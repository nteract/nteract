//! Reproducible measurements for non-stream output commit work.
//!
//! This models the part of the IOPub path that still runs inline for ordinary
//! `display_data`, `execute_result`, and `error` outputs: create an output
//! manifest, then append it to RuntimeStateDoc. The ordered-worker model keeps
//! the same manifest and append work, but measures the IOPub-facing cost as
//! ordered enqueue instead of synchronous blob/doc work.

use std::collections::VecDeque;
use std::time::Instant;

use anyhow::{ensure, Context};
use automerge::sync;
use notebook_protocol::protocol::BlobDurability;
use runtime_doc::RuntimeStateDoc;
use serde::Serialize;
use uuid::Uuid;

use crate::blob_store::BlobStore;
use crate::output_redaction::OutputRedactor;
use crate::output_segment::resolve_segment_outputs;
use crate::output_store::{self, DEFAULT_INLINE_THRESHOLD};

const EXECUTION_ID: &str = "exec-output-commit-measure";
const OUTPUT_SEGMENT_MIME: &str = "application/vnd.nteract.output-segment+json";
const DEFAULT_SEGMENT_SIZE: usize = 128;

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OutputCommitKind {
    DisplayData,
    ExecuteResult,
    Error,
}

impl OutputCommitKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::DisplayData => "display_data",
            Self::ExecuteResult => "execute_result",
            Self::Error => "error",
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct OutputCommitMeasurementConfig {
    pub output_count: usize,
    pub payload_bytes: usize,
    pub kind: OutputCommitKind,
    pub segment_size: usize,
}

