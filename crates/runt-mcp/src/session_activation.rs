//! Ownership for concurrent notebook activation work.
//!
//! A single activation generation owns the right to publish an active MCP
//! session. Callers for the same canonical target share the in-flight result;
//! choosing another target advances the generation and makes older completions
//! stale without cancelling their underlying daemon work.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};

use rmcp::model::{CallToolResult, Content};
use tokio::sync::watch;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct CanonicalNotebookTarget(String);

impl CanonicalNotebookTarget {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Debug)]
struct InFlightActivation {
    generation: u64,
    result_tx: watch::Sender<Option<CallToolResult>>,
}

#[derive(Debug, Default)]
struct ActivationState {
    generation: u64,
    current_target: Option<CanonicalNotebookTarget>,
    /// Identity of the session actually installed in the active slot. This is
    /// deliberately independent from `current_target`: a failed or cancelled
    /// attempt must not invalidate the healthy session it was trying to
    /// replace.
    installed: Option<(u64, CanonicalNotebookTarget)>,
    in_flight: HashMap<CanonicalNotebookTarget, InFlightActivation>,
}

/// Process-local owner for notebook activation generations.
#[derive(Debug, Default)]
pub struct SessionActivation {
    state: Mutex<ActivationState>,
}

pub enum ActivationTicket {
    Leader(ActivationLease),
    Follower(ActivationFollower),
}

pub struct ActivationLease {
    owner: Arc<SessionActivation>,
    target: CanonicalNotebookTarget,
    generation: u64,
    completed: bool,
}

pub struct ActivationFollower {
    target: CanonicalNotebookTarget,
    generation: u64,
    result_rx: watch::Receiver<Option<CallToolResult>>,
}

impl SessionActivation {
    fn lock_state(&self) -> MutexGuard<'_, ActivationState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Claim a target or join the current same-target activation.
    ///
    /// A same-target flight is reused only while it is also the current
    /// generation. This prevents an A-B-A switch from joining stale A work.
    pub fn begin(self: &Arc<Self>, target: CanonicalNotebookTarget) -> ActivationTicket {
        let mut state = self.lock_state();
        if let Some(flight) = state.in_flight.get(&target) {
            if flight.generation == state.generation {
                return ActivationTicket::Follower(ActivationFollower {
                    target,
                    generation: flight.generation,
                    result_rx: flight.result_tx.subscribe(),
                });
            }
        }

        state.generation = state.generation.saturating_add(1);
        let generation = state.generation;
        state.current_target = Some(target.clone());
        let (result_tx, _result_rx) = watch::channel(None);
        state.in_flight.insert(
            target.clone(),
            InFlightActivation {
                generation,
                result_tx,
            },
        );

        ActivationTicket::Leader(ActivationLease {
            owner: Arc::clone(self),
            target,
            generation,
            completed: false,
        })
    }

    pub fn is_current(&self, generation: u64, target: &CanonicalNotebookTarget) -> bool {
        let state = self.lock_state();
        state.generation == generation && state.current_target.as_ref() == Some(target)
    }

    pub fn is_current_identity(&self, generation: u64, target: &str) -> bool {
        let state = self.lock_state();
        state
            .installed
            .as_ref()
            .is_some_and(|(installed_generation, installed_target)| {
                *installed_generation == generation && installed_target.as_str() == target
            })
    }

    pub fn has_current_local_path_flight(&self) -> bool {
        let state = self.lock_state();
        state.current_target.as_ref().is_some_and(|target| {
            target.as_str().starts_with("local:path:")
                && state
                    .in_flight
                    .get(target)
                    .is_some_and(|flight| flight.generation == state.generation)
        })
    }
}

impl ActivationLease {
    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub fn target(&self) -> &CanonicalNotebookTarget {
        &self.target
    }

    pub fn is_current(&self) -> bool {
        self.owner.is_current(self.generation, &self.target)
    }

    /// Commit this activation identity as the session currently installed in
    /// the MCP slot. The attempt must still be current at this exact point.
    pub fn mark_installed(&self) -> bool {
        let mut state = self.owner.lock_state();
        if state.generation != self.generation
            || state.current_target.as_ref() != Some(&self.target)
        {
            return false;
        }
        state.installed = Some((self.generation, self.target.clone()));
        true
    }

