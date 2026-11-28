//! Lifecycle of one prompt execution inside the coordinator.
//!
//! One pure transition function ([`transition`]) over [`PromptState`] and
//! [`PromptEvent`]. It performs no I/O: it returns the next state (`None`
//! forgets the run) and the [`Effect`]s the coordinator runs at its edge.
//! Only the dispatch step runs concurrently, so it is the only effect that
//! reports back as an event.
//!
//! ```text
//! accepted --> Waiting --WaitersSettled--> Dispatching --DispatchSucceeded--> Dispatched
//!                 |                            |                                  |
//!                 |                      DispatchFailed                     OwnTerminal
//!                 |--OwnTerminal               |                                  |
//!                 \----------------------> (forgotten, placeholder finalized) <---/
//! ```
//!
//! Stop is not an event: it is document state written by the Stop request
//! (it cancels an execution that has no context yet, or marks a dispatched
//! one for the agent, which cancels or stops it), so the coordinator only
//! ever observes its result as `OwnTerminal`. While
//! `Dispatching`, `OwnTerminal` waits for the dispatch outcome: the agent may
//! already have claimed the run, so it must not be finalized until the
//! dispatch task is done. Events that make no sense in a state (a stale
//! `DispatchSucceeded` after a cancel) are no-ops.

use std::collections::BTreeSet;

/// Where one tracked prompt execution is in the coordinator.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PromptState {
    /// Waiting for cells above the prompt that were queued or running when
    /// the prompt was accepted (their outputs belong in its context).
    Waiting { waiting_on: BTreeSet<String> },
    /// Building the context, storing it on the execution (dispatch) for the
    /// prompt agent. Runs on a spawned task; ends with `DispatchSucceeded` or
    /// `DispatchFailed`.
    Dispatching,
    /// Dispatched to or running in the agent; waiting for it to end.
    Dispatched,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PromptEvent {
    /// These executions were observed terminal (or missing).
    WaitersSettled {
        settled: BTreeSet<String>,
    },
    /// The prompt's own execution is terminal in the RuntimeStateDoc.
    OwnTerminal,
    DispatchSucceeded,
    DispatchFailed {
        error: String,
    },
}

/// Work the coordinator runs after a transition.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Effect {
    /// Spawn the dispatch task.
    Dispatch,
    /// Record `error` as the execution's failure (error output + `error`).
    FailExecution { error: String },
    /// Turn the execution's result into answer cells and drop the placeholder.
    Finalize,
}

impl PromptState {
    /// State and effects of a newly accepted run; `waiting_on` are the
    /// executions above the prompt that were queued or running at that time.
    pub(crate) fn accepted(waiting_on: BTreeSet<String>) -> (PromptState, Vec<Effect>) {
        if waiting_on.is_empty() {
            (PromptState::Dispatching, vec![Effect::Dispatch])
        } else {
            (PromptState::Waiting { waiting_on }, vec![])
        }
    }
}

