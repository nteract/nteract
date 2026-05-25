//! Reproducible measurements for the current Output widget replay loop.
//!
//! This module intentionally models the shape of the current IOPub OutputModel
//! replay path without changing production behavior: append a captured output
//! manifest to `RuntimeStateDoc.comms[*].outputs`, mirror the full outputs list
//! into comm state, resolve every manifest, then enqueue one kernel-facing
//! replay update.

use std::collections::HashMap;
use std::time::Instant;

use anyhow::Context;
use runtime_doc::RuntimeStateDoc;
use serde::Serialize;
use uuid::Uuid;

use crate::blob_store::BlobStore;
use crate::output_store::{self, OutputManifest, DEFAULT_INLINE_THRESHOLD};

const COMM_ID: &str = "comm-output-replay-measure";

#[derive(Debug, Clone, Copy)]
pub struct ReplayMeasurementConfig {
    pub output_count: usize,
    pub payload_bytes: usize,
}

impl Default for ReplayMeasurementConfig {
    fn default() -> Self {
        Self {
            output_count: 100,
            payload_bytes: 256,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ReplayMeasurement {
    pub output_count: usize,
    pub payload_bytes: usize,
    pub comm_output_appends: usize,
    pub comm_state_mirrors: usize,
    pub replay_updates: usize,
    pub manifest_resolutions: usize,
    pub resolved_outputs_sent: usize,
    pub append_nanos: u128,
    pub mirror_nanos: u128,
    pub resolve_nanos: u128,
    pub total_nanos: u128,
}

impl ReplayMeasurement {
    fn new(config: ReplayMeasurementConfig) -> Self {
        Self {
            output_count: config.output_count,
            payload_bytes: config.payload_bytes,
            comm_output_appends: 0,
            comm_state_mirrors: 0,
            replay_updates: 0,
            manifest_resolutions: 0,
            resolved_outputs_sent: 0,
            append_nanos: 0,
            mirror_nanos: 0,
            resolve_nanos: 0,
            total_nanos: 0,
        }
    }
}

pub async fn measure_current_replay_loop(
    config: ReplayMeasurementConfig,
) -> anyhow::Result<ReplayMeasurement> {
    let blob_root = std::env::temp_dir().join(format!(
        "runtimed-output-widget-replay-measure-{}",
        Uuid::new_v4()
    ));
    tokio::fs::create_dir_all(&blob_root)
        .await
        .with_context(|| format!("create blob root {}", blob_root.display()))?;
    let blob_store = BlobStore::new(blob_root.clone());

    let started = Instant::now();
    let mut metrics = ReplayMeasurement::new(config);
    let mut doc = RuntimeStateDoc::new();
    doc.put_comm(
        COMM_ID,
        "jupyter.widget",
        "@jupyter-widgets/output",
        "OutputModel",
        &serde_json::json!({ "outputs": [] }),
        0,
    )?;

    for index in 0..config.output_count {
        let output = captured_stream_output(index, config.payload_bytes);
        let manifest =
            output_store::create_manifest(&output, &blob_store, DEFAULT_INLINE_THRESHOLD)
                .await
                .context("create output manifest")?;
        let manifest_json = manifest.to_json();

        let append_started = Instant::now();
        doc.append_comm_output(COMM_ID, &manifest_json)?;
        metrics.append_nanos += append_started.elapsed().as_nanos();
        metrics.comm_output_appends += 1;

        let mirror_started = Instant::now();
        let output_manifests = doc
            .get_comm(COMM_ID)
            .map(|entry| entry.outputs)
            .unwrap_or_default();
        doc.set_comm_state_property(
            COMM_ID,
            "outputs",
            &serde_json::Value::Array(output_manifests.clone()),
        )?;
        metrics.mirror_nanos += mirror_started.elapsed().as_nanos();
        metrics.comm_state_mirrors += 1;

        let resolve_started = Instant::now();
        let mut resolved_outputs = Vec::with_capacity(output_manifests.len());
        for output_manifest in output_manifests {
            let manifest: OutputManifest =
                serde_json::from_value(output_manifest).context("parse output manifest")?;
            let resolved = output_store::resolve_manifest(&manifest, &blob_store)
                .await
                .context("resolve output manifest")?;
            resolved_outputs.push(resolved);
            metrics.manifest_resolutions += 1;
        }
        metrics.resolve_nanos += resolve_started.elapsed().as_nanos();
        metrics.resolved_outputs_sent += resolved_outputs.len();
        metrics.replay_updates += 1;
    }

    metrics.total_nanos = started.elapsed().as_nanos();
    let _ = tokio::fs::remove_dir_all(&blob_root).await;
    Ok(metrics)
}

pub async fn measure_cached_replay_loop(
    config: ReplayMeasurementConfig,
) -> anyhow::Result<ReplayMeasurement> {
    let blob_root = std::env::temp_dir().join(format!(
        "runtimed-output-widget-replay-measure-{}",
        Uuid::new_v4()
    ));
    tokio::fs::create_dir_all(&blob_root)
        .await
        .with_context(|| format!("create blob root {}", blob_root.display()))?;
    let blob_store = BlobStore::new(blob_root.clone());

    let started = Instant::now();
    let mut metrics = ReplayMeasurement::new(config);
    let mut doc = RuntimeStateDoc::new();
    let mut resolved_output_cache: HashMap<String, Vec<serde_json::Value>> = HashMap::new();
    doc.put_comm(
        COMM_ID,
        "jupyter.widget",
        "@jupyter-widgets/output",
        "OutputModel",
        &serde_json::json!({ "outputs": [] }),
        0,
    )?;

    for index in 0..config.output_count {
        let output = captured_stream_output(index, config.payload_bytes);
        let manifest =
            output_store::create_manifest(&output, &blob_store, DEFAULT_INLINE_THRESHOLD)
                .await
                .context("create output manifest")?;
        let manifest_json = manifest.to_json();

        let append_started = Instant::now();
        doc.append_comm_output(COMM_ID, &manifest_json)?;
        metrics.append_nanos += append_started.elapsed().as_nanos();
        metrics.comm_output_appends += 1;

        let mirror_started = Instant::now();
        let output_manifests = doc
            .get_comm(COMM_ID)
            .map(|entry| entry.outputs)
            .unwrap_or_default();
        doc.set_comm_state_property(
            COMM_ID,
            "outputs",
            &serde_json::Value::Array(output_manifests.clone()),
        )?;
        metrics.mirror_nanos += mirror_started.elapsed().as_nanos();
        metrics.comm_state_mirrors += 1;

        let resolve_started = Instant::now();
        let cached_outputs = resolved_output_cache
            .entry(COMM_ID.to_string())
            .or_default();
        if cached_outputs.len() + 1 == output_manifests.len() {
            let resolved = output_store::resolve_manifest(&manifest, &blob_store)
                .await
                .context("resolve appended output manifest")?;
            cached_outputs.push(resolved);
            metrics.manifest_resolutions += 1;
        } else {
            cached_outputs.clear();
            for output_manifest in &output_manifests {
                let manifest: OutputManifest = serde_json::from_value(output_manifest.clone())
                    .context("parse output manifest")?;
                let resolved = output_store::resolve_manifest(&manifest, &blob_store)
                    .await
                    .context("resolve output manifest")?;
                cached_outputs.push(resolved);
                metrics.manifest_resolutions += 1;
            }
        }
        metrics.resolve_nanos += resolve_started.elapsed().as_nanos();
        metrics.resolved_outputs_sent += cached_outputs.len();
        metrics.replay_updates += 1;
    }

    metrics.total_nanos = started.elapsed().as_nanos();
    let _ = tokio::fs::remove_dir_all(&blob_root).await;
    Ok(metrics)
}

fn captured_stream_output(index: usize, payload_bytes: usize) -> serde_json::Value {
    let prefix = format!("captured-{index:06}:");
    let padding_len = payload_bytes.saturating_sub(prefix.len() + 1);
    let text = format!("{prefix}{}\n", "x".repeat(padding_len));
    serde_json::json!({
        "output_type": "stream",
        "name": "stdout",
        "text": text,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn measurement_records_triangular_resolve_work_for_current_replay_loop() {
        let metrics = measure_current_replay_loop(ReplayMeasurementConfig {
            output_count: 4,
            payload_bytes: 16,
        })
        .await
        .expect("measurement should run");

        assert_eq!(metrics.output_count, 4);
        assert_eq!(metrics.comm_output_appends, 4);
        assert_eq!(metrics.comm_state_mirrors, 4);
        assert_eq!(metrics.replay_updates, 4);
        assert_eq!(metrics.manifest_resolutions, 10);
        assert_eq!(metrics.resolved_outputs_sent, 10);
    }

    #[tokio::test]
    async fn cached_replay_resolves_each_manifest_once() {
        let metrics = measure_cached_replay_loop(ReplayMeasurementConfig {
            output_count: 4,
            payload_bytes: 16,
        })
        .await
        .expect("measurement should run");

        assert_eq!(metrics.output_count, 4);
        assert_eq!(metrics.comm_output_appends, 4);
        assert_eq!(metrics.comm_state_mirrors, 4);
        assert_eq!(metrics.replay_updates, 4);
        assert_eq!(metrics.manifest_resolutions, 4);
        assert_eq!(metrics.resolved_outputs_sent, 10);
    }
}
