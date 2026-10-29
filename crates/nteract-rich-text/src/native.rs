//! Optional conversion to the pinned native Automerge representation. These
//! functions never mutate a document; callers retain ownership of transactions,
//! heads, object identities, mark expansion and concurrency preconditions.

use std::{collections::HashMap, sync::Arc};

use automerge::{hydrate, marks::MarkSet, ScalarValue};
use serde_json::Value;

use crate::{validate_spans, CodecError, Result, Span};

pub fn to_automerge(spans: &[Span]) -> Result<Vec<automerge::Span>> {
    validate_spans(spans)?;
    spans
        .iter()
        .map(|span| match span {
            Span::Text { value, marks } => {
                let marks = marks
                    .iter()
                    .map(|(key, value)| Ok((key.clone(), scalar(value)?)))
                    .collect::<Result<MarkSet>>()?;
                Ok(automerge::Span::Text {
                    text: value.clone(),
                    marks: (!marks.is_empty()).then(|| Arc::new(marks)),
                })
            }
            Span::Block { value } => {
                let json = serde_json::to_value(value).map_err(|e| CodecError(e.to_string()))?;
                match hydrate_value(&json)? {
                    hydrate::Value::Map(map) => Ok(automerge::Span::Block(map)),
                    _ => Err(CodecError("Block must be a map".into())),
                }
            }
        })
        .collect()
}

pub fn from_automerge(spans: impl IntoIterator<Item = automerge::Span>) -> Result<Vec<Span>> {
    let spans = spans
        .into_iter()
        .map(|span| match span {
            automerge::Span::Text { text, marks } => {
                let marks = marks
                    .as_deref()
                    .map(|m| {
                        m.iter()
                            .map(|(key, value)| Ok((key.to_owned(), scalar_json(value)?)))
                            .collect::<Result<_>>()
                    })
                    .transpose()?
                    .unwrap_or_default();
                Ok(Span::Text { value: text, marks })
            }
            automerge::Span::Block(map) => {
                let json = hydrated_json(&hydrate::Value::Map(map), 0)?;
                Ok(Span::Block {
                    value: serde_json::from_value(json).map_err(|e| CodecError(e.to_string()))?,
                })
            }
        })
        .collect::<Result<Vec<_>>>()?;
    validate_spans(&spans)?;
    Ok(spans)
}

fn scalar(value: &Value) -> Result<ScalarValue> {
    match value {
        Value::Null => Ok(ScalarValue::Null),
        Value::Bool(v) => Ok((*v).into()),
        Value::String(v) => Ok(v.as_str().into()),
        Value::Number(v) => v
            .as_u64()
            .map(ScalarValue::Uint)
            .or_else(|| v.as_i64().map(ScalarValue::Int))
            .ok_or_else(|| CodecError("Noninteger attribute".into())),
        _ => Err(CodecError("Expected scalar attribute".into())),
    }
}

fn hydrate_value(value: &Value) -> Result<hydrate::Value> {
    match value {
        Value::Object(values) => Ok(hydrate::Value::Map(
            values
                .iter()
                .map(|(k, v)| Ok((k.clone(), hydrate_value(v)?)))
                .collect::<Result<HashMap<_, _>>>()?
                .into(),
        )),
        Value::Array(values) => Ok(hydrate::Value::List(
            values
                .iter()
                .map(hydrate_value)
                .collect::<Result<Vec<_>>>()?
                .into(),
        )),
        _ => Ok(hydrate::Value::Scalar(scalar(value)?)),
    }
}

fn scalar_json(value: &ScalarValue) -> Result<Value> {
    match value {
        ScalarValue::Null => Ok(Value::Null),
        ScalarValue::Boolean(v) => Ok((*v).into()),
        ScalarValue::Str(v) => Ok(v.to_string().into()),
        ScalarValue::Int(v) => Ok((*v).into()),
        ScalarValue::Uint(v) => Ok((*v).into()),
        _ => Err(CodecError(
            "Unsupported Automerge scalar would be lost".into(),
        )),
    }
}

fn hydrated_json(value: &hydrate::Value, depth: usize) -> Result<Value> {
    if depth > crate::MAX_DEPTH + 4 {
        return Err(CodecError(
            "Automerge attribute nesting exceeds the codec limit".into(),
        ));
    }
    match value {
        hydrate::Value::Scalar(value) => scalar_json(value),
        hydrate::Value::Map(values) => Ok(Value::Object(
            values
                .iter()
                .map(|(key, value)| {
                    if value.conflict {
                        return Err(CodecError("Conflicted block attribute".into()));
                    }
                    Ok((key.clone(), hydrated_json(&value.value, depth + 1)?))
                })
                .collect::<Result<_>>()?,
        )),
        hydrate::Value::List(values) => Ok(Value::Array(
            values
                .iter()
                .map(|value| {
                    if value.conflict || !value.marks.is_empty() {
                        return Err(CodecError("Conflicted or marked block attribute".into()));
                    }
                    hydrated_json(&value.value, depth + 1)
                })
                .collect::<Result<_>>()?,
        )),
        hydrate::Value::Text(_) => Err(CodecError(
            "Expected immutable block string, found text object".into(),
        )),
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)] // Test fixture failures should fail the test immediately.
mod tests {
    use super::*;
    use crate::{markdown_to_spans, ImportOptions};
    use automerge::{transaction::Transactable, AutoCommit, ObjType, ReadDoc, ROOT};

    #[test]
    fn native_reconciliation_retains_text_identity_and_unrelated_data() {
        let mut doc = AutoCommit::new();
        let text = doc.put_object(ROOT, "richText", ObjType::Text).unwrap();
        doc.put(ROOT, "unrelated", "preserve").unwrap();
        let spans = markdown_to_spans(
            "- [ ] Read **café 🦀**\n- [x] Write",
            &ImportOptions::default(),
        )
        .unwrap();
        doc.update_spans(&text, Default::default(), to_automerge(&spans).unwrap())
            .unwrap();
        assert_eq!(from_automerge(doc.spans(&text).unwrap()).unwrap(), spans);
        let updated = markdown_to_spans(
            "- [x] Read **café 🦀**\n- [x] Write",
            &ImportOptions::default(),
        )
        .unwrap();
        doc.update_spans(&text, Default::default(), to_automerge(&updated).unwrap())
            .unwrap();
        let loaded = AutoCommit::load(&doc.save()).unwrap();
        assert_eq!(loaded.get(ROOT, "richText").unwrap().unwrap().1, text);
        assert_eq!(
            loaded.get(ROOT, "unrelated").unwrap().unwrap().0.as_str(),
            Some("preserve")
        );
        assert_eq!(
            from_automerge(loaded.spans(&text).unwrap()).unwrap(),
            updated
        );
    }
}
