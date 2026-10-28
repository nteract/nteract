//! Equality across the documented runtime-manifest / nbformat transport boundary.
//!
//! Only output-envelope fields are disposable. MIME payloads and metadata retain
//! unknown fields, array order, and explicit types. Blob I/O is supplied by the
//! owner so this policy is shared without coupling the client to daemon storage.
use std::{future::Future, io};

use serde::Deserialize;
use serde_json::Value;

use notebook_doc::mime::ARROW_STREAM_MANIFEST_MIME as ARROW_MANIFEST;
const ARROW_STREAM: &str = "application/vnd.apache.arrow.stream";

#[derive(Debug, PartialEq, Eq)]
pub enum OutputComparison {
    Equivalent,
    Different,
    /// Required content could not be read; this is not evidence of a conflict.
    Unavailable(String),
}

#[derive(Deserialize)]
#[serde(untagged, deny_unknown_fields)]
enum ContentRef {
    Inline { inline: String },
    Blob { blob: String, size: u64 },
}

/// Top-level MIME payload keys that may differ between a durable execution
/// record and a saved output, e.g. live state written only at save time.
/// Fields must be static per MIME so a payload cannot widen its own exemption.
/// Only JSON MIME types (`application/json`, `*+json`) are exempted; others
/// stay byte-strict whatever they declare.
pub trait ReplayFieldPolicy: Sync {
    fn mutable_fields(&self, mime: &str) -> &'static [&'static str];
}

/// Every payload key is compared.
pub struct StrictReplayFields;

impl ReplayFieldPolicy for StrictReplayFields {
    fn mutable_fields(&self, _mime: &str) -> &'static [&'static str] {
        &[]
    }
}

/// Compare output manifests, resolving unequal content references as needed.
/// Equal blob references require no read: their hash and size already agree.
pub async fn compare_outputs<F, Fut>(
    left: &[Value],
    right: &[Value],
    resolve: F,
) -> OutputComparison
where
    F: Fn(String) -> Fut,
    Fut: Future<Output = io::Result<Option<Vec<u8>>>>,
{
    compare_outputs_with_policy(left, right, resolve, &StrictReplayFields).await
}

/// [`compare_outputs`], ignoring the top-level keys `policy` declares mutable
/// for each JSON MIME of `display_data`/`execute_result` payloads. Everything else,
/// including other keys of the same payload, stays strict.
pub async fn compare_outputs_with_policy<F, Fut>(
    left: &[Value],
    right: &[Value],
    resolve: F,
    policy: &dyn ReplayFieldPolicy,
) -> OutputComparison
where
    F: Fn(String) -> Fut,
    Fut: Future<Output = io::Result<Option<Vec<u8>>>>,
{
    if left.len() != right.len() {
        return OutputComparison::Different;
    }
    let mut unavailable = None;
    for (left, right) in left.iter().zip(right) {
        let (Some(mut left), Some(mut right)) =
            (left.as_object().cloned(), right.as_object().cloned())
        else {
            if left != right {
                return OutputComparison::Different;
            }
            continue;
        };
        strip_runtime_fields(&mut left);
        strip_runtime_fields(&mut right);
        if left.len() != right.len() || left.keys().any(|key| !right.contains_key(key)) {
            return OutputComparison::Different;
        }
        for (key, value) in &left {
            let other = &right[key];
            let result = match (
                left.get("output_type").and_then(Value::as_str),
                key.as_str(),
            ) {
                (Some("display_data" | "execute_result"), "data") => {
                    let (Some(a), Some(b)) = (value.as_object(), other.as_object()) else {
                        return OutputComparison::Different;
                    };
                    if a.len() != b.len() || a.keys().any(|key| !b.contains_key(key)) {
                        return OutputComparison::Different;
                    }
                    for (mime, a) in a {
                        let result = compare_content(
                            a,
                            &b[mime],
                            mime,
                            policy.mutable_fields(mime),
                            &resolve,
                        )
                        .await;
                        match result {
                            OutputComparison::Different => return OutputComparison::Different,
                            OutputComparison::Unavailable(reason) => {
                                unavailable.get_or_insert(reason);
                            }
                            OutputComparison::Equivalent => {}
                        }
                    }
                    OutputComparison::Equivalent
                }
                (Some("stream"), "text") => {
                    compare_content(value, other, "text/plain", &[], &resolve).await
                }
                (Some("error"), "traceback") => {
                    compare_content(value, other, "application/json", &[], &resolve).await
                }
                _ if value == other => OutputComparison::Equivalent,
                _ => OutputComparison::Different,
            };
            match result {
                OutputComparison::Different => return OutputComparison::Different,
                OutputComparison::Unavailable(reason) => {
                    unavailable.get_or_insert(reason);
                }
                OutputComparison::Equivalent => {}
            }
        }
    }
    unavailable.map_or(OutputComparison::Equivalent, OutputComparison::Unavailable)
}

