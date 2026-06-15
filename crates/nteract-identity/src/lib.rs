//! Identity primitives for nteract notebook rooms.
//!
//! The crate keeps the security-critical parsing rules close to the provider
//! dispatch types that room hosts will use at connection time. The
//! JupyterHub provider surface is feature-gated and currently returns
//! [`AuthError::ProviderUnavailable`] until the Hub API validation path lands.

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::fmt;
use std::str::FromStr;

#[cfg(feature = "jupyterhub")]
mod jupyterhub;
mod local;
#[cfg(feature = "oidc")]
mod oidc;

#[cfg(feature = "jupyterhub")]
pub use jupyterhub::JupyterHubProvider;
pub use local::{LocalPeerCredential, LocalProvider};
#[cfg(feature = "oidc")]
pub use oidc::{OidcProvider, OidcProviderConfig};

/// Result alias for identity and authentication operations.
pub type Result<T> = std::result::Result<T, AuthError>;

/// Errors raised while parsing labels or authenticating a connection.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum AuthError {
    #[error("principal cannot be empty")]
    EmptyPrincipal,
    #[error("principal cannot contain '/'")]
    PrincipalContainsSlash,
    #[error("principal must be 'system' or '<scheme>:<id>'")]
    PrincipalMissingScheme,
    #[error("principal scheme cannot be empty")]
    PrincipalEmptyScheme,
    #[error("principal id cannot be empty")]
    PrincipalEmptyId,
    #[error("operator cannot be empty")]
    EmptyOperator,
    #[error("operator kind cannot be empty")]
    EmptyOperatorKind,
    #[error("operator cannot contain '/'")]
    OperatorContainsSlash,
    #[error("actor label must be '<principal>/<operator>'")]
    ActorLabelMissingDelimiter,
    #[error("local username cannot be empty")]
    EmptyLocalUsername,
    #[error("local username cannot contain '/'")]
    LocalUsernameContainsSlash,
    #[error("invalid credential: {0}")]
    InvalidCredential(&'static str),
    #[error("identity provider is unavailable: {0}")]
    ProviderUnavailable(&'static str),
    #[error("unknown connection scope: {0}")]
    UnknownConnectionScope(String),
    #[error("invalid OIDC configuration: {0}")]
    InvalidOidcConfig(&'static str),
    #[error("invalid OIDC JWKS: {0}")]
    InvalidOidcJwks(String),
    #[error("OIDC token rejected: {0}")]
    OidcTokenRejected(String),
    #[error("OIDC signing key not found for kid {kid:?}")]
    OidcKeyNotFound { kid: Option<String> },
    #[error("OIDC algorithm is not allowed: {algorithm}")]
    OidcAlgorithmNotAllowed { algorithm: String },
    #[error("operator kind '{kind}' is not allowed for this connection")]
    OperatorKindNotAllowed { kind: String },
}

/// Authenticated entity for a room.
///
/// Principals are room-local identity names, not process-local identity names.
/// They must either be the seed principal `system` or follow `<scheme>:<id>`.
/// The literal `system` principal is reserved; `system:*` values are ordinary
/// scheme principals and do not receive the seed-author exemption.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Principal(String);

impl Principal {
    /// Principal reserved for system seed changes.
    pub const SYSTEM: &'static str = "system";

    /// Creates a validated principal.
    pub fn new(value: impl Into<String>) -> Result<Self> {
        let value = value.into();
        if value.is_empty() {
            return Err(AuthError::EmptyPrincipal);
        }
        if value.contains('/') {
            return Err(AuthError::PrincipalContainsSlash);
        }
        if value == Self::SYSTEM {
            return Ok(Self(value));
        }

        let Some((scheme, id)) = value.split_once(':') else {
            return Err(AuthError::PrincipalMissingScheme);
        };
        if scheme.is_empty() {
            return Err(AuthError::PrincipalEmptyScheme);
        }
        if id.is_empty() {
            return Err(AuthError::PrincipalEmptyId);
        }

        Ok(Self(value))
    }

    /// Returns the underlying principal string.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for Principal {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl FromStr for Principal {
    type Err = AuthError;

    fn from_str(value: &str) -> Result<Self> {
        Self::new(value.to_owned())
    }
}

impl TryFrom<String> for Principal {
    type Error = AuthError;

    fn try_from(value: String) -> Result<Self> {
        Self::new(value)
    }
}

impl Serialize for Principal {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for Principal {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::new(value).map_err(serde::de::Error::custom)
    }
}

/// Self-declared operator acting on behalf of a principal.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Operator(String);

impl Operator {
    /// Creates a validated operator suffix.
    pub fn new(value: impl Into<String>) -> Result<Self> {
        let value = value.into();
        if value.is_empty() {
            return Err(AuthError::EmptyOperator);
        }
        if value.contains('/') {
            return Err(AuthError::OperatorContainsSlash);
        }
        if value.starts_with(':') {
            return Err(AuthError::EmptyOperatorKind);
        }
        Ok(Self(value))
    }

    /// Returns the underlying operator string.
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Returns the operator kind before the first colon.
    pub fn kind(&self) -> &str {
        match self.0.split_once(':') {
            Some((kind, _)) => kind,
            None => self.as_str(),
        }
    }

    /// Extracts an operator from either a full actor label or a legacy
    /// operator-only label.
    ///
    /// Current room hosts emit `<principal>/<operator>`, but existing local
    /// clients may still present values such as `human:session`. Treating a
    /// valid operator-only value as the suffix keeps those clients attributed
    /// under the authenticated principal instead of falling back to an
    /// anonymous connection operator.
    pub fn from_actor_label_or_operator(value: &str) -> Result<Self> {
        match ActorLabel::parse(value.to_owned()) {
            Ok(label) => label.operator_value(),
            Err(AuthError::ActorLabelMissingDelimiter) => Self::new(value.to_owned()),
            Err(error) => Err(error),
        }
    }
}

impl fmt::Display for Operator {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl FromStr for Operator {
    type Err = AuthError;

    fn from_str(value: &str) -> Result<Self> {
        Self::new(value.to_owned())
    }
}

impl TryFrom<String> for Operator {
    type Error = AuthError;

    fn try_from(value: String) -> Result<Self> {
        Self::new(value)
    }
}

impl Serialize for Operator {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for Operator {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::new(value).map_err(serde::de::Error::custom)
    }
}

/// Full Automerge actor label, formatted as `<principal>/<operator>`.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ActorLabel {
    value: String,
    delimiter_index: usize,
}

impl ActorLabel {
    /// Creates a label from already-validated parts.
    pub fn new(principal: Principal, operator: Operator) -> Self {
        let delimiter_index = principal.as_str().len();
        let value = format!("{principal}/{operator}");
        Self {
            value,
            delimiter_index,
        }
    }

    /// Parses and validates an actor label.
    pub fn parse(value: impl Into<String>) -> Result<Self> {
        let value = value.into();
        let Some(delimiter_index) = value.find('/') else {
            return Err(AuthError::ActorLabelMissingDelimiter);
        };

        Principal::new(value[..delimiter_index].to_owned())?;
        Operator::new(value[delimiter_index + 1..].to_owned())?;

        Ok(Self {
            value,
            delimiter_index,
        })
    }

    /// Returns the full actor label string.
    pub fn as_str(&self) -> &str {
        &self.value
    }

    /// Returns the principal prefix.
    pub fn principal(&self) -> &str {
        &self.value[..self.delimiter_index]
    }

    /// Returns the operator suffix.
    pub fn operator(&self) -> &str {
        &self.value[self.delimiter_index + 1..]
    }

    /// Returns a parsed copy of the principal prefix.
    pub fn principal_value(&self) -> Result<Principal> {
        Principal::new(self.principal().to_owned())
    }

    /// Returns a parsed copy of the operator suffix.
    pub fn operator_value(&self) -> Result<Operator> {
        Operator::new(self.operator().to_owned())
    }

    /// Returns the same operator under a different authenticated principal.
    pub fn with_principal(&self, principal: Principal) -> Result<Self> {
        let operator = self.operator_value()?;
        Ok(Self::new(principal, operator))
    }
}

impl fmt::Display for ActorLabel {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl FromStr for ActorLabel {
    type Err = AuthError;

    fn from_str(value: &str) -> Result<Self> {
        Self::parse(value.to_owned())
    }
}

impl TryFrom<String> for ActorLabel {
    type Error = AuthError;

    fn try_from(value: String) -> Result<Self> {
        Self::parse(value)
    }
}

impl Serialize for ActorLabel {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for ActorLabel {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::parse(value).map_err(serde::de::Error::custom)
    }
}

/// Server-side connection scope assigned by an identity provider.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionScope {
    Viewer,
    Editor,
    RuntimePeer,
    Owner,
}

impl ConnectionScope {
    /// Every scope, in privilege order. The TypeScript mirror in
    /// `packages/runtimed/src/scope-capabilities.ts` is generated from this
    /// list (see `notebook-protocol/src/typescript.rs`); both hosts must see
    /// the same lattice.
    pub const ALL: [Self; 4] = [Self::Viewer, Self::Editor, Self::RuntimePeer, Self::Owner];

    /// Stable lowercase scope name.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Viewer => "viewer",
            Self::Editor => "editor",
            Self::RuntimePeer => "runtime_peer",
            Self::Owner => "owner",
        }
    }

    /// Whether this scope can send NotebookDoc frames.
    pub const fn allows_notebook_write(self) -> bool {
        matches!(self, Self::Editor | Self::Owner)
    }

    /// Whether this scope can send RuntimeStateDoc frames.
    pub const fn allows_runtime_state_write(self) -> bool {
        matches!(self, Self::RuntimePeer)
    }

    /// Whether this scope can upload blobs (`PUT_BLOB` frames and the
    /// multipart Create/Complete/Abort requests) on a **hosted** room.
    ///
    /// Editors stay excluded until server-side reference-path validation
    /// lands; the two ship together (`hosted-room-authorization.md`
    /// Decision 3, punchlist HCA-3).
    pub const fn allows_blob_upload(self) -> bool {
        matches!(self, Self::RuntimePeer | Self::Owner)
    }

    /// Whether this scope can upload blobs on a **local daemon** connection.
    ///
    /// Differs from [`Self::allows_blob_upload`] by allowing editors: local
    /// same-UID editor peers upload document-scoped attachments today, and the
    /// hosted editor exclusion exists only until reference-path validation
    /// lands (HCA-3). Viewers are denied on both topologies (punchlist BS-12).
    /// When HCA-3 stage 2 ships, hosted converges on this predicate and the
    /// two collapse into one.
    pub const fn allows_local_blob_upload(self) -> bool {
        !matches!(self, Self::Viewer)
    }

    /// Whether this scope can submit execution requests (ExecuteCell,
    /// RunAllCells, kernel lifecycle). Owner-only until an explicit execute
    /// capability exists (`hosted-room-authorization.md` Decision 3 /
    /// punchlist HCA-7): editing a notebook must not imply spending compute.
    pub const fn allows_execution_request(self) -> bool {
        matches!(self, Self::Owner)
    }

    /// Whether this scope can publish revisions.
    pub const fn allows_publish(self) -> bool {
        matches!(self, Self::Owner)
    }

    /// Whether this scope can manage ACLs.
    pub const fn allows_acl_mutation(self) -> bool {
        matches!(self, Self::Owner)
    }
}

