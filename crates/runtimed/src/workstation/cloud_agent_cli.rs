//! Argument/environment → cloud-agent config mapping for the
//! `runtimed cloud-runtime-agent` subcommand.
//!
//! This module is the invocable entry for the workstation runtime peer: it
//! maps CLI flags plus environment variables to a [`CloudWsConfig`] +
//! [`CloudAuth`] that the subcommand hands to
//! [`run_cloud_runtime_agent`](crate::runtime_agent::run_cloud_runtime_agent).
//! The hosted connector (`apps/notebook-cloud/scripts/hosted-workstation-agent.mjs`)
//! spawns this subcommand per attach job; operators can also run it directly
//! (`docs/remote-workstation.md`).
//!
//! Security (ADR "Security constraints"): the credential is read from the
//! environment, never from argv, so it can't leak into a long-running process's
//! command line / `ps` output. The flags carry only non-secret routing
//! (URL, notebook id, scope, operator, auth *kind*).

use anyhow::{anyhow, Context, Result};
use notebook_cloud_transport::{CloudAuth, CloudWsConfig};

/// Environment variable carrying the cloud credential (never passed on argv).
pub const CLOUD_TOKEN_ENV: &str = "RUNT_CLOUD_TOKEN";
/// Optional dev-user label for the `dev` auth kind.
pub const CLOUD_DEV_USER_ENV: &str = "RUNT_CLOUD_DEV_USER";

/// How the runtime peer authenticates on the WebSocket upgrade. Mirrors
/// [`CloudAuth`]'s variants as a flag value, kept separate so the secret token
/// stays out of argv — only the *kind* is a flag.
#[derive(Debug, Clone, Copy, PartialEq, Eq, clap::ValueEnum)]
pub enum CloudAuthKind {
    /// OIDC / dev-validated bearer (`Authorization: Bearer`).
    #[value(name = "oidc")]
    Oidc,
    /// Anaconda API key (bearer + provider-selector header).
    #[value(name = "anaconda-key")]
    AnacondaKey,
    /// Workstation credential from the pairing flow (`nwc_` token; plain
    /// bearer on the wire).
    #[value(name = "workstation")]
    Workstation,
    /// Dev token (`X-Notebook-Cloud-Dev-Token`) + user label.
    #[value(name = "dev")]
    Dev,
}

/// Non-secret arguments for the `cloud-runtime-agent` subcommand. The token is
/// intentionally absent — it is read from [`CLOUD_TOKEN_ENV`].
#[derive(Debug, Clone)]
pub struct CloudAgentArgs {
    /// Base URL of the notebook cloud (https/http; scheme swapped to wss/ws).
    pub cloud_url: String,
    /// Notebook id; the room is `/n/<id>/sync`.
    pub notebook_id: String,
    /// Connection scope (`runtime_peer` for a workstation runtime).
    pub scope: String,
    /// Auth kind; the token itself comes from the environment.
    pub auth_kind: CloudAuthKind,
}

