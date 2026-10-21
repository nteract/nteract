//! Passive discovery of user-owned Conda prefixes. The daemon shares one
//! inventory; refresh is explicit and concurrent callers join the same scan.
//! Filesystem evidence is a readiness filter, never a guarantee of importability.
//! An in-flight scan is retained even when every caller disconnects: blocking OS
//! calls cannot be cancelled, so retries must not accumulate abandoned scans.

use std::collections::HashSet;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use notebook_protocol::protocol::{
    CondaEnvironmentInventory, InstalledCondaPackage, InstalledCondaPackageInventory,
    LocalCondaEnvironment,
};
use sha2::{Digest, Sha256};
use tokio::sync::{watch, Semaphore};

const MAX_ROOTS: usize = 32;
const MAX_DIRECTORY_ENTRIES: usize = 2048;
const MAX_SCAN_ENTRIES: usize = 16 * 1024;
const MAX_REGISTRY_BYTES: usize = 64 * 1024;
const MAX_METADATA_BYTES: usize = 1024 * 1024;
const MAX_PYTHON_RECORDS: usize = 16;
const MAX_ENVIRONMENTS: usize = 250;
pub(crate) const MAX_INSTALLED_CONDA_PACKAGES: usize = 20_000;
const MAX_INSTALLED_CONDA_DIRECTORY_ENTRIES: usize = 32_768;
const MAX_CONDA_RECORD_BYTES: u64 = 256 * 1024;
const MAX_TOTAL_CONDA_RECORD_BYTES: u64 = 64 * 1024 * 1024;
const MAX_WARNINGS: usize = 32;

#[derive(Clone, Default)]
struct DiscoverySources {
    prefixes: Vec<PathBuf>,
    envs_dirs: Vec<PathBuf>,
    registry: Option<PathBuf>,
    #[cfg(test)]
    scan_gate: Option<std::sync::Arc<ScanGate>>,
}

impl DiscoverySources {
    fn configured() -> Self {
        let mut sources = Self::default();
        for key in ["CONDA_ENVS_PATH", "CONDA_ENVS_DIRS"] {
            if let Some(value) = std::env::var_os(key) {
                sources
                    .envs_dirs
                    .extend(std::env::split_paths(&value).take(MAX_ROOTS + 1));
            }
        }
        for key in ["CONDA_PREFIX", "MAMBA_ROOT_PREFIX"] {
            if let Some(value) = std::env::var_os(key) {
                sources.add_root(PathBuf::from(value));
            }
        }
        if let Some(exe) = std::env::var_os("CONDA_EXE") {
            let exe = PathBuf::from(exe);
            if let Some(bin) = exe.parent() {
                if bin.file_name().is_some_and(|name| {
                    matches!(
                        name.to_string_lossy().to_ascii_lowercase().as_str(),
                        "bin" | "scripts" | "condabin"
                    )
                }) {
                    if let Some(root) = bin.parent() {
                        sources.add_root(root.to_path_buf());
                    }
                }
            }
        }
        if let Some(home) = dirs::home_dir() {
            for name in ["anaconda3", "miniconda3", "miniforge3", "mambaforge"] {
                sources.add_root(home.join(name));
            }
            sources.envs_dirs.push(home.join(".conda/envs"));
            sources.add_root(home.join(".local/share/mamba"));
            sources.registry = Some(home.join(".conda/environments.txt"));
        }
        #[cfg(windows)]
        for key in ["LOCALAPPDATA", "PROGRAMDATA"] {
            if let Some(dir) = std::env::var_os(key) {
                for name in ["anaconda3", "miniconda3", "miniforge3"] {
                    sources.add_root(PathBuf::from(&dir).join(name));
                }
            }
        }
        #[cfg(unix)]
        for path in [
            "/opt/conda",
            "/opt/anaconda3",
            "/opt/miniconda3",
            "/opt/miniforge3",
        ] {
            sources.add_root(PathBuf::from(path));
        }
        sources
    }

    fn add_root(&mut self, root: PathBuf) {
        self.envs_dirs.push(root.join("envs"));
        self.prefixes.push(root);
    }
}

#[cfg(test)]
#[derive(Default)]
struct ScanGate {
    started: tokio::sync::Notify,
    released: std::sync::Mutex<bool>,
    wake: std::sync::Condvar,
    scans: std::sync::atomic::AtomicUsize,
    entries: std::sync::atomic::AtomicUsize,
    files_read: std::sync::atomic::AtomicUsize,
}

#[cfg(test)]
impl ScanGate {
    fn release(&self) {
        *self
            .released
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = true;
        self.wake.notify_all();
    }
}

pub(crate) struct LocalCondaEnvironments {
    sources: DiscoverySources,
    state: Arc<Mutex<InventoryState>>,
    filesystem: Arc<Semaphore>,
}

type InventoryResult = Result<CondaEnvironmentInventory, String>;

#[derive(Default)]
struct InventoryState {
    cached: Option<CondaEnvironmentInventory>,
    in_flight: Option<watch::Receiver<Option<InventoryResult>>>,
}

impl Default for LocalCondaEnvironments {
    fn default() -> Self {
        Self::new(DiscoverySources::configured())
    }
}

impl LocalCondaEnvironments {
    fn new(sources: DiscoverySources) -> Self {
        Self {
            sources,
            state: Arc::new(Mutex::new(InventoryState::default())),
            filesystem: Arc::new(Semaphore::new(1)),
        }
    }

