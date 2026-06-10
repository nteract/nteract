//! Translates a [`SandboxProfile`] into the nono JSON profile file and CLI flags.
//!
//! ## Overview
//!
//! nono 0.62.x accepts profiles as JSON files (not YAML — empirical test OQ-6
//! in `docs/sandbox/nono-empirical-tests.md` confirmed YAML is rejected with
//! "Profile parse error: Unexpected word on line 1 column 1").
//!
//! The translation is **pure** given a profile, modulo creating a temporary
//! file. It never reads the macOS Keychain — credential values never leave the
//! Keychain and are never present in the profile (D-6).
//!
//! ## nono JSON profile shape (0.62.x)
//!
//! The nono profile uses a `network.custom_credentials` map for per-credential
//! routing. Each entry names the credential, its upstream URL, the Keychain key
//! to look up, the header to inject, and the Bearer format string. The profile
//! also specifies `allow_domain` for domain filtering.
//!
//! ```json
//! {
//!   "meta": {
//!     "name": "nteract-kernel-proxy",
//!     "description": "Credential injection proxy for Python kernels",
//!     "version": "1.0.0"
//!   },
//!   "workdir": { "access": "readwrite" },
//!   "network": {
//!     "credentials": ["analytics_api"],
//!     "custom_credentials": {
//!       "analytics_api": {
//!         "credential_key": "analytics_api",
//!         "inject_header": "Authorization",
//!         "credential_format": "Bearer {}"
//!       }
//!     },
//!     "allow_domain": ["api.analytics.example.com"]
//!   }
//! }
//! ```
//!
//! ## Field mapping (`SandboxProfile` → nono JSON)
//!
//! A `CredentialRef` with N routes expands into N `custom_credentials` entries.
//! The entry key is `<cred_name>` for single-route credentials and
//! `<cred_name>__<index>` for multi-route credentials.
//!
//! | SandboxProfile field | nono JSON path | Notes |
//! |---|---|---|
//! | `credential.name` (per route) | `network.credentials[]` | One entry per route |
//! | `credential.effective_keystore_name()` | `network.custom_credentials.<key>.credential_key` | Shared across all routes |
//! | `route.host` + `route.scheme` | `network.custom_credentials.<key>.upstream` | `<scheme>://<host>` per route |
//! | `route.inject_as` | `network.custom_credentials.<key>.inject_mode` | `"header"`, `"basic_auth"`, or `"query_param"` |
//! | Route `inject_as = Header`, `header` | `network.custom_credentials.<key>.inject_header` | Header name (e.g. "Authorization") |
//! | Route `inject_as = Header`, `template` | `network.custom_credentials.<key>.credential_format` | `{credential}` → `{}` substituted; Header mode only |
//! | Route `inject_as = Query`, `template` | `network.custom_credentials.<key>.query_param_name` | `{credential}` → `{}` substituted; Query mode only |
//! | All route hosts + `allowed_domains` | `network.allow_domain` | Merged, sorted, deduped; always emitted |
//!
//! ### `allow_domain` is always emitted (block-by-default)
//!
//! `allow_domain` is **always** written to the nono JSON, even as an empty
//! array.  An absent `allow_domain` key causes nono to allow all outbound
//! connections, defeating the sandbox.  An empty `[]` enforces
//! block-by-default: only the ZMQ ports opened via `--open-port` and the
//! hosts in the list are reachable.
//!
//! Credential route hosts are **auto-included** in `allow_domain`.  For nono
//! to activate `connect_intercept` mode (TLS interception + header injection),
//! the target domain must be in `allow_domain`.  Without it nono falls back to
//! plain `connect` tunnel mode (raw TLS relay, no credential injection).
//! Users should not need to duplicate route hosts in `allowed_domains`.
//!
//! ## CLI flags produced
//!
//! For each credential, `translate` appends `["--env-credential", "<keystore_name>"]`
//! to `env_credential_flags`. Per D-5, `--env-credential` is used for all
//! user-defined credentials; `--credential` is reserved for nono's built-in
//! service integrations and is not used here.
//!
//! ## Kernel env overrides
//!
//! nono **automatically injects** `HTTP_PROXY`, `HTTPS_PROXY`, `NONO_PROXY_TOKEN`,
//! and `<SERVICE>_BASE_URL` / `<SERVICE>_API_KEY` into the child process environment
//! at startup (confirmed by the proxy mechanics description in
//! `docs/sandbox/nono-sh-investigation.md` §2). The daemon does not need to pass
//! these explicitly via `kernel_env_overrides`.
//!
//! However, since nono injects proxy env vars itself, `kernel_env_overrides` is
//! populated with the **phantom token env vars** (`effective_env_var()` →
//! `<NAME>_PROXY_TOKEN` placeholder) so the supervisor can document what the
//! kernel will see. In practice these are set by nono, not by us — but surfacing
//! them in `kernel_env_overrides` gives task 07 a clear list of env vars the
//! kernel session will expose.
//!
//! Out of an abundance of caution (cannot fully verify what nono auto-injects for
//! all edge cases), `HTTP_PROXY` and `HTTPS_PROXY` are **not** added to
//! `kernel_env_overrides` since nono manages them. If nono's behavior changes,
//! update this to set them explicitly.
//!
//! ## Temp file lifecycle
//!
//! The profile is written to a `NamedTempFile` (mode `0600`) and converted to a
//! `TempPath` via `into_temp_path()`. The file is automatically removed when the
//! `TempPath` drops. The supervisor (task 07) must hold the `TranslatedProfile`
//! for the kernel session lifetime.
//!
//! ## Verification (manual)
//!
//! To confirm the generated JSON is accepted by nono:
//! ```bash
//! # Write a profile to a known path
//! cat > /tmp/test-nono-profile.json << 'EOF'
//! { "meta": { "name": "test", "version": "1.0.0" }, "workdir": { "access": "readwrite" }, "network": {} }
//! EOF
//! nono run --profile /tmp/test-nono-profile.json -- /bin/true
//! echo "Exit: $?"  # should be 0
//! ```