impl fmt::Display for ConnectionScope {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl FromStr for ConnectionScope {
    type Err = AuthError;

    fn from_str(value: &str) -> Result<Self> {
        match value {
            "viewer" => Ok(Self::Viewer),
            "editor" => Ok(Self::Editor),
            "runtime_peer" => Ok(Self::RuntimePeer),
            "owner" => Ok(Self::Owner),
            _ => Err(AuthError::UnknownConnectionScope(value.to_owned())),
        }
    }
}

/// Normalized credential presented to a server-side provider.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "snake_case")]
pub enum Credential {
    BearerToken(String),
    Cookie(String),
    OneTimeTicket(String),
    LocalPeer(LocalPeerCredential),
}

/// Authenticated room user returned by an identity provider.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuthenticatedUser {
    principal: Principal,
    scope: ConnectionScope,
    allowed_operator_kinds: Vec<String>,
}

impl AuthenticatedUser {
    /// Creates an authenticated user with no operator-kind restriction.
    pub fn new(principal: Principal, scope: ConnectionScope) -> Self {
        Self {
            principal,
            scope,
            allowed_operator_kinds: Vec::new(),
        }
    }

    /// Creates an authenticated user with explicit operator-kind restrictions.
    pub fn with_allowed_operator_kinds(
        principal: Principal,
        scope: ConnectionScope,
        allowed_operator_kinds: Vec<String>,
    ) -> Self {
        Self {
            principal,
            scope,
            allowed_operator_kinds,
        }
    }

