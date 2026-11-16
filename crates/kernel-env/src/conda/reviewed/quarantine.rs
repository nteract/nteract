//! Conservative restart bookkeeping for generated staging prefixes.
//!
//! A process-lifetime file lease proves only that the old process and its
//! threads have exited. It does NOT cover children/descendants. Persist
//! `ExternalWriters` before invoking any installer or executable. Such records
//! are inventory only and NEVER automatically deleted, even after lease expiry.
//! Missing, malformed and unknown records also fail closed. No persisted path
//! is accepted: every target is derived from validated generated UUID names.

use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use anyhow::{anyhow, bail, Context, Result};

const SCHEMA: &str = "reviewed-conda-quarantine-v1";
const OWNER_PREFIX: &str = ".reviewed-owner-";
const PREFIX: &str = "prefix-";

static PROCESS_ID: OnceLock<uuid::Uuid> = OnceLock::new();
static OWNERS: OnceLock<Mutex<HashMap<PathBuf, Arc<Owner>>>> = OnceLock::new();

struct Owner {
    // Intentionally retained by OWNERS until process termination. Releasing an
    // operation/session must not imply that detached process-local writers died.
    _lease: File,
}

pub(super) fn owner_directory(root: &Path) -> PathBuf {
    root.join(format!(
        "{OWNER_PREFIX}{}",
        PROCESS_ID.get_or_init(uuid::Uuid::new_v4)
    ))
}

fn generated_id(name: &str, prefix: &str) -> bool {
    name.strip_prefix(prefix)
        .and_then(|s| uuid::Uuid::parse_str(s).ok().map(|id| id.to_string() == s))
        .unwrap_or(false)
}

pub(super) fn ensure_owner(root: &Path) -> Result<()> {
    let mut owners = OWNERS
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| anyhow!("quarantine owner lock poisoned"))?;
    let path = owner_directory(root);
    if owners.contains_key(&path) {
        return Ok(());
    }
    std::fs::create_dir_all(root)?;
    // This process UUID must never claim a pre-existing owner directory.
    std::fs::create_dir(&path)?;
    let lease = OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .open(path.join("owner.lock"))?;
    lease
        .try_lock()
        .map_err(|error| anyhow!("could not lock quarantine owner: {error}"))?;
    std::fs::write(path.join("schema"), SCHEMA)?;
    owners.insert(path, Arc::new(Owner { _lease: lease }));
    Ok(())
}

#[derive(Clone, Copy)]
pub(super) enum WriterScope {
    ProcessLocal,
    ExternalWriters,
    Retained,
}
impl WriterScope {
    fn encoded(self) -> &'static str {
        match self {
            Self::ProcessLocal => "process-local-v1",
            Self::ExternalWriters => "external-writers-v1",
            Self::Retained => "retained-v1",
        }
    }
}

pub(super) fn record_for(target: &Path) -> Result<PathBuf> {
    let name = target
        .file_name()
        .and_then(|n| n.to_str())
        .context("invalid staging name")?;
    if !generated_id(name, PREFIX) {
        bail!("invalid generated staging identity");
    }
    Ok(target.with_file_name(format!("{name}.state")))
}

pub(super) fn write_scope(record: &Path, scope: WriterScope) -> Result<()> {
    // Truncate before changing authority. A crash mid-write leaves an unknown
    // state, never an affirmative permission to delete.
    let mut file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(record)?;
    file.write_all(scope.encoded().as_bytes())?;
    file.sync_all()?;
    Ok(())
}

/// Bounded recovery facts. Skipped prefixes remain untouched for a stronger
/// process-tree-aware recovery owner; a TTL is not evidence of quiescence.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct RecoveryReport {
    pub removed: usize,
    pub live_owners: usize,
    pub retained_or_unproven: usize,
    pub unknown: usize,
    /// This one-shot pass stopped early. Repeating it is not a resumable scan
    /// and does not promise eventual coverage of later directory entries.
    pub truncated: bool,
}

