use std::collections::HashSet;

#[cfg(test)]
use automerge::transaction::CommitOptions;
use automerge::{
    sync, sync::SyncDoc, transaction::Transactable, ActorId, AutoCommit, ObjId, ObjType, ReadDoc,
    ScalarValue, Value, ROOT,
};
use automerge_recovery::{
    catch_automerge_panic, catch_automerge_result, is_recoverable_sync_error,
    recoverable_automerge_operation, AutomergeAttempt, AutomergeOperationError,
    AutomergeRebuildError,
};
use loro_fractional_index::FractionalIndex;

use crate::error::CommentsDocError;
use crate::types::{
    CommentAnchor, CommentCreated, CommentMessageSnapshot, CommentReplied, CommentThreadSnapshot,
    CommentsProjection, NotebookCommentRef, ProjectedMutationState, ProjectedThreadStatus,
};

#[cfg(test)]
const COMMENTS_DOC_SCHEMA_SEED_ACTOR: &str = "nteract:comments-doc-schema:v1";
#[cfg(test)]
const COMMENTS_DOC_SCHEMA_SEED_ACTOR_BYTES: &[u8] = b"nteract:comments-doc-schema:v1";
pub const COMMENTS_DOC_DEFAULT_ACTOR: &str = "runtimed:comments";
#[cfg(test)]
const COMMENTS_DOC_SCHEMA_VERSION: u64 = 1;
const COMMENTS_DOC_GENESIS_V1_BYTES: &[u8] = include_bytes!("../assets/comments_doc_genesis_v1.am");
const DEFAULT_POSITION: &str = "80";

#[derive(Debug)]
pub struct CommentsDoc {
    doc: AutoCommit,
    comments_doc_id: String,
}

impl CommentsDoc {
    pub fn try_new(
        comments_doc_id: &str,
        notebook_ref: &NotebookCommentRef,
    ) -> Result<Self, CommentsDocError> {
        Self::try_new_with_actor(comments_doc_id, notebook_ref, COMMENTS_DOC_DEFAULT_ACTOR)
    }

    pub fn try_new_empty(
        comments_doc_id: &str,
        notebook_ref: &NotebookCommentRef,
    ) -> Result<Self, CommentsDocError> {
        let actor = ActorId::random().to_string();
        Self::try_new_with_actor(comments_doc_id, notebook_ref, &actor)
    }

    pub fn try_new_sync_target(comments_doc_id: &str) -> Result<Self, CommentsDocError> {
        let actor = ActorId::random().to_string();
        Self::try_new_sync_target_with_actor(comments_doc_id, &actor)
    }

    pub fn try_new_sync_target_with_actor(
        comments_doc_id: &str,
        actor_label: &str,
    ) -> Result<Self, CommentsDocError> {
        validate_comments_doc_id(comments_doc_id)?;
        let mut doc = Self::schema_seed_doc()?;
        doc.set_actor(ActorId::from(actor_label.as_bytes()));
        Ok(Self {
            doc,
            comments_doc_id: comments_doc_id.to_string(),
        })
    }

    pub fn try_new_with_actor(
        comments_doc_id: &str,
        notebook_ref: &NotebookCommentRef,
        actor_label: &str,
    ) -> Result<Self, CommentsDocError> {
        validate_comments_doc_id(comments_doc_id)?;
        let mut doc = Self::schema_seed_doc()?;
        doc.set_actor(ActorId::from(actor_label.as_bytes()));
        let mut comments = Self {
            doc,
            comments_doc_id: String::new(),
        };
        comments.set_comments_doc_id(comments_doc_id)?;
        comments.set_notebook_ref(notebook_ref)?;
        Ok(comments)
    }

    pub fn load(bytes: &[u8], expected_comments_doc_id: &str) -> Result<Self, CommentsDocError> {
        Self::load_with_actor(bytes, expected_comments_doc_id, COMMENTS_DOC_DEFAULT_ACTOR)
    }

    pub fn load_with_actor(
        bytes: &[u8],
        expected_comments_doc_id: &str,
        actor_label: &str,
    ) -> Result<Self, CommentsDocError> {
        validate_comments_doc_id(expected_comments_doc_id)?;
        let mut doc = AutoCommit::load(bytes)?;
        doc.set_actor(ActorId::from(actor_label.as_bytes()));
        let comments = Self {
            doc,
            comments_doc_id: expected_comments_doc_id.to_string(),
        };
        comments.ensure_raw_comments_doc_id_matches()?;
        Ok(comments)
    }

    pub fn new(comments_doc_id: &str, notebook_ref: &NotebookCommentRef) -> Self {
        Self::try_new(comments_doc_id, notebook_ref)
            .unwrap_or_else(|err| panic!("seed comments doc schema: {err}"))
    }

    pub fn new_with_actor(
        comments_doc_id: &str,
        notebook_ref: &NotebookCommentRef,
        actor_label: &str,
    ) -> Self {
        Self::try_new_with_actor(comments_doc_id, notebook_ref, actor_label)
            .unwrap_or_else(|err| panic!("seed comments doc schema: {err}"))
    }

    fn schema_seed_doc() -> Result<AutoCommit, CommentsDocError> {
        AutoCommit::load(COMMENTS_DOC_GENESIS_V1_BYTES).map_err(Into::into)
    }

    #[cfg(test)]
    fn generated_schema_seed_doc() -> Result<AutoCommit, CommentsDocError> {
        let mut doc = AutoCommit::new();
        doc.set_actor(ActorId::from(COMMENTS_DOC_SCHEMA_SEED_ACTOR_BYTES));
        scaffold_comments_doc_schema(&mut doc)?;
        let _ = doc.commit_with(
            CommitOptions::default()
                .with_message("Seed nteract comments doc schema")
                .with_time(0),
        );
        Ok(doc)
    }

    #[cfg(test)]
    fn from_doc_unchecked(doc: AutoCommit) -> Self {
        let comments_doc_id = read_str(&doc, &ROOT, "comments_doc_id").unwrap_or_default();
        Self {
            doc,
            comments_doc_id,
        }
    }

    pub fn from_doc(doc: AutoCommit) -> Result<Self, CommentsDocError> {
        let comments_doc_id = read_str(&doc, &ROOT, "comments_doc_id")
            .ok_or(CommentsDocError::MissingCommentsDocId)?;
        validate_comments_doc_id(&comments_doc_id)?;
        let comments = Self {
            doc,
            comments_doc_id,
        };
        comments.ensure_raw_comments_doc_id_matches()?;
        Ok(comments)
    }

    pub fn doc(&self) -> &AutoCommit {
        &self.doc
    }

    pub fn doc_mut(&mut self) -> &mut AutoCommit {
        &mut self.doc
    }

    pub fn comments_doc_id(&self) -> Option<String> {
        Some(self.comments_doc_id.clone())
    }

    pub fn raw_comments_doc_id(&self) -> Option<String> {
        read_str(&self.doc, &ROOT, "comments_doc_id")
    }

    pub fn notebook_ref(&self) -> Option<NotebookCommentRef> {
        automunge::read_json_value(&self.doc, &ROOT, "notebook_ref")
            .and_then(|value| serde_json::from_value(value).ok())
    }

    pub fn is_materialized(&self) -> bool {
        self.ensure_raw_comments_doc_id_matches().is_ok()
    }

    pub fn get_heads(&mut self) -> Vec<automerge::ChangeHash> {
        self.doc.get_heads()
    }

    pub fn save(&mut self) -> Vec<u8> {
        self.doc.save()
    }

    fn set_comments_doc_id(&mut self, comments_doc_id: &str) -> Result<(), CommentsDocError> {
        validate_comments_doc_id(comments_doc_id)?;
        self.comments_doc_id = comments_doc_id.to_string();
        self.doc.put(&ROOT, "comments_doc_id", comments_doc_id)?;
        Ok(())
    }

    fn ensure_raw_comments_doc_id_matches(&self) -> Result<(), CommentsDocError> {
        validate_comments_doc_id(&self.comments_doc_id)?;
        let conflicts = self
            .doc
            .get_all(&ROOT, "comments_doc_id")
            .unwrap_or_default();
        let mut values = HashSet::new();
        for (value, _) in conflicts {
            let Some(value) = scalar_string(&value) else {
                return Err(CommentsDocError::CommentsDocIdConflict);
            };
            values.insert(value);
        }
        if values.len() > 1 {
            return Err(CommentsDocError::CommentsDocIdConflict);
        }
        let actual = values
            .into_iter()
            .next()
            .ok_or(CommentsDocError::MissingCommentsDocId)?;
        validate_comments_doc_id(&actual)?;
        if actual != self.comments_doc_id {
            return Err(CommentsDocError::CommentsDocIdMismatch {
                expected: self.comments_doc_id.clone(),
                actual,
            });
        }
        Ok(())
    }

    fn set_notebook_ref(
        &mut self,
        notebook_ref: &NotebookCommentRef,
    ) -> Result<(), CommentsDocError> {
        let value = serde_json::to_value(notebook_ref)?;
        automunge::update_json_at_key(&mut self.doc, &ROOT, "notebook_ref", &value)?;
        Ok(())
    }

    pub fn create_thread(
        &mut self,
        thread_id: &str,
        message_id: &str,
        anchor: &CommentAnchor,
        body: &str,
        after_thread_id: Option<&str>,
        created_at: &str,
    ) -> Result<CommentCreated, CommentsDocError> {
        if self.thread_obj(thread_id).is_some() {
            return Err(CommentsDocError::ThreadAlreadyExists(thread_id.to_string()));
        }
        let threads = self.scaffold_map("threads")?;
        let position = self.compute_thread_position(anchor, after_thread_id)?;
        let thread = self.doc.put_object(&threads, thread_id, ObjType::Map)?;
        self.doc.put(&thread, "id", thread_id)?;
        self.doc.put(&thread, "position", position.as_str())?;
        self.doc
            .put(&thread, "thread_order_scope", anchor.thread_order_scope())?;
        self.doc.put(&thread, "status", "open")?;
        self.doc.put(&thread, "mutation_state", "pending")?;
        self.doc.put(&thread, "created_at", created_at)?;
        let anchor_value = serde_json::to_value(anchor)?;
        automunge::put_json_at_key_batched(&mut self.doc, &thread, "anchor", &anchor_value)?;
        let messages = self.doc.put_object(&thread, "messages", ObjType::Map)?;
        self.create_message_in_map(&messages, message_id, body, None, created_at)?;
        Ok(CommentCreated {
            thread_id: thread_id.to_string(),
            message_id: message_id.to_string(),
        })
    }

