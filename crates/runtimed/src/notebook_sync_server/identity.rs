use notebook_doc::diff::ChangeActor;
use nteract_identity::{
    ActorLabel, AuthenticatedConnection, ConnectionScope, Credential, IdentityProvider,
    LocalPeerCredential, Operator,
};

/// Identity state attached to one room connection.
#[derive(Debug, Clone)]
pub(crate) struct RoomConnectionIdentity {
    auth: AuthenticatedConnection,
    actor_label: ActorLabel,
    fallback_operator: Operator,
    legacy_operator_actor_policy: LegacyOperatorActorPolicy,
}

impl RoomConnectionIdentity {
    /// Authenticate a local same-UID daemon connection.
    pub(crate) async fn local(presented_operator: Option<String>) -> anyhow::Result<Self> {
        Self::local_with_scope(presented_operator, ConnectionScope::Owner).await
    }

    /// Authenticate a local same-UID daemon connection with an explicit scope.
    ///
    /// Local file-backed rooms use this to downgrade a connection to viewer
    /// when the host can read a notebook but cannot write it. The principal is
    /// still the local user; only the room-enforced document capabilities differ.
    pub(crate) async fn local_with_scope(
        presented_operator: Option<String>,
        scope: ConnectionScope,
    ) -> anyhow::Result<Self> {
        let username = local_username();
        let provider = IdentityProvider::local();
        let credential = Credential::LocalPeer(LocalPeerCredential::new(username)?);
        let user = provider.authenticate(credential).await?;
        let auth = AuthenticatedConnection::new(user.principal().clone(), scope);
        let fallback_operator = fallback_operator("desktop");
        let operator = presented_operator
            .as_deref()
            .and_then(|value| Operator::from_actor_label_or_operator(value).ok())
            .unwrap_or_else(|| fallback_operator.clone());
        let actor_label = auth.actor_label_for(operator.clone())?;

        Ok(Self {
            auth,
            actor_label,
            fallback_operator: operator,
            legacy_operator_actor_policy: LegacyOperatorActorPolicy::AllowLocalSameUid,
        })
    }

    /// Identity for a local same-UID peer on a hosted-bridged room.
    ///
    /// The hosted room's actor-authorization check rejects any change whose
    /// actor principal differs from the authenticated cloud principal, so
    /// local peers on a bridged room must author under that principal — the
    /// local operator suffix carries the per-client attribution
    /// (`user:anaconda:<sub>/desktop:<session>`). Legacy operator-only actor
    /// labels are rejected: they would collapse into the daemon's identity on
    /// the cloud side.
    pub(crate) fn hosted_bridged(
        cloud_principal: &str,
        presented_operator: Option<String>,
        scope: ConnectionScope,
    ) -> anyhow::Result<Self> {
        let principal = nteract_identity::Principal::new(cloud_principal.to_string())?;
        let auth = AuthenticatedConnection::new(principal, scope);
        let fallback_operator = fallback_operator("desktop");
        let operator = presented_operator
            .as_deref()
            .and_then(|value| Operator::from_actor_label_or_operator(value).ok())
            .unwrap_or_else(|| fallback_operator.clone());
        let actor_label = auth.actor_label_for(operator.clone())?;

        Ok(Self {
            auth,
            actor_label,
            fallback_operator: operator,
            legacy_operator_actor_policy: LegacyOperatorActorPolicy::Reject,
        })
    }

    pub(crate) fn actor_label(&self) -> &ActorLabel {
        &self.actor_label
    }

    pub(crate) fn scope(&self) -> ConnectionScope {
        self.auth.scope()
    }

    pub(crate) fn rewrite_presence_actor_label(&self, presented: Option<&str>) -> ActorLabel {
        self.auth
            .rewrite_presence_actor_label(presented, self.fallback_operator.clone())
    }

    pub(crate) fn allows_notebook_write(&self) -> bool {
        self.scope().allows_notebook_write()
    }

    #[cfg(test)]
    pub(crate) fn allows_runtime_state_write(&self) -> bool {
        self.scope().allows_runtime_state_write()
    }

