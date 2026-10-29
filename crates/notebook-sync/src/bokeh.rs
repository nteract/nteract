//! Bokeh session documents over the keyed document replicas (frame `0x0b`).
//!
//! A session is the keyed document `("bokeh_session", session_id)`. A client
//! subscribes by opening the replica at the epoch RuntimeStateDoc announces;
//! the daemon then pushes later changes. Writes are property values only and
//! are checked with the daemon hub's own rules before they are sent. The hub
//! stays the authority: a refused write comes back as `DocResync`, which
//! restarts the replica without it.

use std::collections::BTreeMap;
use std::future::Future;
use std::time::Duration;

use automerge::{ActorId, ChangeHash};
use runtime_doc::{
    BokehSessionDocMut, BokehSessionDocRef, BokehSessionSnapshot, BokehSessionStatus,
    BokehSessionWriteContext, BokehSessionWriteRejection, RuntimeStateWriteScope,
};
use tokio::sync::broadcast;

use crate::error::SyncError;
use crate::handle::DocHandle;
use crate::keyed_doc::KeyedDocEvent;

/// Keyed document kind of Bokeh session documents.
pub const BOKEH_SESSION_KIND: &str = "bokeh_session";

const ACK_POLL_INTERVAL: Duration = Duration::from_millis(20);

/// Who set a written property's value as of the end of the wait.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BokehValueSource {
    /// Still this write's value. Python echoes only corrections, so this
    /// does not show that Python applied it.
    Requested,
    /// The session's kernel set it after the write, normally Python
    /// correcting it.
    Kernel,
    /// Another client set it after the write.
    OtherClient,
    /// The document was replaced (new epoch) without the write.
    Lost,
}

/// The value a written property has after the write.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BokehWrittenValue {
    pub value: Option<String>,
    pub source: BokehValueSource,
}

/// What became of a property write within the wait window.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BokehWriteReport {
    /// False when every value was already current, so nothing was sent.
    pub changed: bool,
    /// The daemon merged the write into the epoch it was written for.
    pub acknowledged: bool,
    /// The daemon refused the write; the replica restarted without it.
    pub rejected: Option<String>,
    /// The producer replaced the document during the wait. The new epoch
    /// keeps the write only if it reached the runtime agent first; `values`
    /// read the new document.
    pub replaced_epoch: Option<u64>,
    pub values: BTreeMap<String, BTreeMap<String, BokehWrittenValue>>,
    /// Other properties the kernel changed while waiting. Callback results
    /// and unrelated kernel updates (periodic callbacks, running cells) look
    /// the same here.
    pub kernel_changes: BTreeMap<String, BTreeMap<String, String>>,
}

#[derive(Debug, thiserror::Error)]
pub enum BokehWriteError {
    #[error("this daemon connection does not sync Bokeh session documents")]
    Unsupported,
    #[error("Bokeh session {0} has not synced its document yet")]
    NotSynced(String),
    #[error(transparent)]
    Rejected(#[from] BokehSessionWriteRejection),
    #[error(transparent)]
    Sync(Box<SyncError>),
}

impl From<SyncError> for BokehWriteError {
    fn from(error: SyncError) -> Self {
        Self::Sync(Box::new(error))
    }
}

/// Bokeh session access on a notebook connection.
pub trait BokehDocHandleExt {
    /// Whether the daemon routes Bokeh session documents to this connection.
    fn supports_bokeh_session_docs(&self) -> bool;

    /// The session's document, once its replica has synced. Opens the
    /// replica (subscribing to daemon pushes) for `epoch` if needed and waits
    /// up to `timeout`. `None` when the daemon does not sync session
    /// documents or the document did not arrive in time.
    fn await_bokeh_session(
        &self,
        session_id: &str,
        epoch: u64,
        timeout: Duration,
    ) -> impl Future<Output = Result<Option<BokehSessionSnapshot>, SyncError>> + Send;