    pub fn reply(
        &mut self,
        thread_id: &str,
        message_id: &str,
        body: &str,
        after_message_id: Option<&str>,
        created_at: &str,
    ) -> Result<CommentReplied, CommentsDocError> {
        let thread = self
            .thread_obj(thread_id)
            .ok_or_else(|| CommentsDocError::ThreadNotFound(thread_id.to_string()))?;
        let messages = self
            .messages_obj(&thread)
            .ok_or(CommentsDocError::MissingScaffold("messages"))?;
        if self.doc.get(&messages, message_id)?.is_some() {
            return Err(CommentsDocError::MessageAlreadyExists {
                thread_id: thread_id.to_string(),
                message_id: message_id.to_string(),
            });
        }
        self.create_message_in_map(&messages, message_id, body, after_message_id, created_at)?;
        Ok(CommentReplied {
            thread_id: thread_id.to_string(),
            message_id: message_id.to_string(),
        })
    }

    pub fn accept_thread_creation(
        &mut self,
        thread_id: &str,
        actor_label: &str,
        authority: &str,
    ) -> Result<(), CommentsDocError> {
        let thread = self.thread_or_error(thread_id)?;
        let anchor = self
            .read_anchor(&thread)
            .ok_or_else(|| CommentsDocError::ThreadNotFound(thread_id.to_string()))?;
        let anchor_json = serde_json::to_string(&anchor)?;
        let position = read_str(&self.doc, &thread, "position")
            .unwrap_or_else(|| DEFAULT_POSITION.to_string());
        let created_at = read_str(&self.doc, &thread, "created_at").unwrap_or_default();
        self.doc
            .put(&thread, "authority_mutation_state", "accepted")?;
        self.doc.put(&thread, "authority_status", "open")?;
        self.doc
            .put(&thread, "authority_anchor_json", anchor_json.as_str())?;
        self.doc
            .put(&thread, "authority_position", position.as_str())?;
        self.doc
            .put(&thread, "authority_created_at", created_at.as_str())?;
        self.doc
            .put(&thread, "authority_created_by_actor_label", actor_label)?;
        self.doc
            .put(&thread, "authority_created_by_authority", authority)?;
        Ok(())
    }

    pub fn reject_thread_creation(
        &mut self,
        thread_id: &str,
        reason: &str,
    ) -> Result<(), CommentsDocError> {
        let thread = self.thread_or_error(thread_id)?;
        if let Some(anchor) = self.read_anchor(&thread) {
            let anchor_json = serde_json::to_string(&anchor)?;
            self.doc
                .put(&thread, "authority_anchor_json", anchor_json.as_str())?;
        }
        let position = read_str(&self.doc, &thread, "position")
            .unwrap_or_else(|| DEFAULT_POSITION.to_string());
        let created_at = read_str(&self.doc, &thread, "created_at").unwrap_or_default();
        self.doc
            .put(&thread, "authority_mutation_state", "rejected")?;
        self.doc.put(&thread, "authority_status", "open")?;
        self.doc
            .put(&thread, "authority_position", position.as_str())?;
        self.doc
            .put(&thread, "authority_created_at", created_at.as_str())?;
        self.doc
            .put(&thread, "authority_rejection_reason", reason)?;
        Ok(())
    }

    pub fn accept_message(
        &mut self,
        thread_id: &str,
        message_id: &str,
        actor_label: &str,
        authority: &str,
    ) -> Result<(), CommentsDocError> {
        let message = self.message_or_error(thread_id, message_id)?;
        let body = read_text_at_key(&self.doc, &message, "body").unwrap_or_default();
        let position = read_str(&self.doc, &message, "position")
            .unwrap_or_else(|| DEFAULT_POSITION.to_string());
        let created_at = read_str(&self.doc, &message, "created_at").unwrap_or_default();
        self.doc
            .put(&message, "authority_mutation_state", "accepted")?;
        self.doc.put(&message, "authority_body", body.as_str())?;
        self.doc
            .put(&message, "authority_position", position.as_str())?;
        self.doc
            .put(&message, "authority_created_at", created_at.as_str())?;
        self.doc
            .put(&message, "authority_created_by_actor_label", actor_label)?;
        self.doc
            .put(&message, "authority_created_by_authority", authority)?;
        Ok(())
    }

    pub fn reject_message(
        &mut self,
        thread_id: &str,
        message_id: &str,
        reason: &str,
    ) -> Result<(), CommentsDocError> {
        let message = self.message_or_error(thread_id, message_id)?;
        let body = read_text_at_key(&self.doc, &message, "body").unwrap_or_default();
        let position = read_str(&self.doc, &message, "position")
            .unwrap_or_else(|| DEFAULT_POSITION.to_string());
        let created_at = read_str(&self.doc, &message, "created_at").unwrap_or_default();
        self.doc
            .put(&message, "authority_mutation_state", "rejected")?;
        self.doc.put(&message, "authority_body", body.as_str())?;
        self.doc
            .put(&message, "authority_position", position.as_str())?;
        self.doc
            .put(&message, "authority_created_at", created_at.as_str())?;
        self.doc
            .put(&message, "authority_rejection_reason", reason)?;
        Ok(())
    }

    pub fn resolve_thread(
        &mut self,
        thread_id: &str,
        actor_label: &str,
        authority: &str,
        resolved_at: &str,
    ) -> Result<(), CommentsDocError> {
        let thread = self.thread_or_error(thread_id)?;
        self.doc.put(&thread, "authority_status", "resolved")?;
        self.doc
            .put(&thread, "authority_resolved_at", resolved_at)?;
        self.doc
            .put(&thread, "authority_resolved_by_actor_label", actor_label)?;
        self.doc
            .put(&thread, "authority_resolved_by_authority", authority)?;
        Ok(())
    }

    pub fn reopen_thread(
        &mut self,
        thread_id: &str,
        actor_label: &str,
        authority: &str,
        reopened_at: &str,
    ) -> Result<(), CommentsDocError> {
        let thread = self.thread_or_error(thread_id)?;
        self.doc.put(&thread, "authority_status", "open")?;
        self.doc
            .put(&thread, "authority_reopened_at", reopened_at)?;
        self.doc
            .put(&thread, "authority_reopened_by_actor_label", actor_label)?;
        self.doc
            .put(&thread, "authority_reopened_by_authority", authority)?;
        Ok(())
    }

    pub fn edit_message_body(
        &mut self,
        thread_id: &str,
        message_id: &str,
        body: &str,
    ) -> Result<(), CommentsDocError> {
        let message = self.message_or_error(thread_id, message_id)?;
        let body_obj = read_text_obj(&self.doc, &message, "body").ok_or(
            CommentsDocError::MessageNotFound {
                thread_id: thread_id.to_string(),
                message_id: message_id.to_string(),
            },
        )?;
        self.doc.update_text(&body_obj, body)?;
        Ok(())
    }