    pub(crate) fn validate_actor_labels<'a>(
        &self,
        labels: impl IntoIterator<Item = &'a str>,
    ) -> anyhow::Result<()> {
        for label in labels {
            self.validate_actor_label(label)?;
        }

        Ok(())
    }

    pub(crate) fn validate_notebook_change_actors<'a>(
        &self,
        changes: impl IntoIterator<Item = &'a ChangeActor>,
    ) -> anyhow::Result<()> {
        for change in changes {
            if notebook_doc::NotebookDoc::is_canonical_schema_seed_change(
                &change.actor_label,
                &change.hash,
            ) {
                continue;
            }
            self.validate_actor_label(&change.actor_label)?;
        }

        Ok(())
    }

    fn validate_actor_label(&self, label: &str) -> anyhow::Result<()> {
        match ActorLabel::parse(label.to_string()) {
            Ok(actor) if actor.principal() == self.auth.principal().as_str() => Ok(()),
            Ok(actor) => anyhow::bail!(
                "actor principal {} is not authorized for authenticated principal {}",
                actor.principal(),
                self.auth.principal()
            ),
            Err(nteract_identity::AuthError::ActorLabelMissingDelimiter)
                if self
                    .legacy_operator_actor_policy
                    .allows_operator_only(&self.auth)
                    && Operator::new(label.to_string()).is_ok() =>
            {
                Ok(())
            }
            Err(error) => anyhow::bail!("actor label {label:?} is invalid: {error}"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LegacyOperatorActorPolicy {
    // Used by future non-local constructors. Local is the only constructor
    // today, but remote providers must start from this strict policy.
    #[allow(dead_code)]
    Reject,
    /// Local rooms historically accepted operator-only labels from same-UID
    /// clients. Keep that compatibility local-only; remote auth providers must
    /// send fully layered actor labels.
    AllowLocalSameUid,
}

impl LegacyOperatorActorPolicy {
    fn allows_operator_only(self, auth: &AuthenticatedConnection) -> bool {
        match self {
            Self::Reject => false,
            Self::AllowLocalSameUid => {
                debug_assert!(
                    auth.principal().as_str().starts_with("local:"),
                    "legacy operator-only labels are only allowed for local same-UID rooms"
                );
                auth.principal().as_str().starts_with("local:")
            }
        }
    }
}

fn fallback_operator(kind: &str) -> Operator {
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let value = format!("{kind}:{}", &suffix[..8]);
    match Operator::new(value) {
        Ok(operator) => operator,
        Err(error) => panic!("generated fallback operator is invalid: {error}"),
    }
}

fn local_username() -> String {
    std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .ok()
        .and_then(|username| sanitize_local_username(&username))
        .unwrap_or_else(|| "unknown".to_string())
}

fn sanitize_local_username(username: &str) -> Option<String> {
    let trimmed = username.trim();
    if trimmed.is_empty() || trimmed.contains('/') {
        None
    } else {
        Some(trimmed.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn local_identity_preserves_presented_operator() {
        let identity = RoomConnectionIdentity::local(Some("agent:codex:s1".to_string()))
            .await
            .expect("local identity");

        assert!(identity.actor_label().as_str().contains("/agent:codex:s1"));
        assert_eq!(identity.scope(), ConnectionScope::Owner);
        assert!(identity.allows_notebook_write());
        assert!(!identity.allows_runtime_state_write());
    }

    #[tokio::test]
    async fn local_identity_can_be_downgraded_to_viewer() {
        let identity = RoomConnectionIdentity::local_with_scope(
            Some("desktop:window-1".to_string()),
            ConnectionScope::Viewer,
        )
        .await
        .expect("local viewer identity");

        assert_eq!(identity.scope(), ConnectionScope::Viewer);
        assert!(!identity.allows_notebook_write());
        assert!(!identity.allows_runtime_state_write());
        assert!(identity
            .actor_label()
            .as_str()
            .contains("/desktop:window-1"));
    }

    #[tokio::test]
    async fn local_identity_accepts_legacy_actor_as_operator() {
        let identity = RoomConnectionIdentity::local(Some("human:session-abc".to_string()))
            .await
            .expect("local identity");

        assert!(identity
            .actor_label()
            .as_str()
            .contains("/human:session-abc"));
    }

    #[tokio::test]
    async fn local_identity_rewrites_presence_principal() {
        let identity = RoomConnectionIdentity::local(Some("desktop:window-1".to_string()))
            .await
            .expect("local identity");

        let rewritten =
            identity.rewrite_presence_actor_label(Some("user:anaconda:other/agent:claude:s1"));

        assert!(rewritten.as_str().ends_with("/agent:claude:s1"));
        assert_eq!(rewritten.principal(), identity.actor_label().principal());
    }

    #[tokio::test]
    async fn local_identity_rejects_layered_actor_from_another_principal() {
        let identity = RoomConnectionIdentity::local(Some("desktop:window-1".to_string()))
            .await
            .expect("local identity");

        let error = identity
            .validate_actor_labels(["user:anaconda:evil/desktop:window-1"])
            .expect_err("wrong principal should be rejected");

        assert!(error.to_string().contains("not authorized"));
    }

    #[tokio::test]
    async fn local_identity_allows_legacy_operator_only_actor() {
        let identity = RoomConnectionIdentity::local(Some("desktop:window-1".to_string()))
            .await
            .expect("local identity");

        identity
            .validate_actor_labels(["human:legacy-session"])
            .expect("local same-UID rooms keep legacy operator labels working");
    }

    #[test]
    fn non_local_identity_rejects_legacy_operator_only_actor() {
        let principal =
            nteract_identity::Principal::new("user:anaconda:550e".to_string()).expect("principal");
        let operator = Operator::new("desktop:window-1".to_string()).expect("operator");
        let auth = AuthenticatedConnection::new(principal, ConnectionScope::Editor);
        let actor_label = auth.actor_label_for(operator.clone()).expect("actor label");
        let identity = RoomConnectionIdentity {
            auth,
            actor_label,
            fallback_operator: operator,
            legacy_operator_actor_policy: LegacyOperatorActorPolicy::Reject,
        };

        let error = identity
            .validate_actor_labels(["human:legacy-session"])
            .expect_err("remote rooms must reject legacy operator-only actors");

        assert!(error.to_string().contains("actor label"));
    }

    #[test]
    fn non_local_identity_allows_only_canonical_schema_seed_change() {
        let principal =
            nteract_identity::Principal::new("user:anaconda:550e".to_string()).expect("principal");
        let operator = Operator::new("desktop:window-1".to_string()).expect("operator");
        let auth = AuthenticatedConnection::new(principal, ConnectionScope::Editor);
        let actor_label = auth.actor_label_for(operator.clone()).expect("actor label");
        let identity = RoomConnectionIdentity {
            auth,
            actor_label,
            fallback_operator: operator,
            legacy_operator_actor_policy: LegacyOperatorActorPolicy::Reject,
        };
        let seed_hash = notebook_doc::NotebookDoc::canonical_schema_seed_change_hashes()
            .into_iter()
            .next()
            .expect("seed hash");

        identity
            .validate_notebook_change_actors(
                [ChangeActor {
                    actor_label: "nteract:notebook-schema:v5".to_string(),
                    hash: seed_hash,
                }]
                .iter(),
            )
            .expect("canonical schema seed change is allowed");

        let error = identity
            .validate_notebook_change_actors(
                [ChangeActor {
                    actor_label: "nteract:notebook-schema:v5".to_string(),
                    hash: automerge::ChangeHash([1; 32]),
                }]
                .iter(),
            )
            .expect_err("spoofed seed actor must be rejected");

        assert!(error.to_string().contains("actor label"));
    }

    #[test]
    fn sanitize_local_username_rejects_empty_and_slashes() {
        assert_eq!(sanitize_local_username(""), None);
        assert_eq!(sanitize_local_username("bad/user"), None);
        assert_eq!(sanitize_local_username(" kyle "), Some("kyle".to_string()));
    }
}
