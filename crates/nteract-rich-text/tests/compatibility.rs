//! Checked-in golden data comes from the existing JS codec, not this parser.
#![allow(clippy::unwrap_used)] // A broken fixture is an immediate test failure.

use nteract_rich_text::{markdown_to_spans, spans_to_markdown, ImportOptions, Span};
use serde_json::Value;

fn corpus() -> Value {
    serde_json::from_str(include_str!("../fixtures/compatibility.json")).unwrap()
}

#[test]
fn imports_match_legacy_fixtures_and_documented_preservation_differences() {
    let corpus = corpus();
    for fixture in corpus["fixtures"]
        .as_array()
        .unwrap()
        .iter()
        .chain(corpus["divergences"].as_array().unwrap())
    {
        let options = ImportOptions {
            import_id: fixture["import_id"].as_str().unwrap_or(""),
            kind: fixture["kind"].as_str().unwrap_or("markdown"),
        };
        let expected: Vec<Span> =
            serde_json::from_value(fixture["expected_spans"].clone()).unwrap();
        let actual = markdown_to_spans(fixture["markdown"].as_str().unwrap(), &options).unwrap();
        assert_eq!(actual, expected, "{}", fixture["id"]);
        let exported = spans_to_markdown(&actual).unwrap();
        let reimported = markdown_to_spans(&exported, &options).unwrap();
        assert_eq!(reimported, actual, "{} export/import", fixture["id"]);
    }
}

#[cfg(feature = "automerge")]
#[test]
fn every_fixture_survives_native_automerge_save_and_load() {
    use automerge::{transaction::Transactable, AutoCommit, ObjType, ReadDoc, ROOT};
    use nteract_rich_text::native::{from_automerge, to_automerge};

    let corpus = corpus();
    for fixture in corpus["fixtures"]
        .as_array()
        .unwrap()
        .iter()
        .chain(corpus["divergences"].as_array().unwrap())
    {
        let spans: Vec<Span> = serde_json::from_value(fixture["expected_spans"].clone()).unwrap();
        let mut doc = AutoCommit::new();
        let text = doc.put_object(ROOT, "content", ObjType::Text).unwrap();
        doc.update_spans(&text, Default::default(), to_automerge(&spans).unwrap())
            .unwrap();
        let restored = AutoCommit::load(&doc.save()).unwrap();
        assert_eq!(
            from_automerge(restored.spans(&text).unwrap()).unwrap(),
            spans,
            "{}",
            fixture["id"]
        );
    }
}
