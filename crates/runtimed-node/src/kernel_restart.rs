//! Client-side restart confirmation for `Session.restartKernelResult()`.
//!
//! The daemon replies to `LaunchKernel` after it writes `Running` and the new
//! `env_source` into RuntimeStateDoc, but the reply frame can reach this client
//! before the RuntimeStateDoc sync frame. A replica read right after the reply
//! can still show `Launching` or the previous kernel's `env_source`. Restarts
//! reuse the connected runtime agent, so `runtime_agent_id` does not change and
//! cannot separate old from new either.
//!
//! The fence is an observation, not an id: the client waits until its replica
//! shows the old kernel stopped, then launches. RuntimeStateDoc changes only
//! arrive in causal order, so a `Running` seen after the fence was written
//! after the stop. Confirmation also requires the `env_source` the daemon
//! reported for this launch and the local environment id when supplied.
//!
//! The protocol has no launch generation. If another peer restarts with the
//! same environment between the fence and confirmation, the two launches look
//! the same here. A terminal state written by another peer in that window can
//! be reported as this restart's failure.
//!
//! [`step`] is the only transition function. The async driver in `session.rs`
//! runs effects (requests, waits) after each transition.

use runtime_doc::{KernelState, RuntimeLifecycle};

/// The parts of a RuntimeStateDoc kernel snapshot the restart flow compares.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(crate) struct KernelObservation {
    pub lifecycle: RuntimeLifecycle,
    pub env_source: String,
    pub environment_id: String,
    pub runtime_agent_id: String,
    pub error_reason: Option<String>,
    pub error_details: Option<String>,
}

impl From<&KernelState> for KernelObservation {
    fn from(kernel: &KernelState) -> Self {
        Self {
            lifecycle: kernel.lifecycle.clone(),
            env_source: kernel.env_source.clone(),
            environment_id: kernel.environment_id.clone(),
            runtime_agent_id: kernel.runtime_agent_id.clone(),
            error_reason: kernel.error_reason.clone().filter(|s| !s.is_empty()),
            error_details: kernel.error_details.clone().filter(|s| !s.is_empty()),
        }
    }
}

impl KernelObservation {
    fn is_starting_or_running(&self) -> bool {
        self.lifecycle.is_starting_or_running()
    }
}

/// Which wait a timeout interrupted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TimeoutStage {
    AwaitingStopped,
    Confirming,
}