    pub fn read_projection(
        &self,
        authority_actor_labels: &[&str],
        current_cell_order: Option<&[String]>,
    ) -> Result<CommentsProjection, CommentsDocError> {
        self.ensure_raw_comments_doc_id_matches()?;
        let comments_doc_id = self
            .comments_doc_id()
            .ok_or(CommentsDocError::MissingCommentsDocId)?;
        let authority_actors = authority_actor_set(authority_actor_labels);
        let Some(threads_obj) = self.get_map("threads") else {
            return Ok(CommentsProjection {
                comments_doc_id,
                threads: Vec::new(),
            });
        };

        let mut threads = Vec::new();
        for thread_id in self.doc.keys(&threads_obj) {
            let Some((Value::Object(ObjType::Map), thread_obj)) = self
                .doc
                .get(&threads_obj, thread_id.as_str())
                .ok()
                .flatten()
            else {
                continue;
            };
            let mut mutation_state = self.projected_mutation_state(&thread_obj, &authority_actors);
            let projected_from_authority = matches!(
                mutation_state,
                ProjectedMutationState::Accepted | ProjectedMutationState::Rejected
            );
            let Some(raw_anchor) = self.read_anchor(&thread_obj) else {
                continue;
            };
            let anchor = if projected_from_authority {
                match self.projected_thread_anchor(&thread_obj, &authority_actors) {
                    Some(anchor) => anchor,
                    None => {
                        mutation_state = ProjectedMutationState::Unverified;
                        raw_anchor
                    }
                }
            } else {
                raw_anchor
            };
            let mut status = self.projected_thread_status(&thread_obj, &authority_actors);
            if projected_from_authority && status == ProjectedThreadStatus::Unverified {
                mutation_state = ProjectedMutationState::Unverified;
            }
            if status == ProjectedThreadStatus::Resolved
                && self.has_visible_key(&thread_obj, "authority_resolved_at")
                && !has_trusted_str(
                    &self.doc,
                    &thread_obj,
                    "authority_resolved_at",
                    &authority_actors,
                )
            {
                status = ProjectedThreadStatus::Unverified;
                mutation_state = ProjectedMutationState::Unverified;
            }
            if projected_from_authority
                && mutation_state != ProjectedMutationState::Unverified
                && (!has_trusted_str(
                    &self.doc,
                    &thread_obj,
                    "authority_position",
                    &authority_actors,
                ) || !has_trusted_str(
                    &self.doc,
                    &thread_obj,
                    "authority_created_at",
                    &authority_actors,
                ))
            {
                mutation_state = ProjectedMutationState::Unverified;
            }
            if mutation_state == ProjectedMutationState::Accepted
                && (!has_trusted_str(
                    &self.doc,
                    &thread_obj,
                    "authority_created_by_actor_label",
                    &authority_actors,
                ) || !has_trusted_str(
                    &self.doc,
                    &thread_obj,
                    "authority_created_by_authority",
                    &authority_actors,
                ))
            {
                mutation_state = ProjectedMutationState::Unverified;
            }
            if mutation_state == ProjectedMutationState::Rejected
                && !has_trusted_str(
                    &self.doc,
                    &thread_obj,
                    "authority_rejection_reason",
                    &authority_actors,
                )
            {
                mutation_state = ProjectedMutationState::Unverified;
            }
            let accepted = mutation_state == ProjectedMutationState::Accepted;
            let rejected = mutation_state == ProjectedMutationState::Rejected;
            let position = if accepted || rejected {
                read_trusted_str(
                    &self.doc,
                    &thread_obj,
                    "authority_position",
                    &authority_actors,
                )
            } else {
                read_str(&self.doc, &thread_obj, "position")
            }
            .unwrap_or_else(|| DEFAULT_POSITION.to_string());
            let created_at = if accepted || rejected {
                read_trusted_str(
                    &self.doc,
                    &thread_obj,
                    "authority_created_at",
                    &authority_actors,
                )
            } else {
                read_str(&self.doc, &thread_obj, "created_at")
            }
            .unwrap_or_default();
            let resolved_at = if status == ProjectedThreadStatus::Resolved {
                read_trusted_str(
                    &self.doc,
                    &thread_obj,
                    "authority_resolved_at",
                    &authority_actors,
                )
            } else {
                None
            };
            let resolved_by_actor_label = if status == ProjectedThreadStatus::Resolved {
                read_trusted_str(
                    &self.doc,
                    &thread_obj,
                    "authority_resolved_by_actor_label",
                    &authority_actors,
                )
            } else {
                None
            };
            let resolved_by_authority = if status == ProjectedThreadStatus::Resolved {
                read_trusted_str(
                    &self.doc,
                    &thread_obj,
                    "authority_resolved_by_authority",
                    &authority_actors,
                )
            } else {
                None
            };
            threads.push(CommentThreadSnapshot {
                id: thread_id.clone(),
                anchor: anchor.clone(),
                position,
                status,
                mutation_state,
                trusted: accepted && status != ProjectedThreadStatus::Unverified,
                messages: self.read_messages(&thread_id, &thread_obj, &authority_actors),
                badge_cell_ids: anchor.badge_cell_ids(current_cell_order),
                created_at,
                created_by_actor_label: if accepted || rejected {
                    read_trusted_str(
                        &self.doc,
                        &thread_obj,
                        "authority_created_by_actor_label",
                        &authority_actors,
                    )
                } else {
                    None
                },
                created_by_authority: if accepted || rejected {
                    read_trusted_str(
                        &self.doc,
                        &thread_obj,
                        "authority_created_by_authority",
                        &authority_actors,
                    )
                } else {
                    None
                },
                rejection_reason: if rejected {
                    read_trusted_str(
                        &self.doc,
                        &thread_obj,
                        "authority_rejection_reason",
                        &authority_actors,
                    )
                } else {
                    None
                },
                resolved_at,
                resolved_by_actor_label,
                resolved_by_authority,
            });
        }

        threads.sort_by(|a, b| {
            a.anchor
                .thread_order_scope()
                .cmp(&b.anchor.thread_order_scope())
                .then_with(|| a.position.cmp(&b.position))
                .then_with(|| a.id.cmp(&b.id))
        });
        Ok(CommentsProjection {
            comments_doc_id,
            threads,
        })
    }

    pub fn get_comments_for_cell(
        &self,
        cell_id: &str,
        authority_actor_labels: &[&str],
        current_cell_order: Option<&[String]>,
    ) -> Result<Vec<CommentThreadSnapshot>, CommentsDocError> {
        Ok(self
            .read_projection(authority_actor_labels, current_cell_order)?
            .threads
            .into_iter()
            .filter(|thread| thread.badge_cell_ids.iter().any(|id| id == cell_id))
            .collect())
    }

    pub fn generate_sync_message(&mut self, peer_state: &mut sync::State) -> Option<sync::Message> {
        self.doc.sync().generate_sync_message(peer_state)
    }

    pub fn generate_sync_message_recovering(
        &mut self,
        peer_state: &mut sync::State,
        label: &str,
    ) -> Result<Option<sync::Message>, AutomergeOperationError> {
        let mut context = CommentsSyncRecoveryContext {
            doc: self,
            peer_state,
        };
        recoverable_automerge_operation(
            label,
            &mut context,
            |context| Ok(context.doc.generate_sync_message(context.peer_state)),
            |_| false,
            |context| {
                *context.peer_state = sync::State::new();
                context.doc.rebuild_from_save()
            },
        )
    }

    pub fn receive_sync_message_with_changes(
        &mut self,
        peer_state: &mut sync::State,
        message: sync::Message,
    ) -> Result<bool, CommentsDocError> {
        let before_doc = self.doc.clone();
        let before_actor = self.doc.get_actor().clone();
        let heads_before = self.doc.get_heads();
        if let Err(err) = self.doc.sync().receive_sync_message(peer_state, message) {
            return Err(CommentsDocError::Automerge(err));
        }
        let heads_changed = self.doc.get_heads() != heads_before;
        if heads_changed || self.is_materialized() {
            if let Err(err) = self.ensure_raw_comments_doc_id_matches() {
                self.doc = before_doc;
                self.doc.set_actor(before_actor);
                *peer_state = sync::State::new();
                return Err(err);
            }
        }
        Ok(heads_changed)
    }

    pub fn receive_sync_message_with_changes_recovering(
        &mut self,
        peer_state: &mut sync::State,
        message: sync::Message,
        label: &str,
    ) -> Result<bool, CommentsDocError> {
        let label = label.to_string();
        let should_retry = match catch_automerge_result(label.clone(), || {
            self.receive_sync_message_with_changes(peer_state, message.clone())
        }) {
            AutomergeAttempt::Success(changed) => return Ok(changed),
            AutomergeAttempt::OperationError(CommentsDocError::Automerge(source))
                if is_recoverable_sync_error(&source) =>
            {
                true
            }
            AutomergeAttempt::OperationError(source) => return Err(source),
            AutomergeAttempt::Panic(error) => {
                return Err(CommentsDocError::from(AutomergeOperationError::Panic(
                    error,
                )));
            }
        };
        debug_assert!(should_retry);

        *peer_state = sync::State::new();
        self.rebuild_from_save().map_err(|source| {
            CommentsDocError::from(AutomergeOperationError::rebuild_failed(
                label.clone(),
                source,
            ))
        })?;

        match catch_automerge_result(label.clone(), || {
            self.receive_sync_message_with_changes(peer_state, message)
        }) {
            AutomergeAttempt::Success(changed) => Ok(changed),
            AutomergeAttempt::OperationError(source) => Err(source),
            AutomergeAttempt::Panic(error) => Err(CommentsDocError::from(
                AutomergeOperationError::Panic(error),
            )),
        }
    }

    pub fn rebuild_from_save(&mut self) -> Result<(), AutomergeRebuildError> {
        catch_automerge_panic("comments-doc-rebuild-from-save", || {
            let actor = self.doc.get_actor().clone();
            let bytes = self.doc.save();
            match AutoCommit::load(&bytes) {
                Ok(mut doc) => {
                    doc.set_actor(actor);
                    self.doc = doc;
                    Ok(())
                }
                Err(source) => Err(AutomergeRebuildError::load(source)),
            }
        })?
    }

    fn create_message_in_map(
        &mut self,
        messages: &ObjId,
        message_id: &str,
        body: &str,
        after_message_id: Option<&str>,
        created_at: &str,
    ) -> Result<(), CommentsDocError> {
        let position = self.compute_message_position(messages, after_message_id)?;
        let message = self.doc.put_object(messages, message_id, ObjType::Map)?;
        self.doc.put(&message, "id", message_id)?;
        self.doc.put(&message, "position", position.as_str())?;
        self.doc.put(&message, "mutation_state", "pending")?;
        self.doc.put(&message, "created_at", created_at)?;
        let body_obj = self.doc.put_object(&message, "body", ObjType::Text)?;
        if !body.is_empty() {
            self.doc.splice_text(&body_obj, 0, 0, body)?;
        }
        Ok(())
    }

