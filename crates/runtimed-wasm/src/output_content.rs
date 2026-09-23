//! Prepare guest MIME values for the trusted runtime's content store.
use base64::Engine as _;
use notebook_doc::mime::{mime_kind, MimeKind};
use serde::Serialize;
use serde_json::Value;
use wasm_bindgen::prelude::*;

#[derive(Serialize)]
#[serde(untagged)]
enum PreparedContent {
    Inline { inline: String },
    Blob { bytes: Vec<u8> },
}

fn prepare(mime: &str, value: Value) -> Result<PreparedContent, String> {
    let text = match mime_kind(mime) {
        MimeKind::Binary => {
            let encoded = value.as_str().ok_or("Binary output must be base64 text")?;
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .map_err(|error| format!("Invalid binary output: {error}"))?;
            return Ok(PreparedContent::Blob { bytes });
        }
        MimeKind::Json => serde_json::to_string(&value).map_err(|error| error.to_string())?,
        MimeKind::Text => value
            .as_str()
            .ok_or("Text output must be a string")?
            .to_owned(),
    };
    if text.len() < 1024 {
        Ok(PreparedContent::Inline { inline: text })
    } else {
        Ok(PreparedContent::Blob {
            bytes: text.into_bytes(),
        })
    }
}

/// Classify through notebook-doc's canonical MIME rules. The trusted caller
/// uploads returned bytes before publishing their content-addressed reference.
#[wasm_bindgen]
pub fn prepare_output_content(mime: &str, value_json: &str) -> Result<JsValue, JsError> {
    let value = serde_json::from_str(value_json)
        .map_err(|error| JsError::new(&format!("Invalid output JSON: {error}")))?;
    let prepared = prepare(mime, value).map_err(|error| JsError::new(&error))?;
    crate::serialize_to_js(&prepared).map_err(|error| JsError::new(&error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn binary_is_decoded_even_when_small() {
        assert!(
            matches!(prepare("image/png", Value::String("AQID".into())).unwrap(), PreparedContent::Blob { bytes } if bytes == [1,2,3])
        );
        assert!(prepare("image/png", Value::String("not base64!".into())).is_err());
    }
    #[test]
    fn json_and_text_have_distinct_serialization() {
        assert!(
            matches!(prepare("application/json", serde_json::json!({"x":1})).unwrap(), PreparedContent::Inline { inline } if inline == "{\"x\":1}")
        );
        assert!(
            matches!(prepare("image/svg+xml", Value::String("<svg/>".into())).unwrap(), PreparedContent::Inline { inline } if inline == "<svg/>")
        );
    }
    #[test]
    fn spill_threshold_counts_utf8_bytes() {
        assert!(
            matches!(prepare("text/plain", Value::String("é".repeat(512))).unwrap(), PreparedContent::Blob { bytes } if bytes.len() == 1024)
        );
    }
}