/// Next state (`None`: forget the run) and effects for `event` in `state`.
pub(crate) fn transition(
    state: &PromptState,
    event: PromptEvent,
) -> (Option<PromptState>, Vec<Effect>) {
    use Effect::*;
    use PromptEvent as E;
    use PromptState as S;

    match (state, event) {
        (S::Waiting { waiting_on }, E::WaitersSettled { settled }) => {
            let remaining = waiting_on.difference(&settled).cloned().collect();
            let (next, effects) = S::accepted(remaining);
            (Some(next), effects)
        }
        // Ended before dispatch (a Stop cancelled it, or room teardown failed
        // it): clean up the placeholder.
        (S::Waiting { .. }, E::OwnTerminal) => (None, vec![Finalize]),

        (S::Dispatching, E::DispatchSucceeded) => (Some(S::Dispatched), vec![]),
        (S::Dispatching, E::DispatchFailed { error }) => {
            (None, vec![FailExecution { error }, Finalize])
        }
        // The dispatch task is still running; its outcome (and the next scan)
        // decides. Finalizing now could race the dispatch write.
        (S::Dispatching, E::OwnTerminal) => (Some(S::Dispatching), vec![]),

        (S::Dispatched, E::OwnTerminal) => (None, vec![Finalize]),

        // Everything else is stale or duplicate input.
        (state, _) => (Some(state.clone()), vec![]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set(ids: &[&str]) -> BTreeSet<String> {
        ids.iter().map(|id| id.to_string()).collect()
    }

    fn waiting(ids: &[&str]) -> PromptState {
        PromptState::Waiting {
            waiting_on: set(ids),
        }
    }

    #[test]
    fn accepted_dispatches_at_once_or_waits() {
        let (state, effects) = PromptState::accepted(set(&[]));
        assert_eq!(state, PromptState::Dispatching);
        assert_eq!(effects, vec![Effect::Dispatch]);

        let (state, effects) = PromptState::accepted(set(&["a", "b"]));
        assert_eq!(state, waiting(&["a", "b"]));
        assert!(effects.is_empty());
    }

    #[test]
    fn waiting_narrows_then_dispatches_when_the_last_waiter_settles() {
        let (next, effects) = transition(
            &waiting(&["a", "b"]),
            PromptEvent::WaitersSettled {
                settled: set(&["a"]),
            },
        );
        assert_eq!(next, Some(waiting(&["b"])));
        assert!(effects.is_empty());

        let (next, effects) = transition(
            &next.unwrap(),
            PromptEvent::WaitersSettled {
                settled: set(&["b", "zzz"]),
            },
        );
        assert_eq!(next, Some(PromptState::Dispatching));
        assert_eq!(effects, vec![Effect::Dispatch]);
    }

    #[test]
    fn waiting_run_ended_from_outside_is_finalized() {
        let (next, effects) = transition(&waiting(&["a"]), PromptEvent::OwnTerminal);
        assert_eq!(next, None);
        assert_eq!(effects, vec![Effect::Finalize]);
    }

    #[test]
    fn dispatch_outcomes() {
        let (next, effects) = transition(&PromptState::Dispatching, PromptEvent::DispatchSucceeded);
        assert_eq!(next, Some(PromptState::Dispatched));
        assert!(effects.is_empty());

        let (next, effects) = transition(
            &PromptState::Dispatching,
            PromptEvent::DispatchFailed {
                error: "no agent".into(),
            },
        );
        assert_eq!(next, None);
        assert_eq!(
            effects,
            vec![
                Effect::FailExecution {
                    error: "no agent".into()
                },
                Effect::Finalize
            ]
        );
    }

    #[test]
    fn dispatched_terminal_is_finalized() {
        let (next, effects) = transition(&PromptState::Dispatched, PromptEvent::OwnTerminal);
        assert_eq!(next, None);
        assert_eq!(effects, vec![Effect::Finalize]);
    }

    /// The execution ends (a Stop) while dispatching: it is finalized only
    /// after the dispatch outcome, once.
    #[test]
    fn a_run_ended_while_dispatching_finalizes_after_the_dispatch_outcome() {
        let (state, effects) = transition(&PromptState::Dispatching, PromptEvent::OwnTerminal);
        assert_eq!(state, Some(PromptState::Dispatching));
        assert!(effects.is_empty());
        let (state, _) = transition(&state.unwrap(), PromptEvent::DispatchSucceeded);
        assert_eq!(state, Some(PromptState::Dispatched));
        let (state, effects) = transition(&state.unwrap(), PromptEvent::OwnTerminal);
        assert_eq!(state, None);
        assert_eq!(effects, vec![Effect::Finalize]);
    }

    #[test]
    fn stale_events_are_noops() {
        let stale = [
            (waiting(&["a"]), PromptEvent::DispatchSucceeded),
            (
                PromptState::Dispatching,
                PromptEvent::WaitersSettled {
                    settled: set(&["a"]),
                },
            ),
            (PromptState::Dispatched, PromptEvent::DispatchSucceeded),
            (
                PromptState::Dispatched,
                PromptEvent::DispatchFailed {
                    error: "late".into(),
                },
            ),
        ];
        for (state, event) in stale {
            let (next, effects) = transition(&state, event.clone());
            assert_eq!(next, Some(state.clone()), "{state:?} + {event:?}");
            assert!(effects.is_empty(), "{state:?} + {event:?}");
        }
    }
}
