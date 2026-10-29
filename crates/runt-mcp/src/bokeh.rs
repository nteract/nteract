//! Live Bokeh session documents for output summaries.
//!
//! The daemon's hub replica is reached the way a browser reaches it: the
//! notebook connection subscribes to a session over frame `0x0b` and keeps a
//! replica (`notebook_sync::bokeh`), so summaries read current state and the
//! write tool goes through the hub's normal ingress checks.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use notebook_sync::handle::DocHandle;
use notebook_sync::BokehDocHandleExt;
use runtime_doc::BokehSessionStatus;
use runtimed_outputs::bokeh_summary::{self, BOKEH_SESSION_MIME};
use runtimed_outputs::output_resolver::{LiveOutputView, ResolveCtx};
use tokio::task::JoinSet;

/// How long one summary waits for the first sync of its connected sessions,
/// all together; later reads use the pushed replica.
const CONNECTED_SYNC_TIMEOUT: Duration = Duration::from_millis(1500);

/// Views for the Bokeh session outputs among `manifests`, by output id.
///
/// Ended sessions get a view without a document: their saved output already
/// holds the frozen state, and the hub may no longer serve them.
pub(crate) async fn session_views(
    handle: &DocHandle,
    manifests: &[&serde_json::Value],
    blob_base_url: Option<&str>,
    blob_store_path: Option<&Path>,
) -> Vec<(String, Arc<dyn LiveOutputView>)> {
    let output_ids: Vec<&str> = manifests
        .iter()
        .filter(|manifest| {
            manifest
                .get("data")
                .is_some_and(|data| data.get(BOKEH_SESSION_MIME).is_some())
        })
        .filter_map(|manifest| manifest.get("output_id")?.as_str())
        .collect();
    if output_ids.is_empty() {
        return Vec::new();
    }
    let Ok(state) = handle.get_runtime_state() else {
        return Vec::new();
    };
    let deadline = tokio::time::Instant::now() + CONNECTED_SYNC_TIMEOUT;
    let blob_base_url = blob_base_url.map(String::from);
    let blob_store_path = blob_store_path.map(PathBuf::from);
    let mut tasks = JoinSet::new();
    for (session_id, record) in state.bokeh_sessions {
        if !output_ids.contains(&record.output_id.as_str()) {
            continue;
        }
        let handle = handle.clone();
        let blob_base_url = blob_base_url.clone();
        let blob_store_path = blob_store_path.clone();
        tasks.spawn(async move {
            let snapshot = if record.status == BokehSessionStatus::Connected {
                let timeout = deadline.saturating_duration_since(tokio::time::Instant::now());
                handle
                    .await_bokeh_session(&session_id, record.epoch, timeout)
                    .await
                    .ok()
                    .flatten()
            } else {
                None
            };
            let view = bokeh_summary::prepare_bokeh_view(
                &session_id,
                record.status,
                record.epoch,
                snapshot,
                ResolveCtx {
                    blob_base_url: blob_base_url.as_deref(),
                    blob_store_path: blob_store_path.as_deref(),
                    ..Default::default()
                },
            )
            .await;
            (record.output_id, Arc::new(view) as Arc<dyn LiveOutputView>)
        });
    }
    let mut views = Vec::new();
    while let Some(joined) = tasks.join_next().await {
        match joined {
            Ok(view) => views.push(view),
            Err(error) => tracing::warn!("[bokeh] session summary task failed: {error}"),
        }
    }
    views
}