    /// Authenticated principal in the room's identity space.
    pub fn principal(&self) -> &Principal {
        &self.principal
    }

    /// Server-enforced connection scope.
    pub const fn scope(&self) -> ConnectionScope {
        self.scope
    }

    /// Allowed operator kinds. Empty means unrestricted.
    pub fn allowed_operator_kinds(&self) -> &[String] {
        &self.allowed_operator_kinds
    }
}

/// In-memory identity state attached to an authenticated connection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuthenticatedConnection {
    principal: Principal,
    scope: ConnectionScope,
    allowed_operator_kinds: Vec<String>,
}

impl AuthenticatedConnection {
    /// Creates a connection identity from an authenticated provider result.
    pub fn new(principal: Principal, scope: ConnectionScope) -> Self {
        Self::from_user(AuthenticatedUser::new(principal, scope))
    }

    /// Creates a connection identity from an authenticated provider result.
    pub fn from_user(user: AuthenticatedUser) -> Self {
        Self {
            principal: user.principal,
            scope: user.scope,
            allowed_operator_kinds: user.allowed_operator_kinds,
        }
    }

    /// Authenticated principal in the room's identity space.
    pub fn principal(&self) -> &Principal {
        &self.principal
    }

    /// Server-enforced connection scope.
    pub const fn scope(&self) -> ConnectionScope {
        self.scope
    }

