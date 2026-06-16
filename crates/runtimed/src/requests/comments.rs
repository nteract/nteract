//! `NotebookRequest` handlers for daemon-authoritative comment transitions.

use automerge::ActorId;
use nteract_identity::ConnectionScope;

use crate::notebook_sync_server::{NotebookRoom, COMMENTS_DOC_ACTOR};
use crate::protocol::NotebookResponse;

pub(crate) async fn resolve_thread(
    room: &NotebookRoom,
    thread_id: String,
    submitter_actor_label: Option<&str>,
    submitter_scope: ConnectionScope,
) -> NotebookResponse {
    set_thread_status(
        room,
        thread_id,
        submitter_actor_label,
        submitter_scope,
        ThreadStatusTransition::Resolve,
    )
}

pub(crate) async fn reopen_thread(
    room: &NotebookRoom,
    thread_id: String,
    submitter_actor_label: Option<&str>,
    submitter_scope: ConnectionScope,
) -> NotebookResponse {
    set_thread_status(
        room,
        thread_id,
        submitter_actor_label,
        submitter_scope,
        ThreadStatusTransition::Reopen,
    )
}

#[derive(Debug, Clone, Copy)]
enum ThreadStatusTransition {
    Resolve,
    Reopen,
}

fn set_thread_status(
    room: &NotebookRoom,
    thread_id: String,
    submitter_actor_label: Option<&str>,
    submitter_scope: ConnectionScope,
    transition: ThreadStatusTransition,
) -> NotebookResponse {
    if !allows_comment_status_transition(submitter_scope) {
        return NotebookResponse::Error {
            error: format!("{submitter_scope} cannot finalize comment thread status"),
        };
    }

    if thread_id.trim().is_empty() {
        return NotebookResponse::Error {
            error: "thread_id cannot be empty".to_string(),
        };
    }

    let actor_label = submitter_actor_label.unwrap_or("unknown");
    let timestamp = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let result = room.comments.with_doc(|doc| {
        doc.doc_mut()
            .set_actor(ActorId::from(COMMENTS_DOC_ACTOR.as_bytes()));
        match transition {
            ThreadStatusTransition::Resolve => {
                doc.resolve_thread(&thread_id, actor_label, COMMENTS_DOC_ACTOR, &timestamp)
            }
            ThreadStatusTransition::Reopen => {
                doc.reopen_thread(&thread_id, actor_label, COMMENTS_DOC_ACTOR, &timestamp)
            }
        }
    });

    if let Err(error) = result {
        return NotebookResponse::Error {
            error: format!("Failed to update comment thread status: {error}"),
        };
    }

    if let Err(error) = room.comments_store.save_handle(&room.comments) {
        return NotebookResponse::Error {
            error: format!("Failed to persist comment thread status: {error:#}"),
        };
    }

    NotebookResponse::Ok {}
}

fn allows_comment_status_transition(scope: ConnectionScope) -> bool {
    matches!(scope, ConnectionScope::Editor | ConnectionScope::Owner)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn comment_status_transition_scope_excludes_viewer_and_runtime_peer() {
        assert!(!allows_comment_status_transition(ConnectionScope::Viewer));
        assert!(allows_comment_status_transition(ConnectionScope::Editor));
        assert!(!allows_comment_status_transition(
            ConnectionScope::RuntimePeer
        ));
        assert!(allows_comment_status_transition(ConnectionScope::Owner));
    }
}
