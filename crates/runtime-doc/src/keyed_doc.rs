//! Write policy shared by every keyed document kind.
//!
//! A keyed document is a small Automerge document addressed by `(kind, id)`
//! and an `epoch` that moves when its producer replaces it. The daemon hub
//! applies these rules before handing a peer's changes to the kind's own
//! content validation; clients may use them to pre-check writes.

use crate::RuntimeStateWriteScope;

/// What the room knows about one keyed document.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyedDocRecord {
    pub epoch: u64,
    /// Editors and owners may write content while this holds.
    pub accepts_peer_writes: bool,
    /// Human-readable status used in rejection messages.
    pub status_label: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyedWritePermission {
    /// Runtime peer: changes are applied without content validation.
    Producer,
    /// Editor or owner: every change goes through the kind's validation.
    Validated,
}

/// Why a peer's keyed document frame was refused.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum KeyedDocRejection {
    #[error("scope {0} cannot write {1} documents")]
    Scope(&'static str, String),
    #[error("{0} is {1}; it does not accept writes")]
    NotWritable(String, &'static str),
    #[error("epoch {frame} is not the current epoch {current}")]
    StaleEpoch { frame: u64, current: u64 },
    #[error("unknown document {0}")]
    UnknownDocument(String),
    /// Carries the identity check's reason, which names the actor.
    #[error("unauthorized change actor: {0}")]
    UnauthorizedActor(String),
    #[error("undecodable sync message")]
    Undecodable,
    #[error("frame body of {size} bytes exceeds the limit of {cap}")]
    TooLarge { size: usize, cap: usize },
    #[error("{0}")]
    Content(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KeyedWriteContext {
    pub scope: RuntimeStateWriteScope,
    pub current_epoch: u64,
}

impl KeyedWriteContext {
    /// The runtime peer builds epoch N+1 before the room announces it, so only
    /// older epochs are stale for it; everyone else must match exactly.
    pub fn check_frame_epoch(&self, frame_epoch: u64) -> Result<(), KeyedDocRejection> {
        let stale = match self.scope {
            RuntimeStateWriteScope::RuntimePeer => frame_epoch < self.current_epoch,
            _ => frame_epoch != self.current_epoch,
        };
        if stale {
            return Err(KeyedDocRejection::StaleEpoch {
                frame: frame_epoch,
                current: self.current_epoch,
            });
        }
        Ok(())
    }
}

/// Viewers never write, the runtime peer produces, and editors/owners write
/// validated content only while the record accepts peer writes.
pub fn default_write_permission(
    kind: &str,
    scope: RuntimeStateWriteScope,
    record: Option<&KeyedDocRecord>,
) -> Result<KeyedWritePermission, KeyedDocRejection> {
    match scope {
        RuntimeStateWriteScope::RuntimePeer => Ok(KeyedWritePermission::Producer),
        RuntimeStateWriteScope::Viewer => Err(KeyedDocRejection::Scope(
            RuntimeStateWriteScope::Viewer.as_str(),
            kind.to_string(),
        )),
        RuntimeStateWriteScope::Editor | RuntimeStateWriteScope::Owner => match record {
            Some(record) if record.accepts_peer_writes => Ok(KeyedWritePermission::Validated),
            Some(record) => Err(KeyedDocRejection::NotWritable(
                kind.to_string(),
                record.status_label,
            )),
            None => Err(KeyedDocRejection::NotWritable(kind.to_string(), "unknown")),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(accepts_peer_writes: bool) -> KeyedDocRecord {
        KeyedDocRecord {
            epoch: 2,
            accepts_peer_writes,
            status_label: if accepts_peer_writes {
                "connected"
            } else {
                "disconnected"
            },
        }
    }

    #[test]
    fn runtime_peer_may_run_one_epoch_ahead() {
        let runtime = KeyedWriteContext {
            scope: RuntimeStateWriteScope::RuntimePeer,
            current_epoch: 2,
        };
        assert!(runtime.check_frame_epoch(2).is_ok());
        assert!(runtime.check_frame_epoch(3).is_ok());
        assert_eq!(
            runtime.check_frame_epoch(1),
            Err(KeyedDocRejection::StaleEpoch {
                frame: 1,
                current: 2
            })
        );
        let editor = KeyedWriteContext {
            scope: RuntimeStateWriteScope::Editor,
            current_epoch: 2,
        };
        assert!(editor.check_frame_epoch(2).is_ok());
        assert!(editor.check_frame_epoch(3).is_err());
        assert!(editor.check_frame_epoch(1).is_err());
    }

    #[test]
    fn default_permission_by_scope_and_record() {
        use RuntimeStateWriteScope::*;
        assert_eq!(
            default_write_permission("test_kv", RuntimePeer, None),
            Ok(KeyedWritePermission::Producer)
        );
        assert_eq!(
            default_write_permission("test_kv", Viewer, Some(&record(true))),
            Err(KeyedDocRejection::Scope("viewer", "test_kv".into()))
        );
        for scope in [Editor, Owner] {
            assert_eq!(
                default_write_permission("test_kv", scope, Some(&record(true))),
                Ok(KeyedWritePermission::Validated)
            );
            let refused = default_write_permission("test_kv", scope, Some(&record(false)))
                .unwrap_err()
                .to_string();
            assert_eq!(
                refused,
                "test_kv is disconnected; it does not accept writes"
            );
            assert!(default_write_permission("test_kv", scope, None).is_err());
        }
    }
}
