//! Kind-agnostic routing and sync for keyed documents (frame `0x0b`).
//!
//! The host keeps one replica per `(kind, id, epoch)` and routes `0x0b`
//! frames to it by header. Kind-specific handles embed [`KeyedDocReplica`]
//! and add typed reads and validated writes; [`KeyedDocHandle`] exposes the
//! untyped replica for kinds that need nothing more.

use automerge::sync::{self, SyncDoc};
use automerge::{ActorId, AutoCommit};
use notebook_wire::{frame_types, KeyedDocFrameHeader};
use serde::Serialize;
use wasm_bindgen::prelude::*;

use crate::serialize_to_js;

/// Split a typed `0x0b` frame (type byte included) into header and sync bytes.
pub(crate) fn split_keyed_doc_frame(
    frame_bytes: &[u8],
) -> Result<(KeyedDocFrameHeader, &[u8]), String> {
    match frame_bytes.split_first() {
        Some((&frame_types::KEYED_DOC_SYNC, payload)) => {
            KeyedDocFrameHeader::try_parse(payload).map_err(|e| e.to_string())
        }
        _ => Err("expected a KeyedDocSync (0x0b) frame".to_string()),
    }
}

/// Read the routing header `{kind, id, epoch}` of a typed `0x0b` frame.
#[wasm_bindgen]
pub fn keyed_doc_frame_header(frame_bytes: &[u8]) -> Result<JsValue, JsError> {
    let (header, _) = split_keyed_doc_frame(frame_bytes).map_err(|e| JsError::new(&e))?;
    serialize_to_js(&header).map_err(|e| JsError::new(&e.to_string()))
}

/// Header-frame Automerge sync bytes for `(kind, id, epoch)`. The result is
/// the `0x0b` payload without the type byte.
#[wasm_bindgen]
pub fn encode_keyed_doc_frame(
    kind: &str,
    id: &str,
    epoch: u32,
    sync_message: &[u8],
) -> Result<Vec<u8>, JsError> {
    let header = KeyedDocFrameHeader::new(kind, id, epoch.into());
    header
        .validate()
        .map_err(|e| JsError::new(&e.to_string()))?;
    Ok(header.encode_frame(sync_message))
}

/// What became of an inbound frame.
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(crate) enum KeyedFrameOutcome {
    Applied {
        changed: bool,
        /// Header-framed reply payload; send as frame `0x0b`.
        reply: Option<Vec<u8>>,
    },
    /// The frame belongs to another document or epoch.
    Ignored {
        kind: String,
        id: String,
        epoch: u64,
    },
    /// Receive failed; sync state was reset and `reply` restarts negotiation.
    SyncError {
        error: String,
        reply: Option<Vec<u8>>,
    },
}

/// One keyed document replica at one epoch, with its sync state.
pub(crate) struct KeyedDocReplica {
    header: KeyedDocFrameHeader,
    doc: AutoCommit,
    sync_state: sync::State,
}

impl KeyedDocReplica {
    /// An empty replica filled in by sync.
    pub(crate) fn new(kind: &str, id: &str, epoch: u64, actor_label: &str) -> Result<Self, String> {
        let header = KeyedDocFrameHeader::new(kind, id, epoch);
        header.validate().map_err(|e| e.to_string())?;
        Ok(Self {
            header,
            doc: AutoCommit::new().with_actor(ActorId::from(actor_label.as_bytes())),
            sync_state: sync::State::new(),
        })
    }

    pub(crate) fn header(&self) -> &KeyedDocFrameHeader {
        &self.header
    }

    pub(crate) fn doc(&self) -> &AutoCommit {
        &self.doc
    }

    pub(crate) fn doc_mut(&mut self) -> &mut AutoCommit {
        &mut self.doc
    }

