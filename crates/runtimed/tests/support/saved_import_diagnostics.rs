//! Temporary diagnostics for adjacent saved-file UUID restart fixtures.
//! Keep its polling, shutdown budget, and transport ownership unchanged.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use runtimed::daemon::Daemon;
use runtimed_client::client::PoolClient;
use tokio::task::JoinHandle;

#[derive(Clone)]
pub struct Diagnostics {
    fixture: &'static str,
    start: Instant,
    socket: PathBuf,
}

impl Diagnostics {
    pub fn new(fixture: &'static str, socket: &Path) -> Self {
        Self {
            fixture,
            start: Instant::now(),
            socket: socket.to_owned(),
        }
    }

    pub fn event(&self, message: &str) {
        // Direct stderr retains diagnostics even when libtest captures a pass.
        let _ = writeln!(
            std::io::stderr(),
            "[restart-fixture {} {:?} +{:?}] {message}",
            self.fixture,
            self.socket,
            self.start.elapsed()
        );
    }

    pub fn spawn(
        &self,
        phase: &'static str,
        daemon: Arc<Daemon>,
    ) -> JoinHandle<anyhow::Result<()>> {
        let diagnostics = self.clone();
        tokio::spawn(async move {
            diagnostics.event(&format!("{phase}: run starting"));
            let result = daemon.run().await;
            diagnostics.event(&format!("{phase}: run returned {result:?}"));
            result
        })
    }

    pub async fn ready(
        &self,
        phase: &str,
        client: &PoolClient,
        task: &mut JoinHandle<anyhow::Result<()>>,
    ) -> bool {
        let start = Instant::now();
        let mut attempts = 0;
        let mut last_error = None;
        while start.elapsed() < super::DAEMON_READY_TIMEOUT {
            attempts += 1;
            match client.ping().await {
                Ok(()) => {
                    self.event(&format!("{phase}: ping ready after {attempts} attempts, {:?}; last error={last_error:?}", start.elapsed()));
                    return true;
                }
                Err(error) => last_error = Some(format!("{error:?}")),
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        self.event(&format!("{phase}: readiness failed after {attempts} attempts, {:?}; task finished={}; last error={last_error:?}", start.elapsed(), task.is_finished()));
        if task.is_finished() {
            self.event(&format!("{phase}: failed startup join={:?}", task.await));
        }
        false
    }

    pub async fn stop(
        &self,
        phase: &str,
        client: &PoolClient,
        task: &mut JoinHandle<anyhow::Result<()>>,
    ) {
        let shutdown = client.shutdown().await;
        self.event(&format!("{phase}: shutdown RPC={shutdown:?}"));
        match tokio::time::timeout(Duration::from_secs(2), &mut *task).await {
            Ok(result) => self.event(&format!("{phase}: shutdown join={result:?}")),
            Err(error) => {
                self.event(&format!("{phase}: shutdown join timed out: {error}"));
                task.abort();
                self.event(&format!("{phase}: abort join={:?}", task.await));
            }
        }
    }
}
