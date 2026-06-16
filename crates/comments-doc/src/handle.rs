use std::sync::{Arc, Mutex};

use automerge::sync;
use tokio::sync::broadcast;

use crate::doc::CommentsDoc;
use crate::error::CommentsDocError;

#[derive(Clone)]
pub struct CommentsDocHandle {
    doc: Arc<Mutex<CommentsDoc>>,
    changed_tx: broadcast::Sender<()>,
}

impl CommentsDocHandle {
    pub fn new(doc: CommentsDoc, changed_tx: broadcast::Sender<()>) -> Self {
        Self {
            doc: Arc::new(Mutex::new(doc)),
            changed_tx,
        }
    }

    pub fn with_doc<F, T>(&self, f: F) -> Result<T, CommentsDocError>
    where
        F: FnOnce(&mut CommentsDoc) -> Result<T, CommentsDocError>,
    {
        let mut doc = self
            .doc
            .lock()
            .map_err(|_| CommentsDocError::LockPoisoned)?;
        let heads_before = doc.get_heads();
        let result = f(&mut doc);
        if doc.get_heads() != heads_before {
            let _ = self.changed_tx.send(());
        }
        result
    }

    pub fn generate_sync_message_recovering(
        &self,
        peer_state: &mut sync::State,
        label: &str,
    ) -> Result<Option<sync::Message>, CommentsDocError> {
        let mut doc = self
            .doc
            .lock()
            .map_err(|_| CommentsDocError::LockPoisoned)?;
        doc.generate_sync_message_recovering(peer_state, label)
            .map_err(Into::into)
    }

    pub fn receive_sync_message_with_changes_recovering(
        &self,
        peer_state: &mut sync::State,
        message: sync::Message,
        label: &str,
    ) -> Result<bool, CommentsDocError> {
        let mut doc = self
            .doc
            .lock()
            .map_err(|_| CommentsDocError::LockPoisoned)?;
        let changed =
            doc.receive_sync_message_with_changes_recovering(peer_state, message, label)?;
        if changed {
            let _ = self.changed_tx.send(());
        }
        Ok(changed)
    }

    pub fn read<F, T>(&self, f: F) -> Result<T, CommentsDocError>
    where
        F: FnOnce(&CommentsDoc) -> T,
    {
        let doc = self
            .doc
            .lock()
            .map_err(|_| CommentsDocError::LockPoisoned)?;
        Ok(f(&doc))
    }

    pub fn subscribe(&self) -> broadcast::Receiver<()> {
        self.changed_tx.subscribe()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{CommentAnchor, NotebookCommentRef};

    #[test]
    fn with_doc_notifies_on_change() {
        let doc = CommentsDoc::new(
            "comments:handle",
            &NotebookCommentRef::LocalRoom {
                room_id: "room".to_string(),
            },
        );
        let (tx, _) = broadcast::channel(16);
        let handle = CommentsDocHandle::new(doc, tx);
        let mut rx = handle.subscribe();
        handle
            .with_doc(|doc| {
                doc.create_thread(
                    "thread-1",
                    "msg-1",
                    &CommentAnchor::Notebook,
                    "body",
                    None,
                    "2026-06-16T00:00:00Z",
                )?;
                Ok(())
            })
            .unwrap();
        assert!(rx.try_recv().is_ok());
    }

    #[test]
    fn sync_receive_notifies_on_change() {
        let mut sender = CommentsDoc::new_with_actor(
            "comments:handle-sync",
            &NotebookCommentRef::LocalRoom {
                room_id: "room".to_string(),
            },
            "client:user",
        );
        sender
            .create_thread(
                "thread-1",
                "msg-1",
                &CommentAnchor::Notebook,
                "body",
                None,
                "2026-06-16T00:00:00Z",
            )
            .unwrap();

        let receiver = CommentsDoc::new_with_actor(
            "comments:handle-sync",
            &NotebookCommentRef::LocalRoom {
                room_id: "room".to_string(),
            },
            "receiver",
        );
        let (tx, _) = broadcast::channel(16);
        let handle = CommentsDocHandle::new(receiver, tx);
        let mut rx = handle.subscribe();
        let mut sender_sync = sync::State::new();
        let mut receiver_sync = sync::State::new();
        let mut observed_change = false;

        for _ in 0..8 {
            if let Some(message) = sender.generate_sync_message(&mut sender_sync) {
                let changed = handle
                    .receive_sync_message_with_changes_recovering(
                        &mut receiver_sync,
                        message,
                        "comments-handle-test",
                    )
                    .unwrap();
                if changed {
                    observed_change = true;
                    break;
                }
            }
            if let Some(reply) = handle
                .generate_sync_message_recovering(&mut receiver_sync, "comments-handle-test")
                .unwrap()
            {
                let _ = sender.receive_sync_message_with_changes(&mut sender_sync, reply);
            }
        }

        assert!(observed_change);
        assert!(rx.try_recv().is_ok());
    }
}