    pub(crate) async fn inventory(&self, refresh: bool) -> InventoryResult {
        let mut response = {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "Conda inventory lock failed")?;
            if let Some(in_flight) = &state.in_flight {
                in_flight.clone()
            } else {
                if !refresh {
                    if let Some(cached) = &state.cached {
                        return Ok(cached.clone());
                    }
                }
                let (sender, receiver) = watch::channel(None);
                state.in_flight = Some(receiver.clone());
                let state = self.state.clone();
                let sources = self.sources.clone();
                let filesystem = self.filesystem.clone();
                tokio::spawn(async move {
                    let result = match filesystem.acquire_owned().await {
                        Ok(permit) => tokio::task::spawn_blocking(move || {
                            let _permit = permit;
                            scan_inventory(sources)
                        })
                        .await
                        .map_err(|error| format!("Conda discovery worker failed: {error}")),
                        Err(_) => Err("Conda discovery worker stopped".to_string()),
                    };
                    if let Ok(mut state) = state.lock() {
                        if let Ok(inventory) = &result {
                            state.cached = Some(inventory.clone());
                        }
                        state.in_flight = None;
                    }
                    sender.send_replace(Some(result));
                });
                receiver
            }
        };
        loop {
            if let Some(result) = response.borrow().clone() {
                return result;
            }
            response
                .changed()
                .await
                .map_err(|_| "Conda discovery worker stopped")?;
        }
    }

    pub(crate) async fn resolve_prefix(
        &self,
        prefix: PathBuf,
    ) -> Result<LocalCondaEnvironment, String> {
        if !prefix.is_absolute() {
            return Err("Enter an absolute Conda environment directory".to_string());
        }
        let permit = self
            .filesystem
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| "Conda discovery worker stopped")?;
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            validate_prefix(&prefix, &mut ScanEvidence::default())
        })
        .await
        .map_err(|error| format!("Conda prefix validation worker failed: {error}"))?
    }

    /// Read package records for a validated prefix without running Conda or Python.
    pub(crate) async fn installed_packages(
        prefix: PathBuf,
    ) -> Result<InstalledCondaPackageInventory, String> {
        tokio::task::spawn_blocking(move || read_installed_conda_packages(&prefix))
            .await
            .map_err(|error| format!("Installed package read failed: {error}"))?
    }
}

#[cfg(test)]
mod installed_package_tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn installed_records_are_sorted_and_invalid_records_are_reported() {
        let temp = TempDir::new().unwrap();
        let prefix = temp.path().join("borrowed");
        let metadata = prefix.join("conda-meta");
        std::fs::create_dir_all(&metadata).unwrap();
        std::fs::write(
            metadata.join("numpy-2.1.0-py312_0.json"),
            r#"{"name":"numpy","version":"2.1.0","build":"py312_0"}"#,
        )
        .unwrap();
        std::fs::write(
            metadata.join("python-3.12.7-h123_0.json"),
            r#"{"name":"python","version":"3.12.7","build":"h123_0"}"#,
        )
        .unwrap();
        std::fs::write(metadata.join("invalid-1.0-0.json"), "not json").unwrap();

        let inventory = read_installed_conda_packages(&prefix).unwrap();
        assert_eq!(
            inventory
                .packages
                .iter()
                .map(|package| package.name.as_str())
                .collect::<Vec<_>>(),
            ["numpy", "python"]
        );
        assert_eq!(inventory.packages[0].version, "2.1.0");
        assert_eq!(inventory.packages[0].build, "py312_0");
        assert!(!inventory.truncated);
        assert!(inventory
            .warnings
            .iter()
            .any(|warning| warning.contains("invalid Conda package record")));
    }

    #[test]
    fn installed_inventory_distinguishes_missing_metadata_from_empty_records() {
        let temp = TempDir::new().unwrap();
        let prefix = temp.path().join("borrowed");
        std::fs::create_dir_all(&prefix).unwrap();
        assert!(read_installed_conda_packages(&prefix)
            .unwrap_err()
            .contains("conda-meta"));

        std::fs::create_dir(prefix.join("conda-meta")).unwrap();
        let inventory = read_installed_conda_packages(&prefix).unwrap();
        assert!(inventory.packages.is_empty());
        assert!(!inventory.truncated);
        assert!(inventory.warnings.is_empty());
    }

    #[test]
    fn installed_inventory_bounds_all_directory_entries_not_only_json_records() {
        let temp = TempDir::new().unwrap();
        let prefix = temp.path().join("borrowed");
        let metadata = prefix.join("conda-meta");
        std::fs::create_dir_all(&metadata).unwrap();
        std::fs::write(
            metadata.join("numpy-2.1.0-py312_0.json"),
            r#"{"name":"numpy","version":"2.1.0","build":"py312_0"}"#,
        )
        .unwrap();
        for index in 0..7 {
            std::fs::write(metadata.join(format!("noise-{index}.txt")), "noise").unwrap();
        }

        let inventory = read_installed_conda_packages_with_entry_limit(&prefix, 3).unwrap();
        assert!(inventory.truncated);
        assert!(inventory
            .warnings
            .iter()
            .any(|warning| warning.contains("directory entry limit")));
    }

    #[test]
    fn installed_record_reader_stops_at_the_limit_plus_one_byte() {
        struct EndlessReader;
        impl Read for EndlessReader {
            fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
                buffer.fill(b'x');
                Ok(buffer.len())
            }
        }

        let result = read_limited_conda_record(EndlessReader, 32).unwrap();
        assert!(result.is_none());
    }
}

fn read_installed_conda_packages(prefix: &Path) -> Result<InstalledCondaPackageInventory, String> {
    read_installed_conda_packages_with_entry_limit(prefix, MAX_INSTALLED_CONDA_DIRECTORY_ENTRIES)
}

