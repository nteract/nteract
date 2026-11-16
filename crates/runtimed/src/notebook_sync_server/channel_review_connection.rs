//! Per-connection admission for the still-disabled scoped channel workflow.
//!
//! The handshake opt-in is protocol literacy, not consent. This deny-only
//! bridge retains it with the authenticated owner/hosted facts and the server's
//! fresh peer identity. Nothing is copied into shared room/runtime documents.
//! A future enabled route must also own an immutable prepared review ID and
//! fence installation/publication; changing this module alone cannot enable it.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use crate::protocol::{NotebookRequest, NotebookResponse};

pub(super) struct ChannelReviewConnection {
    peer_id: String,
    requested: bool,
    local_owner: bool,
    live: AtomicBool,
}

/// Dropped with the actual peer sync-loop, including cancellation/error paths.
/// Request workers retain only the checkable connection, not this lease.
pub(super) struct ChannelReviewConnectionLease(Arc<ChannelReviewConnection>);

impl ChannelReviewConnection {
    pub(super) fn open(
        peer_id: String,
        requested: bool,
        local_owner: bool,
    ) -> (Arc<Self>, ChannelReviewConnectionLease) {
        let connection = Arc::new(Self {
            peer_id,
            requested,
            local_owner,
            live: AtomicBool::new(true),
        });
        let lease = ChannelReviewConnectionLease(connection.clone());
        (connection, lease)
    }

    pub(super) fn reject_review_request(
        &self,
        peer_id: &str,
        request: &NotebookRequest,
    ) -> Option<NotebookResponse> {
        if !matches!(
            request,
            NotebookRequest::ApproveRelatedChannels { .. }
                | NotebookRequest::DeclineRelatedChannels { .. }
        ) {
            return None;
        }
        let error = if !self.live.load(Ordering::Acquire) || self.peer_id != peer_id {
            "Channel review belongs to an inactive connection; reconnect and review again"
        } else if !self.requested {
            "Scoped channel review was not requested by this connection"
        } else if !self.local_owner {
            "Scoped channel review requires a local owner connection"
        } else {
            // Intentionally unconditional. No production prepared-install route
            // is complete, so no server review ID is currently redeemable.
            "Scoped channel installation is not available on this connection"
        };
        Some(NotebookResponse::Error {
            error: error.into(),
        })
    }
}

impl Drop for ChannelReviewConnectionLease {
    fn drop(&mut self) {
        self.0.live.store(false, Ordering::Release);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn approval(id: &str) -> NotebookRequest {
        NotebookRequest::ApproveRelatedChannels {
            review_id: id.into(),
        }
    }
    fn rejection(
        connection: &ChannelReviewConnection,
        peer: &str,
        request: &NotebookRequest,
    ) -> String {
        match connection.reject_review_request(peer, request) {
            Some(NotebookResponse::Error { error }) => error,
            _ => panic!("review must be refused without a complete owner route"),
        }
    }

    #[test]
    fn legacy_opted_in_and_nonowner_connections_all_fail_closed() {
        for (requested, owner, expected) in [
            (false, true, "not requested"),
            (true, false, "local owner"),
            (true, true, "not available"),
        ] {
            let (connection, _lease) =
                ChannelReviewConnection::open("peer-a".into(), requested, owner);
            for request in [
                approval("server-review-id"),
                NotebookRequest::DeclineRelatedChannels {
                    review_id: "server-review-id".into(),
                },
            ] {
                assert!(rejection(&connection, "peer-a", &request).contains(expected));
            }
        }
    }

    #[test]
    fn disconnect_invalidates_queued_requests_without_enabling_successor() {
        let (old, lease) = ChannelReviewConnection::open("peer-old".into(), true, true);
        drop(lease);
        assert!(rejection(&old, "peer-old", &approval("old-id")).contains("inactive"));
        let (new, _lease) = ChannelReviewConnection::open("peer-new".into(), true, true);
        assert!(rejection(&new, "peer-old", &approval("old-id")).contains("inactive"));
        assert!(rejection(&new, "peer-new", &approval("old-id")).contains("not available"));
    }

    #[test]
    fn one_peers_opt_in_does_not_upgrade_another_peer() {
        let (new, _new_lease) = ChannelReviewConnection::open("new".into(), true, true);
        let (old, _old_lease) = ChannelReviewConnection::open("old".into(), false, true);
        assert!(rejection(&new, "new", &approval("id")).contains("not available"));
        assert!(rejection(&old, "old", &approval("id")).contains("not requested"));
        assert!(old
            .reject_review_request("old", &NotebookRequest::GetEnvironmentSelection {})
            .is_none());
    }
}
