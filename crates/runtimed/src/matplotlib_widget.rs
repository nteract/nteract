//! Helpers for the `jupyter-matplotlib` / ipympl custom widget protocol.

use serde_json::Value;

pub(crate) const JUPYTER_MATPLOTLIB_MODULE: &str = "jupyter-matplotlib";
pub(crate) const MPL_CANVAS_MODEL: &str = "MPLCanvasModel";
pub(crate) const MPL_CANVAS_CHECKPOINT_KEY: &str = "_nteract_mpl_canvas";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum MplCanvasCustomMessage {
    Binary,
    ImageMode(String),
    Resize(Option<(u64, u64)>),
    Other,
}

pub(crate) fn is_mpl_canvas_model(model_module: &str, model_name: &str) -> bool {
    model_module == JUPYTER_MATPLOTLIB_MODULE && model_name == MPL_CANVAS_MODEL
}

pub(crate) fn parse_mpl_canvas_custom_message(comm_data: &Value) -> Option<MplCanvasCustomMessage> {
    let content = custom_content(comm_data)?;
    let message = if let Some(raw) = content.get("data").and_then(Value::as_str) {
        serde_json::from_str::<Value>(raw).ok()?
    } else {
        content.clone()
    };

    let message_type = message.get("type").and_then(Value::as_str)?;
    match message_type {
        "binary" => Some(MplCanvasCustomMessage::Binary),
        "image_mode" => message
            .get("mode")
            .and_then(Value::as_str)
            .map(|mode| MplCanvasCustomMessage::ImageMode(mode.to_string())),
        "resize" => Some(MplCanvasCustomMessage::Resize(parse_resize_size(&message))),
        _ => Some(MplCanvasCustomMessage::Other),
    }
}

fn custom_content(comm_data: &Value) -> Option<&Value> {
    let method = comm_data.get("method").and_then(Value::as_str);
    if method.is_some() && method != Some("custom") {
        return None;
    }

    if let Some(content) = comm_data.get("content") {
        return Some(content);
    }

    if comm_data.get("type").is_some() || comm_data.get("data").is_some() {
        return Some(comm_data);
    }

    None
}

fn parse_resize_size(message: &Value) -> Option<(u64, u64)> {
    if let Some(size) = message.get("size").and_then(Value::as_array) {
        let width = size.first()?.as_u64()?;
        let height = size.get(1)?.as_u64()?;
        return Some((width, height));
    }

    let width = message.get("width").and_then(Value::as_u64)?;
    let height = message.get("height").and_then(Value::as_u64)?;
    Some((width, height))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parser_extracts_image_mode_from_widget_custom_payload() {
        let data = json!({
            "method": "custom",
            "content": {
                "data": "{\"type\":\"image_mode\",\"mode\":\"diff\"}"
            }
        });

        assert_eq!(
            parse_mpl_canvas_custom_message(&data),
            Some(MplCanvasCustomMessage::ImageMode("diff".to_string()))
        );
    }

    #[test]
    fn parser_detects_binary_frame_payload() {
        let data = json!({
            "method": "custom",
            "content": {
                "data": "{\"type\":\"binary\"}"
            }
        });

        assert_eq!(
            parse_mpl_canvas_custom_message(&data),
            Some(MplCanvasCustomMessage::Binary)
        );
    }

    #[test]
    fn parser_extracts_resize_size() {
        let data = json!({
            "method": "custom",
            "content": {
                "data": "{\"type\":\"resize\",\"size\":[640,480]}"
            }
        });

        assert_eq!(
            parse_mpl_canvas_custom_message(&data),
            Some(MplCanvasCustomMessage::Resize(Some((640, 480))))
        );
    }

    #[test]
    fn parser_ignores_non_custom_updates() {
        let data = json!({
            "method": "update",
            "state": {"value": 1}
        });

        assert_eq!(parse_mpl_canvas_custom_message(&data), None);
    }

    #[test]
    fn parser_ignores_malformed_payloads() {
        let data = json!({
            "method": "custom",
            "content": {
                "data": "{not json"
            }
        });

        assert_eq!(parse_mpl_canvas_custom_message(&data), None);
    }
}
