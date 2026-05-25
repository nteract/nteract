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
use runtime_doc::RuntimeStateDoc;
use serde::Serialize;
use uuid::Uuid;

use crate::blob_store::BlobStore;
use crate::output_redaction::OutputRedactor;
use crate::output_store::{self, DEFAULT_INLINE_THRESHOLD};

const EXECUTION_ID: &str = "exec-output-commit-measure";

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
}

impl Default for OutputCommitMeasurementConfig {
    fn default() -> Self {
        Self {
            output_count: 100,
            payload_bytes: 256,
            kind: OutputCommitKind::DisplayData,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct OutputCommitMeasurement {
    pub strategy: &'static str,
    pub output_count: usize,
    pub payload_bytes: usize,
    pub kind: OutputCommitKind,
    pub iopub_messages_observed: usize,
    pub buffer_preflights: usize,
    pub manifest_creations: usize,
    pub output_appends: usize,
    pub enqueued_outputs: usize,
    pub committed_outputs: usize,
    pub iopub_nanos: u128,
    pub preflight_nanos: u128,
    pub manifest_nanos: u128,
    pub append_nanos: u128,
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
            iopub_messages_observed: 0,
            buffer_preflights: 0,
            manifest_creations: 0,
            output_appends: 0,
            enqueued_outputs: 0,
            committed_outputs: 0,
            iopub_nanos: 0,
            preflight_nanos: 0,
            manifest_nanos: 0,
            append_nanos: 0,
            worker_nanos: 0,
            total_nanos: 0,
        }
    }
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
        metrics.committed_outputs += 1;
        metrics.iopub_nanos += iopub_started.elapsed().as_nanos();
        metrics.iopub_messages_observed += 1;
    }

    ensure!(
        doc.get_outputs(EXECUTION_ID).len() == config.output_count,
        "current output commit loop committed an unexpected number of outputs"
    );
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

        let append_started = Instant::now();
        doc.append_output(EXECUTION_ID, &manifest.to_json())?;
        metrics.append_nanos += append_started.elapsed().as_nanos();
        metrics.output_appends += 1;
        metrics.committed_outputs += 1;
    }
    metrics.worker_nanos = worker_started.elapsed().as_nanos();

    ensure!(
        doc.get_outputs(EXECUTION_ID).len() == config.output_count,
        "ordered worker model committed an unexpected number of outputs"
    );
    metrics.total_nanos = started.elapsed().as_nanos();
    let _ = tokio::fs::remove_dir_all(&blob_root).await;
    Ok(metrics)
}

fn output_commit_measure_blob_root() -> std::path::PathBuf {
    std::env::temp_dir().join(format!("runtimed-output-commit-measure-{}", Uuid::new_v4()))
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
        })
        .await
        .expect("measurement should run");

        assert_eq!(metrics.iopub_messages_observed, 4);
        assert_eq!(metrics.buffer_preflights, 4);
        assert_eq!(metrics.manifest_creations, 4);
        assert_eq!(metrics.output_appends, 4);
        assert_eq!(metrics.committed_outputs, 4);
        assert_eq!(metrics.enqueued_outputs, 0);
    }

    #[tokio::test]
    async fn ordered_worker_model_commits_each_message() {
        let metrics = measure_ordered_worker_output_commit_model(OutputCommitMeasurementConfig {
            output_count: 4,
            payload_bytes: 16,
            kind: OutputCommitKind::ExecuteResult,
        })
        .await
        .expect("measurement should run");

        assert_eq!(metrics.iopub_messages_observed, 4);
        assert_eq!(metrics.enqueued_outputs, 4);
        assert_eq!(metrics.buffer_preflights, 4);
        assert_eq!(metrics.manifest_creations, 4);
        assert_eq!(metrics.output_appends, 4);
        assert_eq!(metrics.committed_outputs, 4);
    }
}