    /// Allowed operator kinds. Empty means unrestricted.
    pub fn allowed_operator_kinds(&self) -> &[String] {
        &self.allowed_operator_kinds
    }

    /// Whether the supplied operator is allowed for this connection.
    pub fn permits_operator(&self, operator: &Operator) -> bool {
        self.allowed_operator_kinds.is_empty()
            || self
                .allowed_operator_kinds
                .iter()
                .any(|allowed| allowed == operator.kind())
    }

    /// Constructs an actor label under this connection's authenticated principal.
    pub fn actor_label_for(&self, operator: Operator) -> Result<ActorLabel> {
        if !self.permits_operator(&operator) {
            return Err(AuthError::OperatorKindNotAllowed {
                kind: operator.kind().to_owned(),
            });
        }
        Ok(ActorLabel::new(self.principal.clone(), operator))
    }

    /// Rewrites a presented presence actor label to this connection's principal.
    ///
    /// The operator suffix is preserved when the presented label is valid. If
    /// the label is absent or malformed, the caller-provided fallback operator
    /// is used instead. Presence ingress is deliberately non-rejecting; use
    /// [`Self::actor_label_for`] when constructing a handshake actor label that
    /// must honor operator-kind restrictions.
    pub fn rewrite_presence_actor_label(
        &self,
        presented: Option<&str>,
        fallback_operator: Operator,
    ) -> ActorLabel {
        let operator = presented
            .and_then(|label| Operator::from_actor_label_or_operator(label).ok())
            .unwrap_or(fallback_operator);

        ActorLabel::new(self.principal.clone(), operator)
    }
}

/// Closed provider dispatch for server-side authentication.
#[derive(Debug, Clone)]
pub enum IdentityProvider {
    Local(LocalProvider),
    #[cfg(feature = "oidc")]
    Oidc(OidcProvider),
    #[cfg(feature = "jupyterhub")]
    JupyterHub(JupyterHubProvider),
}

impl IdentityProvider {
    /// Creates a local peer-credential provider.
    pub fn local() -> Self {
        Self::Local(LocalProvider::default())
    }

