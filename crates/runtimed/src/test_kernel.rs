//! In-memory test kernel for deterministic E2E tests.
//!
//! `TestKernel` implements `KernelConnection` without ZMQ, real kernel processes,
//! or environment resolution. It writes directly to `RuntimeStateDoc` and signals
//! `ExecutionDone` over the lifecycle channel so the runtime agent's queue loop
//! advances exactly as it would with a real kernel.
//!
//! Activated when `kernel_type == "test"` in a `LaunchKernel` request.

use std::path::PathBuf;

use anyhow::Result;
use notebook_protocol::protocol::{CommRequestMessage, LaunchedEnvConfig};
use runtime_doc::{KernelActivity, RuntimeLifecycle, RuntimeStateHandle};
use tokio::sync::mpsc;
use tracing::debug;

use crate::kernel_connection::{KernelConnection, KernelLaunchConfig, KernelSharedRefs};
use crate::output_prep::{queue_command_channels, LifecycleSignal, QueueCommandReceivers};
use crate::protocol::{CompletionItem, HistoryEntry};

pub struct TestKernel {
    state: RuntimeStateHandle,
    lifecycle_tx: mpsc::UnboundedSender<LifecycleSignal>,
    kernel_type: String,
    env_source: String,
    launched_config: LaunchedEnvConfig,
    execution_counter: u64,
}

impl KernelConnection for TestKernel {
    async fn launch(
        config: KernelLaunchConfig,
        shared: KernelSharedRefs,
    ) -> Result<(Self, QueueCommandReceivers)> {
        let (lifecycle_tx, _work_tx, receivers) = queue_command_channels(1);

        if let Err(e) = shared
            .state
            .with_doc(|sd| sd.set_lifecycle(&RuntimeLifecycle::Running(KernelActivity::Idle)))
        {
            debug!("[test-kernel] Failed to set initial idle state: {}", e);
        }

        let kernel = TestKernel {
            state: shared.state,
            lifecycle_tx,
            kernel_type: config.kernel_type,
            env_source: config.env_source,
            launched_config: config.launched_config,
            execution_counter: 0,
        };

        Ok((kernel, receivers))
    }

    async fn execute(
        &mut self,
        execution_id: &str,
        _cell_id: Option<&str>,
        source: &str,
    ) -> Result<()> {
        self.execution_counter += 1;
        let output_id = format!("test-out-{}-{}", execution_id, self.execution_counter);
        let manifest = serde_json::json!({
            "output_type": "stream",
            "output_id": output_id,
            "name": "stdout",
            "text": { "inline": source }
        });

        let eid = execution_id.to_string();
        if let Err(e) = self.state.with_doc(|sd| {
            sd.set_execution_running(&eid)?;
            sd.set_execution_count(&eid, self.execution_counter as i64)?;
            sd.append_output(&eid, &manifest)?;
            sd.set_execution_done(&eid, true)?;
            Ok(())
        }) {
            debug!(
                "[test-kernel] State write failed for {}: {}",
                execution_id, e
            );
        }

        let _ = self.lifecycle_tx.send(LifecycleSignal::ExecutionDone {
            execution_id: execution_id.to_string(),
        });

        Ok(())
    }

    async fn interrupt(&mut self) -> Result<()> {
        Ok(())
    }

    async fn shutdown(&mut self) -> Result<()> {
        Ok(())
    }

    async fn send_comm_message(&mut self, _: CommRequestMessage) -> Result<()> {
        Ok(())
    }

    async fn send_comm_update(
        &mut self,
        _: &str,
        _: serde_json::Value,
        _: Vec<Vec<String>>,
        _: Vec<Vec<u8>>,
    ) -> Result<()> {
        Ok(())
    }

    async fn complete(&mut self, _: &str, _: usize) -> Result<(Vec<CompletionItem>, usize, usize)> {
        Ok((vec![], 0, 0))
    }

    async fn get_history(&mut self, _: Option<&str>, _: i32, _: bool) -> Result<Vec<HistoryEntry>> {
        Ok(vec![])
    }

    fn kernel_type(&self) -> &str {
        &self.kernel_type
    }

    fn env_source(&self) -> &str {
        &self.env_source
    }

    fn launched_config(&self) -> &LaunchedEnvConfig {
        &self.launched_config
    }

    fn env_path(&self) -> Option<&PathBuf> {
        None
    }

    fn is_connected(&self) -> bool {
        true
    }

    fn update_launched_uv_deps(&mut self, _: Vec<String>) {}
}