fn read_installed_conda_packages_with_entry_limit(
    prefix: &Path,
    max_directory_entries: usize,
) -> Result<InstalledCondaPackageInventory, String> {
    let canonical_prefix = std::fs::canonicalize(prefix)
        .map_err(|error| format!("Cannot access running Conda prefix: {error}"))?;
    let metadata = std::fs::canonicalize(canonical_prefix.join("conda-meta"))
        .map_err(|error| format!("Cannot read running prefix conda-meta records: {error}"))?;
    if !metadata.starts_with(&canonical_prefix) || !metadata.is_dir() {
        return Err("Running prefix has no usable conda-meta directory".into());
    }

    let entries = std::fs::read_dir(&metadata)
        .map_err(|error| format!("Cannot list Conda package records: {error}"))?;
    let mut record_paths = Vec::new();
    let mut warnings = Vec::new();
    let mut truncated = false;
    for (entries_seen, entry) in entries.enumerate() {
        if entries_seen >= max_directory_entries {
            truncated = true;
            warnings.push("Conda metadata directory entry limit reached".into());
            break;
        }
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                truncated = true;
                if warnings.len() < MAX_WARNINGS {
                    warnings.push(format!("Could not read a Conda package entry: {error}"));
                }
                continue;
            }
        };
        if entry
            .path()
            .extension()
            .is_some_and(|extension| extension == "json")
        {
            if record_paths.len() == MAX_INSTALLED_CONDA_PACKAGES {
                truncated = true;
                break;
            }
            record_paths.push(entry.path());
        }
    }
    record_paths.sort();

    let mut packages = Vec::with_capacity(record_paths.len());
    let mut total_record_bytes = 0_u64;
    for record_path in record_paths {
        let metadata = match std::fs::symlink_metadata(&record_path) {
            Ok(metadata) if metadata.file_type().is_file() => metadata,
            Ok(_) => {
                if warnings.len() < MAX_WARNINGS {
                    warnings.push("Skipped a non-regular Conda package record".into());
                }
                continue;
            }
            Err(error) => {
                if warnings.len() < MAX_WARNINGS {
                    warnings.push(format!("Could not inspect a Conda package record: {error}"));
                }
                continue;
            }
        };
        if metadata.len() > MAX_CONDA_RECORD_BYTES
            || metadata.len() > MAX_TOTAL_CONDA_RECORD_BYTES.saturating_sub(total_record_bytes)
        {
            truncated = true;
            if warnings.len() < MAX_WARNINGS {
                warnings.push("Conda package record byte budget reached".into());
            }
            break;
        }
        total_record_bytes += metadata.len();
        let file = match std::fs::File::open(&record_path) {
            Ok(file) => file,
            Err(error) => {
                if warnings.len() < MAX_WARNINGS {
                    warnings.push(format!("Could not read a Conda package record: {error}"));
                }
                continue;
            }
        };
        let bytes = match read_limited_conda_record(file, MAX_CONDA_RECORD_BYTES) {
            Ok(Some(bytes)) => bytes,
            Ok(None) => {
                truncated = true;
                if warnings.len() < MAX_WARNINGS {
                    warnings.push("Conda package record grew beyond its read limit".into());
                }
                break;
            }
            Err(error) => {
                if warnings.len() < MAX_WARNINGS {
                    warnings.push(format!("Could not read a Conda package record: {error}"));
                }
                continue;
            }
        };
        let record: CondaPackageRecord = match serde_json::from_slice::<CondaPackageRecord>(&bytes)
        {
            Ok(record) if !record.name.trim().is_empty() && !record.version.trim().is_empty() => {
                record
            }
            Ok(_) => {
                if warnings.len() < MAX_WARNINGS {
                    warnings
                        .push("Skipped a Conda package record with missing name or version".into());
                }
                continue;
            }
            Err(error) => {
                if warnings.len() < MAX_WARNINGS {
                    warnings.push(format!("Skipped an invalid Conda package record: {error}"));
                }
                continue;
            }
        };
        packages.push(InstalledCondaPackage {
            name: record.name,
            version: record.version,
            build: record.build.unwrap_or_default(),
        });
    }
    packages.sort_by(|left, right| {
        left.name
            .to_ascii_lowercase()
            .cmp(&right.name.to_ascii_lowercase())
            .then_with(|| left.version.cmp(&right.version))
            .then_with(|| left.build.cmp(&right.build))
    });
    if truncated && warnings.is_empty() {
        warnings.push("Installed Conda package record limit reached".into());
    }
    Ok(InstalledCondaPackageInventory {
        packages,
        truncated,
        warnings,
    })
}

fn read_limited_conda_record(
    reader: impl Read,
    max_bytes: u64,
) -> std::io::Result<Option<Vec<u8>>> {
    let mut bytes = Vec::new();
    reader
        .take(max_bytes.saturating_add(1))
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > max_bytes {
        return Ok(None);
    }
    Ok(Some(bytes))
}

#[derive(serde::Deserialize)]
struct CondaPackageRecord {
    name: String,
    version: String,
    #[serde(default)]
    build: Option<String>,
}

#[derive(Default)]
struct ScanEvidence {
    truncated: bool,
    warnings: Vec<String>,
    entries: usize,
    prefixes: usize,
    files_read: usize,
}

impl ScanEvidence {
    fn warn(&mut self, warning: String, truncated: bool) {
        self.truncated |= truncated;
        if self.warnings.len() < MAX_WARNINGS && !self.warnings.contains(&warning) {
            self.warnings.push(warning);
        }
    }
}

fn bounded_file(
    path: &Path,
    limit: usize,
    evidence: &mut ScanEvidence,
) -> std::io::Result<Vec<u8>> {
    let metadata = std::fs::metadata(path)?;
    if !metadata.is_file() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "not a regular file",
        ));
    }
    let file = std::fs::File::open(path)?;
    let mut bytes = Vec::new();
    file.take((limit + 1) as u64).read_to_end(&mut bytes)?;
    evidence.files_read += 1;
    Ok(bytes)
}

fn directory_entries(path: &Path, evidence: &mut ScanEvidence) -> Vec<PathBuf> {
    let directory = match std::fs::read_dir(path) {
        Ok(directory) => directory,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Vec::new(),
        Err(error) => {
            evidence.warn(
                format!("Could not read Conda directory {}: {error}", path.display()),
                false,
            );
            return Vec::new();
        }
    };
    let mut paths = Vec::new();
    for (index, entry) in directory.enumerate() {
        if evidence.entries == MAX_SCAN_ENTRIES {
            evidence.warn(
                "Conda scan entry budget reached; inventory is incomplete".to_string(),
                true,
            );
            break;
        }
        if index == MAX_DIRECTORY_ENTRIES {
            evidence.warn(
                format!("Conda directory entry budget reached at {}", path.display()),
                true,
            );
            break;
        }
        evidence.entries += 1;
        match entry {
            Ok(entry) => paths.push(entry.path()),
            Err(error) => evidence.warn(
                format!("Could not read Conda entry at {}: {error}", path.display()),
                false,
            ),
        }
    }
    paths.sort();
    paths
}