use std::ffi::OsString;
use std::io::Write as _;

use notebook_doc::sandbox::{InjectionKind, SandboxProfile};
use serde_json::json;
use tempfile::TempPath;

// ── Public types ──────────────────────────────────────────────────────

/// The result of translating a [`SandboxProfile`] for nono.
///
/// Hold this struct for the kernel session lifetime — dropping it removes the
/// temporary profile file from disk.
///
/// `Debug` is implemented manually because [`TempPath`] does not implement
/// `Debug`.
pub struct TranslatedProfile {
    /// Path to the temp JSON file to pass as `nono run --profile <path>`.
    ///
    /// The file is deleted when this `TempPath` drops. The supervisor must keep
    /// the `TranslatedProfile` alive for the entire kernel session.
    pub profile_json_path: TempPath,

    /// Flags to append to the `nono run` command line, e.g.:
    /// `["--env-credential", "analytics_api", "--env-credential", "db_key"]`.
    ///
    /// Per D-5, only `--env-credential` is used (not `--credential`, which is
    /// reserved for nono's built-in service integrations).
    ///
    /// Sorted by credential name for determinism.
    pub env_credential_flags: Vec<String>,

    /// Environment variables the kernel session will expose (phantom tokens).
    ///
    /// nono injects `HTTP_PROXY`, `HTTPS_PROXY`, `NONO_PROXY_TOKEN`, and
    /// `<SERVICE>_BASE_URL` / `<SERVICE>_API_KEY` automatically. This vec
    /// surfaces the credential env var names (via `effective_env_var()`) so
    /// task 07 can document what the kernel will see — but the actual values
    /// are set by nono at runtime, not by the daemon.
    pub kernel_env_overrides: Vec<(OsString, OsString)>,
}

impl std::fmt::Debug for TranslatedProfile {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TranslatedProfile")
            .field("profile_json_path", &self.profile_json_path.to_path_buf())
            .field("env_credential_flags", &self.env_credential_flags)
            .field("kernel_env_overrides", &self.kernel_env_overrides)
            .finish()
    }
}

/// Error returned by [`translate`].
#[derive(Debug, thiserror::Error)]
pub enum ProfileTranslationError {
    /// The profile is disabled (`enabled = false`). Callers must not translate
    /// a disabled profile — the opt-in check belongs to task 07.
    #[error("sandbox profile is disabled (enabled = false); do not translate a disabled profile")]
    Disabled,

    /// The profile failed validation. Translation never produces a JSON file for
    /// an invalid profile.
    #[error("invalid profile: {0}")]
    Invalid(String),

