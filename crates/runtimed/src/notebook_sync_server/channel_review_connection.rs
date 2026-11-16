//! Connection-local authority for scoped channel review. Shared runtime state is
//! only a projection; a review ID can be redeemed only on its creating peer.

use crate::protocol::{NotebookRequest, NotebookResponse};
use std::sync::{Arc, Mutex};
use tokio::sync::oneshot;

type Validate = Arc<dyn kernel_env::channel_review::authorization::ReviewValidator>;

struct Pending {
    id: String,
    validate: Validate,
    reply: oneshot::Sender<bool>,
}

enum State {
    Live { pending: Option<Pending> },
    Closed,
}

pub(crate) struct ChannelReviewConnection {
    peer_id: String,
    requested: bool,
    local_owner: bool,
    state: Mutex<State>,
}

pub(crate) struct ChannelReviewConnectionLease(Arc<ChannelReviewConnection>);

pub(crate) struct ReviewWaiter {
    connection: Arc<ChannelReviewConnection>,
    id: String,
}

impl Drop for ReviewWaiter {
    fn drop(&mut self) {
        let mut state = self
            .connection
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if let State::Live { pending } = &mut *state {
            if pending.as_ref().is_some_and(|p| p.id == self.id) {
                *pending = None;
            }
        }
    }
}

impl ChannelReviewConnection {
    pub(crate) fn open(
        peer_id: String,
        requested: bool,
        local_owner: bool,
    ) -> (Arc<Self>, ChannelReviewConnectionLease) {
        let connection = Arc::new(Self {
            peer_id,
            requested,
            local_owner,
            state: Mutex::new(State::Live { pending: None }),
        });
        let lease = ChannelReviewConnectionLease(connection.clone());
        (connection, lease)
    }

    pub(crate) fn enabled(&self) -> bool {
        self.requested && self.local_owner
    }

    /// Serialize the effect boundary with disconnect. No await under this lock.
    pub(crate) fn with_live<T>(
        &self,
        effect: impl FnOnce() -> anyhow::Result<T>,
    ) -> anyhow::Result<T> {
        let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        anyhow::ensure!(
            self.enabled() && matches!(*state, State::Live { .. }),
            "Channel review belongs to an inactive or unsupported connection"
        );
        effect()
    }

    pub(crate) fn register(
        self: &Arc<Self>,
        id: String,
        validate: Validate,
    ) -> anyhow::Result<(ReviewWaiter, oneshot::Receiver<bool>)> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        anyhow::ensure!(self.enabled(), "Scoped channel review was not requested");
        let State::Live { pending } = &mut *state else {
            anyhow::bail!("Channel review belongs to an inactive connection");
        };
        anyhow::ensure!(pending.is_none(), "A channel review is already pending");
        let (reply, receiver) = oneshot::channel();
        *pending = Some(Pending {
            id: id.clone(),
            validate,
            reply,
        });
        Ok((
            ReviewWaiter {
                connection: self.clone(),
                id,
            },
            receiver,
        ))
    }

    pub(super) async fn reject_review_request(
        &self,
        peer_id: &str,
        request: &NotebookRequest,
    ) -> Option<NotebookResponse> {
        self.handle_review_request(peer_id, request).await
    }

    pub(super) async fn handle_review_request(
        &self,
        peer_id: &str,
        request: &NotebookRequest,
    ) -> Option<NotebookResponse> {
        let (id, approved) = match request {
            NotebookRequest::ApproveRelatedChannels { review_id } => (review_id, true),
            NotebookRequest::DeclineRelatedChannels { review_id } => (review_id, false),
            _ => return None,
        };
        let result: anyhow::Result<()> = async {
            let pending =
                {
                    let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
                    anyhow::ensure!(self.peer_id == peer_id && matches!(*state, State::Live { .. }),
                    "Channel review belongs to an inactive connection; reconnect and review again");
                    anyhow::ensure!(
                        self.requested,
                        "Scoped channel review was not requested by this connection"
                    );
                    anyhow::ensure!(
                        self.local_owner,
                        "Scoped channel review requires a local owner connection"
                    );
                    let State::Live { pending } = &mut *state else {
                        unreachable!()
                    };
                    anyhow::ensure!(
                        pending.as_ref().is_some_and(|p| &p.id == id),
                        "Channel review is not available on this connection; review again"
                    );
                    // Consume before replying: duplicate IDs cannot queue two decisions.
                    pending
                        .take()
                        .ok_or_else(|| anyhow::anyhow!("Channel review expired"))?
                };
            pending.validate.validate().await?;
            pending
                .reply
                .send(approved)
                .map_err(|_| anyhow::anyhow!("Channel review expired"))
        }
        .await;
        Some(match result {
            Ok(()) => NotebookResponse::Ok {},
            Err(error) => NotebookResponse::Error {
                error: error.to_string(),
            },
        })
    }
}