    /// Error result for an attempt superseded by a newer target.
    pub fn superseded_result(&self) -> CallToolResult {
        activation_error(
            "session_superseded",
            "A newer notebook target superseded this connection",
            self.generation,
            &self.target,
        )
    }

    /// Publish `session` into the active slot and commit this lease as the
    /// installed identity, rolling back on a refused commit.
    ///
    /// This is the supersede discipline for slot publication, in lock order:
    /// the attempt must be current before taking the slot lock, current again
    /// under the lock before the slot is touched, and `mark_installed` is the
    /// atomic commit point. A refused commit restores the previous occupant
    /// and drops the stale session, so a superseded connect never leaves its
    /// session published over the target the user switched to.
    ///
    /// Returns the previous occupant on success; its disposition (parking,
    /// teardown) is the caller's decision. Generic over the slot payload so
    /// tests exercise the exact production lock/check ordering against a stub
    /// payload instead of mirroring it.
    pub async fn install_in_slot<S>(
        &self,
        slot: &tokio::sync::RwLock<Option<S>>,
        session: S,
    ) -> Result<Option<S>, CallToolResult> {
        if !self.is_current() {
            return Err(self.superseded_result());
        }

        let mut guard = slot.write().await;
        if !self.is_current() {
            return Err(self.superseded_result());
        }
        let previous = guard.replace(session);
        if !self.mark_installed() {
            let stale = guard.take();
            *guard = previous;
            drop(stale);
            return Err(self.superseded_result());
        }
        Ok(previous)
    }

    /// Add another canonical locator for this same in-flight room.
    ///
    /// A cold path open learns the daemon UUID only after its handshake. Once
    /// registered, UUID callers subscribe to the path-owned flight instead of
    /// starting a competing generation. Stale generations cannot add aliases.
    pub fn add_alias(&self, alias: CanonicalNotebookTarget) -> bool {
        let mut state = self.owner.lock_state();
        if state.generation != self.generation
            || state.current_target.as_ref() != Some(&self.target)
        {
            return false;
        }
        let Some(flight) = state.in_flight.get(&self.target) else {
            return false;
        };
        let generation = flight.generation;
        let result_tx = flight.result_tx.clone();
        state.in_flight.insert(
            alias,
            InFlightActivation {
                generation,
                result_tx,
            },
        );
        true
    }

    /// Publish the leader's result to coalesced callers and close the flight.
    pub fn complete(&mut self, result: &CallToolResult) {
        let mut state = self.owner.lock_state();
        if let Some(flight) = state
            .in_flight
            .values()
            .find(|flight| flight.generation == self.generation)
        {
            let _ = flight.result_tx.send(Some(result.clone()));
        }
        state
            .in_flight
            .retain(|_, flight| flight.generation != self.generation);
        self.completed = true;
    }
}

impl Drop for ActivationLease {
    fn drop(&mut self) {
        if self.completed {
            return;
        }

        let mut state = self.owner.lock_state();
        if let Some(flight) = state
            .in_flight
            .values()
            .find(|flight| flight.generation == self.generation)
        {
            let result = activation_error(
                "sync_failed",
                "Notebook activation ended before publishing a result",
                self.generation,
                &self.target,
            );
            let _ = flight.result_tx.send(Some(result));
        }
        state
            .in_flight
            .retain(|_, flight| flight.generation != self.generation);
    }
}

impl ActivationFollower {
    pub async fn wait(mut self) -> CallToolResult {
        loop {
            if let Some(result) = self.result_rx.borrow().clone() {
                return result;
            }
            if self.result_rx.changed().await.is_err() {
                return activation_error(
                    "sync_failed",
                    "Notebook activation owner disappeared before publishing a result",
                    self.generation,
                    &self.target,
                );
            }
        }
    }
}

pub fn activation_error(
    code: &str,
    message: &str,
    generation: u64,
    target: &CanonicalNotebookTarget,
) -> CallToolResult {
    let details = serde_json::json!({
        "error": {
            "code": code,
            "message": message,
            "session_generation": generation,
            "target": target.as_str(),
        }
    });
    let mut result = CallToolResult::error(vec![Content::text(details.to_string())]);
    result.structured_content = Some(details);
    result
}

#[cfg(test)]
mod tests {
    use std::future::Future;

    use super::*;

    fn target(value: &str) -> CanonicalNotebookTarget {
        CanonicalNotebookTarget::new(value)
    }

