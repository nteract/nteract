//! Explicit attachment ownership, independent of legacy notebook selection.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::{RwLock, RwLockReadGuard, RwLockWriteGuard};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

use crate::session::NotebookSession;

pub const MAX_ATTACHMENTS: usize = 128;
/// Application semantics only: the private proxy child remains legacy initialized.
pub const ATTACHMENT_MODE_META_KEY: &str = "io.nteract/attachmentMode";
/// Terminal signal on legacy resource notifications, recoverable through resource reads.
pub const ATTACHMENT_EXPIRED_META_KEY: &str = "io.nteract/attachmentExpired";

pub(crate) fn expired_resource_error(handle: &str) -> rmcp::ErrorData {
    rmcp::ErrorData::resource_not_found(
        "Notebook attachment expired; connect again and obtain a new handle",
        Some(serde_json::json!({ "code": "attachment_expired", "notebook_handle": handle })),
    )
}

pub(crate) fn expired_resource_notification(
    uri: &str,
    handle: &str,
) -> rmcp::model::ResourceUpdatedNotificationParam {
    let mut notification = rmcp::model::ResourceUpdatedNotificationParam::new(uri);
    let mut meta = rmcp::model::NotificationMetaObject::new();
    meta.insert(
        ATTACHMENT_EXPIRED_META_KEY.into(),
        serde_json::json!({
            "code": "attachment_expired", "notebook_handle": handle,
        }),
    );
    notification.meta = Some(meta);
    notification
}

/// An admitted open holds capacity even while connecting. Cancellation releases it.
pub struct AttachmentReservation {
    _permit: OwnedSemaphorePermit,
}

/// Removing an entry releases its capacity and peer ownership together.
pub struct AttachmentEntry {
    pub session: NotebookSession,
    _reservation: AttachmentReservation,
    expired: tokio::sync::watch::Sender<bool>,
}

impl AttachmentEntry {
    pub fn expiration(&self) -> tokio::sync::watch::Receiver<bool> {
        self.expired.subscribe()
    }

    /// Signal removal before a caller finishes inspecting the removed payload.
    pub fn expire(&self) {
        self.expired.send_replace(true);
    }
}

impl Drop for AttachmentEntry {
    fn drop(&mut self) {
        self.expire();
    }
}

/// Handles are process-local, never reused or rebound, and retained until release
/// or explicit recovery expiry. Cache pressure cannot expire an attachment.
pub struct AttachmentRegistry {
    pub entries: RwLock<HashMap<String, AttachmentEntry>>,
    capacity: Arc<Semaphore>,
}

impl Default for AttachmentRegistry {
    fn default() -> Self {
        Self {
            entries: RwLock::new(HashMap::new()),
            capacity: Arc::new(Semaphore::new(MAX_ATTACHMENTS)),
        }
    }
}

impl AttachmentRegistry {
    pub fn read_entries(&self) -> RwLockReadGuard<'_, HashMap<String, AttachmentEntry>> {
        self.entries
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
    pub fn write_entries(&self) -> RwLockWriteGuard<'_, HashMap<String, AttachmentEntry>> {
        self.entries
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    pub fn reserve(&self) -> Result<AttachmentReservation, &'static str> {
        Arc::clone(&self.capacity)
            .try_acquire_owned()
            .map(|_permit| AttachmentReservation { _permit })
            .map_err(|_| "attachment_limit: release an attachment before opening another notebook")
    }

    pub fn insert(&self, session: NotebookSession, reservation: AttachmentReservation) {
        let mut entries = self.write_entries();
        // A UUID identifies one ownership lifetime, never a target cache entry.
        assert!(!entries.contains_key(&session.notebook_handle));
        entries.insert(
            session.notebook_handle.clone(),
            AttachmentEntry {
                session,
                _reservation: reservation,
                expired: tokio::sync::watch::channel(false).0,
            },
        );
    }

    pub fn remove(&self, handle: &str) -> Option<AttachmentEntry> {
        let entry = self.write_entries().remove(handle);
        if let Some(entry) = &entry {
            entry.expire();
        }
        entry
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pending_opens_are_bounded_and_cancelled_opens_return_capacity() {
        let registry = AttachmentRegistry::default();
        let mut reservations = (0..MAX_ATTACHMENTS)
            .map(|_| registry.reserve().unwrap())
            .collect::<Vec<_>>();
        assert!(registry.reserve().is_err());
        reservations.pop();
        assert!(registry.reserve().is_ok());
    }
}