impl Drop for ChannelReviewConnectionLease {
    fn drop(&mut self) {
        *self.0.state.lock().unwrap_or_else(|e| e.into_inner()) = State::Closed;
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
    async fn rejection(
        connection: &ChannelReviewConnection,
        peer: &str,
        request: &NotebookRequest,
    ) -> String {
        match connection.reject_review_request(peer, request).await {
            Some(NotebookResponse::Error { error }) => error,
            _ => panic!("review must be refused without a complete owner route"),
        }
    }

    #[tokio::test]
    async fn legacy_opted_in_and_nonowner_connections_all_fail_closed() {
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
                assert!(rejection(&connection, "peer-a", &request)
                    .await
                    .contains(expected));
            }
        }
    }

    #[tokio::test]
    async fn disconnect_invalidates_queued_requests_without_enabling_successor() {
        let (old, lease) = ChannelReviewConnection::open("peer-old".into(), true, true);
        drop(lease);
        assert!(rejection(&old, "peer-old", &approval("old-id"))
            .await
            .contains("inactive"));
        let (new, _lease) = ChannelReviewConnection::open("peer-new".into(), true, true);
        assert!(rejection(&new, "peer-old", &approval("old-id"))
            .await
            .contains("inactive"));
        assert!(rejection(&new, "peer-new", &approval("old-id"))
            .await
            .contains("not available"));
    }

    #[tokio::test]
    async fn one_peers_opt_in_does_not_upgrade_another_peer() {
        let (new, _new_lease) = ChannelReviewConnection::open("new".into(), true, true);
        let (old, _old_lease) = ChannelReviewConnection::open("old".into(), false, true);
        assert!(rejection(&new, "new", &approval("id"))
            .await
            .contains("not available"));
        assert!(rejection(&old, "old", &approval("id"))
            .await
            .contains("not requested"));
        assert!(old
            .reject_review_request("old", &NotebookRequest::GetEnvironmentSelection {})
            .await
            .is_none());
    }
    #[tokio::test]
    async fn only_live_creating_peer_can_redeem_each_review_once() {
        let (connection, lease) = ChannelReviewConnection::open("peer".into(), true, true);
        let (_waiter, receiver) = connection
            .register("review-1".into(), Arc::new(|| Ok(())))
            .unwrap();
        assert!(rejection(&connection, "other", &approval("review-1"))
            .await
            .contains("inactive"));
        assert!(rejection(&connection, "peer", &approval("old-id"))
            .await
            .contains("not available"));
        assert!(matches!(
            connection
                .handle_review_request("peer", &approval("review-1"))
                .await,
            Some(NotebookResponse::Ok {})
        ));
        assert!(receiver.await.unwrap());
        assert!(rejection(&connection, "peer", &approval("review-1"))
            .await
            .contains("not available"));
        let (_waiter, receiver) = connection
            .register("review-2".into(), Arc::new(|| Ok(())))
            .unwrap();
        drop(lease);
        assert!(receiver.await.is_err());
        assert!(rejection(&connection, "peer", &approval("review-2"))
            .await
            .contains("inactive"));
    }

    #[tokio::test]
    async fn changed_inputs_cannot_deliver_an_approval() {
        let (connection, _lease) = ChannelReviewConnection::open("peer".into(), true, true);
        let (_waiter, receiver) = connection
            .register(
                "review".into(),
                Arc::new(|| anyhow::bail!("inputs changed")),
            )
            .unwrap();
        assert!(rejection(&connection, "peer", &approval("review"))
            .await
            .contains("inputs changed"));
        assert!(receiver.await.is_err());
    }

    #[tokio::test]
    async fn decline_is_one_use_and_abandoned_waiter_revokes_id() {
        let (connection, _lease) = ChannelReviewConnection::open("peer".into(), true, true);
        let (waiter, receiver) = connection
            .register("decline".into(), Arc::new(|| Ok(())))
            .unwrap();
        assert!(matches!(
            connection
                .handle_review_request(
                    "peer",
                    &NotebookRequest::DeclineRelatedChannels {
                        review_id: "decline".into()
                    }
                )
                .await,
            Some(NotebookResponse::Ok {})
        ));
        assert!(!receiver.await.unwrap());
        drop(waiter);
        let (waiter, receiver) = connection
            .register("abandoned".into(), Arc::new(|| Ok(())))
            .unwrap();
        drop(waiter);
        assert!(receiver.await.is_err());
        assert!(rejection(&connection, "peer", &approval("abandoned"))
            .await
            .contains("not available"));
    }
}
