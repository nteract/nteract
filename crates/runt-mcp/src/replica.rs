//! A stable operator describes attribution; a replica owns one sequential writer.
//!
//! Independently writable Automerge documents must not share an actor even when
//! they belong to the same MCP worker. Allocate once before initial sync, retain
//! it when sharing the same DocHandle, and mint again when reconstructing a peer.

pub(crate) fn fresh_operator(operator: &str) -> String {
    format!("{operator}:{}", uuid::Uuid::new_v4())
}

/// Compatibility check for backing-peer reuse, not principal authorization.
/// The daemon still authenticates the principal in the actor label. Historical
/// unsuffixed operators remain recognizable while new replicas carry a UUID.
pub(crate) fn belongs_to_operator(actor: &str, operator: &str) -> bool {
    let Some((_, actual)) = actor.rsplit_once('/') else {
        return false;
    };
    actual == operator
        || actual
            .strip_prefix(operator)
            .and_then(|suffix| suffix.strip_prefix(':'))
            .is_some_and(|suffix| uuid::Uuid::parse_str(suffix).is_ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replicas_are_distinct_without_changing_operator_attribution() {
        let operator = "agent:codex:worker";
        let first = fresh_operator(operator);
        let second = fresh_operator(operator);
        assert_ne!(first, second);
        assert!(belongs_to_operator(
            &format!("user:alice/{first}"),
            operator
        ));
        assert!(belongs_to_operator(
            &format!("user:alice/{second}"),
            operator
        ));
        assert!(belongs_to_operator(
            "user:alice/agent:codex:worker",
            operator
        ));
        for invalid in [
            "agent:codex:worker",
            "user:alice/agent:codex:worker-other",
            "user:alice/agent:codex:worker:short",
            "user:alice/agent:codex:worker:extra:550e8400-e29b-41d4-a716-446655440000",
        ] {
            assert!(!belongs_to_operator(invalid, operator), "{invalid}");
        }
    }
}