pub(crate) fn strip_runtime_fields(output: &mut serde_json::Map<String, Value>) {
    output.remove("output_id");
    match output.get("output_type").and_then(Value::as_str) {
        Some("error") => {
            output.remove("rich");
            output.remove("llm_preview");
        }
        Some("stream") => {
            output.remove("llm_preview");
        }
        _ => {}
    }
}

async fn compare_content<F, Fut>(
    left: &Value,
    right: &Value,
    mime: &str,
    mutable_fields: &[&str],
    resolve: &F,
) -> OutputComparison
where
    F: Fn(String) -> Fut,
    Fut: Future<Output = io::Result<Option<Vec<u8>>>>,
{
    if left == right {
        return OutputComparison::Equivalent;
    }
    let (Ok(a), Ok(b)) = (
        serde_json::from_value::<ContentRef>(left.clone()),
        serde_json::from_value::<ContentRef>(right.clone()),
    ) else {
        return OutputComparison::Different;
    };
    if let (ContentRef::Blob { blob: a, size: sa }, ContentRef::Blob { blob: b, size: sb }) =
        (&a, &b)
    {
        if a == b && sa != sb {
            return OutputComparison::Different;
        }
    }
    let a = match resolve_content(a, resolve).await {
        Ok(a) => a,
        Err(result) => return result,
    };
    let b = match resolve_content(b, resolve).await {
        Ok(b) => b,
        Err(result) => return result,
    };
    let is_json = mime == "application/json" || mime.ends_with("+json");
    let equal = if !is_json {
        a == b
    } else if let Some(equal) = equal_except_fields(&a, &b, mutable_fields) {
        equal
    } else {
        match (
            serde_json::from_slice::<Value>(&a),
            serde_json::from_slice::<Value>(&b),
        ) {
            (Ok(mut a), Ok(mut b)) => {
                if mime == ARROW_MANIFEST {
                    normalize_arrow_refs(&mut a);
                    normalize_arrow_refs(&mut b);
                }
                a == b
            }
            _ => a == b,
        }
    };
    if equal {
        OutputComparison::Equivalent
    } else {
        OutputComparison::Different
    }
}

/// `None` when there is nothing to exempt or either side is not a JSON object;
/// the caller then compares strictly.
fn equal_except_fields(a: &[u8], b: &[u8], fields: &[&str]) -> Option<bool> {
    if fields.is_empty() {
        return None;
    }
    let (Ok(Value::Object(mut a)), Ok(Value::Object(mut b))) =
        (serde_json::from_slice(a), serde_json::from_slice(b))
    else {
        return None;
    };
    for field in fields {
        a.remove(*field);
        b.remove(*field);
    }
    Some(a == b)
}

async fn resolve_content<F, Fut>(
    content: ContentRef,
    resolve: &F,
) -> Result<Vec<u8>, OutputComparison>
where
    F: Fn(String) -> Fut,
    Fut: Future<Output = io::Result<Option<Vec<u8>>>>,
{
    match content {
        ContentRef::Inline { inline } => Ok(inline.into_bytes()),
        ContentRef::Blob { blob, size } => match resolve(blob.clone()).await {
            Ok(Some(bytes)) if bytes.len() as u64 == size => Ok(bytes),
            Ok(Some(_)) => Err(OutputComparison::Different),
            Ok(None) => Err(OutputComparison::Unavailable(format!(
                "missing output blob {blob}"
            ))),
            Err(error) => Err(OutputComparison::Unavailable(format!(
                "cannot read output blob {blob}: {error}"
            ))),
        },
    }
}

fn normalize_arrow_refs(manifest: &mut Value) {
    if let Some(chunks) = manifest.get_mut("chunks").and_then(Value::as_array_mut) {
        for chunk in chunks {
            normalize_arrow_ref(chunk);
        }
    }
    if let Some(coalesced) = manifest.get_mut("coalesced") {
        normalize_arrow_ref(coalesced);
        if let Some(segments) = coalesced.get_mut("segments").and_then(Value::as_array_mut) {
            for segment in segments {
                normalize_arrow_ref(segment);
            }
        }
    }
}

