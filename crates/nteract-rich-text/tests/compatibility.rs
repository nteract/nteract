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

#[cfg(feature = "automerge")]
#[test]
fn javascript_documents_preserve_native_identity_or_refuse_explicitly() {
    use automerge::{transaction::Transactable, AutoCommit, ReadDoc, ROOT};
    use nteract_rich_text::native::{from_automerge, to_automerge};

    // Authored and saved by the pinned JS Automerge runtime, not this crate.
    // Comparing JSON spans alone misses scalar types and mutable Text attrs.
    let corpus: Value =
        serde_json::from_str(include_str!("../fixtures/javascript-automerge.json")).unwrap();
    for fixture in corpus["documents"].as_array().unwrap() {
        let id = fixture["id"].as_str().unwrap();
        let hex = fixture["bytes_hex"].as_str().unwrap();
        assert_eq!(hex.len() % 2, 0);
        let bytes: Vec<u8> = (0..hex.len())
            .step_by(2)
            .map(|index| u8::from_str_radix(&hex[index..index + 2], 16).unwrap())
            .collect();
        let mut doc = AutoCommit::load(&bytes).unwrap();
        let text = doc.get(ROOT, "content").unwrap().unwrap().1;
        let original_heads = doc.get_heads();
        assert_eq!(
            serde_json::to_value(
                original_heads
                    .iter()
                    .map(ToString::to_string)
                    .collect::<Vec<_>>()
            )
            .unwrap(),
            fixture["heads"],
            "{id} saved heads"
        );
        let projection = from_automerge(doc.spans(&text).unwrap());
        if id == "legacy-image-text" {
            // PM's alt/title are editable Text objects. Wordgard's are scalar
            // attributes. Do not flatten this known difference into a silent
            // object replacement: callers need an explicit adoption decision.
            assert!(projection.unwrap_err().0.contains("found text object"));
            assert_eq!(doc.get_heads(), original_heads);
            continue;
        }
        let projection = projection.unwrap();
        let expected: Vec<Span> = serde_json::from_value(fixture["spans"].clone()).unwrap();
        assert_eq!(projection, expected, "{id} stored projection");
        if id == "legacy-core" {
            let imported = markdown_to_spans(
                fixture["markdown"].as_str().unwrap(),
                &ImportOptions::default(),
            )
            .unwrap();
            assert_eq!(imported, expected, "{id} Markdown import");
        }
        doc.update_spans(
            &text,
            Default::default(),
            to_automerge(&projection).unwrap(),
        )
        .unwrap();
        assert_eq!(
            doc.get_heads(),
            original_heads,
            "{id}: unchanged JS content emitted native operations"
        );
        assert_eq!(doc.get(ROOT, "content").unwrap().unwrap().1, text);
        let loaded = AutoCommit::load(&doc.save()).unwrap();
        assert_eq!(
            from_automerge(loaded.spans(&text).unwrap()).unwrap(),
            expected,
            "{id} saved projection"
        );
    }
}
