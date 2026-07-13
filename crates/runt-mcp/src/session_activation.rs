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
