//! Machine-local cloud domain registry.
//!
//! Maps hosted nteract origins (e.g. `https://preview.runt.run`) to credential
//! references and a default operator, per
//! `docs/adr/cloud-connected-local-mcp.md` Decision 2. The registry stores
//! routing metadata and credential *references* only; secret values are
//! resolved at connect time from their referenced environment variables.
//!
//! Shared by every local process that dials hosted rooms with its own
//! credential: `runt mcp` hosted sessions and the daemon's hosted-room bridge
//! read the same file, so one machine has one hosted-domain configuration.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use url::Url;

use crate::CloudAuth;

/// Generic override for the registry file location.
pub const REGISTRY_ENV_VAR: &str = "NTERACT_CLOUD_REGISTRY";
/// Historical override honored for compatibility with existing MCP setups.
pub const LEGACY_REGISTRY_ENV_VAR: &str = "NTERACT_MCP_CLOUD_REGISTRY";

#[derive(Debug, Clone, Deserialize)]
pub struct CloudRegistry {
    #[serde(default)]
    pub default_domain: Option<String>,
    #[serde(default)]
    pub domains: Vec<CloudDomainConfig>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CloudDomainConfig {
    #[serde(alias = "domain", alias = "url")]
    pub base_url: String,
    #[serde(default)]
    pub operator: Option<String>,
    pub credential: CredentialRef,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum CredentialRef {
    #[serde(alias = "bearer-env")]
    OidcBearerEnv {
        env: String,
    },
    AnacondaApiKeyEnv {
        env: String,
    },
    WorkstationCredentialEnv {
        env: String,
    },
    DevTokenEnv {
        env: String,
        user: String,
    },
}

impl CloudRegistry {
    pub fn load_default() -> Result<Option<Self>, String> {
        let path = registry_path();
        Self::load_from_path(&path)
    }

    pub fn load_from_path(path: &Path) -> Result<Option<Self>, String> {
        if !path.exists() {
            return Ok(None);
        }
        let contents = std::fs::read_to_string(path)
            .map_err(|e| format!("Failed to read cloud registry {}: {e}", path.display()))?;
        let registry: Self = toml::from_str(&contents)
            .map_err(|e| format!("Failed to parse cloud registry {}: {e}", path.display()))?;
        registry.validate()?;
        Ok(Some(registry))
    }

    pub fn validate(&self) -> Result<(), String> {
        let mut seen = HashSet::new();
        for domain in &self.domains {
            let normalized = normalize_domain(&domain.base_url)?;
            if !seen.insert(normalized.clone()) {
                return Err(format!("Duplicate cloud domain in registry: {normalized}"));
            }
        }
        if let Some(default_domain) = self.default_domain.as_deref() {
            let normalized_default = normalize_domain(default_domain)?;
            if !seen.contains(&normalized_default) {
                return Err(format!(
                    "default_domain {normalized_default} is not present in [[domains]]"
                ));
            }
        }
        Ok(())
    }

    pub fn default_domain(&self) -> Result<Option<String>, String> {
        self.default_domain
            .as_deref()
            .map(normalize_domain)
            .transpose()
    }

    pub fn domain(&self, domain: &str) -> Result<Option<ResolvedCloudDomain>, String> {
        let normalized = normalize_domain(domain)?;
        for config in &self.domains {
            if normalize_domain(&config.base_url)? == normalized {
                return Ok(Some(ResolvedCloudDomain {
                    base_url: normalized,
                    operator: config.operator.clone(),
                    credential: config.credential.clone(),
                    auth_override: None,
                }));
            }
        }
        Ok(None)
    }
}

#[derive(Debug, Clone)]
pub struct ResolvedCloudDomain {
    pub base_url: String,
    pub operator: Option<String>,
    credential: CredentialRef,
    /// Bypass env-var resolution with a fixed credential. Test seam only —
    /// production paths always resolve through [`CredentialRef`].
    auth_override: Option<CloudAuth>,
}

impl ResolvedCloudDomain {
    /// Construct a domain with a fixed credential, bypassing env resolution.
    /// For tests and in-process fakes.
    #[doc(hidden)]
    pub fn with_auth_override(
        base_url: impl Into<String>,
        operator: Option<String>,
        auth: CloudAuth,
    ) -> Self {
        Self {
            base_url: base_url.into(),
            operator,
            credential: CredentialRef::OidcBearerEnv {
                env: "NTERACT_UNUSED_AUTH_OVERRIDE".to_string(),
            },
            auth_override: Some(auth),
        }
    }

    pub fn resolve_auth(&self) -> Result<CloudAuth, String> {
        if let Some(auth) = self.auth_override.clone() {
            return Ok(auth);
        }
        self.credential.resolve()
    }

    /// Assemble the doc actor label for `principal`, using the configured
    /// operator (or `fallback_operator`) plus a fresh nonce. Automerge actors
    /// cannot be reused concurrently by independent document instances, so
    /// every live connection mints a new nonce.
    pub fn actor_label(&self, principal: &str, fallback_operator: &str) -> String {
        let operator = self
            .operator
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(fallback_operator);
        format!("{principal}/{operator}:{}", short_nonce())
    }
}

impl CredentialRef {
    fn resolve(&self) -> Result<CloudAuth, String> {
        match self {
            Self::OidcBearerEnv { env } => Ok(CloudAuth::OidcBearer {
                token: read_secret_env(env)?,
            }),
            Self::AnacondaApiKeyEnv { env } => Ok(CloudAuth::AnacondaApiKey {
                token: read_secret_env(env)?,
            }),
            Self::WorkstationCredentialEnv { env } => Ok(CloudAuth::WorkstationCredential {
                token: read_secret_env(env)?,
            }),
            Self::DevTokenEnv { env, user } => Ok(CloudAuth::Dev {
                token: read_secret_env(env)?,
                user: user.clone(),
            }),
        }
    }
}

fn read_secret_env(name: &str) -> Result<String, String> {
    std::env::var(name).map_err(|_| format!("Credential env var {name} is not set"))
}

pub fn registry_path() -> PathBuf {
    std::env::var_os(REGISTRY_ENV_VAR)
        .or_else(|| std::env::var_os(LEGACY_REGISTRY_ENV_VAR))
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            dirs::config_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join(runt_workspace::config_namespace())
                .join("cloud-domains.toml")
        })
}