    /// Write property values to a synced session as one change and follow
    /// it for up to `wait`: the daemon's acknowledgement or refusal, kernel
    /// corrections of the written values, and other values callbacks set.
    ///
    /// Writes are limited to existing models' non-reference properties of a
    /// connected session at the current epoch; the daemon additionally
    /// checks this connection's scope and actor.
    fn write_bokeh_session_props(
        &self,
        session_id: &str,
        status: BokehSessionStatus,
        props: &BTreeMap<String, BTreeMap<String, String>>,
        wait: Duration,
    ) -> impl Future<Output = Result<BokehWriteReport, BokehWriteError>> + Send;
}

impl BokehDocHandleExt for DocHandle {
    fn supports_bokeh_session_docs(&self) -> bool {
        self.supports_doc_kind(BOKEH_SESSION_KIND)
    }

    async fn await_bokeh_session(
        &self,
        session_id: &str,
        epoch: u64,
        timeout: Duration,
    ) -> Result<Option<BokehSessionSnapshot>, SyncError> {
        if !self.supports_bokeh_session_docs() {
            return Ok(None);
        }
        // Subscribe before opening so the first push is not missed.
        let mut events = self.subscribe_keyed_docs()?;
        self.open_keyed_doc(BOKEH_SESSION_KIND, session_id, epoch)?;
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            if let Some(snapshot) = snapshot(self, session_id)? {
                return Ok(Some(snapshot));
            }
            match tokio::time::timeout_at(deadline, events.recv()).await {
                Err(_) | Ok(Err(broadcast::error::RecvError::Closed)) => return Ok(None),
                Ok(_) => {}
            }
        }
    }

    async fn write_bokeh_session_props(
        &self,
        session_id: &str,
        status: BokehSessionStatus,
        props: &BTreeMap<String, BTreeMap<String, String>>,
        wait: Duration,
    ) -> Result<BokehWriteReport, BokehWriteError> {
        if !self.supports_bokeh_session_docs() {
            return Err(BokehWriteError::Unsupported);
        }
        let events = self.subscribe_keyed_docs()?;
        let written = write(self, session_id, status, props)?;
        if !written.changed {
            return Ok(unchanged_report(props));
        }
        Ok(observe_write(self, events, session_id, props, &written, wait).await?)
    }
}

fn is_session(event_key: &crate::KeyedDocKey, session_id: &str) -> bool {
    event_key.kind == BOKEH_SESSION_KIND && event_key.id == session_id
}

/// The session's state, or `None` before its epoch's document arrived.
fn snapshot(
    handle: &DocHandle,
    session_id: &str,
) -> Result<Option<BokehSessionSnapshot>, SyncError> {
    Ok(handle
        .with_keyed_doc(BOKEH_SESSION_KIND, session_id, |view| {
            let doc = BokehSessionDocRef::from_doc(&*view.doc);
            doc.epoch().and_then(|_| doc.read_snapshot().ok())
        })?
        .flatten())
}

/// A write the sync task is sending.
struct Written {
    changed: bool,
    epoch: u64,
    heads: Vec<ChangeHash>,
    /// Authored this epoch's build; only its writes count as Python's.
    kernel: ActorId,
}

/// Write one batch to the replica; the sync task sends the change.
fn write(
    handle: &DocHandle,
    session_id: &str,
    status: BokehSessionStatus,
    props: &BTreeMap<String, BTreeMap<String, String>>,
) -> Result<Written, BokehWriteError> {
    handle
        .with_keyed_doc(BOKEH_SESSION_KIND, session_id, |view| {
            let epoch = view.epoch;
            let mut doc = BokehSessionDocMut::from_doc(view.doc);
            let (Some(_), Some(kernel)) = (doc.epoch(), doc.epoch_actor()) else {
                return Err(BokehWriteError::NotSynced(session_id.to_string()));
            };
            // The daemon knows this connection's scope and enforces it; the
            // local check covers status, epoch and content.
            let context = BokehSessionWriteContext {
                scope: RuntimeStateWriteScope::Editor,
                status,
                current_epoch: epoch,
            };
            let changed = doc.write_peer_props(&context, props)?;
            Ok(Written {
                changed,
                epoch,
                heads: doc.get_heads(),
                kernel,
            })
        })?
        .unwrap_or_else(|| Err(BokehWriteError::NotSynced(session_id.to_string())))
}

