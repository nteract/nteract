//! Browser replica of one Bokeh session document.
//!
//! The host keeps one handle per (session, epoch) and routes `0x0b` frames to
//! it by header; the keyed document key is `("bokeh_session", session_id)`.
//! Writes are limited to what the daemon's content filter accepts, so an
//! honest client never has a change rejected; disconnected sessions are made
//! read-only by the host.

use std::collections::BTreeMap;

use runtime_doc::{BokehSessionChangeset, BokehSessionDocMut, BokehSessionDocRef};
use serde::Serialize;
use wasm_bindgen::prelude::*;

use crate::keyed_doc::{KeyedDocReplica, KeyedFrameOutcome};
use crate::serialize_to_js;

/// Keyed document kind of Bokeh session documents.
pub(crate) const BOKEH_SESSION_KIND: &str = "bokeh_session";

#[wasm_bindgen]
pub struct BokehSessionDocHandle {
    replica: KeyedDocReplica,
    read_only: bool,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum BokehSessionFrameEvent {
    Applied {
        changed: bool,
        changeset: BokehSessionChangeset,
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

#[wasm_bindgen]
impl BokehSessionDocHandle {
    /// An empty replica for `session_id` at `epoch`, filled in by sync.
    #[wasm_bindgen(constructor)]
    pub fn new(
        session_id: &str,
        epoch: u32,
        actor_label: &str,
    ) -> Result<BokehSessionDocHandle, JsError> {
        KeyedDocReplica::new(BOKEH_SESSION_KIND, session_id, epoch.into(), actor_label)
            .map(|replica| BokehSessionDocHandle {
                replica,
                read_only: false,
            })
            .map_err(|e| JsError::new(&e))
    }

    #[wasm_bindgen(getter)]
    pub fn session_id(&self) -> String {
        self.replica.header().id.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn epoch(&self) -> u32 {
        u32::try_from(self.replica.header().epoch).unwrap_or(u32::MAX)
    }

    /// Whether the epoch's document has arrived.
    pub fn is_synced(&self) -> bool {
        self.doc().epoch().is_some()
    }

    pub fn set_read_only(&mut self, read_only: bool) {
        self.read_only = read_only;
    }

    pub fn is_read_only(&self) -> bool {
        self.read_only
    }

    /// Apply a typed `0x0b` frame. Returns `{type: "applied", changed,
    /// changeset, reply}`, `{type: "ignored", kind, id, epoch}` or `{type:
    /// "sync_error", error, reply}`; send any `reply` as frame `0x0b`.
    pub fn receive_frame(&mut self, frame_bytes: &[u8]) -> Result<JsValue, JsError> {
        let event = self
            .receive_frame_inner(frame_bytes)
            .map_err(|e| JsError::new(&e))?;
        serialize_to_js(&event).map_err(|e| JsError::new(&e.to_string()))
    }

    /// Header-framed sync payload for local changes, if any.
    pub fn flush_sync(&mut self) -> Option<Vec<u8>> {
        self.replica.flush_sync()
    }

    pub fn cancel_last_flush(&mut self) {
        self.replica.cancel_last_flush();
    }

    /// The materialized session, or `null` before the document arrives.
    pub fn snapshot(&self) -> JsValue {
        match self.doc().read_snapshot() {
            Ok(snapshot) => serialize_to_js(&snapshot).unwrap_or(JsValue::NULL),
            Err(_) => JsValue::NULL,
        }
    }

    pub fn get_model(&self, model_id: &str) -> JsValue {
        match self.doc().read_model(model_id) {
            Some(model) => serialize_to_js(&model).unwrap_or(JsValue::NULL),
            None => JsValue::NULL,
        }
    }

    pub fn get_prop(&self, model_id: &str, name: &str) -> Option<String> {
        self.doc().get_prop(model_id, name)
    }

    /// Who won a property's current value: `"kernel"` (the actor that built
    /// the epoch), `"local"` (this replica) or `"peer"`. The kernel never
    /// echoes accepted values, so a kernel-won value is authoritative.
    pub fn get_prop_origin(&self, model_id: &str, name: &str) -> Option<String> {
        let doc = self.doc();
        let actor = doc.prop_actor(model_id, name)?;
        let origin = if Some(&actor) == doc.epoch_actor().as_ref() {
            "kernel"
        } else if &actor == doc.doc().get_actor() {
            "local"
        } else {
            "peer"
        };
        Some(origin.to_string())
    }

    /// Write `{model_id: {prop: encoded_json}}` as one change. Validates every
    /// value first, so a rejected batch writes nothing. Returns whether the
    /// document changed.
    pub fn set_props_json(&mut self, patch_json: &str) -> Result<bool, JsError> {
        self.set_props_inner(patch_json)
            .map_err(|e| JsError::new(&e))
    }

    pub fn get_heads_hex(&mut self) -> Vec<String> {
        self.replica
            .doc_mut()
            .get_heads()
            .iter()
            .map(|head| head.to_string())
            .collect()
    }

    pub fn save(&mut self) -> Vec<u8> {
        self.replica.doc_mut().save()
    }
}

impl BokehSessionDocHandle {
    fn doc(&self) -> BokehSessionDocRef<'_> {
        BokehSessionDocRef::from_doc(self.replica.doc())
    }

    fn doc_mut(&mut self) -> BokehSessionDocMut<'_> {
        BokehSessionDocMut::from_doc(self.replica.doc_mut())
    }

    fn receive_frame_inner(
        &mut self,
        frame_bytes: &[u8],
    ) -> Result<BokehSessionFrameEvent, String> {
        let before = self.replica.doc_mut().get_heads();
        Ok(match self.replica.receive_frame(frame_bytes)? {
            KeyedFrameOutcome::Applied { changed, reply } => {
                let changeset = if changed {
                    let after = self.replica.doc_mut().get_heads();
                    self.doc_mut().diff(&before, &after)
                } else {
                    BokehSessionChangeset::default()
                };
                BokehSessionFrameEvent::Applied {
                    changed: !changeset.is_empty(),
                    changeset,
                    reply,
                }
            }
            KeyedFrameOutcome::Ignored { kind, id, epoch } => {
                BokehSessionFrameEvent::Ignored { kind, id, epoch }
            }
            KeyedFrameOutcome::SyncError { error, reply } => {
                BokehSessionFrameEvent::SyncError { error, reply }
            }
        })
    }

    fn set_props_inner(&mut self, patch_json: &str) -> Result<bool, String> {
        if self.read_only {
            return Err("Bokeh session is read-only".to_string());
        }
        let patch: BTreeMap<String, BTreeMap<String, String>> =
            serde_json::from_str(patch_json).map_err(|e| format!("parse props patch: {e}"))?;
        for (model_id, props) in &patch {
            for (name, value) in props {
                self.doc()
                    .check_peer_write(model_id, name, value)
                    .map_err(|e| e.to_string())?;
            }
        }
        let mut doc = self.doc_mut();
        let mut changed = false;
        for (model_id, props) in &patch {
            for (name, value) in props {
                changed |= doc
                    .set_prop(model_id, name, value)
                    .map_err(|e| e.to_string())?;
            }
        }
        doc.commit();
        Ok(changed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use automerge::sync;
    use notebook_wire::{frame_types, KeyedDocFrameHeader};
    use runtime_doc::{
        BokehModelState, BokehSessionDoc, BokehSessionIngressError, BokehSessionMeta,
        BokehSessionSnapshot, BokehSessionStatus, BokehSessionWriteContext,
        BokehSessionWriteRejection, RuntimeStateWriteScope,
    };

    fn kernel_doc() -> BokehSessionDoc {
        let mut models = BTreeMap::new();
        models.insert(
            "p1".to_string(),
            BokehModelState {
                type_name: "Slider".into(),
                ref_props: vec!["js_property_callbacks".into()],
                props: BTreeMap::from([("value".to_string(), "0.5".to_string())]),
            },
        );
        BokehSessionDoc::build(
            &BokehSessionSnapshot {
                epoch: 2,
                meta: BokehSessionMeta {
                    session_id: "s1".into(),
                    root_ids: vec!["p1".into()],
                    ..Default::default()
                },
                models,
                columns: BTreeMap::new(),
            },
            "rt:kernel:test",
        )
        .unwrap()
    }

    fn frame(header: &KeyedDocFrameHeader, msg: sync::Message) -> Vec<u8> {
        let mut bytes = vec![frame_types::KEYED_DOC_SYNC];
        bytes.extend(header.encode_frame(&msg.encode()));
        bytes
    }

    /// Sync the handle with `hub`, sending its writes through the ingress
    /// filter as the daemon will.
    fn sync_with_hub(
        handle: &mut BokehSessionDocHandle,
        hub: &mut BokehSessionDoc,
        hub_state: &mut sync::State,
    ) -> Result<(), BokehSessionIngressError> {
        let context = BokehSessionWriteContext {
            scope: RuntimeStateWriteScope::Editor,
            status: BokehSessionStatus::Connected,
            current_epoch: 2,
        };
        for _ in 0..16 {
            let mut progressed = false;
            if let Some(msg) = hub.generate_sync_message(hub_state) {
                let event = handle
                    .receive_frame_inner(&frame(&handle.replica.header().clone(), msg))
                    .unwrap();
                if let BokehSessionFrameEvent::Applied {
                    reply: Some(reply), ..
                } = event
                {
                    let (header, bytes) = KeyedDocFrameHeader::try_parse(&reply).unwrap();
                    context.check_frame_epoch(header.epoch)?;
                    hub.receive_peer_sync_message(
                        hub_state,
                        sync::Message::decode(bytes).unwrap(),
                        &context,
                    )?;
                }
                progressed = true;
            }
            if let Some(payload) = handle.flush_sync() {
                let (_, bytes) = KeyedDocFrameHeader::try_parse(&payload).unwrap();
                hub.receive_peer_sync_message(
                    hub_state,
                    sync::Message::decode(bytes).unwrap(),
                    &context,
                )?;
                progressed = true;
            }
            if !progressed {
                return Ok(());
            }
        }
        panic!("sync did not converge");
    }

    #[test]
    fn handle_syncs_routes_by_header_and_writes_allowed_props() {
        let mut hub = kernel_doc();
        let mut hub_state = sync::State::new();
        let mut handle = BokehSessionDocHandle::new("s1", 2, "user:dev:alice/browser").unwrap();
        assert!(!handle.is_synced());

        // Frames for another epoch or session are left to the host.
        for other in [
            KeyedDocFrameHeader::new(BOKEH_SESSION_KIND, "s1", 1),
            KeyedDocFrameHeader::new(BOKEH_SESSION_KIND, "s2", 2),
            KeyedDocFrameHeader::new("other_kind", "s1", 2),
        ] {
            let msg = hub.generate_sync_message(&mut sync::State::new()).unwrap();
            match handle.receive_frame_inner(&frame(&other, msg)).unwrap() {
                BokehSessionFrameEvent::Ignored { kind, id, epoch } => {
                    assert_eq!(KeyedDocFrameHeader::new(kind, id, epoch), other);
                }
                event => panic!("expected Ignored, got {event:?}"),
            }
        }
        assert!(handle.receive_frame_inner(&[0x09, 0, 0]).is_err());

        sync_with_hub(&mut handle, &mut hub, &mut hub_state).unwrap();
        assert!(handle.is_synced());
        assert_eq!(handle.get_prop("p1", "value").as_deref(), Some("0.5"));

        assert!(handle
            .set_props_inner(r#"{"p1": {"value": "0.75"}}"#)
            .unwrap());
        assert!(!handle
            .set_props_inner(r#"{"p1": {"value": "0.75"}}"#)
            .unwrap());
        sync_with_hub(&mut handle, &mut hub, &mut hub_state).unwrap();
        assert_eq!(hub.get_prop("p1", "value").as_deref(), Some("0.75"));
    }

    #[test]
    fn prop_origin_tells_kernel_corrections_from_local_and_peer_values() {
        let mut hub = kernel_doc();
        let mut hub_state = sync::State::new();
        let mut handle = BokehSessionDocHandle::new("s1", 2, "user:dev:alice/browser").unwrap();
        sync_with_hub(&mut handle, &mut hub, &mut hub_state).unwrap();
        assert_eq!(
            handle.get_prop_origin("p1", "value").as_deref(),
            Some("kernel")
        );
        assert_eq!(handle.get_prop_origin("p1", "missing"), None);

        handle.set_props_inner(r#"{"p1": {"value": "2"}}"#).unwrap();
        assert_eq!(
            handle.get_prop_origin("p1", "value").as_deref(),
            Some("local")
        );
        sync_with_hub(&mut handle, &mut hub, &mut hub_state).unwrap();

        // The kernel clamps the value back to one the browser wrote earlier.
        hub.set_prop("p1", "value", "1").unwrap();
        hub.commit();
        sync_with_hub(&mut handle, &mut hub, &mut hub_state).unwrap();
        assert_eq!(handle.get_prop("p1", "value").as_deref(), Some("1"));
        assert_eq!(
            handle.get_prop_origin("p1", "value").as_deref(),
            Some("kernel")
        );

        let mut peer = BokehSessionDoc::new_empty("user:dev:bob/browser");
        let (mut hub_to_peer, mut peer_to_hub) = (sync::State::new(), sync::State::new());
        let mut exchange = |hub: &mut BokehSessionDoc, peer: &mut BokehSessionDoc| {
            for _ in 0..8 {
                if let Some(msg) = hub.generate_sync_message(&mut hub_to_peer) {
                    peer.receive_sync_message(&mut peer_to_hub, msg).unwrap();
                }
                if let Some(msg) = peer.generate_sync_message(&mut peer_to_hub) {
                    hub.receive_sync_message(&mut hub_to_peer, msg).unwrap();
                }
            }
        };
        exchange(&mut hub, &mut peer);
        peer.set_prop("p1", "value", "3").unwrap();
        peer.commit();
        exchange(&mut hub, &mut peer);
        sync_with_hub(&mut handle, &mut hub, &mut hub_state).unwrap();
        assert_eq!(handle.get_prop("p1", "value").as_deref(), Some("3"));
        assert_eq!(
            handle.get_prop_origin("p1", "value").as_deref(),
            Some("peer")
        );
    }

    #[test]
    fn handle_refuses_writes_the_daemon_would_reject() {
        let mut hub = kernel_doc();
        let mut handle = BokehSessionDocHandle::new("s1", 2, "user:dev:alice/browser").unwrap();
        sync_with_hub(&mut handle, &mut hub, &mut sync::State::new()).unwrap();
        let heads = handle.get_heads_hex();

        let err = handle
            .set_props_inner(r#"{"p1": {"value": "1", "js_property_callbacks": "{}"}}"#)
            .unwrap_err();
        assert_eq!(
            err,
            BokehSessionWriteRejection::ReferenceProperty {
                model: "p1".into(),
                prop: "js_property_callbacks".into(),
            }
            .to_string()
        );
        assert!(handle.set_props_inner(r#"{"p9": {"value": "1"}}"#).is_err());
        assert!(handle
            .set_props_inner(r#"{"p1": {"value": "nope"}}"#)
            .is_err());
        assert_eq!(
            handle.get_heads_hex(),
            heads,
            "rejected batches write nothing"
        );

        handle.set_read_only(true);
        assert!(handle.set_props_inner(r#"{"p1": {"value": "1"}}"#).is_err());
    }

    /// Item 5 (review 2026-10-29): the pre-check refuses values the hub
    /// refuses as model references or blob refs, so the frame learns at write
    /// time instead of through a resync.
    #[test]
    fn handle_refuses_model_references_blob_refs_and_unknown_reps() {
        let mut hub = kernel_doc();
        let mut handle = BokehSessionDocHandle::new("s1", 2, "user:dev:alice/browser").unwrap();
        sync_with_hub(&mut handle, &mut hub, &mut sync::State::new()).unwrap();
        let heads = handle.get_heads_hex();
        for value in [
            r#"{"id":"p1"}"#,
            r#"{"blob":"ee","size":10,"media_type":"application/json"}"#,
            r#"{"type":"bogus"}"#,
        ] {
            let patch = serde_json::json!({"p1": {"value": value}}).to_string();
            assert!(
                handle.set_props_inner(&patch).is_err(),
                "{value} was accepted"
            );
        }
        assert_eq!(handle.get_heads_hex(), heads);
    }
}