fn scan_inventory(sources: DiscoverySources) -> CondaEnvironmentInventory {
    #[cfg(test)]
    if let Some(gate) = &sources.scan_gate {
        gate.scans.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        gate.started.notify_one();
        let mut released = gate
            .released
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        while !*released {
            released = gate
                .wake
                .wait(released)
                .unwrap_or_else(|error| error.into_inner());
        }
    }
    let started = Instant::now();
    let mut evidence = ScanEvidence::default();
    let mut roots = HashSet::new();
    let mut candidates = HashSet::new();
    for (path, enumerate) in sources
        .prefixes
        .into_iter()
        .map(|path| (path, false))
        .chain(sources.envs_dirs.into_iter().map(|path| (path, true)))
    {
        if !path.is_absolute() || !roots.insert((path.clone(), enumerate)) {
            continue;
        }
        if roots.len() > MAX_ROOTS {
            evidence.warn(
                "Conda root budget reached; inventory is incomplete".to_string(),
                true,
            );
            break;
        }
        if enumerate {
            candidates.extend(directory_entries(&path, &mut evidence));
        } else {
            candidates.insert(path);
        }
    }
    if let Some(registry) = sources.registry {
        match bounded_file(&registry, MAX_REGISTRY_BYTES, &mut evidence) {
            Ok(mut bytes) => {
                if bytes.len() > MAX_REGISTRY_BYTES {
                    evidence.warn(
                        "Conda registry size budget reached; inventory is incomplete".to_string(),
                        true,
                    );
                    let complete = bytes[..MAX_REGISTRY_BYTES]
                        .iter()
                        .rposition(|byte| *byte == b'\n')
                        .map_or(0, |index| index + 1);
                    bytes.truncate(complete);
                }
                match String::from_utf8(bytes) {
                    Ok(content) => {
                        for (index, line) in content.lines().enumerate() {
                            if index == MAX_DIRECTORY_ENTRIES {
                                evidence
                                    .warn("Conda registry entry budget reached".to_string(), true);
                                break;
                            }
                            let path = PathBuf::from(line.trim());
                            if path.is_absolute() {
                                candidates.insert(path);
                            }
                        }
                    }
                    Err(_) => evidence.warn(
                        "Conda registry is not UTF-8; registered prefixes were omitted".to_string(),
                        false,
                    ),
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => evidence.warn(format!("Could not read Conda registry: {error}"), false),
        }
    }
    let mut candidates: Vec<_> = candidates.into_iter().collect();
    candidates.sort();
    if candidates.len() > MAX_DIRECTORY_ENTRIES {
        candidates.truncate(MAX_DIRECTORY_ENTRIES);
        evidence.warn(
            "Conda candidate budget reached; inventory is incomplete".to_string(),
            true,
        );
    }
    let mut environments = Vec::new();
    let mut ids = HashSet::new();
    for prefix in candidates {
        evidence.prefixes += 1;
        if let Ok(environment) = validate_prefix(&prefix, &mut evidence) {
            if ids.insert(environment.id.clone()) {
                environments.push(environment);
            }
        }
    }
    environments.sort_by(|left, right| {
        left.name
            .to_lowercase()
            .cmp(&right.name.to_lowercase())
            .then_with(|| left.prefix.cmp(&right.prefix))
    });
    if environments.len() > MAX_ENVIRONMENTS {
        environments.truncate(MAX_ENVIRONMENTS);
        evidence.warn(
            "Conda environment result budget reached; inventory is incomplete".to_string(),
            true,
        );
    }
    evidence.warnings.sort();
    #[cfg(test)]
    if let Some(gate) = &sources.scan_gate {
        gate.entries
            .fetch_add(evidence.entries, std::sync::atomic::Ordering::SeqCst);
        gate.files_read
            .fetch_add(evidence.files_read, std::sync::atomic::Ordering::SeqCst);
    }
    tracing::debug!(
        elapsed_ms = started.elapsed().as_millis(),
        roots = roots.len().min(MAX_ROOTS),
        entries = evidence.entries,
        prefixes = evidence.prefixes,
        files_read = evidence.files_read,
        environments = environments.len(),
        truncated = evidence.truncated,
        "Passive Conda inventory scan completed"
    );
    CondaEnvironmentInventory {
        environments,
        truncated: evidence.truncated,
        warnings: evidence.warnings,
    }
}

fn python_major_minor(version: &str) -> Option<String> {
    let mut components = version.split('.');
    let major = components.next()?;
    let minor = components.next()?;
    if major.is_empty()
        || minor.is_empty()
        || !major.bytes().all(|byte| byte.is_ascii_digit())
        || !minor.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    Some(format!("{major}.{minor}"))
}

fn validate_prefix(
    path: &Path,
    evidence: &mut ScanEvidence,
) -> Result<LocalCondaEnvironment, String> {
    if !path.is_absolute() {
        return Err("Enter an absolute Conda environment directory".to_string());
    }
    let prefix = std::fs::canonicalize(path)
        .map_err(|_| "Conda environment directory does not exist or is inaccessible")?;
    if !prefix.is_dir() || !prefix.join("conda-meta").is_dir() {
        return Err("The directory is not a Conda environment (missing conda-meta)".to_string());
    }
    let python_path = crate::project_file::conda_python_path(&prefix);
    let resolved_python = std::fs::canonicalize(&python_path)
        .map_err(|_| "Conda environment has no accessible Python interpreter")?;
    if !resolved_python.is_file() || !resolved_python.starts_with(&prefix) {
        return Err(
            "Conda environment Python interpreter is not a file inside its prefix".to_string(),
        );
    }
    let records = directory_entries(&prefix.join("conda-meta"), evidence);
    let mut versions = HashSet::new();
    let mut python_records = 0;
    for record in records {
        if !record.file_name().is_some_and(|name| {
            let name = name.to_string_lossy();
            name.starts_with("python-") && name.ends_with(".json")
        }) {
            continue;
        }
        python_records += 1;
        if python_records > MAX_PYTHON_RECORDS {
            evidence.warn(
                "Conda Python metadata record budget reached".to_string(),
                true,
            );
            break;
        }
        match bounded_file(&record, MAX_METADATA_BYTES, evidence) {
            Ok(bytes) if bytes.len() <= MAX_METADATA_BYTES => {
                if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                    if value.get("name").and_then(|name| name.as_str()) == Some("python") {
                        if let Some(version) =
                            value.get("version").and_then(|version| version.as_str())
                        {
                            if python_major_minor(version).is_some() {
                                versions.insert(version.to_string());
                            }
                        }
                    }
                }
            }
            Ok(_) => evidence.warn(
                "Conda Python metadata size budget reached".to_string(),
                true,
            ),
            Err(error) => evidence.warn(
                format!("Could not read Conda Python metadata: {error}"),
                false,
            ),
        }
    }
    let python_version = if versions.len() == 1 {
        versions.into_iter().next()
    } else {
        None
    };
    let interpreter_version = resolved_python
        .file_name()
        .and_then(|name| name.to_str())
        .and_then(|name| name.strip_prefix("python"))
        .and_then(python_major_minor);
    let metadata_version = python_version.as_deref().and_then(python_major_minor);
    if interpreter_version
        .as_ref()
        .zip(metadata_version.as_ref())
        .is_some_and(|(interpreter, metadata)| interpreter != metadata)
    {
        return Err(
            "Cannot confirm ipykernel: Conda metadata and interpreter Python versions disagree"
                .to_string(),
        );
    }
    let site = if cfg!(windows) {
        prefix.join("Lib/site-packages")
    } else {
        let version = interpreter_version.or(metadata_version).ok_or("Cannot confirm ipykernel: Python site-packages layout is unknown for this Conda prefix")?;
        prefix
            .join("lib")
            .join(format!("python{version}"))
            .join("site-packages")
    };
    let resolved_site = std::fs::canonicalize(&site).map_err(|_| {
        "Cannot confirm ipykernel: supported site-packages is missing or inaccessible"
    })?;
    #[cfg(windows)]
    let same_site = resolved_site
        .to_string_lossy()
        .eq_ignore_ascii_case(&site.to_string_lossy());
    #[cfg(not(windows))]
    let same_site = resolved_site == site;
    if !same_site {
        return Err(
            "Cannot confirm ipykernel: site-packages resolves outside this Python version's supported layout".to_string(),
        );
    }
    let site = resolved_site;
    let own_file = |path: &Path| {
        std::fs::canonicalize(path).is_ok_and(|path| path.starts_with(&site) && path.is_file())
    };
    let mut ipykernel = own_file(&site.join("ipykernel/__init__.py"));
    if !ipykernel {
        for entry in directory_entries(&site, evidence) {
            let matching = entry.file_name().is_some_and(|name| {
                let name = name.to_string_lossy();
                name.strip_prefix("ipykernel-")
                    .and_then(|name| name.strip_suffix(".dist-info"))
                    .is_some_and(|version| {
                        !version.is_empty() && version.as_bytes()[0].is_ascii_digit()
                    })
            });
            if matching
                && std::fs::canonicalize(&entry)
                    .is_ok_and(|path| path.starts_with(&site) && path.is_dir())
            {
                ipykernel = true;
                break;
            }
        }
    }
    if !ipykernel {
        return Err("Cannot confirm ipykernel in this Conda prefix's supported site-packages; install it outside nteract or choose another environment".to_string());
    }
    #[cfg(windows)]
    let identity = prefix
        .as_os_str()
        .to_string_lossy()
        .to_lowercase()
        .into_bytes();
    #[cfg(not(windows))]
    let identity = prefix.as_os_str().as_encoded_bytes().to_vec();
    Ok(LocalCondaEnvironment {
        id: hex::encode(Sha256::digest(identity)),
        name: prefix
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| "Conda".to_string()),
        prefix,
        python_path,
        python_version,
    })
}

