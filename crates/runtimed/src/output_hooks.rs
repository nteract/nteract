//! MIME-keyed hooks that let an output type attach behaviour to generic output
//! paths without those paths naming it.
//!
//! The runtime agent's output committer calls the storage and prepare hooks;
//! the daemon's save, load and runtime-agent retirement paths call the rest.
//! Hooks are registered in `crate::extensions`.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use futures::future::BoxFuture;
use notebook_doc::NotebookDoc;
use notebook_protocol::protocol::RuntimeAgentRequest;
use runtime_doc::{RuntimeStateDoc, RuntimeStateError};
use runtimed_client::output_equivalence::ReplayFieldPolicy;
use serde_json::Value;

use crate::output_commit_context::OutputCommitContext;
use crate::output_store::OutputManifest;

pub(crate) trait OutputHook: Send + Sync + 'static {
    fn mime(&self) -> &'static str;

    /// Output to store instead of the original. Runs before the manifest is
    /// created; `prepare` still sees the original value.
    fn transform_for_storage(&self, _nbformat_value: &Value) -> Option<Value> {
        None
    }

    /// Runs after the manifest exists and before the RuntimeStateDoc output
    /// transaction. May write blobs. An error is logged and the output is
    /// committed without the hook's records.
    fn prepare<'a>(
        &'a self,
        _input: OutputHookInput<'a>,
    ) -> BoxFuture<'a, anyhow::Result<Option<Box<dyn PreparedOutput>>>> {
        Box::pin(async { Ok(None) })
    }

    /// Replacement for this MIME's resolved payload in the `.ipynb` export.
    fn materialize_for_save<'a>(&'a self, _payload: &'a Value) -> BoxFuture<'a, Option<Value>> {
        Box::pin(async { None })
    }

    /// Top-level payload keys that may differ between the durable execution
    /// record and the saved output.
    fn mutable_replay_fields(&self) -> &'static [&'static str] {
        &[]
    }

    /// Requests that release live resources whose outputs no current cell
    /// references. Keys added to `sent` are not requested again on the same
    /// runtime-agent connection.
    fn retirement_requests(
        &self,
        _notebook: &NotebookDoc,
        _state: &RuntimeStateDoc,
        _sent: &mut HashSet<String>,
    ) -> Vec<RuntimeAgentRequest> {
        Vec::new()
    }
}

pub(crate) trait PreparedOutput: Send {
    /// Runs inside the batch transaction that appends the output. Returns
    /// whether this output created its record.
    fn apply_in_txn(&mut self, state: &mut RuntimeStateDoc) -> Result<bool, RuntimeStateError>;

    /// Runs after a successful commit, only when `apply_in_txn` returned true.
    fn after_commit(self: Box<Self>) {}
}

pub(crate) struct OutputHookInput<'a> {
    pub(crate) execution_id: &'a str,
    /// The kernel's output, before `transform_for_storage`.
    pub(crate) nbformat_value: &'a Value,
    pub(crate) manifest: &'a OutputManifest,
    pub(crate) ctx: &'a OutputCommitContext,
}

#[derive(Clone, Default)]
pub(crate) struct OutputHookRegistry {
    by_mime: Arc<HashMap<&'static str, Arc<dyn OutputHook>>>,
}

impl OutputHookRegistry {
    pub(crate) fn new(hooks: Vec<Arc<dyn OutputHook>>) -> Self {
        let mut by_mime = HashMap::with_capacity(hooks.len());
        for hook in hooks {
            let mime = hook.mime();
            let duplicate = by_mime.insert(mime, hook).is_some();
            assert!(!duplicate, "duplicate output hook for {mime}");
        }
        Self {
            by_mime: Arc::new(by_mime),
        }
    }

