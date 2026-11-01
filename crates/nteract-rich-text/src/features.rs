//! Schema features shared with the JavaScript Pages registry.
//!
//! A Pages document stamps the non-baseline features its content uses in
//! `schema.features`. Feature ids and their block types come from
//! `docs/memos/authenticated-automerge-app-substrate/experiment/pages/model/features.json`;
//! a mark names its feature in `marks.json`. `model/schema-features.mjs` reads
//! the same files. Marks and block types without a feature are baseline, and
//! content that uses only the baseline needs no stamp.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

use crate::validate::BLOCKS;
use crate::{CodecError, Result, Span};

const FEATURES_SOURCE: &str = include_str!(
    "../../../docs/memos/authenticated-automerge-app-substrate/experiment/pages/model/features.json"
);
const MARKS_SOURCE: &str = include_str!(
    "../../../docs/memos/authenticated-automerge-app-substrate/experiment/pages/model/marks.json"
);

/// One `features.json` entry.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FeatureSpec {
    pub id: String,
    pub description: String,
    /// Block types (and parents) whose presence needs this feature.
    #[serde(default)]
    pub blocks: Vec<String>,
}

#[derive(Deserialize)]
struct FeatureFile {
    features: Vec<FeatureSpec>,
}

#[derive(Deserialize)]
struct MarkFile {
    marks: Vec<MarkFeature>,
}

#[derive(Deserialize)]
struct MarkFeature {
    name: String,
    #[serde(default)]
    feature: Option<String>,
}

/// The feature registry: feature ids, and which marks and block types need them.
#[derive(Debug)]
pub struct FeatureRegistry {
    features: Vec<FeatureSpec>,
    marks: BTreeMap<String, String>,
    blocks: BTreeMap<String, String>,
}

fn valid_id(id: &str) -> bool {
    let mut chars = id.chars();
    chars.next().is_some_and(|c| c.is_ascii_lowercase())
        && id.len() <= 64
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

impl FeatureRegistry {
    /// Parse and check `features.json` and `marks.json` sources. Fails on a
    /// malformed or repeated id, a missing description, a block type listed
    /// twice or unknown to this codec, or a mark naming an unlisted feature.
    pub fn parse(features: &str, marks: &str) -> Result<Self> {
        let file: FeatureFile = serde_json::from_str(features)
            .map_err(|error| CodecError(format!("Invalid feature registry: {error}")))?;
        let mark_file: MarkFile = serde_json::from_str(marks)
            .map_err(|error| CodecError(format!("Invalid mark registry: {error}")))?;
        let mut ids = BTreeSet::new();
        let mut blocks = BTreeMap::new();
        for feature in &file.features {
            if !valid_id(&feature.id) {
                return Err(CodecError(format!(
                    "Invalid schema feature id: {}",
                    feature.id
                )));
            }
            if !ids.insert(feature.id.clone()) {
                return Err(CodecError(format!(
                    "Schema feature {} is listed twice",
                    feature.id
                )));
            }
            if feature.description.is_empty() {
                return Err(CodecError(format!(
                    "Schema feature {} needs a description",
                    feature.id
                )));
            }
            for block in &feature.blocks {
                if !BLOCKS.contains(&block.as_str()) {
                    return Err(CodecError(format!(
                        "Schema feature {} lists unknown block type {block}",
                        feature.id
                    )));
                }
                if blocks.insert(block.clone(), feature.id.clone()).is_some() {
                    return Err(CodecError(format!(
                        "Block type {block} belongs to two schema features"
                    )));
                }
            }
        }
        let mut mark_features = BTreeMap::new();
        for mark in mark_file.marks {
            if let Some(feature) = mark.feature {
                if !ids.contains(&feature) {
                    return Err(CodecError(format!(
                        "Mark {} names unknown schema feature {feature}",
                        mark.name
                    )));
                }
                mark_features.insert(mark.name, feature);
            }
        }
        Ok(Self {
            features: file.features,
            marks: mark_features,
            blocks,
        })
    }

    /// Every feature, in registry order.
    pub fn features(&self) -> &[FeatureSpec] {
        &self.features
    }

    /// Feature ids, sorted: what this build can read and write.
    pub fn ids(&self) -> Vec<&str> {
        let mut ids: Vec<&str> = self
            .features
            .iter()
            .map(|feature| feature.id.as_str())
            .collect();
        ids.sort_unstable();
        ids
    }

    /// Mark name to feature id, for marks that have one.
    pub fn mark_features(&self) -> &BTreeMap<String, String> {
        &self.marks
    }

    /// Block type to feature id, for block types that have one.
    pub fn block_features(&self) -> &BTreeMap<String, String> {
        &self.blocks
    }

    /// The features these spans need: their marks, block types and parents.
    pub fn span_features(&self, spans: &[Span]) -> BTreeSet<String> {
        let mut needed = BTreeSet::new();
        for span in spans {
            match span {
                Span::Text { marks, .. } => {
                    needed.extend(
                        marks
                            .keys()
                            .filter_map(|name| self.marks.get(name).cloned()),
                    );
                }
                Span::Block { value } => {
                    needed.extend(
                        std::iter::once(&value.kind)
                            .chain(&value.parents)
                            .filter_map(|kind| self.blocks.get(kind).cloned()),
                    );
                }
            }
        }
        needed
    }
}

/// The registry compiled into this build.
pub fn registry() -> Result<&'static FeatureRegistry> {
    static REGISTRY: OnceLock<std::result::Result<FeatureRegistry, String>> = OnceLock::new();
    REGISTRY
        .get_or_init(|| FeatureRegistry::parse(FEATURES_SOURCE, MARKS_SOURCE).map_err(|e| e.0))
        .as_ref()
        .map_err(|error| CodecError(error.clone()))
}