fn unchanged_report(props: &BTreeMap<String, BTreeMap<String, String>>) -> BokehWriteReport {
    BokehWriteReport {
        acknowledged: true,
        values: props
            .iter()
            .map(|(model, values)| {
                let values = values
                    .iter()
                    .map(|(prop, value)| {
                        (
                            prop.clone(),
                            BokehWrittenValue {
                                value: Some(value.clone()),
                                source: BokehValueSource::Requested,
                            },
                        )
                    })
                    .collect();
                (model.clone(), values)
            })
            .collect(),
        ..Default::default()
    }
}

/// Values of properties the kernel won in the change between `before` and
/// `after` of epoch `epoch`.
fn kernel_values(
    handle: &DocHandle,
    session_id: &str,
    epoch: u64,
    kernel: &ActorId,
    before: &[ChangeHash],
    after: &[ChangeHash],
) -> Result<BTreeMap<String, BTreeMap<String, String>>, SyncError> {
    Ok(handle
        .with_keyed_doc(BOKEH_SESSION_KIND, session_id, |view| {
            // A restart since the event leaves its heads unknown to the replica.
            let mut known = |heads: &[ChangeHash]| {
                heads
                    .iter()
                    .all(|head| view.doc.get_change_by_hash(head).is_some())
            };
            if view.epoch != epoch || !known(before) || !known(after) {
                return BTreeMap::new();
            }
            let mut doc = BokehSessionDocMut::from_doc(view.doc);
            let changeset = doc.diff(before, after);
            doc.foreign_props(&changeset, |actor| actor == kernel)
        })?
        .unwrap_or_default())
}

/// The replica's epoch, and whether the daemon merged `heads` in it.
fn merge_state(
    handle: &DocHandle,
    session_id: &str,
    heads: &[ChangeHash],
) -> Result<Option<(u64, bool)>, SyncError> {
    handle.with_keyed_doc(BOKEH_SESSION_KIND, session_id, |mut view| {
        (view.epoch, view.has_merged(heads))
    })
}

/// Follow a write until the kernel sets every written value, the daemon
/// refuses it, the document is replaced, or `wait` runs out.
async fn observe_write(
    handle: &DocHandle,
    mut events: broadcast::Receiver<KeyedDocEvent>,
    session_id: &str,
    props: &BTreeMap<String, BTreeMap<String, String>>,
    written: &Written,
    wait: Duration,
) -> Result<BokehWriteReport, SyncError> {
    let deadline = tokio::time::Instant::now() + wait;
    let mut report = BokehWriteReport {
        changed: true,
        ..Default::default()
    };
    let requested = |model: &str, prop: &str| {
        props
            .get(model)
            .is_some_and(|values| values.contains_key(prop))
    };
    let mut kernel_set_all = false;
    loop {
        match merge_state(handle, session_id, &written.heads)? {
            Some((epoch, _)) if epoch != written.epoch => {
                report.replaced_epoch = Some(epoch);
            }
            Some((_, merged)) => report.acknowledged |= merged,
            None => {}
        }
        if report.rejected.is_some() || report.replaced_epoch.is_some() || kernel_set_all {
            break;
        }
        // The daemon's acknowledgement moves only the sync state, which
        // publishes no event, so poll for it while unacknowledged.
        let until = if report.acknowledged {
            deadline
        } else {
            deadline.min(tokio::time::Instant::now() + ACK_POLL_INTERVAL)
        };
        let event = match tokio::time::timeout_at(until, events.recv()).await {
            Err(_) if until < deadline => continue,
            Err(_) | Ok(Err(broadcast::error::RecvError::Closed)) => break,
            Ok(Err(broadcast::error::RecvError::Lagged(_))) => continue,
            Ok(Ok(event)) => event,
        };
        match event {
            KeyedDocEvent::Resync { key, reason, .. } if is_session(&key, session_id) => {
                report.rejected = Some(reason)
            }
            KeyedDocEvent::Changed {
                key,
                epoch,
                before,
                after,
            } if is_session(&key, session_id) => {
                if epoch != written.epoch {
                    report.replaced_epoch = Some(epoch);
                    continue;
                }
                let changed =
                    kernel_values(handle, session_id, epoch, &written.kernel, &before, &after)?;
                for (model, values) in changed {
                    for (prop, value) in values {
                        if !requested(&model, &prop) {
                            report
                                .kernel_changes
                                .entry(model.clone())
                                .or_default()
                                .insert(prop, value);
                        }
                    }
                }
                kernel_set_all = written_values(handle, session_id, props, written)?
                    .iter()
                    .all(|(_, _, value)| value.source == BokehValueSource::Kernel);
            }
            _ => {}
        }
    }
    if report.rejected.is_none() {
        for (model, prop, value) in written_values(handle, session_id, props, written)? {
            report.values.entry(model).or_default().insert(prop, value);
        }
    }
    Ok(report)
}

