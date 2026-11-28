//! `NotebookRequest::InterruptExecution` handler.

use std::sync::Arc;

use crate::notebook_sync_server::{send_runtime_agent_command, NotebookRoom};
use crate::protocol::NotebookResponse;

/// Interrupt the kernel, or, with a `cell_id`, that prompt cell's run. Only
/// prompt Stop buttons send a `cell_id`, so it never reaches the kernel, even
/// when the cell is gone or no longer a prompt by the time the request lands.
pub(crate) async fn handle(room: &Arc<NotebookRoom>, cell_id: Option<String>) -> NotebookResponse {
    match cell_id {
        Some(cell_id) => crate::prompt_cells::interrupt_prompt(room, &cell_id).await,
        None => handle_kernel(room).await,
    }
}

async fn handle_kernel(room: &NotebookRoom) -> NotebookResponse {
    let has_runtime_agent = room.runtime_agent_request_tx.lock().await.is_some();
    if has_runtime_agent {
        // Do NOT mark executions as failed here on the coordinator side.
        // The coordinator's CRDT copy may contain entries from a concurrent
        // ExecuteCell whose final state should be determined by the runtime
        // agent, not pre-empted by a blanket sweep.  The runtime agent's
        // interrupt handler calls abort_inflight_executions() on its
        // own CRDT copy - only entries that have actually synced to the
        // agent are affected, so final state is correct regardless of
        // timing between ExecuteCell and InterruptExecution.
        match send_runtime_agent_command(
            room,
            notebook_protocol::protocol::RuntimeAgentRequest::InterruptExecution,
        )
        .await
        {
            Ok(()) => NotebookResponse::InterruptSent {},
            Err(e) => NotebookResponse::Error {
                error: format!("Agent interrupt error: {}", e),
            },
        }
    } else {
        NotebookResponse::NoKernel {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::blob_store::BlobStore;
    use crate::notebook_sync_server::RuntimeAgentMessage;
    use notebook_protocol::protocol::RuntimeAgentRequest;

    fn test_room() -> (tempfile::TempDir, Arc<NotebookRoom>) {
        let tmp = tempfile::TempDir::new().unwrap();
        let room = Arc::new(NotebookRoom::new_fresh(
            uuid::Uuid::new_v4(),
            None,
            tmp.path(),
            Arc::new(BlobStore::new(tmp.path().join("blobs"))),
            false,
        ));
        (tmp, room)
    }

    async fn add_cells(room: &NotebookRoom) {
        let mut doc = room.doc.write().await;
        doc.add_cell(0, "code-1", "code").unwrap();
        doc.add_cell(1, "prompt-1", "raw").unwrap();
        doc.set_cell_metadata("prompt-1", &serde_json::json!({"nteract": {"prompt": {}}}))
            .unwrap();
        // A raw cell without prompt metadata is an ordinary cell.
        doc.add_cell(2, "raw-1", "raw").unwrap();
    }

    /// Install a kernel runtime-agent channel and return its receiver.
    async fn connect_kernel_agent(
        room: &NotebookRoom,
    ) -> tokio::sync::mpsc::Receiver<RuntimeAgentMessage> {
        let (tx, rx) = tokio::sync::mpsc::channel(4);
        *room.runtime_agent_request_tx.lock().await = Some(tx);
        rx
    }

    #[tokio::test]
    async fn without_a_cell_id_the_kernel_is_interrupted() {
        let (_tmp, room) = test_room();
        add_cells(&room).await;
        assert!(matches!(
            handle(&room, None).await,
            NotebookResponse::NoKernel {}
        ));

        let mut kernel_rx = connect_kernel_agent(&room).await;
        assert!(matches!(
            handle(&room, None).await,
            NotebookResponse::InterruptSent {}
        ));
        let Some(RuntimeAgentMessage::Command(envelope)) = kernel_rx.recv().await else {
            panic!("kernel agent must receive the interrupt");
        };
        assert!(matches!(
            envelope.request,
            RuntimeAgentRequest::InterruptExecution
        ));
    }

    #[tokio::test]
    async fn a_cell_id_never_reaches_the_kernel() {
        let (_tmp, room) = test_room();
        add_cells(&room).await;
        // A queued kernel execution behind `code-1`: a Stop naming that cell
        // must not cancel it either.
        room.doc
            .write()
            .await
            .set_execution_id("code-1", Some("kernel-exec"))
            .unwrap();
        room.state
            .with_doc(|sd| {
                sd.create_execution_with_source_provenance(
                    "kernel-exec",
                    "1 + 1",
                    0,
                    None,
                    Some("code-1"),
                )
                .map(|_| ())
            })
            .unwrap();
        let mut kernel_rx = connect_kernel_agent(&room).await;

        for cell_id in ["prompt-1", "code-1", "raw-1", "missing"] {
            let response = handle(&room, Some(cell_id.to_string())).await;
            assert!(
                matches!(response, NotebookResponse::InterruptSent {}),
                "{cell_id}: {response:?}"
            );
        }
        assert!(
            kernel_rx.try_recv().is_err(),
            "a prompt stop must not interrupt the kernel"
        );
        let kernel_exec = room
            .state
            .read(|sd| sd.get_execution("kernel-exec"))
            .unwrap()
            .unwrap();
        assert_eq!(kernel_exec.status, "queued");
        assert_eq!(kernel_exec.stop_requested, 0);
    }
}
