//! `set_bokeh_property`: write one property value of a live Bokeh/Panel
//! session, as a browser edit would.
//!
//! The write is an Automerge change to this connection's replica of the
//! session document, authored by the agent's actor. The daemon hub applies
//! the same ingress checks as for browsers (scope, actor, existing model,
//! non-reference property, connected session, current epoch), and the runtime
//! agent forwards it to Python, where callbacks run.

use std::collections::BTreeMap;
use std::time::Duration;

use notebook_sync::bokeh::{
    BokehDocHandleExt, BokehValueSource, BokehWriteError, BokehWriteReport, BokehWrittenValue,
};
use rmcp::model::{CallToolRequestParams, CallToolResult};
use rmcp::ErrorData as McpError;
use runtime_doc::BokehSessionStatus;
use runtimed_outputs::bokeh_summary::{
    bokeh_model_is_secret, resolve_bokeh_target, status_label, BokehTarget,
};
use schemars::JsonSchema;
use serde::Deserialize;

use crate::NteractMcp;

use super::{reject_unknown_args, tool_error};

const DEFAULT_WAIT_MS: u64 = 1500;
const MAX_WAIT_MS: u64 = 5000;
const SYNC_TIMEOUT: Duration = Duration::from_secs(3);
const MAX_KERNEL_CHANGES: usize = 10;

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SetBokehPropertyParams {
    /// Cell whose output holds the Bokeh/Panel session.
    pub cell_id: String,
    /// Model id from the output summary (a unique prefix works), or a
    /// widget's label, title or name.
    pub model: String,
    /// Property name, e.g. "value". Properties that hold model references
    /// (children, renderers, ...) cannot be set.
    pub property: String,
    /// New value in Bokeh's JSON encoding, e.g. 42, "abc" or [0, 10].
    pub value: serde_json::Value,
    /// Output id, when the cell displays more than one session.
    #[serde(default)]
    pub output_id: Option<String>,
    /// Milliseconds to wait for Python to correct the value (0–5000,
    /// default 1500). Accepted values are not echoed back.
    #[serde(default)]
    pub wait_ms: Option<u64>,
}

