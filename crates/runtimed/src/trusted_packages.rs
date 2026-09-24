use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result};
use rattler_conda_types::{MatchSpec, ParseMatchSpecOptions};
use rusqlite::{params, Connection};
use tracing::warn;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PackageIdentity {
    pub ecosystem: &'static str,
    pub raw_spec: String,
    pub normalized_name: String,
}

const ECOSYSTEM_PYPI: &str = "pypi";
const ECOSYSTEM_CONDA: &str = "conda";
const ECOSYSTEM_CONDA_CHANNEL: &str = "conda-channel";
const ECOSYSTEM_PIXI_CHANNEL: &str = "pixi-channel";

/// Prefix for allowlist keys that hold an exact dependency spec. Registry
/// names normalize to `[a-z0-9-]`, so exact keys can never collide with them.
const EXACT_SPEC_PREFIX: &str = "exact:";

/// Which installer grammar a dependency spec is written in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SpecSource {
    /// PEP 508 requirements installed by uv or pixi's PyPI solver.
    Pypi,
    /// Conda match specs. `channel_ecosystem` is the allowlist namespace for
    /// a `channel::name` qualifier on a spec from this source.
    Conda { channel_ecosystem: &'static str },
}

impl SpecSource {
    fn package_ecosystem(self) -> &'static str {
        match self {
            Self::Pypi => ECOSYSTEM_PYPI,
            Self::Conda { .. } => ECOSYSTEM_CONDA,
        }
    }

    fn for_package_ecosystem(ecosystem: &str) -> Self {
        if ecosystem == ECOSYSTEM_CONDA {
            Self::Conda {
                channel_ecosystem: ECOSYSTEM_CONDA_CHANNEL,
            }
        } else {
            Self::Pypi
        }
    }
}

/// Allowlist identity of one dependency spec.
///
/// Approval of a registry name must never extend to a spec that chooses its
/// own source. Anything that is not a plain registry spec is keyed by its
/// exact text, so it needs its own approval.
#[derive(Debug, Clone, PartialEq, Eq)]
enum SpecIdentity {
    /// A package resolved from the configured registry or channels, keyed by
    /// normalized name. Extras, version constraints, and environment markers
    /// do not change the source, so approving `numpy` covers `numpy>=2`.
    Registry(String),
    /// A conda package pinned to a named channel with `channel::name`. The
    /// package and the channel must both be approved.
    ChannelRegistry { channel: String, name: String },
    /// A spec that names its own source (a PEP 508 direct reference, VCS or
    /// path reference, installer option, conda URL, or bracketed conda
    /// channel) or that is not a recognizable registry spec.
    Exact(String),
}

fn classify_spec(source: SpecSource, spec: &str) -> Option<SpecIdentity> {
    match source {
        SpecSource::Pypi => classify_pypi_spec(spec),
        SpecSource::Conda { .. } => classify_conda_spec(spec),
    }
}

fn classify_pypi_spec(spec: &str) -> Option<SpecIdentity> {
    let spec = spec.trim();
    if spec.is_empty() {
        return None;
    }
    let exact = || Some(SpecIdentity::Exact(spec.to_string()));

    // PEP 508 direct references (`name @ url`) choose their own source. A
    // valid marker can't contain `@`, so checking the whole spec is safe.
    if spec.contains('@') {
        return exact();
    }
    // Environment markers only decide whether the requirement applies.
    let requirement = spec.split(';').next().unwrap_or(spec).trim_end();

    let name_end = requirement
        .find(|ch: char| !is_registry_name_char(ch))
        .unwrap_or(requirement.len());
    let Some(name) = normalize_registry_name(&requirement[..name_end]) else {
        return exact();
    };

    let mut rest = requirement[name_end..].trim_start();
    if let Some(after_open) = rest.strip_prefix('[') {
        let Some((extras, after_close)) = after_open.split_once(']') else {
            return exact();
        };
        if !extras
            .chars()
            .all(|ch| is_registry_name_char(ch) || matches!(ch, ',' | ' ' | '\t'))
        {
            return exact();
        }
        rest = after_close;
    }
    if !rest.chars().all(is_version_clause_char) {
        return exact();
    }
    Some(SpecIdentity::Registry(name))
}

fn classify_conda_spec(spec: &str) -> Option<SpecIdentity> {
    let spec = spec.trim();
    if spec.is_empty() {
        return None;
    }
    let exact = || Some(SpecIdentity::Exact(spec.to_string()));

    // Match kernel-env's installer, which treats the first `::` as a channel
    // qualifier (`kernel_env::channels::parse_match_spec`).
    let (channel, package_spec) = match spec.split_once("::") {
        Some((channel, package_spec)) => (Some(channel.trim()), package_spec.trim()),
        None => (None, spec),
    };
    if channel.is_some_and(str::is_empty) {
        return exact();
    }

    let Ok(parsed) = MatchSpec::from_str(package_spec, ParseMatchSpecOptions::strict()) else {
        return exact();
    };
    // Bracketed `channel=` / `url=` keys and URL specs choose their own source.
    if parsed.channel.is_some() || parsed.url.is_some() {
        return exact();
    }
    let Some(name) = parsed.name.as_exact() else {
        return exact();
    };
    let Some(name) = normalize_registry_name(name.as_normalized()) else {
        return exact();
    };

    Some(match channel {
        Some(channel) => SpecIdentity::ChannelRegistry {
            channel: channel.to_string(),
            name,
        },
        None => SpecIdentity::Registry(name),
    })
}

