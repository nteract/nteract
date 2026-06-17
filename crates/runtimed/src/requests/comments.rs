//! `NotebookRequest` handlers for daemon-authoritative comment transitions.

use automerge::{ActorId, ChangeHash};
use nteract_identity::ConnectionScope;

use crate::notebook_sync_server::{NotebookRoom, COMMENTS_DOC_ACTOR};
use crate::protocol::NotebookResponse;

pub(crate) async fn resolve_thread(
    room: &NotebookRoom,
    thread_id: String,
    observed_comments_heads: Vec<String>,
    submitter_actor_label: Option<&str>,
    submitter_scope: ConnectionScope,
) -> NotebookResponse {
    set_thread_status(
        room,
        thread_id,
        observed_comments_heads,
        submitter_actor_label,
        submitter_scope,
        ThreadStatusTransition::Resolve,
    )
}

pub(crate) async fn reopen_thread(
    room: &NotebookRoom,
    thread_id: String,
    observed_comments_heads: Vec<String>,
    submitter_actor_label: Option<&str>,
    submitter_scope: ConnectionScope,
) -> NotebookResponse {
    set_thread_status(
        room,
        thread_id,
        observed_comments_heads,
        submitter_actor_label,
        submitter_scope,
        ThreadStatusTransition::Reopen,
    )
}

pub(crate) async fn accept_thread(
    room: &NotebookRoom,
    thread_id: String,
    message_id: String,
    observed_comments_heads: Vec<String>,
    submitter_actor_label: Option<&str>,
    submitter_scope: ConnectionScope,
) -> NotebookResponse {
    finalize_thread_creation(
        room,
        thread_id,
        Some(message_id),
        observed_comments_heads,
        submitter_actor_label,
        submitter_scope,
        ThreadCreationFinalization::Accept,
    )
    .await
}

pub(crate) async fn reject_thread(
    room: &NotebookRoom,
    thread_id: String,
    reason: String,
    message_id: String,
    observed_comments_heads: Vec<String>,
    submitter_actor_label: Option<&str>,
    submitter_scope: ConnectionScope,
) -> NotebookResponse {
    finalize_thread_creation(
        room,
        thread_id,
        Some(message_id),
        observed_comments_heads,
        submitter_actor_label,
        submitter_scope,
        ThreadCreationFinalization::Reject { reason },
    )
    .await
}

pub(crate) async fn accept_message(
    room: &NotebookRoom,
    thread_id: String,
    message_id: String,
    observed_comments_heads: Vec<String>,
    submitter_actor_label: Option<&str>,
    submitter_scope: ConnectionScope,
) -> NotebookResponse {
    finalize_message_creation(
        room,
        thread_id,
        message_id,
        observed_comments_heads,
        submitter_actor_label,
        submitter_scope,
        MessageCreationFinalization::Accept,
    )
}

pub(crate) async fn reject_message(
    room: &NotebookRoom,
    thread_id: String,
    message_id: String,
    reason: String,
    observed_comments_heads: Vec<String>,
    submitter_actor_label: Option<&str>,
    submitter_scope: ConnectionScope,
) -> NotebookResponse {
    finalize_message_creation(
        room,
        thread_id,
        message_id,
        observed_comments_heads,
        submitter_actor_label,
        submitter_scope,
        MessageCreationFinalization::Reject { reason },
    )
}

#[derive(Debug, Clone, Copy)]
enum ThreadStatusTransition {
    Resolve,
    Reopen,
}

impl ThreadStatusTransition {
    fn expected_current_status(self) -> &'static str {
        match self {
            Self::Resolve => "open",
            Self::Reopen => "resolved",
        }
    }
}

enum ThreadCreationFinalization {
    Accept,
    Reject { reason: String },
}

enum MessageCreationFinalization {
    Accept,
    Reject { reason: String },
}

