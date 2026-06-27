//! `RelayHandle` — transparent byte pipe between a frontend (WASM) and the daemon.
//!
//! Unlike [`DocHandle`](crate::DocHandle), the relay does not maintain a local
//! Automerge document replica. It does not participate in the Automerge sync
//! protocol — the frontend owns sync state and the relay forwards bytes, plus
//! a native presence heartbeat for desktop liveness.
//!
//! This eliminates the "dual sync" problem where both the relay and the WASM
//! generate sync messages on the same daemon connection. The relay never owns
//! bootstrap or readiness heuristics; it only owns socket forwarding and relay
//! liveness.
//!
//! ## API surface
//!
//! The relay handle exposes only what Tauri needs:
//!
//! - `send_request` — daemon protocol (launch kernel, save, etc.)
//! - `notebook_id` — read the notebook identifier
//! - `forward_frame` — pipe a typed frame from the frontend to the daemon
//!
//! No `with_doc`. No `get_cells`. No `snapshot`. No `subscribe`.

use tokio::sync::{broadcast, mpsc, oneshot};

use notebook_protocol::protocol::{
    BlobUploadPart, NotebookBroadcast, NotebookRequest, NotebookResponse, PutBlobHeader,
    PutBlobResult,
};
use sha2::{Digest, Sha256};

use crate::error::SyncError;

const PUT_BLOB_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
const PUT_BLOB_ABORT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(1);

/// Commands for the relay task — only socket I/O operations.
///
/// This is intentionally minimal. The relay has no local document,
/// so there are no mutation or sync confirmation commands.
pub enum RelayCommand {
    /// Send a request to the daemon and wait for a response.
    ///
    /// The caller generates the correlation `id` so it can later send a
    /// matching `CancelRequest` if the wait times out — otherwise the
    /// pending entry would linger in the relay's `HashMap` forever.
    SendRequest {
        id: String,
        request: NotebookRequest,
        required_heads: Vec<String>,
        reply: oneshot::Sender<Result<NotebookResponse, SyncError>>,
        /// Optional broadcast sender for delivering broadcasts during long-running
        /// requests (e.g., LaunchKernel with environment progress updates).
        broadcast_tx: Option<broadcast::Sender<NotebookBroadcast>>,
    },

    /// Send a one-shot PutBlob frame to the daemon and wait for a response.
    SendPutBlob {
        id: String,
        frame: Vec<u8>,
        reply: oneshot::Sender<Result<NotebookResponse, SyncError>>,
    },

    /// Evict a pending request whose caller has given up (e.g., timed
    /// out). Stops future responses for `id` from being delivered to a
    /// dead `oneshot` and keeps the pending map from accumulating
    /// abandoned entries across a long-lived relay.
    CancelRequest { id: String },

    /// Forward a typed frame from the frontend to the daemon.
    ///
    /// The relay validates the frame type byte but does not decode
    /// the payload — it writes the type and payload directly to the
    /// daemon socket.
    ForwardFrame {
        frame_type: u8,
        payload: Vec<u8>,
        reply: oneshot::Sender<Result<(), SyncError>>,
    },
}

/// A handle to a relay connection — forwards frames between a frontend
/// (WASM) and the daemon without maintaining a local document replica.
///
/// Unlike `DocHandle`, this does not participate in the Automerge sync
/// protocol. The frontend owns the sync state; the relay just pipes bytes.
///
/// `RelayHandle` is `Clone` — multiple callers can hold handles to the
/// same relay connection.
///
/// # Example
///
/// ```ignore
/// // Forward a WASM sync frame to the daemon
/// handle.forward_frame(frame_types::AUTOMERGE_SYNC, payload).await?;
///
/// // Send a daemon protocol request
/// let response = handle.send_request(NotebookRequest::SaveNotebook { ... }).await?;
///
/// // Read the notebook ID (synchronous)
/// let id = handle.notebook_id();
/// ```
#[derive(Clone)]
pub struct RelayHandle {
    cmd_tx: mpsc::Sender<RelayCommand>,
    notebook_id: std::sync::Arc<std::sync::RwLock<String>>,
}

