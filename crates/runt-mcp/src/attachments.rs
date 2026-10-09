//! Explicit attachment ownership, independent of legacy notebook selection.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, Weak};
use std::sync::{RwLock, RwLockReadGuard, RwLockWriteGuard};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

use crate::session::{DaemonIncarnation, NotebookSession};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AttachmentOrigin {
    Explicit,
    Legacy,
    /// Server-retained owner used by notebook-ID requests.
    Address,
}

/// Source and authority must match before a native open can share a peer.
/// The endpoint is fixed by the owning MCP server. Hosted connections are not
/// pooled without a stable authenticated source identity.
#[derive(Clone, PartialEq, Eq, Hash)]
pub(crate) struct BackingPeerKey {
    pub target: String,
    pub incarnation: DaemonIncarnation,
    pub operator: String,
}

pub const MAX_ATTACHMENTS: usize = 128;
/// Terminal signal on legacy resource notifications, recoverable through resource reads.
pub const ATTACHMENT_EXPIRED_META_KEY: &str = "io.nteract/attachmentExpired";
/// Terminal observation loss does not end logical registry membership.
pub const ATTACHMENT_UNAVAILABLE_META_KEY: &str = "io.nteract/attachmentUnavailable";

pub(crate) fn unavailable_resource_data(handle: &str) -> serde_json::Value {
    serde_json::json!({"code": "attachment_unavailable", "notebook_handle": handle})
}

pub(crate) fn unavailable_resource_notification(
    uri: &str,
    handle: &str,
) -> rmcp::model::ResourceUpdatedNotificationParam {
    let mut notification = rmcp::model::ResourceUpdatedNotificationParam::new(uri);
    let mut meta = rmcp::model::NotificationMetaObject::new();
    meta.insert(
        ATTACHMENT_UNAVAILABLE_META_KEY.into(),
        unavailable_resource_data(handle),
    );
    notification.meta = Some(meta);
    notification
}

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
    origin: AttachmentOrigin,
    _reservation: AttachmentReservation,
    expired: tokio::sync::watch::Sender<bool>,
}

impl AttachmentEntry {
    pub fn origin(&self) -> AttachmentOrigin {
        self.origin
    }

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
    /// Weak gates serialize compatible native acquisition, never retain peers.
    acquisition_gates: Mutex<HashMap<BackingPeerKey, Weak<Semaphore>>>,
}

