//! Projects a prompt run into one RuntimeStateDoc output.
//!
//! The streamed answer is ONE `display_data` output with a stable `output_id`
//! and a single `text/markdown` entry that is rewritten in place as text
//! arrives. Each rewrite stores the whole text, so writes are spaced by
//! [`write_interval`]: at least [`MIN_WRITE_INTERVAL`] apart, and further
//! apart as the text grows so the bytes written per second stay under
//! [`WRITE_BYTES_PER_SEC`]. The final write is never throttled and happens
//! before the execution's terminal status, so a client that sees
//! `done`/`error` always also sees the complete text.

use std::sync::Arc;
use std::time::Duration;

use runtime_doc::RuntimeStateHandle;
use serde_json::{json, Value};
use tokio::time::Instant;
use tracing::{debug, warn};

use crate::blob_store::BlobStore;
use crate::output_store::{create_manifest, DEFAULT_INLINE_THRESHOLD};

/// Streaming rewrites happen at most 10 times per second.
const MIN_WRITE_INTERVAL: Duration = Duration::from_millis(100);

/// Bytes per second that streaming rewrites may write (each rewrite writes
/// the whole text, into the doc or as a new blob).
const WRITE_BYTES_PER_SEC: u64 = 16 * 1024;

/// Time between streaming rewrites of a text of `len` bytes: short answers
/// keep 10 updates per second, long ones slow down to stay within
/// [`WRITE_BYTES_PER_SEC`].
fn write_interval(len: usize) -> Duration {
    let budget = Duration::from_millis((len as u64).saturating_mul(1000) / WRITE_BYTES_PER_SEC);
    budget.max(MIN_WRITE_INTERVAL)
}

pub(super) struct OutputProjector {
    state: RuntimeStateHandle,
    blob_store: Arc<BlobStore>,
    execution_id: String,
    output_id: String,
    text: String,
    /// Text changed since the last write.
    dirty: bool,
    last_write: Option<Instant>,
    writes: usize,
}

impl OutputProjector {
    pub fn new(
        state: RuntimeStateHandle,
        blob_store: Arc<BlobStore>,
        execution_id: impl Into<String>,
    ) -> Self {
        Self {
            state,
            blob_store,
            execution_id: execution_id.into(),
            output_id: uuid::Uuid::new_v4().to_string(),
            text: String::new(),
            dirty: false,
            last_write: None,
            writes: 0,
        }
    }

    /// Text accumulated so far.
    pub fn text(&self) -> &str {
        &self.text
    }

    /// Number of output writes so far (tests and debug logs).
    pub fn writes(&self) -> usize {
        self.writes
    }

    /// Add streamed text. Does not write.
    pub fn push(&mut self, delta: &str) {
        if delta.is_empty() {
            return;
        }
        self.text.push_str(delta);
        self.dirty = true;
    }

    /// When the next throttled write is due, or `None` when nothing is
    /// pending.
    pub fn flush_deadline(&self) -> Option<Instant> {
        if !self.dirty {
            return None;
        }
        Some(match self.last_write {
            Some(last) => last + write_interval(self.text.len()),
            None => Instant::now(),
        })
    }

    /// Write pending text if the throttle allows. Returns whether it wrote.
    pub async fn flush_if_due(&mut self) -> bool {
        match self.flush_deadline() {
            Some(deadline) if deadline <= Instant::now() => {
                self.write(None).await;
                true
            }
            _ => false,
        }
    }

    /// Final, unthrottled write of the answer text. `stopped` marks the
    /// output with `metadata.nteract.prompt_stopped`. Always writes, even for
    /// empty text, so the terminal status never precedes the output.
    pub async fn finish(&mut self, text: Option<&str>, stopped: bool) {
        if let Some(text) = text {
            self.text = text.to_string();
        }
        let metadata = stopped.then(|| json!({"nteract": {"prompt_stopped": true}}));
        self.write(metadata).await;
    }

    async fn write(&mut self, metadata: Option<Value>) {
        let output = json!({
            "output_type": "display_data",
            "output_id": self.output_id,
            "data": {"text/markdown": &self.text},
            "metadata": metadata.unwrap_or_else(|| json!({})),
        });
        commit_output(&self.state, &self.blob_store, &self.execution_id, &output).await;
        self.dirty = false;
        self.last_write = Some(Instant::now());
        self.writes += 1;
    }
}