impl Default for OutputCommitMeasurementConfig {
    fn default() -> Self {
        Self {
            output_count: 100,
            payload_bytes: 256,
            kind: OutputCommitKind::DisplayData,
            segment_size: DEFAULT_SEGMENT_SIZE,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct OutputCommitMeasurement {
    pub resolve_count: usize,
    pub resolve_nanos: u128,
    pub strategy: &'static str,
    pub output_count: usize,
    pub payload_bytes: usize,
    pub kind: OutputCommitKind,
    pub iopub_messages_observed: usize,
    pub buffer_preflights: usize,
    pub manifest_creations: usize,
    pub output_appends: usize,
    pub doc_append_calls: usize,
    pub enqueued_outputs: usize,
    pub committed_outputs: usize,
    pub durable_output_entries: usize,
    pub segment_blobs: usize,
    pub segment_bytes: usize,
    pub doc_save_bytes: usize,
    pub sync_daemon_messages: usize,
    pub sync_daemon_bytes: usize,
    pub sync_peer_messages: usize,
    pub sync_peer_bytes: usize,
    pub iopub_nanos: u128,
    pub preflight_nanos: u128,
    pub manifest_nanos: u128,
    pub append_nanos: u128,
    pub segment_write_nanos: u128,
    pub sync_nanos: u128,
    pub worker_nanos: u128,
    pub total_nanos: u128,
}

impl OutputCommitMeasurement {
    fn new(strategy: &'static str, config: OutputCommitMeasurementConfig) -> Self {
        Self {
            strategy,
            output_count: config.output_count,
            payload_bytes: config.payload_bytes,
            kind: config.kind,
            resolve_count: 0,
            resolve_nanos: 0,
            iopub_messages_observed: 0,
            buffer_preflights: 0,
            manifest_creations: 0,
            output_appends: 0,
            doc_append_calls: 0,
            enqueued_outputs: 0,
            committed_outputs: 0,
            durable_output_entries: 0,
            segment_blobs: 0,
            segment_bytes: 0,
            doc_save_bytes: 0,
            sync_daemon_messages: 0,
            sync_daemon_bytes: 0,
            sync_peer_messages: 0,
            sync_peer_bytes: 0,
            iopub_nanos: 0,
            preflight_nanos: 0,
            manifest_nanos: 0,
            append_nanos: 0,
            segment_write_nanos: 0,
            sync_nanos: 0,
            worker_nanos: 0,
            total_nanos: 0,
        }
    }
}

#[derive(Debug, Default)]
struct SyncMeasurement {
    daemon_messages: usize,
    daemon_bytes: usize,
    peer_messages: usize,
    peer_bytes: usize,
}

#[derive(Debug)]
struct QueuedOutput {
    value: serde_json::Value,
}

pub async fn measure_current_output_commit_loop(
    config: OutputCommitMeasurementConfig,
) -> anyhow::Result<OutputCommitMeasurement> {
    let blob_root = output_commit_measure_blob_root();
    tokio::fs::create_dir_all(&blob_root)
        .await
        .with_context(|| format!("create blob root {}", blob_root.display()))?;
    let blob_store = BlobStore::new(blob_root.clone());
    let redactor = OutputRedactor::disabled();
    let mut doc = RuntimeStateDoc::new();
    doc.create_execution_with_source(EXECUTION_ID, "pass", 0)?;
    doc.set_execution_running(EXECUTION_ID)?;
    let mut sync_peer = SyncPeer::after_initial_sync(&mut doc)?;

    let started = Instant::now();
    let mut metrics = OutputCommitMeasurement::new("current", config);

    for index in 0..config.output_count {
        let iopub_started = Instant::now();
        let output = measured_output(config.kind, index, config.payload_bytes);
        if uses_iopub_buffer_preflight(config.kind) {
            let preflight_started = Instant::now();
            output_store::preflight_ref_buffers(&output, &[], &blob_store).await;
            metrics.preflight_nanos += preflight_started.elapsed().as_nanos();
            metrics.buffer_preflights += 1;
        }

        let manifest_started = Instant::now();
        let manifest = output_store::create_manifest_with_redactor(
            &output,
            &blob_store,
            DEFAULT_INLINE_THRESHOLD,
            &redactor,
        )
        .await
        .context("create output manifest")?;
        metrics.manifest_nanos += manifest_started.elapsed().as_nanos();
        metrics.manifest_creations += 1;

        let append_started = Instant::now();
        doc.append_output(EXECUTION_ID, &manifest.to_json())?;
        metrics.append_nanos += append_started.elapsed().as_nanos();
        metrics.output_appends += 1;
        metrics.doc_append_calls += 1;
        metrics.committed_outputs += 1;
        metrics.iopub_nanos += iopub_started.elapsed().as_nanos();
        metrics.iopub_messages_observed += 1;
    }

    ensure!(
        doc.get_outputs(EXECUTION_ID).len() == config.output_count,
        "current output commit loop committed an unexpected number of outputs"
    );
    finalize_doc_metrics(&mut metrics, &mut doc, &mut sync_peer)?;
    metrics.total_nanos = started.elapsed().as_nanos();
    let _ = tokio::fs::remove_dir_all(&blob_root).await;
    Ok(metrics)
}

pub async fn measure_ordered_worker_output_commit_model(
    config: OutputCommitMeasurementConfig,
) -> anyhow::Result<OutputCommitMeasurement> {
    let blob_root = output_commit_measure_blob_root();
    tokio::fs::create_dir_all(&blob_root)
        .await
        .with_context(|| format!("create blob root {}", blob_root.display()))?;
    let blob_store = BlobStore::new(blob_root.clone());
    let redactor = OutputRedactor::disabled();
    let mut doc = RuntimeStateDoc::new();
    doc.create_execution_with_source(EXECUTION_ID, "pass", 0)?;
    doc.set_execution_running(EXECUTION_ID)?;
    let mut sync_peer = SyncPeer::after_initial_sync(&mut doc)?;

    let started = Instant::now();
    let mut metrics = OutputCommitMeasurement::new("ordered_worker_model", config);
    let mut queue = VecDeque::with_capacity(config.output_count);

    for index in 0..config.output_count {
        let iopub_started = Instant::now();
        queue.push_back(QueuedOutput {
            value: measured_output(config.kind, index, config.payload_bytes),
        });
        metrics.iopub_nanos += iopub_started.elapsed().as_nanos();
        metrics.iopub_messages_observed += 1;
        metrics.enqueued_outputs += 1;
    }

    let worker_started = Instant::now();
    let mut manifests = Vec::with_capacity(config.output_count);
    while let Some(output) = queue.pop_front() {
        if uses_iopub_buffer_preflight(config.kind) {
            let preflight_started = Instant::now();
            output_store::preflight_ref_buffers(&output.value, &[], &blob_store).await;
            metrics.preflight_nanos += preflight_started.elapsed().as_nanos();
            metrics.buffer_preflights += 1;
        }

        let manifest_started = Instant::now();
        let manifest = output_store::create_manifest_with_redactor(
            &output.value,
            &blob_store,
            DEFAULT_INLINE_THRESHOLD,
            &redactor,
        )
        .await
        .context("create output manifest")?;
        metrics.manifest_nanos += manifest_started.elapsed().as_nanos();
        metrics.manifest_creations += 1;
        manifests.push(manifest.to_json());
        metrics.committed_outputs += 1;
    }

    for chunk in manifests.chunks(effective_segment_size(config.segment_size)) {
        let append_started = Instant::now();
        doc.append_outputs(EXECUTION_ID, chunk)?;
        metrics.append_nanos += append_started.elapsed().as_nanos();
        metrics.output_appends += chunk.len();
        metrics.doc_append_calls += 1;
    }
    metrics.worker_nanos = worker_started.elapsed().as_nanos();

    ensure!(
        doc.get_outputs(EXECUTION_ID).len() == config.output_count,
        "ordered worker model committed an unexpected number of outputs"
    );
    finalize_doc_metrics(&mut metrics, &mut doc, &mut sync_peer)?;
    metrics.total_nanos = started.elapsed().as_nanos();
    let _ = tokio::fs::remove_dir_all(&blob_root).await;
    Ok(metrics)
}

/// Model a blob-backed output segment.
///
/// The kernel-facing work is unchanged: every IOPub output still becomes a
/// normal `OutputManifest`, including blob offload for large MIME values. The
/// difference is the durable runtime-state shape: each segment stores a compact
/// ordered child-manifest array in blob storage and appends one segment manifest
/// to RuntimeStateDoc. A production version would need projection/resolution
/// support before clients could consume this shape.
pub async fn measure_blob_segment_output_model(
    config: OutputCommitMeasurementConfig,
) -> anyhow::Result<OutputCommitMeasurement> {
    let blob_root = output_commit_measure_blob_root();
    tokio::fs::create_dir_all(&blob_root)
        .await
        .with_context(|| format!("create blob root {}", blob_root.display()))?;
    let blob_store = BlobStore::new(blob_root.clone());
    let redactor = OutputRedactor::disabled();
    let mut doc = RuntimeStateDoc::new();
    doc.create_execution_with_source(EXECUTION_ID, "pass", 0)?;
    doc.set_execution_running(EXECUTION_ID)?;
    let mut sync_peer = SyncPeer::after_initial_sync(&mut doc)?;

    let started = Instant::now();
    let mut metrics = OutputCommitMeasurement::new("blob_segment_model", config);
    let mut queue = VecDeque::with_capacity(config.output_count);

    for index in 0..config.output_count {
        let iopub_started = Instant::now();
        queue.push_back(QueuedOutput {
            value: measured_output(config.kind, index, config.payload_bytes),
        });
        metrics.iopub_nanos += iopub_started.elapsed().as_nanos();
        metrics.iopub_messages_observed += 1;
        metrics.enqueued_outputs += 1;
    }

    let worker_started = Instant::now();
    let mut child_manifests = Vec::with_capacity(config.output_count);
    while let Some(output) = queue.pop_front() {
        if uses_iopub_buffer_preflight(config.kind) {
            let preflight_started = Instant::now();
            output_store::preflight_ref_buffers(&output.value, &[], &blob_store).await;
            metrics.preflight_nanos += preflight_started.elapsed().as_nanos();
            metrics.buffer_preflights += 1;
        }

        let manifest_started = Instant::now();
        let manifest = output_store::create_manifest_with_redactor(
            &output.value,
            &blob_store,
            DEFAULT_INLINE_THRESHOLD,
            &redactor,
        )
        .await
        .context("create output manifest")?;
        metrics.manifest_nanos += manifest_started.elapsed().as_nanos();
        metrics.manifest_creations += 1;
        child_manifests.push(manifest.to_json());
        metrics.committed_outputs += 1;
    }

    for segment_children in child_manifests.chunks(effective_segment_size(config.segment_size)) {
        let segment_started = Instant::now();
        let segment_payload = serde_json::json!({
            "version": 1,
            "outputs": segment_children,
        });
        let segment_bytes = serde_json::to_vec(&segment_payload)?;
        let segment_hash = blob_store
            .put_with_durability(
                &segment_bytes,
                OUTPUT_SEGMENT_MIME,
                BlobDurability::Ephemeral,
            )
            .await?;
        metrics.segment_write_nanos += segment_started.elapsed().as_nanos();
        metrics.segment_blobs += 1;
        metrics.segment_bytes += segment_bytes.len();

        let first_output_id = segment_children
            .first()
            .and_then(runtime_doc::extract_output_id);
        let last_output_id = segment_children
            .last()
            .and_then(runtime_doc::extract_output_id);
        let segment_manifest = serde_json::json!({
            "output_type": "output_segment",
            "output_id": Uuid::new_v4().to_string(),
            "segment": {
                "blob": segment_hash,
                "size": segment_bytes.len(),
                "media_type": OUTPUT_SEGMENT_MIME,
                "count": segment_children.len(),
                "first_output_id": first_output_id,
                "last_output_id": last_output_id,
            },
        });

        let append_started = Instant::now();
        doc.append_output(EXECUTION_ID, &segment_manifest)?;
        metrics.append_nanos += append_started.elapsed().as_nanos();
        metrics.output_appends += segment_children.len();
        metrics.doc_append_calls += 1;
    }
    metrics.worker_nanos = worker_started.elapsed().as_nanos();

    ensure!(
        doc.get_outputs(EXECUTION_ID).len() == metrics.segment_blobs,
        "blob segment model committed an unexpected number of segment outputs"
    );

    let resolve_started = Instant::now();
    let resolved = resolve_segment_outputs(&doc, EXECUTION_ID, &blob_store).await?;
    metrics.resolve_nanos = resolve_started.elapsed().as_nanos();
    metrics.resolve_count = resolved.len();

    ensure!(
        resolved.len() == config.output_count,
        "blob segment resolve returned {} outputs, expected {}",
        resolved.len(),
        config.output_count
    );

    finalize_doc_metrics(&mut metrics, &mut doc, &mut sync_peer)?;
    metrics.total_nanos = started.elapsed().as_nanos();
    let _ = tokio::fs::remove_dir_all(&blob_root).await;
    Ok(metrics)
}

fn output_commit_measure_blob_root() -> std::path::PathBuf {
    std::env::temp_dir().join(format!("runtimed-output-commit-measure-{}", Uuid::new_v4()))
}

fn effective_segment_size(segment_size: usize) -> usize {
    segment_size.max(1)
}

struct SyncPeer {
    doc: RuntimeStateDoc,
    daemon_state: sync::State,
    peer_state: sync::State,
}

impl SyncPeer {
    fn after_initial_sync(daemon_doc: &mut RuntimeStateDoc) -> anyhow::Result<Self> {
        let mut peer = Self {
            doc: RuntimeStateDoc::new(),
            daemon_state: sync::State::new(),
            peer_state: sync::State::new(),
        };
        sync_runtime_docs(daemon_doc, &mut peer)?;
        Ok(peer)
    }
}

fn finalize_doc_metrics(
    metrics: &mut OutputCommitMeasurement,
    doc: &mut RuntimeStateDoc,
    sync_peer: &mut SyncPeer,
) -> anyhow::Result<()> {
    metrics.durable_output_entries = doc.get_outputs(EXECUTION_ID).len();
    metrics.doc_save_bytes = doc.doc_mut().save().len();

    let sync_started = Instant::now();
    let sync = sync_runtime_docs(doc, sync_peer)?;
    metrics.sync_nanos = sync_started.elapsed().as_nanos();
    metrics.sync_daemon_messages = sync.daemon_messages;
    metrics.sync_daemon_bytes = sync.daemon_bytes;
    metrics.sync_peer_messages = sync.peer_messages;
    metrics.sync_peer_bytes = sync.peer_bytes;
    Ok(())
}

fn sync_runtime_docs(
    daemon_doc: &mut RuntimeStateDoc,
    peer: &mut SyncPeer,
) -> anyhow::Result<SyncMeasurement> {
    let mut stats = SyncMeasurement::default();
    for _ in 0..100 {
        let mut progressed = false;

        if let Some(message) = daemon_doc.generate_sync_message(&mut peer.daemon_state) {
            let encoded = message.clone().encode();
            stats.daemon_messages += 1;
            stats.daemon_bytes += encoded.len();
            peer.doc
                .receive_sync_message_with_changes(&mut peer.peer_state, message)
                .context("peer receive runtime-state sync")?;
            progressed = true;
        }

        if let Some(message) = peer.doc.generate_sync_message(&mut peer.peer_state) {
            let encoded = message.clone().encode();
            stats.peer_messages += 1;
            stats.peer_bytes += encoded.len();
            daemon_doc
                .receive_sync_message_with_changes(&mut peer.daemon_state, message)
                .context("daemon receive runtime-state sync")?;
            progressed = true;
        }

        if !progressed {
            return Ok(stats);
        }
    }

    anyhow::bail!("runtime-state docs did not converge within 100 sync rounds")
}

fn measured_output(
    kind: OutputCommitKind,
    index: usize,
    payload_bytes: usize,
) -> serde_json::Value {
    match kind {
        OutputCommitKind::DisplayData => {
            let text = measured_payload("display", index, payload_bytes);
            serde_json::json!({
                "output_type": "display_data",
                "data": { "text/plain": text },
                "metadata": {},
            })
        }
        OutputCommitKind::ExecuteResult => {
            let text = measured_payload("execute", index, payload_bytes);
            serde_json::json!({
                "output_type": "execute_result",
                "execution_count": index + 1,
                "data": { "text/plain": text },
                "metadata": {},
            })
        }
        OutputCommitKind::Error => {
            let text = measured_payload("error", index, payload_bytes);
            serde_json::json!({
                "output_type": "error",
                "ename": "MeasuredError",
                "evalue": text,
                "traceback": [text],
            })
        }
    }
}

fn uses_iopub_buffer_preflight(kind: OutputCommitKind) -> bool {
    matches!(
        kind,
        OutputCommitKind::DisplayData | OutputCommitKind::ExecuteResult
    )
}

fn measured_payload(prefix: &str, index: usize, payload_bytes: usize) -> String {
    let prefix = format!("{prefix}-{index:06}:");
    let padding_len = payload_bytes.saturating_sub(prefix.len());
    format!("{prefix}{}", "x".repeat(padding_len))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn current_output_commit_loop_commits_each_message() {
        let metrics = measure_current_output_commit_loop(OutputCommitMeasurementConfig {
            output_count: 4,
            payload_bytes: 16,
            kind: OutputCommitKind::DisplayData,
            ..Default::default()
        })
        .await
        .expect("measurement should run");

        assert_eq!(metrics.iopub_messages_observed, 4);
        assert_eq!(metrics.buffer_preflights, 4);
        assert_eq!(metrics.manifest_creations, 4);
        assert_eq!(metrics.output_appends, 4);
        assert_eq!(metrics.doc_append_calls, 4);
        assert_eq!(metrics.committed_outputs, 4);
        assert_eq!(metrics.enqueued_outputs, 0);
        assert_eq!(metrics.durable_output_entries, 4);
        assert!(metrics.doc_save_bytes > 0);
        assert!(metrics.sync_daemon_bytes > 0);
    }

    #[tokio::test]
    async fn ordered_worker_model_commits_each_message() {
        let metrics = measure_ordered_worker_output_commit_model(OutputCommitMeasurementConfig {
            output_count: 4,
            payload_bytes: 16,
            kind: OutputCommitKind::ExecuteResult,
            ..Default::default()
        })
        .await
        .expect("measurement should run");

        assert_eq!(metrics.iopub_messages_observed, 4);
        assert_eq!(metrics.enqueued_outputs, 4);
        assert_eq!(metrics.buffer_preflights, 4);
        assert_eq!(metrics.manifest_creations, 4);
        assert_eq!(metrics.output_appends, 4);
        assert_eq!(metrics.doc_append_calls, 1);
        assert_eq!(metrics.committed_outputs, 4);
        assert_eq!(metrics.durable_output_entries, 4);
        assert!(metrics.doc_save_bytes > 0);
        assert!(metrics.sync_daemon_bytes > 0);
    }

    #[tokio::test]
    async fn blob_segment_model_reduces_durable_output_entries() {
        let metrics = measure_blob_segment_output_model(OutputCommitMeasurementConfig {
            output_count: 5,
            payload_bytes: 16,
            kind: OutputCommitKind::DisplayData,
            segment_size: 2,
        })
        .await
        .expect("measurement should run");

        assert_eq!(metrics.iopub_messages_observed, 5);
        assert_eq!(metrics.enqueued_outputs, 5);
        assert_eq!(metrics.manifest_creations, 5);
        assert_eq!(metrics.output_appends, 5);
        assert_eq!(metrics.doc_append_calls, 3);
        assert_eq!(metrics.committed_outputs, 5);
        assert_eq!(metrics.segment_blobs, 3);
        assert_eq!(metrics.durable_output_entries, 3);
        assert!(metrics.segment_bytes > 0);
        assert!(metrics.doc_save_bytes > 0);
        assert!(metrics.sync_daemon_bytes > 0);
        assert_eq!(metrics.resolve_count, 5);
        assert!(metrics.resolve_nanos > 0);
    }
}