fn is_registry_name_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.')
}

/// Characters allowed in a PEP 440 version clause, including the legacy
/// parenthesized form. `:`, `/`, `@`, `-`, and newlines are excluded, which
/// keeps URLs, paths, and installer options out of the registry identity.
fn is_version_clause_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric()
        || matches!(
            ch,
            '<' | '>' | '=' | '!' | '~' | ',' | '.' | '*' | '+' | '(' | ')' | ' ' | '\t'
        )
}

/// Normalize a PEP 503 / conda package name, or `None` if `name` is not a
/// valid registry name.
fn normalize_registry_name(name: &str) -> Option<String> {
    let first = name.chars().next()?;
    let last = name.chars().last()?;
    if !first.is_ascii_alphanumeric()
        || !last.is_ascii_alphanumeric()
        || !name.chars().all(is_registry_name_char)
    {
        return None;
    }

    let mut normalized = String::with_capacity(name.len());
    let mut last_was_separator = false;
    for ch in name.chars() {
        if matches!(ch, '-' | '_' | '.') {
            if !last_was_separator {
                normalized.push('-');
                last_was_separator = true;
            }
        } else {
            normalized.push(ch.to_ascii_lowercase());
            last_was_separator = false;
        }
    }
    Some(normalized)
}

fn identities_for_spec(source: SpecSource, raw_spec: &str) -> Vec<PackageIdentity> {
    let Some(identity) = classify_spec(source, raw_spec) else {
        return Vec::new();
    };
    let package = |normalized_name: String| PackageIdentity {
        ecosystem: source.package_ecosystem(),
        raw_spec: raw_spec.to_string(),
        normalized_name,
    };
    match (identity, source) {
        (SpecIdentity::Registry(name), _) => vec![package(name)],
        (SpecIdentity::Exact(spec), _) => vec![package(format!("{EXACT_SPEC_PREFIX}{spec}"))],
        (
            SpecIdentity::ChannelRegistry { channel, name },
            SpecSource::Conda { channel_ecosystem },
        ) => vec![
            package(name),
            PackageIdentity {
                ecosystem: channel_ecosystem,
                raw_spec: raw_spec.to_string(),
                normalized_name: channel,
            },
        ],
        // Only the conda grammar produces channel identities.
        (SpecIdentity::ChannelRegistry { .. }, SpecSource::Pypi) => {
            vec![package(format!("{EXACT_SPEC_PREFIX}{}", raw_spec.trim()))]
        }
    }
}

#[derive(Debug)]
enum StoreInner {
    Sqlite { conn: Mutex<Connection> },
    Unavailable { reason: String },
}

#[derive(Debug, Clone)]
pub(crate) struct TrustedPackageStore {
    inner: Arc<StoreInner>,
}

impl TrustedPackageStore {
    pub(crate) fn open(path: PathBuf) -> Result<Self> {
        ensure_private_store_file(&path)?;
        let conn = Connection::open(&path)
            .with_context(|| format!("open trusted package store {}", path.display()))?;
        conn.execute_batch(
            r#"
            PRAGMA foreign_keys = ON;
            CREATE TABLE IF NOT EXISTS trusted_packages (
                ecosystem TEXT NOT NULL,
                normalized_name TEXT NOT NULL,
                approved_at TEXT NOT NULL,
                source TEXT NOT NULL,
                PRIMARY KEY (ecosystem, normalized_name)
            );
            "#,
        )
        .with_context(|| format!("initialize trusted package store {}", path.display()))?;

        Ok(Self {
            inner: Arc::new(StoreInner::Sqlite {
                conn: Mutex::new(conn),
            }),
        })
    }

    pub(crate) fn unavailable(reason: impl Into<String>) -> Self {
        Self {
            inner: Arc::new(StoreInner::Unavailable {
                reason: reason.into(),
            }),
        }
    }

    pub(crate) fn unavailable_reason(&self) -> Option<&str> {
        match self.inner.as_ref() {
            StoreInner::Sqlite { .. } => None,
            StoreInner::Unavailable { reason } => Some(reason.as_str()),
        }
    }

