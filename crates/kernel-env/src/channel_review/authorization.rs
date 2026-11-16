//! Owner-local consent for one immutable channel-expansion operation.
//!
//! Discovery results are not grants. This state machine separates permission
//! to read newly discovered metadata from permission to use a completed source
//! set, and binds both to the caller's dependency/environment revision. It has
//! no network or filesystem effects and never writes the package allowlist.
//!
//! An owner must keep this session outside shared/peer-writable documents,
//! publish only `pending_review`, and validate its fence at the installation
//! boundary. A token is single-use, not a durable or transferable approval.
//!
//! This is a foundation, not production enablement. The launch coordinator and
//! runtime agent do not consume it yet. Before enabling a surface, its owner must
//! negotiate scoped-review support, retain the exact prepared inputs, fence all
//! dependency/settings/target changes, and serialize consumption with effects.
//! Cache reuse, lock reconstruction, pool reuse, retries and hot-sync must all
//! obey the same scope or stay on the existing no-expansion path. Publishing a
//! review into a shared document does not transfer authority to runtime peers.

use super::{ChannelReview, DiscoveryOutcome};
use uuid::Uuid;

/// Identity of the operation whose dependencies and environment were reviewed.
///
/// The coordinator constructs these values, never the approving client. The
/// revision must cover every installer input (including project content when
/// relevant), and generation changes on cancellation/replacement/restart.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReviewFence {
    pub owner: String,
    pub dependency_revision: String,
    pub environment: String,
    pub generation: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApprovalScope {
    Metadata,
    Install,
}

/// Read-only view for the owner to project into its runtime document.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingChannelReview {
    pub review_id: String,
    pub scope: ApprovalScope,
    pub channels: ChannelReview,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConsentError {
    UnsupportedClient,
    WrongState,
    StaleReview,
    ChangedInputs,
    ChangedDeclaredChannels,
    UnapprovedMetadata,
}

#[derive(Debug)]
enum State {
    Disabled,
    Discovering {
        approved_metadata: Vec<String>,
    },
    Reading {
        request_id: Uuid,
        approved_metadata: Vec<String>,
    },
    Awaiting {
        review: PendingChannelReview,
        approved_metadata: Vec<String>,
    },
    Authorized {
        channels: ChannelReview,
    },
    Consumed,
    Declined,
    Invalidated,
}

/// Authoritative, non-serializable state for a single preparation attempt.
///
/// It deliberately is not `Clone`: copying it could duplicate a one-use grant.
#[derive(Debug)]
pub struct ChannelConsentSession {
    fence: ReviewFence,
    declared_channels: Vec<String>,
    state: State,
}

impl ChannelConsentSession {
    /// Clients that cannot display both approval scopes never enable expansion.
    pub fn new(
        fence: ReviewFence,
        declared_channels: Vec<String>,
        client_supports_scoped_review: bool,
    ) -> Self {
        Self {
            fence,
            declared_channels,
            state: if client_supports_scoped_review {
                State::Discovering {
                    approved_metadata: Vec::new(),
                }
            } else {
                State::Disabled
            },
        }
    }

    fn validate_fence(&mut self, current: &ReviewFence) -> Result<(), ConsentError> {
        if &self.fence != current {
            self.state = State::Invalidated;
            return Err(ConsentError::ChangedInputs);
        }
        Ok(())
    }

    /// Start exactly one metadata effect. The request must be returned with
    /// its result; a late response cannot be applied to a later frontier.
    pub fn begin_discovery(
        &mut self,
        current: &ReviewFence,
    ) -> Result<DiscoveryRequest, ConsentError> {
        self.validate_fence(current)?;
        match &self.state {
            State::Discovering { approved_metadata } => {
                let request_id = Uuid::new_v4();
                let approved_metadata = approved_metadata.clone();
                self.state = State::Reading {
                    request_id,
                    approved_metadata: approved_metadata.clone(),
                };
                Ok(DiscoveryRequest {
                    request_id,
                    approved_metadata,
                })
            }
            State::Disabled => Err(ConsentError::UnsupportedClient),
            _ => Err(ConsentError::WrongState),
        }
    }