    fn read_messages(
        &self,
        thread_id: &str,
        thread_obj: &ObjId,
        authority_actors: &HashSet<ActorId>,
    ) -> Vec<CommentMessageSnapshot> {
        let Some(messages_obj) = self.messages_obj(thread_obj) else {
            return Vec::new();
        };
        let mut messages = Vec::new();
        for message_id in self.doc.keys(&messages_obj) {
            let Some((Value::Object(ObjType::Map), message_obj)) = self
                .doc
                .get(&messages_obj, message_id.as_str())
                .ok()
                .flatten()
            else {
                continue;
            };
            let mut mutation_state = self.projected_mutation_state(&message_obj, authority_actors);
            let projected_from_authority = matches!(
                mutation_state,
                ProjectedMutationState::Accepted | ProjectedMutationState::Rejected
            );
            if projected_from_authority
                && (!has_trusted_str(&self.doc, &message_obj, "authority_body", authority_actors)
                    || !has_trusted_str(
                        &self.doc,
                        &message_obj,
                        "authority_position",
                        authority_actors,
                    )
                    || !has_trusted_str(
                        &self.doc,
                        &message_obj,
                        "authority_created_at",
                        authority_actors,
                    ))
            {
                mutation_state = ProjectedMutationState::Unverified;
            }
            if mutation_state == ProjectedMutationState::Accepted
                && (!has_trusted_str(
                    &self.doc,
                    &message_obj,
                    "authority_created_by_actor_label",
                    authority_actors,
                ) || !has_trusted_str(
                    &self.doc,
                    &message_obj,
                    "authority_created_by_authority",
                    authority_actors,
                ))
            {
                mutation_state = ProjectedMutationState::Unverified;
            }
            if mutation_state == ProjectedMutationState::Rejected
                && !has_trusted_str(
                    &self.doc,
                    &message_obj,
                    "authority_rejection_reason",
                    authority_actors,
                )
            {
                mutation_state = ProjectedMutationState::Unverified;
            }
            let accepted = mutation_state == ProjectedMutationState::Accepted;
            let rejected = mutation_state == ProjectedMutationState::Rejected;
            let position = if accepted || rejected {
                read_trusted_str(
                    &self.doc,
                    &message_obj,
                    "authority_position",
                    authority_actors,
                )
            } else {
                read_str(&self.doc, &message_obj, "position")
            }
            .unwrap_or_else(|| DEFAULT_POSITION.to_string());
            let body = if accepted || rejected {
                read_trusted_str(&self.doc, &message_obj, "authority_body", authority_actors)
                    .unwrap_or_default()
            } else {
                read_text_at_key(&self.doc, &message_obj, "body").unwrap_or_default()
            };
            let accepted = mutation_state == ProjectedMutationState::Accepted;
            let rejected = mutation_state == ProjectedMutationState::Rejected;
            let created_at = if accepted || rejected {
                read_trusted_str(
                    &self.doc,
                    &message_obj,
                    "authority_created_at",
                    authority_actors,
                )
            } else {
                read_str(&self.doc, &message_obj, "created_at")
            }
            .unwrap_or_default();
            messages.push(CommentMessageSnapshot {
                id: message_id.clone(),
                position,
                body,
                mutation_state,
                trusted: accepted,
                created_at,
                created_by_actor_label: if accepted || rejected {
                    read_trusted_str(
                        &self.doc,
                        &message_obj,
                        "authority_created_by_actor_label",
                        authority_actors,
                    )
                } else {
                    None
                },
                created_by_authority: if accepted || rejected {
                    read_trusted_str(
                        &self.doc,
                        &message_obj,
                        "authority_created_by_authority",
                        authority_actors,
                    )
                } else {
                    None
                },
                rejection_reason: if rejected {
                    read_trusted_str(
                        &self.doc,
                        &message_obj,
                        "authority_rejection_reason",
                        authority_actors,
                    )
                } else {
                    None
                },
            });
        }
        messages.sort_by(|a, b| a.position.cmp(&b.position).then_with(|| a.id.cmp(&b.id)));
        tracing::trace!(
            "[comments-doc] projected {} messages for thread {}",
            messages.len(),
            thread_id
        );
        messages
    }

    fn projected_mutation_state(
        &self,
        obj: &ObjId,
        authority_actors: &HashSet<ActorId>,
    ) -> ProjectedMutationState {
        match read_trusted_str(&self.doc, obj, "authority_mutation_state", authority_actors)
            .as_deref()
        {
            Some("accepted") => ProjectedMutationState::Accepted,
            Some("rejected") => ProjectedMutationState::Rejected,
            Some(_) => ProjectedMutationState::Unverified,
            None if self.has_visible_key(obj, "authority_mutation_state") => {
                ProjectedMutationState::Unverified
            }
            None => ProjectedMutationState::Pending,
        }
    }

    fn projected_thread_status(
        &self,
        thread_obj: &ObjId,
        authority_actors: &HashSet<ActorId>,
    ) -> ProjectedThreadStatus {
        match read_trusted_str(&self.doc, thread_obj, "authority_status", authority_actors)
            .as_deref()
        {
            Some("open") => ProjectedThreadStatus::Open,
            Some("resolved") => ProjectedThreadStatus::Resolved,
            Some(_) => ProjectedThreadStatus::Unverified,
            None if self.has_visible_key(thread_obj, "authority_status") => {
                ProjectedThreadStatus::Unverified
            }
            None => ProjectedThreadStatus::Open,
        }
    }

    fn read_anchor(&self, thread_obj: &ObjId) -> Option<CommentAnchor> {
        let value = automunge::read_json_value(&self.doc, thread_obj, "anchor")?;
        serde_json::from_value(value).ok()
    }

    fn projected_thread_anchor(
        &self,
        thread_obj: &ObjId,
        authority_actors: &HashSet<ActorId>,
    ) -> Option<CommentAnchor> {
        read_trusted_str(
            &self.doc,
            thread_obj,
            "authority_anchor_json",
            authority_actors,
        )
        .and_then(|value| serde_json::from_str(&value).ok())
    }

    fn has_visible_key(&self, obj: &ObjId, key: &str) -> bool {
        self.doc.get(obj, key).ok().flatten().is_some()
    }

    fn get_map(&self, key: &str) -> Option<ObjId> {
        match self.doc.get(&ROOT, key).ok().flatten() {
            Some((Value::Object(ObjType::Map), obj)) => Some(obj),
            _ => None,
        }
    }

    fn scaffold_map(&mut self, key: &'static str) -> Result<ObjId, CommentsDocError> {
        if let Some(obj) = self.get_map(key) {
            return Ok(obj);
        }
        Ok(self.doc.put_object(&ROOT, key, ObjType::Map)?)
    }

    fn thread_obj(&self, thread_id: &str) -> Option<ObjId> {
        let threads = self.get_map("threads")?;
        match self.doc.get(&threads, thread_id).ok().flatten() {
            Some((Value::Object(ObjType::Map), obj)) => Some(obj),
            _ => None,
        }
    }

    fn thread_or_error(&self, thread_id: &str) -> Result<ObjId, CommentsDocError> {
        self.thread_obj(thread_id)
            .ok_or_else(|| CommentsDocError::ThreadNotFound(thread_id.to_string()))
    }

    fn messages_obj(&self, thread_obj: &ObjId) -> Option<ObjId> {
        match self.doc.get(thread_obj, "messages").ok().flatten() {
            Some((Value::Object(ObjType::Map), obj)) => Some(obj),
            _ => None,
        }
    }

    fn message_or_error(
        &self,
        thread_id: &str,
        message_id: &str,
    ) -> Result<ObjId, CommentsDocError> {
        let thread = self.thread_or_error(thread_id)?;
        let messages = self
            .messages_obj(&thread)
            .ok_or(CommentsDocError::MissingScaffold("messages"))?;
        match self.doc.get(&messages, message_id).ok().flatten() {
            Some((Value::Object(ObjType::Map), obj)) => Ok(obj),
            _ => Err(CommentsDocError::MessageNotFound {
                thread_id: thread_id.to_string(),
                message_id: message_id.to_string(),
            }),
        }
    }

    fn compute_thread_position(
        &self,
        anchor: &CommentAnchor,
        after_thread_id: Option<&str>,
    ) -> Result<String, CommentsDocError> {
        let scope = anchor.thread_order_scope();
        let Some(threads_obj) = self.get_map("threads") else {
            return Ok(FractionalIndex::default().to_string());
        };
        let mut pairs = Vec::new();
        let mut found_after_thread = after_thread_id.is_none();
        for thread_id in self.doc.keys(&threads_obj) {
            let Some((Value::Object(ObjType::Map), thread_obj)) = self
                .doc
                .get(&threads_obj, thread_id.as_str())
                .ok()
                .flatten()
            else {
                continue;
            };
            if read_str(&self.doc, &thread_obj, "thread_order_scope").as_deref()
                != Some(scope.as_str())
            {
                continue;
            }
            let is_after_thread = after_thread_id == Some(thread_id.as_str());
            if is_after_thread {
                found_after_thread = true;
            }
            let position = read_str(&self.doc, &thread_obj, "position")
                .unwrap_or_else(|| DEFAULT_POSITION.to_string());
            match parse_fractional_position(&position) {
                Ok(_) => pairs.push((position, thread_id)),
                Err(err) if is_after_thread => return Err(err),
                Err(err) => {
                    tracing::warn!(
                        "[comments-doc] skipping thread {} with invalid position: {}",
                        thread_id,
                        err
                    );
                }
            }
        }
        if let (Some(after_thread_id), false) = (after_thread_id, found_after_thread) {
            return Err(CommentsDocError::AfterThreadNotFound(
                after_thread_id.to_string(),
            ));
        }
        compute_position_after(&pairs, after_thread_id)
    }

    fn compute_message_position(
        &self,
        messages_obj: &ObjId,
        after_message_id: Option<&str>,
    ) -> Result<String, CommentsDocError> {
        let mut pairs = Vec::new();
        let mut found_after_message = after_message_id.is_none();
        for message_id in self.doc.keys(messages_obj) {
            let Some((Value::Object(ObjType::Map), message_obj)) = self
                .doc
                .get(messages_obj, message_id.as_str())
                .ok()
                .flatten()
            else {
                continue;
            };
            let is_after_message = after_message_id == Some(message_id.as_str());
            if is_after_message {
                found_after_message = true;
            }
            let position = read_str(&self.doc, &message_obj, "position")
                .unwrap_or_else(|| DEFAULT_POSITION.to_string());
            match parse_fractional_position(&position) {
                Ok(_) => pairs.push((position, message_id)),
                Err(err) if is_after_message => return Err(err),
                Err(err) => {
                    tracing::warn!(
                        "[comments-doc] skipping message {} with invalid position: {}",
                        message_id,
                        err
                    );
                }
            }
        }
        if let (Some(after_message_id), false) = (after_message_id, found_after_message) {
            return Err(CommentsDocError::AfterMessageNotFound(
                after_message_id.to_string(),
            ));
        }
        compute_position_after(&pairs, after_message_id)
    }
}

