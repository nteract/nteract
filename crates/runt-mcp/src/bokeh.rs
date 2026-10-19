//! Live Bokeh session documents for output summaries.
//!
//! The daemon's hub replica is reached the way a browser reaches it: the
//! notebook connection subscribes to a session over frame `0x0b` and keeps a
//! replica (`notebook_sync::bokeh`), so summaries read current state and the
//! write tool goes through the hub's normal ingress checks.

use std::path::Path;
use std::time::Duration;

use notebook_sync::handle::DocHandle;
use runtime_doc::BokehSessionStatus;
use runtimed_outputs::bokeh_summary::{self, BokehSessionViews, BOKEH_SESSION_MIME};
use runtimed_outputs::output_resolver::ResolveCtx;

/// First sync of a connected session; later reads use the pushed replica.
const CONNECTED_SYNC_TIMEOUT: Duration = Duration::from_millis(1500);
/// The hub may no longer hold an ended session; the saved document covers it.
const ENDED_SYNC_TIMEOUT: Duration = Duration::from_millis(250);

/// Views for the Bokeh session outputs among `manifests`, keyed by output id.
pub(crate) async fn session_views<'a>(
    handle: &DocHandle,
    manifests: impl IntoIterator<Item = &'a serde_json::Value>,
    blob_base_url: Option<&str>,
    blob_store_path: Option<&Path>,
) -> BokehSessionViews {
    let mut views = BokehSessionViews::new();
    let output_ids: Vec<&str> = manifests
        .into_iter()
        .filter(|manifest| {
            manifest
                .get("data")
                .is_some_and(|data| data.get(BOKEH_SESSION_MIME).is_some())
        })
        .filter_map(|manifest| manifest.get("output_id")?.as_str())
        .collect();
    if output_ids.is_empty() {
        return views;
    }
    let Ok(state) = handle.get_runtime_state() else {
        return views;
    };
    for (session_id, record) in state.bokeh_sessions {
        if !output_ids.contains(&record.output_id.as_str()) {
            continue;
        }
        let timeout = if record.status == BokehSessionStatus::Connected {
            CONNECTED_SYNC_TIMEOUT
        } else {
            ENDED_SYNC_TIMEOUT
        };
        let snapshot = handle
            .await_bokeh_session(&session_id, record.epoch, timeout)
            .await
            .ok()
            .flatten();
        let view = bokeh_summary::prepare_bokeh_view(
            &session_id,
            record.status,
            record.epoch,
            snapshot,
            ResolveCtx {
                blob_base_url,
                blob_store_path,
                ..Default::default()
            },
        )
        .await;
        views.insert(record.output_id, view);
    }
    views
}