    /// Accept the result of the outstanding discovery, rejecting a late result
    /// after cancellation or a change to any prepared-operation input.
    pub fn discovered(
        &mut self,
        current: &ReviewFence,
        request: DiscoveryRequest,
        outcome: DiscoveryOutcome,
    ) -> Result<(), ConsentError> {
        self.validate_fence(current)?;
        let State::Reading {
            request_id,
            approved_metadata,
        } = &self.state
        else {
            return Err(ConsentError::WrongState);
        };
        if *request_id != request.request_id {
            return Err(ConsentError::StaleReview);
        }
        let channels = outcome.review().clone();
        if channels.declared_channels != self.declared_channels {
            self.state = State::Invalidated;
            return Err(ConsentError::ChangedDeclaredChannels);
        }
        // A result from another discovery must not smuggle already-inspected
        // roots into this request. Only the uninspected frontier may exceed
        // the exact metadata authority captured when the request was issued.
        if channels.effective_channels.iter().any(|channel| {
            !self.declared_channels.contains(channel)
                && !approved_metadata.contains(channel)
                && !channels.uninspected_channels.contains(channel)
        }) {
            self.state = State::Invalidated;
            return Err(ConsentError::UnapprovedMetadata);
        }
        let scope = match outcome {
            DiscoveryOutcome::NeedsConsent(_) => ApprovalScope::Metadata,
            DiscoveryOutcome::Complete(_) => ApprovalScope::Install,
        };
        self.state = State::Awaiting {
            review: PendingChannelReview {
                review_id: Uuid::new_v4().to_string(),
                scope,
                channels,
            },
            approved_metadata: approved_metadata.clone(),
        };
        Ok(())
    }

    pub fn pending_review(&self) -> Option<&PendingChannelReview> {
        match &self.state {
            State::Awaiting { review, .. } => Some(review),
            _ => None,
        }
    }

    /// Approve only the server-created review ID; never accept channel lists
    /// from a client. Metadata approval cannot produce an installation token.
    pub fn approve(
        &mut self,
        current: &ReviewFence,
        review_id: &str,
    ) -> Result<ApprovalScope, ConsentError> {
        self.validate_fence(current)?;
        let State::Awaiting {
            review,
            approved_metadata,
        } = &self.state
        else {
            return Err(ConsentError::WrongState);
        };
        if review.review_id != review_id {
            return Err(ConsentError::StaleReview);
        }
        let scope = review.scope;
        self.state = match scope {
            ApprovalScope::Metadata => {
                let mut approved_metadata = approved_metadata.clone();
                for root in &review.channels.uninspected_channels {
                    if !approved_metadata.contains(root) {
                        approved_metadata.push(root.clone());
                    }
                }
                State::Discovering { approved_metadata }
            }
            ApprovalScope::Install => State::Authorized {
                channels: review.channels.clone(),
            },
        };
        Ok(scope)
    }

    /// Refusal is terminal for this attempt; a retry must create a new session.
    pub fn decline(&mut self, current: &ReviewFence, review_id: &str) -> Result<(), ConsentError> {
        self.validate_fence(current)?;
        let State::Awaiting { review, .. } = &self.state else {
            return Err(ConsentError::WrongState);
        };
        if review.review_id != review_id {
            return Err(ConsentError::StaleReview);
        }
        self.state = State::Declined;
        Ok(())
    }

    /// Cancellation, owner eviction, or an environment replacement is terminal.
    pub fn cancel(&mut self) {
        self.state = State::Invalidated;
    }

    /// Consume the completed, explicitly approved source list once.
    ///
    /// This does not install anything. The installer must still check the
    /// token's fence immediately before performing its first mutation, and use
    /// its exact ordered channels with automatic channel discovery disabled.
    pub fn take_authorization(
        &mut self,
        current: &ReviewFence,
    ) -> Result<AuthorizedChannelPlan, ConsentError> {
        self.validate_fence(current)?;
        if !matches!(self.state, State::Authorized { .. }) {
            return Err(ConsentError::WrongState);
        }
        let State::Authorized { channels } = std::mem::replace(&mut self.state, State::Consumed)
        else {
            unreachable!("state checked above")
        };
        Ok(AuthorizedChannelPlan {
            fence: self.fence.clone(),
            channels,
        })
    }
}

/// One outstanding metadata request, constructed only by its owner session.
/// It cannot be cloned or deserialized from peer input.
#[derive(Debug)]
pub struct DiscoveryRequest {
    request_id: Uuid,
    approved_metadata: Vec<String>,
}

impl DiscoveryRequest {
    pub fn approved_metadata_channels(&self) -> &[String] {
        &self.approved_metadata
    }
}

/// Non-cloneable, non-deserializable installation consent from the local owner.
#[derive(Debug)]
pub struct AuthorizedChannelPlan {
    fence: ReviewFence,
    channels: ChannelReview,
}

impl AuthorizedChannelPlan {
    pub fn review(&self) -> &ChannelReview {
        &self.channels
    }