    fn success(value: &str) -> CallToolResult {
        CallToolResult::success(vec![Content::text(value.to_string())])
    }

    #[tokio::test]
    async fn coalesces_same_target_flight() {
        let owner = Arc::new(SessionActivation::default());
        let ActivationTicket::Leader(mut leader) = owner.begin(target("local:id:a")) else {
            panic!("first activation must lead");
        };
        let ActivationTicket::Follower(follower) = owner.begin(target("local:id:a")) else {
            panic!("same target must follow");
        };

        let expected = success("connected");
        leader.complete(&expected);

        assert_eq!(follower.wait().await, expected);
    }

    #[test]
    fn different_target_supersedes_generation() {
        let owner = Arc::new(SessionActivation::default());
        let ActivationTicket::Leader(first) = owner.begin(target("local:id:a")) else {
            panic!("first activation must lead");
        };
        let ActivationTicket::Leader(second) = owner.begin(target("local:id:b")) else {
            panic!("different target must lead");
        };

        assert_eq!(first.generation(), 1);
        assert_eq!(second.generation(), 2);
        assert!(!first.is_current());
        assert!(second.is_current());
    }

    #[test]
    fn aba_switch_does_not_follow_stale_first_target() {
        let owner = Arc::new(SessionActivation::default());
        let ActivationTicket::Leader(first_a) = owner.begin(target("local:id:a")) else {
            panic!("first activation must lead");
        };
        let ActivationTicket::Leader(_b) = owner.begin(target("local:id:b")) else {
            panic!("different target must lead");
        };
        let ActivationTicket::Leader(second_a) = owner.begin(target("local:id:a")) else {
            panic!("A after B must create a new generation");
        };

        assert_eq!(first_a.generation(), 1);
        assert_eq!(second_a.generation(), 3);
        assert!(!first_a.is_current());
        assert!(second_a.is_current());
    }

    #[test]
    fn failed_replacement_attempt_does_not_supersede_installed_identity() {
        let owner = Arc::new(SessionActivation::default());
        let ActivationTicket::Leader(mut installed) = owner.begin(target("local:id:a")) else {
            panic!("first activation must lead");
        };
        assert!(installed.mark_installed());
        installed.complete(&success("connected a"));

        let ActivationTicket::Leader(replacement) = owner.begin(target("local:id:b")) else {
            panic!("replacement activation must lead");
        };
        drop(replacement);

        assert!(owner.is_current_identity(installed.generation(), installed.target().as_str()));
    }

    #[tokio::test]
    async fn dropped_leader_wakes_followers() {
        let owner = Arc::new(SessionActivation::default());
        let ActivationTicket::Leader(leader) = owner.begin(target("local:id:a")) else {
            panic!("first activation must lead");
        };
        let ActivationTicket::Follower(follower) = owner.begin(target("local:id:a")) else {
            panic!("same target must follow");
        };

        drop(leader);
        let result = follower.wait().await;
        assert_eq!(result.is_error, Some(true));
        assert_eq!(
            result
                .structured_content
                .as_ref()
                .and_then(|value| value.pointer("/error/code"))
                .and_then(serde_json::Value::as_str),
            Some("sync_failed")
        );
    }

    fn assert_superseded(error: &CallToolResult) {
        assert_eq!(error.is_error, Some(true));
        assert_eq!(
            error
                .structured_content
                .as_ref()
                .and_then(|value| value.pointer("/error/code"))
                .and_then(serde_json::Value::as_str),
            Some("session_superseded")
        );
    }