fn validate_comments_doc_id(comments_doc_id: &str) -> Result<(), CommentsDocError> {
    if comments_doc_id.is_empty() {
        return Err(CommentsDocError::MissingCommentsDocId);
    }
    if !comments_doc_id.starts_with("comments:")
        || comments_doc_id == "comments:"
        || comments_doc_id.trim() != comments_doc_id
        || comments_doc_id
            .chars()
            .any(|ch| ch.is_control() || ch == '/' || ch == '\\')
    {
        return Err(CommentsDocError::InvalidCommentsDocId(
            comments_doc_id.to_string(),
        ));
    }
    Ok(())
}

#[cfg(test)]
fn scaffold_comments_doc_schema(doc: &mut AutoCommit) -> Result<(), CommentsDocError> {
    doc.put(
        &ROOT,
        "schema_version",
        ScalarValue::Uint(COMMENTS_DOC_SCHEMA_VERSION),
    )?;
    doc.put(&ROOT, "comments_doc_id", "")?;
    doc.put_object(&ROOT, "notebook_ref", ObjType::Map)?;
    doc.put_object(&ROOT, "threads", ObjType::Map)?;
    Ok(())
}

fn compute_position_after(
    pairs: &[(String, String)],
    after_id: Option<&str>,
) -> Result<String, CommentsDocError> {
    let mut sorted = pairs.to_vec();
    sorted.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
    let index = after_id.and_then(|id| sorted.iter().position(|(_, item_id)| item_id == id));
    let position = match (index, sorted.as_slice()) {
        (None, []) => FractionalIndex::default(),
        (None, [first, ..]) => FractionalIndex::new_before(&parse_fractional_position(&first.0)?),
        (Some(i), _) if i + 1 < sorted.len() => {
            let left = parse_fractional_position(&sorted[i].0)?;
            let right = parse_fractional_position(&sorted[i + 1].0)?;
            FractionalIndex::new_between(&left, &right)
                .unwrap_or_else(|| FractionalIndex::new_after(&left))
        }
        (Some(i), _) => FractionalIndex::new_after(&parse_fractional_position(&sorted[i].0)?),
    };
    Ok(position.to_string())
}

fn read_str<O: AsRef<ObjId>>(doc: &AutoCommit, obj: O, key: &str) -> Option<String> {
    doc.get(obj, key)
        .ok()
        .flatten()
        .and_then(|(value, _)| scalar_string(&value))
}

fn scalar_string(value: &Value<'_>) -> Option<String> {
    match value {
        Value::Scalar(s) => match s.as_ref() {
            ScalarValue::Str(s) => Some(s.to_string()),
            _ => None,
        },
        _ => None,
    }
}

fn read_trusted_str(
    doc: &AutoCommit,
    obj: &ObjId,
    key: &str,
    authority_actors: &HashSet<ActorId>,
) -> Option<String> {
    doc.get(obj, key).ok().flatten().and_then(|(value, op_id)| {
        if !obj_id_authored_by_authority(&op_id, authority_actors) {
            return None;
        }
        match value {
            Value::Scalar(s) => match s.as_ref() {
                ScalarValue::Str(s) => Some(s.to_string()),
                _ => None,
            },
            _ => None,
        }
    })
}

fn has_trusted_str(
    doc: &AutoCommit,
    obj: &ObjId,
    key: &str,
    authority_actors: &HashSet<ActorId>,
) -> bool {
    read_trusted_str(doc, obj, key, authority_actors).is_some()
}

fn parse_fractional_position(position: &str) -> Result<FractionalIndex, CommentsDocError> {
    if position.is_empty()
        || !position.len().is_multiple_of(2)
        || !position.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(CommentsDocError::InvalidPosition(position.to_string()));
    }
    Ok(FractionalIndex::from_hex_string(position))
}

fn read_text_at_key(doc: &AutoCommit, obj: &ObjId, key: &str) -> Option<String> {
    match doc.get(obj, key).ok().flatten() {
        Some((Value::Object(ObjType::Text), text_obj)) => doc.text(&text_obj).ok(),
        _ => None,
    }
}

fn read_text_obj(doc: &AutoCommit, obj: &ObjId, key: &str) -> Option<ObjId> {
    match doc.get(obj, key).ok().flatten() {
        Some((Value::Object(ObjType::Text), text_obj)) => Some(text_obj),
        _ => None,
    }
}

fn authority_actor_set(authority_actor_labels: &[&str]) -> HashSet<ActorId> {
    authority_actor_labels
        .iter()
        .map(|label| ActorId::from(label.as_bytes()))
        .collect()
}

fn obj_id_authored_by_authority(obj_id: &ObjId, authority_actors: &HashSet<ActorId>) -> bool {
    match obj_id {
        ObjId::Id(_, actor, _) => authority_actors.contains(actor),
        _ => false,
    }
}

struct CommentsSyncRecoveryContext<'a> {
    doc: &'a mut CommentsDoc,
    peer_state: &'a mut sync::State,
}

#[cfg(test)]
mod tests {
    use super::*;

    const DOC_ID: &str = "comments:test-notebook";
    const CLIENT: &str = "client:user";
    const AUTHORITY: &str = "comments-authority:local";

    fn notebook_ref() -> NotebookCommentRef {
        NotebookCommentRef::LocalRoom {
            room_id: "room-a".to_string(),
        }
    }

    fn cell_anchor(cell_id: &str) -> CommentAnchor {
        CommentAnchor::Cell {
            cell_id: cell_id.to_string(),
            observed_cell_position: Some(DEFAULT_POSITION.to_string()),
        }
    }

    fn change_hashes_for_actor(doc: &mut AutoCommit, actor: &str) -> Vec<automerge::ChangeHash> {
        doc.get_changes(&[])
            .into_iter()
            .filter(|change| change.actor_id() == &ActorId::from(actor.as_bytes()))
            .map(|change| change.hash())
            .collect()
    }

    fn change_hashes(doc: &mut AutoCommit) -> Vec<automerge::ChangeHash> {
        doc.get_changes(&[])
            .into_iter()
            .map(|change| change.hash())
            .collect()
    }

    #[test]
    fn comments_doc_requires_identity() {
        let err = CommentsDoc::try_new("", &notebook_ref()).expect_err("empty id should fail");
        assert!(matches!(err, CommentsDocError::MissingCommentsDocId));
    }

    #[test]
    fn comments_doc_rejects_malformed_identity() {
        for comments_doc_id in [
            "not-comments:test",
            "comments:",
            " comments:test",
            "comments:test ",
            "comments:path:/tmp/notebook.ipynb",
            "comments:path\\notebook",
            "comments:\nnotebook",
        ] {
            let err = CommentsDoc::try_new(comments_doc_id, &notebook_ref())
                .expect_err("malformed id should fail");
            assert!(matches!(err, CommentsDocError::InvalidCommentsDocId(_)));
        }
    }

    #[test]
    fn comments_doc_identity_and_ref_round_trip_through_save() {
        let mut doc = CommentsDoc::new(DOC_ID, &notebook_ref());
        let bytes = doc.save();
        let loaded = CommentsDoc::load(&bytes, DOC_ID).unwrap();
        assert_eq!(loaded.comments_doc_id().as_deref(), Some(DOC_ID));
        assert_eq!(loaded.notebook_ref(), Some(notebook_ref()));
        let err = CommentsDoc::load(&bytes, "comments:other").expect_err("mismatch");
        assert!(matches!(
            err,
            CommentsDocError::CommentsDocIdMismatch { .. }
        ));
    }

    #[test]
    fn sync_target_tracks_expected_identity_without_local_materialization() {
        let doc = CommentsDoc::try_new_sync_target(DOC_ID).unwrap();

        assert_eq!(doc.comments_doc_id().as_deref(), Some(DOC_ID));
        assert!(!doc.is_materialized());
        assert_eq!(doc.notebook_ref(), None);
        assert!(matches!(
            doc.read_projection(&[AUTHORITY], None),
            Err(CommentsDocError::MissingCommentsDocId)
                | Err(CommentsDocError::InvalidCommentsDocId(_))
        ));
    }

    #[test]
    fn sync_target_materializes_from_seeded_comments_doc() {
        let mut daemon = CommentsDoc::new_with_actor(DOC_ID, &notebook_ref(), AUTHORITY);
        let mut client = CommentsDoc::try_new_sync_target(DOC_ID).unwrap();

        sync_pair(&mut daemon, &mut client);

        assert!(client.is_materialized());
        assert_eq!(client.raw_comments_doc_id().as_deref(), Some(DOC_ID));
        assert_eq!(client.notebook_ref(), Some(notebook_ref()));
    }

    #[test]
    fn non_string_comments_doc_id_conflict_rejects_projection() {
        let mut doc = CommentsDoc::new_with_actor(DOC_ID, &notebook_ref(), CLIENT);
        doc.doc_mut()
            .put(&ROOT, "comments_doc_id", ScalarValue::Uint(1))
            .unwrap();

        let err = doc
            .read_projection(&[AUTHORITY], None)
            .expect_err("non-string identity conflict should reject projection");
        assert!(matches!(err, CommentsDocError::CommentsDocIdConflict));
    }

    #[test]
    fn schema_seed_starts_without_materialized_identity() {
        let seed = CommentsDoc::schema_seed_doc().unwrap();
        let mut seed_for_save = CommentsDoc::from_doc_unchecked(seed.clone());
        let err = CommentsDoc::load(&seed_for_save.save(), DOC_ID)
            .expect_err("seed bytes without id must not load");
        assert!(matches!(err, CommentsDocError::MissingCommentsDocId));

        let seed = CommentsDoc::from_doc_unchecked(seed);
        assert_eq!(seed.comments_doc_id().as_deref(), Some(""));
        assert!(seed
            .read_projection(&[AUTHORITY], None)
            .expect_err("seed without id must not project")
            .to_string()
            .contains("comments_doc_id is required"));
    }

