//! The inline mark registry shared with the JavaScript Pages codec.
//!
//! Mark names, value shapes, expand rules and Markdown projections come from
//! `docs/memos/authenticated-automerge-app-substrate/experiment/pages/model/marks.json`,
//! which `model/marks.mjs` also reads. Registry order is the Markdown nesting
//! order: earlier marks open outside later ones, and `code` stays innermost.

use std::collections::BTreeMap;
use std::sync::OnceLock;

use regex::Regex;
use serde::Deserialize;
use serde_json::Value;

use crate::{safe_url, CodecError, Result};

const REGISTRY_SOURCE: &str = include_str!(
    "../../../docs/memos/authenticated-automerge-app-substrate/experiment/pages/model/marks.json"
);

#[derive(Debug, Deserialize)]
struct RegistryFile {
    marks: Vec<MarkSpec>,
}

/// One registry entry.
#[derive(Debug, Deserialize)]
pub struct MarkSpec {
    pub name: String,
    pub value: ValueRule,
    /// Automerge expand rule: `none`, `before`, `after` or `both`.
    pub expand: String,
    /// Markdown projection: `native` syntax or one fixed `html` tag.
    pub markdown: String,
}

/// The stored Automerge shape of one mark value.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum ValueRule {
    /// The value must be `true`.
    Flag,
    /// A string from `enum`, or one that matches `pattern`.
    String {
        #[serde(rename = "enum", default)]
        allowed: Vec<String>,
        #[serde(default)]
        pattern: Option<String>,
    },
    /// A JSON string encoding an object with only the listed fields.
    JsonObject { fields: BTreeMap<String, FieldRule> },
    /// A value type this build does not implement. Validation refuses it.
    #[serde(other)]
    Unsupported,
}

#[derive(Debug, Deserialize)]
pub struct FieldRule {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub nullable: bool,
}

struct Registry {
    marks: Vec<MarkSpec>,
    patterns: BTreeMap<String, Regex>,
}

fn registry() -> Result<&'static Registry> {
    static REGISTRY: OnceLock<std::result::Result<Registry, String>> = OnceLock::new();
    REGISTRY
        .get_or_init(|| {
            let file: RegistryFile = serde_json::from_str(REGISTRY_SOURCE)
                .map_err(|error| format!("Invalid mark registry: {error}"))?;
            let mut patterns = BTreeMap::new();
            for spec in &file.marks {
                if let ValueRule::String {
                    pattern: Some(pattern),
                    ..
                } = &spec.value
                {
                    let regex = Regex::new(pattern)
                        .map_err(|error| format!("Invalid {} mark pattern: {error}", spec.name))?;
                    patterns.insert(spec.name.clone(), regex);
                }
            }
            Ok(Registry {
                marks: file.marks,
                patterns,
            })
        })
        .as_ref()
        .map_err(|error| CodecError(error.clone()))
}

/// Every registered mark, in registry (Markdown nesting) order.
pub fn mark_specs() -> Result<&'static [MarkSpec]> {
    Ok(&registry()?.marks)
}

/// Registered mark names, in registry order.
pub fn mark_names() -> Result<Vec<&'static str>> {
    Ok(mark_specs()?
        .iter()
        .map(|spec| spec.name.as_str())
        .collect())
}

pub fn mark_spec(name: &str) -> Result<&'static MarkSpec> {
    mark_specs()?
        .iter()
        .find(|spec| spec.name == name)
        .ok_or_else(|| CodecError(format!("Unsupported rich mark: {name}")))
}

/// The Automerge expand rule. An unknown mark does not expand over new text.
pub fn expand(name: &str) -> &'static str {
    mark_spec(name).map_or("none", |spec| spec.expand.as_str())
}

