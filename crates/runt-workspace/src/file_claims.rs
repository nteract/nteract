//! Cross-channel file claim registry.
//!
//! Every daemon process that opens a file-backed notebook room records a
//! claim for the canonical path in a registry shared across channels and dev
//! worktrees (`~/.cache/runt-shared/file-claims/`). The claim names the
//! owner (channel, socket path, room id, pid), so a second daemon that is
//! asked to open the same path can see the live claim and refuse instead of
//! split-braining the file between two processes.
//!
//! Claims are leases, not locks. A claim is live only while its owning pid
//! is alive AND its refresh window has not lapsed; anything else is stale,
//! ignored, and reaped by the next writer, so a crashed daemon can never
//! brick a path. The registry stores facts only: no sockets are held open,
//! and nothing in-process depends on a claim being present.
//!
//! A claim is held while the room serving the path has connected peers or
//! unexported durable state, not for the room's whole residency: the
//! daemon releases a clean idle room's claim after a short grace window
//! and re-acquires on reconnect, so a closed notebook frees the path in
//! about a minute instead of blocking other daemons for the resident-room
//! TTL. The daemon's claim reconciler is the writer that maintains this.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Bump when the claim record shape changes incompatibly. Records with a
/// different schema version read as absent and are reaped by the next
/// writer.
pub const FILE_CLAIM_SCHEMA_VERSION: u32 = 1;

/// How long a claim stays live without a refresh. The owning daemon's
/// claim reconciler renews held claims every few minutes, so this
/// tolerates several missed renewals before a live daemon's claim goes
/// stale. Expiry exists for pid reuse: a recycled pid would otherwise keep
/// a crashed daemon's claim looking live forever.
pub const FILE_CLAIM_TTL: Duration = Duration::from_secs(30 * 60);

/// Identity of the daemon process writing claims.
///
/// The socket path is the claim identity: two live daemons never share a
/// socket path, and it is exactly what an agent needs to reconnect through
/// the owner. Channel alone cannot distinguish per-worktree dev daemons,
/// which all build as nightly.
#[derive(Debug, Clone)]
pub struct FileClaimOwner {
    /// Cache namespace of this daemon (`runt`, `runt-nightly`).
    pub channel: String,
    /// This daemon's IPC socket path.
    pub socket_path: String,
    /// This daemon's pid.
    pub pid: u32,
}

/// One claim record, stored as JSON at
/// `<registry-dir>/<sha256-of-canonical-path>.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileClaim {
    pub schema_version: u32,
    /// Cache namespace of the owning daemon (`runt`, `runt-nightly`).
    pub channel: String,
    /// Socket path of the owning daemon. A claim is foreign iff this
    /// differs from the reader's own socket path.
    pub socket_path: String,
    /// Room id serving the file inside the owning daemon.
    pub notebook_id: String,
    /// Owning daemon pid; used for liveness.
    pub pid: u32,
    /// Canonical path this claim covers. Recorded for observability; the
    /// registry file name is a hash of it.
    pub path: String,
    /// Last write or refresh time, unix epoch milliseconds.
    pub refreshed_at_unix_ms: u64,
}

impl FileClaim {
    /// Milliseconds since this claim was last written or refreshed.
    pub fn age_ms(&self) -> u64 {
        unix_now_ms().saturating_sub(self.refreshed_at_unix_ms)
    }
}

/// Outcome of [`FileClaimRegistry::acquire`].
#[derive(Debug)]
pub enum ClaimAttempt {
    /// The claim is now (or already was) owned by the caller.
    Acquired,
    /// A live claim from a different daemon process holds the path.
    ForeignLive(FileClaim),
}

/// The `file_active_elsewhere` refusal, formatted in one place so daemons
/// and tests agree on the exact shape. MCP tools surface it verbatim.
pub fn file_active_elsewhere_message(path: &Path, claim: &FileClaim) -> String {
    format!(
        "file_active_elsewhere: {} is open in {} (socket {}); connect there or close it first",
        path.display(),
        claim.channel,
        claim.socket_path
    )
}

type LivenessFn = Box<dyn Fn(u32) -> bool + Send + Sync>;

/// Claim registry rooted at a directory of per-path JSON lease records.
///
/// All operations are small synchronous filesystem reads/writes; writes
/// publish atomically via temp-file rename, last writer wins. Concurrent
/// writers across processes are expected and safe: the registry is a
/// best-effort guard, and the durability layer remains the last line of
/// defense for a claim that lied.
pub struct FileClaimRegistry {
    dir: PathBuf,
    ttl: Duration,
    liveness: LivenessFn,
}