    /// Hooks whose MIME is a key of a display_data/execute_result `data` map.
    pub(crate) fn for_output<'a>(
        &'a self,
        output: &'a Value,
    ) -> impl Iterator<Item = &'a Arc<dyn OutputHook>> + 'a {
        let data = matches!(
            output.get("output_type").and_then(Value::as_str),
            Some("display_data" | "execute_result")
        )
        .then(|| output.get("data").and_then(Value::as_object))
        .flatten();
        data.into_iter()
            .flat_map(|data| data.keys())
            .filter_map(|mime| self.by_mime.get(mime.as_str()))
    }

    /// `None` when no hook rewrites the output.
    pub(crate) fn transform_for_storage(&self, nbformat_value: &Value) -> Option<Value> {
        let mut transformed: Option<Value> = None;
        for hook in self.for_output(nbformat_value) {
            if let Some(next) =
                hook.transform_for_storage(transformed.as_ref().unwrap_or(nbformat_value))
            {
                transformed = Some(next);
            }
        }
        transformed
    }

    pub(crate) async fn prepare(&self, input: OutputHookInput<'_>) -> Vec<Box<dyn PreparedOutput>> {
        let mut prepared = Vec::new();
        for hook in self.for_output(input.nbformat_value) {
            let hook_input = OutputHookInput {
                execution_id: input.execution_id,
                nbformat_value: input.nbformat_value,
                manifest: input.manifest,
                ctx: input.ctx,
            };
            match hook.prepare(hook_input).await {
                Ok(Some(output)) => prepared.push(output),
                Ok(None) => {}
                Err(error) => tracing::warn!(
                    "[output-hooks] Failed to prepare {} output: {error}",
                    hook.mime()
                ),
            }
        }
        prepared
    }

    /// `output` unchanged unless a hook rewrites one of its payloads.
    pub(crate) async fn materialize_for_save(&self, mut output: Value) -> Value {
        let mut replacements = Vec::new();
        for hook in self.for_output(&output) {
            let Some(payload) = output.get("data").and_then(|data| data.get(hook.mime())) else {
                continue;
            };
            if let Some(replacement) = hook.materialize_for_save(payload).await {
                replacements.push((hook.mime(), replacement));
            }
        }
        if let Some(data) = output.get_mut("data").and_then(Value::as_object_mut) {
            for (mime, replacement) in replacements {
                data.insert(mime.to_string(), replacement);
            }
        }
        output
    }

    pub(crate) fn retirement_requests(
        &self,
        notebook: &NotebookDoc,
        state: &RuntimeStateDoc,
        sent: &mut HashSet<String>,
    ) -> Vec<RuntimeAgentRequest> {
        self.by_mime
            .values()
            .flat_map(|hook| hook.retirement_requests(notebook, state, sent))
            .collect()
    }
}

impl ReplayFieldPolicy for OutputHookRegistry {
    fn mutable_fields(&self, mime: &str) -> &'static [&'static str] {
        self.by_mime
            .get(mime)
            .map_or(&[], |hook| hook.mutable_replay_fields())
    }
}

/// Commits the hooks prepared for a batch: `apply_in_txn` inside the caller's
/// transaction, `after_commit` once it succeeded.
#[derive(Default)]
pub(crate) struct PreparedOutputBatch {
    pending: Vec<Box<dyn PreparedOutput>>,
}

impl PreparedOutputBatch {
    pub(crate) fn extend(&mut self, prepared: Vec<Box<dyn PreparedOutput>>) {
        self.pending.extend(prepared);
    }

    pub(crate) fn apply_in_txn(
        &mut self,
        state: &mut RuntimeStateDoc,
    ) -> Result<Vec<usize>, RuntimeStateError> {
        let mut created = Vec::new();
        for (index, prepared) in self.pending.iter_mut().enumerate() {
            if prepared.apply_in_txn(state)? {
                created.push(index);
            }
        }
        Ok(created)
    }

    pub(crate) fn after_commit(self, created: &[usize]) {
        for (index, prepared) in self.pending.into_iter().enumerate() {
            if created.contains(&index) {
                prepared.after_commit();
            }
        }
    }
}

#[cfg(test)]
pub(crate) mod test_hooks {
    use super::*;

    /// Test-only MIME whose `snapshot` key is mutable replay state, so save and
    /// load can be exercised before a production hook declares fields.
    pub(crate) const MUTABLE_REPLAY_TEST_MIME: &str =
        "application/x.nteract-test-mutable-replay+json";

    /// What the test hook writes to `snapshot` on save.
    pub(crate) fn saved_snapshot() -> Value {
        serde_json::json!({"document": {"roots": [1]}})
    }

    pub(crate) struct MutableReplayTestHook;

    impl OutputHook for MutableReplayTestHook {
        fn mime(&self) -> &'static str {
            MUTABLE_REPLAY_TEST_MIME
        }

        fn materialize_for_save<'a>(&'a self, payload: &'a Value) -> BoxFuture<'a, Option<Value>> {
            Box::pin(async move {
                let mut payload = payload.as_object()?.clone();
                payload.insert("snapshot".into(), saved_snapshot());
                Some(Value::Object(payload))
            })
        }

