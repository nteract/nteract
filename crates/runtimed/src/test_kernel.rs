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

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use notebook_doc::presence::PresenceState;
    use notebook_protocol::protocol::{KernelPorts, LaunchedEnvConfig};
    use runtime_doc::{
        CommsDoc, CommsDocHandle, KernelActivity, RuntimeLifecycle, RuntimeStateDoc,
    };
    use tokio::sync::{broadcast, RwLock};

    use super::*;
    use crate::blob_store::BlobStore;
    use crate::kernel_connection::{KernelLaunchConfig, KernelSharedRefs};
    use crate::output_blob_publisher::OutputBlobPublisher;

    fn test_launch_config(kernel_type: &str) -> KernelLaunchConfig {
        KernelLaunchConfig {
            kernel_type: kernel_type.to_string(),
            env_source: "test".to_string(),
            notebook_path: None,
            launched_config: LaunchedEnvConfig::default(),
            kernel_ports: KernelPorts {
                stdin: 0,
                control: 0,
                hb: 0,
                shell: 0,
                iopub: 0,
            },
            env_vars: vec![],
            redact_env_values_in_outputs: false,
            pooled_env: None,
            direct_python_path: None,
        }
    }

    fn test_shared_refs() -> (KernelSharedRefs, RuntimeStateHandle) {
        let (state_tx, _) = broadcast::channel(64);
        let handle = RuntimeStateHandle::new(RuntimeStateDoc::new(), state_tx);
        let (comms_tx, _) = broadcast::channel(64);
        let comms = CommsDocHandle::new(CommsDoc::new(), comms_tx);
        let (broadcast_tx, _) = broadcast::channel(16);
        let (presence_tx, _) = broadcast::channel(16);
        let blob_store = Arc::new(BlobStore::new(
            std::env::temp_dir().join("test-kernel-blobs"),
        ));
        let presence = Arc::new(RwLock::new(PresenceState::new()));
        let shared = KernelSharedRefs {
            state: handle.clone(),
            comms,
            blob_store,
            output_blob_publisher: OutputBlobPublisher::none(),
            broadcast_tx,
            presence,
            presence_tx,
            kernel_actor_principal: None,
        };
        (shared, handle)
    }

    /// Scaffold a queued execution entry so the kernel has something to run.
    fn scaffold_queued_execution(handle: &RuntimeStateHandle, execution_id: &str, source: &str) {
        static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        handle
            .with_doc(|sd| sd.create_execution_with_source(execution_id, source, seq))
            .unwrap();
    }

    #[tokio::test]
    async fn launch_sets_kernel_idle() {
        let (shared, handle) = test_shared_refs();
        let (_kernel, _rx) = TestKernel::launch(test_launch_config("test"), shared)
            .await
            .unwrap();

        let state = handle.read(|sd| sd.read_state()).unwrap();
        assert_eq!(
            state.kernel.lifecycle,
            RuntimeLifecycle::Running(KernelActivity::Idle),
        );
    }

    #[tokio::test]
    async fn execute_marks_execution_done_with_output() {
        let (shared, handle) = test_shared_refs();
        let (mut kernel, mut receivers) = TestKernel::launch(test_launch_config("test"), shared)
            .await
            .unwrap();

        scaffold_queued_execution(&handle, "exec-1", "1 + 1");
        kernel.execute("exec-1", None, "1 + 1").await.unwrap();

        // Execution entry should be marked done with success.
        let exec = handle
            .read(|sd| sd.get_execution("exec-1"))
            .unwrap()
            .expect("execution entry present");
        assert_eq!(exec.status, "done");
        assert_eq!(exec.success, Some(true));

        // One stdout output echoing the source should be present.
        let outputs = handle.read(|sd| sd.get_outputs("exec-1")).unwrap();
        assert_eq!(outputs.len(), 1);
        assert_eq!(outputs[0]["output_type"], "stream");
        assert_eq!(outputs[0]["name"], "stdout");
        assert_eq!(outputs[0]["text"]["inline"], "1 + 1");

        // ExecutionDone lifecycle signal should have been sent.
        let signal = receivers
            .lifecycle_rx
            .recv()
            .await
            .expect("lifecycle signal");
        assert!(matches!(
            signal,
            crate::output_prep::LifecycleSignal::ExecutionDone { execution_id }
            if execution_id == "exec-1"
        ));
    }

    #[tokio::test]
    async fn execute_increments_execution_count() {
        let (shared, handle) = test_shared_refs();
        let (mut kernel, _rx) = TestKernel::launch(test_launch_config("test"), shared)
            .await
            .unwrap();

        scaffold_queued_execution(&handle, "exec-a", "x = 1");
        scaffold_queued_execution(&handle, "exec-b", "x = 2");
        kernel.execute("exec-a", None, "x = 1").await.unwrap();
        kernel.execute("exec-b", None, "x = 2").await.unwrap();

        let a = handle
            .read(|sd| sd.get_execution("exec-a"))
            .unwrap()
            .unwrap();
        let b = handle
            .read(|sd| sd.get_execution("exec-b"))
            .unwrap()
            .unwrap();

        assert_eq!(a.execution_count, Some(1));
        assert_eq!(b.execution_count, Some(2));
    }
}