    /// Apply a typed `0x0b` frame (type byte included) addressed to this
    /// replica. Frames for another key or epoch are left to the host.
    pub(crate) fn receive_frame(
        &mut self,
        frame_bytes: &[u8],
    ) -> Result<KeyedFrameOutcome, String> {
        let (header, sync_bytes) = split_keyed_doc_frame(frame_bytes)?;
        if header != self.header {
            return Ok(KeyedFrameOutcome::Ignored {
                kind: header.kind,
                id: header.id,
                epoch: header.epoch,
            });
        }
        let message =
            sync::Message::decode(sync_bytes).map_err(|e| format!("decode keyed doc sync: {e}"))?;
        let before = self.doc.get_heads();
        let applied = self
            .doc
            .sync()
            .receive_sync_message(&mut self.sync_state, message);
        match applied {
            Ok(()) => Ok(KeyedFrameOutcome::Applied {
                changed: self.doc.get_heads() != before,
                reply: self.flush_sync(),
            }),
            Err(error) => {
                self.sync_state = sync::State::new();
                Ok(KeyedFrameOutcome::SyncError {
                    error: error.to_string(),
                    reply: self.flush_sync(),
                })
            }
        }
    }

    /// Header-framed sync payload for local changes or negotiation, if any.
    pub(crate) fn flush_sync(&mut self) -> Option<Vec<u8>> {
        self.doc
            .sync()
            .generate_sync_message(&mut self.sync_state)
            .map(|msg| self.header.encode_frame(&msg.encode()))
    }

    /// Roll back the bookkeeping of a flush the transport did not deliver.
    pub(crate) fn cancel_last_flush(&mut self) {
        self.sync_state.in_flight = false;
        self.sync_state.sent_hashes.clear();
    }
}

/// Browser replica of one keyed document, for kinds that need no typed view.
#[wasm_bindgen]
pub struct KeyedDocHandle {
    replica: KeyedDocReplica,
}

#[wasm_bindgen]
impl KeyedDocHandle {
    /// An empty replica of `(kind, id)` at `epoch`, filled in by sync.
    #[wasm_bindgen(constructor)]
    pub fn new(
        kind: &str,
        id: &str,
        epoch: u32,
        actor_label: &str,
    ) -> Result<KeyedDocHandle, JsError> {
        KeyedDocReplica::new(kind, id, epoch.into(), actor_label)
            .map(|replica| KeyedDocHandle { replica })
            .map_err(|e| JsError::new(&e))
    }