fn set_thread_status(
    room: &NotebookRoom,
    thread_id: String,
    observed_comments_heads: Vec<String>,
    submitter_actor_label: Option<&str>,
    submitter_scope: ConnectionScope,
    transition: ThreadStatusTransition,
) -> NotebookResponse {
    if !allows_comment_status_transition(submitter_scope) {
        return NotebookResponse::Error {
            error: format!("{submitter_scope} cannot finalize comment thread status"),
        };
    }

    if let Err(error) = validate_non_empty("thread_id", &thread_id) {
        return NotebookResponse::Error { error };
    }
    let observed_heads = match parse_observed_comments_heads(&observed_comments_heads) {
        Ok(heads) => heads,
        Err(error) => return NotebookResponse::Error { error },
    };

    let actor_label = submitter_actor_label.unwrap_or("unknown");
    let timestamp = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let result = room.comments.with_doc(|doc| {
        doc.validate_thread_status_transition(
            &thread_id,
            &observed_heads,
            &[COMMENTS_DOC_ACTOR],
            transition.expected_current_status(),
        )?;
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

async fn finalize_thread_creation(
    room: &NotebookRoom,
    thread_id: String,
    message_id: Option<String>,
    observed_comments_heads: Vec<String>,
    submitter_actor_label: Option<&str>,
    submitter_scope: ConnectionScope,
    finalization: ThreadCreationFinalization,
) -> NotebookResponse {
    if !allows_comment_content_finalization(submitter_scope) {
        return NotebookResponse::Error {
            error: format!("{submitter_scope} cannot finalize comment thread creation"),
        };
    }

    if let Err(error) = validate_non_empty("thread_id", &thread_id) {
        return NotebookResponse::Error { error };
    }
    if let Some(message_id) = &message_id {
        if let Err(error) = validate_non_empty("message_id", message_id) {
            return NotebookResponse::Error { error };
        }
    }
    if let ThreadCreationFinalization::Reject { reason } = &finalization {
        if let Err(error) = validate_non_empty("reason", reason) {
            return NotebookResponse::Error { error };
        }
    }
    let Some(submitter_actor_label) = submitter_actor_label else {
        return NotebookResponse::Error {
            error: "comment finalization requires an authenticated actor label".to_string(),
        };
    };
    let observed_heads = match parse_observed_comments_heads(&observed_comments_heads) {
        Ok(heads) => heads,
        Err(error) => return NotebookResponse::Error { error },
    };

    let finalize = |doc: &mut comments_doc::CommentsDoc,
                    notebook_doc: Option<&notebook_doc::NotebookDoc>| {
        let pending_author = match message_id.as_deref() {
            Some(message_id) => doc.validate_pending_thread_creation(
                &thread_id,
                message_id,
                &observed_heads,
                &[COMMENTS_DOC_ACTOR],
            )?,
            None => {
                doc.validate_pending_thread(&thread_id, &observed_heads, &[COMMENTS_DOC_ACTOR])?
            }
        };
        validate_finalizer_scope(&pending_author, submitter_actor_label, submitter_scope)?;
        if matches!(&finalization, ThreadCreationFinalization::Accept) {
            let projection = doc.read_projection(&[COMMENTS_DOC_ACTOR], None)?;
            let anchor = projection
                .threads
                .iter()
                .find(|thread| thread.id == thread_id)
                .map(|thread| &thread.anchor)
                .ok_or_else(|| comments_doc::CommentsDocError::ThreadNotFound(thread_id.clone()))?;
            let Some(notebook_doc) = notebook_doc else {
                return Err(comments_doc::CommentsDocError::InvalidAnchor(
                    "notebook document unavailable for source_range validation".to_string(),
                ));
            };
            validate_thread_anchor_against_notebook_doc(notebook_doc, anchor)?;
        }
        doc.doc_mut()
            .set_actor(ActorId::from(COMMENTS_DOC_ACTOR.as_bytes()));
        match &finalization {
            ThreadCreationFinalization::Accept => {
                doc.accept_thread_creation(&thread_id, &pending_author, COMMENTS_DOC_ACTOR)?;
                if let Some(message_id) = message_id.as_deref() {
                    doc.accept_message(
                        &thread_id,
                        message_id,
                        &pending_author,
                        COMMENTS_DOC_ACTOR,
                    )?;
                }
                Ok(())
            }
            ThreadCreationFinalization::Reject { reason } => {
                doc.reject_thread_creation(
                    &thread_id,
                    reason,
                    &pending_author,
                    COMMENTS_DOC_ACTOR,
                )?;
                if let Some(message_id) = message_id.as_deref() {
                    doc.reject_message(
                        &thread_id,
                        message_id,
                        &reason,
                        &pending_author,
                        COMMENTS_DOC_ACTOR,
                    )?;
                }
                Ok(())
            }
        }
    };

    let result = if matches!(&finalization, ThreadCreationFinalization::Accept) {
        let notebook_doc = room.doc.read().await;
        room.comments
            .with_doc(|doc| finalize(doc, Some(&notebook_doc)))
    } else {
        room.comments.with_doc(|doc| finalize(doc, None))
    };

    if let Err(error) = result {
        return NotebookResponse::Error {
            error: format!("Failed to finalize comment thread creation: {error}"),
        };
    }

    if let Err(error) = room.comments_store.save_handle(&room.comments) {
        return NotebookResponse::Error {
            error: format!("Failed to persist comment thread finalization: {error:#}"),
        };
    }

    NotebookResponse::Ok {}
}

fn finalize_message_creation(
    room: &NotebookRoom,
    thread_id: String,
    message_id: String,
    observed_comments_heads: Vec<String>,
    submitter_actor_label: Option<&str>,
    submitter_scope: ConnectionScope,
    finalization: MessageCreationFinalization,
) -> NotebookResponse {
    if !allows_comment_content_finalization(submitter_scope) {
        return NotebookResponse::Error {
            error: format!("{submitter_scope} cannot finalize comment message creation"),
        };
    }

    if let Err(error) = validate_non_empty("thread_id", &thread_id) {
        return NotebookResponse::Error { error };
    }
    if let Err(error) = validate_non_empty("message_id", &message_id) {
        return NotebookResponse::Error { error };
    }
    if let MessageCreationFinalization::Reject { reason } = &finalization {
        if let Err(error) = validate_non_empty("reason", reason) {
            return NotebookResponse::Error { error };
        }
    }
    let Some(submitter_actor_label) = submitter_actor_label else {
        return NotebookResponse::Error {
            error: "comment finalization requires an authenticated actor label".to_string(),
        };
    };
    let observed_heads = match parse_observed_comments_heads(&observed_comments_heads) {
        Ok(heads) => heads,
        Err(error) => return NotebookResponse::Error { error },
    };

    let result = room.comments.with_doc(|doc| {
        let pending_author = doc.validate_pending_message_creation(
            &thread_id,
            &message_id,
            &observed_heads,
            &[COMMENTS_DOC_ACTOR],
        )?;
        validate_finalizer_scope(&pending_author, submitter_actor_label, submitter_scope)?;
        doc.doc_mut()
            .set_actor(ActorId::from(COMMENTS_DOC_ACTOR.as_bytes()));
        match finalization {
            MessageCreationFinalization::Accept => {
                doc.accept_message(&thread_id, &message_id, &pending_author, COMMENTS_DOC_ACTOR)?;
                reopen_resolved_thread_for_reply(doc, &thread_id, &pending_author)?;
                Ok(())
            }
            MessageCreationFinalization::Reject { reason } => doc.reject_message(
                &thread_id,
                &message_id,
                &reason,
                &pending_author,
                COMMENTS_DOC_ACTOR,
            ),
        }
    });

    if let Err(error) = result {
        return NotebookResponse::Error {
            error: format!("Failed to finalize comment message creation: {error}"),
        };
    }

    if let Err(error) = room.comments_store.save_handle(&room.comments) {
        return NotebookResponse::Error {
            error: format!("Failed to persist comment message finalization: {error:#}"),
        };
    }

    NotebookResponse::Ok {}
}

fn parse_observed_comments_heads(heads: &[String]) -> Result<Vec<ChangeHash>, String> {
    if heads.is_empty() {
        return Err("observed_comments_heads cannot be empty".to_string());
    }
    heads
        .iter()
        .map(|head| {
            head.parse::<ChangeHash>()
                .map_err(|_| "observed_comments_heads contained an invalid head".to_string())
        })
        .collect()
}

fn reopen_resolved_thread_for_reply(
    doc: &mut comments_doc::CommentsDoc,
    thread_id: &str,
    actor_label: &str,
) -> Result<(), comments_doc::CommentsDocError> {
    let projection = doc.read_projection(&[COMMENTS_DOC_ACTOR], None)?;
    let should_reopen = projection.threads.iter().any(|thread| {
        thread.id == thread_id && thread.status == comments_doc::ProjectedThreadStatus::Resolved
    });
    if should_reopen {
        let timestamp = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        doc.reopen_thread(thread_id, actor_label, COMMENTS_DOC_ACTOR, &timestamp)?;
    }
    Ok(())
}

fn validate_finalizer_scope(
    pending_author: &str,
    submitter_actor_label: &str,
    submitter_scope: ConnectionScope,
) -> Result<(), comments_doc::CommentsDocError> {
    if submitter_scope == ConnectionScope::Owner || pending_author == submitter_actor_label {
        return Ok(());
    }
    Err(comments_doc::CommentsDocError::UnauthorizedActor(format!(
        "{submitter_actor_label} cannot finalize comment content authored by {pending_author}"
    )))
}

fn validate_thread_anchor_against_notebook_doc(
    notebook_doc: &notebook_doc::NotebookDoc,
    anchor: &comments_doc::CommentAnchor,
) -> Result<(), comments_doc::CommentsDocError> {
    comments_doc::validate_comment_anchor(anchor)
        .map_err(comments_doc::CommentsDocError::InvalidAnchor)?;

    if let comments_doc::CommentAnchor::SourceRange { cell_id, .. } = anchor {
        let source = notebook_doc.get_cell_source(cell_id).ok_or_else(|| {
            comments_doc::CommentsDocError::InvalidAnchor(format!(
                "source_range cell not found: {cell_id}"
            ))
        })?;
        comments_doc::validate_source_range_anchor_against_source(anchor, &source)
            .map_err(comments_doc::CommentsDocError::InvalidAnchor)?;
    }

    Ok(())
}

fn validate_non_empty(field: &str, value: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        return Err(format!("{field} cannot be empty"));
    }
    Ok(())
}

fn allows_comment_status_transition(scope: ConnectionScope) -> bool {
    matches!(scope, ConnectionScope::Editor | ConnectionScope::Owner)
}

fn allows_comment_content_finalization(scope: ConnectionScope) -> bool {
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

    #[test]
    fn comment_content_finalization_scope_excludes_viewer_and_runtime_peer() {
        assert!(!allows_comment_content_finalization(
            ConnectionScope::Viewer
        ));
        assert!(allows_comment_content_finalization(ConnectionScope::Editor));
        assert!(!allows_comment_content_finalization(
            ConnectionScope::RuntimePeer
        ));
        assert!(allows_comment_content_finalization(ConnectionScope::Owner));
    }

    #[test]
    fn source_range_authority_validation_rejects_stale_exact_quote() {
        let mut notebook = notebook_doc::NotebookDoc::new("notebook-1");
        notebook.add_cell(0, "cell-1", "code").unwrap();
        notebook.update_source("cell-1", "alpha\nbeta\n").unwrap();
        let anchor = comments_doc::CommentAnchor::SourceRange {
            cell_id: "cell-1".into(),
            start_line: 1,
            start_column: 0,
            end_line: 1,
            end_column: 4,
            prefix_quote: None,
            exact_quote: Some("beta".into()),
            suffix_quote: None,
        };

        assert!(validate_thread_anchor_against_notebook_doc(&notebook, &anchor).is_ok());

        notebook.update_source("cell-1", "alpha\ngamma\n").unwrap();
        assert!(validate_thread_anchor_against_notebook_doc(&notebook, &anchor).is_err());
    }

    #[test]
    fn source_range_authority_validation_rejects_missing_cell() {
        let notebook = notebook_doc::NotebookDoc::new("notebook-1");
        let anchor = comments_doc::CommentAnchor::SourceRange {
            cell_id: "missing".into(),
            start_line: 0,
            start_column: 0,
            end_line: 0,
            end_column: 0,
            prefix_quote: None,
            exact_quote: Some(String::new()),
            suffix_quote: None,
        };

        assert!(validate_thread_anchor_against_notebook_doc(&notebook, &anchor).is_err());
    }
}
