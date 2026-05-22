use crate::{AuthError, AuthenticatedUser, Credential, Result};

/// JupyterHub identity provider placeholder.
///
/// The provider enum and feature gate land with the core crate so downstream
/// code can compile against the intended dispatch shape before Hub API
/// validation dependencies are introduced. Until that path lands, this
/// provider intentionally returns [`AuthError::ProviderUnavailable`].
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct JupyterHubProvider;

impl JupyterHubProvider {
    /// JupyterHub authentication is implemented in the provider follow-up.
    #[allow(clippy::manual_async_fn)]
    pub fn authenticate(
        &self,
        _presented: Credential,
    ) -> impl std::future::Future<Output = Result<AuthenticatedUser>> + Send + '_ {
        async move { Err(AuthError::ProviderUnavailable("jupyterhub")) }
    }
}