    /// Writing the temporary profile file failed.
    #[error("io error writing temp profile: {0}")]
    Io(#[from] std::io::Error),

    /// JSON serialization failed (unexpected — our internal structs are always
    /// serializable, but we surface the error rather than panic).
    #[error("json serialize error: {0}")]
    Json(#[from] serde_json::Error),
}

// ── Public API ────────────────────────────────────────────────────────

/// Translate a [`SandboxProfile`] into a nono JSON profile file and CLI flags.
///
/// # Preconditions
///
/// - `profile.enabled` must be `true` — returns [`ProfileTranslationError::Disabled`]
///   if the profile is disabled. The opt-in check ("should we even sandbox this
///   kernel?") is the caller's responsibility (task 07).
/// - The profile must pass [`SandboxProfile::validate`] — returns
///   [`ProfileTranslationError::Invalid`] otherwise.
///
/// # Side effects
///
/// Creates a temporary JSON file (mode `0600`) in the system temp directory.
/// The file is deleted when the returned [`TranslatedProfile::profile_json_path`] drops.
///
/// # Determinism
///
/// Given the same `profile`, two calls produce byte-identical JSON (credentials
/// sorted by name) and identical `env_credential_flags` (also sorted by name).
///
/// # Example
///
/// ```rust,no_run
/// use notebook_doc::sandbox::{SandboxProfile, CredentialRef};
/// use runtimed::nono::profile::translate;
///
/// let profile = SandboxProfile {
///     enabled: true,
///     credentials: vec![
///         CredentialRef {
///             name: "analytics_api".to_string(),
///             description: None,
///             env_var: None,
///             keystore_name: None,
///             routes: vec![],
///         },
///     ],
///     allowed_domains: vec![],
/// };
///
/// let result = translate(&profile).expect("translation failed");
/// // result.profile_json_path → pass as `nono run --profile <path>`
/// // result.env_credential_flags → append to nono command line
/// ```
pub fn translate(profile: &SandboxProfile) -> Result<TranslatedProfile, ProfileTranslationError> {
    // Step 1: Gate on enabled.
    if !profile.enabled {
        return Err(ProfileTranslationError::Disabled);
    }

    // Step 2: Validate — refuse to produce a JSON for an invalid profile.
    let errors = profile.validate();
    if !errors.is_empty() {
        let msg = errors
            .iter()
            .map(|e| e.to_string())
            .collect::<Vec<_>>()
            .join("; ");
        return Err(ProfileTranslationError::Invalid(msg));
    }

    // Step 3: Build the nono JSON profile value.
    let profile_json = build_nono_json(profile)?;

    // Step 4: Write to a temp file (mode 0600).
    let mut temp = tempfile::Builder::new()
        .prefix("nteract-nono-")
        .suffix(".json")
        .tempfile()?;

    // Set permissions to 0600 — profile contains credential names (no values,
    // but still sensitive routing configuration).
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let file = temp.as_file();
        let mut perms = file.metadata()?.permissions();
        perms.set_mode(0o600);
        file.set_permissions(perms)?;
    }

    let json_bytes = serde_json::to_vec_pretty(&profile_json)?;
    temp.write_all(&json_bytes)?;
    temp.flush()?;

    let profile_json_path = temp.into_temp_path();

    // Debug: log the full profile JSON so operators can inspect it.
    // Visible at RUST_LOG=debug or via `runt daemon logs`.
    tracing::info!(
        profile_path = %profile_json_path.display(),
        profile_json = %String::from_utf8_lossy(&json_bytes),
        "[nono::profile] generated nono profile",
    );

    // Step 5: Build --env-credential flags (sorted by keystore name for determinism).
    let mut sorted_creds = profile.credentials.clone();
    sorted_creds.sort_by(|a, b| a.name.cmp(&b.name));

    let mut env_credential_flags = Vec::new();
    for cred in &sorted_creds {
        env_credential_flags.push("--env-credential".to_string());
        env_credential_flags.push(cred.effective_keystore_name().to_string());
    }

    // Step 6: Kernel env overrides.
    //
    // nono automatically injects HTTP_PROXY, HTTPS_PROXY, NONO_PROXY_TOKEN,
    // and <SERVICE>_BASE_URL / <SERVICE>_API_KEY into the child's environment
    // at startup. We do not re-inject those here.
    //
    // We populate kernel_env_overrides with the effective env var names so task 07
    // has visibility into what the kernel will see. Values are left as empty
    // strings because the actual phantom tokens are generated by nono at runtime.
    //
    // If nono ever stops auto-injecting proxy env vars, replace this with explicit
    // HTTP_PROXY / HTTPS_PROXY entries pointing at the local proxy URL.
    let kernel_env_overrides: Vec<(OsString, OsString)> = sorted_creds
        .iter()
        .map(|cred| {
            (
                OsString::from(cred.effective_env_var()),
                OsString::from(""), // phantom value; set by nono at runtime
            )
        })
        .collect();

    Ok(TranslatedProfile {
        profile_json_path,
        env_credential_flags,
        kernel_env_overrides,
    })
}

// ── Private helpers ───────────────────────────────────────────────────

/// Build the nono 0.62.x JSON profile value from a [`SandboxProfile`].
///
/// Credentials are sorted by name for byte-identical deterministic output.
///
/// The nono JSON schema (confirmed against nono 0.62.0):
/// - `meta.name` / `meta.version` — profile identity
/// - `workdir.access` — always `"readwrite"` for kernel CWD access
/// - `network.credentials` — list of credential entry names to activate
/// - `network.custom_credentials` — per-route routing map (one entry per route)
/// - `network.allow_domain` — domain allowlist; always emitted for block-by-default
///
/// ## One entry per route
///
/// nono's `custom_credentials` map has exactly one `upstream` per entry.  A
/// `CredentialRef` with multiple `RouteRule`s is expanded into one entry per
/// route, keyed `<cred_name>__<route_index>` (0-based).  All per-route entries
/// share the same `credential_key` (the macOS Keychain account name) so nono
/// only loads the secret once.
///
/// Example: `my_demo_token` with two routes produces:
/// ```json
/// "credentials": ["my_demo_token__0", "my_demo_token__1"],
/// "custom_credentials": {
///   "my_demo_token__0": { "credential_key": "my_demo_token", "upstream": "http://localhost:8877", ... },
///   "my_demo_token__1": { "credential_key": "my_demo_token", "upstream": "https://5a52-….ngrok-free.app", ... }
/// }
/// ```
fn build_nono_json(profile: &SandboxProfile) -> Result<serde_json::Value, serde_json::Error> {
    // Sort credentials by name for determinism.
    let mut sorted_creds = profile.credentials.clone();
    sorted_creds.sort_by(|a, b| a.name.cmp(&b.name));

    // Expand each credential into one entry per route.  Credentials with no
    // routes are excluded from the profile JSON (nono requires `upstream` in
    // every `custom_credentials` entry); they are handled via `--env-credential`.
    //
    // Entry key: `<cred_name>__<route_index>` for multi-route credentials,
    // plain `<cred_name>` when there is exactly one route (preserves the
    // simple case and matches what pre-existing notebooks may expect).
    let mut credentials_list: Vec<serde_json::Value> = Vec::new();
    let mut custom_credentials = serde_json::Map::new();

    for cred in &sorted_creds {
        if cred.routes.is_empty() {
            continue;
        }
        for (idx, route) in cred.routes.iter().enumerate() {
            let entry_key = if cred.routes.len() == 1 {
                cred.name.clone()
            } else {
                format!("{}__{}", cred.name, idx)
            };
            credentials_list.push(json!(entry_key));
            let entry = build_route_entry(cred.effective_keystore_name(), route);
            custom_credentials.insert(entry_key, entry);
        }
    }

    // Build the network section.
    let mut network = serde_json::Map::new();

    if !credentials_list.is_empty() {
        network.insert("credentials".to_string(), json!(credentials_list));
        network.insert(
            "custom_credentials".to_string(),
            serde_json::Value::Object(custom_credentials),
        );
    }

    // Build the effective allow_domain list and always emit it.
    //
    // We always emit `allow_domain` — even as an empty list — so nono
    // enforces block-by-default network access.  Without this field nono
    // allows all outbound connections, defeating the sandbox (the kernel
    // could reach arbitrary hosts without restriction).
    //
    // Credential route hosts are auto-included: CONNECT-intercept credential
    // injection only activates when the target host is in `allow_domain`.
    // Without it nono falls back to plain `connect` tunnel mode (raw TLS
    // relay, no header injection), so the credential is silently not applied.
    // The user should not need to duplicate route hosts in `allowed_domains`.
    let mut effective_allow_domains: Vec<String> = profile
        .credentials
        .iter()
        .flat_map(|c| c.routes.iter().map(|r| r.host.clone()))
        .chain(profile.allowed_domains.iter().cloned())
        .collect();
    effective_allow_domains.sort();
    effective_allow_domains.dedup();
    network.insert("allow_domain".to_string(), json!(effective_allow_domains));

    Ok(json!({
        "meta": {
            "name": "nteract-kernel-proxy",
            "description": "Credential injection proxy for Python kernels — generated by nteract",
            "version": "1.0.0"
        },
        "workdir": {
            "access": "readwrite"
        },
        "network": serde_json::Value::Object(network)
    }))
}

/// Build one `custom_credentials` entry for a single route.
///
/// - `credential_key` — the macOS Keychain account name (shared across all
///   per-route entries that belong to the same `CredentialRef`)
/// - `upstream` — `<scheme>://<host>` from the route
/// - `inject_mode` — always emitted; `"header"`, `"basic_auth"`, or
///   `"query_param"` (nono 0.62+ feature, see always-further/nono#165)
/// - `inject_header` — set when `inject_as = Header`; nono uses this as the
///   target header name
/// - `credential_format` — set when `inject_as = Header`; template with
///   `{credential}` → `{}`. Not emitted for `BasicAuth` (nono handles
///   base64-encoding internally) or `Query` (nono uses `query_param_name`).
fn build_route_entry(
    credential_key: &str,
    route: &notebook_doc::sandbox::RouteRule,
) -> serde_json::Value {
    let upstream = format!("{}://{}", route.scheme.as_str(), route.host);
    let mut entry = serde_json::Map::new();
    entry.insert("credential_key".to_string(), json!(credential_key));
    entry.insert("upstream".to_string(), json!(upstream));

    match route.inject_as {
        InjectionKind::Header => {
            entry.insert("inject_mode".to_string(), json!("header"));
            if let Some(header_name) = &route.header {
                entry.insert("inject_header".to_string(), json!(header_name));
            }
            let format_str = route.template.replace("{credential}", "{}");
            entry.insert("credential_format".to_string(), json!(format_str));
        }
        InjectionKind::BasicAuth => {
            entry.insert("inject_mode".to_string(), json!("basic_auth"));
        }
        InjectionKind::Query => {
            entry.insert("inject_mode".to_string(), json!("query_param"));
            let format_str = route.template.replace("{credential}", "{}");
            entry.insert("query_param_name".to_string(), json!(format_str));
        }
    }

    serde_json::Value::Object(entry)
}

// ── Tests ─────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use std::fs;