fn normalize_arrow_ref(value: &mut Value) {
    let Some(object) = value.as_object_mut() else {
        return;
    };
    // A dual reference is not a transport form. Preserve it (and all unknown
    // fields) rather than hide an explicit conflict. Never visit schema.hash.
    if object.contains_key("hash") && object.contains_key("blob") {
        return;
    }
    if let Some(blob) = object
        .get("blob")
        .and_then(Value::as_str)
        .map(str::to_owned)
    {
        object.remove("blob");
        object.insert("hash".into(), Value::String(blob));
    }
    if object.get("hash").and_then(Value::as_str).is_some() {
        object
            .entry("content_type")
            .or_insert_with(|| Value::String(ARROW_STREAM.into()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn output(mime: &str, content: Value) -> Vec<Value> {
        vec![json!({"output_type":"execute_result", "execution_count":1,
            "data":{mime:content}, "metadata":{}, "output_id":"original"})]
    }
    fn inline(value: &Value) -> Value {
        json!({"inline":value.to_string()})
    }
    async fn compare(a: &[Value], b: &[Value]) -> OutputComparison {
        compare_outputs(a, b, |_| async { Ok(None) }).await
    }
    fn manifest() -> Value {
        json!({"schema":{"hash":"schema-hash","fields":["qa_id","score"]},
            "chunks":[{"hash":"a","size":1088,"rows":2}, {"hash":"b","size":80,"rows":1}],
            "coalesced":{"hash":"c","size":1168,"segments":[{"hash":"a","size":1088}]},
            "unknown":{"output_id":"payload","rich":true,"llm_preview":"payload"}})
    }

    #[tokio::test]
    async fn known_conflicts_take_precedence_over_unavailable_content() {
        let missing = output("application/json", json!({"blob":"missing","size":10})).remove(0);
        let inline = output("application/json", inline(&json!({"a":1}))).remove(0);
        let mut changed = inline.clone();
        changed["metadata"] = json!({"changed":true});
        assert_eq!(
            compare(
                &[missing.clone(), inline.clone()],
                &[inline.clone(), changed.clone()]
            )
            .await,
            OutputComparison::Different
        );
        assert_eq!(
            compare(&[inline.clone(), missing], &[changed, inline]).await,
            OutputComparison::Different
        );
    }

    #[tokio::test]
    async fn json_order_and_arrow_transport_defaults_are_equivalent() {
        let a = manifest();
        let mut b = a.clone();
        for pointer in [
            "/chunks/0",
            "/chunks/1",
            "/coalesced",
            "/coalesced/segments/0",
        ] {
            let object = b.pointer_mut(pointer).unwrap().as_object_mut().unwrap();
            let hash = object.remove("hash").unwrap();
            object.insert("blob".into(), hash);
            object.insert("content_type".into(), json!(ARROW_STREAM));
        }
        let a = output(ARROW_MANIFEST, inline(&a));
        let mut b = output(
            ARROW_MANIFEST,
            json!({"inline":serde_json::to_string_pretty(&b).unwrap()}),
        );
        b[0]["output_id"] = json!("recovered");
        assert_eq!(compare(&a, &b).await, OutputComparison::Equivalent);
        let a = output("application/json", json!({"inline":"{\"b\":2,\"a\":1}"}));
        let b = output("application/json", json!({"inline":"{\"a\":1,\"b\":2}"}));
        assert_eq!(compare(&a, &b).await, OutputComparison::Equivalent);
    }

    #[tokio::test]
    async fn arrow_content_order_unknown_fields_and_explicit_types_remain_strict() {
        let original = manifest();
        for pointer in [
            "/schema/hash",
            "/schema/fields/0",
            "/chunks/0/hash",
            "/chunks/0/size",
            "/chunks/0/rows",
            "/coalesced/hash",
            "/coalesced/segments/0/hash",
            "/unknown/output_id",
            "/unknown/rich",
            "/unknown/llm_preview",
        ] {
            let mut changed = original.clone();
            *changed.pointer_mut(pointer).unwrap() = json!("different");
            assert_eq!(
                compare(
                    &output(ARROW_MANIFEST, inline(&original)),
                    &output(ARROW_MANIFEST, inline(&changed))
                )
                .await,
                OutputComparison::Different,
                "{pointer}"
            );
        }
        let mut variants = Vec::new();
        let mut swapped = original.clone();
        swapped["chunks"].as_array_mut().unwrap().swap(0, 1);
        variants.push(swapped);
        for value in [json!("application/other"), Value::Null, json!(123)] {
            let mut changed = original.clone();
            changed["chunks"][0]["content_type"] = value;
            variants.push(changed);
        }
        let mut dual = original.clone();
        dual["chunks"][0]["blob"] = json!("other");
        variants.push(dual);
        let mut schema_ref = original.clone();
        schema_ref["schema"].as_object_mut().unwrap().remove("hash");
        schema_ref["schema"]["blob"] = json!("schema-hash");
        variants.push(schema_ref);
        let mut missing = original.clone();
        missing["chunks"][0].as_object_mut().unwrap().remove("size");
        variants.push(missing);
        let mut extra = original.clone();
        extra["chunks"][0]["future"] = json!(true);
        variants.push(extra);
        for changed in variants {
            assert_eq!(
                compare(
                    &output(ARROW_MANIFEST, inline(&original)),
                    &output(ARROW_MANIFEST, inline(&changed))
                )
                .await,
                OutputComparison::Different
            );
        }
    }

    #[tokio::test]
    async fn blob_and_inline_forms_compare_content_and_validate_sizes() {
        let a = output(ARROW_MANIFEST, inline(&manifest()));
        let mut restored = manifest();
        restored["chunks"][0]["content_type"] = json!(ARROW_STREAM);
        let bytes = serde_json::to_vec_pretty(&restored).unwrap();
        let b = output(
            ARROW_MANIFEST,
            json!({"blob":"restored","size":bytes.len()}),
        );
        let resolver = |_: String| {
            let bytes = bytes.clone();
            async move { Ok(Some(bytes)) }
        };
        assert_eq!(
            compare_outputs(&a, &b, resolver).await,
            OutputComparison::Equivalent
        );
        let a_blob = output(
            ARROW_MANIFEST,
            json!({"blob":"original","size":manifest().to_string().len()}),
        );
        let resolver = |hash: String| {
            let bytes = if hash == "original" {
                manifest().to_string().into_bytes()
            } else {
                bytes.clone()
            };
            async move { Ok(Some(bytes)) }
        };
        assert_eq!(
            compare_outputs(&a_blob, &b, resolver).await,
            OutputComparison::Equivalent
        );
        let mut bad_size = b.clone();
        bad_size[0]["data"][ARROW_MANIFEST]["size"] = json!(1);
        assert_eq!(
            compare_outputs(&a, &bad_size, resolver).await,
            OutputComparison::Different
        );
        assert_eq!(compare(&b, &bad_size).await, OutputComparison::Different);
        assert!(matches!(
            compare(&a, &b).await,
            OutputComparison::Unavailable(_)
        ));
        assert_eq!(compare(&b, &b).await, OutputComparison::Equivalent);
        assert!(matches!(
            compare_outputs(&a, &b, |_| async { Err(io::Error::other("unreadable")) }).await,
            OutputComparison::Unavailable(_)
        ));
    }

    #[tokio::test]
    async fn only_runtime_envelope_fields_are_ignored() {
        let a = vec![
            json!({"output_type":"error","ename":"ValueError","evalue":"expected",
            "traceback":{"inline":"[\"one\",\"two\"]"},"output_id":"old","rich":{},"llm_preview":{}}),
        ];
        let mut b = a.clone();
        for key in ["rich", "llm_preview", "output_id"] {
            b[0].as_object_mut().unwrap().remove(key);
        }
        assert_eq!(compare(&a, &b).await, OutputComparison::Equivalent);
        b[0]["traceback"]["inline"] = json!("[\"two\",\"one\"]");
        assert_eq!(compare(&a, &b).await, OutputComparison::Different);
        let a = output("text/plain", json!({"inline":"{\"a\":1,\"b\":2}"}));
        let mut b = a.clone();
        b[0]["data"]["text/plain"]["inline"] = json!("{\"b\":2,\"a\":1}");
        assert_eq!(compare(&a, &b).await, OutputComparison::Different);
        let mut b = a.clone();
        b[0]["metadata"]["rich"] = json!("must survive");
        assert_eq!(compare(&a, &b).await, OutputComparison::Different);
        let mut b = a.clone();
        b[0]["data"]["text/plain"]["future"] = json!(true);
        assert_eq!(compare(&a, &b).await, OutputComparison::Different);
        assert_eq!(compare(&a, &[]).await, OutputComparison::Different);
        let mut b = a.clone();
        b[0]["execution_count"] = json!(2);
        assert_eq!(compare(&a, &b).await, OutputComparison::Different);
    }

    const SESSION_MIME: &str = "application/x.test-session+json";

    struct SnapshotMutable;
    impl ReplayFieldPolicy for SnapshotMutable {
        fn mutable_fields(&self, mime: &str) -> &'static [&'static str] {
            if mime == SESSION_MIME {
                &["snapshot"]
            } else {
                &[]
            }
        }
    }

    async fn compare_mutable(a: &[Value], b: &[Value]) -> OutputComparison {
        compare_outputs_with_policy(a, b, |_| async { Ok(None) }, &SnapshotMutable).await
    }

    fn session_payload() -> Value {
        json!({"session_id":"s1","document":{"roots":[0]},"extra":1})
    }

    #[tokio::test]
    async fn declared_replay_fields_are_ignored_only_for_their_mime() {
        let recorded = output(SESSION_MIME, inline(&session_payload()));
        let mut live = session_payload();
        live["snapshot"] = json!({"document":{"roots":[1]}});
        let saved = output(SESSION_MIME, inline(&live));
        assert_eq!(
            compare_mutable(&recorded, &saved).await,
            OutputComparison::Equivalent
        );
        assert_eq!(
            compare(&recorded, &saved).await,
            OutputComparison::Different
        );

        let blob = live.to_string().into_bytes();
        let size = blob.len() as u64;
        let saved_blob = output(SESSION_MIME, json!({"blob":"live","size":size}));
        assert_eq!(
            compare_outputs_with_policy(
                &recorded,
                &saved_blob,
                |_| {
                    let blob = blob.clone();
                    async move { Ok(Some(blob)) }
                },
                &SnapshotMutable,
            )
            .await,
            OutputComparison::Equivalent
        );

        for (key, value) in [
            ("document", json!({"roots":[1]})),
            ("session_id", json!("s2")),
            ("extra", json!(2)),
            ("future", json!(true)),
        ] {
            let mut changed = live.clone();
            changed[key] = value;
            assert_eq!(
                compare_mutable(&recorded, &output(SESSION_MIME, inline(&changed))).await,
                OutputComparison::Different,
                "{key} must stay strict"
            );
        }

        let mut metadata_changed = saved.clone();
        metadata_changed[0]["metadata"] = json!({"snapshot":true});
        assert_eq!(
            compare_mutable(&recorded, &metadata_changed).await,
            OutputComparison::Different
        );

        let other = output("application/json", inline(&session_payload()));
        let other_live = output("application/json", inline(&live));
        assert_eq!(
            compare_mutable(&other, &other_live).await,
            OutputComparison::Different
        );
    }

    #[tokio::test]
    async fn non_json_mimes_stay_byte_strict_even_when_declared() {
        struct DeclaresTextFields;
        impl ReplayFieldPolicy for DeclaresTextFields {
            fn mutable_fields(&self, _mime: &str) -> &'static [&'static str] {
                &["snapshot"]
            }
        }
        let recorded = json!({"session_id": "s1", "snapshot": 0});
        let saved = json!({"session_id": "s1", "snapshot": 1});
        for (mime, expected) in [
            ("text/x-session", OutputComparison::Different),
            ("application/x-session", OutputComparison::Different),
            ("application/json", OutputComparison::Equivalent),
            (SESSION_MIME, OutputComparison::Equivalent),
        ] {
            assert_eq!(
                compare_outputs_with_policy(
                    &output(mime, inline(&recorded)),
                    &output(mime, inline(&saved)),
                    |_| async { Ok(None) },
                    &DeclaresTextFields,
                )
                .await,
                expected,
                "{mime}"
            );
        }
    }

    #[tokio::test]
    async fn non_object_payloads_fall_back_to_strict_comparison() {
        let a = output(SESSION_MIME, inline(&json!([{"snapshot":1}])));
        let b = output(SESSION_MIME, inline(&json!([{"snapshot":2}])));
        assert_eq!(compare_mutable(&a, &b).await, OutputComparison::Different);
        let a = output(SESSION_MIME, json!({"inline":"not json"}));
        let b = output(SESSION_MIME, inline(&json!({"snapshot":2})));
        assert_eq!(compare_mutable(&a, &b).await, OutputComparison::Different);
    }
}