    /// Authenticates a normalized credential using the selected provider.
    #[allow(clippy::manual_async_fn)]
    pub fn authenticate(
        &self,
        presented: Credential,
    ) -> impl std::future::Future<Output = Result<AuthenticatedUser>> + Send + '_ {
        async move {
            match self {
                Self::Local(provider) => provider.authenticate(presented).await,
                #[cfg(feature = "oidc")]
                Self::Oidc(provider) => provider.authenticate(presented).await,
                #[cfg(feature = "jupyterhub")]
                Self::JupyterHub(provider) => provider.authenticate(presented).await,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures::executor::block_on;

    fn principal(value: &str) -> Principal {
        match Principal::new(value.to_owned()) {
            Ok(principal) => principal,
            Err(error) => panic!("principal should parse: {error}"),
        }
    }

    fn operator(value: &str) -> Operator {
        match Operator::new(value.to_owned()) {
            Ok(operator) => operator,
            Err(error) => panic!("operator should parse: {error}"),
        }
    }

    fn actor_label(value: &str) -> ActorLabel {
        match ActorLabel::parse(value.to_owned()) {
            Ok(label) => label,
            Err(error) => panic!("actor label should parse: {error}"),
        }
    }

    fn auth_user(result: Result<AuthenticatedUser>) -> AuthenticatedUser {
        match result {
            Ok(user) => user,
            Err(error) => panic!("authentication should pass: {error}"),
        }
    }

    fn actor_result(result: Result<ActorLabel>) -> ActorLabel {
        match result {
            Ok(label) => label,
            Err(error) => panic!("actor label should be constructed: {error}"),
        }
    }

    #[test]
    fn validates_principal_shape() {
        for value in [
            "system",
            "system:anonymous",
            "local:kylekelley",
            "user:anaconda:550e8400-e29b-41d4-a716-446655440000",
            "hub:hub.example.com:alice",
        ] {
            assert!(Principal::new(value.to_owned()).is_ok(), "{value}");
        }

        for value in ["", "local", "local:", ":alice", "local/foo"] {
            assert!(Principal::new(value.to_owned()).is_err(), "{value}");
        }
    }

    #[test]
    fn validates_operator_shape() {
        for value in ["desktop:7f3a", "agent:codex:s2", "runtime:py-3.12-s4"] {
            assert!(Operator::new(value.to_owned()).is_ok(), "{value}");
        }

        for value in ["", ":claude:s1", "agent/claude:s1"] {
            assert!(Operator::new(value.to_owned()).is_err(), "{value}");
        }
    }

    #[test]
    fn parses_actor_label_layers() {
        let label = actor_label("user:anaconda:550e/agent:codex:s2");
        assert_eq!(label.as_str(), "user:anaconda:550e/agent:codex:s2");
        assert_eq!(label.principal(), "user:anaconda:550e");
        assert_eq!(label.operator(), "agent:codex:s2");
    }

    #[test]
    fn rejects_malformed_actor_labels() {
        for value in [
            "local:kylekelley",
            "local:kylekelley/",
            "/desktop:7f3a",
            "local:kylekelley/agent/codex:s2",
        ] {
            assert!(ActorLabel::parse(value.to_owned()).is_err(), "{value}");
        }
    }

    #[test]
    fn rewrites_actor_label_principal() {
        let label = actor_label("local:kylekelley/agent:claude:s1");
        let rewritten = actor_result(label.with_principal(principal("user:anaconda:550e")));

        assert_eq!(rewritten.as_str(), "user:anaconda:550e/agent:claude:s1");
    }

    #[test]
    fn connection_rewrite_preserves_presented_operator() {
        let connection =
            AuthenticatedConnection::new(principal("user:anaconda:550e"), ConnectionScope::Editor);

        let rewritten = connection.rewrite_presence_actor_label(
            Some("local:kylekelley/agent:claude:s1"),
            operator("unknown:connection-1"),
        );

        assert_eq!(rewritten.as_str(), "user:anaconda:550e/agent:claude:s1");
    }

    #[test]
    fn connection_rewrite_uses_fallback_for_malformed_label() {
        let connection =
            AuthenticatedConnection::new(principal("user:anaconda:550e"), ConnectionScope::Editor);

        let rewritten = connection
            .rewrite_presence_actor_label(Some("bad/operator"), operator("unknown:connection-1"));

        assert_eq!(
            rewritten.as_str(),
            "user:anaconda:550e/unknown:connection-1"
        );
    }

    #[test]
    fn connection_rewrite_preserves_legacy_operator_only_label() {
        let connection =
            AuthenticatedConnection::new(principal("local:kylekelley"), ConnectionScope::Owner);

        let rewritten = connection.rewrite_presence_actor_label(
            Some("human:session-abc"),
            operator("unknown:connection-1"),
        );

        assert_eq!(rewritten.as_str(), "local:kylekelley/human:session-abc");
    }

    #[test]
    fn operator_kind_restrictions_are_enforced() {
        let user = AuthenticatedUser::with_allowed_operator_kinds(
            principal("user:anaconda:550e"),
            ConnectionScope::Editor,
            vec!["agent".to_owned()],
        );
        let connection = AuthenticatedConnection::from_user(user);

        assert!(connection
            .actor_label_for(operator("agent:codex:s2"))
            .is_ok());
        assert_eq!(
            connection.actor_label_for(operator("desktop:7f3a")),
            Err(AuthError::OperatorKindNotAllowed {
                kind: "desktop".to_owned()
            })
        );
    }

    #[test]
    fn scopes_expose_frame_permissions() {
        assert!(!ConnectionScope::Viewer.allows_notebook_write());
        assert!(!ConnectionScope::Viewer.allows_runtime_state_write());

        assert!(ConnectionScope::Editor.allows_notebook_write());
        assert!(!ConnectionScope::Editor.allows_runtime_state_write());
        assert!(!ConnectionScope::Editor.allows_publish());

        assert!(!ConnectionScope::RuntimePeer.allows_notebook_write());
        assert!(ConnectionScope::RuntimePeer.allows_runtime_state_write());

        assert!(ConnectionScope::Owner.allows_notebook_write());
        assert!(!ConnectionScope::Owner.allows_runtime_state_write());
        assert!(ConnectionScope::Owner.allows_publish());
        assert!(ConnectionScope::Owner.allows_acl_mutation());
    }

    #[test]
    fn scope_strings_are_stable() {
        assert_eq!(ConnectionScope::Viewer.to_string(), "viewer");
        assert_eq!(
            ConnectionScope::from_str("runtime_peer"),
            Ok(ConnectionScope::RuntimePeer)
        );
        assert!(ConnectionScope::from_str("runtime-peer").is_err());
    }

    #[test]
    fn serde_revalidates_string_newtypes() {
        let parsed = match serde_json::from_str::<ActorLabel>("\"local:kyle/desktop:7f3a\"") {
            Ok(label) => label,
            Err(error) => panic!("valid actor label should deserialize: {error}"),
        };
        assert_eq!(parsed.principal(), "local:kyle");
        assert_eq!(parsed.operator(), "desktop:7f3a");

        let invalid = serde_json::from_str::<ActorLabel>("\"local:kyle\"");
        assert!(invalid.is_err());
    }

    #[test]
    fn local_provider_maps_peer_credentials_to_owner() {
        let provider = IdentityProvider::local();
        let credential = Credential::LocalPeer(match LocalPeerCredential::new("kylekelley") {
            Ok(credential) => credential,
            Err(error) => panic!("local peer credential should parse: {error}"),
        });
        let user = auth_user(block_on(provider.authenticate(credential)));

        assert_eq!(user.principal().as_str(), "local:kylekelley");
        assert_eq!(user.scope(), ConnectionScope::Owner);
        assert!(user.allowed_operator_kinds().is_empty());
    }

    #[test]
    fn local_provider_rejects_remote_credentials() {
        let provider = IdentityProvider::local();
        let result = block_on(provider.authenticate(Credential::BearerToken("token".to_owned())));

        assert_eq!(
            result,
            Err(AuthError::InvalidCredential(
                "local provider requires local peer credentials"
            ))
        );
    }

    #[test]
    fn local_peer_credentials_reject_bad_usernames() {
        assert_eq!(
            LocalPeerCredential::new(""),
            Err(AuthError::EmptyLocalUsername)
        );
        assert_eq!(
            LocalPeerCredential::new("bad/user"),
            Err(AuthError::LocalUsernameContainsSlash)
        );
    }

    #[test]
    fn local_peer_credential_deserialization_revalidates_username() {
        let invalid = serde_json::from_str::<LocalPeerCredential>(r#"{"username":"bad/user"}"#);

        assert!(invalid.is_err());
    }
}