impl Default for AttachmentRegistry {
    fn default() -> Self {
        Self {
            entries: RwLock::new(HashMap::new()),
            capacity: Arc::new(Semaphore::new(MAX_ATTACHMENTS)),
            acquisition_gates: Mutex::new(HashMap::new()),
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
        self.insert_with_origin(session, reservation, AttachmentOrigin::Explicit);
    }

    pub fn insert_legacy(&self, session: NotebookSession, reservation: AttachmentReservation) {
        self.insert_with_origin(session, reservation, AttachmentOrigin::Legacy);
    }

    fn insert_with_origin(
        &self,
        session: NotebookSession,
        reservation: AttachmentReservation,
        origin: AttachmentOrigin,
    ) {
        let mut entries = self.write_entries();
        // A UUID identifies one ownership lifetime, never a target cache entry.
        assert!(!entries.contains_key(&session.notebook_handle));
        entries.insert(
            session.notebook_handle.clone(),
            AttachmentEntry {
                session,
                origin,
                _reservation: reservation,
                expired: tokio::sync::watch::channel(false).0,
            },
        );
    }

    pub(crate) fn acquisition_gate(&self, key: BackingPeerKey) -> Arc<Semaphore> {
        let mut gates = self
            .acquisition_gates
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        gates.retain(|_, gate| gate.strong_count() != 0);
        if let Some(gate) = gates.get(&key).and_then(Weak::upgrade) {
            return gate;
        }
        let gate = Arc::new(Semaphore::new(1));
        gates.insert(key, Arc::downgrade(&gate));
        gate
    }

    /// Retain one address owner per already admitted notebook/authority. This
    /// owner is shared by ID callers; it is independent of every explicit handle.
    /// No network admission or eviction occurs here. Capacity is deliberate.
    pub(crate) fn acquire_address(
        &self,
        target: &crate::session_activation::CanonicalNotebookTarget,
        eligible: impl Fn(&NotebookSession) -> bool,
    ) -> Result<NotebookSession, &'static str> {
        let mut entries = self.write_entries();
        let mut candidates = entries.values().filter(|entry| eligible(&entry.session));
        let Some(first) = candidates.next() else {
            return Err("notebook_not_connected");
        };
        let principal = first
            .session
            .hosted_authority
            .as_ref()
            .map(|authority| (&authority.principal, authority.requested_scope));
        if candidates.any(|entry| {
            entry
                .session
                .hosted_authority
                .as_ref()
                .map(|authority| (&authority.principal, authority.requested_scope))
                != principal
        }) {
            return Err("ambiguous_notebook_authority");
        }
        let selected = entries
            .values()
            .filter(|entry| eligible(&entry.session))
            .max_by_key(|entry| {
                (
                    entry.origin == AttachmentOrigin::Address,
                    entry.session.readiness().document_ready,
                    &entry.session.notebook_handle,
                )
            })
            .ok_or("notebook_not_connected")?;
        if selected.origin == AttachmentOrigin::Address {
            return Ok(selected.session.clone());
        }
        let session = selected.session.fresh_attachment(0, target);
        let reservation = self.reserve().map_err(|_| "attachment_limit")?;
        entries.insert(
            session.notebook_handle.clone(),
            AttachmentEntry {
                session: session.clone(),
                origin: AttachmentOrigin::Address,
                _reservation: reservation,
                expired: tokio::sync::watch::channel(false).0,
            },
        );
        Ok(session)
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

    fn key(target: &str) -> BackingPeerKey {
        BackingPeerKey {
            target: target.into(),
            incarnation: DaemonIncarnation {
                pid: 1,
                started_at: chrono::Utc::now(),
            },
            operator: "agent:test:owner".into(),
        }
    }

    #[tokio::test]
    async fn gates_share_only_exact_identity_and_cancelled_waiters_do_not_block_retry() {
        let registry = AttachmentRegistry::default();
        let key = key("local:path:/same.ipynb");
        let first = registry.acquisition_gate(key.clone());
        let follower = registry.acquisition_gate(key.clone());
        assert!(Arc::ptr_eq(&first, &follower));
        let permit = Arc::clone(&first).acquire_owned().await.unwrap();
        let waiter_gate = Arc::clone(&follower);
        let waiter = tokio::spawn(async move { waiter_gate.acquire_owned().await });
        tokio::task::yield_now().await;
        waiter.abort();
        assert!(waiter.await.unwrap_err().is_cancelled());
        let mut other = key.clone();
        other.target = "local:path:/other.ipynb".into();
        assert!(!Arc::ptr_eq(
            &first,
            &registry.acquisition_gate(other.clone())
        ));
        other = key.clone();
        other.incarnation.pid += 1;
        assert!(!Arc::ptr_eq(
            &first,
            &registry.acquisition_gate(other.clone())
        ));
        other = key;
        other.operator = "agent:other:owner".into();
        assert!(!Arc::ptr_eq(&first, &registry.acquisition_gate(other)));
        drop(permit);
        assert!(first.try_acquire().is_ok());
    }

    #[test]
    fn abandoned_gates_do_not_form_a_strong_or_unbounded_cache() {
        let registry = AttachmentRegistry::default();
        let gate = registry.acquisition_gate(key("first"));
        let weak = Arc::downgrade(&gate);
        drop(gate);
        assert!(weak.upgrade().is_none());
        for index in 0..1000 {
            drop(registry.acquisition_gate(key(&index.to_string())));
        }
        assert_eq!(registry.acquisition_gates.lock().unwrap().len(), 1);
    }
}