    pub(crate) fn add_from_info(&self, info: &runt_trust::TrustInfo, source: &str) -> Result<()> {
        let identities = identities_from_trust_info(info);
        if identities.is_empty() {
            return Ok(());
        }

        // Fail-closed when the SQLite store is unavailable: the allowlist
        // is the only trust gate, so a silent success here would leave the
        // notebook blocked from launching while the UI reports approval
        // worked.
        let conn = match self.inner.as_ref() {
            StoreInner::Sqlite { conn } => conn,
            StoreInner::Unavailable { reason } => {
                return Err(anyhow::anyhow!(
                    "trusted package store unavailable: {reason}"
                ));
            }
        };

        let approved_at = chrono::Utc::now().to_rfc3339();
        let mut conn = conn
            .lock()
            .map_err(|_| anyhow::anyhow!("trusted package store mutex poisoned"))?;
        let tx = conn.transaction()?;
        {
            let mut stmt = tx.prepare(
                r#"
                INSERT INTO trusted_packages (ecosystem, normalized_name, approved_at, source)
                VALUES (?1, ?2, ?3, ?4)
                ON CONFLICT(ecosystem, normalized_name) DO UPDATE SET
                    approved_at = excluded.approved_at,
                    source = excluded.source
                "#,
            )?;
            for identity in identities {
                stmt.execute(params![
                    identity.ecosystem,
                    identity.normalized_name,
                    approved_at,
                    source
                ])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub(crate) fn enrich_info(&self, info: &mut runt_trust::TrustInfo) -> Result<()> {
        info.approved_uv_dependencies =
            self.approved_raw_specs(SpecSource::Pypi, &info.uv_dependencies)?;
        info.approved_conda_dependencies = self.approved_raw_specs(
            SpecSource::Conda {
                channel_ecosystem: ECOSYSTEM_CONDA_CHANNEL,
            },
            &info.conda_dependencies,
        )?;
        info.approved_conda_channels =
            self.approved_raw_channels(ECOSYSTEM_CONDA_CHANNEL, &info.conda_channels)?;
        info.approved_pixi_dependencies = self.approved_raw_specs(
            SpecSource::Conda {
                channel_ecosystem: ECOSYSTEM_PIXI_CHANNEL,
            },
            &info.pixi_dependencies,
        )?;
        info.approved_pixi_pypi_dependencies =
            self.approved_raw_specs(SpecSource::Pypi, &info.pixi_pypi_dependencies)?;
        info.approved_pixi_channels =
            self.approved_raw_channels(ECOSYSTEM_PIXI_CHANNEL, &info.pixi_channels)?;
        Ok(())
    }

    pub(crate) fn all_dependencies_approved(&self, info: &runt_trust::TrustInfo) -> Result<bool> {
        let identities = identities_from_trust_info(info);
        if identities.is_empty() {
            return Ok(false);
        }

        let StoreInner::Sqlite { conn } = self.inner.as_ref() else {
            return Ok(false);
        };
        let conn = conn
            .lock()
            .map_err(|_| anyhow::anyhow!("trusted package store mutex poisoned"))?;
        let mut stmt = conn.prepare(
            "SELECT 1 FROM trusted_packages WHERE ecosystem = ?1 AND normalized_name = ?2",
        )?;
        for identity in identities {
            let mut rows = stmt.query(params![identity.ecosystem, identity.normalized_name])?;
            if rows.next()?.is_none() {
                return Ok(false);
            }
        }
        Ok(true)
    }

    /// Seed product-default registry packages. Seeds are plain names; a seed
    /// that is not a plain registry spec is ignored rather than stored as an
    /// exact-spec approval.
    pub(crate) fn seed_defaults(&self, ecosystem: &'static str, specs: &[&str]) -> Result<()> {
        let StoreInner::Sqlite { conn } = self.inner.as_ref() else {
            return Ok(());
        };

        let source = SpecSource::for_package_ecosystem(ecosystem);
        let approved_at = chrono::Utc::now().to_rfc3339();
        let mut conn = conn
            .lock()
            .map_err(|_| anyhow::anyhow!("trusted package store mutex poisoned"))?;
        let tx = conn.transaction()?;
        {
            let mut stmt = tx.prepare(
                r#"
                INSERT INTO trusted_packages (ecosystem, normalized_name, approved_at, source)
                VALUES (?1, ?2, ?3, ?4)
                ON CONFLICT(ecosystem, normalized_name) DO NOTHING
                "#,
            )?;
            for spec in specs {
                if let Some(SpecIdentity::Registry(name)) = classify_spec(source, spec) {
                    stmt.execute(params![ecosystem, name, approved_at, "daemon-default"])?;
                }
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// Seed public Conda channel sources that are part of the product's
    /// default policy. Channels have their own exact-match identity and must
    /// not pass through package-name normalization.
    pub(crate) fn seed_default_channels(&self, channels: &[&str]) -> Result<()> {
        let StoreInner::Sqlite { conn } = self.inner.as_ref() else {
            return Ok(());
        };

        let approved_at = chrono::Utc::now().to_rfc3339();
        let mut conn = conn
            .lock()
            .map_err(|_| anyhow::anyhow!("trusted package store mutex poisoned"))?;
        let tx = conn.transaction()?;
        {
            let mut stmt = tx.prepare(
                r#"
                INSERT INTO trusted_packages (ecosystem, normalized_name, approved_at, source)
                VALUES (?1, ?2, ?3, ?4)
                ON CONFLICT(ecosystem, normalized_name) DO NOTHING
                "#,
            )?;
            for ecosystem in [ECOSYSTEM_CONDA_CHANNEL, ECOSYSTEM_PIXI_CHANNEL] {
                for channel in channels {
                    if let Some(source) = normalize_channel_source(channel) {
                        stmt.execute(params![ecosystem, source, approved_at, "daemon-default"])?;
                    }
                }
            }
        }
        tx.commit()?;
        Ok(())
    }

    fn approved_raw_specs(&self, source: SpecSource, specs: &[String]) -> Result<Vec<String>> {
        let StoreInner::Sqlite { conn } = self.inner.as_ref() else {
            return Ok(vec![]);
        };
        let conn = conn
            .lock()
            .map_err(|_| anyhow::anyhow!("trusted package store mutex poisoned"))?;
        let mut stmt = conn.prepare(
            "SELECT 1 FROM trusted_packages WHERE ecosystem = ?1 AND normalized_name = ?2",
        )?;
        let mut approved = Vec::new();
        'specs: for spec in specs {
            let identities = identities_for_spec(source, spec);
            if identities.is_empty() {
                continue;
            }
            for identity in identities {
                let mut rows = stmt.query(params![identity.ecosystem, identity.normalized_name])?;
                if rows.next()?.is_none() {
                    continue 'specs;
                }
            }
            approved.push(spec.clone());
        }
        Ok(approved)
    }

    fn approved_raw_channels(
        &self,
        ecosystem: &'static str,
        channels: &[String],
    ) -> Result<Vec<String>> {
        let StoreInner::Sqlite { conn } = self.inner.as_ref() else {
            return Ok(vec![]);
        };
        let conn = conn
            .lock()
            .map_err(|_| anyhow::anyhow!("trusted package store mutex poisoned"))?;
        let mut stmt = conn.prepare(
            "SELECT 1 FROM trusted_packages WHERE ecosystem = ?1 AND normalized_name = ?2",
        )?;
        let mut approved = Vec::new();
        for channel in channels {
            let Some(normalized) = normalize_channel_source(channel) else {
                continue;
            };
            let mut rows = stmt.query(params![ecosystem, normalized])?;
            if rows.next()?.is_some() {
                approved.push(channel.clone());
            }
        }
        Ok(approved)
    }
}

pub(crate) fn identities_from_trust_info(info: &runt_trust::TrustInfo) -> Vec<PackageIdentity> {
    let conda = SpecSource::Conda {
        channel_ecosystem: ECOSYSTEM_CONDA_CHANNEL,
    };
    let pixi_conda = SpecSource::Conda {
        channel_ecosystem: ECOSYSTEM_PIXI_CHANNEL,
    };
    let mut out = Vec::new();
    out.extend(identities_for_specs(
        SpecSource::Pypi,
        &info.uv_dependencies,
    ));
    out.extend(identities_for_specs(conda, &info.conda_dependencies));
    out.extend(identities_for_channels(
        ECOSYSTEM_CONDA_CHANNEL,
        &info.conda_channels,
    ));
    out.extend(identities_for_specs(pixi_conda, &info.pixi_dependencies));
    out.extend(identities_for_specs(
        SpecSource::Pypi,
        &info.pixi_pypi_dependencies,
    ));
    out.extend(identities_for_channels(
        ECOSYSTEM_PIXI_CHANNEL,
        &info.pixi_channels,
    ));
    out
}

fn identities_for_specs(source: SpecSource, specs: &[String]) -> Vec<PackageIdentity> {
    specs
        .iter()
        .flat_map(|raw_spec| identities_for_spec(source, raw_spec))
        .collect()
}

fn identities_for_channels(ecosystem: &'static str, channels: &[String]) -> Vec<PackageIdentity> {
    channels
        .iter()
        .filter_map(|channel| {
            normalize_channel_source(channel).map(|normalized_name| PackageIdentity {
                ecosystem,
                raw_spec: channel.clone(),
                normalized_name,
            })
        })
        .collect()
}

pub(crate) fn normalize_channel_source(source: &str) -> Option<String> {
    let source = source.trim();
    if source.is_empty() {
        None
    } else {
        Some(source.to_string())
    }
}

fn ensure_private_store_file(path: &Path) -> Result<()> {
    if let Some(parent) = path.parent() {
        #[cfg(unix)]
        let existed = parent.exists();
        std::fs::create_dir_all(parent)
            .with_context(|| format!("create trusted package store dir {}", parent.display()))?;
        #[cfg(unix)]
        if !existed {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))
                .with_context(|| format!("set permissions on {}", parent.display()))?;
        }
    }

    std::fs::OpenOptions::new()
        .create(true)
        .read(true)
        .truncate(false)
        .write(true)
        .open(path)
        .with_context(|| format!("create trusted package store {}", path.display()))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .with_context(|| format!("set permissions on {}", path.display()))?;
    }

    #[cfg(windows)]
    {
        apply_private_windows_acl(path)
            .with_context(|| format!("set private ACL on {}", path.display()))?;
    }

    Ok(())
}

#[cfg(windows)]
fn apply_private_windows_acl(path: &Path) -> Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Authorization::{
        ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
    };
    use windows_sys::Win32::Security::{
        SetFileSecurityW, DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR,
    };

    let mut path_wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let sddl = "D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;OW)";
    let sddl_wide: Vec<u16> = std::ffi::OsStr::new(sddl)
        .encode_wide()
        .chain(Some(0))
        .collect();
    let mut security_descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();

    let converted = unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl_wide.as_ptr(),
            SDDL_REVISION_1,
            &mut security_descriptor,
            std::ptr::null_mut(),
        )
    };
    if converted == 0 {
        return Err(std::io::Error::last_os_error().into());
    }

    let set_result = unsafe {
        SetFileSecurityW(
            path_wide.as_mut_ptr(),
            DACL_SECURITY_INFORMATION,
            security_descriptor,
        )
    };
    unsafe {
        LocalFree(security_descriptor);
    }
    if set_result == 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(())
}