    use notebook_doc::sandbox::{CredentialRef, InjectionKind, RouteRule, SandboxProfile};

    use super::*;

    // ── Helper builders ────────────────────────────────────────────────

    fn make_profile_with_cred() -> SandboxProfile {
        SandboxProfile {
            enabled: true,
            credentials: vec![CredentialRef {
                name: "analytics_api".to_string(),
                description: Some("API key for analytics".to_string()),
                env_var: None,
                keystore_name: None,
                routes: vec![RouteRule {
                    host: "api.analytics.example.com".to_string(),
                    inject_as: InjectionKind::Header,
                    header: Some("Authorization".to_string()),
                    template: "Bearer {credential}".to_string(),
                    scheme: notebook_doc::sandbox::RouteScheme::Https,
                }],
            }],
            allowed_domains: vec!["api.analytics.example.com".to_string()],
        }
    }

    fn make_multi_cred_profile() -> SandboxProfile {
        SandboxProfile {
            enabled: true,
            credentials: vec![
                CredentialRef {
                    name: "zz_last".to_string(),
                    description: None,
                    env_var: None,
                    keystore_name: None,
                    routes: vec![],
                },
                CredentialRef {
                    name: "aa_first".to_string(),
                    description: None,
                    env_var: None,
                    keystore_name: None,
                    routes: vec![],
                },
            ],
            allowed_domains: vec![],
        }
    }