/// One partial recovery/inventory pass over at most `limit` owner entries and
/// `limit` directory entries per owner. `truncated` explicitly reports incomplete
/// coverage. This is not an eventual collector: retained entries are not removed,
/// and repeating this pass can revisit the same entries. A production recovery
/// owner needs resumable traversal before claiming all quarantines were examined.
/// Run on a blocking worker. The configured root must be daemon-owned and not
/// concurrently renamed/replaced by external filesystem actors; this is not a
/// sandbox against another OS process with write access to that root.
/// Only generated process-local pending prefixes
/// whose original owner lease can be acquired are eligible for removal.
/// No production startup path invokes this until the complete launch lifecycle
/// is integrated. Installer/vendor records always remain quarantined.
pub fn recover_process_local(root: &Path, limit: usize) -> Result<RecoveryReport> {
    if !root.is_absolute() {
        bail!("quarantine recovery requires an absolute configured root");
    }
    if std::fs::symlink_metadata(root).is_ok_and(|meta| !meta.file_type().is_dir()) {
        bail!("quarantine recovery root is not a real directory");
    }
    let limit = limit.min(128);
    let mut report = RecoveryReport::default();
    let mut entries = match std::fs::read_dir(root) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(report),
        Err(e) => return Err(e.into()),
    };
    for entry in entries.by_ref().take(limit) {
        let entry = entry?;
        let name = entry.file_name();
        if !name
            .to_str()
            .is_some_and(|name| generated_id(name, OWNER_PREFIX))
            || !entry.file_type()?.is_dir()
        {
            report.unknown += 1;
            continue;
        }
        let owner = entry.path();
        let lock_path = owner.join("owner.lock");
        if !std::fs::symlink_metadata(&lock_path).is_ok_and(|meta| meta.file_type().is_file()) {
            report.unknown += 1;
            continue;
        }
        let lease = match OpenOptions::new().read(true).write(true).open(&lock_path) {
            Ok(lease) => lease,
            Err(_) => {
                report.unknown += 1;
                continue;
            }
        };
        if lease.try_lock().is_err() {
            report.live_owners += 1;
            continue;
        }
        if !std::fs::symlink_metadata(owner.join("schema"))
            .is_ok_and(|meta| meta.file_type().is_file())
        {
            report.unknown += 1;
            continue;
        }
        if std::fs::read_to_string(owner.join("schema"))
            .ok()
            .as_deref()
            != Some(SCHEMA)
        {
            report.unknown += 1;
            continue;
        }
        let mut records = std::fs::read_dir(&owner)?;
        for record in records.by_ref().take(limit) {
            let record = record?;
            let name = record.file_name();
            let Some(stem) = name.to_str().and_then(|name| name.strip_suffix(".state")) else {
                continue;
            };
            if !generated_id(stem, PREFIX) || !record.file_type()?.is_file() {
                report.unknown += 1;
                continue;
            }
            match std::fs::read_to_string(record.path()).ok().as_deref() {
                Some("process-local-v1") => {}
                Some("external-writers-v1" | "retained-v1") => {
                    report.retained_or_unproven += 1;
                    continue;
                }
                _ => {
                    report.unknown += 1;
                    continue;
                }
            }
            let target = owner.join(stem);
            let metadata = match std::fs::symlink_metadata(&target) {
                Ok(metadata) => metadata,
                Err(_) => {
                    report.unknown += 1;
                    continue;
                }
            };
            if !metadata.file_type().is_dir() {
                report.unknown += 1;
                continue;
            }
            std::fs::remove_dir_all(&target)?;
            std::fs::remove_file(record.path())?;
            report.removed += 1;
        }
        report.truncated |= records.next().is_some();
    }
    report.truncated |= entries.next().is_some();
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::{Child, Command};
    use std::time::{Duration, Instant};

    fn fixture(root: &Path, scope: WriterScope) -> (PathBuf, PathBuf) {
        let owner = root.join(format!("{OWNER_PREFIX}{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&owner).unwrap();
        File::create(owner.join("owner.lock")).unwrap();
        std::fs::write(owner.join("schema"), SCHEMA).unwrap();
        let target = owner.join(format!("{PREFIX}{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&target).unwrap();
        std::fs::write(target.join("data"), b"stage").unwrap();
        write_scope(&record_for(&target).unwrap(), scope).unwrap();
        (owner, target)
    }

    struct ChildGuard(Child);
    impl Drop for ChildGuard {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    fn child(action: &str, owner: &Path, target: &Path) -> ChildGuard {
        ChildGuard(
            Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "conda::reviewed::quarantine::tests::quarantine_child",
                    "--nocapture",
                ])
                .env("NTERACT_QUARANTINE_TEST_ACTION", action)
                .env("NTERACT_QUARANTINE_TEST_OWNER", owner)
                .env("NTERACT_QUARANTINE_TEST_TARGET", target)
                .spawn()
                .unwrap(),
        )
    }

    fn wait_for(path: &Path) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !path.exists() {
            assert!(Instant::now() < deadline, "child did not reach barrier");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn quarantine_child() {
        let Ok(action) = std::env::var("NTERACT_QUARANTINE_TEST_ACTION") else {
            return;
        };
        let owner = PathBuf::from(std::env::var_os("NTERACT_QUARANTINE_TEST_OWNER").unwrap());
        let target = PathBuf::from(std::env::var_os("NTERACT_QUARANTINE_TEST_TARGET").unwrap());
        let lease = OpenOptions::new()
            .read(true)
            .write(true)
            .open(owner.join("owner.lock"))
            .unwrap();
        if action == "hold" {
            lease.lock().unwrap();
        }
        std::fs::write(owner.join("ready"), b"ready").unwrap();
        wait_for(&owner.join("release"));
        if action == "write" {
            std::fs::write(target.join("late-child-write"), b"alive").unwrap();
        }
    }

    #[test]
    fn live_owner_blocks_recovery_and_process_exit_releases_only_local_work() {
        let root = tempfile::tempdir().unwrap();
        let (owner, target) = fixture(root.path(), WriterScope::ProcessLocal);
        let mut child = child("hold", &owner, &target);
        wait_for(&owner.join("ready"));
        assert_eq!(
            recover_process_local(root.path(), 20).unwrap().live_owners,
            1
        );
        assert!(target.exists());
        child.0.kill().unwrap();
        child.0.wait().unwrap();
        assert_eq!(recover_process_local(root.path(), 20).unwrap().removed, 1);
        assert!(!target.exists());
        assert!(
            owner.join("owner.lock").exists(),
            "lock inode must never be unlinked"
        );
    }

    #[test]
    fn surviving_child_writer_is_preserved_without_parent_lease() {
        let root = tempfile::tempdir().unwrap();
        let (owner, target) = fixture(root.path(), WriterScope::ExternalWriters);
        let mut child = child("write", &owner, &target);
        wait_for(&owner.join("ready"));
        let report = recover_process_local(root.path(), 20).unwrap();
        assert_eq!(report.removed, 0);
        assert_eq!(report.retained_or_unproven, 1);
        std::fs::write(owner.join("release"), b"go").unwrap();
        assert!(child.0.wait().unwrap().success());
        assert_eq!(
            std::fs::read(target.join("late-child-write")).unwrap(),
            b"alive"
        );
    }

    #[test]
    fn retained_and_torn_records_never_authorize_cleanup() {
        let root = tempfile::tempdir().unwrap();
        let (_, retained) = fixture(root.path(), WriterScope::Retained);
        let (_, torn) = fixture(root.path(), WriterScope::ProcessLocal);
        std::fs::write(record_for(&torn).unwrap(), b"process-lo").unwrap();
        let report = recover_process_local(root.path(), 20).unwrap();
        assert_eq!(report.removed, 0);
        assert_eq!(report.retained_or_unproven, 1);
        assert_eq!(report.unknown, 1);
        assert!(retained.exists());
        assert!(torn.exists());
    }

    #[test]
    fn concurrent_recovery_has_one_deletion_owner() {
        let root = tempfile::tempdir().unwrap();
        let (_, target) = fixture(root.path(), WriterScope::ProcessLocal);
        let path = root.path().to_path_buf();
        let other = path.clone();
        let first = std::thread::spawn(move || recover_process_local(&other, 20).unwrap());
        let second = recover_process_local(&path, 20).unwrap();
        assert_eq!(first.join().unwrap().removed + second.removed, 1);
        assert!(!target.exists());
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_and_path_like_records_never_delete_outside_owner() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let (owner, target) = fixture(root.path(), WriterScope::ProcessLocal);
        std::fs::remove_dir_all(&target).unwrap();
        std::os::unix::fs::symlink(outside.path(), &target).unwrap();
        std::fs::write(
            owner.join("not-a-generated-prefix.state"),
            "process-local-v1",
        )
        .unwrap();
        std::fs::write(outside.path().join("keep"), b"keep").unwrap();
        let report = recover_process_local(root.path(), 20).unwrap();
        assert_eq!(report.removed, 0);
        assert_eq!(report.unknown, 2);
        assert!(outside.path().join("keep").exists());
    }

    #[test]
    fn bounded_partial_pass_reports_incomplete_coverage() {
        let root = tempfile::tempdir().unwrap();
        for _ in 0..5 {
            fixture(root.path(), WriterScope::Retained);
        }
        fixture(root.path(), WriterScope::ProcessLocal);
        let report = recover_process_local(root.path(), 2).unwrap();
        assert!(report.truncated);
        assert!(report.removed <= 1);
    }

    #[test]
    fn same_process_owner_lease_outlives_operation_handles() {
        let root = tempfile::tempdir().unwrap();
        ensure_owner(root.path()).unwrap();
        ensure_owner(root.path()).unwrap();
        assert_eq!(
            recover_process_local(root.path(), 20).unwrap().live_owners,
            1
        );
    }
}