impl std::fmt::Debug for RelayHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RelayHandle")
            .field(
                "notebook_id",
                &*self.notebook_id.read().unwrap_or_else(|e| e.into_inner()),
            )
            .finish()
    }
}

impl RelayHandle {
    /// Create a new `RelayHandle` from a command channel and notebook ID.
    ///
    /// Called by the relay connect functions, not by end users.
    pub(crate) fn new(cmd_tx: mpsc::Sender<RelayCommand>, notebook_id: String) -> Self {
        Self {
            cmd_tx,
            notebook_id: std::sync::Arc::new(std::sync::RwLock::new(notebook_id)),
        }
    }

    /// Get the notebook ID this handle is connected to.
    pub fn notebook_id(&self) -> String {
        self.notebook_id
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// Update the notebook ID stored in this relay handle.
    pub fn set_notebook_id(&self, new_id: String) {
        *self.notebook_id.write().unwrap_or_else(|e| e.into_inner()) = new_id;
    }

    /// Send a request to the daemon and wait for a response.
    ///
    /// This is async because it involves socket I/O. The request is sent
    /// to the daemon via the relay task, which handles the wire protocol.
    /// The per-request-type timeout (see `relay_task::request_timeout`) is
    /// enforced here; an overrun returns `SyncError::Timeout`.
    pub async fn send_request(
        &self,
        request: NotebookRequest,
    ) -> Result<NotebookResponse, SyncError> {
        self.send_request_inner(request, Vec::new(), None).await
    }

    /// Send a request with a broadcast channel for real-time progress updates.
    ///
    /// Used for long-running requests like `LaunchKernel` where the daemon
    /// sends progress broadcasts (env creation, package installs) while
    /// the request is in flight.
    pub async fn send_request_with_broadcast(
        &self,
        request: NotebookRequest,
        broadcast_tx: broadcast::Sender<NotebookBroadcast>,
    ) -> Result<NotebookResponse, SyncError> {
        self.send_request_inner(request, Vec::new(), Some(broadcast_tx))
            .await
    }

    async fn send_request_inner(
        &self,
        request: NotebookRequest,
        required_heads: Vec<String>,
        broadcast_tx: Option<broadcast::Sender<NotebookBroadcast>>,
    ) -> Result<NotebookResponse, SyncError> {
        let timeout = crate::relay_task::request_timeout(&request);
        // Generate the id here so we can send a matching CancelRequest on
        // timeout — otherwise the pending map inside the relay task would
        // accumulate abandoned entries across a long-lived connection.
        let id = uuid::Uuid::new_v4().to_string();
        let (reply_tx, reply_rx) = oneshot::channel();
        self.cmd_tx
            .send(RelayCommand::SendRequest {
                id: id.clone(),
                request,
                required_heads,
                reply: reply_tx,
                broadcast_tx,
            })
            .await
            .map_err(|_| SyncError::Disconnected)?;
        match tokio::time::timeout(timeout, crate::reply::recv(reply_rx)).await {
            Ok(reply) => reply,
            Err(_) => {
                // Fire-and-forget eviction. If the relay has already shut
                // down (cmd_tx closed), there's nothing to clean up.
                let _ = self.cmd_tx.send(RelayCommand::CancelRequest { id }).await;
                Err(SyncError::Timeout)
            }
        }
    }

    /// Upload bytes to the daemon blob store using a one-shot PutBlob frame.
    pub async fn put_blob_one_shot(
        &self,
        bytes: &[u8],
        media_type: &str,
    ) -> Result<PutBlobResult, SyncError> {
        let sha256 = hex::encode(Sha256::digest(bytes));
        let id = uuid::Uuid::new_v4().to_string();
        let header = PutBlobHeader::Put {
            id: id.clone(),
            media_type: media_type.to_string(),
            size: bytes.len() as u64,
            sha256,
            durability: None,
            purpose: None,
        };
        let frame = header.encode_frame(bytes)?;
        let (reply_tx, reply_rx) = oneshot::channel();
        self.cmd_tx
            .send(RelayCommand::SendPutBlob {
                id: id.clone(),
                frame,
                reply: reply_tx,
            })
            .await
            .map_err(|_| SyncError::Disconnected)?;

        let response =
            match tokio::time::timeout(PUT_BLOB_TIMEOUT, crate::reply::recv(reply_rx)).await {
                Ok(reply) => reply?,
                Err(_) => {
                    let _ = self.cmd_tx.send(RelayCommand::CancelRequest { id }).await;
                    return Err(SyncError::Timeout);
                }
            };

        match response {
            NotebookResponse::BlobStored {
                hash,
                size,
                media_type,
            } => Ok(PutBlobResult {
                blob: hash,
                size,
                media_type,
            }),
            NotebookResponse::BlobUploadError { reason } => Err(SyncError::BlobUpload(reason)),
            other => Err(SyncError::Protocol(format!(
                "Unexpected response for PutBlob: {other:?}"
            ))),
        }
    }

    /// Upload bytes to the daemon blob store using multipart PutBlob frames.
    pub async fn put_blob_multipart(
        &self,
        bytes: &[u8],
        media_type: &str,
    ) -> Result<PutBlobResult, SyncError> {
        let expected_sha256 = hex::encode(Sha256::digest(bytes));
        let created = self
            .send_request(NotebookRequest::CreateBlobUpload {
                media_type: media_type.to_string(),
                size: bytes.len() as u64,
                sha256: Some(expected_sha256),
                part_size: None,
                purpose: None,
            })
            .await?;

        let (upload_id, part_size) = match created {
            NotebookResponse::BlobUploadCreated {
                upload_id,
                part_size,
                ..
            } if part_size > 0 => (upload_id, part_size as usize),
            NotebookResponse::BlobUploadCreated {
                upload_id,
                part_size,
                ..
            } => {
                self.abort_blob_upload_best_effort(&upload_id).await;
                return Err(SyncError::Protocol(format!(
                    "Invalid multipart blob part_size: {part_size}"
                )));
            }
            NotebookResponse::BlobUploadError { reason } => {
                return Err(SyncError::BlobUpload(reason));
            }
            other => {
                return Err(SyncError::Protocol(format!(
                    "Unexpected response for create_blob_upload: {other:?}"
                )));
            }
        };

        let mut manifest = Vec::new();
        for (index, chunk) in bytes.chunks(part_size).enumerate() {
            let part_number = match u32::try_from(index + 1) {
                Ok(part_number) => part_number,
                Err(_) => {
                    self.abort_blob_upload_best_effort(&upload_id).await;
                    return Err(SyncError::Protocol(
                        "multipart blob upload exceeds u32 part count".to_string(),
                    ));
                }
            };
            let part_sha256 = hex::encode(Sha256::digest(chunk));
            let id = uuid::Uuid::new_v4().to_string();
            let header = PutBlobHeader::Part {
                id: id.clone(),
                upload_id: upload_id.clone(),
                part_number,
                size: chunk.len() as u64,
                sha256: part_sha256.clone(),
            };
            let frame = match header.encode_frame(chunk) {
                Ok(frame) => frame,
                Err(error) => {
                    self.abort_blob_upload_best_effort(&upload_id).await;
                    return Err(error.into());
                }
            };
            let response = self.send_put_blob_frame(id, frame).await;
            let response = match response {
                Ok(response) => response,
                Err(error) => {
                    self.abort_blob_upload_best_effort(&upload_id).await;
                    return Err(error);
                }
            };
            match response {
                NotebookResponse::BlobPartStored {
                    upload_id: response_upload_id,
                    part_number: response_part_number,
                    sha256,
                } if response_upload_id == upload_id
                    && response_part_number == part_number
                    && sha256 == part_sha256 =>
                {
                    manifest.push(BlobUploadPart {
                        part_number,
                        sha256: part_sha256,
                        size: chunk.len() as u64,
                    });
                }
                NotebookResponse::BlobUploadError { reason } => {
                    self.abort_blob_upload_best_effort(&upload_id).await;
                    return Err(SyncError::BlobUpload(reason));
                }
                other => {
                    self.abort_blob_upload_best_effort(&upload_id).await;
                    return Err(SyncError::Protocol(format!(
                        "Unexpected response for PutBlob part: {other:?}"
                    )));
                }
            }
        }

        let complete_response = match self
            .send_request(NotebookRequest::CompleteBlobUpload {
                upload_id: upload_id.clone(),
                parts: manifest,
            })
            .await
        {
            Ok(response) => response,
            Err(error) => {
                self.abort_blob_upload_best_effort(&upload_id).await;
                return Err(error);
            }
        };

        match complete_response {
            NotebookResponse::BlobStored {
                hash,
                size,
                media_type,
            } => Ok(PutBlobResult {
                blob: hash,
                size,
                media_type,
            }),
            NotebookResponse::BlobUploadError { reason } => {
                self.abort_blob_upload_best_effort(&upload_id).await;
                Err(SyncError::BlobUpload(reason))
            }
            other => {
                self.abort_blob_upload_best_effort(&upload_id).await;
                Err(SyncError::Protocol(format!(
                    "Unexpected response for complete_blob_upload: {other:?}"
                )))
            }
        }
    }

    async fn abort_blob_upload_best_effort(&self, upload_id: &str) {
        let id = uuid::Uuid::new_v4().to_string();
        let (reply_tx, reply_rx) = oneshot::channel();
        if self
            .cmd_tx
            .send(RelayCommand::SendRequest {
                id: id.clone(),
                request: NotebookRequest::AbortBlobUpload {
                    upload_id: upload_id.to_string(),
                },
                required_heads: Vec::new(),
                reply: reply_tx,
                broadcast_tx: None,
            })
            .await
            .is_err()
        {
            return;
        }
        if tokio::time::timeout(PUT_BLOB_ABORT_TIMEOUT, crate::reply::recv(reply_rx))
            .await
            .is_err()
        {
            let _ = self.cmd_tx.send(RelayCommand::CancelRequest { id }).await;
        }
    }

    async fn send_put_blob_frame(
        &self,
        id: String,
        frame: Vec<u8>,
    ) -> Result<NotebookResponse, SyncError> {
        let (reply_tx, reply_rx) = oneshot::channel();
        self.cmd_tx
            .send(RelayCommand::SendPutBlob {
                id: id.clone(),
                frame,
                reply: reply_tx,
            })
            .await
            .map_err(|_| SyncError::Disconnected)?;

        match tokio::time::timeout(PUT_BLOB_TIMEOUT, crate::reply::recv(reply_rx)).await {
            Ok(reply) => reply,
            Err(_) => {
                let _ = self.cmd_tx.send(RelayCommand::CancelRequest { id }).await;
                Err(SyncError::Timeout)
            }
        }
    }

    /// Forward a typed frame from the frontend to the daemon.
    ///
    /// The relay writes the frame directly to the daemon socket without
    /// decoding or processing it. Used for Automerge sync messages and
    /// presence frames originating from the WASM frontend.
    pub async fn forward_frame(&self, frame_type: u8, payload: Vec<u8>) -> Result<(), SyncError> {
        let (reply_tx, reply_rx) = oneshot::channel();
        self.cmd_tx
            .send(RelayCommand::ForwardFrame {
                frame_type,
                payload,
                reply: reply_tx,
            })
            .await
            .map_err(|_| SyncError::Disconnected)?;
        crate::reply::recv(reply_rx).await
    }
}