pub async fn set_bokeh_property(
    server: &NteractMcp,
    request: &CallToolRequestParams,
) -> Result<CallToolResult, McpError> {
    reject_unknown_args(
        request,
        &[
            "cell_id",
            "model",
            "property",
            "value",
            "output_id",
            "wait_ms",
        ],
    )?;
    let handle = require_handle!(server, DocumentMutation);
    let params: SetBokehPropertyParams = serde_json::from_value(serde_json::Value::Object(
        request
            .arguments
            .clone()
            .ok_or_else(|| McpError::invalid_params("Missing arguments", None))?,
    ))
    .map_err(|e| McpError::invalid_params(format!("Invalid parameters: {e}"), None))?;
    super::assert_cell_exists(&handle, &params.cell_id)?;

    if !handle.supports_bokeh_session_docs() {
        return tool_error(
            "This notebook connection does not sync Bokeh session documents, so it cannot set properties.",
        );
    }
    let state = handle
        .get_runtime_state()
        .map_err(|e| McpError::internal_error(format!("read runtime state: {e}"), None))?;
    let mut sessions: Vec<_> = state
        .bokeh_sessions
        .into_iter()
        .filter(|(_, record)| record.cell_id == params.cell_id)
        .filter(|(_, record)| {
            params
                .output_id
                .as_deref()
                .is_none_or(|id| record.output_id == id)
        })
        .collect();
    sessions.sort_by(|a, b| a.1.output_id.cmp(&b.1.output_id));
    let (session_id, record) = match sessions.len() {
        0 => {
            return tool_error(&format!(
                "Cell {} has no Bokeh/Panel session output{}.",
                params.cell_id,
                params
                    .output_id
                    .as_deref()
                    .map(|id| format!(" with output_id {id}"))
                    .unwrap_or_default()
            ))
        }
        1 => sessions.remove(0),
        _ => {
            let ids: Vec<&str> = sessions.iter().map(|(_, r)| r.output_id.as_str()).collect();
            return tool_error(&format!(
                "Cell {} displays {} Bokeh/Panel sessions; pass output_id (one of: {}).",
                params.cell_id,
                ids.len(),
                ids.join(", ")
            ));
        }
    };
    if record.status != BokehSessionStatus::Connected {
        return tool_error(&format!(
            "The Bokeh session in cell {} is {} and read-only; re-run the cell to start a new session.",
            params.cell_id,
            status_label(record.status)
        ));
    }
    let snapshot = match handle
        .await_bokeh_session(&session_id, record.epoch, SYNC_TIMEOUT)
        .await
    {
        Ok(Some(snapshot)) => snapshot,
        Ok(None) => {
            return tool_error("The Bokeh session document did not sync in time; try again.")
        }
        Err(e) => return tool_error(&format!("Bokeh session sync failed: {e}")),
    };
    let target = match resolve_bokeh_target(&snapshot, &params.model, &params.property) {
        Ok(target) => target,
        Err(message) => return tool_error(&message),
    };
    let encoded = serde_json::to_string(&params.value)
        .map_err(|e| McpError::invalid_params(format!("Invalid value: {e}"), None))?;
    let props = BTreeMap::from([(
        target.model_id.clone(),
        BTreeMap::from([(params.property.clone(), encoded.clone())]),
    )]);
    let wait_ms = params.wait_ms.unwrap_or(DEFAULT_WAIT_MS).min(MAX_WAIT_MS);
    let report = match handle
        .write_bokeh_session_props(
            &session_id,
            record.status,
            &props,
            Duration::from_millis(wait_ms),
        )
        .await
    {
        Ok(report) => report,
        Err(BokehWriteError::Rejected(rejection)) => {
            return tool_error(&format!("Refused: {rejection}."))
        }
        Err(error) => return tool_error(&error.to_string()),
    };
    if let Some(reason) = &report.rejected {
        return tool_error(&format!("The daemon refused the write: {reason}."));
    }
    let secret = |model: &str| bokeh_model_is_secret(&snapshot, model);
    let text = describe(
        &target,
        &params.property,
        &encoded,
        &report,
        wait_ms,
        &secret,
    );
    let shown = |model: &str, value: &str| {
        if secret(model) {
            serde_json::Value::String("****".into())
        } else {
            serde_json::from_str(value).unwrap_or_else(|_| value.into())
        }
    };
    let written = report
        .values
        .get(&target.model_id)
        .and_then(|values| values.get(&params.property));
    let kernel_changes: serde_json::Map<String, serde_json::Value> = report
        .kernel_changes
        .iter()
        .flat_map(|(model, values)| {
            values
                .iter()
                .map(move |(prop, value)| (format!("{model}.{prop}"), shown(model, value)))
        })
        .take(MAX_KERNEL_CHANGES)
        .collect();
    let source = written.map(|w| w.source);
    let mut result = CallToolResult::success(vec![crate::formatting::assistant_text(text)]);
    result.structured_content = Some(serde_json::json!({
        "session_id": session_id,
        "output_id": record.output_id,
        "model": target.model_id,
        "kind": target.kind,
        "property": params.property,
        "requested": shown(&target.model_id, &encoded),
        "value": written.and_then(|w| w.value.as_deref()).map(|v| shown(&target.model_id, v)),
        "set_by": source.map(source_label),
        "corrected": written.is_some_and(|w| is_correction(w, &encoded)),
        "confirmed_by_python": source == Some(BokehValueSource::Kernel),
        "changed": report.changed,
        "acknowledged": report.acknowledged,
        "replaced_epoch": report.replaced_epoch,
        "kernel_changes_observed": kernel_changes,
    }));
    Ok(result)
}

fn source_label(source: BokehValueSource) -> &'static str {
    match source {
        BokehValueSource::Requested => "request",
        BokehValueSource::Kernel => "python",
        BokehValueSource::OtherClient => "other_client",
        BokehValueSource::Lost => "lost",
    }
}

fn is_correction(written: &BokehWrittenValue, requested: &str) -> bool {
    written.source == BokehValueSource::Kernel && written.value.as_deref() != Some(requested)
}

