//! Materialize a session document into Bokeh DocJson for the saved output.
//!
//! A frozen or saved session must render without the session document, so
//! the output's session payload carries the materialized DocJson as its
//! `document`, with columns and blob-backed values inlined and the
//! duplicate `session_doc` removed.

use std::collections::{BTreeMap, HashSet};

use runtime_doc::{BokehBlobRef, BokehSessionSnapshot, RuntimeStateHandle, BOKEH_SESSION_MIME};
use serde_json::{json, Map, Value};

use crate::blob_store::BlobStore;
use crate::output_blob_publisher::OutputBlobPublisher;
use crate::output_store::ContentRef;

/// Decode a stored value, reading it from the blob store when offloaded.
pub(crate) async fn resolve_value(encoded: &str, blob_store: &BlobStore) -> anyhow::Result<Value> {
    let text = match BokehBlobRef::parse(encoded) {
        Some(blob) => {
            let bytes = blob_store
                .get(&blob.blob)
                .await?
                .ok_or_else(|| anyhow::anyhow!("Bokeh value blob {} is missing", blob.blob))?;
            String::from_utf8(bytes)?
        }
        None => encoded.to_string(),
    };
    Ok(serde_json::from_str(&text)?)
}

/// Bokeh DocJson for the snapshot: roots expanded depth-first, each model
/// defined at its first reference, unreachable models dropped.
pub(crate) async fn materialize_doc_json(
    snapshot: &BokehSessionSnapshot,
    blob_store: &BlobStore,
) -> anyhow::Result<Value> {
    let mut models: BTreeMap<String, (String, Map<String, Value>)> = BTreeMap::new();
    for (id, model) in &snapshot.models {
        let mut attributes = Map::new();
        for (name, encoded) in &model.props {
            attributes.insert(name.clone(), resolve_value(encoded, blob_store).await?);
        }
        if let Some(columns) = snapshot.columns.get(id) {
            let mut entries = Vec::with_capacity(columns.len());
            for (name, column) in columns {
                let bytes = blob_store.get(&column.blob).await?.ok_or_else(|| {
                    anyhow::anyhow!("Bokeh column blob {} is missing", column.blob)
                })?;
                entries.push(json!([name, serde_json::from_slice::<Value>(&bytes)?]));
            }
            attributes.insert(
                "data".to_string(),
                json!({"type": "map", "entries": entries}),
            );
        }
        models.insert(id.clone(), (model.type_name.clone(), attributes));
    }

    let mut emitted = HashSet::new();
    let roots = snapshot
        .meta
        .root_ids
        .iter()
        .filter(|id| models.contains_key(*id))
        .map(|id| expand_model(id, &models, &mut emitted))
        .collect::<Vec<_>>();

    let mut doc = Map::new();
    if let Some(extras) = &snapshot.meta.doc_extras {
        if let Value::Object(extras) = resolve_value(extras, blob_store).await? {
            doc.extend(extras);
        }
    }
    doc.insert("version".to_string(), json!(snapshot.meta.bokeh_version));
    if let Some(title) = &snapshot.meta.title {
        doc.insert("title".to_string(), json!(title));
    }
    doc.insert("roots".to_string(), Value::Array(roots));
    Ok(Value::Object(doc))
}

fn expand_model(
    id: &str,
    models: &BTreeMap<String, (String, Map<String, Value>)>,
    emitted: &mut HashSet<String>,
) -> Value {
    if !emitted.insert(id.to_string()) {
        return json!({"id": id});
    }
    let (type_name, attributes) = &models[id];
    let attributes: Map<String, Value> = attributes
        .iter()
        .map(|(name, value)| (name.clone(), expand_refs(value, models, emitted)))
        .collect();
    json!({"type": "object", "name": type_name, "id": id, "attributes": attributes})
}

fn expand_refs(
    value: &Value,
    models: &BTreeMap<String, (String, Map<String, Value>)>,
    emitted: &mut HashSet<String>,
) -> Value {
    match value {
        Value::Object(map) => {
            if map.len() == 1 {
                if let Some(id) = map.get("id").and_then(Value::as_str) {
                    if models.contains_key(id) {
                        return expand_model(id, models, emitted);
                    }
                }
            }
            Value::Object(
                map.iter()
                    .map(|(key, value)| (key.clone(), expand_refs(value, models, emitted)))
                    .collect(),
            )
        }
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| expand_refs(item, models, emitted))
                .collect(),
        ),
        other => other.clone(),
    }
}

/// The output's session payload with `document` replaced by the frozen
/// state. Buffers are inlined, so the descriptor list is emptied.
pub(crate) async fn frozen_payload(
    payload: &Value,
    snapshot: &BokehSessionSnapshot,
    blob_store: &BlobStore,
) -> anyhow::Result<Value> {
    let mut payload = payload.clone();
    let object = payload
        .as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("Bokeh session payload must be an object"))?;
    object.insert(
        "document".to_string(),
        materialize_doc_json(snapshot, blob_store).await?,
    );
    object.insert("buffers".to_string(), json!([]));
    object.remove("session_doc");
    object.remove("session_doc_buffers");
    Ok(payload)
}

