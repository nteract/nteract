//! Live views of session-backed outputs for output summaries.
//!
//! Each provider follows its own sessions over this notebook connection and
//! returns views keyed by output id; the resolver prefers them over the
//! output's saved payload.

use std::path::Path;

use notebook_sync::handle::DocHandle;
use runtimed_outputs::output_resolver::LiveOutputViews;

/// Live views for the outputs among `manifests` that have one.
pub(crate) async fn collect<'a>(
    handle: &DocHandle,
    manifests: impl IntoIterator<Item = &'a serde_json::Value>,
    blob_base_url: Option<&str>,
    blob_store_path: Option<&Path>,
) -> LiveOutputViews {
    let manifests: Vec<&serde_json::Value> = manifests.into_iter().collect();
    let mut views = LiveOutputViews::new();
    views.extend(
        crate::bokeh::session_views(handle, &manifests, blob_base_url, blob_store_path).await,
    );
    views
}