/// Build the manifest for `output` and write it (rewriting in place when its
/// `output_id` already exists).
async fn commit_output(
    state: &RuntimeStateHandle,
    blob_store: &BlobStore,
    execution_id: &str,
    output: &Value,
) {
    // Same threshold as kernel streams: every rewrite stays in the doc's history,
    // so text above 1 KiB goes to the blob store and the doc keeps only a hash.
    let manifest = match create_manifest(output, blob_store, DEFAULT_INLINE_THRESHOLD).await {
        Ok(manifest) => manifest.to_json(),
        Err(err) => {
            warn!("[prompt-agent] Failed to build output manifest for {execution_id}: {err}");
            return;
        }
    };
    match state.with_doc(|sd| sd.append_output(execution_id, &manifest)) {
        Ok(_) => debug!("[prompt-agent] Wrote output for {execution_id}"),
        Err(err) => warn!("[prompt-agent] Failed to write output for {execution_id}: {err}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use runtime_doc::RuntimeStateDoc;
    use tokio::sync::broadcast;

    fn setup() -> (RuntimeStateHandle, Arc<BlobStore>, tempfile::TempDir) {
        let tmp = tempfile::tempdir().unwrap();
        let (tx, _rx) = broadcast::channel(16);
        let state = RuntimeStateHandle::new(RuntimeStateDoc::new(), tx);
        state
            .with_doc(|sd| {
                sd.create_execution_with_capability("e1", "q", 1, None, Some("c"), "prompt")
            })
            .unwrap();
        (
            state,
            Arc::new(BlobStore::new(tmp.path().join("blobs"))),
            tmp,
        )
    }

    fn markdown(state: &RuntimeStateHandle) -> Vec<String> {
        state
            .read(|sd| sd.get_outputs("e1"))
            .unwrap()
            .iter()
            .map(|m| {
                m["data"]["text/markdown"]["inline"]
                    .as_str()
                    .unwrap()
                    .to_string()
            })
            .collect()
    }

    #[tokio::test(start_paused = true)]
    async fn rewrites_one_output_in_place_at_most_ten_times_a_second() {
        let (state, blobs, _tmp) = setup();
        let mut projector = OutputProjector::new(state.clone(), blobs, "e1");

        // First text writes immediately.
        assert_eq!(projector.flush_deadline(), None);
        projector.push("a");
        assert!(projector.flush_if_due().await);
        assert_eq!(markdown(&state), vec!["a"]);

        // Within the interval, deltas are held back.
        projector.push("b");
        projector.push("c");
        assert!(!projector.flush_if_due().await);
        tokio::time::advance(Duration::from_millis(50)).await;
        assert!(!projector.flush_if_due().await);
        assert_eq!(markdown(&state), vec!["a"]);

        // At the interval the whole accumulated text is written, in place.
        tokio::time::advance(Duration::from_millis(50)).await;
        assert!(projector.flush_if_due().await);
        assert_eq!(markdown(&state), vec!["abc"]);
        assert_eq!(projector.writes(), 2);

        // Nothing pending: no deadline, no write.
        assert_eq!(projector.flush_deadline(), None);
        assert!(!projector.flush_if_due().await);

        // 1 second of 1 ms deltas produces about ten writes, not 1000.
        for _ in 0..1000 {
            projector.push("x");
            projector.flush_if_due().await;
            tokio::time::advance(Duration::from_millis(1)).await;
        }
        assert!(
            projector.writes() <= 2 + 11,
            "writes={}",
            projector.writes()
        );
        assert!(projector.writes() >= 2 + 9, "writes={}", projector.writes());
        assert_eq!(state.read(|sd| sd.get_outputs("e1")).unwrap().len(), 1);
    }

    #[test]
    fn the_write_interval_grows_with_the_text() {
        assert_eq!(write_interval(0), MIN_WRITE_INTERVAL);
        assert_eq!(write_interval(1600), MIN_WRITE_INTERVAL);
        assert_eq!(write_interval(16 * 1024), Duration::from_secs(1));
        assert_eq!(write_interval(64 * 1024), Duration::from_secs(4));
    }

    #[tokio::test(start_paused = true)]
    async fn long_text_is_rewritten_less_often() {
        let (state, blobs, _tmp) = setup();
        let mut projector = OutputProjector::new(state.clone(), blobs, "e1");
        projector.push(&"x".repeat(32 * 1024));
        assert!(projector.flush_if_due().await);

        // 32 KiB at 16 KiB/s: the next rewrite waits 2 s, not 100 ms.
        projector.push("y");
        tokio::time::advance(Duration::from_millis(1900)).await;
        assert!(!projector.flush_if_due().await);
        tokio::time::advance(Duration::from_millis(100)).await;
        assert!(projector.flush_if_due().await);
        assert_eq!(projector.writes(), 2);

        // The final write still goes through at once.
        projector.push("z");
        projector.finish(None, false).await;
        assert_eq!(projector.writes(), 3);
        assert!(projector.text().ends_with("yz"));
    }

    #[tokio::test(start_paused = true)]
    async fn the_final_write_is_not_throttled_and_carries_the_stop_marker() {
        let (state, blobs, _tmp) = setup();
        let mut projector = OutputProjector::new(state.clone(), blobs, "e1");
        projector.push("part");
        assert!(projector.flush_if_due().await);
        projector.push("ial");
        // Immediately after a write, the final write still goes through.
        projector.finish(None, true).await;
        assert_eq!(markdown(&state), vec!["partial"]);
        let outputs = state.read(|sd| sd.get_outputs("e1")).unwrap();
        assert_eq!(outputs[0]["metadata"]["nteract"]["prompt_stopped"], true);
        assert_eq!(projector.flush_deadline(), None);
    }

    #[tokio::test(start_paused = true)]
    async fn long_text_goes_to_the_blob_store_not_the_doc_history() {
        let (state, blobs, _tmp) = setup();
        let mut projector = OutputProjector::new(state.clone(), blobs.clone(), "e1");
        let long = "word ".repeat(2000); // ~10 KiB, above the 1 KiB inline threshold
        projector.push(&long);
        projector.finish(None, false).await;

        let outputs = state.read(|sd| sd.get_outputs("e1")).unwrap();
        let content = &outputs[0]["data"]["text/markdown"];
        assert!(
            content.get("inline").is_none(),
            "long text must not be inline"
        );
        let hash = content["blob"].as_str().expect("blob ref");
        let bytes = blobs.get(hash).await.unwrap().expect("blob stored");
        assert_eq!(String::from_utf8(bytes).unwrap(), long);
    }
}