pub fn hosted_notebook_url(domain: &str, notebook_id: &str) -> String {
    format!("{}/n/{}", domain.trim_end_matches('/'), notebook_id)
}

/// Parse a hosted notebook URL (`https://<host>/n/<notebook_id>[/...]`) into
/// its normalized domain and notebook id.
pub fn parse_hosted_url(target: &str) -> Result<(String, String), String> {
    let url = Url::parse(target).map_err(|e| format!("Invalid hosted notebook URL: {e}"))?;
    let domain = normalize_url_domain(&url)?;
    let mut segments = url
        .path_segments()
        .ok_or_else(|| "Hosted notebook URL has no path".to_string())?;
    match (segments.next(), segments.next()) {
        (Some("n"), Some(id)) if !id.is_empty() => Ok((domain, id.to_string())),
        _ => Err("Hosted notebook URL must look like https://host/n/<notebook_id>".to_string()),
    }
}

pub fn normalize_domain(domain: &str) -> Result<String, String> {
    let url = Url::parse(domain).map_err(|e| format!("Invalid cloud domain {domain:?}: {e}"))?;
    normalize_url_domain(&url)
}

pub fn normalize_url_domain(url: &Url) -> Result<String, String> {
    match url.scheme() {
        "https" | "http" => {}
        other => return Err(format!("Unsupported cloud domain scheme: {other}")),
    }
    let host = url
        .host_str()
        .ok_or_else(|| "Cloud domain must include a host".to_string())?;
    let mut normalized = format!("{}://{}", url.scheme(), host);
    if let Some(port) = url.port() {
        normalized.push(':');
        normalized.push_str(&port.to_string());
    }
    Ok(normalized)
}

pub fn short_nonce() -> String {
    uuid::Uuid::new_v4().simple().to_string()[..8].to_string()
}