    #[test]
    fn pending_thread_projects_before_authority_acceptance() {
        let mut doc = CommentsDoc::new_with_actor(DOC_ID, &notebook_ref(), CLIENT);
        doc.create_thread(
            "thread-1",
            "msg-1",
            &cell_anchor("cell-a"),
            "needs a citation",
            None,
            "2026-06-16T00:00:00Z",
        )
        .unwrap();

        let projection = doc.read_projection(&[AUTHORITY], None).unwrap();
        assert_eq!(projection.comments_doc_id, DOC_ID);
        assert_eq!(projection.threads.len(), 1);
        let thread = &projection.threads[0];
        assert_eq!(thread.mutation_state, ProjectedMutationState::Pending);
        assert_eq!(thread.status, ProjectedThreadStatus::Open);
        assert!(!thread.trusted);
        assert_eq!(thread.messages[0].body, "needs a citation");
        assert_eq!(
            thread.messages[0].mutation_state,
            ProjectedMutationState::Pending
        );
        assert_eq!(thread.badge_cell_ids, vec!["cell-a"]);
    }

    #[test]
    fn authority_written_policy_fields_finalize_thread_and_message() {
        let mut doc = CommentsDoc::new_with_actor(DOC_ID, &notebook_ref(), CLIENT);
        doc.create_thread(
            "thread-1",
            "msg-1",
            &cell_anchor("cell-a"),
            "needs a citation",
            None,
            "2026-06-16T00:00:00Z",
        )
        .unwrap();
        doc.doc_mut().set_actor(ActorId::from(AUTHORITY.as_bytes()));
        doc.accept_thread_creation("thread-1", "local-user", "local_uid")
            .unwrap();
        doc.accept_message("thread-1", "msg-1", "local-user", "local_uid")
            .unwrap();

        let projection = doc.read_projection(&[AUTHORITY], None).unwrap();
        let thread = &projection.threads[0];
        assert_eq!(thread.mutation_state, ProjectedMutationState::Accepted);
        assert!(thread.trusted);
        assert_eq!(thread.created_by_actor_label.as_deref(), Some("local-user"));
        assert_eq!(thread.created_by_authority.as_deref(), Some("local_uid"));
        assert_eq!(
            thread.messages[0].mutation_state,
            ProjectedMutationState::Accepted
        );
        assert!(thread.messages[0].trusted);
    }

    #[test]
    fn accepted_projection_uses_authority_snapshots_not_later_client_edits() {
        let mut doc = CommentsDoc::new_with_actor(DOC_ID, &notebook_ref(), CLIENT);
        doc.create_thread(
            "thread-1",
            "msg-1",
            &cell_anchor("cell-a"),
            "approved body",
            None,
            "2026-06-16T00:00:00Z",
        )
        .unwrap();
        doc.doc_mut().set_actor(ActorId::from(AUTHORITY.as_bytes()));
        doc.accept_thread_creation("thread-1", "local-user", "local_uid")
            .unwrap();
        doc.accept_message("thread-1", "msg-1", "local-user", "local_uid")
            .unwrap();

        doc.doc_mut().set_actor(ActorId::from(CLIENT.as_bytes()));
        let thread = doc.thread_obj("thread-1").unwrap();
        let moved_anchor = serde_json::to_value(cell_anchor("cell-b")).unwrap();
        automunge::update_json_at_key(doc.doc_mut(), &thread, "anchor", &moved_anchor).unwrap();
        doc.doc_mut().put(&thread, "position", "ff").unwrap();
        doc.edit_message_body("thread-1", "msg-1", "tampered body")
            .unwrap();

        let projection = doc.read_projection(&[AUTHORITY], None).unwrap();
        let thread = &projection.threads[0];
        assert_eq!(thread.anchor, cell_anchor("cell-a"));
        assert_eq!(thread.position, DEFAULT_POSITION);
        assert_eq!(thread.badge_cell_ids, vec!["cell-a"]);
        assert_eq!(thread.messages[0].body, "approved body");
        assert!(thread.trusted);
        assert!(thread.messages[0].trusted);
    }

    #[test]
    fn client_authored_authority_anchor_conflict_keeps_thread_unverified() {
        let mut doc = CommentsDoc::new_with_actor(DOC_ID, &notebook_ref(), CLIENT);
        doc.create_thread(
            "thread-1",
            "msg-1",
            &cell_anchor("cell-a"),
            "approved body",
            None,
            "2026-06-16T00:00:00Z",
        )
        .unwrap();
        doc.doc_mut().set_actor(ActorId::from(AUTHORITY.as_bytes()));
        doc.accept_thread_creation("thread-1", "local-user", "local_uid")
            .unwrap();

        doc.doc_mut().set_actor(ActorId::from(CLIENT.as_bytes()));
        let thread = doc.thread_obj("thread-1").unwrap();
        doc.doc_mut()
            .put(&thread, "authority_anchor_json", "not json")
            .unwrap();

        let projection = doc.read_projection(&[AUTHORITY], None).unwrap();
        assert_eq!(projection.threads.len(), 1);
        assert_eq!(
            projection.threads[0].mutation_state,
            ProjectedMutationState::Unverified
        );
        assert!(!projection.threads[0].trusted);
        assert_eq!(projection.threads[0].anchor, cell_anchor("cell-a"));
    }

    #[test]
    fn client_authored_authority_snapshot_conflicts_unverify_thread_and_message() {
        let mut doc = CommentsDoc::new_with_actor(DOC_ID, &notebook_ref(), CLIENT);
        doc.create_thread(
            "thread-1",
            "msg-1",
            &cell_anchor("cell-a"),
            "approved body",
            None,
            "2026-06-16T00:00:00Z",
        )
        .unwrap();
        doc.doc_mut().set_actor(ActorId::from(AUTHORITY.as_bytes()));
        doc.accept_thread_creation("thread-1", "local-user", "local_uid")
            .unwrap();
        doc.accept_message("thread-1", "msg-1", "local-user", "local_uid")
            .unwrap();

        doc.doc_mut().set_actor(ActorId::from(CLIENT.as_bytes()));
        let thread = doc.thread_obj("thread-1").unwrap();
        let message = doc.message_or_error("thread-1", "msg-1").unwrap();
        doc.doc_mut()
            .put(&thread, "authority_position", "ff")
            .unwrap();
        doc.doc_mut()
            .put(&message, "authority_body", "forged")
            .unwrap();

        let projection = doc.read_projection(&[AUTHORITY], None).unwrap();
        let thread = &projection.threads[0];
        assert_eq!(thread.mutation_state, ProjectedMutationState::Unverified);
        assert!(!thread.trusted);
        assert_eq!(
            thread.messages[0].mutation_state,
            ProjectedMutationState::Unverified
        );
        assert!(!thread.messages[0].trusted);
        assert_eq!(thread.messages[0].body, "approved body");
    }

    #[test]
    fn client_authored_policy_fields_are_ignored() {
        let mut doc = CommentsDoc::new_with_actor(DOC_ID, &notebook_ref(), CLIENT);
        doc.create_thread(
            "thread-1",
            "msg-1",
            &cell_anchor("cell-a"),
            "spoofed",
            None,
            "2026-06-16T00:00:00Z",
        )
        .unwrap();
        let thread = doc.thread_obj("thread-1").unwrap();
        doc.doc_mut()
            .put(&thread, "mutation_state", "accepted")
            .unwrap();
        doc.doc_mut().put(&thread, "status", "resolved").unwrap();
        doc.doc_mut()
            .put(&thread, "created_by_actor_label", "victim")
            .unwrap();

        let projection = doc.read_projection(&[AUTHORITY], None).unwrap();
        let thread = &projection.threads[0];
        assert_eq!(thread.mutation_state, ProjectedMutationState::Pending);
        assert_eq!(thread.status, ProjectedThreadStatus::Open);
        assert!(!thread.trusted);
        assert_eq!(thread.created_by_actor_label, None);
    }

    #[test]
    fn client_conflicting_policy_field_de_trusts_projection() {
        let mut doc = CommentsDoc::new_with_actor(DOC_ID, &notebook_ref(), CLIENT);
        doc.create_thread(
            "thread-1",
            "msg-1",
            &cell_anchor("cell-a"),
            "spoofed",
            None,
            "2026-06-16T00:00:00Z",
        )
        .unwrap();
        doc.doc_mut().set_actor(ActorId::from(AUTHORITY.as_bytes()));
        doc.accept_thread_creation("thread-1", "local-user", "local_uid")
            .unwrap();
        assert_eq!(
            doc.read_projection(&[AUTHORITY], None).unwrap().threads[0].mutation_state,
            ProjectedMutationState::Accepted
        );

        let thread = doc.thread_obj("thread-1").unwrap();
        doc.doc_mut().set_actor(ActorId::from(CLIENT.as_bytes()));
        doc.doc_mut()
            .put(&thread, "authority_mutation_state", "rejected")
            .unwrap();

        let projection = doc.read_projection(&[AUTHORITY], None).unwrap();
        assert_eq!(
            projection.threads[0].mutation_state,
            ProjectedMutationState::Unverified
        );
        assert!(!projection.threads[0].trusted);
    }

    #[test]
    fn authority_resolve_and_reopen_drive_projected_status() {
        let mut doc = CommentsDoc::new_with_actor(DOC_ID, &notebook_ref(), CLIENT);
        doc.create_thread(
            "thread-1",
            "msg-1",
            &cell_anchor("cell-a"),
            "needs a citation",
            None,
            "2026-06-16T00:00:00Z",
        )
        .unwrap();
        doc.doc_mut().set_actor(ActorId::from(AUTHORITY.as_bytes()));
        doc.accept_thread_creation("thread-1", "local-user", "local_uid")
            .unwrap();
        doc.resolve_thread(
            "thread-1",
            "local-user",
            "local_uid",
            "2026-06-16T00:00:02Z",
        )
        .unwrap();
        assert_eq!(
            doc.read_projection(&[AUTHORITY], None).unwrap().threads[0].status,
            ProjectedThreadStatus::Resolved
        );
        assert_eq!(
            doc.read_projection(&[AUTHORITY], None).unwrap().threads[0]
                .resolved_at
                .as_deref(),
            Some("2026-06-16T00:00:02Z")
        );

        doc.reopen_thread(
            "thread-1",
            "local-user",
            "local_uid",
            "2026-06-16T00:00:03Z",
        )
        .unwrap();
        assert_eq!(
            doc.read_projection(&[AUTHORITY], None).unwrap().threads[0].status,
            ProjectedThreadStatus::Open
        );
        assert_eq!(
            doc.read_projection(&[AUTHORITY], None).unwrap().threads[0].resolved_at,
            None
        );
    }