    /// Consume at the effect boundary, rejecting a changed preparation even
    /// when an earlier coordinator check passed. A caller must hold its owner
    /// lease through this check and mutation, not check and then reacquire it.
    pub fn into_channels(self, current: &ReviewFence) -> Result<Vec<String>, ConsentError> {
        if self.fence != *current {
            return Err(ConsentError::ChangedInputs);
        }
        Ok(self.channels.effective_channels)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fence() -> ReviewFence {
        ReviewFence {
            owner: "notebook-a".into(),
            dependency_revision: "deps-project-settings-1".into(),
            environment: "conda:inline:target-a".into(),
            generation: 1,
        }
    }

    fn outcome(frontier: &[&str]) -> DiscoveryOutcome {
        DiscoveryOutcome::from_review(ChannelReview {
            declared_channels: vec!["https://repo.test/main/".into()],
            effective_channels: vec![
                "https://repo.test/extra/".into(),
                "https://repo.test/main/".into(),
            ],
            relations: vec![],
            uninspected_channels: frontier.iter().map(|s| (*s).into()).collect(),
        })
    }

    fn session() -> ChannelConsentSession {
        ChannelConsentSession::new(fence(), vec!["https://repo.test/main/".into()], true)
    }

    fn discover(
        session: &mut ChannelConsentSession,
        current: &ReviewFence,
        result: DiscoveryOutcome,
    ) -> Result<(), ConsentError> {
        let request = session.begin_discovery(current)?;
        session.discovered(current, request, result)
    }

    fn approved() -> ChannelConsentSession {
        let mut session = session();
        discover(
            &mut session,
            &fence(),
            outcome(&["https://repo.test/extra/"]),
        )
        .unwrap();
        let metadata_id = session.pending_review().unwrap().review_id.clone();
        session.approve(&fence(), &metadata_id).unwrap();
        discover(&mut session, &fence(), outcome(&[])).unwrap();
        let id = session.pending_review().unwrap().review_id.clone();
        assert_eq!(session.approve(&fence(), &id), Ok(ApprovalScope::Install));
        session
    }

    #[test]
    fn old_clients_cannot_discover_or_authorize_expansion() {
        let mut session = ChannelConsentSession::new(fence(), vec![], false);
        assert!(matches!(
            session.begin_discovery(&fence()),
            Err(ConsentError::UnsupportedClient)
        ));
        assert!(discover(&mut session, &fence(), outcome(&[])).is_err());
        assert!(session.take_authorization(&fence()).is_err());
    }

    #[test]
    fn metadata_consent_is_not_installation_consent() {
        let mut session = session();

        discover(
            &mut session,
            &fence(),
            outcome(&["https://repo.test/extra/"]),
        )
        .unwrap();
        let first = session.pending_review().unwrap().clone();
        assert_eq!(first.scope, ApprovalScope::Metadata);
        assert!(session.take_authorization(&fence()).is_err());
        assert_eq!(
            session.approve(&fence(), &first.review_id),
            Ok(ApprovalScope::Metadata)
        );
        assert!(session.take_authorization(&fence()).is_err());

        discover(&mut session, &fence(), outcome(&[])).unwrap();
        let final_review = session.pending_review().unwrap().clone();
        assert_eq!(final_review.scope, ApprovalScope::Install);
        assert_ne!(first.review_id, final_review.review_id);
        assert_eq!(
            session.approve(&fence(), &first.review_id),
            Err(ConsentError::StaleReview)
        );
        assert_eq!(
            session.approve(&fence(), &final_review.review_id),
            Ok(ApprovalScope::Install)
        );
        let token = session.take_authorization(&fence()).unwrap();
        assert!(session.take_authorization(&fence()).is_err());
        assert_eq!(
            token.into_channels(&fence()).unwrap(),
            final_review.channels.effective_channels
        );
    }

    #[test]
    fn metadata_requests_are_single_use_and_late_results_cannot_cross_attempts() {
        let mut first = session();
        let request = first.begin_discovery(&fence()).unwrap();
        assert!(request.approved_metadata_channels().is_empty());
        assert!(first.begin_discovery(&fence()).is_err());
        first.cancel();
        assert_eq!(
            first.discovered(&fence(), request, outcome(&[])),
            Err(ConsentError::WrongState)
        );

        let mut first = session();
        let old_request = first.begin_discovery(&fence()).unwrap();
        let mut replacement = session();
        let live_request = replacement.begin_discovery(&fence()).unwrap();
        assert_eq!(
            replacement.discovered(&fence(), old_request, outcome(&[])),
            Err(ConsentError::StaleReview)
        );
        replacement
            .discovered(
                &fence(),
                live_request,
                outcome(&["https://repo.test/extra/"]),
            )
            .unwrap();
    }

    #[test]
    fn metadata_approval_is_exact_and_never_changes_declared_priority() {
        let mut session = session();
        discover(
            &mut session,
            &fence(),
            outcome(&["https://repo.test/extra/"]),
        )
        .unwrap();
        let review = session.pending_review().unwrap().clone();
        session.approve(&fence(), &review.review_id).unwrap();
        let request = session.begin_discovery(&fence()).unwrap();
        assert_eq!(
            request.approved_metadata_channels(),
            &["https://repo.test/extra/"]
        );
        session.discovered(&fence(), request, outcome(&[])).unwrap();
        assert_eq!(
            session.pending_review().unwrap().channels.declared_channels,
            review.channels.declared_channels
        );
    }

    #[test]
    fn newly_discovered_frontier_requires_new_consent() {
        let mut session = session();
        discover(
            &mut session,
            &fence(),
            outcome(&["https://repo.test/extra/"]),
        )
        .unwrap();
        let first = session.pending_review().unwrap().review_id.clone();
        session.approve(&fence(), &first).unwrap();
        discover(
            &mut session,
            &fence(),
            outcome(&["https://repo.test/other/"]),
        )
        .unwrap();
        assert_ne!(session.pending_review().unwrap().review_id, first);
        assert_eq!(
            session.approve(&fence(), &first),
            Err(ConsentError::StaleReview)
        );
        assert!(session.begin_discovery(&fence()).is_err());
        assert!(session.take_authorization(&fence()).is_err());
    }

    #[test]
    fn all_input_fences_invalidate_approval_and_late_results() {
        let original = fence();
        let mut changes = vec![original.clone(); 4];
        changes[0].owner = "notebook-b".into();
        changes[1].dependency_revision = "edited".into();
        changes[2].environment = "other-prefix".into();
        changes[3].generation += 1;
        for current in changes {
            let mut session = session();
            discover(
                &mut session,
                &original,
                outcome(&["https://repo.test/extra/"]),
            )
            .unwrap();
            let id = session.pending_review().unwrap().review_id.clone();
            assert_eq!(
                session.approve(&current, &id),
                Err(ConsentError::ChangedInputs)
            );
            assert!(session.approve(&original, &id).is_err());
            let mut session = self::session();
            assert_eq!(
                discover(&mut session, &current, outcome(&[])),
                Err(ConsentError::ChangedInputs)
            );
            assert!(discover(&mut session, &original, outcome(&[])).is_err());
            let token = approved().take_authorization(&original).unwrap();
            assert_eq!(
                token.into_channels(&current),
                Err(ConsentError::ChangedInputs)
            );
        }
    }

    #[test]
    fn decline_cancel_and_duplicate_approvals_cannot_install() {
        for cancel in [false, true] {
            let mut session = session();
            discover(
                &mut session,
                &fence(),
                outcome(&["https://repo.test/extra/"]),
            )
            .unwrap();
            let id = session.pending_review().unwrap().review_id.clone();
            if cancel {
                session.cancel();
            } else {
                session.decline(&fence(), &id).unwrap();
            }
            assert!(session.approve(&fence(), &id).is_err());
            assert!(discover(&mut session, &fence(), outcome(&[])).is_err());
            assert!(session.take_authorization(&fence()).is_err());
        }
        let mut session = approved();
        assert!(session.approve(&fence(), "anything").is_err());
        session.cancel();
        assert!(session.take_authorization(&fence()).is_err());
    }

    #[test]
    fn broader_discovery_result_cannot_bypass_metadata_approval() {
        let mut session = session();
        assert_eq!(
            discover(&mut session, &fence(), outcome(&[])),
            Err(ConsentError::UnapprovedMetadata)
        );
        assert!(session.pending_review().is_none());
        assert!(session.take_authorization(&fence()).is_err());
        assert!(session.begin_discovery(&fence()).is_err());
    }

    #[test]
    fn changed_declared_channels_fail_closed() {
        let mut session = session();
        let mut review = outcome(&[]).review().clone();
        review.declared_channels.push("https://other.test/".into());
        assert_eq!(
            discover(
                &mut session,
                &fence(),
                DiscoveryOutcome::from_review(review)
            ),
            Err(ConsentError::ChangedDeclaredChannels)
        );
        assert!(session.pending_review().is_none());
        assert!(session.begin_discovery(&fence()).is_err());
    }
}
