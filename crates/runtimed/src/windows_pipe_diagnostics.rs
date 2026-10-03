//! Diagnostic-only ownership observations; no retries or altered pipe options.

use std::collections::{BTreeMap, BTreeSet};
use std::io;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::task::{Context, Poll};

use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};

// Direct stderr deliberately bypasses libtest capture: successful diagnostic
// controls must remain visible in the existing, unmodified Build workflow.
macro_rules! diagnostic {
    ($($arg:tt)*) => {{
        use std::io::Write as _;
        let _ = writeln!(std::io::stderr(), $($arg)*);
    }};
}

static ENABLED_PATHS: OnceLock<Mutex<BTreeSet<String>>> = OnceLock::new();

pub(crate) fn enable_for_test(path: &std::path::Path) {
    ENABLED_PATHS
        .get_or_init(Mutex::default)
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(path.to_string_lossy().into_owned());
}

type LivePipes = BTreeMap<u64, String>;
static LIVE: OnceLock<Mutex<LivePipes>> = OnceLock::new();
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

fn live() -> std::sync::MutexGuard<'static, LivePipes> {
    LIVE.get_or_init(Mutex::default)
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

// Fields drop in declaration order: the Tokio server owner is dropped BEFORE
// its marker. This observes split-reader ownership, not IOCP completion: Mio
// can retain the native handle internally until overlapped I/O completes.
pub(crate) struct TrackedPipe {
    pub(crate) inner: NamedPipeServer,
    _lifetime: Lifetime,
}

struct Lifetime(Option<u64>);

impl Drop for Lifetime {
    fn drop(&mut self) {
        if let Some(id) = self.0 {
            let path = live().remove(&id);
            diagnostic!(
                "[pipe-diagnostic] pid={} rust_owner_dropped id={id} path={path:?}",
                std::process::id()
            );
        }
    }
}

impl TrackedPipe {
    pub(crate) fn create(path: &str, first: bool) -> anyhow::Result<Self> {
        let enabled = std::env::var_os("RUNTIMED_PIPE_DIAGNOSTICS").is_some()
            || ENABLED_PATHS.get().is_some_and(|paths| {
                paths
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .contains(path)
            });
        if enabled {
            let ids: Vec<_> = live()
                .iter()
                .filter(|(_, p)| p.as_str() == path)
                .map(|(id, _)| *id)
                .collect();
            diagnostic!("[pipe-diagnostic] pid={} create first={first} path={path:?} live_server_owner_ids={ids:?}", std::process::id());
        }
        let inner = ServerOptions::new()
            .first_pipe_instance(first)
            .create(path)
            .map_err(|error| {
                let context = format!(
                    "create named pipe first={first} path={path:?} pid={}: {error} (raw_os_error={:?})",
                    std::process::id(),
                    error.raw_os_error()
                );
                anyhow::Error::new(error).context(context)
            })?;
        let id = enabled.then(|| {
            let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
            live().insert(id, path.to_owned());
            diagnostic!(
                "[pipe-diagnostic] pid={} created id={id} first={first} path={path:?}",
                std::process::id()
            );
            id
        });
        Ok(Self {
            inner,
            _lifetime: Lifetime(id),
        })
    }
}

impl AsyncRead for TrackedPipe {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_read(cx, buf)
    }
}

impl AsyncWrite for TrackedPipe {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.get_mut().inner).poll_write(cx, buf)
    }
    fn is_write_vectored(&self) -> bool {
        self.inner.is_write_vectored()
    }
    fn poll_write_vectored(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bufs: &[io::IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.get_mut().inner).poll_write_vectored(cx, bufs)
    }
    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_flush(cx)
    }
    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_shutdown(cx)
    }
}