    #[test]
    fn rejected_thread_and_message_project_authority_reasons() {
        let mut doc = CommentsDoc::new_with_actor(DOC_ID, &notebook_ref(), CLIENT);
        doc.create_thread(
            "thread-1",
            "msg-1",
            &cell_anchor("cell-a"),
            "not relevant",
            None,
            "2026-06-16T00:00:00Z",
        )
        .unwrap();
        doc.doc_mut().set_actor(ActorId::from(AUTHORITY.as_bytes()));
        doc.reject_thread_creation("thread-1", "off-topic").unwrap();
        doc.reject_message("thread-1", "msg-1", "duplicates prior note")
            .unwrap();

        let projection = doc.read_projection(&[AUTHORITY], None).unwrap();
        let thread = &projection.threads[0];
        assert_eq!(thread.mutation_state, ProjectedMutationState::Rejected);
        assert_eq!(thread.rejection_reason.as_deref(), Some("off-topic"));
        assert_eq!(
            thread.messages[0].mutation_state,
            ProjectedMutationState::Rejected
        );
        assert_eq!(
            thread.messages[0].rejection_reason.as_deref(),
            Some("duplicates prior note")
        );
        assert!(!thread.trusted);
        assert!(!thread.messages[0].trusted);
    }

    #[test]
    fn raw_client_reopen_does_not_override_authority_resolve() {
        let mut doc = CommentsDoc::new_with_actor(DOC_ID, &notebook_ref(), CLIENT);
        doc.create_thread(
            "thread-1",
            "msg-1",
            &cell_anchor("cell-a"),
            "needs a citation",
            None,
            "2026-06-16T00:00:00Z",
        )
        .unwrap();
        doc.doc_mut().set_actor(ActorId::from(AUTHORITY.as_bytes()));
        doc.accept_thread_creation("thread-1", "local-user", "local_uid")
            .unwrap();
        doc.resolve_thread(
            "thread-1",
            "local-user",
            "local_uid",
            "2026-06-16T00:00:02Z",
        )
        .unwrap();

        doc.doc_mut().set_actor(ActorId::from(CLIENT.as_bytes()));
        let thread = doc.thread_obj("thread-1").unwrap();
        doc.doc_mut().put(&thread, "status", "open").unwrap();

        let projection = doc.read_projection(&[AUTHORITY], None).unwrap();
        assert_eq!(
            projection.threads[0].status,
            ProjectedThreadStatus::Resolved
        );
        assert_eq!(
            projection.threads[0].resolved_at.as_deref(),
            Some("2026-06-16T00:00:02Z")
        );
    }

    #[test]
    fn client_authored_resolved_metadata_conflict_unverifies_status() {
        let mut doc = CommentsDoc::new_with_actor(DOC_ID, &notebook_ref(), CLIENT);
        doc.create_thread(
            "thread-1",
            "msg-1",
            &cell_anchor("cell-a"),
            "needs a citation",
            None,
            "2026-06-16T00:00:00Z",
        )
        .unwrap();
        doc.doc_mut().set_actor(ActorId::from(AUTHORITY.as_bytes()));
        doc.accept_thread_creation("thread-1", "local-user", "local_uid")
            .unwrap();
        doc.resolve_thread(
            "thread-1",
            "local-user",
            "local_uid",
            "2026-06-16T00:00:02Z",
        )
        .unwrap();

        doc.doc_mut().set_actor(ActorId::from(CLIENT.as_bytes()));
        let thread = doc.thread_obj("thread-1").unwrap();
        doc.doc_mut()
            .put(&thread, "authority_resolved_at", "client-forged")
            .unwrap();

        let projection = doc.read_projection(&[AUTHORITY], None).unwrap();
        assert_eq!(
            projection.threads[0].status,
            ProjectedThreadStatus::Unverified
        );
        assert!(!projection.threads[0].trusted);
        assert_eq!(projection.threads[0].resolved_at, None);
    }

    #[test]
    fn message_body_is_automerge_text_and_can_be_edited() {
        let mut doc = CommentsDoc::new_with_actor(DOC_ID, &notebook_ref(), CLIENT);
        doc.create_thread(
            "thread-1",
            "msg-1",
            &cell_anchor("cell-a"),
            "old",
            None,
            "2026-06-16T00:00:00Z",
        )
        .unwrap();
        let message = doc.message_or_error("thread-1", "msg-1").unwrap();
        assert!(read_text_obj(doc.doc(), &message, "body").is_some());
        doc.edit_message_body("thread-1", "msg-1", "new body")
            .unwrap();
        assert_eq!(
            doc.read_projection(&[AUTHORITY], None).unwrap().threads[0].messages[0].body,
            "new body"
        );
    }

    #[test]
    fn replies_sort_by_fractional_position_with_id_tie_break() {
        let mut doc = CommentsDoc::new_with_actor(DOC_ID, &notebook_ref(), CLIENT);
        doc.create_thread(
            "thread-1",
            "msg-1",
            &cell_anchor("cell-a"),
            "root",
            None,
            "2026-06-16T00:00:00Z",
        )
        .unwrap();
        doc.reply(
            "thread-1",
            "msg-3",
            "third",
            Some("msg-1"),
            "2026-06-16T00:00:02Z",
        )
        .unwrap();
        doc.reply(
            "thread-1",
            "msg-2",
            "second",
            Some("msg-1"),
            "2026-06-16T00:00:01Z",
        )
        .unwrap();

        let messages: Vec<String> = doc.read_projection(&[AUTHORITY], None).unwrap().threads[0]
            .messages
            .iter()
            .map(|message| message.id.clone())
            .collect();
        assert_eq!(messages, vec!["msg-1", "msg-2", "msg-3"]);
    }

    #[test]
    fn missing_after_thread_is_rejected() {
        let mut doc = CommentsDoc::new_with_actor(DOC_ID, &notebook_ref(), CLIENT);
        let err = doc
            .create_thread(
                "thread-1",
                "msg-1",
                &cell_anchor("cell-a"),
                "body",
                Some("missing-thread"),
                "2026-06-16T00:00:00Z",
            )
            .expect_err("missing after thread should fail");
        assert!(matches!(
            err,
            CommentsDocError::AfterThreadNotFound(id) if id == "missing-thread"
        ));
    }

    #[test]
    fn invalid_stored_position_is_skipped_unless_used_as_after_anchor() {
        let mut doc = CommentsDoc::new_with_actor(DOC_ID, &notebook_ref(), CLIENT);
        doc.create_thread(
            "thread-1",
            "msg-1",
            &cell_anchor("cell-a"),
            "first",
            None,
            "2026-06-16T00:00:00Z",
        )
        .unwrap();
        let thread = doc.thread_obj("thread-1").unwrap();
        doc.doc_mut().put(&thread, "position", "not-hex").unwrap();

        doc.create_thread(
            "thread-2",
            "msg-2",
            &cell_anchor("cell-a"),
            "second",
            None,
            "2026-06-16T00:00:01Z",
        )
        .unwrap();

        let err = doc
            .create_thread(
                "thread-3",
                "msg-3",
                &cell_anchor("cell-a"),
                "third",
                Some("thread-1"),
                "2026-06-16T00:00:02Z",
            )
            .expect_err("invalid after anchor position should fail");
        assert!(matches!(err, CommentsDocError::InvalidPosition(pos) if pos == "not-hex"));
    }

    #[test]
    fn missing_after_message_is_rejected() {
        let mut doc = CommentsDoc::new_with_actor(DOC_ID, &notebook_ref(), CLIENT);
        doc.create_thread(
            "thread-1",
            "msg-1",
            &cell_anchor("cell-a"),
            "root",
            None,
            "2026-06-16T00:00:00Z",
        )
        .unwrap();
        let err = doc
            .reply(
                "thread-1",
                "msg-2",
                "reply",
                Some("missing-message"),
                "2026-06-16T00:00:01Z",
            )
            .expect_err("missing after message should fail");
        assert!(matches!(
            err,
            CommentsDocError::AfterMessageNotFound(id) if id == "missing-message"
        ));
    }

    #[test]
    fn concurrent_replies_to_same_gap_converge_with_id_tie_break() {
        let mut base = CommentsDoc::new_with_actor(DOC_ID, &notebook_ref(), CLIENT);
        base.create_thread(
            "thread-1",
            "msg-1",
            &cell_anchor("cell-a"),
            "root",
            None,
            "2026-06-16T00:00:00Z",
        )
        .unwrap();
        let bytes = base.save();
        let mut a = CommentsDoc::load_with_actor(&bytes, DOC_ID, "client:a").unwrap();
        let mut b = CommentsDoc::load_with_actor(&bytes, DOC_ID, "client:b").unwrap();
        a.reply(
            "thread-1",
            "msg-a",
            "a",
            Some("msg-1"),
            "2026-06-16T00:00:01Z",
        )
        .unwrap();
        b.reply(
            "thread-1",
            "msg-b",
            "b",
            Some("msg-1"),
            "2026-06-16T00:00:01Z",
        )
        .unwrap();
        sync_pair(&mut a, &mut b);

        let a_messages: Vec<String> = a.read_projection(&[AUTHORITY], None).unwrap().threads[0]
            .messages
            .iter()
            .map(|message| message.id.clone())
            .collect();
        let b_messages: Vec<String> = b.read_projection(&[AUTHORITY], None).unwrap().threads[0]
            .messages
            .iter()
            .map(|message| message.id.clone())
            .collect();
        assert_eq!(a_messages, b_messages);
        assert_eq!(a_messages, vec!["msg-1", "msg-a", "msg-b"]);
    }