    #[wasm_bindgen(getter)]
    pub fn kind(&self) -> String {
        self.replica.header().kind.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn id(&self) -> String {
        self.replica.header().id.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn epoch(&self) -> u32 {
        u32::try_from(self.replica.header().epoch).unwrap_or(u32::MAX)
    }

    /// Apply a typed `0x0b` frame. Returns `{type: "applied", changed,
    /// reply}`, `{type: "ignored", kind, id, epoch}` or `{type:
    /// "sync_error", error, reply}`; send any `reply` as frame `0x0b`.
    pub fn receive_frame(&mut self, frame_bytes: &[u8]) -> Result<JsValue, JsError> {
        let outcome = self
            .replica
            .receive_frame(frame_bytes)
            .map_err(|e| JsError::new(&e))?;
        serialize_to_js(&outcome).map_err(|e| JsError::new(&e.to_string()))
    }

    /// Header-framed sync payload for the opening handshake, if any.
    pub fn flush_sync(&mut self) -> Option<Vec<u8>> {
        self.replica.flush_sync()
    }

    pub fn cancel_last_flush(&mut self) {
        self.replica.cancel_last_flush();
    }

    /// The document as plain JSON.
    pub fn to_json(&self) -> Result<JsValue, JsError> {
        serialize_to_js(&automerge::AutoSerde::from(self.replica.doc()))
            .map_err(|e| JsError::new(&e.to_string()))
    }

    pub fn get_heads_hex(&mut self) -> Vec<String> {
        self.replica
            .doc_mut()
            .get_heads()
            .iter()
            .map(|head| head.to_string())
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use automerge::transaction::Transactable;
    use automerge::{ReadDoc, ROOT};

    fn producer(value: &str) -> AutoCommit {
        let mut doc = AutoCommit::new().with_actor(ActorId::from(b"rt:producer".as_slice()));
        doc.put(ROOT, "value", value).unwrap();
        doc.commit();
        doc
    }

    fn frame(header: &KeyedDocFrameHeader, msg: sync::Message) -> Vec<u8> {
        let mut bytes = vec![frame_types::KEYED_DOC_SYNC];
        bytes.extend(header.encode_frame(&msg.encode()));
        bytes
    }

    fn value(doc: &AutoCommit) -> Option<String> {
        doc.get(ROOT, "value")
            .unwrap()
            .and_then(|(value, _)| value.into_string().ok())
    }

    #[test]
    fn replica_syncs_and_routes_by_kind_id_and_epoch() {
        let mut hub = producer("one");
        let mut hub_state = sync::State::new();
        let mut replica =
            KeyedDocReplica::new("test_kv", "d1", 2, "user:dev:alice/browser").unwrap();

        // The opening frame announces the replica's key and epoch.
        let opening = replica.flush_sync().unwrap();
        let (header, body) = KeyedDocFrameHeader::try_parse(&opening).unwrap();
        assert_eq!(header, KeyedDocFrameHeader::new("test_kv", "d1", 2));
        hub.sync()
            .receive_sync_message(&mut hub_state, sync::Message::decode(body).unwrap())
            .unwrap();

        // Frames for another epoch, id or kind are left to the host.
        for other in [
            KeyedDocFrameHeader::new("test_kv", "d1", 1),
            KeyedDocFrameHeader::new("test_kv", "d2", 2),
            KeyedDocFrameHeader::new("other_kind", "d1", 2),
        ] {
            let msg = hub
                .sync()
                .generate_sync_message(&mut sync::State::new())
                .unwrap();
            match replica.receive_frame(&frame(&other, msg)).unwrap() {
                KeyedFrameOutcome::Ignored { kind, id, epoch } => {
                    assert_eq!(KeyedDocFrameHeader::new(kind, id, epoch), other);
                }
                outcome => panic!("expected Ignored, got {outcome:?}"),
            }
        }
        assert_eq!(value(replica.doc()), None);
        assert!(replica
            .receive_frame(&[frame_types::COMMS_DOC_SYNC, 0, 0])
            .is_err());

        let msg = hub.sync().generate_sync_message(&mut hub_state).unwrap();
        match replica.receive_frame(&frame(&header, msg)).unwrap() {
            KeyedFrameOutcome::Applied { changed, reply } => {
                assert!(changed);
                let (reply_header, _) = KeyedDocFrameHeader::try_parse(&reply.unwrap()).unwrap();
                assert_eq!(reply_header, header);
            }
            outcome => panic!("expected Applied, got {outcome:?}"),
        }
        assert_eq!(value(replica.doc()).as_deref(), Some("one"));
    }

    #[test]
    fn cancelled_flush_is_regenerated() {
        let mut replica = KeyedDocReplica::new("test_kv", "d1", 0, "browser").unwrap();
        let first = replica.flush_sync().unwrap();
        assert!(replica.flush_sync().is_none(), "in flight");
        replica.cancel_last_flush();
        assert_eq!(replica.flush_sync().unwrap(), first);
    }

    #[test]
    fn invalid_keys_are_refused() {
        assert!(KeyedDocReplica::new("Bad-Kind", "d1", 0, "browser").is_err());
        assert!(KeyedDocReplica::new("test_kv", "", 0, "browser").is_err());
        assert!(split_keyed_doc_frame(&[]).is_err());
        assert!(split_keyed_doc_frame(&[frame_types::KEYED_DOC_SYNC, 0, 0]).is_err());
    }
}
