//! Keyed documents: small Automerge documents addressed by `(kind, id)` and
//! an `epoch`, synced over frame `0x0b KeyedDocSync`.
//!
//! The room holds a [`KeyedDocHub`] built from the kinds in
//! [`room_kinds`]; the runtime agent holds an [`AgentDocs`]. A kind is
//! routed only when both sides register it and the coordinator advertises
//! it to the agent (`RuntimeAgentCapabilities`).

pub(crate) mod admission;
pub(crate) mod agent;
pub(crate) mod hub;
pub(crate) mod kind;
#[cfg(test)]
pub(crate) mod test_kind;
#[cfg(test)]
mod tests;

use std::sync::Arc;

pub(crate) use agent::{AgentDocs, AgentKeyedDoc};
pub(crate) use hub::{KeyedDocHub, KeyedSyncStates};
pub(crate) use kind::KeyedDocKind;

/// Room-side kinds for a new room. The registration site for production
/// kinds; empty until a kind ships.
pub(crate) fn room_kinds() -> Vec<Arc<dyn KeyedDocKind>> {
    Vec::new()
}

/// Agent-side kinds for a new runtime agent; mirrors [`room_kinds`].
pub(crate) fn agent_kinds() -> Vec<Arc<dyn AgentKeyedDoc>> {
    Vec::new()
}
