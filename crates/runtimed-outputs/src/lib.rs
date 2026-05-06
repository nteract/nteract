//! Output resolution and LLM-friendly output formatting.
//!
//! Resolves blob references, base64-decodes binary outputs, and synthesizes
//! `text/llm+plain` summaries via `repr-llm`. Used by clients that need to
//! present cell outputs to users or to LLM-based agents.

pub mod output_resolver;
pub mod resolved_output;