    // ── Disabled profile ───────────────────────────────────────────────

    #[test]
    fn disabled_profile_returns_error() {
        let profile = SandboxProfile {
            enabled: false,
            credentials: vec![],
            allowed_domains: vec![],
        };
        let err = translate(&profile).expect_err("expected Disabled error");
        assert!(
            matches!(err, ProfileTranslationError::Disabled),
            "expected Disabled, got: {err}"
        );
    }

    // ── Invalid profile ────────────────────────────────────────────────

    #[test]
    fn invalid_profile_returns_error() {
        let profile = SandboxProfile {
            enabled: true,
            credentials: vec![CredentialRef {
                name: "123bad".to_string(), // starts with digit — invalid
                description: None,
                env_var: None,
                keystore_name: None,
                routes: vec![],
            }],
            allowed_domains: vec![],
        };
        let err = translate(&profile).expect_err("expected Invalid error");
        assert!(
            matches!(err, ProfileTranslationError::Invalid(_)),
            "expected Invalid, got: {err}"
        );
    }

    // ── Temp file creation and cleanup ─────────────────────────────────

    #[test]
    fn temp_file_is_created_and_deleted_on_drop() {
        let profile = make_profile_with_cred();
        let result = translate(&profile).expect("translate");

        let path = result.profile_json_path.to_path_buf();
        assert!(path.exists(), "temp file should exist while held");

        // Drop the TranslatedProfile — TempPath deletes the file.
        drop(result);
        assert!(!path.exists(), "temp file should be deleted after drop");
    }

    // ── Round-trip: valid JSON readable by serde_json ──────────────────

    #[test]
    fn translate_produces_valid_json() {
        let profile = make_profile_with_cred();
        let result = translate(&profile).expect("translate");

        let contents = fs::read_to_string(&result.profile_json_path).expect("read temp file");
        let parsed: serde_json::Value =
            serde_json::from_str(&contents).expect("should be valid JSON");

        // Verify top-level structure.
        assert!(parsed.get("meta").is_some(), "should have 'meta' key");
        assert!(parsed.get("network").is_some(), "should have 'network' key");
        assert!(parsed.get("workdir").is_some(), "should have 'workdir' key");
    }