/// The features `spans` need under the compiled registry.
pub fn span_features(spans: &[Span]) -> Result<BTreeSet<String>> {
    Ok(registry()?.span_features(spans))
}

#[cfg(test)]
#[allow(clippy::unwrap_used)] // A fixture registry that fails to parse is a test failure.
mod tests {
    use super::*;
    use crate::{Block, Marks};
    use serde_json::json;

    const FIXTURE_FEATURES: &str = r#"{"features":[
        {"id":"test-highlight","description":"Highlights, for tests."},
        {"id":"test-tables","description":"Native tables, for tests.","blocks":["table"]}
    ]}"#;
    const FIXTURE_MARKS: &str = r#"{"marks":[
        {"name":"strong"},
        {"name":"highlight","feature":"test-highlight"}
    ]}"#;

    #[test]
    fn compiled_registry_is_all_baseline() {
        let registry = registry().unwrap();
        assert!(registry.features().is_empty());
        assert!(registry.ids().is_empty());
        assert!(registry.mark_features().is_empty());
        assert!(registry.block_features().is_empty());
        assert!(crate::marks::mark_specs()
            .unwrap()
            .iter()
            .all(|spec| spec.feature.is_none()));
    }

    #[test]
    fn span_features_follow_the_registry() {
        let fixture = FeatureRegistry::parse(FIXTURE_FEATURES, FIXTURE_MARKS).unwrap();
        assert_eq!(fixture.ids(), vec!["test-highlight", "test-tables"]);
        let spans = [
            Span::Block {
                value: Block {
                    kind: "table-cell".into(),
                    parents: vec!["table".into(), "table-row".into()],
                    attrs: Default::default(),
                    is_embed: false,
                },
            },
            Span::Text {
                value: "x".into(),
                marks: Marks::from([
                    ("strong".into(), json!(true)),
                    ("highlight".into(), json!("yellow")),
                ]),
            },
        ];
        assert_eq!(
            fixture
                .span_features(&spans)
                .into_iter()
                .collect::<Vec<_>>(),
            vec!["test-highlight", "test-tables"]
        );
        assert!(span_features(&spans).unwrap().is_empty());
    }

    #[test]
    fn inconsistent_registries_are_refused() {
        let marks = r#"{"marks":[{"name":"em"}]}"#;
        for (features, marks, message) in [
            (
                r#"{"features":[{"id":"Bad","description":"x"}]}"#,
                marks,
                "Invalid schema feature id",
            ),
            (
                r#"{"features":[{"id":"a","description":"x"},{"id":"a","description":"y"}]}"#,
                marks,
                "listed twice",
            ),
            (
                r#"{"features":[{"id":"a","description":""}]}"#,
                marks,
                "needs a description",
            ),
            (
                r#"{"features":[{"id":"a","description":"x","blocks":["table"]},{"id":"b","description":"y","blocks":["table"]}]}"#,
                marks,
                "two schema features",
            ),
            (
                r#"{"features":[{"id":"a","description":"x","blocks":["future-block"]}]}"#,
                marks,
                "unknown block type",
            ),
            (
                r#"{"features":[]}"#,
                r#"{"marks":[{"name":"em","feature":"nope"}]}"#,
                "unknown schema feature",
            ),
        ] {
            let error = FeatureRegistry::parse(features, marks).unwrap_err();
            assert!(error.0.contains(message), "{} lacks {message}", error.0);
        }
    }
}
