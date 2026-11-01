use crate::{features, markdown_to_spans, spans_to_markdown, ImportOptions, Span, MAX_INPUT_BYTES};
use serde::Deserialize;
use serde_json::json;

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
enum Request {
    Import {
        markdown: String,
        #[serde(default)]
        import_id: String,
        #[serde(default = "markdown_kind")]
        kind: String,
    },
    Export {
        spans: Vec<Span>,
    },
    /// The schema features these spans need.
    Features {
        spans: Vec<Span>,
    },
    /// The compiled feature registry, for parity checks with JavaScript.
    Registry {},
}

fn markdown_kind() -> String {
    "markdown".into()
}

/// The same bounded JSON entry point is exercised by native and WASM fixtures.
/// Schema errors are returned as data, never panics or partial conversions.
pub fn process_json(bytes: &[u8]) -> String {
    // Allow JSON escaping overhead while bounding the semantic input separately.
    let result = if bytes.len() > MAX_INPUT_BYTES * 6 + 1024 {
        Err("Codec request exceeds size limit".to_owned())
    } else {
        serde_json::from_slice::<Request>(bytes)
            .map_err(|e| e.to_string())
            .and_then(|request| {
                match request {
                    Request::Import {
                        markdown,
                        import_id,
                        kind,
                    } => markdown_to_spans(
                        &markdown,
                        &ImportOptions {
                            import_id: &import_id,
                            kind: &kind,
                        },
                    )
                    .map(|spans| json!({"ok":true,"spans":spans})),
                    Request::Export { spans } => spans_to_markdown(&spans)
                        .map(|markdown| json!({"ok":true,"markdown":markdown})),
                    Request::Features { spans } => features::span_features(&spans)
                        .map(|features| json!({"ok":true,"features":features})),
                    Request::Registry {} => features::registry().map(|registry| {
                        json!({
                            "ok": true,
                            "features": registry.features(),
                            "marks": registry.mark_features(),
                            "blocks": registry.block_features(),
                        })
                    }),
                }
                .map_err(|e| e.to_string())
            })
    };
    match result {
        Ok(value) => value,
        Err(error) => json!({"ok":false,"error":error}),
    }
    .to_string()
}

#[cfg(test)]
#[allow(clippy::unwrap_used)] // Malformed response JSON is a test failure.
mod tests {
    use super::*;

    #[test]
    fn malformed_and_future_requests_fail_explicitly() {
        for input in [
            b"not JSON".as_slice(),
            br#"{"op":"other"}"#,
            br#"{"op":"import","markdown":"x","ignored":true}"#,
            br#"{"op":"export","spans":[{"type":"unknown","value":"x"}]}"#,
            br#"{"op":"registry","extra":true}"#,
            br#"{"op":"features"}"#,
        ] {
            let result: serde_json::Value = serde_json::from_str(&process_json(input)).unwrap();
            assert_eq!(result["ok"], false);
        }
    }

    #[test]
    fn feature_requests_report_the_compiled_registry() {
        let registry: serde_json::Value =
            serde_json::from_str(&process_json(br#"{"op":"registry"}"#)).unwrap();
        assert_eq!(
            registry["features"]
                .as_array()
                .unwrap()
                .iter()
                .map(|feature| feature["id"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec![
                "strike",
                "horizontal-rule",
                "preserved-markdown-converted",
                "comments-doc"
            ]
        );
        assert_eq!(registry["marks"], json!({"strike":"strike"}));
        assert_eq!(
            registry["blocks"],
            json!({"horizontal-rule":"horizontal-rule"})
        );
        let features: serde_json::Value = serde_json::from_str(&process_json(
            br#"{"op":"features","spans":[{"type":"text","value":"x","marks":{"strong":true}}]}"#,
        ))
        .unwrap();
        assert_eq!(features, json!({"ok":true,"features":[]}));
        let features: serde_json::Value = serde_json::from_str(&process_json(
            br#"{"op":"features","spans":[{"type":"text","value":"x","marks":{"strike":true}}]}"#,
        ))
        .unwrap();
        assert_eq!(features, json!({"ok":true,"features":["strike"]}));
    }
}