    #[test]
    fn translate_includes_credential_in_json() {
        let profile = make_profile_with_cred();
        let result = translate(&profile).expect("translate");

        let contents = fs::read_to_string(&result.profile_json_path).expect("read");
        let parsed: serde_json::Value = serde_json::from_str(&contents).expect("parse");

        let creds = parsed["network"]["credentials"]
            .as_array()
            .expect("credentials array");
        assert_eq!(creds.len(), 1);
        assert_eq!(creds[0], "analytics_api");

        let custom = &parsed["network"]["custom_credentials"]["analytics_api"];
        assert_eq!(custom["credential_key"], "analytics_api");
        assert_eq!(custom["inject_mode"], "header");
        assert_eq!(custom["inject_header"], "Authorization");
        // Template {credential} → {} conversion
        assert_eq!(custom["credential_format"], "Bearer {}");
        assert_eq!(custom["upstream"], "https://api.analytics.example.com");
    }

    #[test]
    fn basic_auth_route_emits_inject_mode_not_inject_header() {
        let profile = SandboxProfile {
            enabled: true,
            credentials: vec![CredentialRef {
                name: "jira_creds".to_string(),
                description: None,
                env_var: None,
                keystore_name: None,
                routes: vec![RouteRule {
                    host: "mycompany.atlassian.net".to_string(),
                    inject_as: InjectionKind::BasicAuth,
                    header: None,
                    template: "{credential}".to_string(),
                    scheme: notebook_doc::sandbox::RouteScheme::Https,
                }],
            }],
            allowed_domains: vec![],
        };
        let result = translate(&profile).expect("translate");
        let contents = fs::read_to_string(&result.profile_json_path).expect("read");
        let parsed: serde_json::Value = serde_json::from_str(&contents).expect("parse");

        let custom = &parsed["network"]["custom_credentials"]["jira_creds"];
        assert_eq!(custom["inject_mode"], "basic_auth");
        assert_eq!(custom["upstream"], "https://mycompany.atlassian.net");
        // No inject_header or credential_format for basic_auth
        assert!(custom.get("inject_header").is_none());
        assert!(custom.get("credential_format").is_none());
    }

    #[test]
    fn translate_includes_allow_domain_in_json() {
        let profile = make_profile_with_cred();
        let result = translate(&profile).expect("translate");

        let contents = fs::read_to_string(&result.profile_json_path).expect("read");
        let parsed: serde_json::Value = serde_json::from_str(&contents).expect("parse");

        let domains = parsed["network"]["allow_domain"]
            .as_array()
            .expect("allow_domain array");
        assert_eq!(domains.len(), 1);
        assert_eq!(domains[0], "api.analytics.example.com");
    }

    // ── Determinism ────────────────────────────────────────────────────

    #[test]
    fn two_translate_calls_produce_identical_json() {
        let profile = make_profile_with_cred();

        let r1 = translate(&profile).expect("translate 1");
        let r2 = translate(&profile).expect("translate 2");

        let c1 = fs::read_to_string(&r1.profile_json_path).expect("read 1");
        let c2 = fs::read_to_string(&r2.profile_json_path).expect("read 2");

        assert_eq!(
            c1, c2,
            "two translations of the same profile must be byte-identical"
        );
    }

    // ── Flag ordering ──────────────────────────────────────────────────

    #[test]
    fn env_credential_flags_sorted_by_name() {
        // Profile has credentials in reverse alphabetical order; flags must be sorted.
        let profile = make_multi_cred_profile();
        let result = translate(&profile).expect("translate");

        // Flags should be: ["--env-credential", "aa_first", "--env-credential", "zz_last"]
        assert_eq!(result.env_credential_flags.len(), 4);
        assert_eq!(result.env_credential_flags[0], "--env-credential");
        assert_eq!(result.env_credential_flags[1], "aa_first");
        assert_eq!(result.env_credential_flags[2], "--env-credential");
        assert_eq!(result.env_credential_flags[3], "zz_last");
    }

    #[test]
    fn env_credential_flags_use_effective_keystore_name() {
        let profile = SandboxProfile {
            enabled: true,
            credentials: vec![CredentialRef {
                name: "my_key".to_string(),
                description: None,
                env_var: None,
                keystore_name: Some("keychain-entry-name".to_string()),
                routes: vec![],
            }],
            allowed_domains: vec![],
        };
        let result = translate(&profile).expect("translate");

        assert_eq!(result.env_credential_flags.len(), 2);
        assert_eq!(result.env_credential_flags[0], "--env-credential");
        assert_eq!(result.env_credential_flags[1], "keychain-entry-name");
    }

    // ── Kernel env overrides ───────────────────────────────────────────

    #[test]
    fn kernel_env_overrides_include_effective_env_var_names() {
        let profile = make_profile_with_cred();
        let result = translate(&profile).expect("translate");

        // analytics_api → ANALYTICS_API
        assert_eq!(result.kernel_env_overrides.len(), 1);
        assert_eq!(result.kernel_env_overrides[0].0, "ANALYTICS_API");
    }