/// Current value and setter of each written property. The write was the
/// latest value when made, so any other winner came after it, or at the
/// same time and won the conflict.
fn written_values(
    handle: &DocHandle,
    session_id: &str,
    props: &BTreeMap<String, BTreeMap<String, String>>,
    written: &Written,
) -> Result<Vec<(String, String, BokehWrittenValue)>, SyncError> {
    Ok(handle
        .with_keyed_doc(BOKEH_SESSION_KIND, session_id, |view| {
            let ours = view.doc.get_actor().clone();
            let replaced = view.epoch != written.epoch;
            let doc = BokehSessionDocRef::from_doc(&*view.doc);
            props
                .iter()
                .flat_map(|(model, values)| {
                    values.iter().map(|(prop, requested)| {
                        let value = doc.get_prop(model, prop);
                        let source = if replaced {
                            if value.as_ref() == Some(requested) {
                                BokehValueSource::Requested
                            } else {
                                BokehValueSource::Lost
                            }
                        } else {
                            match doc.prop_actor(model, prop) {
                                Some(actor) if actor == ours => BokehValueSource::Requested,
                                Some(actor) if actor != written.kernel => {
                                    BokehValueSource::OtherClient
                                }
                                // Peers cannot remove models, so a vanished
                                // property is the kernel's doing too.
                                _ => BokehValueSource::Kernel,
                            }
                        };
                        (
                            model.clone(),
                            prop.clone(),
                            BokehWrittenValue { value, source },
                        )
                    })
                })
                .collect()
        })?
        .unwrap_or_default())
}

#[cfg(test)]
mod tests {
    //! Over a fake daemon: the real sync task and keyed replicas, and a hub
    //! that applies the real content filter, refuses with `DocResync`, and
    //! plays the kernel by clamping the slider.

    use std::sync::{Arc, Mutex};

    use automerge::sync::{Message, State};
    use notebook_protocol::connection::{
        FrameSink, FrameSource, KeyedDocFrameHeader, NotebookFrameType, TypedNotebookFrame,
    };
    use notebook_protocol::protocol::SessionControlMessage;
    use runtime_doc::{BokehModelState, BokehSessionDoc, BokehSessionMeta};
    use tokio::sync::mpsc;

    use super::*;

    const AGENT: &str = "agent:bokeh-sync-test";
    const KERNEL: &str = "rt:kernel:test";

