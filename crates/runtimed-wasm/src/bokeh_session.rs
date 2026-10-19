//! Browser replica of one Bokeh session document.
//!
//! The host keeps one handle per (session, epoch) and routes `0x0b` frames to
//! it by header. Writes are limited to what the daemon's ingress filter
//! accepts, so an honest client never has a change rejected; disconnected
//! sessions are made read-only by the host.

use std::collections::BTreeMap;

use automerge::sync;
use notebook_wire::{frame_types, BokehSessionFrameHeader};
use runtime_doc::{BokehSessionChangeset, BokehSessionDoc};
use serde::Serialize;
use wasm_bindgen::prelude::*;

use crate::serialize_to_js;

#[wasm_bindgen]
pub struct BokehSessionDocHandle {
    header: BokehSessionFrameHeader,
    doc: BokehSessionDoc,
    sync_state: sync::State,
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
    /// The frame belongs to another session or epoch.
    Ignored { session_id: String, epoch: u64 },
    /// Receive failed; sync state was reset and `reply` restarts negotiation.
    SyncError {
        error: String,
        reply: Option<Vec<u8>>,
    },
}

fn split_frame(frame_bytes: &[u8]) -> Result<(BokehSessionFrameHeader, &[u8]), String> {
    match frame_bytes.split_first() {
        Some((&frame_types::BOKEH_SESSION_DOC_SYNC, payload)) => {
            BokehSessionFrameHeader::try_parse(payload).map_err(|e| e.to_string())
        }
        _ => Err("expected a BokehSessionDocSync (0x0b) frame".to_string()),
    }
}

/// Read the routing header of a typed `0x0b` frame.
#[wasm_bindgen]
pub fn bokeh_session_frame_header(frame_bytes: &[u8]) -> Result<JsValue, JsError> {
    let (header, _) = split_frame(frame_bytes).map_err(|e| JsError::new(&e))?;
    serialize_to_js(&header).map_err(|e| JsError::new(&e.to_string()))
}

#[wasm_bindgen]
impl BokehSessionDocHandle {
    /// An empty replica for `session_id` at `epoch`, filled in by sync.
    #[wasm_bindgen(constructor)]
    pub fn new(session_id: &str, epoch: u32, actor_label: &str) -> BokehSessionDocHandle {
        BokehSessionDocHandle {
            header: BokehSessionFrameHeader::new(session_id, epoch.into()),
            doc: BokehSessionDoc::new_empty(actor_label),
            sync_state: sync::State::new(),
            read_only: false,
        }
    }

    #[wasm_bindgen(getter)]
    pub fn session_id(&self) -> String {
        self.header.session_id.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn epoch(&self) -> u32 {
        u32::try_from(self.header.epoch).unwrap_or(u32::MAX)
    }

    /// Whether the epoch's document has arrived.
    pub fn is_synced(&self) -> bool {
        self.doc.epoch().is_some()
    }

    pub fn set_read_only(&mut self, read_only: bool) {
        self.read_only = read_only;
    }

    pub fn is_read_only(&self) -> bool {
        self.read_only
    }

    pub fn receive_frame(&mut self, frame_bytes: &[u8]) -> Result<JsValue, JsError> {
        let event = self
            .receive_frame_inner(frame_bytes)
            .map_err(|e| JsError::new(&e))?;
        serialize_to_js(&event).map_err(|e| JsError::new(&e.to_string()))
    }

    /// Header-framed sync payload for local changes, if any.
    pub fn flush_sync(&mut self) -> Option<Vec<u8>> {
        self.generate_framed_sync_message()
    }

    pub fn cancel_last_flush(&mut self) {
        self.sync_state.in_flight = false;
        self.sync_state.sent_hashes.clear();
    }

    /// The materialized session, or `null` before the document arrives.
    pub fn snapshot(&self) -> JsValue {
        match self.doc.read_snapshot() {
            Ok(snapshot) => serialize_to_js(&snapshot).unwrap_or(JsValue::NULL),
            Err(_) => JsValue::NULL,
        }
    }

    pub fn get_model(&self, model_id: &str) -> JsValue {
        match self.doc.read_model(model_id) {
            Some(model) => serialize_to_js(&model).unwrap_or(JsValue::NULL),
            None => JsValue::NULL,
        }
    }

    pub fn get_prop(&self, model_id: &str, name: &str) -> Option<String> {
        self.doc.get_prop(model_id, name)
    }

    /// Write `{model_id: {prop: encoded_json}}` as one change. Validates every
    /// value first, so a rejected batch writes nothing. Returns whether the
    /// document changed.
    pub fn set_props_json(&mut self, patch_json: &str) -> Result<bool, JsError> {
        self.set_props_inner(patch_json)
            .map_err(|e| JsError::new(&e))
    }

    pub fn get_heads_hex(&mut self) -> Vec<String> {
        self.doc
            .get_heads()
            .iter()
            .map(|head| head.to_string())
            .collect()
    }

    pub fn save(&mut self) -> Vec<u8> {
        self.doc.save()
    }
}

impl BokehSessionDocHandle {
    fn generate_framed_sync_message(&mut self) -> Option<Vec<u8>> {
        self.doc
            .generate_sync_message(&mut self.sync_state)
            .map(|msg| self.header.encode_frame(&msg.encode()))
    }