    #[test]
    fn kernel_env_overrides_use_explicit_env_var_if_set() {
        let profile = SandboxProfile {
            enabled: true,
            credentials: vec![CredentialRef {
                name: "my_key".to_string(),
                description: None,
                env_var: Some("CUSTOM_ENV_VAR".to_string()),
                keystore_name: None,
                routes: vec![],
            }],
            allowed_domains: vec![],
        };
        let result = translate(&profile).expect("translate");

        assert_eq!(result.kernel_env_overrides.len(), 1);
        assert_eq!(result.kernel_env_overrides[0].0, "CUSTOM_ENV_VAR");
    }

    // ── Empty credentials and allowed_domains ─────────────────────────

    #[test]
    fn empty_credentials_produces_valid_json() {
        let profile = SandboxProfile {
            enabled: true,
            credentials: vec![],
            allowed_domains: vec![],
        };
        let result = translate(&profile).expect("translate");

        let contents = fs::read_to_string(&result.profile_json_path).expect("read");
        let parsed: serde_json::Value = serde_json::from_str(&contents).expect("parse");

        // No credentials → no credentials list in network
        assert!(
            parsed["network"]["credentials"].is_null(),
            "empty credentials should omit the credentials field"
        );
        // allow_domain is ALWAYS present, even when empty — enforces block-by-default.
        let domains = parsed["network"]["allow_domain"]
            .as_array()
            .expect("allow_domain must always be present (block-by-default)");
        assert!(
            domains.is_empty(),
            "empty profile should produce an empty allow_domain list"
        );

        assert!(result.env_credential_flags.is_empty());
        assert!(result.kernel_env_overrides.is_empty());
    }

    #[test]
    fn empty_credentials_with_domains_produces_allow_domain() {
        let profile = SandboxProfile {
            enabled: true,
            credentials: vec![],
            allowed_domains: vec!["cdn.example.com".to_string(), "api.example.com".to_string()],
        };
        let result = translate(&profile).expect("translate");

        let contents = fs::read_to_string(&result.profile_json_path).expect("read");
        let parsed: serde_json::Value = serde_json::from_str(&contents).expect("parse");

        // Domains are sorted for determinism
        let domains = parsed["network"]["allow_domain"]
            .as_array()
            .expect("allow_domain");
        assert_eq!(domains[0], "api.example.com"); // sorted before cdn
        assert_eq!(domains[1], "cdn.example.com");
    }

    // ── JSON sorted for determinism across multi-credential profiles ───

    #[test]
    fn multi_credential_json_sorted_by_name() {
        // Give both credentials routes so they appear in the credentials JSON array.
        let profile = SandboxProfile {
            enabled: true,
            credentials: vec![
                CredentialRef {
                    name: "zz_last".to_string(),
                    description: None,
                    env_var: None,
                    keystore_name: None,
                    routes: vec![RouteRule {
                        host: "zz.example.com".to_string(),
                        inject_as: InjectionKind::Header,
                        header: Some("Authorization".to_string()),
                        template: "Bearer {credential}".to_string(),
                        scheme: notebook_doc::sandbox::RouteScheme::Https,
                    }],
                },
                CredentialRef {
                    name: "aa_first".to_string(),
                    description: None,
                    env_var: None,
                    keystore_name: None,
                    routes: vec![RouteRule {
                        host: "aa.example.com".to_string(),
                        inject_as: InjectionKind::Header,
                        header: Some("Authorization".to_string()),
                        template: "Bearer {credential}".to_string(),
                        scheme: notebook_doc::sandbox::RouteScheme::Https,
                    }],
                },
            ],
            allowed_domains: vec![],
        };
        let result = translate(&profile).expect("translate");

        let contents = fs::read_to_string(&result.profile_json_path).expect("read");
        let parsed: serde_json::Value = serde_json::from_str(&contents).expect("parse");

        let creds = parsed["network"]["credentials"]
            .as_array()
            .expect("credentials");
        // Sorted: aa_first before zz_last
        assert_eq!(creds[0], "aa_first");
        assert_eq!(creds[1], "zz_last");
    }

    // ── workdir is always readwrite ────────────────────────────────────

    #[test]
    fn workdir_access_is_readwrite() {
        let profile = make_profile_with_cred();
        let result = translate(&profile).expect("translate");

        let contents = fs::read_to_string(&result.profile_json_path).expect("read");
        let parsed: serde_json::Value = serde_json::from_str(&contents).expect("parse");

        assert_eq!(parsed["workdir"]["access"], "readwrite");
    }

    // ── Credentials without routes are excluded from custom_credentials ──