    fn snapshot() -> BokehSessionSnapshot {
        BokehSessionSnapshot {
            epoch: 0,
            meta: BokehSessionMeta {
                session_id: "s1".into(),
                producer_name: "panel".into(),
                producer_version: "1.9.4".into(),
                bokeh_version: "3.9.2".into(),
                root_ids: vec!["p1".into()],
                title: None,
                doc_extras: None,
            },
            models: BTreeMap::from([(
                "p1".to_string(),
                BokehModelState {
                    type_name: "Slider".into(),
                    ref_props: vec!["js_property_callbacks".into()],
                    props: BTreeMap::from([
                        ("value".to_string(), "0.5".to_string()),
                        ("title".to_string(), r#""Alpha""#.to_string()),
                        ("disabled".to_string(), "false".to_string()),
                    ]),
                },
            )]),
            columns: BTreeMap::new(),
        }
    }

    const BROWSER: &str = "user:dev:browser/tab";

    /// What the hub's other writers do once an agent write to `p1.value`
    /// merges.
    #[derive(Clone, Copy, PartialEq, Eq)]
    enum React {
        /// Python clamps to [0, 1] and only echoes corrections.
        Clamp,
        /// A browser overwrites the value and sets another property, and an
        /// unrelated kernel tick changes the title; Python itself is busy.
        Others,
        /// The producer replaces the document (epoch 1) before the write
        /// reached it, so the new epoch lacks it.
        Replace,
    }

    struct Hub {
        doc: BokehSessionDoc,
        state: State,
        refuse: bool,
        react: React,
        tx: mpsc::UnboundedSender<TypedNotebookFrame>,
    }

    impl Hub {
        fn epoch(&self) -> u64 {
            self.doc.epoch().unwrap_or_default()
        }

        fn write_as(&mut self, actor: &str, model: &str, prop: &str, value: &str) {
            self.doc.set_actor(actor);
            self.doc.set_prop(model, prop, value).unwrap();
            self.doc.commit();
            self.doc.set_actor(KERNEL);
        }

        fn push(&mut self) {
            if let Some(message) = self.doc.generate_sync_message(&mut self.state) {
                let payload = KeyedDocFrameHeader::new(BOKEH_SESSION_KIND, "s1", self.epoch())
                    .encode_frame(&message.encode());
                let _ = self.tx.send(TypedNotebookFrame {
                    frame_type: NotebookFrameType::KeyedDocSync,
                    payload,
                });
            }
        }

        fn receive(&mut self, payload: &[u8]) {
            let (header, body) = KeyedDocFrameHeader::try_parse(payload).unwrap();
            assert_eq!(header.kind, BOKEH_SESSION_KIND);
            let message = Message::decode(body).unwrap();
            let context = BokehSessionWriteContext {
                scope: if self.refuse {
                    RuntimeStateWriteScope::Viewer
                } else {
                    RuntimeStateWriteScope::Editor
                },
                status: BokehSessionStatus::Connected,
                current_epoch: self.epoch(),
            };
            if header.epoch != self.epoch() {
                return;
            }
            let agent = ActorId::from(AGENT.as_bytes());
            match self.doc.receive_peer_sync_message_checked(
                &mut self.state,
                message,
                &context,
                |actor| *actor == agent,
            ) {
                Ok(changeset) => {
                    if changeset
                        .props_changed
                        .get("p1")
                        .is_some_and(|props| props.contains("value"))
                    {
                        match self.react {
                            React::Clamp => {
                                let value: f64 =
                                    self.doc.get_prop("p1", "value").unwrap().parse().unwrap();
                                if value > 1.0 {
                                    self.write_as(KERNEL, "p1", "value", "1");
                                }
                            }
                            React::Others => {
                                self.write_as(BROWSER, "p1", "value", "0.9");
                                self.write_as(BROWSER, "p1", "disabled", "true");
                                self.write_as(KERNEL, "p1", "title", r#""tick 1""#);
                            }
                            React::Replace => {
                                let next = BokehSessionSnapshot {
                                    epoch: 1,
                                    ..snapshot()
                                };
                                self.doc = BokehSessionDoc::build(&next, KERNEL).unwrap();
                                self.state = State::new();
                            }
                        }
                    }
                    self.push();
                }
                Err(error) => {
                    self.state = State::new();
                    let resync = SessionControlMessage::DocResync {
                        kind: BOKEH_SESSION_KIND.into(),
                        id: "s1".into(),
                        epoch: 0,
                        reason: error.to_string(),
                    };
                    let _ = self.tx.send(TypedNotebookFrame {
                        frame_type: NotebookFrameType::SessionControl,
                        payload: serde_json::to_vec(&resync).unwrap(),
                    });
                }
            }
        }
    }

    struct Frames(mpsc::UnboundedReceiver<TypedNotebookFrame>);
    impl FrameSource for Frames {
        async fn recv_frame(&mut self) -> Option<std::io::Result<TypedNotebookFrame>> {
            self.0.recv().await.map(Ok)
        }
    }

    struct Sink(Arc<Mutex<Hub>>);
    impl FrameSink for Sink {
        async fn send_frame(
            &mut self,
            frame_type: NotebookFrameType,
            payload: &[u8],
        ) -> std::io::Result<()> {
            if frame_type == NotebookFrameType::KeyedDocSync {
                self.0.lock().unwrap().receive(payload);
            }
            Ok(())
        }
    }

    async fn connect(kinds: &[&str]) -> (DocHandle, Arc<Mutex<Hub>>) {
        let (tx, rx) = mpsc::unbounded_channel();
        let hub = Arc::new(Mutex::new(Hub {
            doc: BokehSessionDoc::build(&snapshot(), KERNEL).unwrap(),
            state: State::new(),
            refuse: false,
            react: React::Clamp,
            tx,
        }));
        let handle = crate::connect::connect_frame_io(
            "bokeh-sync-test".into(),
            AGENT,
            Frames(rx),
            Sink(hub.clone()),
        )
        .await
        .unwrap()
        .handle
        .with_keyed_doc_kinds(kinds.iter().map(|kind| kind.to_string()).collect());
        (handle, hub)
    }

    fn props(value: &str) -> BTreeMap<String, BTreeMap<String, String>> {
        BTreeMap::from([(
            "p1".to_string(),
            BTreeMap::from([("value".to_string(), value.to_string())]),
        )])
    }

    const WAIT: Duration = Duration::from_millis(300);

    #[tokio::test]
    async fn syncs_writes_reports_corrections_and_refusals() {
        let (handle, hub) = connect(&[BOKEH_SESSION_KIND]).await;
        assert!(handle.supports_bokeh_session_docs());
        let synced = handle
            .await_bokeh_session("s1", 0, Duration::from_secs(1))
            .await
            .unwrap()
            .expect("document synced");
        assert_eq!(synced.models["p1"].props["value"], "0.5");

        let report = handle
            .write_bokeh_session_props("s1", BokehSessionStatus::Connected, &props("0.25"), WAIT)
            .await
            .unwrap();
        assert!(report.changed && report.acknowledged, "{report:?}");
        assert_eq!(
            report.values["p1"]["value"],
            BokehWrittenValue {
                value: Some("0.25".into()),
                source: BokehValueSource::Requested
            }
        );
        assert_eq!(
            hub.lock().unwrap().doc.get_prop("p1", "value").as_deref(),
            Some("0.25")
        );

        // Writing the current value sends nothing.
        let report = handle
            .write_bokeh_session_props("s1", BokehSessionStatus::Connected, &props("0.25"), WAIT)
            .await
            .unwrap();
        assert!(!report.changed && report.acknowledged);

        // The kernel's correction is reported as such.
        let report = handle
            .write_bokeh_session_props("s1", BokehSessionStatus::Connected, &props("5"), WAIT)
            .await
            .unwrap();
        assert_eq!(
            report.values["p1"]["value"],
            BokehWrittenValue {
                value: Some("1".into()),
                source: BokehValueSource::Kernel
            }
        );

        // Local checks use the hub's rules.
        let reference = BTreeMap::from([(
            "p1".to_string(),
            BTreeMap::from([("js_property_callbacks".to_string(), "{}".to_string())]),
        )]);
        assert!(matches!(
            handle
                .write_bokeh_session_props("s1", BokehSessionStatus::Connected, &reference, WAIT)
                .await,
            Err(BokehWriteError::Rejected(_))
        ));
        assert!(matches!(
            handle
                .write_bokeh_session_props(
                    "s1",
                    BokehSessionStatus::Disconnected,
                    &props("0.1"),
                    WAIT
                )
                .await,
            Err(BokehWriteError::Rejected(_))
        ));

        // A refusal only the daemon can make restarts the replica without the
        // write, and the replica resyncs to the hub's value.
        hub.lock().unwrap().refuse = true;
        let report = handle
            .write_bokeh_session_props("s1", BokehSessionStatus::Connected, &props("0.75"), WAIT)
            .await
            .unwrap();
        assert!(
            report
                .rejected
                .as_deref()
                .is_some_and(|r| r.contains("viewer")),
            "{report:?}"
        );
        hub.lock().unwrap().refuse = false;
        let resynced = handle
            .await_bokeh_session("s1", 0, Duration::from_secs(1))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(resynced.models["p1"].props["value"], "1");
    }

    #[tokio::test]
    async fn only_kernel_changes_count_as_corrections_or_observed_changes() {
        let (handle, hub) = connect(&[BOKEH_SESSION_KIND]).await;
        handle
            .await_bokeh_session("s1", 0, Duration::from_secs(1))
            .await
            .unwrap()
            .expect("document synced");
        hub.lock().unwrap().react = React::Others;
        let report = handle
            .write_bokeh_session_props("s1", BokehSessionStatus::Connected, &props("0.25"), WAIT)
            .await
            .unwrap();
        assert!(report.acknowledged, "{report:?}");
        let value = &report.values["p1"]["value"];
        assert_eq!(value.value.as_deref(), Some("0.9"), "{report:?}");
        assert_eq!(value.source, BokehValueSource::OtherClient, "{report:?}");
        // The browser's other write is not reported; the kernel's tick is.
        assert_eq!(
            report.kernel_changes,
            BTreeMap::from([(
                "p1".to_string(),
                BTreeMap::from([("title".to_string(), r#""tick 1""#.to_string())])
            )]),
            "{report:?}"
        );
    }

    #[tokio::test]
    async fn a_write_lost_to_an_epoch_replacement_is_not_acknowledged() {
        let (handle, hub) = connect(&[BOKEH_SESSION_KIND]).await;
        handle
            .await_bokeh_session("s1", 0, Duration::from_secs(1))
            .await
            .unwrap()
            .expect("document synced");
        hub.lock().unwrap().react = React::Replace;
        let report = handle
            .write_bokeh_session_props("s1", BokehSessionStatus::Connected, &props("0.25"), WAIT)
            .await
            .unwrap();
        assert!(!report.acknowledged, "{report:?}");
        let value = &report.values["p1"]["value"];
        assert_eq!(value.value.as_deref(), Some("0.5"), "{report:?}");
        assert_eq!(value.source, BokehValueSource::Lost, "{report:?}");
        assert_eq!(report.replaced_epoch, Some(1), "{report:?}");
        // The new epoch's build is all kernel-authored; none of it is a
        // reaction to the write.
        assert!(report.kernel_changes.is_empty(), "{report:?}");
    }

    #[tokio::test]
    async fn without_the_kind_nothing_is_opened_or_written() {
        let (handle, hub) = connect(&[]).await;
        assert!(!handle.supports_bokeh_session_docs());
        assert_eq!(
            handle
                .await_bokeh_session("s1", 0, Duration::from_millis(50))
                .await
                .unwrap(),
            None
        );
        assert!(matches!(
            handle
                .write_bokeh_session_props("s1", BokehSessionStatus::Connected, &props("0.2"), WAIT)
                .await,
            Err(BokehWriteError::Unsupported)
        ));
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(
            hub.lock().unwrap().doc.get_prop("p1", "value").as_deref(),
            Some("0.5")
        );
        assert!(handle
            .with_keyed_doc(BOKEH_SESSION_KIND, "s1", |_| ())
            .is_err());
    }
}
