use crate::{marks::validate_mark, CodecError, Result, Span, MAX_DEPTH, MAX_INPUT_BYTES};
use serde_json::Value;

/// Every block type this codec reads and writes.
pub(crate) const BLOCKS: &[&str] = &[
    "paragraph",
    "heading",
    "blockquote",
    "code-block",
    "image",
    "hard-break",
    "ordered-list-item",
    "unordered-list-item",
    "task-list-item",
    "aside",
    "pages-opaque",
    "horizontal-rule",
    "table",
    "table-row",
    "table-cell",
    "table-header",
];

/// Pages URL policy. Relative URLs are accepted; executable schemes and ASCII
/// whitespace/control characters are rejected, including after an allowed scheme.
pub fn safe_url(value: &str) -> bool {
    if value.chars().any(|c| c <= '\u{20}' || c == '\u{7f}') {
        return false;
    }
    fn scheme(value: &str) -> Option<&str> {
        let (prefix, _) = value.split_once(':')?;
        let mut chars = prefix.chars();
        if !chars.next()?.is_ascii_alphabetic()
            || !chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
        {
            return None;
        }
        Some(prefix)
    }
    match scheme(value) {
        None => true,
        Some(prefix)
            if ["http", "https", "mailto", "tel"]
                .iter()
                .any(|s| prefix.eq_ignore_ascii_case(s)) =>
        {
            scheme(&value[prefix.len() + 1..]).is_none()
        }
        Some(_) => false,
    }
}

/// Validate the wire schema before conversion. Structural Markdown
/// representability is additionally checked by the exporter.
pub fn validate_spans(spans: &[Span]) -> Result<()> {
    let bytes = serde_json::to_vec(spans).map_err(|e| CodecError(e.to_string()))?;
    if bytes.len() > MAX_INPUT_BYTES {
        return Err(CodecError("Rich spans exceed the codec input limit".into()));
    }
    for span in spans {
        match span {
            Span::Text { marks, .. } => {
                for (name, value) in marks {
                    validate_mark(name, value)?;
                }
            }
            Span::Block { value: block } => {
                if !BLOCKS.contains(&block.kind.as_str())
                    || block.parents.len() > MAX_DEPTH
                    || block.parents.iter().any(|p| {
                        !BLOCKS.contains(&p.as_str())
                            || matches!(
                                p.as_str(),
                                "image" | "hard-break" | "pages-opaque" | "horizontal-rule"
                            )
                    })
                {
                    return Err(CodecError("Unsupported rich block or parent".into()));
                }
                if block.is_embed != matches!(block.kind.as_str(), "image" | "hard-break") {
                    return Err(CodecError("Invalid block embedding flag".into()));
                }
                let allowed: &[&str] = match block.kind.as_str() {
                    "heading" => &["level"],
                    "code-block" => &["params"],
                    "task-list-item" => &["checked"],
                    "table-cell" | "table-header" => &["align"],
                    "image" => &["src", "alt", "title"],
                    "pages-opaque" => &["source", "importId", "kind"],
                    _ => &[],
                };
                if block
                    .attrs
                    .keys()
                    .any(|key| !allowed.contains(&key.as_str()))
                {
                    return Err(CodecError("Unknown block attribute would be lost".into()));
                }
                let attr = |key: &str| block.attrs.get(key);
                let string = |key: &str| attr(key).and_then(Value::as_str);
                let valid = match block.kind.as_str() {
                    "heading" => attr("level")
                        .and_then(Value::as_u64)
                        .is_some_and(|level| (1..=6).contains(&level)),
                    "code-block" => string("params").is_some(),
                    "task-list-item" => attr("checked").is_some_and(Value::is_boolean),
                    "table-cell" | "table-header" => attr("align").is_none_or(|v| {
                        v.is_null()
                            || v.as_str()
                                .is_some_and(|v| ["left", "center", "right"].contains(&v))
                    }),
                    "image" => {
                        string("src").is_some_and(safe_url)
                            && attr("alt").is_none_or(|v| v.is_null() || v.is_string())
                            && attr("title").is_none_or(|v| v.is_null() || v.is_string())
                    }
                    "pages-opaque" => ["source", "importId", "kind"]
                        .iter()
                        .all(|key| string(key).is_some()),
                    _ => true,
                };
                if !valid {
                    return Err(CodecError(format!("Invalid {} attributes", block.kind)));
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Block, Marks};
    use serde_json::json;

    #[test]
    fn urls_match_pages_policy() {
        for url in [
            "https://example.org/a",
            "mailto:k@example.org",
            "/api/assets/1",
            "#heading",
            "",
        ] {
            assert!(safe_url(url), "{url}");
        }
        for url in [
            "javascript:alert(1)",
            "data:image/svg+xml,x",
            "https:javascript:x",
            "HTTPS:javascript:x",
            "a\nb",
            "a b",
            "\0https://x",
        ] {
            assert!(!safe_url(url), "{url}");
        }
    }

    #[test]
    fn rejects_lossy_attributes_and_unsafe_marks() {
        let mut block = Block {
            kind: "paragraph".into(),
            parents: vec![],
            attrs: Default::default(),
            is_embed: false,
        };
        block.attrs.insert("future_feature".into(), json!(true));
        assert!(validate_spans(&[Span::Block { value: block }]).is_err());
        let marks = Marks::from([("link".into(), json!(r#"{"href":"javascript:x"}"#))]);
        assert!(validate_spans(&[Span::Text {
            value: "click".into(),
            marks
        }])
        .is_err());
    }

    #[test]
    fn marks_validate_against_the_registry() {
        let text = |name: &str, value: serde_json::Value| Span::Text {
            value: "x".into(),
            marks: Marks::from([(name.into(), value)]),
        };
        assert!(validate_spans(&[text("highlight", json!("pink"))]).is_ok());
        assert!(validate_spans(&[text("highlight", json!("#0a0b0c"))]).is_ok());
        assert!(validate_spans(&[text("highlight", json!("red"))]).is_err());
        assert_eq!(
            validate_spans(&[text("color", json!("red"))]).map_err(|e| e.0),
            Err("Unsupported rich mark: color".into())
        );
        assert_eq!(
            validate_spans(&[text("link", json!(r#"{"href":"javascript:x"}"#))]).map_err(|e| e.0),
            Err("Invalid rich link".into())
        );
    }
}