    /// Credentials with no routes cannot appear in `custom_credentials`
    /// because nono 0.62.x requires `upstream` in every entry.  They are
    /// still passed via `--env-credential` for plain env-var injection.
    #[test]
    fn credential_without_routes_not_in_custom_credentials() {
        let profile = SandboxProfile {
            enabled: true,
            credentials: vec![CredentialRef {
                name: "my_token".to_string(),
                description: None,
                env_var: None,
                keystore_name: Some("custom_keychain_key".to_string()),
                routes: vec![],
            }],
            allowed_domains: vec![],
        };
        let result = translate(&profile).expect("translate");

        let contents = fs::read_to_string(&result.profile_json_path).expect("read");
        let parsed: serde_json::Value = serde_json::from_str(&contents).expect("parse");

        // No routes → no custom_credentials entry (nono requires upstream).
        assert!(
            parsed["network"]["custom_credentials"].is_null(),
            "credential with no routes must not appear in custom_credentials"
        );
        // Still passed via --env-credential for plain env-var injection.
        assert_eq!(result.env_credential_flags.len(), 2);
        assert_eq!(result.env_credential_flags[1], "custom_keychain_key");
    }

    // ── block-by-default: allow_domain always present ─────────────────

    /// A sandbox with no allowed domains and no credential routes should emit
    /// `allow_domain: []`.  The empty list tells nono to block all outbound
    /// connections except the ZMQ ports opened via `--open-port`.  Without
    /// this field nono would allow all connections, defeating the sandbox.
    #[test]
    fn allow_domain_always_present_even_when_empty() {
        let profile = SandboxProfile {
            enabled: true,
            credentials: vec![],
            allowed_domains: vec![],
        };
        let result = translate(&profile).expect("translate");
        let contents = fs::read_to_string(&result.profile_json_path).expect("read");
        let parsed: serde_json::Value = serde_json::from_str(&contents).expect("parse");

        let domains = parsed["network"]["allow_domain"]
            .as_array()
            .expect("allow_domain must always be present");
        assert!(domains.is_empty(), "no routes/domains → empty allow_domain");
    }

    // ── credential route hosts auto-included in allow_domain ──────────

    /// Route hosts are automatically added to `allow_domain` so that nono
    /// can activate `connect_intercept` mode for those hosts.  Without the
    /// host in `allow_domain` nono falls back to plain CONNECT tunnel (no
    /// header injection), silently skipping credential injection.
    #[test]
    fn credential_route_host_auto_included_in_allow_domain() {
        let profile = SandboxProfile {
            enabled: true,
            credentials: vec![CredentialRef {
                name: "ngrok_cred".to_string(),
                description: None,
                env_var: None,
                keystore_name: None,
                routes: vec![RouteRule {
                    host: "5a52-8-29-230-88.ngrok-free.app".to_string(),
                    inject_as: InjectionKind::Header,
                    header: Some("Authorization".to_string()),
                    template: "Bearer {credential}".to_string(),
                    scheme: notebook_doc::sandbox::RouteScheme::Https,
                }],
            }],
            allowed_domains: vec![],
        };
        let result = translate(&profile).expect("translate");
        let contents = fs::read_to_string(&result.profile_json_path).expect("read");
        let parsed: serde_json::Value = serde_json::from_str(&contents).expect("parse");

        let domains = parsed["network"]["allow_domain"]
            .as_array()
            .expect("allow_domain must be present");
        assert_eq!(domains.len(), 1);
        assert_eq!(
            domains[0], "5a52-8-29-230-88.ngrok-free.app",
            "route host must be auto-included in allow_domain"
        );
    }

    /// Route hosts and user-specified allowed_domains are merged and
    /// deduplicated.  A domain that appears both as a route host and in
    /// allowed_domains should appear only once.
    #[test]
    fn route_hosts_and_allowed_domains_are_merged_and_deduped() {
        let profile = SandboxProfile {
            enabled: true,
            credentials: vec![CredentialRef {
                name: "api_cred".to_string(),
                description: None,
                env_var: None,
                keystore_name: None,
                routes: vec![RouteRule {
                    host: "api.example.com".to_string(),
                    inject_as: InjectionKind::Header,
                    header: Some("Authorization".to_string()),
                    template: "Bearer {credential}".to_string(),
                    scheme: notebook_doc::sandbox::RouteScheme::Https,
                }],
            }],
            // api.example.com also in allowed_domains — should appear once.
            allowed_domains: vec![
                "api.example.com".to_string(),
                "cdn.example.com".to_string(),
            ],
        };
        let result = translate(&profile).expect("translate");
        let contents = fs::read_to_string(&result.profile_json_path).expect("read");
        let parsed: serde_json::Value = serde_json::from_str(&contents).expect("parse");

        let domains = parsed["network"]["allow_domain"]
            .as_array()
            .expect("allow_domain must be present");
        // sorted + deduped: ["api.example.com", "cdn.example.com"]
        assert_eq!(domains.len(), 2, "duplicate should be removed");
        assert_eq!(domains[0], "api.example.com");
        assert_eq!(domains[1], "cdn.example.com");
    }
}
