//! Connection-local authority for scoped channel review. Shared runtime state is
//! only a projection; a review ID can be redeemed only on its creating peer.

use crate::protocol::{NotebookRequest, NotebookResponse};
use std::sync::{Arc, Mutex};
use tokio::sync::{oneshot, watch};

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

/// Queue admission is suspended while shutdown is in flight. A shutdown
/// invalidates tickets already queued; tickets created afterward wait for it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LaunchQueueState {
    Ready(u64),
    Stopping(u64),
}
#[derive(Clone, Copy)]
enum LaunchQueueEvent {
    BeginShutdown,
    FinishShutdown(u64),
}
fn launch_queue_transition(state: LaunchQueueState, event: LaunchQueueEvent) -> LaunchQueueState {
    match (state, event) {
        (
            LaunchQueueState::Ready(revision) | LaunchQueueState::Stopping(revision),
            LaunchQueueEvent::BeginShutdown,
        ) => LaunchQueueState::Stopping(revision + 1),
        (LaunchQueueState::Stopping(revision), LaunchQueueEvent::FinishShutdown(expected))
            if revision == expected =>
        {
            LaunchQueueState::Ready(revision)
        }
        (state, LaunchQueueEvent::FinishShutdown(_)) => state,
    }
}
impl LaunchQueueState {
    fn revision(self) -> u64 {
        match self {
            Self::Ready(r) | Self::Stopping(r) => r,
        }
    }
}

pub(crate) struct ChannelReviewLaunch {
    pub(crate) connection: Arc<ChannelReviewConnection>,
    revision: u64,
}
impl std::fmt::Debug for ChannelReviewLaunch {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ChannelReviewLaunch")
            .field("revision", &self.revision)
            .finish_non_exhaustive()
    }
}
impl ChannelReviewLaunch {
    pub(crate) async fn wait_for_admission(&self) -> anyhow::Result<()> {
        let mut state = self.connection.launch_queue.subscribe();
        loop {
            self.connection.with_live(|| Ok(()))?;
            let current = *state.borrow_and_update();
            anyhow::ensure!(
                current.revision() == self.revision,
                "Queued kernel launch cancelled by shutdown"
            );
            if matches!(current, LaunchQueueState::Ready(_)) {
                return Ok(());
            }
            state
                .changed()
                .await
                .map_err(|_| anyhow::anyhow!("Launch connection closed"))?;
        }
    }
    pub(crate) fn validate_admission(&self) -> anyhow::Result<()> {
        self.connection.with_live(|| {
            anyhow::ensure!(
                *self.connection.launch_queue.borrow() == LaunchQueueState::Ready(self.revision),
                "Queued kernel launch cancelled by shutdown"
            );
            Ok(())
        })
    }
}

pub(super) struct ChannelShutdown {
    connection: Arc<ChannelReviewConnection>,
    revision: u64,
}
impl Drop for ChannelShutdown {
    fn drop(&mut self) {
        self.connection.launch_queue.send_modify(|state| {
            *state =
                launch_queue_transition(*state, LaunchQueueEvent::FinishShutdown(self.revision))
        });
    }
}

pub(crate) struct ChannelReviewConnection {
    peer_id: String,
    requested: bool,
    local_owner: bool,
    state: Mutex<State>,
    launch_queue: watch::Sender<LaunchQueueState>,
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
            launch_queue: watch::channel(LaunchQueueState::Ready(0)).0,
        });
        let lease = ChannelReviewConnectionLease(connection.clone());
        (connection, lease)
    }

    pub(crate) fn queued_launch(self: &Arc<Self>) -> ChannelReviewLaunch {
        ChannelReviewLaunch {
            connection: self.clone(),
            revision: self.launch_queue.borrow().revision(),
        }
    }

    /// Called inside the room shutdown commit, under the launch gate. This
    /// closes the race between queue invalidation and manual launch admission.
    pub(super) fn begin_shutdown(self: &Arc<Self>) -> ChannelShutdown {
        self.launch_queue.send_modify(|state| {
            *state = launch_queue_transition(*state, LaunchQueueEvent::BeginShutdown)
        });
        ChannelShutdown {
            connection: self.clone(),
            revision: self.launch_queue.borrow().revision(),
        }
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
        self.0.launch_queue.send_modify(|state| {
            *state = launch_queue_transition(*state, LaunchQueueEvent::BeginShutdown)
        });
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

    #[test]
    fn shutdown_queue_transitions_fence_stale_completions() {
        use LaunchQueueEvent::*;
        use LaunchQueueState::*;
        for state in [Ready(3), Stopping(3)] {
            assert_eq!(launch_queue_transition(state, BeginShutdown), Stopping(4));
            assert_eq!(launch_queue_transition(state, FinishShutdown(2)), state);
            assert_eq!(launch_queue_transition(state, FinishShutdown(4)), state);
        }
        assert_eq!(
            launch_queue_transition(Ready(3), FinishShutdown(3)),
            Ready(3)
        );
        assert_eq!(
            launch_queue_transition(Stopping(3), FinishShutdown(3)),
            Ready(3)
        );
    }

    #[tokio::test]
    async fn shutdown_invalidates_queued_launch_and_holds_successor_until_completion() {
        use std::future::Future;
        let (connection, _lease) = ChannelReviewConnection::open("peer".into(), true, true);
        let queued = connection.queued_launch();
        let shutdown = connection.begin_shutdown();
        assert!(queued.wait_for_admission().await.is_err());
        assert!(queued.validate_admission().is_err());
        let successor = connection.queued_launch();
        let mut admission = std::pin::pin!(successor.wait_for_admission());
        let mut context = std::task::Context::from_waker(std::task::Waker::noop());
        assert!(admission.as_mut().poll(&mut context).is_pending());
        drop(shutdown);
        admission.await.unwrap();
        successor.validate_admission().unwrap();
        assert!(
            queued.validate_admission().is_err(),
            "completed shutdown cannot revive old queued launches"
        );
    }
}