/// Daemon reply to the `LaunchKernel` request, already classified.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum LaunchReply {
    /// `KernelLaunched` or `KernelAlreadyRunning`.
    Accepted {
        env_source: String,
        environment_id: Option<String>,
    },
    /// `GuardRejected`: notebook dependencies are not trusted.
    TrustRejected { reason: String },
    /// `Error` or `EnvironmentSelectionRejected`.
    Rejected { error: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum RestartEvent {
    /// `ShutdownKernel` replied `KernelShuttingDown` or `NoKernel`.
    ShutdownAcknowledged,
    /// The local RuntimeStateDoc replica holds this kernel snapshot.
    Observed(KernelObservation),
    LaunchReplied(LaunchReply),
    /// The bounded wait for the current phase expired.
    TimedOut,
}

/// Terminal result of one restart.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum RestartVerdict {
    /// A post-fence `Running` snapshot with the launched `env_source`.
    Running {
        env_source: String,
    },
    TrustRequired {
        reason: String,
    },
    LaunchRejected {
        error: String,
    },
    /// The daemon accepted the launch, then the replica showed `Error`.
    Failed {
        env_source: String,
        observation: KernelObservation,
    },
    /// The daemon accepted the launch, then the replica showed the kernel stopped.
    Stopped {
        env_source: String,
        observation: KernelObservation,
    },
    TimedOut {
        stage: TimeoutStage,
        env_source: Option<String>,
        last: Option<KernelObservation>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum RestartPhase {
    /// `ShutdownKernel` request in flight.
    ShuttingDown,
    /// Waiting for the replica to show the old kernel stopped.
    AwaitingStopped {
        last: Option<KernelObservation>,
    },
    /// `LaunchKernel` request in flight. `fence` is the stopped observation.
    Launching {
        fence: KernelObservation,
        progressed: bool,
    },
    /// Daemon accepted the launch; waiting for the replica to confirm it.
    Confirming {
        fence: KernelObservation,
        env_source: String,
        environment_id: Option<String>,
        progressed: bool,
        last: KernelObservation,
    },
    Done(RestartVerdict),
}

impl RestartPhase {
    pub(crate) fn initial() -> Self {
        Self::ShuttingDown
    }
}

/// Pure restart transition. Events that do not apply to a phase leave it unchanged.
pub(crate) fn step(phase: RestartPhase, event: RestartEvent) -> RestartPhase {
    use RestartEvent as E;
    use RestartPhase as P;
    match (phase, event) {
        (P::Done(verdict), _) => P::Done(verdict),

        (P::ShuttingDown, E::ShutdownAcknowledged) => P::AwaitingStopped { last: None },
        (phase @ P::ShuttingDown, _) => phase,

        (P::AwaitingStopped { .. }, E::Observed(observation))
            if !observation.is_starting_or_running() =>
        {
            P::Launching {
                fence: observation,
                progressed: false,
            }
        }
        (P::AwaitingStopped { .. }, E::Observed(observation)) => P::AwaitingStopped {
            last: Some(observation),
        },
        (P::AwaitingStopped { last }, E::TimedOut) => P::Done(RestartVerdict::TimedOut {
            stage: TimeoutStage::AwaitingStopped,
            env_source: None,
            last,
        }),
        (phase @ P::AwaitingStopped { .. }, _) => phase,

        (P::Launching { fence, progressed }, E::Observed(observation)) => P::Launching {
            progressed: progressed || observation.is_starting_or_running(),
            fence,
        },
        (P::Launching { fence, progressed }, E::LaunchReplied(reply)) => match reply {
            LaunchReply::Accepted {
                env_source,
                environment_id,
            } => P::Confirming {
                last: fence.clone(),
                fence,
                env_source,
                environment_id,
                progressed,
            },
            LaunchReply::TrustRejected { reason } => {
                P::Done(RestartVerdict::TrustRequired { reason })
            }
            LaunchReply::Rejected { error } => P::Done(RestartVerdict::LaunchRejected { error }),
        },
        // The launch request carries the daemon's own deadline.
        (phase @ P::Launching { .. }, _) => phase,

        (
            P::Confirming {
                fence,
                env_source,
                environment_id,
                progressed,
                ..
            },
            E::Observed(observation),
        ) => confirm(fence, env_source, environment_id, progressed, observation),
        (
            P::Confirming {
                env_source, last, ..
            },
            E::TimedOut,
        ) => P::Done(RestartVerdict::TimedOut {
            stage: TimeoutStage::Confirming,
            env_source: Some(env_source),
            last: Some(last),
        }),
        (phase @ P::Confirming { .. }, _) => phase,
    }
}

fn confirm(
    fence: KernelObservation,
    env_source: String,
    environment_id: Option<String>,
    progressed: bool,
    observation: KernelObservation,
) -> RestartPhase {
    let post_fence = progressed || observation != fence;
    match &observation.lifecycle {
        RuntimeLifecycle::Running(_)
            if observation.env_source == env_source
                && environment_id
                    .as_ref()
                    .is_none_or(|id| observation.environment_id == *id) =>
        {
            RestartPhase::Done(RestartVerdict::Running { env_source })
        }
        RuntimeLifecycle::Error if post_fence => RestartPhase::Done(RestartVerdict::Failed {
            env_source,
            observation,
        }),
        lifecycle
            if !lifecycle.is_starting_or_running() && lifecycle != &RuntimeLifecycle::Error =>
        {
            if post_fence {
                RestartPhase::Done(RestartVerdict::Stopped {
                    env_source,
                    observation,
                })
            } else {
                waiting(fence, env_source, environment_id, progressed, observation)
            }
        }
        // Starting phases, a `Running` with another env_source (a concurrent
        // merge or another launch), or the unchanged pre-restart `Error`.
        _ => {
            let progressed = progressed || observation.is_starting_or_running();
            waiting(fence, env_source, environment_id, progressed, observation)
        }
    }
}

fn waiting(
    fence: KernelObservation,
    env_source: String,
    environment_id: Option<String>,
    progressed: bool,
    last: KernelObservation,
) -> RestartPhase {
    RestartPhase::Confirming {
        fence,
        env_source,
        environment_id,
        progressed,
        last,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use runtime_doc::KernelActivity;

    fn obs(lifecycle: RuntimeLifecycle, env_source: &str) -> KernelObservation {
        KernelObservation {
            lifecycle,
            env_source: env_source.to_string(),
            environment_id: String::new(),
            runtime_agent_id: "runtime-agent:1".to_string(),
            error_reason: None,
            error_details: None,
        }
    }

    fn running(env: &str) -> KernelObservation {
        obs(RuntimeLifecycle::Running(KernelActivity::Idle), env)
    }

    fn error(env: &str, details: &str) -> KernelObservation {
        KernelObservation {
            error_details: Some(details.to_string()),
            ..obs(RuntimeLifecycle::Error, env)
        }
    }

    fn accepted(env: &str) -> RestartEvent {
        RestartEvent::LaunchReplied(LaunchReply::Accepted {
            env_source: env.to_string(),
            environment_id: None,
        })
    }

    fn run(events: impl IntoIterator<Item = RestartEvent>) -> RestartPhase {
        events.into_iter().fold(RestartPhase::initial(), step)
    }

    /// Phase right after the daemon accepted the launch, with the fence at
    /// `Shutdown` of the uv kernel.
    fn confirming(env: &str) -> RestartPhase {
        run([
            RestartEvent::ShutdownAcknowledged,
            RestartEvent::Observed(obs(RuntimeLifecycle::Shutdown, "uv:prewarmed")),
            accepted(env),
        ])
    }

    #[test]
    fn incident_stale_launching_with_old_env_source_does_not_confirm() {
        // Shutdown observed, launch accepted for conda:inline, but the replica
        // still shows Launching + uv:prewarmed from before the sync frame lands.
        let phase = step(
            confirming("conda:inline"),
            RestartEvent::Observed(obs(RuntimeLifecycle::Launching, "uv:prewarmed")),
        );
        assert!(
            matches!(phase, RestartPhase::Confirming { .. }),
            "{phase:?}"
        );
        let phase = step(phase, RestartEvent::Observed(running("conda:inline")));
        assert_eq!(
            phase,
            RestartPhase::Done(RestartVerdict::Running {
                env_source: "conda:inline".into()
            })
        );
    }

    #[test]
    fn stale_running_old_env_never_satisfies_restart() {
        let phase = step(
            confirming("conda:inline"),
            RestartEvent::Observed(running("uv:prewarmed")),
        );
        assert!(matches!(phase, RestartPhase::Confirming { .. }));
        let phase = step(phase, RestartEvent::TimedOut);
        match phase {
            RestartPhase::Done(RestartVerdict::TimedOut {
                stage: TimeoutStage::Confirming,
                env_source: Some(env),
                last: Some(last),
            }) => {
                assert_eq!(env, "conda:inline");
                assert_eq!(last, running("uv:prewarmed"));
            }
            other => panic!("expected confirming timeout, got {other:?}"),
        }
    }

    #[test]
    fn another_environment_with_same_source_does_not_confirm() {
        let phase = run([
            RestartEvent::ShutdownAcknowledged,
            RestartEvent::Observed(obs(RuntimeLifecycle::Shutdown, "conda:existing")),
            RestartEvent::LaunchReplied(LaunchReply::Accepted {
                env_source: "conda:existing".into(),
                environment_id: Some("selected-prefix".into()),
            }),
            RestartEvent::Observed(KernelObservation {
                environment_id: "other-prefix".into(),
                ..running("conda:existing")
            }),
        ]);
        assert!(matches!(phase, RestartPhase::Confirming { .. }));
        assert!(matches!(
            step(
                phase,
                RestartEvent::Observed(KernelObservation {
                    environment_id: "selected-prefix".into(),
                    ..running("conda:existing")
                })
            ),
            RestartPhase::Done(RestartVerdict::Running { .. })
        ));
    }

    #[test]
    fn running_snapshot_before_stop_cannot_become_the_fence() {
        let phase = run([
            RestartEvent::ShutdownAcknowledged,
            RestartEvent::Observed(running("uv:prewarmed")),
            RestartEvent::Observed(obs(RuntimeLifecycle::Launching, "uv:prewarmed")),
        ]);
        assert!(matches!(phase, RestartPhase::AwaitingStopped { .. }));
        // A launch reply before the fence is ignored; the driver never sends one.
        let phase = step(phase, accepted("uv:prewarmed"));
        assert!(matches!(phase, RestartPhase::AwaitingStopped { .. }));
    }

    #[test]
    fn same_env_source_restart_confirms_only_after_fence() {
        // Restarting with an unchanged env_source: the old Running(uv) must
        // not count until the replica shows the kernel stopped.
        let phase = run([
            RestartEvent::ShutdownAcknowledged,
            RestartEvent::Observed(running("uv:prewarmed")),
        ]);
        assert!(matches!(phase, RestartPhase::AwaitingStopped { .. }));
        let phase = run([
            RestartEvent::ShutdownAcknowledged,
            RestartEvent::Observed(running("uv:prewarmed")),
            RestartEvent::Observed(obs(RuntimeLifecycle::Shutdown, "uv:prewarmed")),
            accepted("uv:prewarmed"),
            RestartEvent::Observed(running("uv:prewarmed")),
        ]);
        assert_eq!(
            phase,
            RestartPhase::Done(RestartVerdict::Running {
                env_source: "uv:prewarmed".into()
            })
        );
    }

    #[test]
    fn awaiting_stopped_timeout_reports_last_observation() {
        let phase = run([
            RestartEvent::ShutdownAcknowledged,
            RestartEvent::Observed(running("uv:prewarmed")),
            RestartEvent::TimedOut,
        ]);
        assert_eq!(
            phase,
            RestartPhase::Done(RestartVerdict::TimedOut {
                stage: TimeoutStage::AwaitingStopped,
                env_source: None,
                last: Some(running("uv:prewarmed")),
            })
        );
    }

    #[test]
    fn trust_and_launch_rejections_are_terminal() {
        let fenced = [
            RestartEvent::ShutdownAcknowledged,
            RestartEvent::Observed(obs(RuntimeLifecycle::Shutdown, "")),
        ];
        let phase = run(fenced
            .clone()
            .into_iter()
            .chain([RestartEvent::LaunchReplied(LaunchReply::TrustRejected {
                reason: "untrusted".into(),
            })]));
        assert_eq!(
            phase,
            RestartPhase::Done(RestartVerdict::TrustRequired {
                reason: "untrusted".into()
            })
        );
        let phase =
            run(fenced
                .into_iter()
                .chain([RestartEvent::LaunchReplied(LaunchReply::Rejected {
                    error: "project folder not trusted".into(),
                })]));
        assert_eq!(
            phase,
            RestartPhase::Done(RestartVerdict::LaunchRejected {
                error: "project folder not trusted".into()
            })
        );
    }

    #[test]
    fn pre_restart_error_is_not_this_launch_failure() {
        // The old kernel had errored; that Error is the fence. Seeing it again
        // after the launch reply is stale, not a new failure.
        let stale = error("uv:prewarmed", "old crash");
        let phase = run([
            RestartEvent::ShutdownAcknowledged,
            RestartEvent::Observed(stale.clone()),
            accepted("conda:inline"),
            RestartEvent::Observed(stale),
        ]);
        assert!(
            matches!(phase, RestartPhase::Confirming { .. }),
            "{phase:?}"
        );
    }

    #[test]
    fn post_fence_error_fails_the_restart() {
        let phase = step(
            confirming("conda:inline"),
            RestartEvent::Observed(error("conda:inline", "ipykernel missing")),
        );
        match phase {
            RestartPhase::Done(RestartVerdict::Failed {
                env_source,
                observation,
            }) => {
                assert_eq!(env_source, "conda:inline");
                assert_eq!(
                    observation.error_details.as_deref(),
                    Some("ipykernel missing")
                );
            }
            other => panic!("expected failure, got {other:?}"),
        }
    }

    #[test]
    fn same_error_after_progress_is_a_new_failure() {
        let stale = error("uv:prewarmed", "same text");
        let phase = run([
            RestartEvent::ShutdownAcknowledged,
            RestartEvent::Observed(stale.clone()),
            RestartEvent::Observed(obs(RuntimeLifecycle::Launching, "conda:inline")),
            accepted("conda:inline"),
            RestartEvent::Observed(stale),
        ]);
        assert!(matches!(
            phase,
            RestartPhase::Done(RestartVerdict::Failed { .. })
        ));
    }

    #[test]
    fn stop_after_progress_reports_stopped() {
        let phase = step(
            confirming("conda:inline"),
            RestartEvent::Observed(obs(RuntimeLifecycle::Connecting, "conda:inline")),
        );
        let phase = step(
            phase,
            RestartEvent::Observed(obs(RuntimeLifecycle::Shutdown, "conda:inline")),
        );
        assert!(matches!(
            phase,
            RestartPhase::Done(RestartVerdict::Stopped { .. })
        ));
    }

    #[test]
    fn unchanged_stopped_fence_keeps_waiting() {
        let phase = step(
            confirming("conda:inline"),
            RestartEvent::Observed(obs(RuntimeLifecycle::Shutdown, "uv:prewarmed")),
        );
        assert!(matches!(phase, RestartPhase::Confirming { .. }));
    }

    #[test]
    fn awaiting_trust_after_accept_is_a_post_fence_stop() {
        let phase = step(
            confirming("uv:pyproject"),
            RestartEvent::Observed(obs(RuntimeLifecycle::AwaitingProjectTrust, "")),
        );
        assert!(matches!(
            phase,
            RestartPhase::Done(RestartVerdict::Stopped { .. })
        ));
    }

    #[test]
    fn progress_during_launch_carries_into_confirmation() {
        let phase = run([
            RestartEvent::ShutdownAcknowledged,
            RestartEvent::Observed(obs(RuntimeLifecycle::Shutdown, "uv:prewarmed")),
            RestartEvent::Observed(obs(RuntimeLifecycle::Resolving, "uv:prewarmed")),
            accepted("conda:inline"),
        ]);
        assert!(matches!(
            phase,
            RestartPhase::Confirming {
                progressed: true,
                ..
            }
        ));
        // A stop identical to the fence now counts: the kernel started in between.
        let phase = step(
            phase,
            RestartEvent::Observed(obs(RuntimeLifecycle::Shutdown, "uv:prewarmed")),
        );
        assert!(matches!(
            phase,
            RestartPhase::Done(RestartVerdict::Stopped { .. })
        ));
    }

    #[test]
    fn done_is_absorbing_for_every_event() {
        let done = RestartPhase::Done(RestartVerdict::Running {
            env_source: "uv:inline".into(),
        });
        for event in [
            RestartEvent::ShutdownAcknowledged,
            RestartEvent::Observed(obs(RuntimeLifecycle::Error, "x")),
            accepted("y"),
            RestartEvent::TimedOut,
        ] {
            assert_eq!(step(done.clone(), event), done);
        }
    }

    #[test]
    fn inapplicable_events_leave_phase_unchanged() {
        let shutting = RestartPhase::initial();
        for event in [
            RestartEvent::Observed(obs(RuntimeLifecycle::Shutdown, "")),
            accepted("uv:inline"),
            RestartEvent::TimedOut,
        ] {
            assert_eq!(step(shutting.clone(), event), shutting);
        }
        let launching = run([
            RestartEvent::ShutdownAcknowledged,
            RestartEvent::Observed(obs(RuntimeLifecycle::Shutdown, "")),
        ]);
        assert_eq!(step(launching.clone(), RestartEvent::TimedOut), launching);
        assert_eq!(
            step(launching.clone(), RestartEvent::ShutdownAcknowledged),
            launching
        );
        let confirming = confirming("uv:inline");
        assert_eq!(
            step(confirming.clone(), RestartEvent::ShutdownAcknowledged),
            confirming
        );
        assert_eq!(step(confirming.clone(), accepted("other")), confirming);
    }
}