#[cfg(test)]
// Fixture setup failures should fail the test rather than obscure its assertions.
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use std::path::Path;
    use tempfile::TempDir;

    fn conda_prefix(path: &Path, version: Option<&str>, ipykernel: bool) -> PathBuf {
        std::fs::create_dir_all(path.join("conda-meta")).unwrap();
        let python = crate::project_file::conda_python_path(path);
        std::fs::create_dir_all(python.parent().unwrap()).unwrap();
        // Not executable: discovery and preflight must not run this interpreter.
        std::fs::write(&python, b"not an executable").unwrap();
        if let Some(version) = version {
            std::fs::write(
                path.join("conda-meta")
                    .join(format!("python-{version}-0.json")),
                serde_json::json!({"name": "python", "version": version}).to_string(),
            )
            .unwrap();
        }
        if ipykernel {
            let site = site_packages(path, "3.11");
            std::fs::create_dir_all(site.join("ipykernel")).unwrap();
            std::fs::write(site.join("ipykernel/__init__.py"), b"# fixture").unwrap();
        }
        path.to_path_buf()
    }

    fn site_packages(prefix: &Path, version: &str) -> PathBuf {
        if cfg!(windows) {
            prefix.join("Lib/site-packages")
        } else {
            prefix
                .join("lib")
                .join(format!("python{version}"))
                .join("site-packages")
        }
    }

    fn service(sources: DiscoverySources) -> LocalCondaEnvironments {
        LocalCondaEnvironments::new(sources)
    }

    #[tokio::test]
    async fn discovers_common_roots_and_registered_prefixes_without_executing_python() {
        let temp = TempDir::new().unwrap();
        let root = conda_prefix(&temp.path().join("anaconda3"), Some("3.11.9"), true);
        let named = conda_prefix(
            &root.join("envs/rankings with spaces"),
            Some("3.11.9"),
            true,
        );
        let registered = conda_prefix(&temp.path().join("custom/location"), Some("3.11.9"), true);
        let registry = temp.path().join("environments.txt");
        std::fs::write(
            &registry,
            format!("{}\n{}\n", registered.display(), named.display()),
        )
        .unwrap();
        let service = service(DiscoverySources {
            prefixes: vec![root.clone()],
            envs_dirs: vec![root.join("envs")],
            registry: Some(registry),
            ..DiscoverySources::default()
        });

        let inventory = service.inventory(false).await.unwrap();

        assert_eq!(inventory.environments.len(), 3);
        assert!(!inventory.truncated);
        assert!(inventory.warnings.is_empty());
        let names: Vec<_> = inventory
            .environments
            .iter()
            .map(|env| env.name.as_str())
            .collect();
        assert_eq!(names, ["anaconda3", "location", "rankings with spaces"]);
        let selected = service.resolve_prefix(named.clone()).await.unwrap();
        assert_eq!(selected.prefix, std::fs::canonicalize(&named).unwrap());
        assert_eq!(
            selected.python_path,
            crate::project_file::conda_python_path(&selected.prefix)
        );
        assert_eq!(selected.python_version.as_deref(), Some("3.11.9"));
        assert_eq!(
            std::fs::read(selected.python_path).unwrap(),
            b"not an executable"
        );
    }

    #[tokio::test]
    async fn typed_prefix_is_independent_of_inventory_and_revalidated_after_disappearance() {
        let temp = TempDir::new().unwrap();
        let prefix = conda_prefix(&temp.path().join("unregistered"), Some("3.11.9"), true);
        let service = service(DiscoverySources::default());
        assert!(service
            .inventory(false)
            .await
            .unwrap()
            .environments
            .is_empty());
        assert!(service.resolve_prefix(prefix.clone()).await.is_ok());
        std::fs::remove_dir_all(&prefix).unwrap();
        assert!(service
            .resolve_prefix(prefix)
            .await
            .unwrap_err()
            .contains("exist"));
    }

    #[tokio::test]
    async fn rejects_relative_non_conda_and_missing_python_prefixes() {
        let temp = TempDir::new().unwrap();
        let service = service(DiscoverySources::default());
        assert!(service
            .resolve_prefix(PathBuf::from("relative"))
            .await
            .unwrap_err()
            .contains("absolute"));
        assert!(service
            .resolve_prefix(temp.path().to_path_buf())
            .await
            .unwrap_err()
            .contains("conda-meta"));
        let prefix = temp.path().join("broken");
        std::fs::create_dir_all(prefix.join("conda-meta")).unwrap();
        assert!(service
            .resolve_prefix(prefix)
            .await
            .unwrap_err()
            .contains("Python"));
    }

    #[tokio::test]
    async fn rejects_record_only_and_lookalike_ipykernel_evidence() {
        let temp = TempDir::new().unwrap();
        let prefix = conda_prefix(&temp.path().join("env"), Some("3.11.9"), false);
        std::fs::write(prefix.join("conda-meta/ipykernel-6.0-0.json"), "{}").unwrap();
        let site = site_packages(&prefix, "3.11");
        std::fs::create_dir_all(site.join("ipykernel_helper-1.0.dist-info")).unwrap();
        std::fs::create_dir_all(site.join("ipykernel")).unwrap();
        let service = service(DiscoverySources::default());
        assert!(service
            .resolve_prefix(prefix.clone())
            .await
            .unwrap_err()
            .contains("ipykernel"));
        std::fs::create_dir_all(site.join("ipykernel-6.0.dist-info")).unwrap();
        assert!(service.resolve_prefix(prefix).await.is_ok());
    }

    #[cfg(not(windows))]
    #[tokio::test]
    async fn refuses_sibling_python_version_evidence() {
        let temp = TempDir::new().unwrap();
        let prefix = conda_prefix(&temp.path().join("env"), Some("3.12.4"), true);
        let service = service(DiscoverySources::default());
        assert!(service
            .resolve_prefix(prefix.clone())
            .await
            .unwrap_err()
            .contains("ipykernel"));
        let site = site_packages(&prefix, "3.12");
        std::fs::create_dir_all(site.join("ipykernel")).unwrap();
        std::fs::write(site.join("ipykernel/__init__.py"), "").unwrap();
        assert!(service.resolve_prefix(prefix).await.is_ok());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn versioned_interpreter_cannot_use_stale_sibling_metadata_evidence() {
        use std::os::unix::fs::symlink;
        let temp = TempDir::new().unwrap();
        let prefix = conda_prefix(&temp.path().join("env"), Some("3.11.9"), true);
        let python = crate::project_file::conda_python_path(&prefix);
        std::fs::rename(&python, prefix.join("bin/python3.12")).unwrap();
        symlink("python3.12", python).unwrap();
        let service = service(DiscoverySources::default());
        assert!(service
            .resolve_prefix(prefix)
            .await
            .unwrap_err()
            .contains("version"));
    }

    #[tokio::test]
    async fn malformed_registry_and_unreadable_roots_are_visible_warnings() {
        let temp = TempDir::new().unwrap();
        let registry = temp.path().join("environments.txt");
        std::fs::write(&registry, [0xff]).unwrap();
        let not_directory = temp.path().join("envs");
        std::fs::write(&not_directory, "").unwrap();
        let service = service(DiscoverySources {
            envs_dirs: vec![not_directory],
            registry: Some(registry),
            ..DiscoverySources::default()
        });
        let result = service.inventory(false).await.unwrap();
        assert!(result.environments.is_empty());
        assert!(result
            .warnings
            .iter()
            .any(|warning| warning.contains("not UTF-8")));
        assert!(result
            .warnings
            .iter()
            .any(|warning| warning.contains("directory")));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn outside_prefix_python_and_package_evidence_are_rejected() {
        use std::os::unix::fs::symlink;
        let temp = TempDir::new().unwrap();
        let prefix = conda_prefix(&temp.path().join("env"), Some("3.11.9"), false);
        let outside = conda_prefix(&temp.path().join("outside"), Some("3.11.9"), true);
        let site = site_packages(&prefix, "3.11");
        std::fs::create_dir_all(site.parent().unwrap()).unwrap();
        symlink(site_packages(&outside, "3.11"), &site).unwrap();
        let service = service(DiscoverySources::default());
        assert!(service
            .resolve_prefix(prefix.clone())
            .await
            .unwrap_err()
            .contains("ipykernel"));
        let python = crate::project_file::conda_python_path(&prefix);
        std::fs::remove_file(&python).unwrap();
        symlink(crate::project_file::conda_python_path(&outside), python).unwrap();
        assert!(service
            .resolve_prefix(prefix)
            .await
            .unwrap_err()
            .contains("inside its prefix"));
    }

    #[tokio::test]
    async fn result_budget_is_stably_sorted_and_reported() {
        let temp = TempDir::new().unwrap();
        let envs = temp.path().join("envs");
        for index in (0..=MAX_ENVIRONMENTS).rev() {
            conda_prefix(&envs.join(format!("env-{index:03}")), Some("3.11.9"), true);
        }
        let service = service(DiscoverySources {
            envs_dirs: vec![envs],
            ..DiscoverySources::default()
        });
        let result = service.inventory(false).await.unwrap();
        assert_eq!(result.environments.len(), MAX_ENVIRONMENTS);
        assert_eq!(result.environments.first().unwrap().name, "env-000");
        assert_eq!(result.environments.last().unwrap().name, "env-249");
        assert!(result.truncated);
        assert!(result
            .warnings
            .iter()
            .any(|warning| warning.contains("result budget")));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn symlinked_ipykernel_cannot_borrow_sibling_site_packages() {
        use std::os::unix::fs::symlink;
        let temp = TempDir::new().unwrap();
        let prefix = conda_prefix(&temp.path().join("env"), Some("3.11.9"), false);
        let site = site_packages(&prefix, "3.11");
        let sibling = site_packages(&prefix, "3.10").join("ipykernel");
        std::fs::create_dir_all(&sibling).unwrap();
        std::fs::write(sibling.join("__init__.py"), "").unwrap();
        std::fs::create_dir_all(&site).unwrap();
        symlink(sibling, site.join("ipykernel")).unwrap();
        let service = service(DiscoverySources::default());
        assert!(service
            .resolve_prefix(prefix.clone())
            .await
            .unwrap_err()
            .contains("ipykernel"));
        std::fs::remove_file(site.join("ipykernel")).unwrap();
        std::fs::remove_dir(&site).unwrap();
        symlink(site_packages(&prefix, "3.10"), &site).unwrap();
        assert!(service
            .resolve_prefix(prefix)
            .await
            .unwrap_err()
            .contains("ipykernel"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn canonical_aliases_deduplicate_and_unrecorded_version_stays_unknown() {
        use std::os::unix::fs::symlink;
        let temp = TempDir::new().unwrap();
        let prefix = conda_prefix(&temp.path().join("env"), None, true);
        let python = crate::project_file::conda_python_path(&prefix);
        std::fs::rename(&python, prefix.join("bin/python3.11")).unwrap();
        symlink("python3.11", &python).unwrap();
        let alias = temp.path().join("alias");
        symlink(&prefix, &alias).unwrap();
        let service = service(DiscoverySources {
            prefixes: vec![prefix.clone(), alias.clone()],
            ..DiscoverySources::default()
        });
        let inventory = service.inventory(false).await.unwrap();
        assert_eq!(inventory.environments.len(), 1);
        let selected = service.resolve_prefix(alias).await.unwrap();
        assert_eq!(selected.id, inventory.environments[0].id);
        assert_eq!(selected.prefix, std::fs::canonicalize(prefix).unwrap());
        assert_eq!(selected.python_version, None);
    }

    #[tokio::test]
    async fn inventory_is_cached_until_explicit_refresh() {
        let temp = TempDir::new().unwrap();
        let prefix = conda_prefix(&temp.path().join("env"), Some("3.11.9"), true);
        let service = service(DiscoverySources {
            prefixes: vec![prefix.clone()],
            ..DiscoverySources::default()
        });
        let first = service.inventory(false).await.unwrap();
        assert_eq!(first.environments.len(), 1);
        std::fs::remove_dir_all(prefix).unwrap();
        assert_eq!(
            service.inventory(false).await.unwrap().environments,
            first.environments
        );
        assert!(service
            .inventory(true)
            .await
            .unwrap()
            .environments
            .is_empty());
    }

    #[tokio::test]
    async fn oversized_registry_returns_partial_warning_and_truncation() {
        let temp = TempDir::new().unwrap();
        let prefix = conda_prefix(&temp.path().join("env"), Some("3.11.9"), true);
        let registry = temp.path().join("environments.txt");
        std::fs::write(
            &registry,
            format!("{}\n{}", prefix.display(), "x".repeat(MAX_REGISTRY_BYTES)),
        )
        .unwrap();
        let service = service(DiscoverySources {
            registry: Some(registry),
            ..DiscoverySources::default()
        });
        let inventory = service.inventory(false).await.unwrap();
        assert_eq!(inventory.environments.len(), 1);
        assert!(inventory.truncated);
        assert!(inventory
            .warnings
            .iter()
            .any(|warning| warning.contains("registry")));
    }

    #[tokio::test]
    async fn directory_and_source_budgets_are_reported_instead_of_unbounded_scans() {
        let temp = TempDir::new().unwrap();
        let envs = temp.path().join("envs");
        std::fs::create_dir_all(&envs).unwrap();
        for index in 0..=MAX_DIRECTORY_ENTRIES {
            std::fs::write(envs.join(format!("not-an-env-{index}")), "").unwrap();
        }
        let service = service(DiscoverySources {
            envs_dirs: vec![envs],
            ..DiscoverySources::default()
        });
        let inventory = service.inventory(false).await.unwrap();
        assert!(inventory.environments.is_empty());
        assert!(inventory.truncated);
        assert!(!inventory.warnings.is_empty());

        let service = super::LocalCondaEnvironments::new(DiscoverySources {
            prefixes: (0..=MAX_ROOTS)
                .map(|index| temp.path().join(index.to_string()))
                .collect(),
            ..DiscoverySources::default()
        });
        let inventory = service.inventory(false).await.unwrap();
        assert!(inventory.truncated);
        assert!(inventory
            .warnings
            .iter()
            .any(|warning| warning.contains("root")));
    }

    #[test]
    fn installed_conda_records_are_sorted_and_malformed_records_are_reported() {
        let temp = TempDir::new().unwrap();
        let prefix = temp.path().join("borrowed");
        let metadata = prefix.join("conda-meta");
        std::fs::create_dir_all(&metadata).unwrap();
        std::fs::write(
            metadata.join("numpy-2.1.0-py312_0.json"),
            r#"{"name":"numpy","version":"2.1.0","build":"py312_0"}"#,
        )
        .unwrap();
        std::fs::write(
            metadata.join("python-3.12.7-h123_0.json"),
            r#"{"name":"python","version":"3.12.7","build":"h123_0"}"#,
        )
        .unwrap();
        std::fs::write(metadata.join("invalid-1.0-0.json"), "not json").unwrap();
        let inventory = read_installed_conda_packages(&prefix).unwrap();
        assert_eq!(
            inventory
                .packages
                .iter()
                .map(|package| package.name.as_str())
                .collect::<Vec<_>>(),
            ["numpy", "python"]
        );
        assert_eq!(inventory.packages[0].version, "2.1.0");
        assert_eq!(inventory.packages[0].build, "py312_0");
        assert!(!inventory.truncated);
        assert_eq!(inventory.warnings.len(), 1);
        assert!(inventory.warnings[0].contains("invalid Conda package record"));
    }

    #[test]
    fn installed_conda_inventory_distinguishes_missing_metadata_from_empty_records() {
        let temp = TempDir::new().unwrap();
        let prefix = temp.path().join("borrowed");
        std::fs::create_dir_all(&prefix).unwrap();
        assert!(read_installed_conda_packages(&prefix)
            .unwrap_err()
            .contains("conda-meta"));
        std::fs::create_dir(prefix.join("conda-meta")).unwrap();
        let inventory = read_installed_conda_packages(&prefix).unwrap();
        assert!(inventory.packages.is_empty());
        assert!(!inventory.truncated);
        assert!(inventory.warnings.is_empty());
    }

    #[tokio::test]
    async fn cancelled_callers_and_concurrent_refreshes_share_one_blocking_scan() {
        use std::sync::{atomic::Ordering, Arc};
        let temp = TempDir::new().unwrap();
        let prefix = conda_prefix(&temp.path().join("env"), Some("3.11.9"), true);
        let gate = Arc::new(ScanGate::default());
        let service = Arc::new(service(DiscoverySources {
            prefixes: vec![prefix],
            scan_gate: Some(gate.clone()),
            ..DiscoverySources::default()
        }));
        let first_service = service.clone();
        let first = tokio::spawn(async move { first_service.inventory(false).await });
        tokio::select! {
            _ = gate.started.notified() => {},
            _ = tokio::time::sleep(std::time::Duration::from_secs(5)) => {
                gate.release();
                panic!("blocking scan did not start");
            },
        }
        first.abort();
        let second = service.inventory(true);
        let third = service.inventory(true);
        tokio::pin!(second, third);
        assert!(futures::poll!(&mut second).is_pending());
        assert!(futures::poll!(&mut third).is_pending());
        assert_eq!(gate.scans.load(Ordering::SeqCst), 1);
        gate.release();
        let (second, third) = tokio::join!(second, third);
        assert_eq!(second.unwrap(), third.unwrap());
        assert_eq!(gate.scans.load(Ordering::SeqCst), 1);
        assert_eq!(
            service.inventory(false).await.unwrap().environments.len(),
            1
        );
    }

    #[tokio::test]
    async fn fixture_cache_measurement_keeps_warm_requests_filesystem_free() {
        use std::sync::atomic::Ordering;
        let temp = TempDir::new().unwrap();
        let envs = temp.path().join("envs");
        for index in 0..100 {
            conda_prefix(&envs.join(format!("env-{index:03}")), Some("3.11.9"), true);
        }
        let gate = Arc::new(ScanGate::default());
        gate.release();
        let sources = DiscoverySources {
            envs_dirs: vec![envs],
            scan_gate: Some(gate.clone()),
            ..DiscoverySources::default()
        };
        let baseline_start = Instant::now();
        for _ in 0..10 {
            assert_eq!(scan_inventory(sources.clone()).environments.len(), 100);
        }
        let baseline = baseline_start.elapsed();
        let baseline_entries = gate.entries.swap(0, Ordering::SeqCst);
        let baseline_files = gate.files_read.swap(0, Ordering::SeqCst);
        gate.scans.store(0, Ordering::SeqCst);
        let service = service(sources);
        let cold_start = Instant::now();
        assert_eq!(
            service.inventory(false).await.unwrap().environments.len(),
            100
        );
        let cold = cold_start.elapsed();
        let entries = gate.entries.load(Ordering::SeqCst);
        let files = gate.files_read.load(Ordering::SeqCst);
        let warm_start = Instant::now();
        for _ in 0..10 {
            assert_eq!(
                service.inventory(false).await.unwrap().environments.len(),
                100
            );
        }
        let warm = warm_start.elapsed();
        assert_eq!(gate.scans.load(Ordering::SeqCst), 1);
        assert_eq!(gate.entries.load(Ordering::SeqCst), entries);
        assert_eq!(gate.files_read.load(Ordering::SeqCst), files);
        assert_eq!(entries, 200);
        assert_eq!(files, 100);
        assert_eq!(baseline_entries, 2000);
        assert_eq!(baseline_files, 1000);
        println!("{} disposable fixture, 100 prefixes: uncached 10 scans={baseline:?} ({baseline_entries} entries, {baseline_files} file reads); service first scan={cold:?} ({entries} entries, {files} reads); 10 warm requests={warm:?} (0 added scans/entries/file reads); interpreter probes=0. Not a representative platform or cold-OS-cache benchmark.", std::env::consts::OS);
    }

    #[test]
    fn total_scan_entry_budget_applies_across_roots() {
        let temp = TempDir::new().unwrap();
        std::fs::write(temp.path().join("entry"), "").unwrap();
        let mut evidence = ScanEvidence {
            entries: MAX_SCAN_ENTRIES,
            ..ScanEvidence::default()
        };
        assert!(directory_entries(temp.path(), &mut evidence).is_empty());
        assert_eq!(evidence.entries, MAX_SCAN_ENTRIES);
        assert!(evidence.truncated);
    }
}