    /// Deterministic rollback drive for `install_in_slot`, the production
    /// publish/commit/rollback sequence used by `install_activated_session`
    /// (tools/session.rs). The connect future is stubbed with a oneshot so
    /// the supersede lands at an exact point: after the reconnect claims its
    /// lease, before its session reaches the slot. A superseded connect must
    /// never publish over the notebook the user just switched to; the
    /// previous occupant stays installed.
    #[tokio::test]
    async fn superseded_connect_install_preserves_previous_slot_occupant() {
        let owner = Arc::new(SessionActivation::default());
        let slot = Arc::new(tokio::sync::RwLock::new(None::<String>));

        // Healthy occupant: target A connects, publishes, and commits.
        let ActivationTicket::Leader(mut installed) = owner.begin(target("local:id:a")) else {
            panic!("first activation must lead");
        };
        assert_eq!(
            installed
                .install_in_slot(&slot, "session-a-gen1".to_string())
                .await
                .expect("current attempt must install"),
            None
        );
        let installed_generation = installed.generation();
        installed.complete(&success("connected a"));

        // Reconnect attempt for the same target. Its flight closed with
        // `complete`, so this leads a fresh generation.
        let ActivationTicket::Leader(reconnect) = owner.begin(target("local:id:a")) else {
            panic!("reconnect after a completed flight must lead");
        };
        let (connect_tx, connect_rx) = tokio::sync::oneshot::channel::<String>();
        let install_slot = Arc::clone(&slot);
        let install = tokio::spawn(async move {
            // Stubbed connect: the daemon handshake resolves only when the
            // test fires the oneshot, after the supersede below.
            let session = connect_rx.await.expect("connect stub must resolve");
            reconnect.install_in_slot(&install_slot, session).await
        });

        // Supersede mid-flight: the user switches to B while A's stubbed
        // connect is still pending.
        let ActivationTicket::Leader(_b) = owner.begin(target("local:id:b")) else {
            panic!("different target must lead");
        };

        connect_tx
            .send("session-a-gen2".to_string())
            .expect("install task must be waiting on the connect stub");

        let result = install.await.expect("install task must not panic");

        // The pre-publish is_current check refuses the stale attempt before
        // its session reaches the slot, and the result reports it.
        let error = result.expect_err("superseded install must not publish");
        assert_superseded(&error);

        // The previous occupant still owns the slot and the installed
        // identity.
        assert_eq!(slot.read().await.as_deref(), Some("session-a-gen1"));
        assert!(owner.is_current_identity(installed_generation, "local:id:a"));
    }

    /// Pins the second `is_current` check: the one taken under the slot
    /// write lock, after the pre-lock check already passed. The install
    /// future is polled to its lock acquisition while the test holds the
    /// write guard, then superseded before the guard is released. Only the
    /// under-lock check can refuse this attempt; without it the stale
    /// session would publish.
    #[tokio::test]
    async fn supersede_while_awaiting_slot_lock_is_refused_under_the_lock() {
        let owner = Arc::new(SessionActivation::default());
        let slot = tokio::sync::RwLock::new(None::<String>);

        let ActivationTicket::Leader(mut installed) = owner.begin(target("local:id:a")) else {
            panic!("first activation must lead");
        };
        installed
            .install_in_slot(&slot, "session-a-gen1".to_string())
            .await
            .expect("current attempt must install");
        let installed_generation = installed.generation();
        installed.complete(&success("connected a"));

        let ActivationTicket::Leader(reconnect) = owner.begin(target("local:id:a")) else {
            panic!("reconnect after a completed flight must lead");
        };

        let guard = slot.write().await;
        let mut install =
            std::pin::pin!(reconnect.install_in_slot(&slot, "session-a-gen2".to_string()));
        let mut context = std::task::Context::from_waker(std::task::Waker::noop());
        // First poll passes the pre-lock check (the attempt is still
        // current) and parks on the slot write lock the test holds.
        assert!(install.as_mut().poll(&mut context).is_pending());

        // Supersede while the install is queued on the lock, then let it in.
        let ActivationTicket::Leader(_b) = owner.begin(target("local:id:b")) else {
            panic!("different target must lead");
        };
        drop(guard);

        let error = install
            .await
            .expect_err("superseded install must not publish");
        assert_superseded(&error);

        assert_eq!(slot.read().await.as_deref(), Some("session-a-gen1"));
        assert!(owner.is_current_identity(installed_generation, "local:id:a"));
    }

    #[tokio::test]
    async fn cold_path_can_alias_uuid_into_same_flight() {
        let owner = Arc::new(SessionActivation::default());
        let ActivationTicket::Leader(mut path_leader) =
            owner.begin(target("local:path:/tmp/example.ipynb"))
        else {
            panic!("path activation must lead");
        };
        assert!(path_leader.add_alias(target("local:id:abc")));
        let ActivationTicket::Follower(uuid_follower) = owner.begin(target("local:id:abc")) else {
            panic!("UUID alias must follow the path-owned flight");
        };

        let expected = success("connected once");
        path_leader.complete(&expected);
        assert_eq!(uuid_follower.wait().await, expected);
    }
}
