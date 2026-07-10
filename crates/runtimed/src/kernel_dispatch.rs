//! Kernel dispatch enum — wraps `JupyterKernel` and `TestKernel` behind
//! a single `KernelConnection` impl.
//!
//! The `KernelConnection` trait uses RPIT futures (`impl Future`), so
//! `Box<dyn KernelConnection>` is not viable. This enum delegates every
//! method via match dispatch instead.
//!
//! `Kernel::launch` selects the variant based on `config.kernel_type`:
//! `"test"` builds a `TestKernel`; anything else builds a `JupyterKernel`.

use std::path::PathBuf;

use anyhow::Result;
use notebook_protocol::protocol::{
    BokehSessionPatchRequest, CommRequestMessage, LaunchedEnvConfig,
};

use crate::bokeh_session::{BokehCheckpointFuture, BokehKernelPatchResponse};
use crate::jupyter_kernel::JupyterKernel;
use crate::kernel_connection::{KernelConnection, KernelLaunchConfig, KernelSharedRefs};
use crate::output_prep::QueueCommandReceivers;
use crate::protocol::{CompletionItem, HistoryEntry};
use crate::test_kernel::TestKernel;

pub enum Kernel {
    Jupyter(Box<JupyterKernel>),
    Test(Box<TestKernel>),
}

impl Kernel {
    /// Return an interrupt handle for concurrent interrupt without `&mut self`.
    ///
    /// Only `JupyterKernel` supports out-of-band interrupt; `TestKernel`
    /// returns `None` and interrupt is handled via the `KernelConnection::interrupt`
    /// path instead.
    pub fn interrupt_handle(&self) -> Option<crate::jupyter_kernel::InterruptHandle> {
        match self {
            Kernel::Jupyter(k) => k.interrupt_handle(),
            Kernel::Test(_) => None,
        }
    }
}

impl KernelConnection for Kernel {
    async fn launch(
        config: KernelLaunchConfig,
        shared: KernelSharedRefs,
    ) -> Result<(Self, QueueCommandReceivers)> {
        if config.kernel_type == "test" {
            let (k, rx) = TestKernel::launch(config, shared).await?;
            Ok((Kernel::Test(Box::new(k)), rx))
        } else {
            let (k, rx) = JupyterKernel::launch(config, shared).await?;
            Ok((Kernel::Jupyter(Box::new(k)), rx))
        }
    }

    async fn execute(
        &mut self,
        execution_id: &str,
        cell_id: Option<&str>,
        source: &str,
    ) -> Result<()> {
        match self {
            Kernel::Jupyter(k) => k.execute(execution_id, cell_id, source).await,
            Kernel::Test(k) => k.execute(execution_id, cell_id, source).await,
        }
    }

    async fn interrupt(&mut self) -> Result<()> {
        match self {
            Kernel::Jupyter(k) => k.interrupt().await,
            Kernel::Test(k) => k.interrupt().await,
        }
    }

    async fn shutdown(&mut self) -> Result<()> {
        match self {
            Kernel::Jupyter(k) => k.shutdown().await,
            Kernel::Test(k) => k.shutdown().await,
        }
    }

    async fn send_comm_message(&mut self, message: CommRequestMessage) -> Result<()> {
        match self {
            Kernel::Jupyter(k) => k.send_comm_message(message).await,
            Kernel::Test(k) => k.send_comm_message(message).await,
        }
    }

    async fn send_comm_update(
        &mut self,
        comm_id: &str,
        state: serde_json::Value,
        buffer_paths: Vec<Vec<String>>,
        buffers: Vec<Vec<u8>>,
    ) -> Result<()> {
        match self {
            Kernel::Jupyter(k) => {
                k.send_comm_update(comm_id, state, buffer_paths, buffers)
                    .await
            }
            Kernel::Test(k) => {
                k.send_comm_update(comm_id, state, buffer_paths, buffers)
                    .await
            }
        }
    }

    async fn apply_bokeh_session_patch(
        &mut self,
        request: BokehSessionPatchRequest,
    ) -> Result<BokehKernelPatchResponse> {
        match self {
            Kernel::Jupyter(k) => k.apply_bokeh_session_patch(request).await,
            Kernel::Test(k) => k.apply_bokeh_session_patch(request).await,
        }
    }

    fn bokeh_session_checkpoint_request(
        &self,
        session_id: String,
    ) -> Option<BokehCheckpointFuture> {
        match self {
            Kernel::Jupyter(k) => k.bokeh_session_checkpoint_request(session_id),
            Kernel::Test(k) => k.bokeh_session_checkpoint_request(session_id),
        }
    }

    async fn complete(
        &mut self,
        code: &str,
        cursor_pos: usize,
    ) -> Result<(Vec<CompletionItem>, usize, usize)> {
        match self {
            Kernel::Jupyter(k) => k.complete(code, cursor_pos).await,
            Kernel::Test(k) => k.complete(code, cursor_pos).await,
        }
    }

    async fn get_history(
        &mut self,
        pattern: Option<&str>,
        n: i32,
        unique: bool,
    ) -> Result<Vec<HistoryEntry>> {
        match self {
            Kernel::Jupyter(k) => k.get_history(pattern, n, unique).await,
            Kernel::Test(k) => k.get_history(pattern, n, unique).await,
        }
    }

    fn kernel_type(&self) -> &str {
        match self {
            Kernel::Jupyter(k) => k.kernel_type(),
            Kernel::Test(k) => k.kernel_type(),
        }
    }

    fn kernel_id(&self) -> &str {
        match self {
            Kernel::Jupyter(k) => k.kernel_id(),
            Kernel::Test(k) => k.kernel_id(),
        }
    }

    fn env_source(&self) -> &str {
        match self {
            Kernel::Jupyter(k) => k.env_source(),
            Kernel::Test(k) => k.env_source(),
        }
    }

    fn launched_config(&self) -> &LaunchedEnvConfig {
        match self {
            Kernel::Jupyter(k) => k.launched_config(),
            Kernel::Test(k) => k.launched_config(),
        }
    }

    fn env_path(&self) -> Option<&PathBuf> {
        match self {
            Kernel::Jupyter(k) => k.env_path(),
            Kernel::Test(k) => k.env_path(),
        }
    }

    fn is_connected(&self) -> bool {
        match self {
            Kernel::Jupyter(k) => k.is_connected(),
            Kernel::Test(k) => k.is_connected(),
        }
    }

    fn update_launched_uv_deps(&mut self, deps: Vec<String>) {
        match self {
            Kernel::Jupyter(k) => k.update_launched_uv_deps(deps),
            Kernel::Test(k) => k.update_launched_uv_deps(deps),
        }
    }
}