/// Resolve the credential from the environment and build the cloud config.
///
/// `env` is the lookup (injected so the mapping is testable without touching the
/// process environment); production passes `|k| std::env::var(k).ok()`.
///
/// Errors if the token env var is unset/empty, or if the `dev` kind is selected
/// without a [`CLOUD_DEV_USER_ENV`] label.
pub fn build_cloud_config(
    args: &CloudAgentArgs,
    env: impl Fn(&str) -> Option<String>,
) -> Result<CloudWsConfig> {
    let token = env(CLOUD_TOKEN_ENV)
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .with_context(|| {
            format!("cloud credential not found; set {CLOUD_TOKEN_ENV} (never passed on argv)")
        })?;

    let auth = match args.auth_kind {
        CloudAuthKind::Oidc => CloudAuth::OidcBearer { token },
        CloudAuthKind::AnacondaKey => CloudAuth::AnacondaApiKey { token },
        CloudAuthKind::Workstation => CloudAuth::WorkstationCredential { token },
        CloudAuthKind::Dev => {
            let user = env(CLOUD_DEV_USER_ENV)
                .map(|u| u.trim().to_string())
                .filter(|u| !u.is_empty())
                .ok_or_else(|| {
                    anyhow!("dev auth requires a user label; set {CLOUD_DEV_USER_ENV}")
                })?;
            CloudAuth::Dev { token, user }
        }
    };

    Ok(CloudWsConfig {
        cloud_url: args.cloud_url.clone(),
        notebook_id: args.notebook_id.clone(),
        scope: args.scope.clone(),
        auth,
        workstation: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn args(kind: CloudAuthKind) -> CloudAgentArgs {
        CloudAgentArgs {
            cloud_url: "https://preview.runt.run".into(),
            notebook_id: "nb-123".into(),
            scope: "runtime_peer".into(),
            auth_kind: kind,
        }
    }

    fn env_from(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        move |k: &str| map.get(k).cloned()
    }

    #[test]
    fn oidc_kind_builds_oidc_bearer_with_env_token() {
        let cfg = build_cloud_config(
            &args(CloudAuthKind::Oidc),
            env_from(&[(CLOUD_TOKEN_ENV, "tok-oidc")]),
        )
        .expect("build");
        assert_eq!(cfg.notebook_id, "nb-123");
        assert_eq!(cfg.scope, "runtime_peer");
        assert!(matches!(
            cfg.auth,
            CloudAuth::OidcBearer { token } if token == "tok-oidc"
        ));
    }

    #[test]
    fn anaconda_kind_builds_api_key_auth() {
        let cfg = build_cloud_config(
            &args(CloudAuthKind::AnacondaKey),
            env_from(&[(CLOUD_TOKEN_ENV, "tok-key")]),
        )
        .expect("build");
        assert!(matches!(
            cfg.auth,
            CloudAuth::AnacondaApiKey { token } if token == "tok-key"
        ));
    }

    #[test]
    fn workstation_kind_builds_workstation_credential_auth() {
        let cfg = build_cloud_config(
            &args(CloudAuthKind::Workstation),
            env_from(&[(CLOUD_TOKEN_ENV, "nwc_tok")]),
        )
        .expect("build");
        assert!(matches!(
            cfg.auth,
            CloudAuth::WorkstationCredential { token } if token == "nwc_tok"
        ));
    }

    #[test]
    fn dev_kind_requires_user_label() {
        // With the user label: builds a Dev auth.
        let cfg = build_cloud_config(
            &args(CloudAuthKind::Dev),
            env_from(&[(CLOUD_TOKEN_ENV, "tok-dev"), (CLOUD_DEV_USER_ENV, "alice")]),
        )
        .expect("build");
        assert!(matches!(
            cfg.auth,
            CloudAuth::Dev { token, user } if token == "tok-dev" && user == "alice"
        ));

        // Without it: a clear error rather than a bogus actor downstream.
        let err = build_cloud_config(
            &args(CloudAuthKind::Dev),
            env_from(&[(CLOUD_TOKEN_ENV, "tok-dev")]),
        )
        .expect_err("must require user");
        assert!(err.to_string().contains(CLOUD_DEV_USER_ENV));
    }

    #[test]
    fn missing_token_is_an_error_naming_the_env_var() {
        let err = build_cloud_config(&args(CloudAuthKind::Oidc), env_from(&[]))
            .expect_err("must require token");
        assert!(err.to_string().contains(CLOUD_TOKEN_ENV));
    }

    #[test]
    fn blank_or_whitespace_token_is_rejected() {
        let err = build_cloud_config(
            &args(CloudAuthKind::Oidc),
            env_from(&[(CLOUD_TOKEN_ENV, "   ")]),
        )
        .expect_err("whitespace token must be rejected");
        assert!(err.to_string().contains(CLOUD_TOKEN_ENV));
    }

    #[test]
    fn token_is_trimmed() {
        let cfg = build_cloud_config(
            &args(CloudAuthKind::Oidc),
            env_from(&[(CLOUD_TOKEN_ENV, "  tok-trim\n")]),
        )
        .expect("build");
        assert!(matches!(
            cfg.auth,
            CloudAuth::OidcBearer { token } if token == "tok-trim"
        ));
    }
}