    fn receive_frame_inner(
        &mut self,
        frame_bytes: &[u8],
    ) -> Result<BokehSessionFrameEvent, String> {
        let (header, sync_bytes) = split_frame(frame_bytes)?;
        if header != self.header {
            return Ok(BokehSessionFrameEvent::Ignored {
                session_id: header.session_id,
                epoch: header.epoch,
            });
        }
        let message = sync::Message::decode(sync_bytes)
            .map_err(|e| format!("decode Bokeh session sync: {e}"))?;
        match self.doc.receive_sync_message(&mut self.sync_state, message) {
            Ok(changeset) => Ok(BokehSessionFrameEvent::Applied {
                changed: !changeset.is_empty(),
                changeset,
                reply: self.generate_framed_sync_message(),
            }),
            Err(error) => {
                self.sync_state = sync::State::new();
                Ok(BokehSessionFrameEvent::SyncError {
                    error: error.to_string(),
                    reply: self.generate_framed_sync_message(),
                })
            }
        }
    }

    fn set_props_inner(&mut self, patch_json: &str) -> Result<bool, String> {
        if self.read_only {
            return Err("Bokeh session is read-only".to_string());
        }
        let patch: BTreeMap<String, BTreeMap<String, String>> =
            serde_json::from_str(patch_json).map_err(|e| format!("parse props patch: {e}"))?;
        for (model_id, props) in &patch {
            for (name, value) in props {
                self.doc
                    .check_peer_write(model_id, name, value)
                    .map_err(|e| e.to_string())?;
            }
        }
        let mut changed = false;
        for (model_id, props) in &patch {
            for (name, value) in props {
                changed |= self
                    .doc
                    .set_prop(model_id, name, value)
                    .map_err(|e| e.to_string())?;
            }
        }
        self.doc.commit();
        Ok(changed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use runtime_doc::{
        BokehModelState, BokehSessionIngressError, BokehSessionMeta, BokehSessionSnapshot,
        BokehSessionStatus, BokehSessionWriteContext, BokehSessionWriteRejection,
        RuntimeStateWriteScope,
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

    fn frame(header: &BokehSessionFrameHeader, msg: sync::Message) -> Vec<u8> {
        let mut bytes = vec![frame_types::BOKEH_SESSION_DOC_SYNC];
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
                    .receive_frame_inner(&frame(&handle.header.clone(), msg))
                    .unwrap();
                if let BokehSessionFrameEvent::Applied {
                    reply: Some(reply), ..
                } = event
                {
                    let (header, bytes) = BokehSessionFrameHeader::try_parse(&reply).unwrap();
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
                let (_, bytes) = BokehSessionFrameHeader::try_parse(&payload).unwrap();
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
        let mut handle = BokehSessionDocHandle::new("s1", 2, "user:dev:alice/browser");
        assert!(!handle.is_synced());

        // Frames for another epoch or session are left to the host.
        let other = BokehSessionFrameHeader::new("s1", 1);
        let msg = hub.generate_sync_message(&mut sync::State::new()).unwrap();
        assert!(matches!(
            handle.receive_frame_inner(&frame(&other, msg)).unwrap(),
            BokehSessionFrameEvent::Ignored { epoch: 1, .. }
        ));
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
    fn handle_refuses_writes_the_daemon_would_reject() {
        let mut hub = kernel_doc();
        let mut handle = BokehSessionDocHandle::new("s1", 2, "user:dev:alice/browser");
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
}