impl FileClaimRegistry {
    /// Registry at the cross-channel shared location:
    /// `~/.cache/runt-shared/file-claims/`.
    pub fn shared() -> Self {
        Self::at_dir(crate::shared_cache_root().join("file-claims"))
    }

    /// Registry at an explicit directory. Tests inject a tempdir here so
    /// they never touch the real shared registry.
    pub fn at_dir(dir: PathBuf) -> Self {
        Self {
            dir,
            ttl: FILE_CLAIM_TTL,
            liveness: Box::new(process_is_live),
        }
    }

    /// Override the refresh window. Test hook for the expiry path.
    pub fn with_ttl(mut self, ttl: Duration) -> Self {
        self.ttl = ttl;
        self
    }

    /// Override pid liveness. Test hook for the dead-pid path.
    pub fn with_liveness(mut self, liveness: impl Fn(u32) -> bool + Send + Sync + 'static) -> Self {
        self.liveness = Box::new(liveness);
        self
    }

    /// Registry file holding the claim for a canonical path.
    pub fn claim_file(&self, path: &Path) -> PathBuf {
        let mut hasher = Sha256::new();
        hasher.update(path.to_string_lossy().as_bytes());
        self.dir
            .join(format!("{}.json", hex::encode(hasher.finalize())))
    }

    /// Read the current claim for a path. Missing, unreadable, or
    /// wrong-schema records read as `None` (the next writer reaps them).
    pub fn read(&self, path: &Path) -> Option<FileClaim> {
        let bytes = std::fs::read(self.claim_file(path)).ok()?;
        let claim: FileClaim = serde_json::from_slice(&bytes).ok()?;
        (claim.schema_version == FILE_CLAIM_SCHEMA_VERSION).then_some(claim)
    }

    /// True while the claim's owner pid is alive and the refresh window
    /// has not lapsed. Everything else is stale.
    pub fn is_live(&self, claim: &FileClaim) -> bool {
        if !(self.liveness)(claim.pid) {
            return false;
        }
        let age_ms = unix_now_ms().saturating_sub(claim.refreshed_at_unix_ms);
        u128::from(age_ms) <= self.ttl.as_millis()
    }

    /// Claim `path` for `owner` unless a live claim from a different
    /// daemon process already holds it. A same-owner claim is refreshed,
    /// never refused; stale claims (dead pid, lapsed refresh, unreadable
    /// record) are reaped by the overwrite.
    pub fn acquire(
        &self,
        path: &Path,
        owner: &FileClaimOwner,
        notebook_id: &str,
    ) -> std::io::Result<ClaimAttempt> {
        if let Some(existing) = self.read(path) {
            if existing.socket_path != owner.socket_path && self.is_live(&existing) {
                return Ok(ClaimAttempt::ForeignLive(existing));
            }
        }
        self.record(path, owner, notebook_id)?;
        Ok(ClaimAttempt::Acquired)
    }

    /// Write or refresh the claim unconditionally. Used by `acquire` and
    /// by the owner's periodic refresh of resident rooms; the record is a
    /// fact ("this daemon is serving this path right now"), so the caller
    /// must actually hold a room for the path.
    pub fn record(
        &self,
        path: &Path,
        owner: &FileClaimOwner,
        notebook_id: &str,
    ) -> std::io::Result<()> {
        std::fs::create_dir_all(&self.dir)?;
        let claim = FileClaim {
            schema_version: FILE_CLAIM_SCHEMA_VERSION,
            channel: owner.channel.clone(),
            socket_path: owner.socket_path.clone(),
            notebook_id: notebook_id.to_string(),
            pid: owner.pid,
            path: path.to_string_lossy().into_owned(),
            refreshed_at_unix_ms: unix_now_ms(),
        };
        let mut bytes = serde_json::to_vec_pretty(&claim).map_err(std::io::Error::other)?;
        bytes.push(b'\n');
        let target = self.claim_file(path);
        let tmp = target.with_extension(format!("tmp.{}.{}", owner.pid, next_write_seq()));
        std::fs::write(&tmp, &bytes)?;
        match std::fs::rename(&tmp, &target) {
            Ok(()) => Ok(()),
            Err(error) => {
                let _ = std::fs::remove_file(&tmp);
                Err(error)
            }
        }
    }

