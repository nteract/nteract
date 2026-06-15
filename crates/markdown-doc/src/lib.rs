//! First-class Automerge-backed Markdown document.
//!
//! Cloud can wrap this document in hosted rooms and ACLs; Desktop can wrap it
//! in `.md` file load/save and file watching. The body is an Automerge Text
//! object edited through positional splices, not a replace-whole-body string
//! column.

#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]

use automerge::sync;
use automerge::sync::SyncDoc;
use automerge::transaction::Transactable;
use automerge::{ActorId, AutoCommit, AutomergeError, LoadOptions, ObjId, ObjType, ReadDoc};
use automerge_recovery::{
    is_recoverable_sync_error, recoverable_automerge_operation, AutomergeOperationError,
    AutomergeRebuildError,
};
use serde::{Deserialize, Serialize};
use thiserror::Error;

pub use automerge::TextEncoding;

pub const SCHEMA_VERSION: u64 = 1;

#[derive(Debug, Error)]
pub enum MarkdownDocError {
    #[error("automerge operation failed: {0}")]
    Automerge(#[from] AutomergeError),
    #[error("body splice delete_count is too large: {0}")]
    DeleteCountTooLarge(usize),
    #[error("markdown document rebuild failed: {0}")]
    Rebuild(#[from] AutomergeRebuildError),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MarkdownDocumentSnapshot {
    pub document_id: Option<String>,
    pub title: Option<String>,
    pub body: Option<String>,
    pub comments_doc_id: Option<String>,
}

/// Host-neutral Markdown document wrapper.
pub struct MarkdownDoc {
    doc: AutoCommit,
}

impl MarkdownDoc {
    /// Create a fully seeded Markdown document.
    ///
    /// Call this from exactly one authority for a given document id. Other
    /// peers should call [`bootstrap_with_actor`](Self::bootstrap_with_actor),
    /// sync this seeded body object in, then write body splices.
    pub fn try_new_with_actor(
        document_id: &str,
        title: &str,
        actor_label: &str,
    ) -> Result<Self, MarkdownDocError> {
        let mut doc = empty_doc(actor_label);
        doc.put(automerge::ROOT, "schema_version", SCHEMA_VERSION)?;
        doc.put(automerge::ROOT, "document_id", document_id)?;
        doc.put(automerge::ROOT, "title", title)?;
        doc.put_object(automerge::ROOT, "body", ObjType::Text)?;
        doc.put_object(automerge::ROOT, "metadata", ObjType::Map)?;
        doc.put_object(automerge::ROOT, "artifact_refs", ObjType::Map)?;
        Ok(Self { doc })
    }

    /// Create an empty peer handle with only the actor set.
    ///
    /// A bootstrap peer cannot write body splices until it receives the seeded
    /// body object over Automerge sync.
    pub fn bootstrap_with_actor(actor_label: &str) -> Self {
        Self {
            doc: empty_doc(actor_label),
        }
    }

    pub fn load(data: &[u8]) -> Result<Self, AutomergeError> {
        let doc = AutoCommit::load_with_options(
            data,
            LoadOptions::new().text_encoding(TextEncoding::Utf16CodeUnit),
        )?;
        Ok(Self { doc })
    }

    pub fn load_with_actor(data: &[u8], actor_label: &str) -> Result<Self, AutomergeError> {
        let mut doc = Self::load(data)?;
        doc.set_actor(actor_label);
        Ok(doc)
    }

    pub fn doc(&self) -> &AutoCommit {
        &self.doc
    }

    pub fn doc_mut(&mut self) -> &mut AutoCommit {
        &mut self.doc
    }

    pub fn from_doc(doc: AutoCommit) -> Self {
        Self { doc }
    }

    pub fn save(&mut self) -> Vec<u8> {
        self.doc.save()
    }

    pub fn rebuild_from_save(&mut self) -> Result<(), AutomergeRebuildError> {
        let actor = self.doc.get_actor().clone();
        let bytes = self.doc.save();
        match AutoCommit::load_with_options(
            &bytes,
            LoadOptions::new().text_encoding(TextEncoding::Utf16CodeUnit),
        ) {
            Ok(mut doc) => {
                doc.set_actor(actor);
                self.doc = doc;
                Ok(())
            }
            Err(source) => Err(AutomergeRebuildError::load(source)),
        }
    }

    pub fn set_actor(&mut self, actor_label: &str) {
        self.doc.set_actor(ActorId::from(actor_label.as_bytes()));
    }

    pub fn get_heads(&mut self) -> Vec<automerge::ChangeHash> {
        self.doc.get_heads()
    }

    pub fn get_heads_hex(&mut self) -> Vec<String> {
        self.get_heads()
            .into_iter()
            .map(|head| hex::encode(head.as_ref()))
            .collect()
    }

    pub fn actor_label(&self) -> String {
        actor_label_from_id(self.doc.get_actor())
    }

    pub fn document_id(&self) -> Option<String> {
        read_str(&self.doc, automerge::ROOT, "document_id")
    }

    pub fn title(&self) -> Option<String> {
        read_str(&self.doc, automerge::ROOT, "title")
    }

    pub fn set_title(&mut self, title: &str) -> Result<(), MarkdownDocError> {
        self.doc.put(automerge::ROOT, "title", title)?;
        Ok(())
    }

    pub fn comments_doc_id(&self) -> Option<String> {
        read_str(&self.doc, automerge::ROOT, "comments_doc_id")
    }

    pub fn set_comments_doc_id(
        &mut self,
        comments_doc_id: Option<&str>,
    ) -> Result<(), MarkdownDocError> {
        match comments_doc_id {
            Some(value) => self.doc.put(automerge::ROOT, "comments_doc_id", value)?,
            None => {
                if self.doc.get(automerge::ROOT, "comments_doc_id")?.is_some() {
                    self.doc.delete(automerge::ROOT, "comments_doc_id")?;
                }
            }
        }
        Ok(())
    }

    pub fn body(&self) -> Option<String> {
        let body_id = self.body_text_id()?;
        self.doc.text(&body_id).ok()
    }

    /// Read a UTF-16 slice of the current body. Positions are the same units
    /// CodeMirror uses in the browser.
    pub fn slice_body(&self, start: usize, end: usize) -> Option<String> {
        let body = self.body()?;
        let units: Vec<u16> = body.encode_utf16().collect();
        let clamped_start = start.min(units.len());
        let clamped_end = end.min(units.len()).max(clamped_start);
        Some(String::from_utf16_lossy(&units[clamped_start..clamped_end]))
    }

    pub fn body_len(&self) -> Option<usize> {
        let body_id = self.body_text_id()?;
        Some(self.doc.length(&body_id))
    }

    /// Splice the Automerge Text body. Returns `Ok(false)` when this peer has
    /// not yet synced the seeded body object.
    pub fn splice_body(
        &mut self,
        index: usize,
        delete_count: usize,
        text: &str,
    ) -> Result<bool, MarkdownDocError> {
        let Some(body_id) = self.body_text_id() else {
            return Ok(false);
        };
        let delete_count: isize = delete_count
            .try_into()
            .map_err(|_| MarkdownDocError::DeleteCountTooLarge(delete_count))?;
        self.doc.splice_text(&body_id, index, delete_count, text)?;
        Ok(true)
    }

    /// Import/bootstrap helper. Live editor paths should use
    /// [`splice_body`](Self::splice_body), not whole-body replacement.
    pub fn replace_body_for_import(&mut self, body: &str) -> Result<bool, MarkdownDocError> {
        let Some(body_id) = self.body_text_id() else {
            return Ok(false);
        };
        self.doc.update_text(&body_id, body)?;
        Ok(true)
    }

    pub fn snapshot(&self) -> MarkdownDocumentSnapshot {
        MarkdownDocumentSnapshot {
            document_id: self.document_id(),
            title: self.title(),
            body: self.body(),
            comments_doc_id: self.comments_doc_id(),
        }
    }

    pub fn generate_sync_message(&mut self, peer_state: &mut sync::State) -> Option<sync::Message> {
        self.doc.sync().generate_sync_message(peer_state)
    }

    pub fn receive_sync_message(
        &mut self,
        peer_state: &mut sync::State,
        message: sync::Message,
    ) -> Result<(), AutomergeError> {
        self.doc.sync().receive_sync_message(peer_state, message)
    }

    pub fn generate_sync_message_recovering(
        &mut self,
        peer_state: &mut sync::State,
        label: &str,
    ) -> Result<Option<sync::Message>, AutomergeOperationError> {
        let mut context = SyncRecoveryContext {
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

    pub fn receive_sync_message_recovering(
        &mut self,
        peer_state: &mut sync::State,
        message: sync::Message,
        label: &str,
    ) -> Result<(), AutomergeOperationError> {
        let mut context = SyncReceiveRecoveryContext {
            doc: self,
            peer_state,
            next_message: Some(message.clone()),
            retry_message: message,
        };
        recoverable_automerge_operation(
            label,
            &mut context,
            |context| {
                let message = context
                    .next_message
                    .take()
                    .unwrap_or_else(|| context.retry_message.clone());
                context
                    .doc
                    .receive_sync_message(context.peer_state, message)
            },
            is_recoverable_sync_error,
            |context| {
                *context.peer_state = sync::State::new();
                context.doc.rebuild_from_save()
            },
        )
    }

    fn body_text_id(&self) -> Option<ObjId> {
        match self.doc.get(automerge::ROOT, "body").ok().flatten()? {
            (automerge::Value::Object(ObjType::Text), id) => Some(id),
            _ => None,
        }
    }
}

struct SyncRecoveryContext<'a> {
    doc: &'a mut MarkdownDoc,
    peer_state: &'a mut sync::State,
}

struct SyncReceiveRecoveryContext<'a> {
    doc: &'a mut MarkdownDoc,
    peer_state: &'a mut sync::State,
    next_message: Option<sync::Message>,
    retry_message: sync::Message,
}

fn empty_doc(actor_label: &str) -> AutoCommit {
    let mut doc = AutoCommit::new_with_encoding(TextEncoding::Utf16CodeUnit);
    doc.set_actor(ActorId::from(actor_label.as_bytes()));
    doc
}

fn read_str<O: AsRef<automerge::ObjId>, P: Into<automerge::Prop>>(
    doc: &AutoCommit,
    obj: O,
    prop: P,
) -> Option<String> {
    doc.get(obj, prop)
        .ok()
        .flatten()
        .and_then(|(value, _)| match value {
            automerge::Value::Scalar(s) => match s.as_ref() {
                automerge::ScalarValue::Str(s) => Some(s.to_string()),
                _ => None,
            },
            _ => None,
        })
}

pub fn actor_label_from_id(actor: &ActorId) -> String {
    std::str::from_utf8(actor.to_bytes())
        .map(|s| s.to_string())
        .unwrap_or_else(|_| actor.to_hex_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sync_pair(a: &mut MarkdownDoc, b: &mut MarkdownDoc) {
        let mut a_state = sync::State::new();
        let mut b_state = sync::State::new();
        for _ in 0..100 {
            let mut progressed = false;
            if let Some(message) = a.generate_sync_message(&mut a_state) {
                b.receive_sync_message(&mut b_state, message).unwrap();
                progressed = true;
            }
            if let Some(message) = b.generate_sync_message(&mut b_state) {
                a.receive_sync_message(&mut a_state, message).unwrap();
                progressed = true;
            }
            if !progressed {
                return;
            }
        }
        panic!("sync did not quiesce");
    }

    #[test]
    fn seeded_markdown_doc_has_spliceable_body() {
        let mut doc =
            MarkdownDoc::try_new_with_actor("m-1", "Plan", "user:dev:kyle/browser:a").unwrap();
        assert_eq!(doc.document_id().as_deref(), Some("m-1"));
        assert_eq!(doc.title().as_deref(), Some("Plan"));
        assert_eq!(doc.body().as_deref(), Some(""));

        assert!(doc.splice_body(0, 0, "# Plan\n").unwrap());
        assert!(doc.splice_body(7, 0, "\nBody").unwrap());
        assert_eq!(doc.body().as_deref(), Some("# Plan\n\nBody"));
        assert_eq!(doc.slice_body(0, 6).as_deref(), Some("# Plan"));
    }

    #[test]
    fn bootstrap_peer_waits_for_seeded_body_before_writing() {
        let mut owner =
            MarkdownDoc::try_new_with_actor("m-1", "Plan", "user:dev:kyle/browser:a").unwrap();
        owner.splice_body(0, 0, "hello").unwrap();

        let mut peer = MarkdownDoc::bootstrap_with_actor("user:dev:kyle/codex:b");
        assert_eq!(peer.body(), None);
        assert!(!peer.splice_body(0, 0, "nope").unwrap());

        sync_pair(&mut owner, &mut peer);
        assert_eq!(peer.body().as_deref(), Some("hello"));
        assert!(peer.splice_body(5, 0, " world").unwrap());
        sync_pair(&mut owner, &mut peer);
        assert_eq!(owner.body().as_deref(), Some("hello world"));
    }

    #[test]
    fn concurrent_body_splices_converge() {
        let mut left =
            MarkdownDoc::try_new_with_actor("m-1", "Plan", "user:dev:kyle/browser:a").unwrap();
        left.splice_body(0, 0, "hello").unwrap();
        let mut right = MarkdownDoc::bootstrap_with_actor("user:dev:kyle/codex:b");
        sync_pair(&mut left, &mut right);

        left.splice_body(5, 0, " from browser").unwrap();
        right.splice_body(5, 0, " from agent").unwrap();
        sync_pair(&mut left, &mut right);

        let left_body = left.body().unwrap();
        let right_body = right.body().unwrap();
        assert_eq!(left_body, right_body);
        assert!(left_body.contains("hello"));
        assert!(left_body.contains("from browser"));
        assert!(left_body.contains("from agent"));
    }

    #[test]
    fn save_load_preserves_body_and_actor_can_change() {
        let mut doc =
            MarkdownDoc::try_new_with_actor("m-1", "Plan", "user:dev:kyle/browser:a").unwrap();
        doc.splice_body(0, 0, "line 1\nline 2").unwrap();
        let bytes = doc.save();

        let loaded = MarkdownDoc::load_with_actor(&bytes, "user:dev:kyle/codex:b").unwrap();
        assert_eq!(loaded.body().as_deref(), Some("line 1\nline 2"));
        assert_eq!(loaded.actor_label(), "user:dev:kyle/codex:b");
    }

    #[test]
    fn utf16_slice_and_splice_match_browser_positions() {
        let mut doc =
            MarkdownDoc::try_new_with_actor("m-1", "Plan", "user:dev:kyle/browser:a").unwrap();
        doc.splice_body(0, 0, "a😀c").unwrap();
        assert_eq!(doc.body_len(), Some(4));
        assert_eq!(doc.slice_body(0, 1).as_deref(), Some("a"));
        assert_eq!(doc.slice_body(3, 4).as_deref(), Some("c"));

        doc.splice_body(3, 0, "b").unwrap();
        assert_eq!(doc.body().as_deref(), Some("a😀bc"));
    }
}
