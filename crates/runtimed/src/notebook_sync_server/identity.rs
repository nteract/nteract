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
    allow_legacy_operator_actor_labels: bool,
}

impl RoomConnectionIdentity {
    /// Authenticate a local same-UID daemon connection.
    pub(crate) async fn local(presented_operator: Option<String>) -> anyhow::Result<Self> {
        let username = local_username();
        let provider = IdentityProvider::local();
        let credential = Credential::LocalPeer(LocalPeerCredential::new(username)?);
        let user = provider.authenticate(credential).await?;
        let auth = AuthenticatedConnection::from_user(user);
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
            allow_legacy_operator_actor_labels: true,
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

    pub(crate) fn allows_runtime_state_write(&self) -> bool {
        self.scope().allows_runtime_state_write()
    }

    pub(crate) fn validate_actor_labels<'a>(
        &self,
        labels: impl IntoIterator<Item = &'a str>,
    ) -> anyhow::Result<()> {
        for label in labels {
            match ActorLabel::parse(label.to_string()) {
                Ok(actor) if actor.principal() == nteract_identity::Principal::SYSTEM => {}
                Ok(actor) if actor.principal() == self.auth.principal().as_str() => {}
                Ok(actor) => anyhow::bail!(
                    "actor principal {} is not authorized for authenticated principal {}",
                    actor.principal(),
                    self.auth.principal()
                ),
                Err(nteract_identity::AuthError::ActorLabelMissingDelimiter)
                    if self.allow_legacy_operator_actor_labels
                        && Operator::new(label.to_string()).is_ok() => {}
                Err(error) => anyhow::bail!("actor label {label:?} is invalid: {error}"),
            }
        }

        Ok(())
    }
}

fn fallback_operator(kind: &str) -> Operator {
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let value = format!("{kind}:{}", &suffix[..8]);
    Operator::new(value).expect("generated fallback operator is valid")
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
        assert!(identity.allows_runtime_state_write());
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
    fn sanitize_local_username_rejects_empty_and_slashes() {
        assert_eq!(sanitize_local_username(""), None);
        assert_eq!(sanitize_local_username("bad/user"), None);
        assert_eq!(sanitize_local_username(" kyle "), Some("kyle".to_string()));
    }
}