    #[test]
    fn concurrent_threads_to_same_gap_converge_with_id_tie_break() {
        let mut base = CommentsDoc::new_with_actor(DOC_ID, &notebook_ref(), CLIENT);
        base.create_thread(
            "thread-1",
            "msg-1",
            &cell_anchor("cell-a"),
            "root",
            None,
            "2026-06-16T00:00:00Z",
        )
        .unwrap();
        let bytes = base.save();
        let mut a = CommentsDoc::load_with_actor(&bytes, DOC_ID, "client:a").unwrap();
        let mut b = CommentsDoc::load_with_actor(&bytes, DOC_ID, "client:b").unwrap();
        a.create_thread(
            "thread-a",
            "msg-a",
            &cell_anchor("cell-a"),
            "a",
            Some("thread-1"),
            "2026-06-16T00:00:01Z",
        )
        .unwrap();
        b.create_thread(
            "thread-b",
            "msg-b",
            &cell_anchor("cell-a"),
            "b",
            Some("thread-1"),
            "2026-06-16T00:00:01Z",
        )
        .unwrap();
        sync_pair(&mut a, &mut b);

        let a_threads: Vec<String> = a
            .read_projection(&[AUTHORITY], None)
            .unwrap()
            .threads
            .iter()
            .map(|thread| thread.id.clone())
            .collect();
        let b_threads: Vec<String> = b
            .read_projection(&[AUTHORITY], None)
            .unwrap()
            .threads
            .iter()
            .map(|thread| thread.id.clone())
            .collect();
        assert_eq!(a_threads, b_threads);
        assert_eq!(a_threads, vec!["thread-1", "thread-a", "thread-b"]);
    }

    #[test]
    fn cell_range_badges_follow_current_cell_order() {
        let anchor = CommentAnchor::CellRange {
            start_cell_id: "cell-b".to_string(),
            end_cell_id: "cell-d".to_string(),
            start_position: None,
            end_position: None,
        };
        let order = vec![
            "cell-a".to_string(),
            "cell-b".to_string(),
            "cell-c".to_string(),
            "cell-d".to_string(),
        ];
        assert_eq!(
            anchor.badge_cell_ids(Some(&order)),
            vec!["cell-b", "cell-c", "cell-d"]
        );
    }

    #[test]
    fn get_comments_for_cell_uses_badge_cell_ids() {
        let mut doc = CommentsDoc::new_with_actor(DOC_ID, &notebook_ref(), CLIENT);
        doc.create_thread(
            "thread-1",
            "msg-1",
            &cell_anchor("cell-a"),
            "cell scoped",
            None,
            "2026-06-16T00:00:00Z",
        )
        .unwrap();
        let comments = doc
            .get_comments_for_cell("cell-a", &[AUTHORITY], None)
            .unwrap();
        assert_eq!(comments.len(), 1);
        assert_eq!(
            doc.get_comments_for_cell("cell-b", &[AUTHORITY], None)
                .unwrap()
                .len(),
            0
        );
    }

    #[test]
    fn sync_round_trip_preserves_pending_and_authority_finalized_state() {
        let mut client = CommentsDoc::new_with_actor(DOC_ID, &notebook_ref(), CLIENT);
        let mut daemon = CommentsDoc::new_with_actor(DOC_ID, &notebook_ref(), AUTHORITY);
        client
            .create_thread(
                "thread-1",
                "msg-1",
                &cell_anchor("cell-a"),
                "needs a citation",
                None,
                "2026-06-16T00:00:00Z",
            )
            .unwrap();

        sync_pair(&mut client, &mut daemon);
        assert_eq!(
            daemon.read_projection(&[AUTHORITY], None).unwrap().threads[0].mutation_state,
            ProjectedMutationState::Pending
        );

        daemon
            .accept_thread_creation("thread-1", "local-user", "local_uid")
            .unwrap();
        daemon
            .accept_message("thread-1", "msg-1", "local-user", "local_uid")
            .unwrap();

        sync_pair(&mut daemon, &mut client);
        let projection = client.read_projection(&[AUTHORITY], None).unwrap();
        assert_eq!(
            projection.threads[0].mutation_state,
            ProjectedMutationState::Accepted
        );
        assert!(projection.threads[0].trusted);
        assert_eq!(
            projection.threads[0].messages[0].mutation_state,
            ProjectedMutationState::Accepted
        );
    }

    #[test]
    fn sync_rejects_mismatched_comments_doc_id_and_rolls_back() {
        let mut receiver = CommentsDoc::new_with_actor(DOC_ID, &notebook_ref(), "receiver");
        let mut sender =
            CommentsDoc::new_with_actor("comments:other-notebook", &notebook_ref(), "sender");
        sender
            .create_thread(
                "thread-1",
                "msg-1",
                &cell_anchor("cell-a"),
                "wrong document",
                None,
                "2026-06-16T00:00:00Z",
            )
            .unwrap();

        let mut sender_sync = sync::State::new();
        let mut receiver_sync = sync::State::new();
        let mut sync_error = None;
        for _ in 0..8 {
            if let Some(message) = sender.generate_sync_message(&mut sender_sync) {
                match receiver.receive_sync_message_with_changes(&mut receiver_sync, message) {
                    Ok(_) => {}
                    Err(err) => {
                        sync_error = Some(err);
                        break;
                    }
                }
            }
            if let Some(reply) = receiver.generate_sync_message(&mut receiver_sync) {
                let _ = sender.receive_sync_message_with_changes(&mut sender_sync, reply);
            }
        }
        let err = sync_error.expect("mismatched id should be rejected");
        assert!(matches!(err, CommentsDocError::CommentsDocIdConflict));
        assert_eq!(receiver.comments_doc_id().as_deref(), Some(DOC_ID));
        assert_eq!(receiver.raw_comments_doc_id().as_deref(), Some(DOC_ID));
        assert!(receiver
            .read_projection(&[AUTHORITY], None)
            .unwrap()
            .threads
            .is_empty());
    }

    #[test]
    fn projection_rejects_conflicting_comments_doc_id_values() {
        let mut doc = CommentsDoc::new_with_actor(DOC_ID, &notebook_ref(), CLIENT);
        let bytes = doc.save();
        let mut other = CommentsDoc::load_with_actor(&bytes, DOC_ID, "client:other").unwrap();
        other
            .doc_mut()
            .put(&ROOT, "comments_doc_id", "comments:other")
            .unwrap();
        sync_pair_without_projection_check(&mut other, &mut doc);

        let err = doc
            .read_projection(&[AUTHORITY], None)
            .expect_err("conflicting id should reject projection");
        assert!(matches!(
            err,
            CommentsDocError::CommentsDocIdConflict
                | CommentsDocError::CommentsDocIdMismatch { .. }
        ));
    }

    #[test]
    fn generated_schema_seed_is_stable() {
        let mut generated = CommentsDoc::generated_schema_seed_doc().unwrap();
        let schema_changes: Vec<_> = generated
            .get_changes(&[])
            .into_iter()
            .filter(|change| {
                change.actor_id() == &ActorId::from(COMMENTS_DOC_SCHEMA_SEED_ACTOR.as_bytes())
            })
            .collect();
        assert_eq!(schema_changes.len(), 1);
        let generated = CommentsDoc::from_doc_unchecked(generated);
        assert_eq!(generated.comments_doc_id().as_deref(), Some(""));
    }

    #[test]
    fn comments_doc_genesis_artifact_matches_scaffold() {
        let mut generated = CommentsDoc::generated_schema_seed_doc().unwrap();
        let mut frozen = CommentsDoc::schema_seed_doc().unwrap();

        assert_eq!(
            change_hashes_for_actor(&mut generated, COMMENTS_DOC_SCHEMA_SEED_ACTOR),
            change_hashes_for_actor(&mut frozen, COMMENTS_DOC_SCHEMA_SEED_ACTOR)
        );
        assert_eq!(change_hashes(&mut generated), change_hashes(&mut frozen));
        assert_eq!(
            CommentsDoc::from_doc_unchecked(generated).raw_comments_doc_id(),
            CommentsDoc::from_doc_unchecked(frozen).raw_comments_doc_id()
        );
    }

    #[test]
    #[ignore]
    fn write_comments_doc_genesis_artifact() {
        let Some(path) = std::env::var_os("COMMENTS_DOC_GENESIS_OUT") else {
            return;
        };
        let mut generated = CommentsDoc::generated_schema_seed_doc().unwrap();
        std::fs::write(path, generated.save()).unwrap();
    }

    fn sync_pair(sender: &mut CommentsDoc, receiver: &mut CommentsDoc) {
        let mut sender_sync = sync::State::new();
        let mut receiver_sync = sync::State::new();
        for _ in 0..8 {
            if let Some(msg) = sender.generate_sync_message(&mut sender_sync) {
                receiver
                    .receive_sync_message_with_changes(&mut receiver_sync, msg)
                    .expect("receiver sync");
            }
            if let Some(reply) = receiver.generate_sync_message(&mut receiver_sync) {
                sender
                    .receive_sync_message_with_changes(&mut sender_sync, reply)
                    .expect("sender sync");
            }
        }
    }

    fn sync_pair_without_projection_check(sender: &mut CommentsDoc, receiver: &mut CommentsDoc) {
        let mut sender_sync = sync::State::new();
        let mut receiver_sync = sync::State::new();
        for _ in 0..8 {
            if let Some(msg) = sender.generate_sync_message(&mut sender_sync) {
                let _ = receiver
                    .doc
                    .sync()
                    .receive_sync_message(&mut receiver_sync, msg);
            }
            if let Some(reply) = receiver.generate_sync_message(&mut receiver_sync) {
                let _ = sender
                    .doc
                    .sync()
                    .receive_sync_message(&mut sender_sync, reply);
            }
        }
    }
}