        fn mutable_replay_fields(&self) -> &'static [&'static str] {
            &["snapshot"]
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    struct RecordingHook {
        mime: &'static str,
    }

    struct RecordingPrepared {
        create: bool,
        log: Arc<Mutex<Vec<String>>>,
    }

    impl PreparedOutput for RecordingPrepared {
        fn apply_in_txn(
            &mut self,
            _state: &mut RuntimeStateDoc,
        ) -> Result<bool, RuntimeStateError> {
            self.log
                .lock()
                .unwrap()
                .push(format!("apply:{}", self.create));
            Ok(self.create)
        }

        fn after_commit(self: Box<Self>) {
            self.log
                .lock()
                .unwrap()
                .push(format!("after:{}", self.create));
        }
    }

    impl OutputHook for RecordingHook {
        fn mime(&self) -> &'static str {
            self.mime
        }

        fn transform_for_storage(&self, value: &Value) -> Option<Value> {
            let mut value = value.clone();
            value["data"][self.mime] = Value::String("stored".into());
            Some(value)
        }

        fn materialize_for_save<'a>(&'a self, payload: &'a Value) -> BoxFuture<'a, Option<Value>> {
            Box::pin(async move { Some(serde_json::json!({ "saved": payload })) })
        }
    }

    fn registry() -> OutputHookRegistry {
        OutputHookRegistry::new(vec![Arc::new(RecordingHook {
            mime: "application/x.recording",
        })])
    }

    #[test]
    fn hooks_match_rich_outputs_by_data_mime_only() {
        let registry = registry();
        let display = serde_json::json!({
            "output_type": "display_data",
            "data": {"application/x.recording": 1, "text/plain": "x"},
        });
        assert_eq!(registry.for_output(&display).count(), 1);
        let result = serde_json::json!({
            "output_type": "execute_result",
            "data": {"text/plain": "x"},
        });
        assert_eq!(registry.for_output(&result).count(), 0);
        let stream = serde_json::json!({
            "output_type": "stream",
            "data": {"application/x.recording": 1},
        });
        assert_eq!(registry.for_output(&stream).count(), 0);
        assert!(registry.transform_for_storage(&result).is_none());
        assert_eq!(
            registry.transform_for_storage(&display).unwrap()["data"]["application/x.recording"],
            "stored"
        );
    }

    #[tokio::test]
    async fn materialize_for_save_rewrites_only_the_hook_mime() {
        let registry = registry();
        let output = serde_json::json!({
            "output_type": "display_data",
            "data": {"application/x.recording": {"a": 1}, "text/plain": "x"},
            "metadata": {},
        });
        let saved = registry.materialize_for_save(output.clone()).await;
        assert_eq!(
            saved["data"]["application/x.recording"],
            serde_json::json!({"saved": {"a": 1}})
        );
        assert_eq!(saved["data"]["text/plain"], "x");
        assert_eq!(saved["metadata"], output["metadata"]);

        let empty = OutputHookRegistry::default();
        assert_eq!(empty.materialize_for_save(output.clone()).await, output);
    }

    #[test]
    fn after_commit_runs_only_for_created_records() {
        let log: Arc<Mutex<Vec<String>>> = Arc::default();
        let mut batch = PreparedOutputBatch::default();
        batch.extend(vec![
            Box::new(RecordingPrepared {
                create: true,
                log: log.clone(),
            }),
            Box::new(RecordingPrepared {
                create: false,
                log: log.clone(),
            }),
        ]);
        let mut state = RuntimeStateDoc::new();
        let created = batch.apply_in_txn(&mut state).unwrap();
        batch.after_commit(&created);
        assert_eq!(
            *log.lock().unwrap(),
            ["apply:true", "apply:false", "after:true"]
        );
    }

    #[test]
    fn replay_fields_are_scoped_to_the_declaring_mime() {
        let registry = OutputHookRegistry::new(vec![Arc::new(test_hooks::MutableReplayTestHook)]);
        assert_eq!(
            registry.mutable_fields(test_hooks::MUTABLE_REPLAY_TEST_MIME),
            ["snapshot"]
        );
        assert!(registry.mutable_fields("application/json").is_empty());
    }

    #[test]
    #[should_panic(expected = "duplicate output hook")]
    fn duplicate_mime_registration_panics() {
        OutputHookRegistry::new(vec![
            Arc::new(test_hooks::MutableReplayTestHook),
            Arc::new(test_hooks::MutableReplayTestHook),
        ]);
    }
}
