use std::sync::Arc;

use automerge::sync;
use tokio::io::AsyncWrite;
use tokio::sync::broadcast;
use tracing::{debug, warn};

use crate::connection::{self, NotebookFrameType};

use super::peer_writer::PeerWriter;

pub(super) async fn send_initial_pool_sync<W>(
    writer: &mut W,
    daemon: &Arc<crate::daemon::Daemon>,
    pool_peer_state: &mut sync::State,
) -> anyhow::Result<()>
where
    W: AsyncWrite + Unpin,
{
    let initial_pool_encoded = {
        let mut pool_doc = daemon.pool_doc.write().await;
        match pool_doc.generate_sync_message_recovering(pool_peer_state, "initial-pool-sync") {
            Ok(message) => message.map(|msg| msg.encode()),
            Err(e) => {
                warn!("[notebook-sync] initial pool sync failed: {}", e);
                None
            }
        }
    };
    if let Some(encoded) = initial_pool_encoded {
        connection::send_typed_frame(writer, NotebookFrameType::PoolStateSync, &encoded).await?;
    }
    Ok(())
}

pub(super) async fn handle_pool_state_frame(
    daemon: &Arc<crate::daemon::Daemon>,
    pool_peer_state: &mut sync::State,
    writer: &PeerWriter,
    payload: &[u8],
) -> anyhow::Result<bool> {
    let message =
        sync::Message::decode(payload).map_err(|e| anyhow::anyhow!("decode pool sync: {}", e))?;
    let reply_encoded = {
        let mut pool_doc = daemon.pool_doc.write().await;

        match pool_doc.receive_sync_message_recovering(
            pool_peer_state,
            message,
            "pool-receive-sync",
        ) {
            Ok(()) => {}
            Err(e) => {
                warn!("[notebook-sync] pool receive_sync_message error: {}", e);
                return Ok(false);
            }
        }

        generate_pool_sync_message(&mut pool_doc, pool_peer_state, "pool-sync-reply")
    };
    if let Some(encoded) = reply_encoded {
        writer.send_frame(NotebookFrameType::PoolStateSync, encoded)?;
    }
    Ok(true)
}

pub(super) async fn forward_pool_state_broadcast(
    daemon: &Arc<crate::daemon::Daemon>,
    peer_id: &str,
    pool_peer_state: &mut sync::State,
    writer: &PeerWriter,
    result: Result<(), broadcast::error::RecvError>,
) -> anyhow::Result<bool> {
    match result {
        Ok(()) => {
            send_pool_sync_update(daemon, pool_peer_state, writer, "pool-broadcast").await?;
        }
        Err(broadcast::error::RecvError::Lagged(n)) => {
            debug!(
                "[notebook-sync] Peer {} lagged {} pool state updates",
                peer_id, n
            );
            send_pool_sync_update(daemon, pool_peer_state, writer, "pool-broadcast-lagged").await?;
        }
        Err(broadcast::error::RecvError::Closed) => {
            // Pool doc channel closed — daemon is shutting down.
            return Ok(false);
        }
    }
    Ok(true)
}

async fn send_pool_sync_update(
    daemon: &Arc<crate::daemon::Daemon>,
    pool_peer_state: &mut sync::State,
    writer: &PeerWriter,
    label: &str,
) -> anyhow::Result<()> {
    let encoded = {
        let mut pool_doc = daemon.pool_doc.write().await;
        generate_pool_sync_message(&mut pool_doc, pool_peer_state, label)
    };
    if let Some(encoded) = encoded {
        writer.send_frame(NotebookFrameType::PoolStateSync, encoded)?;
    }
    Ok(())
}

fn generate_pool_sync_message(
    pool_doc: &mut notebook_doc::pool_state::PoolDoc,
    pool_peer_state: &mut sync::State,
    label: &str,
) -> Option<Vec<u8>> {
    match pool_doc.generate_sync_message_recovering(pool_peer_state, label) {
        Ok(message) => message.map(|msg| msg.encode()),
        Err(e) => {
            warn!("[notebook-sync] pool sync generation failed: {}", e);
            None
        }
    }
}