pub(crate) fn log_store_unavailable(store: &TrustedPackageStore) {
    if let Some(reason) = store.unavailable_reason() {
        warn!(
            "[trusted-packages] Package allowlist unavailable; auto-approval disabled: {}",
            reason
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CONDA: SpecSource = SpecSource::Conda {
        channel_ecosystem: ECOSYSTEM_CONDA_CHANNEL,
    };

    fn registry(name: &str) -> Option<SpecIdentity> {
        Some(SpecIdentity::Registry(name.into()))
    }

    fn exact(spec: &str) -> Option<SpecIdentity> {
        Some(SpecIdentity::Exact(spec.into()))
    }

    fn empty_info() -> runt_trust::TrustInfo {
        runt_trust::TrustInfo {
            status: runt_trust::TrustStatus::Untrusted,
            uv_dependencies: vec![],
            approved_uv_dependencies: vec![],
            conda_dependencies: vec![],
            approved_conda_dependencies: vec![],
            conda_channels: vec![],
            approved_conda_channels: vec![],
            pixi_dependencies: vec![],
            approved_pixi_dependencies: vec![],
            pixi_pypi_dependencies: vec![],
            approved_pixi_pypi_dependencies: vec![],
            pixi_channels: vec![],
            approved_pixi_channels: vec![],
        }
    }

    fn seeded_store(tmp: &tempfile::TempDir) -> TrustedPackageStore {
        let store = TrustedPackageStore::open(tmp.path().join("trusted.sqlite")).unwrap();
        store.seed_defaults("pypi", &["numpy", "pandas"]).unwrap();
        store.seed_defaults("conda", &["numpy", "pandas"]).unwrap();
        store.seed_default_channels(&["conda-forge"]).unwrap();
        store
    }

    #[test]
    fn registry_specs_normalize_to_package_names() {
        let pypi = SpecSource::Pypi;
        assert_eq!(classify_spec(pypi, "pandas>=2"), registry("pandas"));
        assert_eq!(classify_spec(pypi, "Pandas"), registry("pandas"));
        assert_eq!(
            classify_spec(pypi, "scikit_learn"),
            registry("scikit-learn")
        );
        assert_eq!(
            classify_spec(
                pypi,
                "requests[security,socks]>=2; python_version >= '3.11'"
            ),
            registry("requests")
        );
        assert_eq!(
            classify_spec(pypi, "my.pkg__name>=1"),
            registry("my-pkg-name")
        );
        assert_eq!(classify_spec(pypi, "numpy (>=1.0, <2)"), registry("numpy"));
        assert_eq!(classify_spec(pypi, "torch==2.1.0+cpu"), registry("torch"));
        assert_eq!(classify_spec(pypi, "   "), None);

        assert_eq!(classify_spec(CONDA, "NumPy=1.26"), registry("numpy"));
        assert_eq!(
            classify_spec(CONDA, "python>=3.12,<3.14"),
            registry("python")
        );
        assert_eq!(
            classify_spec(CONDA, "conda-forge::NumPy=1.26"),
            Some(SpecIdentity::ChannelRegistry {
                channel: "conda-forge".into(),
                name: "numpy".into(),
            })
        );
    }

    #[test]
    fn source_selecting_specs_keep_their_exact_text() {
        let pypi = SpecSource::Pypi;
        for spec in [
            "numpy @ https://example.test/numpy-2.0-py3-none-any.whl",
            "numpy@https://example.test/numpy.whl",
            "numpy @ file:///tmp/numpy.whl ; python_version >= '3.11'",
            "numpy[extra] @ git+https://example.test/numpy.git",
            "git+https://example.test/numpy.git",
            "https://example.test/numpy-2.0-py3-none-any.whl",
            "./vendor/numpy",
            "-e ./vendor/numpy",
            "--index-url=https://example.test/simple",
            "numpy --index-url https://example.test/simple",
            "@ https://example.test/numpy.whl",
        ] {
            assert_eq!(classify_spec(pypi, spec), exact(spec), "pypi spec {spec:?}");
        }

        for spec in [
            "numpy[channel=https://example.test/conda]",
            "numpy[url=https://example.test/numpy-2.0-0.conda]",
            "https://example.test/linux-64/numpy-2.0-0.conda",
            "::numpy",
            "nump*",
        ] {
            assert_eq!(
                classify_spec(CONDA, spec),
                exact(spec),
                "conda spec {spec:?}"
            );
        }
    }

    #[test]
    fn direct_references_do_not_inherit_name_approval() {
        let tmp = tempfile::TempDir::new().unwrap();
        let store = seeded_store(&tmp);
        let direct = "numpy @ https://example.test/numpy-2.0-py3-none-any.whl";

        for (uv, pixi_pypi) in [
            (vec![direct.to_string()], vec![]),
            (vec![], vec![direct.to_string()]),
        ] {
            let info = runt_trust::TrustInfo {
                uv_dependencies: uv,
                pixi_pypi_dependencies: pixi_pypi,
                ..empty_info()
            };
            assert!(
                !store.all_dependencies_approved(&info).unwrap(),
                "an approved registry name must not approve a direct reference"
            );
        }

        let info = runt_trust::TrustInfo {
            uv_dependencies: vec!["pandas".into(), direct.into()],
            ..empty_info()
        };
        let mut enriched = info.clone();
        store.enrich_info(&mut enriched).unwrap();
        assert_eq!(enriched.approved_uv_dependencies, vec!["pandas"]);

        store.add_from_info(&info, "test").unwrap();
        assert!(store.all_dependencies_approved(&info).unwrap());

        let other_url = runt_trust::TrustInfo {
            uv_dependencies: vec!["numpy @ https://example.test/other.whl".into()],
            ..empty_info()
        };
        assert!(
            !store.all_dependencies_approved(&other_url).unwrap(),
            "approving one direct reference must not approve another URL"
        );

        let plain = runt_trust::TrustInfo {
            uv_dependencies: vec!["numpy>=2".into()],
            ..empty_info()
        };
        assert!(store.all_dependencies_approved(&plain).unwrap());
    }

    #[test]
    fn unrecognized_specs_fail_closed() {
        let tmp = tempfile::TempDir::new().unwrap();
        let store = seeded_store(&tmp);
        let info = runt_trust::TrustInfo {
            uv_dependencies: vec!["pandas".into(), "@ https://example.test/x.whl".into()],
            ..empty_info()
        };
        assert!(
            !store.all_dependencies_approved(&info).unwrap(),
            "a spec without a registry name must not drop out of the trust check"
        );
    }

    #[test]
    fn conda_channel_qualifiers_require_channel_approval() {
        let tmp = tempfile::TempDir::new().unwrap();
        let store = seeded_store(&tmp);

        for (conda, pixi) in [
            (vec!["conda-forge::numpy".to_string()], vec![]),
            (vec![], vec!["conda-forge::numpy".to_string()]),
        ] {
            let info = runt_trust::TrustInfo {
                conda_dependencies: conda,
                pixi_dependencies: pixi,
                ..empty_info()
            };
            assert!(store.all_dependencies_approved(&info).unwrap());
        }

        let untrusted_channel = runt_trust::TrustInfo {
            conda_dependencies: vec!["https://example.test/conda::numpy".into()],
            ..empty_info()
        };
        assert!(
            !store.all_dependencies_approved(&untrusted_channel).unwrap(),
            "a channel qualifier must be approved like a notebook channel"
        );
        let mut enriched = untrusted_channel.clone();
        store.enrich_info(&mut enriched).unwrap();
        assert!(enriched.approved_conda_dependencies.is_empty());

        store.add_from_info(&untrusted_channel, "test").unwrap();
        assert!(store.all_dependencies_approved(&untrusted_channel).unwrap());

        let bracket_channel = runt_trust::TrustInfo {
            conda_dependencies: vec!["numpy[channel=https://example.test/other]".into()],
            ..empty_info()
        };
        assert!(!store.all_dependencies_approved(&bracket_channel).unwrap());
    }

    #[test]
    fn seed_defaults_ignores_source_selecting_specs() {
        let tmp = tempfile::TempDir::new().unwrap();
        let store = TrustedPackageStore::open(tmp.path().join("trusted.sqlite")).unwrap();
        let direct = "numpy @ https://example.test/numpy.whl";
        store.seed_defaults("pypi", &[direct]).unwrap();

        let info = runt_trust::TrustInfo {
            uv_dependencies: vec![direct.into()],
            ..empty_info()
        };
        assert!(!store.all_dependencies_approved(&info).unwrap());
    }

    #[test]
    fn store_inserts_idempotently_and_checks_by_ecosystem() {
        let tmp = tempfile::TempDir::new().unwrap();
        let store = TrustedPackageStore::open(tmp.path().join("trusted.sqlite")).unwrap();
        let info = runt_trust::TrustInfo {
            status: runt_trust::TrustStatus::Untrusted,
            uv_dependencies: vec!["Pandas>=2".into()],
            approved_uv_dependencies: vec![],
            conda_dependencies: vec!["numpy=1.26".into()],
            approved_conda_dependencies: vec![],
            conda_channels: vec![],
            approved_conda_channels: vec![],
            pixi_dependencies: vec![],
            approved_pixi_dependencies: vec![],
            pixi_pypi_dependencies: vec![],
            approved_pixi_pypi_dependencies: vec![],
            pixi_channels: vec![],
            approved_pixi_channels: vec![],
        };

        store.add_from_info(&info, "test").unwrap();
        store.add_from_info(&info, "test").unwrap();

        assert!(store.all_dependencies_approved(&info).unwrap());

        let mut pypi_only = info.clone();
        pypi_only.conda_dependencies.clear();
        assert!(store.all_dependencies_approved(&pypi_only).unwrap());

        let conda_not_pypi = runt_trust::TrustInfo {
            status: runt_trust::TrustStatus::Untrusted,
            uv_dependencies: vec!["numpy".into()],
            approved_uv_dependencies: vec![],
            conda_dependencies: vec![],
            approved_conda_dependencies: vec![],
            conda_channels: vec![],
            approved_conda_channels: vec![],
            pixi_dependencies: vec![],
            approved_pixi_dependencies: vec![],
            pixi_pypi_dependencies: vec![],
            approved_pixi_pypi_dependencies: vec![],
            pixi_channels: vec![],
            approved_pixi_channels: vec![],
        };
        assert!(!store.all_dependencies_approved(&conda_not_pypi).unwrap());
    }

    #[test]
    fn enriches_approved_raw_specs() {
        let tmp = tempfile::TempDir::new().unwrap();
        let store = TrustedPackageStore::open(tmp.path().join("trusted.sqlite")).unwrap();
        let approved = runt_trust::TrustInfo {
            status: runt_trust::TrustStatus::Untrusted,
            uv_dependencies: vec!["pandas".into()],
            approved_uv_dependencies: vec![],
            conda_dependencies: vec![],
            approved_conda_dependencies: vec![],
            conda_channels: vec![],
            approved_conda_channels: vec![],
            pixi_dependencies: vec![],
            approved_pixi_dependencies: vec![],
            pixi_pypi_dependencies: vec![],
            approved_pixi_pypi_dependencies: vec![],
            pixi_channels: vec![],
            approved_pixi_channels: vec![],
        };
        store.add_from_info(&approved, "test").unwrap();

        let mut mixed = approved.clone();
        mixed.uv_dependencies = vec!["pandas>=2".into(), "polars".into()];
        store.enrich_info(&mut mixed).unwrap();
        assert_eq!(mixed.approved_uv_dependencies, vec!["pandas>=2"]);
    }

    #[test]
    fn conda_channels_are_part_of_trust_identity() {
        let tmp = tempfile::TempDir::new().unwrap();
        let store = TrustedPackageStore::open(tmp.path().join("trusted.sqlite")).unwrap();
        let package_only = runt_trust::TrustInfo {
            status: runt_trust::TrustStatus::Untrusted,
            uv_dependencies: vec![],
            approved_uv_dependencies: vec![],
            conda_dependencies: vec!["pandas".into()],
            approved_conda_dependencies: vec![],
            conda_channels: vec![],
            approved_conda_channels: vec![],
            pixi_dependencies: vec![],
            approved_pixi_dependencies: vec![],
            pixi_pypi_dependencies: vec![],
            approved_pixi_pypi_dependencies: vec![],
            pixi_channels: vec![],
            approved_pixi_channels: vec![],
        };
        store.add_from_info(&package_only, "test").unwrap();

        let with_channel = runt_trust::TrustInfo {
            conda_channels: vec!["conda-forge".into()],
            ..package_only.clone()
        };
        assert!(
            !store.all_dependencies_approved(&with_channel).unwrap(),
            "approving a conda package must not approve every channel that can provide it"
        );

        store.add_from_info(&with_channel, "test").unwrap();
        assert!(store.all_dependencies_approved(&with_channel).unwrap());

        let mut different_channel = with_channel.clone();
        different_channel.conda_channels = vec!["http://evil.example".into()];
        assert!(
            !store.all_dependencies_approved(&different_channel).unwrap(),
            "channel approval must be source-specific"
        );

        let mut enriched = different_channel;
        enriched.conda_channels = vec!["conda-forge".into(), "defaults".into()];
        store.enrich_info(&mut enriched).unwrap();
        assert_eq!(enriched.approved_conda_dependencies, vec!["pandas"]);
        assert_eq!(enriched.approved_conda_channels, vec!["conda-forge"]);
    }

    #[test]
    fn seed_defaults_pre_approves_packages() {
        let tmp = tempfile::TempDir::new().unwrap();
        let store = TrustedPackageStore::open(tmp.path().join("trusted.sqlite")).unwrap();

        store
            .seed_defaults("pypi", &["pandas", "matplotlib"])
            .unwrap();

        let info = runt_trust::TrustInfo {
            status: runt_trust::TrustStatus::Untrusted,
            uv_dependencies: vec!["pandas>=2".into(), "matplotlib".into()],
            approved_uv_dependencies: vec![],
            conda_dependencies: vec![],
            approved_conda_dependencies: vec![],
            conda_channels: vec![],
            approved_conda_channels: vec![],
            pixi_dependencies: vec![],
            approved_pixi_dependencies: vec![],
            pixi_pypi_dependencies: vec![],
            approved_pixi_pypi_dependencies: vec![],
            pixi_channels: vec![],
            approved_pixi_channels: vec![],
        };
        assert!(store.all_dependencies_approved(&info).unwrap());
    }

    #[test]
    fn seed_defaults_covers_conda_ecosystem() {
        let tmp = tempfile::TempDir::new().unwrap();
        let store = TrustedPackageStore::open(tmp.path().join("trusted.sqlite")).unwrap();

        store
            .seed_defaults("conda", &["pandas", "matplotlib"])
            .unwrap();

        let info = runt_trust::TrustInfo {
            status: runt_trust::TrustStatus::Untrusted,
            uv_dependencies: vec![],
            approved_uv_dependencies: vec![],
            conda_dependencies: vec!["pandas".into(), "matplotlib".into()],
            approved_conda_dependencies: vec![],
            conda_channels: vec![],
            approved_conda_channels: vec![],
            pixi_dependencies: vec![],
            approved_pixi_dependencies: vec![],
            pixi_pypi_dependencies: vec![],
            approved_pixi_pypi_dependencies: vec![],
            pixi_channels: vec![],
            approved_pixi_channels: vec![],
        };
        assert!(store.all_dependencies_approved(&info).unwrap());

        // Pypi ecosystem should NOT see conda-seeded packages
        let pypi_only = runt_trust::TrustInfo {
            status: runt_trust::TrustStatus::Untrusted,
            uv_dependencies: vec!["pandas".into()],
            approved_uv_dependencies: vec![],
            conda_dependencies: vec![],
            approved_conda_dependencies: vec![],
            conda_channels: vec![],
            approved_conda_channels: vec![],
            pixi_dependencies: vec![],
            approved_pixi_dependencies: vec![],
            pixi_pypi_dependencies: vec![],
            approved_pixi_pypi_dependencies: vec![],
            pixi_channels: vec![],
            approved_pixi_channels: vec![],
        };
        assert!(!store.all_dependencies_approved(&pypi_only).unwrap());
    }

    #[test]
    fn seed_default_channels_covers_conda_and_pixi_without_trusting_other_sources() {
        let tmp = tempfile::TempDir::new().unwrap();
        let store = TrustedPackageStore::open(tmp.path().join("trusted.sqlite")).unwrap();

        store
            .seed_default_channels(&[
                "conda-forge",
                "defaults",
                "https://repo.anaconda.com/pkgs/main",
            ])
            .unwrap();

        let info = runt_trust::TrustInfo {
            status: runt_trust::TrustStatus::Untrusted,
            uv_dependencies: vec![],
            approved_uv_dependencies: vec![],
            conda_dependencies: vec![],
            approved_conda_dependencies: vec![],
            conda_channels: vec![
                "defaults".into(),
                "https://repo.anaconda.com/pkgs/main".into(),
            ],
            approved_conda_channels: vec![],
            pixi_dependencies: vec![],
            approved_pixi_dependencies: vec![],
            pixi_pypi_dependencies: vec![],
            approved_pixi_pypi_dependencies: vec![],
            pixi_channels: vec!["conda-forge".into()],
            approved_pixi_channels: vec![],
        };
        assert!(store.all_dependencies_approved(&info).unwrap());

        let mut untrusted = info;
        untrusted.conda_channels = vec!["https://packages.example.test/conda".into()];
        assert!(!store.all_dependencies_approved(&untrusted).unwrap());
    }

    #[test]
    fn seed_defaults_does_not_overwrite_existing() {
        let tmp = tempfile::TempDir::new().unwrap();
        let store = TrustedPackageStore::open(tmp.path().join("trusted.sqlite")).unwrap();

        let info = runt_trust::TrustInfo {
            status: runt_trust::TrustStatus::Untrusted,
            uv_dependencies: vec!["pandas".into()],
            approved_uv_dependencies: vec![],
            conda_dependencies: vec![],
            approved_conda_dependencies: vec![],
            conda_channels: vec![],
            approved_conda_channels: vec![],
            pixi_dependencies: vec![],
            approved_pixi_dependencies: vec![],
            pixi_pypi_dependencies: vec![],
            approved_pixi_pypi_dependencies: vec![],
            pixi_channels: vec![],
            approved_pixi_channels: vec![],
        };
        store.add_from_info(&info, "user-approval").unwrap();
        store.seed_defaults("pypi", &["pandas"]).unwrap();

        assert!(store.all_dependencies_approved(&info).unwrap());
    }

    #[cfg(unix)]
    #[test]
    fn store_file_is_owner_only_on_unix() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = tempfile::TempDir::new().unwrap();
        let path = tmp.path().join("trusted.sqlite");
        TrustedPackageStore::open(path.clone()).unwrap();
        let mode = std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }

    #[test]
    fn add_from_info_returns_error_when_store_unavailable() {
        let store = TrustedPackageStore::unavailable("disk full");
        let info = runt_trust::TrustInfo {
            status: runt_trust::TrustStatus::Untrusted,
            uv_dependencies: vec!["pandas".into()],
            approved_uv_dependencies: vec![],
            conda_dependencies: vec![],
            approved_conda_dependencies: vec![],
            conda_channels: vec![],
            approved_conda_channels: vec![],
            pixi_dependencies: vec![],
            approved_pixi_dependencies: vec![],
            pixi_pypi_dependencies: vec![],
            approved_pixi_pypi_dependencies: vec![],
            pixi_channels: vec![],
            approved_pixi_channels: vec![],
        };

        let err = store
            .add_from_info(&info, "test")
            .expect_err("unavailable store must surface an error");
        let message = format!("{err}");
        assert!(
            message.contains("unavailable") && message.contains("disk full"),
            "error message should mention the unavailable reason; got: {message}"
        );
    }

    #[test]
    fn add_from_info_succeeds_with_no_identities_even_when_unavailable() {
        // Empty TrustInfo carries no identities; nothing to persist, so the
        // store's availability is irrelevant.
        let store = TrustedPackageStore::unavailable("disk full");
        let info = runt_trust::TrustInfo {
            status: runt_trust::TrustStatus::NoDependencies,
            uv_dependencies: vec![],
            approved_uv_dependencies: vec![],
            conda_dependencies: vec![],
            approved_conda_dependencies: vec![],
            conda_channels: vec![],
            approved_conda_channels: vec![],
            pixi_dependencies: vec![],
            approved_pixi_dependencies: vec![],
            pixi_pypi_dependencies: vec![],
            approved_pixi_pypi_dependencies: vec![],
            pixi_channels: vec![],
            approved_pixi_channels: vec![],
        };
        store.add_from_info(&info, "test").unwrap();
    }
}