/// Validate one stored Automerge mark value against the registry.
pub fn validate_mark(name: &str, value: &Value) -> Result<()> {
    let spec = mark_spec(name)?;
    let invalid = || CodecError(format!("Invalid rich {name}"));
    match &spec.value {
        ValueRule::Flag => (value == &Value::Bool(true))
            .then_some(())
            .ok_or_else(invalid),
        ValueRule::String { allowed, .. } => {
            let valid = value.as_str().is_some_and(|value| {
                allowed.iter().any(|allowed| allowed == value)
                    || registry()
                        .ok()
                        .and_then(|registry| registry.patterns.get(name))
                        .is_some_and(|pattern| pattern.is_match(value))
            });
            valid.then_some(()).ok_or_else(invalid)
        }
        ValueRule::JsonObject { fields } => {
            let object = value
                .as_str()
                .and_then(|value| serde_json::from_str::<Value>(value).ok())
                .ok_or_else(invalid)?;
            let object = object.as_object().ok_or_else(invalid)?;
            let valid = object.keys().all(|key| fields.contains_key(key))
                && fields
                    .iter()
                    .all(|(key, field)| field_valid(field, object.get(key)));
            valid.then_some(()).ok_or_else(invalid)
        }
        ValueRule::Unsupported => Err(CodecError(format!("Unsupported {name} mark value type"))),
    }
}

fn field_valid(field: &FieldRule, value: Option<&Value>) -> bool {
    match value {
        None => !field.required,
        Some(Value::Null) => field.nullable && !field.required,
        Some(value) => match field.kind.as_str() {
            "url" => value.as_str().is_some_and(safe_url),
            "string" => value.is_string(),
            _ => false,
        },
    }
}

/// Normalize a Markdown highlight color: trimmed, lowercased, then validated.
pub fn normalize_highlight(value: &str) -> Option<String> {
    let color = value.trim().to_lowercase();
    validate_mark("highlight", &Value::String(color.clone()))
        .ok()
        .map(|()| color)
}

/// The color a bare `<mark>` tag imports as: the first registry palette entry.
pub fn default_highlight() -> Result<&'static str> {
    match &mark_spec("highlight")?.value {
        ValueRule::String { allowed, .. } => allowed
            .first()
            .map(String::as_str)
            .ok_or_else(|| CodecError("The highlight mark has no palette".into())),
        _ => Err(CodecError("The highlight mark is not a string mark".into())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn registry_order_matches_markdown_nesting() {
        assert_eq!(
            mark_names().ok(),
            Some(vec!["link", "em", "strong", "highlight", "code"])
        );
        assert_eq!(expand("link"), "none");
        assert_eq!(expand("strong"), "both");
        assert_eq!(expand("future"), "none");
        assert_eq!(default_highlight().ok(), Some("yellow"));
    }

    #[test]
    fn values_follow_registry_shapes() {
        for (name, value) in [
            ("strong", json!(true)),
            ("highlight", json!("green")),
            ("highlight", json!("#a1b2c3")),
            (
                "link",
                json!(r#"{"href":"https://example.org","title":null}"#),
            ),
            ("link", json!(r#"{"href":"/a"}"#)),
        ] {
            assert!(validate_mark(name, &value).is_ok(), "{name} {value}");
        }
        for (name, value) in [
            ("strong", json!(false)),
            ("em", json!("true")),
            ("highlight", json!("red")),
            ("highlight", json!("#A1B2C3")),
            ("highlight", json!("#a1b2c3 ")),
            ("highlight", json!(true)),
            ("link", json!({"href": "/a"})),
            ("link", json!(r#"{"title":"no href"}"#)),
            ("link", json!(r#"{"href":"/a","extra":1}"#)),
            ("link", json!(r#"{"href":"javascript:x"}"#)),
            ("link", json!(r#"{"href":"/a","title":3}"#)),
            ("link", json!("[]")),
        ] {
            assert!(validate_mark(name, &value).is_err(), "{name} {value}");
        }
        assert_eq!(
            validate_mark("color", &json!("red")).map_err(|e| e.0),
            Err("Unsupported rich mark: color".into())
        );
        assert_eq!(
            validate_mark("link", &json!("{}")).map_err(|e| e.0),
            Err("Invalid rich link".into())
        );
    }

    #[test]
    fn highlight_colors_normalize_like_markdown_import() {
        assert_eq!(normalize_highlight(" Green ").as_deref(), Some("green"));
        assert_eq!(normalize_highlight("#ABCDEF").as_deref(), Some("#abcdef"));
        assert_eq!(normalize_highlight(""), None);
        assert_eq!(normalize_highlight("#abcd"), None);
    }
}