fn describe(
    target: &BokehTarget,
    property: &str,
    requested: &str,
    report: &BokehWriteReport,
    wait_ms: u64,
    secret: &dyn Fn(&str) -> bool,
) -> String {
    let show = |model: &str, value: &str| {
        if secret(model) {
            "****".to_string()
        } else if value.chars().count() > 200 {
            format!("{}\u{2026}", value.chars().take(199).collect::<String>())
        } else {
            value.to_string()
        }
    };
    let name = match &target.label {
        Some(label) => format!("{} {label:?} ({}.{property})", target.kind, target.model_id),
        None => format!("{} {}.{property}", target.kind, target.model_id),
    };
    let written = report
        .values
        .get(&target.model_id)
        .and_then(|values| values.get(property));
    let now = written
        .and_then(|w| w.value.as_deref())
        .map(|value| show(&target.model_id, value))
        .unwrap_or_else(|| "(unset)".into());
    let shown_request = show(&target.model_id, requested);
    let source = written.map(|w| w.source);
    let lost = source == Some(BokehValueSource::Lost);
    let mut lines = vec![if !report.changed {
        format!("{name} already equals {shown_request}; nothing was sent, so no callbacks ran.")
    } else if let Some(epoch) = report.replaced_epoch {
        if lost {
            format!(
                "The write {name} = {shown_request} was lost: the session document was replaced (epoch {epoch}) before the write reached Python, and the new document has {now}. Set it again to retry."
            )
        } else {
            format!(
                "The session document was replaced (epoch {epoch}) while waiting; the new document holds {name} = {shown_request}, but Python has not confirmed it."
            )
        }
    } else {
        match source {
            Some(BokehValueSource::Kernel) if written.is_some_and(|w| is_correction(w, requested)) => {
                format!("Python corrected {name}: requested {shown_request}, now {now}.")
            }
            Some(BokehValueSource::Kernel) => {
                format!("Python applied {name} = {shown_request}.")
            }
            Some(BokehValueSource::OtherClient) => format!(
                "Another client set {name} to {now} after this write (requested {shown_request})."
            ),
            _ if report.acknowledged => format!(
                "Set {name} = {shown_request}: accepted by the daemon; not yet confirmed by Python. Python only sends a value back to correct it, and none arrived within {wait_ms} ms; a busy kernel applies the write and runs callbacks once it is idle."
            ),
            _ => format!(
                "Submitted {name} = {shown_request}; the daemon had not confirmed it within {wait_ms} ms."
            ),
        }
    }];
    if !report.kernel_changes.is_empty() {
        lines.push(
            "Kernel changes observed while waiting (callback results or unrelated updates):".into(),
        );
        let changes: Vec<String> = report
            .kernel_changes
            .iter()
            .flat_map(|(model, values)| {
                values
                    .iter()
                    .map(move |(prop, value)| format!("  {model}.{prop} = {}", show(model, value)))
            })
            .collect();
        let total = changes.len();
        lines.extend(changes.into_iter().take(MAX_KERNEL_CHANGES));
        if total > MAX_KERNEL_CHANGES {
            lines.push(format!("  \u{2026} {} more", total - MAX_KERNEL_CHANGES));
        }
    }
    if report.changed && !lost {
        lines.push("Callback output and errors are appended to the cell's outputs.".into());
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    //! End to end over a fake room: notebook-sync's replica and sync task,
    //! and a hub that applies the real ingress filter, refuses with
    //! `BokehSessionResync`, and plays the kernel (clamping and callbacks).

    use std::sync::{Arc, Mutex};

    use automerge::sync::{Message, State};
    use automerge::ActorId;
    use notebook_protocol::connection::{
        FrameSink, FrameSource, KeyedDocFrameHeader, NotebookFrameType, TypedNotebookFrame,
    };
    use notebook_protocol::protocol::{
        InitialLoadPhaseWire, NotebookDocPhaseWire, RuntimeStatePhaseWire, SessionControlMessage,
        SessionSyncStatusWire,
    };
    use rmcp::model::{CallToolRequestParams, CallToolResult};
    use runtime_doc::{
        BokehModelState, BokehSessionDoc, BokehSessionIngressError, BokehSessionMeta,
        BokehSessionSnapshot, BokehSessionState, BokehSessionStatus, BokehSessionWriteContext,
        RuntimeStateDoc, RuntimeStateWriteScope, BOKEH_SESSION_MIME,
    };
    use tokio::sync::mpsc;

    use notebook_sync::bokeh::BOKEH_SESSION_KIND;

    use crate::session::NotebookSession;
    use crate::NteractMcp;

    const AGENT: &str = "agent:bokeh-test";
    const KERNEL: &str = "rt:kernel:test";
    const SESSION: &str = "session-1";

    fn model(type_name: &str, ref_props: &[&str], props: &[(&str, &str)]) -> BokehModelState {
        BokehModelState {
            type_name: type_name.into(),
            ref_props: ref_props.iter().map(|p| p.to_string()).collect(),
            props: props
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
        }
    }

    fn snapshot() -> BokehSessionSnapshot {
        BokehSessionSnapshot {
            epoch: 0,
            meta: BokehSessionMeta {
                session_id: SESSION.into(),
                producer_name: "panel".into(),
                producer_version: "1.9.4".into(),
                bokeh_version: "3.9.2".into(),
                root_ids: vec!["p1".into()],
                title: None,
                doc_extras: None,
            },
            models: [
                (
                    "p1",
                    model(
                        "Column",
                        &["children"],
                        &[("children", r#"[{"id":"p2"},{"id":"p3"},{"id":"p4"}]"#)],
                    ),
                ),
                (
                    "p2",
                    model(
                        "Slider",
                        &[],
                        &[
                            ("title", r#""Alpha""#),
                            ("value", "0.5"),
                            ("start", "0"),
                            ("end", "1"),
                        ],
                    ),
                ),
                (
                    "p3",
                    model("PasswordInput", &[], &[("title", r#""Secret""#)]),
                ),
                ("p4", model("Div", &[], &[("text", r#""value is 0.5""#)])),
            ]
            .into_iter()
            .map(|(id, model)| (id.to_string(), model))
            .collect(),
            columns: Default::default(),
        }
    }

    const BROWSER: &str = "user:dev:browser/tab";

    /// How the room's other writers react to an agent write of `p2.value`.
    #[derive(Clone, Copy, PartialEq, Eq)]
    enum Kernel {
        /// Python clamps and runs the callback that updates `p4.text`.
        Callbacks,
        /// Python is busy in a cell and has not applied the write yet.
        Busy,
        /// Python is busy; a browser overwrites the value and another prop.
        Browser,
    }

    struct Room {
        runtime: RuntimeStateDoc,
        runtime_sync: State,
        hub: BokehSessionDoc,
        hub_sync: State,
        scope: RuntimeStateWriteScope,
        kernel: Kernel,
        tx: mpsc::UnboundedSender<TypedNotebookFrame>,
    }

    impl Room {
        fn send(&self, frame_type: NotebookFrameType, payload: Vec<u8>) {
            self.tx
                .send(TypedNotebookFrame {
                    frame_type,
                    payload,
                })
                .unwrap();
        }

        fn push_runtime(&mut self) {
            if let Some(message) = self.runtime.generate_sync_message(&mut self.runtime_sync) {
                self.send(NotebookFrameType::RuntimeStateSync, message.encode());
            }
        }

        fn push_hub(&mut self) {
            if let Some(message) = self.hub.generate_sync_message(&mut self.hub_sync) {
                let payload = KeyedDocFrameHeader::new(BOKEH_SESSION_KIND, SESSION, 0)
                    .encode_frame(&message.encode());
                self.send(NotebookFrameType::KeyedDocSync, payload);
            }
        }

        fn context(&self) -> BokehSessionWriteContext {
            BokehSessionWriteContext {
                scope: self.scope,
                status: BokehSessionStatus::Connected,
                current_epoch: 0,
            }
        }

        fn on_bokeh_frame(&mut self, payload: &[u8]) {
            let (header, body) = KeyedDocFrameHeader::try_parse(payload).unwrap();
            assert_eq!(header.kind, BOKEH_SESSION_KIND);
            if header.id != SESSION {
                // Other sessions' documents never arrive.
                return;
            }
            let message = Message::decode(body).unwrap();
            let context = self.context();
            let agent = ActorId::from(AGENT.as_bytes());
            match self.hub.receive_peer_sync_message_checked(
                &mut self.hub_sync,
                message,
                &context,
                |actor| *actor == agent,
            ) {
                Ok(changeset) => {
                    if changeset
                        .props_changed
                        .get("p2")
                        .is_some_and(|props| props.contains("value"))
                    {
                        match self.kernel {
                            Kernel::Callbacks => self.run_kernel(),
                            Kernel::Busy => {}
                            Kernel::Browser => {
                                self.hub.set_actor(BROWSER);
                                self.hub.set_prop("p2", "value", "0.8").unwrap();
                                self.hub.set_prop("p4", "text", r#""browser""#).unwrap();
                                self.hub.commit();
                                self.hub.set_actor(KERNEL);
                            }
                        }
                    }
                    self.push_hub();
                }
                Err(BokehSessionIngressError::Rejected(rejection)) => {
                    self.hub_sync = State::new();
                    let resync = SessionControlMessage::DocResync {
                        kind: BOKEH_SESSION_KIND.into(),
                        id: SESSION.into(),
                        epoch: 0,
                        reason: rejection.to_string(),
                    };
                    self.send(
                        NotebookFrameType::SessionControl,
                        serde_json::to_vec(&resync).unwrap(),
                    );
                }
                Err(error) => panic!("hub sync failed: {error}"),
            }
        }

        /// Python's side: clamp to the slider's bounds and run a callback.
        fn run_kernel(&mut self) {
            let value: f64 = self.hub.get_prop("p2", "value").unwrap().parse().unwrap();
            let kept = value.clamp(0.0, 1.0);
            if kept != value {
                self.hub.set_prop("p2", "value", &kept.to_string()).unwrap();
            }
            self.hub
                .set_prop("p4", "text", &format!("\"value is {kept}\""))
                .unwrap();
            self.hub.commit();
        }
    }

    struct Frames(mpsc::UnboundedReceiver<TypedNotebookFrame>);
    impl FrameSource for Frames {
        async fn recv_frame(&mut self) -> Option<std::io::Result<TypedNotebookFrame>> {
            self.0.recv().await.map(Ok)
        }
    }

    struct Sink(Arc<Mutex<Room>>);
    impl FrameSink for Sink {
        async fn send_frame(
            &mut self,
            frame_type: NotebookFrameType,
            payload: &[u8],
        ) -> std::io::Result<()> {
            let mut room = self.0.lock().unwrap();
            match frame_type {
                NotebookFrameType::RuntimeStateSync => {
                    let Room {
                        runtime,
                        runtime_sync,
                        ..
                    } = &mut *room;
                    runtime
                        .receive_sync_message(runtime_sync, Message::decode(payload).unwrap())
                        .unwrap();
                    room.push_runtime();
                }
                NotebookFrameType::KeyedDocSync => room.on_bokeh_frame(payload),
                _ => {}
            }
            Ok(())
        }
    }

    fn record(status: BokehSessionStatus) -> BokehSessionState {
        record_for("out-1", status)
    }

    fn record_for(output_id: &str, status: BokehSessionStatus) -> BokehSessionState {
        BokehSessionState {
            output_id: output_id.into(),
            cell_id: "cell-1".into(),
            execution_id: "exec-1".into(),
            kernel_id: "kernel-1".into(),
            status,
            producer_name: "panel".into(),
            producer_version: "1.9.4".into(),
            bokeh_version: "3.9.2".into(),
            root_ids: vec!["p1".into()],
            epoch: 0,
            doc_heads: Vec::new(),
            previous_heads: Vec::new(),
        }
    }

    struct Fixture {
        server: NteractMcp,
        handle: notebook_sync::DocHandle,
        notebook_handle: String,
        room: Arc<Mutex<Room>>,
    }

    impl Fixture {
        async fn new() -> Self {
            let (tx, rx) = mpsc::unbounded_channel();
            let mut runtime = RuntimeStateDoc::new_with_actor("runtimed");
            runtime
                .put_bokeh_session(SESSION, &record(BokehSessionStatus::Connected))
                .unwrap();
            let room = Arc::new(Mutex::new(Room {
                runtime,
                runtime_sync: State::new(),
                hub: BokehSessionDoc::build(&snapshot(), KERNEL).unwrap(),
                hub_sync: State::new(),
                scope: RuntimeStateWriteScope::Editor,
                kernel: Kernel::Callbacks,
                tx,
            }));
            let handle = notebook_sync::connect::connect_frame_io(
                "bokeh-test".into(),
                AGENT,
                Frames(rx),
                Sink(room.clone()),
            )
            .await
            .unwrap()
            .handle
            .with_keyed_doc_kinds(vec![BOKEH_SESSION_KIND.into()]);
            handle
                .add_cell_with_source("cell-1", "code", None, "pn.Column(...)")
                .unwrap();
            {
                let mut room = room.lock().unwrap();
                room.push_runtime();
                let status = SessionControlMessage::SyncStatus(SessionSyncStatusWire {
                    notebook_doc: NotebookDocPhaseWire::Interactive,
                    runtime_state: RuntimeStatePhaseWire::Ready,
                    initial_load: InitialLoadPhaseWire::NotNeeded,
                });
                room.send(
                    NotebookFrameType::SessionControl,
                    serde_json::to_vec(&status).unwrap(),
                );
            }
            handle
                .await_session_ready_timeout(std::time::Duration::from_secs(1))
                .await
                .unwrap();
            let fixture_handle = handle.clone();
            tokio::time::timeout(std::time::Duration::from_secs(1), async {
                let mut updates = fixture_handle.subscribe_runtime_state();
                while !fixture_handle
                    .get_runtime_state()
                    .unwrap()
                    .bokeh_sessions
                    .contains_key(SESSION)
                {
                    updates.changed().await.unwrap();
                }
            })
            .await
            .unwrap();
            let session = NotebookSession::local(handle.clone(), "bokeh-test".into(), None, None);
            let server = NteractMcp::new("unused.sock".into(), None, None);
            let notebook_handle = session.notebook_handle.clone();
            server
                .attachments
                .insert(session, server.attachments.reserve().unwrap());
            Self {
                server,
                handle,
                notebook_handle,
                room,
            }
        }

        async fn set(
            &self,
            model: &str,
            property: &str,
            value: serde_json::Value,
        ) -> CallToolResult {
            let mut request = CallToolRequestParams::new("set_bokeh_property");
            request.arguments = serde_json::json!({
                "notebook_handle": self.notebook_handle,
                "cell_id": "cell-1",
                "model": model,
                "property": property,
                "value": value,
                "wait_ms": 300,
            })
            .as_object()
            .cloned();
            crate::targets::dispatch(&self.server, &request)
                .await
                .unwrap()
        }

        /// Announce another session whose document the room never sends.
        async fn add_session(&self, session_id: &str, output_id: &str, status: BokehSessionStatus) {
            {
                let mut room = self.room.lock().unwrap();
                room.runtime
                    .put_bokeh_session(session_id, &record_for(output_id, status))
                    .unwrap();
                room.push_runtime();
            }
            tokio::time::timeout(std::time::Duration::from_secs(1), async {
                let mut updates = self.handle.subscribe_runtime_state();
                while !self
                    .handle
                    .get_runtime_state()
                    .unwrap()
                    .bokeh_sessions
                    .contains_key(session_id)
                {
                    updates.changed().await.unwrap();
                }
            })
            .await
            .unwrap();
        }

        fn hub_prop(&self, model: &str, prop: &str) -> Option<String> {
            self.room.lock().unwrap().hub.get_prop(model, prop)
        }
    }

    fn manifest(output_id: &str) -> serde_json::Value {
        serde_json::json!({
            "output_type": "display_data",
            "output_id": output_id,
            "data": {BOKEH_SESSION_MIME: {"inline": "{}"}},
        })
    }

    fn text(result: &CallToolResult) -> String {
        result
            .content
            .iter()
            .filter_map(|content| content.as_text().map(|text| text.text.clone()))
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[tokio::test]
    async fn set_bokeh_property_writes_as_the_agent_and_reports_python_results() {
        let fixture = Fixture::new().await;

        // Accepted: the hub merges the agent's change and the callback runs.
        let result = fixture.set("Alpha", "value", serde_json::json!(0.25)).await;
        let message = text(&result);
        assert_eq!(result.is_error, Some(false), "{message}");
        assert!(
            message.contains("Set Slider \"Alpha\" (p2.value) = 0.25: accepted"),
            "{message}"
        );
        assert!(
            message.contains("accepted by the daemon; not yet confirmed by Python"),
            "{message}"
        );
        assert!(message.contains("p4.text = \"value is 0.25\""), "{message}");
        let data = result.structured_content.as_ref().unwrap();
        assert_eq!(data["acknowledged"], true);
        assert_eq!(data["corrected"], false);
        assert_eq!(fixture.hub_prop("p2", "value").as_deref(), Some("0.25"));

        // Corrected: the kernel clamps and the tool reports the final value.
        let result = fixture.set("p2", "value", serde_json::json!(5)).await;
        let message = text(&result);
        assert!(
            message.contains("Python corrected Slider \"Alpha\" (p2.value): requested 5, now 1."),
            "{message}"
        );
        assert_eq!(result.structured_content.as_ref().unwrap()["value"], 1.0);

        // The live summary reads the replica, including the correction.
        let manifest = serde_json::json!({
            "output_type": "display_data",
            "output_id": "out-1",
            "data": {BOKEH_SESSION_MIME: {"inline": "{}"}},
        });
        let views = crate::live_views::collect(
            &fixture.handle,
            std::slice::from_ref(&manifest),
            None,
            None,
        )
        .await;
        let summary = views["out-1"].summarize().unwrap();
        assert!(
            summary.contains("p2 Slider \"Alpha\": value=1"),
            "{summary}"
        );
        assert!(
            summary.contains("p3 PasswordInput \"Secret\": value=****"),
            "{summary}"
        );

        // Rejected locally with the hub's own rules.
        let result = fixture.set("p1", "children", serde_json::json!([])).await;
        assert_eq!(result.is_error, Some(true));
        assert!(text(&result).contains("reference"), "{}", text(&result));
        let result = fixture.set("p99", "value", serde_json::json!(1)).await;
        assert_eq!(result.is_error, Some(true));
        assert!(
            text(&result).contains("no model or widget named"),
            "{}",
            text(&result)
        );

        // Viewer scope: only the daemon knows it; its refusal is reported.
        fixture.room.lock().unwrap().scope = RuntimeStateWriteScope::Viewer;
        let result = fixture.set("p2", "value", serde_json::json!(0.75)).await;
        let message = text(&result);
        assert_eq!(result.is_error, Some(true), "{message}");
        assert!(
            message.contains("The daemon refused the write"),
            "{message}"
        );
        assert!(message.contains("viewer"), "{message}");
        assert_eq!(fixture.hub_prop("p2", "value").as_deref(), Some("1"));
        fixture.room.lock().unwrap().scope = RuntimeStateWriteScope::Editor;

        // Disconnected sessions are read-only.
        {
            let mut room = fixture.room.lock().unwrap();
            room.runtime
                .put_bokeh_session(SESSION, &record(BokehSessionStatus::Disconnected))
                .unwrap();
            room.push_runtime();
        }
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            let mut updates = fixture.handle.subscribe_runtime_state();
            while fixture.handle.get_runtime_state().unwrap().bokeh_sessions[SESSION].status
                != BokehSessionStatus::Disconnected
            {
                updates.changed().await.unwrap();
            }
        })
        .await
        .unwrap();
        let result = fixture.set("p2", "value", serde_json::json!(0.1)).await;
        assert_eq!(result.is_error, Some(true));
        assert!(
            text(&result).contains("is disconnected and read-only"),
            "{}",
            text(&result)
        );
    }

    #[tokio::test]
    async fn an_unapplied_write_is_not_reported_as_kept_by_python() {
        let fixture = Fixture::new().await;
        fixture.room.lock().unwrap().kernel = Kernel::Busy;
        let result = fixture.set("Alpha", "value", serde_json::json!(0.25)).await;
        let message = text(&result);
        assert_eq!(result.is_error, Some(false), "{message}");
        assert!(!message.contains("Python kept"), "{message}");
        assert!(
            message.contains("accepted by the daemon; not yet confirmed by Python"),
            "{message}"
        );
    }

    #[tokio::test]
    async fn another_clients_write_is_not_a_python_correction() {
        let fixture = Fixture::new().await;
        fixture.room.lock().unwrap().kernel = Kernel::Browser;
        let result = fixture.set("Alpha", "value", serde_json::json!(0.25)).await;
        let message = text(&result);
        assert!(!message.contains("Python corrected"), "{message}");
        assert!(message.contains("Another client"), "{message}");
        assert!(!message.contains("p4.text"), "{message}");
        assert_eq!(
            result.structured_content.as_ref().unwrap()["corrected"],
            false
        );
    }

    #[tokio::test]
    async fn kernel_changes_during_the_wait_are_not_called_callback_effects() {
        let fixture = Fixture::new().await;
        let result = fixture.set("Alpha", "value", serde_json::json!(0.25)).await;
        let message = text(&result);
        assert!(!message.contains("Callbacks also changed"), "{message}");
        assert!(message.contains("observed while waiting"), "{message}");
        assert!(message.contains("p4.text = \"value is 0.25\""), "{message}");
    }

    #[tokio::test]
    async fn summaries_wait_for_connected_sessions_under_one_deadline() {
        let fixture = Fixture::new().await;
        for (session, output) in [("session-2", "out-2"), ("session-3", "out-3")] {
            fixture
                .add_session(session, output, BokehSessionStatus::Connected)
                .await;
        }
        let manifests: Vec<_> = ["out-1", "out-2", "out-3"].map(manifest).into();
        let started = std::time::Instant::now();
        let views = crate::live_views::collect(&fixture.handle, &manifests, None, None).await;
        let elapsed = started.elapsed();
        assert!(
            elapsed < std::time::Duration::from_millis(2500),
            "two unsynced sessions took {elapsed:?}"
        );
        assert_eq!(views.len(), 3);
        let summary = views["out-1"].summarize().unwrap();
        assert!(summary.contains("p2 Slider \"Alpha\""), "{summary}");
    }

    #[tokio::test]
    async fn summaries_of_ended_sessions_use_the_saved_document_without_waiting() {
        let fixture = Fixture::new().await;
        fixture
            .add_session("session-4", "out-4", BokehSessionStatus::Disconnected)
            .await;
        fixture
            .add_session("session-5", "out-5", BokehSessionStatus::Closed)
            .await;
        let manifests: Vec<_> = ["out-4", "out-5"].map(manifest).into();
        let started = std::time::Instant::now();
        let views = crate::live_views::collect(&fixture.handle, &manifests, None, None).await;
        let elapsed = started.elapsed();
        assert!(
            elapsed < std::time::Duration::from_millis(150),
            "ended sessions took {elapsed:?}"
        );
        assert_eq!(views.len(), 2);
        assert!(views["out-4"].summarize().is_none());
    }

    #[test]
    fn a_replacement_reports_the_write_lost_unless_the_new_epoch_kept_it() {
        use notebook_sync::bokeh::{BokehValueSource, BokehWriteReport, BokehWrittenValue};
        use runtimed_outputs::bokeh_summary::BokehTarget;

        let target = BokehTarget {
            model_id: "p2".into(),
            kind: "Slider".into(),
            label: Some("Alpha".into()),
            secret: false,
        };
        let report = |value: &str, source| BokehWriteReport {
            changed: true,
            acknowledged: true,
            replaced_epoch: Some(3),
            values: [(
                "p2".to_string(),
                [(
                    "value".to_string(),
                    BokehWrittenValue {
                        value: Some(value.into()),
                        source,
                    },
                )]
                .into(),
            )]
            .into(),
            ..Default::default()
        };
        let lost = super::describe(
            &target,
            "value",
            "0.25",
            &report("0.5", BokehValueSource::Lost),
            300,
            &|_| false,
        );
        assert!(
            lost.starts_with("The write Slider \"Alpha\" (p2.value) = 0.25 was lost"),
            "{lost}"
        );
        assert!(
            lost.contains("epoch 3") && lost.contains("has 0.5"),
            "{lost}"
        );
        assert!(!lost.contains("Callback output"), "{lost}");
        let kept = super::describe(
            &target,
            "value",
            "0.25",
            &report("0.25", BokehValueSource::Requested),
            300,
            &|_| false,
        );
        assert!(
            kept.contains(
                "holds Slider \"Alpha\" (p2.value) = 0.25, but Python has not confirmed it"
            ),
            "{kept}"
        );
    }
}
