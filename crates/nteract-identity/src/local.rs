use crate::{AuthError, AuthenticatedUser, ConnectionScope, Credential, Principal, Result};
use serde::{Deserialize, Deserializer, Serialize};

/// Peer credentials extracted by a trusted local listener.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LocalPeerCredential {
    username: String,
}

impl LocalPeerCredential {
    /// Creates a local peer credential for an OS user.
    pub fn new(username: impl Into<String>) -> Result<Self> {
        let username = username.into();
        if username.is_empty() {
            return Err(AuthError::EmptyLocalUsername);
        }
        if username.contains('/') {
            return Err(AuthError::LocalUsernameContainsSlash);
        }

        Ok(Self { username })
    }

    /// Returns the OS username supplied by the listener.
    pub fn username(&self) -> &str {
        &self.username
    }

    /// Maps the peer credential into the local identity space.
    pub fn principal(&self) -> Result<Principal> {
        Principal::new(format!("local:{}", self.username))
    }
}

impl<'de> Deserialize<'de> for LocalPeerCredential {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        struct WireLocalPeerCredential {
            username: String,
        }

        let wire = WireLocalPeerCredential::deserialize(deserializer)?;
        Self::new(wire.username).map_err(serde::de::Error::custom)
    }
}

/// Local identity provider backed by listener-verified peer credentials.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalProvider {
    default_scope: ConnectionScope,
    allowed_operator_kinds: Vec<String>,
}

impl Default for LocalProvider {
    fn default() -> Self {
        Self {
            default_scope: ConnectionScope::Owner,
            allowed_operator_kinds: Vec::new(),
        }
    }
}

impl LocalProvider {
    /// Creates a local provider with a custom default scope.
    pub fn new(default_scope: ConnectionScope) -> Self {
        Self {
            default_scope,
            allowed_operator_kinds: Vec::new(),
        }
    }

    /// Restricts the operator kinds accepted for local connections.
    pub fn with_allowed_operator_kinds(mut self, allowed_operator_kinds: Vec<String>) -> Self {
        self.allowed_operator_kinds = allowed_operator_kinds;
        self
    }

    /// Authenticates local peer credentials.
    #[allow(clippy::manual_async_fn)]
    pub fn authenticate(
        &self,
        presented: Credential,
    ) -> impl std::future::Future<Output = Result<AuthenticatedUser>> + Send + '_ {
        let default_scope = self.default_scope;
        let allowed_operator_kinds = self.allowed_operator_kinds.clone();

        async move {
            match presented {
                Credential::LocalPeer(peer) => Ok(AuthenticatedUser::with_allowed_operator_kinds(
                    peer.principal()?,
                    default_scope,
                    allowed_operator_kinds,
                )),
                _ => Err(AuthError::InvalidCredential(
                    "local provider requires local peer credentials",
                )),
            }
        }
    }
}
