//! Markdown interchange for the Pages rich-text span contract.
//!
//! This crate owns conversion, not an Automerge document or an editor session.
//! Callers reconcile spans against existing text; they must not replace CRDT
//! objects or run Markdown conversion for each keystroke.

mod export;
pub mod features;
mod import;
pub mod marks;
#[cfg(feature = "automerge")]
pub mod native;
mod validate;
#[cfg(target_arch = "wasm32")]
mod wasm;
mod wire;

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub use export::spans_to_markdown;
pub use import::markdown_to_spans;
pub use validate::{safe_url, validate_spans};
pub use wire::process_json;

pub const PROFILE: &str = "pages-markdown-v1";
/// Independent bounds for Markdown source and serialized spans. An import
/// must satisfy both, including JSON escaping and span/provenance overhead.
pub const MAX_INPUT_BYTES: usize = 262_144;
pub const MAX_DEPTH: usize = 32;

pub type Attributes = BTreeMap<String, Value>;
pub type Marks = BTreeMap<String, Value>;

/// JSON-compatible boundary representation. JS callers turn block type,
/// parent names, and string attributes into Automerge ImmutableString values.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", deny_unknown_fields)]
pub enum Span {
    #[serde(rename = "text")]
    Text {
        value: String,
        #[serde(default)]
        marks: Marks,
    },
    #[serde(rename = "block")]
    Block { value: Block },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Block {
    #[serde(rename = "type")]
    pub kind: String,
    pub parents: Vec<String>,
    pub attrs: Attributes,
    #[serde(rename = "isEmbed")]
    pub is_embed: bool,
}

#[derive(Clone, Debug)]
pub struct ImportOptions<'a> {
    pub import_id: &'a str,
    pub kind: &'a str,
}

impl Default for ImportOptions<'_> {
    fn default() -> Self {
        Self {
            import_id: "",
            kind: "markdown",
        }
    }
}

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct CodecError(pub String);

pub type Result<T> = std::result::Result<T, CodecError>;