/// On kernel loss, write the frozen payload as a blob and point the
/// session's output at it, so reloads render the last state read-only.
pub(crate) async fn freeze_session_output(
    session_id: &str,
    snapshot: &BokehSessionSnapshot,
    state: &RuntimeStateHandle,
    actor: Option<&str>,
    blob_store: &BlobStore,
    blob_publisher: &OutputBlobPublisher,
) -> anyhow::Result<()> {
    let Some(record) = state.read(|doc| doc.get_bokeh_session(session_id))? else {
        anyhow::bail!("unknown Bokeh session {session_id}");
    };
    let Some(mut manifest) = state
        .read(|doc| doc.get_outputs(&record.execution_id))?
        .into_iter()
        .find(|output| output.get("output_id").and_then(Value::as_str) == Some(&record.output_id))
    else {
        anyhow::bail!("Bokeh session {session_id} has no output");
    };
    let content: ContentRef = serde_json::from_value(
        manifest
            .get("data")
            .and_then(|data| data.get(BOKEH_SESSION_MIME))
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("output for {session_id} has no session payload"))?,
    )?;
    let payload: Value = serde_json::from_str(&content.resolve(blob_store).await?)?;
    let frozen = serde_json::to_vec(&frozen_payload(&payload, snapshot, blob_store).await?)?;
    let hash = blob_store.put(&frozen, BOKEH_SESSION_MIME).await?;
    blob_publisher
        .publish_artifact(
            hash.clone(),
            frozen.len() as u64,
            BOKEH_SESSION_MIME.to_string(),
            blob_store,
        )
        .await?;
    manifest["data"][BOKEH_SESSION_MIME] = serde_json::to_value(ContentRef::Blob {
        blob: hash,
        size: frozen.len() as u64,
    })?;
    state.transact_at_current_heads(actor, "runtime-state-bokeh-freeze", |doc| {
        doc.replace_output(&record.execution_id, &record.output_id, &manifest)
            .map(|_| ())
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use runtime_doc::{BokehColumnRef, BokehModelState, BokehSessionMeta};

    #[tokio::test]
    async fn doc_json_expands_roots_and_inlines_columns_and_blobs() {
        let dir = tempfile::TempDir::new().unwrap();
        let blobs = BlobStore::new(dir.path().to_path_buf());
        let column = blobs.put(br#"[1,2,3]"#, "application/json").await.unwrap();
        let title = blobs
            .put(br#""A long title""#, "application/json")
            .await
            .unwrap();
        let model = |type_name: &str, props: &[(&str, String)]| BokehModelState {
            type_name: type_name.into(),
            ref_props: Vec::new(),
            props: props
                .iter()
                .map(|(k, v)| (k.to_string(), v.clone()))
                .collect(),
        };
        let snapshot = BokehSessionSnapshot {
            epoch: 3,
            meta: BokehSessionMeta {
                bokeh_version: "3.9.2".into(),
                root_ids: vec!["p1".into()],
                title: Some("Page".into()),
                doc_extras: Some(r#"{"defs":[]}"#.into()),
                ..Default::default()
            },
            models: BTreeMap::from([
                (
                    "p1".to_string(),
                    model(
                        "Row",
                        &[(
                            "children",
                            r#"[{"id":"p2"},{"id":"p3"},{"id":"p2"}]"#.into(),
                        )],
                    ),
                ),
                (
                    "p2".to_string(),
                    model(
                        "Div",
                        &[(
                            "text",
                            BokehBlobRef {
                                blob: title,
                                size: 14,
                                media_type: "application/json".into(),
                            }
                            .encode(),
                        )],
                    ),
                ),
                ("p3".to_string(), model("ColumnDataSource", &[])),
                ("orphan".to_string(), model("Div", &[])),
            ]),
            columns: BTreeMap::from([(
                "p3".to_string(),
                BTreeMap::from([(
                    "x".to_string(),
                    BokehColumnRef {
                        blob: column,
                        size: 7,
                        version: 4,
                    },
                )]),
            )]),
        };
        let doc = materialize_doc_json(&snapshot, &blobs).await.unwrap();
        assert_eq!(doc["version"], "3.9.2");
        assert_eq!(doc["title"], "Page");
        assert_eq!(doc["defs"], json!([]));
        let root = &doc["roots"][0];
        assert_eq!(root["name"], "Row");
        let children = &root["attributes"]["children"];
        assert_eq!(children[0]["attributes"]["text"], "A long title");
        assert_eq!(
            children[1]["attributes"]["data"]["entries"][0],
            json!(["x", [1, 2, 3]])
        );
        assert_eq!(
            children[2],
            json!({"id": "p2"}),
            "later references stay refs"
        );
        assert!(!doc.to_string().contains("orphan"));

        let payload =
            json!({"session_id": "s", "document": {}, "session_doc": {}, "buffers": [{"id": "b"}]});
        let frozen = frozen_payload(&payload, &snapshot, &blobs).await.unwrap();
        assert_eq!(frozen["document"], doc);
        assert_eq!(frozen["buffers"], json!([]));
        assert!(frozen.get("session_doc").is_none());
    }
}
