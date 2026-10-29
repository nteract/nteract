use crate::{markdown_to_spans, spans_to_markdown, ImportOptions, Span, MAX_INPUT_BYTES};
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
        ] {
            let result: serde_json::Value = serde_json::from_str(&process_json(input)).unwrap();
            assert_eq!(result["ok"], false);
        }
    }
}