    /// Remove the claim if it belongs to `owner`. Foreign and unreadable
    /// claims are left alone; their owner (or staleness) handles them.
    pub fn release(&self, path: &Path, owner: &FileClaimOwner) -> std::io::Result<()> {
        match self.read(path) {
            Some(claim) if claim.socket_path == owner.socket_path => {
                match std::fs::remove_file(self.claim_file(path)) {
                    Ok(()) => Ok(()),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
                    Err(error) => Err(error),
                }
            }
            _ => Ok(()),
        }
    }
}

fn unix_now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// Per-process counter making concurrent temp-file names unique within one
/// process; the pid in the name separates processes.
fn next_write_seq() -> u64 {
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}

/// Probe whether a pid refers to a live process. Signal 0 on unix probes
/// without delivering; EPERM still means the process exists.
#[cfg(unix)]
fn process_is_live(pid: u32) -> bool {
    let Ok(pid) = i32::try_from(pid) else {
        return false;
    };
    if pid <= 0 {
        return false;
    }
    let rc = unsafe { libc::kill(pid, 0) };
    rc == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(windows)]
fn process_is_live(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle == 0 {
            return false;
        }
        CloseHandle(handle);
        true
    }
}

#[cfg(not(any(unix, windows)))]
fn process_is_live(_pid: u32) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn owner(socket: &str) -> FileClaimOwner {
        FileClaimOwner {
            channel: "runt-nightly".to_string(),
            socket_path: socket.to_string(),
            pid: std::process::id(),
        }
    }

    fn registry_at(dir: &Path) -> FileClaimRegistry {
        FileClaimRegistry::at_dir(dir.to_path_buf())
    }

    #[test]
    fn claim_write_refresh_release_lifecycle() {
        let tmp = tempfile::tempdir().unwrap();
        let registry = registry_at(tmp.path());
        let path = Path::new("/notebooks/analysis.ipynb");
        let me = owner("/sockets/a.sock");

        assert!(registry.read(path).is_none());

        let attempt = registry.acquire(path, &me, "room-1").unwrap();
        assert!(matches!(attempt, ClaimAttempt::Acquired));
        let first = registry.read(path).unwrap();
        assert_eq!(first.socket_path, "/sockets/a.sock");
        assert_eq!(first.channel, "runt-nightly");
        assert_eq!(first.notebook_id, "room-1");
        assert_eq!(first.pid, std::process::id());
        assert_eq!(first.path, path.to_string_lossy());
        assert!(registry.is_live(&first));

        std::thread::sleep(std::time::Duration::from_millis(5));
        registry.record(path, &me, "room-1").unwrap();
        let refreshed = registry.read(path).unwrap();
        assert!(refreshed.refreshed_at_unix_ms > first.refreshed_at_unix_ms);

        registry.release(path, &me).unwrap();
        assert!(registry.read(path).is_none());
        // Releasing an absent claim is a no-op.
        registry.release(path, &me).unwrap();
    }

    #[test]
    fn foreign_live_claim_is_refused_with_structured_message() {
        let tmp = tempfile::tempdir().unwrap();
        let registry = registry_at(tmp.path()).with_liveness(|_| true);
        let path = Path::new("/notebooks/gaming-500-hours.ipynb");

        let foreign = FileClaimOwner {
            channel: "runt-nightly".to_string(),
            socket_path: "/sockets/nightly.sock".to_string(),
            pid: 4242,
        };
        registry.record(path, &foreign, "room-f").unwrap();

        let me = owner("/sockets/dev.sock");
        let attempt = registry.acquire(path, &me, "room-mine").unwrap();
        let ClaimAttempt::ForeignLive(claim) = attempt else {
            panic!("expected foreign live claim to refuse the acquire");
        };
        assert_eq!(
            file_active_elsewhere_message(path, &claim),
            "file_active_elsewhere: /notebooks/gaming-500-hours.ipynb is open in \
             runt-nightly (socket /sockets/nightly.sock); connect there or close it first"
        );
        // The foreign record was not clobbered by the refused acquire.
        assert_eq!(
            registry.read(path).unwrap().socket_path,
            foreign.socket_path
        );
    }

    #[test]
    fn stale_claim_by_dead_pid_is_reaped() {
        let tmp = tempfile::tempdir().unwrap();
        let registry = registry_at(tmp.path()).with_liveness(|pid| pid != 4242);
        let path = Path::new("/notebooks/crashed.ipynb");

        let dead = FileClaimOwner {
            channel: "runt".to_string(),
            socket_path: "/sockets/stable.sock".to_string(),
            pid: 4242,
        };
        registry.record(path, &dead, "room-dead").unwrap();

        let me = owner("/sockets/dev.sock");
        let attempt = registry.acquire(path, &me, "room-mine").unwrap();
        assert!(matches!(attempt, ClaimAttempt::Acquired));
        let claim = registry.read(path).unwrap();
        assert_eq!(claim.socket_path, me.socket_path);
        assert_eq!(claim.notebook_id, "room-mine");
    }

    #[test]
    fn stale_claim_by_lapsed_refresh_is_reaped() {
        let tmp = tempfile::tempdir().unwrap();
        // Owner pid stays live; only the refresh window lapses.
        let registry = registry_at(tmp.path())
            .with_liveness(|_| true)
            .with_ttl(Duration::ZERO);
        let path = Path::new("/notebooks/expired.ipynb");

        let foreign = FileClaimOwner {
            channel: "runt".to_string(),
            socket_path: "/sockets/stable.sock".to_string(),
            pid: 4242,
        };
        registry.record(path, &foreign, "room-old").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));

        let me = owner("/sockets/dev.sock");
        let attempt = registry.acquire(path, &me, "room-mine").unwrap();
        assert!(matches!(attempt, ClaimAttempt::Acquired));
        assert_eq!(registry.read(path).unwrap().socket_path, me.socket_path);
    }

    #[test]
    fn same_owner_reacquire_refreshes_and_never_refuses() {
        let tmp = tempfile::tempdir().unwrap();
        let registry = registry_at(tmp.path()).with_liveness(|_| true);
        let path = Path::new("/notebooks/reopen.ipynb");
        let me = owner("/sockets/dev.sock");

        registry.record(path, &me, "room-1").unwrap();
        let first = registry.read(path).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));

        let attempt = registry.acquire(path, &me, "room-1").unwrap();
        assert!(matches!(attempt, ClaimAttempt::Acquired));
        let refreshed = registry.read(path).unwrap();
        assert!(refreshed.refreshed_at_unix_ms > first.refreshed_at_unix_ms);
    }

    #[test]
    fn release_leaves_foreign_claims_alone() {
        let tmp = tempfile::tempdir().unwrap();
        let registry = registry_at(tmp.path()).with_liveness(|_| true);
        let path = Path::new("/notebooks/theirs.ipynb");

        let foreign = FileClaimOwner {
            channel: "runt".to_string(),
            socket_path: "/sockets/stable.sock".to_string(),
            pid: 4242,
        };
        registry.record(path, &foreign, "room-f").unwrap();

        let me = owner("/sockets/dev.sock");
        registry.release(path, &me).unwrap();
        assert!(registry.read(path).is_some());
    }

    #[test]
    fn unreadable_record_reads_as_absent_and_is_reaped_on_write() {
        let tmp = tempfile::tempdir().unwrap();
        let registry = registry_at(tmp.path()).with_liveness(|_| true);
        let path = Path::new("/notebooks/garbled.ipynb");

        std::fs::create_dir_all(registry.dir.as_path()).unwrap();
        std::fs::write(registry.claim_file(path), b"not json").unwrap();
        assert!(registry.read(path).is_none());

        let me = owner("/sockets/dev.sock");
        let attempt = registry.acquire(path, &me, "room-1").unwrap();
        assert!(matches!(attempt, ClaimAttempt::Acquired));
        assert_eq!(registry.read(path).unwrap().socket_path, me.socket_path);
    }

    #[test]
    fn claim_file_name_is_stable_per_path() {
        let tmp = tempfile::tempdir().unwrap();
        let registry = registry_at(tmp.path());
        let a = registry.claim_file(Path::new("/notebooks/a.ipynb"));
        let b = registry.claim_file(Path::new("/notebooks/b.ipynb"));
        assert_eq!(a, registry.claim_file(Path::new("/notebooks/a.ipynb")));
        assert_ne!(a, b);
        assert!(a.extension().is_some_and(|ext| ext == "json"));
    }

    #[test]
    fn own_pid_is_live() {
        let tmp = tempfile::tempdir().unwrap();
        let registry = registry_at(tmp.path());
        let claim = FileClaim {
            schema_version: FILE_CLAIM_SCHEMA_VERSION,
            channel: "runt-nightly".to_string(),
            socket_path: "/sockets/a.sock".to_string(),
            notebook_id: "room-1".to_string(),
            pid: std::process::id(),
            path: "/notebooks/a.ipynb".to_string(),
            refreshed_at_unix_ms: unix_now_ms(),
        };
        assert!(registry.is_live(&claim));
    }
}
