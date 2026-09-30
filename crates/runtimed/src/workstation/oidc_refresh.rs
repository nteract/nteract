//! OIDC `refresh_token` client and the on-disk [`RefreshTokenCache`] that let
//! a long-lived `--auth-kind oidc` `cloud-runtime-agent` renew its access token
//! instead of holding one static token for its whole process lifetime.
//!
//! [`OidcRefreshClient::into_token_refresher`] produces the
//! [`notebook_cloud_transport::TokenRefresher`] that the agent hands to both
//! the room WebSocket transport (called before every connect/reconnect) and
//! the output blob publisher (called before every upload), so both paths
//! present the same current access token.
//!
//! Trust rules enforced here:
//!
//! - A cache is bound to one notebook-cloud origin, issuer, and OAuth client
//!   ([`CacheBinding`]). A cache that does not match the agent's binding is an
//!   error, never a silent credential for another deployment.
//! - Issuers must use `https`. Plain `http` is accepted only for loopback
//!   hosts, and only when the caller opts in with
//!   [`IssuerTransport::AllowLoopbackHttp`].
//! - Discovery must echo the configured issuer exactly, and the token endpoint
//!   must share the issuer's origin. Redirects are never followed, so the
//!   refresh token is only ever posted to that endpoint.
//! - The agent uses a cache only when an `--oidc-*` flag or a seed asks for
//!   refresh. Without either it keeps its static `RUNT_CLOUD_TOKEN`, even if a
//!   cache exists at the default path.
//! - Discovery and token requests have connect and total timeouts. A failed
//!   refresh is shared with callers for [`FAILURE_BACKOFF`], and a cached token
//!   that has not actually expired is still returned when refresh fails.
//! - Exchanges run one at a time within a process and, on unix, are serialized
//!   across processes by an advisory lock beside the cache, so a rotating
//!   issuer never sees one refresh token spent twice. Other platforms get the
//!   in-process bound only. The exchange and persist run in their own task, so
//!   a cancelled caller cannot drop a rotated refresh token before it is saved.
//! - Unverified JWT claims are read only for local consistency checks (same
//!   issuer, same account) and expiry scheduling. The notebook cloud verifies
//!   token signatures; nothing here treats a decoded claim as authorization.
//!
//! `workstation` (`nwc_`), `anaconda-key`, and `dev` credentials never go
//! through this module; `cloud_agent_cli.rs` builds a refresher only for
//! `--auth-kind oidc`.

use std::future::Future;
use std::io;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Environment variable carrying the refresh token used to seed a new cache.
/// Read once at startup and never passed on argv. Its presence also opts the
/// agent into refresh; with an existing cache the value itself is ignored.
pub const CLOUD_REFRESH_TOKEN_ENV: &str = "RUNT_CLOUD_REFRESH_TOKEN";

/// Safety skew applied before an access token's recorded expiry: refresh at
/// or before this many seconds remain, not only after outright expiry, so a
/// connect attempt never races a token that is about to lapse mid-handshake.
const REFRESH_SKEW: Duration = Duration::from_secs(60);

/// Total budget for one discovery or token request, including the body read.
/// Matches the browser viewer's OIDC fetch timeout.
const OIDC_REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const OIDC_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

/// How long a refresh waits for another process holding the cache lock. Longer
/// than one holder's worst case (discovery plus token request).
const CACHE_LOCK_WAIT: Duration = Duration::from_secs(40);

/// After a failed refresh, callers within this window get the same error
/// without new issuer requests, so an outage costs one timeout, not one per
/// queued connect or blob upload.
const FAILURE_BACKOFF: Duration = Duration::from_secs(5);

/// How long a caller holding a still-valid (inside the skew window) token
/// waits for a refresh before using that token.
const UNEXPIRED_REFRESH_WAIT: Duration = Duration::from_secs(2);

/// Access-token lifetime assumed when a grant has neither `expires_in` nor a
/// JWT `exp`.
const DEFAULT_EXPIRES_IN_SECONDS: i64 = 300;
#[cfg(unix)]
const CACHE_LOCK_POLL: Duration = Duration::from_millis(25);

/// Which issuer URL schemes the agent accepts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IssuerTransport {
    /// Production rule: `https` only.
    HttpsOnly,
    /// Also accept `http` for `localhost` / loopback IPs (local dev issuers).
    AllowLoopbackHttp,
}

/// The deployment a cache belongs to. A cache is only usable by an agent whose
/// binding matches field for field.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CacheBinding {
    /// Notebook-cloud origin (`scheme://host[:port]`), from `--cloud-url`.
    pub cloud_origin: String,
    /// OIDC issuer exactly as configured.
    pub issuer: String,
    /// Public OAuth client id.
    pub client_id: String,
}

/// On-disk cache for a single OIDC-refreshable credential. Written with mode
/// `0600`.
///
/// No derived `Debug`: `access_token`/`refresh_token` must never appear in
/// a log line, and a derived `Debug` would print them in full the moment
/// anything formats this struct with `{:?}`.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RefreshTokenCache {
    /// Notebook-cloud origin this credential is for (see [`CacheBinding`]).
    pub cloud_origin: String,
    /// OIDC issuer URL, e.g. `https://auth.stage.anaconda.com/api/auth`.
    pub issuer: String,
    /// Public OAuth client id (no secret involved).
    pub client_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    /// Account (`sub`) the cache is pinned to, once known. Refreshed tokens
    /// for a different account are rejected.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subject: Option<String>,
    pub access_token: String,
    pub refresh_token: String,
    /// RFC 3339 (UTC) absolute expiry of `access_token`.
    pub expires_at: String,
}

impl std::fmt::Debug for RefreshTokenCache {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RefreshTokenCache")
            .field("cloud_origin", &self.cloud_origin)
            .field("issuer", &self.issuer)
            .field("client_id", &self.client_id)
            .field("scope", &self.scope)
            .field("subject", &self.subject.as_ref().map(|_| "[set]"))
            .field("access_token", &"[REDACTED]")
            .field("refresh_token", &"[REDACTED]")
            .field("expires_at", &self.expires_at)
            .finish()
    }
}

impl RefreshTokenCache {
    /// Load the cache at `path`.
    ///
    /// `Ok(None)` means no cache file exists. A file that exists but is
    /// unreadable, wider than owner-only, or malformed is an error: the caller
    /// asked for refresh and should hear why it cannot happen. Parse errors
    /// never echo file contents.
    ///
    /// The permission check and the content read use the same open file
    /// handle, so a concurrent rename/symlink swap cannot substitute a
    /// different file between the two.
    pub fn load(path: &Path) -> io::Result<Option<RefreshTokenCache>> {
        let mut file = match std::fs::File::open(path) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => {
                return Err(io::Error::new(
                    error.kind(),
                    format!("open oidc refresh cache {}: {error}", path.display()),
                ))
            }
        };
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = file.metadata()?.permissions().mode();
            if mode & 0o777 != 0o600 {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    format!(
                        "oidc refresh cache {} must have mode 0600 (found {:o})",
                        path.display(),
                        mode & 0o777
                    ),
                ));
            }
        }
        let mut contents = String::new();
        {
            use std::io::Read;
            file.read_to_string(&mut contents)?;
        }
        serde_json::from_str(&contents).map(Some).map_err(|_| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                format!(
                    "oidc refresh cache {} is not a valid cache file",
                    path.display()
                ),
            )
        })
    }

    /// Persist the cache atomically (write and sync a temp file in the same
    /// directory, then rename) with mode `0600`. Readers see either the old
    /// cache or the new one, never a half-written file. A crash after the
    /// issuer rotates but before this completes still loses the new refresh
    /// token; the old one stays on disk.
    ///
    /// The temp file is created at mode `0600` from the moment it exists —
    /// never at a wider, umask-dependent mode that a later `chmod` would
    /// only narrow after the secret was already written — and is removed
    /// on any failure so a partially written credential file is never left
    /// behind at any permission.
    pub fn save(&self, path: &Path) -> io::Result<()> {
        let tmp_path = self.write_tmp(path)?;
        if let Err(e) = std::fs::rename(&tmp_path, path) {
            let _ = std::fs::remove_file(&tmp_path);
            return Err(e);
        }
        Ok(())
    }

    /// Like [`save`](Self::save), but never replaces an existing cache.
    /// Returns `Ok(false)` when another process created `path` first; the
    /// caller should load that cache instead.
    pub fn save_new(&self, path: &Path) -> io::Result<bool> {
        let tmp_path = self.write_tmp(path)?;
        let linked = std::fs::hard_link(&tmp_path, path);
        let _ = std::fs::remove_file(&tmp_path);
        match linked {
            Ok(()) => Ok(true),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => Ok(false),
            Err(e) => Err(e),
        }
    }

    fn write_tmp(&self, path: &Path) -> io::Result<PathBuf> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let json = serde_json::to_string_pretty(self)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
        let tmp_path = tmp_sibling_path(path);
        if let Err(e) = write_owner_only(&tmp_path, json.as_bytes()) {
            let _ = std::fs::remove_file(&tmp_path);
            return Err(e);
        }
        Ok(tmp_path)
    }

    /// Error unless this cache belongs to `expected`.
    pub fn check_binding(&self, expected: &CacheBinding) -> io::Result<()> {
        let fields = [
            (
                "notebook cloud origin",
                &self.cloud_origin,
                &expected.cloud_origin,
            ),
            ("issuer", &self.issuer, &expected.issuer),
            ("client id", &self.client_id, &expected.client_id),
        ];
        for (field, found, wanted) in fields {
            if found != wanted {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    format!("oidc refresh cache is bound to {field} {found:?}, not {wanted:?}"),
                ));
            }
        }
        Ok(())
    }
}

/// Write `contents` to `path`, creating it at mode `0600` from birth on
/// unix (never at a wider, umask-dependent mode that a later `chmod` would
/// only narrow after the fact). On non-unix platforms mode bits don't
/// apply the same way, so this is a plain create+write there.
///
/// Uses `create_new` (`O_EXCL`), not `create`: `create` would happily open
/// and reuse whatever already sits at `path` — including following a
/// pre-existing symlink to an attacker-chosen target, or reusing a
/// wider-than-`0600` file without narrowing it, since `mode()` only applies
/// when the file is freshly created. `create_new` fails instead of
/// following/reusing either. This function removes any stale leftover at
/// `path` first (from a crashed prior write) so a legitimate retry isn't
/// blocked by its own debris.
fn write_owner_only(path: &Path, contents: &[u8]) -> io::Result<()> {
    use std::io::Write;
    let _ = std::fs::remove_file(path);
    #[cfg(unix)]
    let mut file = {
        use std::os::unix::fs::OpenOptionsExt;
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)?
    };
    #[cfg(not(unix))]
    let mut file = std::fs::File::create(path)?;
    file.write_all(contents)?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    Ok(())
}

fn tmp_sibling_path(path: &Path) -> PathBuf {
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("oidc-refresh.json");
    path.with_file_name(format!(".{file_name}.tmp-{}", std::process::id()))
}

fn lock_sibling_path(path: &Path) -> PathBuf {
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("oidc-refresh.json");
    path.with_file_name(format!("{file_name}.lock"))
}

/// Default cache location for one notebook-cloud origin, under the same
/// dev/production config convention `workstation.json` uses
/// ([`runt_workspace::config_or_dev_file`]). Keying the file name by origin
/// keeps agents for different deployments from sharing a credential.
pub fn default_cache_path(cloud_origin: &str) -> PathBuf {
    let digest = Sha256::digest(cloud_origin.as_bytes());
    let key = hex::encode(&digest[..8]);
    runt_workspace::config_or_dev_file(&format!("oidc-refresh-{key}.json"))
}

/// Normalize `--cloud-url` to its origin for [`CacheBinding::cloud_origin`].
pub fn cloud_origin(cloud_url: &str) -> io::Result<String> {
    let url = reqwest::Url::parse(cloud_url.trim()).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("notebook cloud URL {cloud_url:?} is not a valid URL"),
        )
    })?;
    if !matches!(url.scheme(), "https" | "http") || url.host_str().is_none() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("notebook cloud URL {cloud_url:?} must be an http(s) URL with a host"),
        ));
    }
    Ok(url.origin().ascii_serialization())
}

fn is_loopback_host(host: &str) -> bool {
    let host = host.trim_start_matches('[').trim_end_matches(']');
    host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback())
}

/// Check an issuer URL against the transport policy and return it parsed.
pub fn validate_issuer(issuer: &str, transport: IssuerTransport) -> io::Result<reqwest::Url> {
    let invalid = |reason: &str| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("oidc issuer {issuer:?} {reason}"),
        )
    };
    let url = reqwest::Url::parse(issuer).map_err(|_| invalid("is not a valid URL"))?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(invalid(
            "must not contain credentials, a query, or a fragment",
        ));
    }
    let Some(host) = url.host_str() else {
        return Err(invalid("must have a host"));
    };
    match url.scheme() {
        "https" => Ok(url),
        "http" if is_loopback_host(host) => match transport {
            IssuerTransport::AllowLoopbackHttp => Ok(url),
            IssuerTransport::HttpsOnly => Err(invalid(
                "uses http; pass --oidc-allow-loopback-http for a local development issuer",
            )),
        },
        _ => Err(invalid("must use https")),
    }
}

/// The token endpoint must live on the issuer's origin. A provider using a
/// separate token origin would need an explicit allowlist, not a discovery
/// document or redirect choosing where the refresh token goes.
fn validate_token_endpoint(endpoint: &str, issuer: &reqwest::Url) -> io::Result<reqwest::Url> {
    let untrusted = || {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "oidc token endpoint must use the issuer's origin without credentials or a fragment",
        )
    };
    let url = reqwest::Url::parse(endpoint).map_err(|_| untrusted())?;
    if url.origin() != issuer.origin()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(untrusted());
    }
    Ok(url)
}

/// Claims read from a JWT payload *without* signature verification.
#[derive(Debug, Default, Deserialize)]
struct UnverifiedClaims {
    #[serde(default)]
    iss: Option<String>,
    #[serde(default)]
    sub: Option<String>,
    #[serde(default)]
    exp: Option<f64>,
}

/// Decode a JWT payload for local consistency checks. Returns `None` for
/// opaque tokens or any payload that does not parse; callers skip the check
/// in that case.
fn unverified_claims(token: &str) -> Option<UnverifiedClaims> {
    let mut parts = token.split('.');
    let (_header, payload, _signature) = (parts.next()?, parts.next()?, parts.next()?);
    if parts.next().is_some() {
        return None;
    }
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload.trim_end_matches('='))
        .ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Reject `token` when its unverified claims name a different issuer, or a
/// different account than `subject`. Opaque tokens pass.
fn check_token_account(
    token: &str,
    issuer: &str,
    subject: Option<&str>,
    what: &str,
) -> io::Result<()> {
    let Some(claims) = unverified_claims(token) else {
        return Ok(());
    };
    if let Some(found) = claims.iss.as_deref() {
        if found != issuer {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                format!("{what} was issued by {found:?}, not the cache issuer {issuer:?}"),
            ));
        }
    }
    if let (Some(expected), Some(found)) = (subject, claims.sub.as_deref()) {
        if found != expected {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                format!("{what} belongs to a different account than the oidc refresh cache"),
            ));
        }
    }
    Ok(())
}

/// Non-secret `cloud-runtime-agent` flags that control OIDC refresh.
#[derive(Debug, Clone, Default)]
pub struct OidcRefreshOptions {
    /// Cache file; defaults to [`default_cache_path`] for the cloud origin.
    pub cache_path: Option<PathBuf>,
    /// Issuer for seeding a new cache, or an assertion about an existing one.
    pub issuer: Option<String>,
    /// OAuth client id for seeding, or an assertion about an existing cache.
    pub client_id: Option<String>,
    /// Scope requested on refresh; only recorded when seeding.
    pub scope: Option<String>,
    /// Accept `http` issuers on loopback hosts.
    pub allow_loopback_http: bool,
}

impl OidcRefreshOptions {
    /// Whether any refresh flag was given, i.e. the operator asked for refresh.
    pub fn is_configured(&self) -> bool {
        self.cache_path.is_some()
            || self.issuer.is_some()
            || self.client_id.is_some()
            || self.scope.is_some()
            || self.allow_loopback_http
    }

    fn transport(&self) -> IssuerTransport {
        if self.allow_loopback_http {
            IssuerTransport::AllowLoopbackHttp
        } else {
            IssuerTransport::HttpsOnly
        }
    }
}

fn trimmed(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

/// Resolve the refresh cache for one agent start and build its client.
///
/// - No seed and no `--oidc-*` flags: `Ok(None)` without touching any cache
///   file; the agent keeps its static `RUNT_CLOUD_TOKEN`. Refresh is opt-in
///   per start, so a connector that launches oidc agents with fresh job
///   credentials is never overridden by a cache a person seeded earlier.
/// - No cache but a seed refresh token: `--oidc-issuer` and
///   `--oidc-client-id` are required. The new cache records the cloud origin,
///   issuer, client, and the account from `initial_access_token` when it is a
///   JWT. Its expiry comes from that token's `exp`, or is already due, so the
///   first connect refreshes.
/// - Existing cache: it must match the cloud origin and any issuer/client
///   flags, and `initial_access_token` must not name a different issuer or
///   account. A seed is ignored; delete the cache file to re-seed. A rotating
///   issuer has already spent the seed if this cache was refreshed from it.
/// - Flags given but neither a cache nor a seed: an error, because refresh was
///   requested but cannot start.
pub fn prepare_refresh_client(
    options: &OidcRefreshOptions,
    cloud_url: &str,
    initial_access_token: &str,
    seed_refresh_token: Option<&str>,
) -> io::Result<Option<OidcRefreshClient>> {
    if !options.is_configured() && trimmed(seed_refresh_token).is_none() {
        return Ok(None);
    }
    let origin = cloud_origin(cloud_url)?;
    let path = options
        .cache_path
        .clone()
        .unwrap_or_else(|| default_cache_path(&origin));
    prepare_refresh_client_at(
        path,
        options,
        origin,
        initial_access_token,
        seed_refresh_token,
    )
}

fn prepare_refresh_client_at(
    path: PathBuf,
    options: &OidcRefreshOptions,
    origin: String,
    initial_access_token: &str,
    seed_refresh_token: Option<&str>,
) -> io::Result<Option<OidcRefreshClient>> {
    let transport = options.transport();
    let issuer_flag = trimmed(options.issuer.as_deref());
    let client_id_flag = trimmed(options.client_id.as_deref());
    let seed = trimmed(seed_refresh_token);

    let cache = match RefreshTokenCache::load(&path)? {
        Some(existing) => {
            if seed.is_some() {
                tracing::info!(
                    path = %path.display(),
                    "keeping existing oidc refresh cache; {CLOUD_REFRESH_TOKEN_ENV} only seeds a missing cache"
                );
            }
            existing
        }
        None => {
            let Some(refresh_token) = seed else {
                if options.is_configured() {
                    return Err(io::Error::new(
                        io::ErrorKind::NotFound,
                        format!(
                            "no oidc refresh cache at {}; set {CLOUD_REFRESH_TOKEN_ENV} to seed it",
                            path.display()
                        ),
                    ));
                }
                return Ok(None);
            };
            let (Some(issuer), Some(client_id)) = (issuer_flag.clone(), client_id_flag.clone())
            else {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "seeding an oidc refresh cache requires --oidc-issuer and --oidc-client-id",
                ));
            };
            validate_issuer(&issuer, transport)?;
            check_token_account(initial_access_token, &issuer, None, CLOUD_TOKEN_LABEL)?;
            let claims = unverified_claims(initial_access_token).unwrap_or_default();
            let expires_at = claims
                .exp
                .and_then(|exp| chrono::DateTime::from_timestamp(exp as i64, 0))
                .map(|at| at.to_rfc3339())
                .unwrap_or_else(|| absolute_expiry(0));
            let seeded = RefreshTokenCache {
                cloud_origin: origin.clone(),
                issuer,
                client_id,
                scope: trimmed(options.scope.as_deref()),
                subject: claims.sub,
                access_token: initial_access_token.to_string(),
                refresh_token,
                expires_at,
            };
            // No-clobber: another agent seeding the same origin may have
            // created (and already rotated) the cache since `load` above.
            if seeded.save_new(&path)? {
                tracing::info!(path = %path.display(), "seeded oidc refresh cache");
                seeded
            } else {
                tracing::info!(
                    path = %path.display(),
                    "another agent created the oidc refresh cache first; using it"
                );
                RefreshTokenCache::load(&path)?.ok_or_else(|| {
                    io::Error::new(
                        io::ErrorKind::NotFound,
                        "oidc refresh cache disappeared while seeding",
                    )
                })?
            }
        }
    };

    let binding = CacheBinding {
        cloud_origin: origin,
        issuer: issuer_flag.unwrap_or_else(|| cache.issuer.clone()),
        client_id: client_id_flag.unwrap_or_else(|| cache.client_id.clone()),
    };
    cache.check_binding(&binding)?;
    validate_issuer(&cache.issuer, transport)?;
    check_token_account(
        initial_access_token,
        &cache.issuer,
        cache.subject.as_deref(),
        CLOUD_TOKEN_LABEL,
    )?;
    OidcRefreshClient::new(path, binding, transport).map(Some)
}

const CLOUD_TOKEN_LABEL: &str = "RUNT_CLOUD_TOKEN";

/// The one discovery-document field this module uses after validation.
#[derive(Debug, Clone)]
pub struct OidcDiscovery {
    pub token_endpoint: reqwest::Url,
}

#[derive(Debug, Clone, Deserialize)]
struct OidcDiscoveryResponse {
    #[serde(default)]
    issuer: Option<String>,
    #[serde(default)]
    token_endpoint: Option<String>,
}

fn discovery_url(issuer: &str) -> String {
    format!(
        "{}/.well-known/openid-configuration",
        issuer.trim_end_matches('/')
    )
}

fn request_error(context: &str, error: reqwest::Error) -> io::Error {
    let kind = if error.is_timeout() {
        io::ErrorKind::TimedOut
    } else {
        io::ErrorKind::Other
    };
    io::Error::new(kind, format!("{context}: {error}"))
}

/// Read a JSON body within the client's timeout. Parse errors are reported
/// generically so a malformed token response is never echoed into a log.
async fn read_json<T: serde::de::DeserializeOwned>(
    response: reqwest::Response,
    context: &str,
) -> io::Result<T> {
    let bytes = response
        .bytes()
        .await
        .map_err(|e| request_error(context, e))?;
    serde_json::from_slice(&bytes).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("{context}: response was not the expected JSON"),
        )
    })
}

/// `GET {issuer}/.well-known/openid-configuration` and validate it: the
/// document must name `issuer` exactly, and its token endpoint must share
/// the issuer's origin. Any non-2xx status, including an unfollowed
/// redirect, is an error.
pub async fn discover(
    client: &reqwest::Client,
    issuer: &str,
    issuer_url: &reqwest::Url,
) -> io::Result<OidcDiscovery> {
    let response = client
        .get(discovery_url(issuer))
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| request_error("oidc discovery request failed", e))?;
    if !response.status().is_success() {
        return Err(io::Error::other(format!(
            "oidc discovery failed with status {}",
            response.status()
        )));
    }
    let body: OidcDiscoveryResponse = read_json(response, "oidc discovery").await?;
    match body.issuer.as_deref() {
        Some(found) if found == issuer => {}
        Some(found) => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("oidc discovery issuer {found:?} does not match {issuer:?}"),
            ))
        }
        None => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "oidc discovery response missing issuer",
            ))
        }
    }
    let token_endpoint = body.token_endpoint.ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "oidc discovery response missing token_endpoint",
        )
    })?;
    Ok(OidcDiscovery {
        token_endpoint: validate_token_endpoint(&token_endpoint, issuer_url)?,
    })
}

/// `refresh_token` grant response. `refresh_token` is optional — some
/// issuers don't rotate it on every exchange.
///
/// No derived `Debug`, for the same reason as [`RefreshTokenCache`]:
/// `access_token`/`refresh_token` must never appear in a log line.
#[derive(Clone, Deserialize)]
pub struct RefreshGrantResponse {
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: Option<String>,
    /// Optional per RFC 6749; see [`grant_expiry`] for the fallback.
    #[serde(default)]
    pub expires_in: Option<i64>,
}

impl std::fmt::Debug for RefreshGrantResponse {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RefreshGrantResponse")
            .field("access_token", &"[REDACTED]")
            .field(
                "refresh_token",
                &self.refresh_token.as_ref().map(|_| "[REDACTED]"),
            )
            .field("expires_in", &self.expires_in)
            .finish()
    }
}

#[derive(Deserialize)]
struct OAuthErrorBody {
    #[serde(default)]
    error: Option<String>,
}

/// `POST {token_endpoint}` with `grant_type=refresh_token`, `client_id`,
/// `refresh_token`, and `scope` only if `Some` — no `client_secret` (public
/// client, mirroring `exchangeRefreshToken` in
/// `apps/notebook-cloud/viewer/oidc-auth.ts`). A non-2xx or malformed
/// response returns an `io::Error` carrying at most the OAuth `error` code.
pub async fn exchange_refresh_token(
    client: &reqwest::Client,
    token_endpoint: &reqwest::Url,
    client_id: &str,
    refresh_token: &str,
    scope: Option<&str>,
) -> io::Result<RefreshGrantResponse> {
    let mut form: Vec<(&str, &str)> = vec![
        ("grant_type", "refresh_token"),
        ("client_id", client_id),
        ("refresh_token", refresh_token),
    ];
    if let Some(scope) = scope {
        form.push(("scope", scope));
    }
    let response = client
        .post(token_endpoint.clone())
        .header("Accept", "application/json")
        .form(&form)
        .send()
        .await
        .map_err(|e| request_error("oidc token refresh request failed", e))?;
    let status = response.status();
    if !status.is_success() {
        let code = read_json::<OAuthErrorBody>(response, "oidc token refresh")
            .await
            .ok()
            .and_then(|body| body.error)
            .filter(|code| {
                code.len() <= 64
                    && code
                        .bytes()
                        .all(|b| b.is_ascii_lowercase() || b == b'_' || b == b'-')
            });
        return Err(io::Error::other(match code {
            Some(code) => format!("oidc token refresh failed with status {status} ({code})"),
            None => format!("oidc token refresh failed with status {status}"),
        }));
    }
    read_json(response, "oidc token refresh").await
}

/// True when `expires_at` is at or past `now + REFRESH_SKEW`, or is
/// unparseable (treated as already-expired: refresh now rather than trust a
/// token we can't reason about).
fn needs_refresh(expires_at: &str) -> bool {
    match chrono::DateTime::parse_from_rfc3339(expires_at) {
        Ok(dt) => {
            let expires = dt.with_timezone(&chrono::Utc);
            let skew = chrono::Duration::from_std(REFRESH_SKEW).unwrap_or(chrono::Duration::zero());
            expires <= chrono::Utc::now() + skew
        }
        Err(_) => true,
    }
}

/// Convert a relative `expires_in` (seconds) grant field into an absolute
/// RFC 3339 timestamp before it is ever persisted (never store a relative
/// duration).
///
/// `expires_in` is server-controlled input; it is clamped to a sane bound
/// before any `chrono::Duration` arithmetic so a malicious or buggy token
/// endpoint returning an out-of-range value (e.g. `i64::MAX`) cannot panic
/// this process via duration/date overflow — a bad response must become an
/// error or a clamped value, never a crash.
fn absolute_expiry(expires_in_seconds: i64) -> String {
    const MAX_EXPIRES_IN_SECONDS: i64 = 60 * 60 * 24 * 365; // 1 year
    let seconds = expires_in_seconds.clamp(0, MAX_EXPIRES_IN_SECONDS);
    let now = chrono::Utc::now();
    now.checked_add_signed(chrono::Duration::seconds(seconds))
        .unwrap_or(now)
        .to_rfc3339()
}

/// Absolute expiry for a grant: `expires_in` when present, else the access
/// token's JWT `exp`, else [`DEFAULT_EXPIRES_IN_SECONDS`].
fn grant_expiry(grant: &RefreshGrantResponse) -> String {
    if let Some(seconds) = grant.expires_in {
        return absolute_expiry(seconds);
    }
    unverified_claims(&grant.access_token)
        .and_then(|claims| claims.exp)
        .and_then(|exp| chrono::DateTime::from_timestamp(exp as i64, 0))
        .map(|at| at.to_rfc3339())
        .unwrap_or_else(|| absolute_expiry(DEFAULT_EXPIRES_IN_SECONDS))
}

/// True once `expires_at` has actually passed (no skew). Unparseable counts
/// as expired.
fn is_expired(expires_at: &str) -> bool {
    chrono::DateTime::parse_from_rfc3339(expires_at)
        .map(|dt| dt.with_timezone(&chrono::Utc) <= chrono::Utc::now())
        .unwrap_or(true)
}

/// Cross-process advisory lock on `<cache>.lock`. Held for one
/// check-exchange-persist cycle; closing the file releases it.
struct CacheFileLock {
    #[cfg(unix)]
    _file: std::fs::File,
}

impl CacheFileLock {
    #[cfg(unix)]
    async fn acquire(path: &Path, wait: Duration) -> io::Result<Self> {
        use std::os::fd::AsRawFd;
        use std::os::unix::fs::OpenOptionsExt;

        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(path)?;
        let deadline = tokio::time::Instant::now() + wait;
        loop {
            // SAFETY: `file` owns a valid descriptor for the whole call.
            let rc = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
            if rc == 0 {
                return Ok(Self { _file: file });
            }
            let error = io::Error::last_os_error();
            match error.raw_os_error() {
                Some(code) if code == libc::EWOULDBLOCK || code == libc::EINTR => {}
                _ => return Err(error),
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "timed out waiting for another process to finish refreshing the oidc token",
                ));
            }
            tokio::time::sleep(CACHE_LOCK_POLL).await;
        }
    }

    #[cfg(not(unix))]
    async fn acquire(_path: &Path, _wait: Duration) -> io::Result<Self> {
        Ok(Self {})
    }
}

/// A refresh failure remembered for [`FAILURE_BACKOFF`].
struct RecentFailure {
    at: std::time::Instant,
    kind: io::ErrorKind,
    message: String,
}

/// Fresh-token source for a `TokenRefresher`: checks a cached access
/// token's expiry, exchanges the refresh token when needed, and persists
/// the result.
///
/// Exchanges are single-flight in-process via a [`tokio::sync::Semaphore`]
/// (a permit may be held across `.await`; a Tokio `Mutex`/`RwLock` guard may
/// not, per `cargo test -p runtimed --test tokio_mutex_lint`) and serialized
/// across processes sharing the cache by [`CacheFileLock`].
#[derive(Clone)]
pub struct OidcRefreshClient {
    cache_path: PathBuf,
    binding: CacheBinding,
    transport: IssuerTransport,
    http: reqwest::Client,
    single_flight: Arc<tokio::sync::Semaphore>,
    lock_wait: Duration,
    /// Most recent refresh failure, for [`FAILURE_BACKOFF`]. A std mutex:
    /// only touched in synchronous sections, never held across `.await`.
    last_failure: Arc<std::sync::Mutex<Option<RecentFailure>>>,
}

impl OidcRefreshClient {
    pub fn new(
        cache_path: PathBuf,
        binding: CacheBinding,
        transport: IssuerTransport,
    ) -> io::Result<Self> {
        Self::with_limits(
            cache_path,
            binding,
            transport,
            OIDC_CONNECT_TIMEOUT,
            OIDC_REQUEST_TIMEOUT,
            CACHE_LOCK_WAIT,
        )
    }

    fn with_limits(
        cache_path: PathBuf,
        binding: CacheBinding,
        transport: IssuerTransport,
        connect_timeout: Duration,
        request_timeout: Duration,
        lock_wait: Duration,
    ) -> io::Result<Self> {
        let http = reqwest::Client::builder()
            .connect_timeout(connect_timeout)
            .timeout(request_timeout)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| io::Error::other(format!("build oidc http client: {e}")))?;
        Ok(Self {
            cache_path,
            binding,
            transport,
            http,
            single_flight: Arc::new(tokio::sync::Semaphore::new(1)),
            lock_wait,
            last_failure: Arc::new(std::sync::Mutex::new(None)),
        })
    }

    fn load_bound(&self) -> io::Result<RefreshTokenCache> {
        let cache = RefreshTokenCache::load(&self.cache_path)?.ok_or_else(|| {
            io::Error::new(io::ErrorKind::NotFound, "no oidc refresh cache available")
        })?;
        cache.check_binding(&self.binding)?;
        Ok(cache)
    }

    /// Returns the bearer token to present next: the cached token unchanged
    /// if still outside the skew window (no HTTP, no locking), or a freshly
    /// exchanged one.
    ///
    /// The exchange runs in a spawned task, so dropping this future (an
    /// aborted IOPub task, a cancelled connect) cannot lose a rotated refresh
    /// token between the issuer's response and the cache write. If refresh
    /// fails while the cached token has not actually expired, that token is
    /// still returned.
    async fn refresh_or_reuse(&self) -> io::Result<String> {
        let cache = self.load_bound()?;
        if !needs_refresh(&cache.expires_at) {
            return Ok(cache.access_token);
        }

        let this = self.clone();
        let task = tokio::spawn(async move { this.refresh_locked().await });
        let joined = if is_expired(&cache.expires_at) {
            task.await
        } else {
            // The cached token still works, so don't hold the caller for a
            // slow issuer. The detached task still persists any rotation.
            match tokio::time::timeout(UNEXPIRED_REFRESH_WAIT, task).await {
                Ok(joined) => joined,
                Err(_) => return Ok(cache.access_token),
            }
        };
        let result =
            joined.map_err(|e| io::Error::other(format!("oidc refresh task failed: {e}")))?;
        match result {
            Err(error) if !is_expired(&cache.expires_at) => {
                tracing::warn!(
                    "oidc token refresh failed; using the unexpired cached token: {error}"
                );
                Ok(cache.access_token)
            }
            other => other,
        }
    }

    fn recent_failure(&self) -> Option<io::Error> {
        let guard = self
            .last_failure
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let failure = guard.as_ref()?;
        (failure.at.elapsed() < FAILURE_BACKOFF).then(|| {
            io::Error::new(
                failure.kind,
                format!("{} (recent failure; not retried yet)", failure.message),
            )
        })
    }

    fn record_outcome(&self, result: &io::Result<String>) {
        let mut guard = self
            .last_failure
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *guard = result.as_ref().err().map(|error| RecentFailure {
            at: std::time::Instant::now(),
            kind: error.kind(),
            message: error.to_string(),
        });
    }

    /// Serialized check-exchange-persist: in-process permit, then the
    /// cross-process lock, then a fresh expiry check, because another task or
    /// process may have just finished refreshing.
    async fn refresh_locked(&self) -> io::Result<String> {
        if let Some(error) = self.recent_failure() {
            return Err(error);
        }
        let _permit = self.single_flight.acquire().await.map_err(|e| {
            io::Error::other(format!("oidc refresh single-flight semaphore closed: {e}"))
        })?;
        // The previous permit holder may have just failed.
        if let Some(error) = self.recent_failure() {
            return Err(error);
        }
        let result = self.exchange_under_lock().await;
        self.record_outcome(&result);
        result
    }

    async fn exchange_under_lock(&self) -> io::Result<String> {
        let _lock =
            CacheFileLock::acquire(&lock_sibling_path(&self.cache_path), self.lock_wait).await?;

        let cache = self.load_bound()?;
        if !needs_refresh(&cache.expires_at) {
            return Ok(cache.access_token);
        }

        let issuer_url = validate_issuer(&cache.issuer, self.transport)?;
        let discovery = discover(&self.http, &cache.issuer, &issuer_url).await?;
        let grant = exchange_refresh_token(
            &self.http,
            &discovery.token_endpoint,
            &cache.client_id,
            &cache.refresh_token,
            cache.scope.as_deref(),
        )
        .await?;
        check_token_account(
            &grant.access_token,
            &cache.issuer,
            cache.subject.as_deref(),
            "refreshed access token",
        )?;

        let subject = cache
            .subject
            .or_else(|| unverified_claims(&grant.access_token).and_then(|claims| claims.sub));
        let expires_at = grant_expiry(&grant);
        let updated = RefreshTokenCache {
            cloud_origin: cache.cloud_origin,
            issuer: cache.issuer,
            client_id: cache.client_id,
            scope: cache.scope,
            subject,
            access_token: grant.access_token,
            refresh_token: grant.refresh_token.unwrap_or(cache.refresh_token),
            expires_at,
        };
        updated.save(&self.cache_path)?;
        tracing::debug!("oidc access token refreshed"); // no token value logged
        Ok(updated.access_token)
    }

    /// Wrap this client into the `Arc<dyn Fn() -> ...>` shape
    /// `CloudWsFrameTransport::with_token_refresher` and the output blob
    /// publisher take. Every failure path is an `io::Error`; this never
    /// panics.
    pub fn into_token_refresher(self) -> notebook_cloud_transport::TokenRefresher {
        Arc::new(move || {
            let this = self.clone();
            Box::pin(async move { this.refresh_or_reuse().await })
                as Pin<Box<dyn Future<Output = io::Result<String>> + Send>>
        })
    }
}

/// Deterministic local stand-ins for an OIDC issuer, shared with the blob
/// publisher tests. No network beyond `127.0.0.1`, no real credentials.
#[cfg(test)]
pub(crate) mod test_support {
    use super::*;
    use std::collections::HashSet;
    use std::convert::Infallible;
    use std::sync::atomic::{AtomicUsize, Ordering};

    pub(crate) const SEED_REFRESH_TOKEN: &str = "seed-refresh-token";

    /// Unsigned JWT-shaped test token carrying `iss`, `sub`, and `exp`.
    pub(crate) fn fake_jwt(iss: &str, sub: &str, exp: i64, nonce: &str) -> String {
        let engine = base64::engine::general_purpose::URL_SAFE_NO_PAD;
        let header = engine.encode(br#"{"alg":"none","typ":"JWT"}"#);
        let payload = engine.encode(
            serde_json::json!({ "iss": iss, "sub": sub, "exp": exp, "jti": nonce }).to_string(),
        );
        format!("{header}.{payload}.sig")
    }

    #[derive(Clone)]
    pub(crate) struct FakeIssuerConfig {
        /// Discovery `issuer`; `None` echoes the server's own URL.
        pub discovery_issuer: Option<String>,
        /// Discovery `token_endpoint`; `None` uses `<url>/token`.
        pub token_endpoint: Option<String>,
        /// Issue a new refresh token per exchange and reject spent ones.
        pub rotate: bool,
        /// `sub` in minted access tokens.
        pub subject: String,
        /// Delay before answering `/token`.
        pub token_delay: Option<Duration>,
        /// Leave `expires_in` out of successful grants.
        pub omit_expires_in: bool,
    }

    impl Default for FakeIssuerConfig {
        fn default() -> Self {
            Self {
                discovery_issuer: None,
                token_endpoint: None,
                rotate: false,
                subject: "user-1".to_string(),
                token_delay: None,
                omit_expires_in: false,
            }
        }
    }

    pub(crate) struct FakeIssuer {
        pub url: String,
        pub exchange_count: Arc<AtomicUsize>,
        _shutdown: tokio::sync::oneshot::Sender<()>,
    }

    struct State {
        valid_refresh_tokens: HashSet<String>,
        next: usize,
    }

    pub(crate) async fn start_fake_issuer(config: FakeIssuerConfig) -> FakeIssuer {
        use http_body_util::BodyExt;

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let exchange_count = Arc::new(AtomicUsize::new(0));
        let state = Arc::new(std::sync::Mutex::new(State {
            valid_refresh_tokens: HashSet::from([SEED_REFRESH_TOKEN.to_string()]),
            next: 0,
        }));
        let (shutdown_tx, mut shutdown_rx) = tokio::sync::oneshot::channel::<()>();

        let server_url = url.clone();
        let counter = exchange_count.clone();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = &mut shutdown_rx => break,
                    accepted = listener.accept() => {
                        let Ok((stream, _)) = accepted else { break };
                        let config = config.clone();
                        let state = state.clone();
                        let counter = counter.clone();
                        let server_url = server_url.clone();
                        tokio::spawn(async move {
                            let io = hyper_util::rt::TokioIo::new(stream);
                            let service = hyper::service::service_fn(move |req: hyper::Request<hyper::body::Incoming>| {
                                let config = config.clone();
                                let state = state.clone();
                                let counter = counter.clone();
                                let server_url = server_url.clone();
                                async move {
                                    let path = req.uri().path().to_string();
                                    let (status, body) = match path.as_str() {
                                        "/.well-known/openid-configuration" => (200, serde_json::json!({
                                            "issuer": config.discovery_issuer.clone().unwrap_or_else(|| server_url.clone()),
                                            "token_endpoint": config.token_endpoint.clone().unwrap_or_else(|| format!("{server_url}/token")),
                                        }).to_string()),
                                        "/token" => {
                                            counter.fetch_add(1, Ordering::SeqCst);
                                            if let Some(delay) = config.token_delay {
                                                tokio::time::sleep(delay).await;
                                            }
                                            let body = req.into_body().collect().await.unwrap().to_bytes();
                                            let presented = url_form_value(&body, "refresh_token");
                                            let mut state = state.lock().unwrap();
                                            if !state.valid_refresh_tokens.contains(&presented) {
                                                (400, r#"{"error":"invalid_grant"}"#.to_string())
                                            } else {
                                                state.next += 1;
                                                let n = state.next;
                                                let mut grant = serde_json::json!({
                                                    "access_token": fake_jwt(&server_url, &config.subject, chrono::Utc::now().timestamp() + 3600, &format!("at-{n}")),
                                                });
                                                if !config.omit_expires_in {
                                                    grant["expires_in"] = 3600.into();
                                                }
                                                if config.rotate {
                                                    state.valid_refresh_tokens.remove(&presented);
                                                    let rotated = format!("rotated-refresh-{n}");
                                                    state.valid_refresh_tokens.insert(rotated.clone());
                                                    grant["refresh_token"] = rotated.into();
                                                }
                                                (200, grant.to_string())
                                            }
                                        }
                                        _ => (404, "{}".to_string()),
                                    };
                                    Ok::<_, Infallible>(
                                        hyper::Response::builder()
                                            .status(status)
                                            .header("content-type", "application/json")
                                            .body(http_body_util::Full::new(bytes::Bytes::from(body)))
                                            .unwrap(),
                                    )
                                }
                            });
                            let _ = hyper::server::conn::http1::Builder::new()
                                .serve_connection(io, service)
                                .await;
                        });
                    }
                }
            }
        });

        FakeIssuer {
            url,
            exchange_count,
            _shutdown: shutdown_tx,
        }
    }

    fn url_form_value(body: &[u8], key: &str) -> String {
        reqwest::Url::parse(&format!(
            "http://form.invalid/?{}",
            String::from_utf8_lossy(body)
        ))
        .ok()
        .and_then(|url| {
            url.query_pairs()
                .find(|(name, _)| name == key)
                .map(|(_, value)| value.into_owned())
        })
        .unwrap_or_default()
    }

    pub(crate) fn binding_for(issuer: &str) -> CacheBinding {
        CacheBinding {
            cloud_origin: "https://cloud.example".to_string(),
            issuer: issuer.to_string(),
            client_id: "client-123".to_string(),
        }
    }

    /// Write an already-expired cache bound to [`binding_for`]`(issuer)`.
    pub(crate) fn write_expired_cache(path: &Path, issuer: &str, subject: Option<&str>) {
        RefreshTokenCache {
            cloud_origin: "https://cloud.example".to_string(),
            issuer: issuer.to_string(),
            client_id: "client-123".to_string(),
            scope: None,
            subject: subject.map(str::to_string),
            access_token: "stale-access-token".to_string(),
            refresh_token: SEED_REFRESH_TOKEN.to_string(),
            expires_at: absolute_expiry(0),
        }
        .save(path)
        .unwrap();
    }

    pub(crate) fn loopback_client(path: &Path, issuer: &str) -> OidcRefreshClient {
        OidcRefreshClient::new(
            path.to_path_buf(),
            binding_for(issuer),
            IssuerTransport::AllowLoopbackHttp,
        )
        .unwrap()
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::*;
    use super::*;
    use std::sync::atomic::Ordering;

    fn sample_cache(expires_at: &str) -> RefreshTokenCache {
        RefreshTokenCache {
            cloud_origin: "https://cloud.example".to_string(),
            issuer: "https://issuer.example/api/auth".to_string(),
            client_id: "client-123".to_string(),
            scope: Some("openid profile".to_string()),
            subject: Some("user-1".to_string()),
            access_token: "at-1".to_string(),
            refresh_token: "rt-1".to_string(),
            expires_at: expires_at.to_string(),
        }
    }

    fn options(issuer: Option<&str>, path: &Path) -> OidcRefreshOptions {
        OidcRefreshOptions {
            cache_path: Some(path.to_path_buf()),
            issuer: issuer.map(str::to_string),
            client_id: issuer.map(|_| "client-123".to_string()),
            scope: None,
            allow_loopback_http: false,
        }
    }

    // -- cache file ---------------------------------------------------------

    #[test]
    fn cache_round_trip_preserves_all_fields() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cache.json");
        let cache = sample_cache(&absolute_expiry(3600));
        cache.save(&path).unwrap();
        let loaded = RefreshTokenCache::load(&path).unwrap().unwrap();
        assert_eq!(loaded, cache);
    }

    #[test]
    fn cache_save_sets_exactly_0600() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("cache.json");
        sample_cache(&absolute_expiry(3600)).save(&path).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600, "cache file must be 0600");
        }
    }

    #[test]
    fn missing_cache_file_is_none_not_error() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("does-not-exist.json");
        assert!(RefreshTokenCache::load(&path).unwrap().is_none());
    }

    #[test]
    fn malformed_cache_file_is_an_error_that_does_not_echo_contents() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cache.json");
        std::fs::write(
            &path,
            r#"{"refresh_token": 1, "leak": "secret-looking-value"}"#,
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        }
        let err = RefreshTokenCache::load(&path).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
        assert!(!err.to_string().contains("secret-looking-value"));
    }

    #[cfg(unix)]
    #[test]
    fn wide_permission_cache_file_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cache.json");
        sample_cache(&absolute_expiry(3600)).save(&path).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        let err = RefreshTokenCache::load(&path).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::PermissionDenied);
    }

    #[test]
    fn debug_output_redacts_tokens_and_subject() {
        let rendered = format!("{:?}", sample_cache(&absolute_expiry(3600)));
        assert!(!rendered.contains("at-1"));
        assert!(!rendered.contains("rt-1"));
        assert!(!rendered.contains("user-1"));
    }

    #[test]
    fn needs_refresh_false_well_before_expiry() {
        assert!(!needs_refresh(&absolute_expiry(3600)));
    }

    #[test]
    fn needs_refresh_true_within_skew() {
        assert!(needs_refresh(&absolute_expiry(10)));
    }

    #[test]
    fn needs_refresh_true_when_unparseable() {
        assert!(needs_refresh("not-a-timestamp"));
    }

    #[test]
    fn default_cache_path_is_keyed_by_cloud_origin() {
        let a = default_cache_path("https://preview.runt.run");
        let b = default_cache_path("https://app.runt.run");
        assert_ne!(a, b);
        assert_eq!(a, default_cache_path("https://preview.runt.run"));
    }

    // -- URL policy ---------------------------------------------------------

    #[test]
    fn cloud_origin_normalizes_to_scheme_host_port() {
        assert_eq!(
            cloud_origin("https://Preview.Runt.Run/some/path?x=1").unwrap(),
            "https://preview.runt.run"
        );
        assert_eq!(
            cloud_origin("http://127.0.0.1:8787/").unwrap(),
            "http://127.0.0.1:8787"
        );
        assert!(cloud_origin("not a url").is_err());
    }

    #[test]
    fn issuer_policy_requires_https_with_explicit_loopback_exception() {
        use IssuerTransport::*;
        assert!(validate_issuer("https://auth.anaconda.com/api/auth", HttpsOnly).is_ok());
        assert!(validate_issuer("http://auth.anaconda.com/api/auth", HttpsOnly).is_err());
        assert!(validate_issuer("http://auth.anaconda.com/api/auth", AllowLoopbackHttp).is_err());
        for local in [
            "http://localhost:5173/dev/oidc",
            "http://127.0.0.1:8787/dev/oidc",
            "http://[::1]:8787/dev/oidc",
        ] {
            let err = validate_issuer(local, HttpsOnly).unwrap_err();
            assert!(err.to_string().contains("--oidc-allow-loopback-http"));
            assert!(validate_issuer(local, AllowLoopbackHttp).is_ok(), "{local}");
        }
        for bad in [
            "https://user:pass@auth.example",
            "https://auth.example/?q=1",
            "https://auth.example/#frag",
            "ftp://auth.example",
        ] {
            assert!(validate_issuer(bad, AllowLoopbackHttp).is_err(), "{bad}");
        }
    }

    #[test]
    fn token_endpoint_must_share_the_issuer_origin() {
        let issuer = reqwest::Url::parse("https://auth.example/api/auth").unwrap();
        assert!(validate_token_endpoint("https://auth.example/api/auth/token", &issuer).is_ok());
        assert!(validate_token_endpoint("https://evil.example/token", &issuer).is_err());
        assert!(validate_token_endpoint("http://auth.example/token", &issuer).is_err());
        assert!(validate_token_endpoint("https://auth.example:8443/token", &issuer).is_err());
        assert!(validate_token_endpoint("https://u:p@auth.example/token", &issuer).is_err());
    }

    // -- bootstrap / binding -----------------------------------------------

    #[test]
    fn no_cache_no_seed_no_flags_keeps_static_token_and_writes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cache.json");
        // Without flags or a seed no cache path is resolved at all, so even a
        // cache at the default location is ignored and the URL is not parsed
        // (the transport accepts `wss://` cloud URLs).
        for cloud_url in ["https://cloud.example", "wss://cloud.example"] {
            assert!(
                prepare_refresh_client(&OidcRefreshOptions::default(), cloud_url, "tok", None)
                    .unwrap()
                    .is_none()
            );
            assert!(prepare_refresh_client(
                &OidcRefreshOptions::default(),
                cloud_url,
                "tok",
                Some("  ")
            )
            .unwrap()
            .is_none());
        }
        assert!(!path.exists());
    }

    #[test]
    fn refresh_flags_without_cache_or_seed_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cache.json");
        let err = prepare_refresh_client(
            &options(Some("https://auth.example"), &path),
            "https://cloud.example",
            "tok",
            None,
        )
        .err()
        .unwrap();
        assert_eq!(err.kind(), io::ErrorKind::NotFound);
        assert!(err.to_string().contains(CLOUD_REFRESH_TOKEN_ENV));
    }

    #[test]
    fn seeding_requires_issuer_and_client_id() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cache.json");
        let err = prepare_refresh_client(
            &options(None, &path),
            "https://cloud.example",
            "tok",
            Some("seed"),
        )
        .err()
        .unwrap();
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
        assert!(!path.exists());
    }

    #[test]
    fn seeding_rejects_non_https_issuer_without_writing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cache.json");
        for issuer in ["http://auth.example", "http://127.0.0.1:9/dev/oidc"] {
            assert!(prepare_refresh_client(
                &options(Some(issuer), &path),
                "https://cloud.example",
                "tok",
                Some("seed"),
            )
            .is_err());
            assert!(!path.exists(), "{issuer}");
        }
    }

    #[test]
    fn seeding_writes_a_bound_0600_cache_from_the_initial_token() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cache.json");
        let issuer = "https://auth.example/api/auth";
        let exp = chrono::Utc::now().timestamp() + 1800;
        let initial = fake_jwt(issuer, "user-1", exp, "seed");

        let client = prepare_refresh_client(
            &options(Some(issuer), &path),
            "https://Cloud.Example/n/abc",
            &initial,
            Some("  seed-refresh  "),
        )
        .unwrap();
        assert!(client.is_some());

        let cache = RefreshTokenCache::load(&path).unwrap().unwrap();
        assert_eq!(cache.cloud_origin, "https://cloud.example");
        assert_eq!(cache.issuer, issuer);
        assert_eq!(cache.client_id, "client-123");
        assert_eq!(cache.subject.as_deref(), Some("user-1"));
        assert_eq!(cache.refresh_token, "seed-refresh");
        assert_eq!(cache.access_token, initial);
        let recorded = chrono::DateTime::parse_from_rfc3339(&cache.expires_at).unwrap();
        assert_eq!(recorded.timestamp(), exp);
    }

    #[test]
    fn seeding_with_an_opaque_token_schedules_an_immediate_refresh() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cache.json");
        prepare_refresh_client(
            &options(Some("https://auth.example"), &path),
            "https://cloud.example",
            "opaque-token",
            Some("seed"),
        )
        .unwrap()
        .unwrap();
        let cache = RefreshTokenCache::load(&path).unwrap().unwrap();
        assert!(cache.subject.is_none());
        assert!(needs_refresh(&cache.expires_at));
    }

    #[test]
    fn seeding_rejects_an_initial_token_from_another_issuer() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cache.json");
        let initial = fake_jwt("https://other.example", "user-1", 0, "x");
        let err = prepare_refresh_client(
            &options(Some("https://auth.example"), &path),
            "https://cloud.example",
            &initial,
            Some("seed"),
        )
        .err()
        .unwrap();
        assert_eq!(err.kind(), io::ErrorKind::PermissionDenied);
        assert!(!path.exists());
    }

    #[test]
    fn existing_cache_is_kept_when_a_seed_is_also_present() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cache.json");
        let mut cache = sample_cache(&absolute_expiry(3600));
        cache.subject = None;
        cache.save(&path).unwrap();
        prepare_refresh_client(
            &options(None, &path),
            "https://cloud.example",
            "tok",
            Some("newer-seed"),
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            RefreshTokenCache::load(&path)
                .unwrap()
                .unwrap()
                .refresh_token,
            "rt-1"
        );
    }

    #[test]
    fn existing_cache_for_another_cloud_or_issuer_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cache.json");
        sample_cache(&absolute_expiry(3600)).save(&path).unwrap();

        let err = prepare_refresh_client(
            &options(None, &path),
            "https://other-cloud.example",
            "tok",
            None,
        )
        .err()
        .unwrap();
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
        assert!(err.to_string().contains("notebook cloud origin"));

        let err = prepare_refresh_client(
            &options(Some("https://auth.other.example"), &path),
            "https://cloud.example",
            "tok",
            None,
        )
        .err()
        .unwrap();
        assert!(err.to_string().contains("issuer"));
    }

    #[test]
    fn existing_cache_rejects_a_cloud_token_for_another_account() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cache.json");
        let cache = sample_cache(&absolute_expiry(3600));
        cache.save(&path).unwrap();
        let other = fake_jwt(&cache.issuer, "user-2", 0, "x");
        let err =
            prepare_refresh_client(&options(None, &path), "https://cloud.example", &other, None)
                .err()
                .unwrap();
        assert_eq!(err.kind(), io::ErrorKind::PermissionDenied);
        assert!(!err.to_string().contains("user-2"));
    }

    #[test]
    fn existing_cache_with_loopback_http_issuer_needs_the_opt_in() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cache.json");
        let mut cache = sample_cache(&absolute_expiry(3600));
        cache.issuer = "http://127.0.0.1:9/dev/oidc".to_string();
        cache.save(&path).unwrap();
        let mut opts = options(None, &path);
        assert!(prepare_refresh_client(&opts, "https://cloud.example", "tok", None).is_err());
        opts.allow_loopback_http = true;
        assert!(
            prepare_refresh_client(&opts, "https://cloud.example", "tok", None)
                .unwrap()
                .is_some()
        );
    }

    // -- refresh against a fake issuer --------------------------------------

    #[tokio::test]
    async fn refresh_or_reuse_exchanges_exactly_once_when_expired_then_reuses_cache() {
        let issuer = start_fake_issuer(FakeIssuerConfig::default()).await;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cache.json");
        write_expired_cache(&path, &issuer.url, None);
        let client = loopback_client(&path, &issuer.url);

        let token = client.refresh_or_reuse().await.unwrap();
        assert_ne!(token, "stale-access-token");
        assert_eq!(issuer.exchange_count.load(Ordering::SeqCst), 1);

        let token_again = client.refresh_or_reuse().await.unwrap();
        assert_eq!(token_again, token);
        assert_eq!(issuer.exchange_count.load(Ordering::SeqCst), 1);

        // The account is pinned after the first refresh.
        let cache = RefreshTokenCache::load(&path).unwrap().unwrap();
        assert_eq!(cache.subject.as_deref(), Some("user-1"));
    }

    #[tokio::test]
    async fn into_token_refresher_produces_a_working_closure() {
        let issuer = start_fake_issuer(FakeIssuerConfig::default()).await;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cache.json");
        write_expired_cache(&path, &issuer.url, None);

        let refresher = loopback_client(&path, &issuer.url).into_token_refresher();
        let token = refresher().await.unwrap();
        assert_ne!(token, "stale-access-token");
    }

    #[tokio::test]
    async fn rotating_issuer_sequential_refreshes_use_the_persisted_token() {
        let issuer = start_fake_issuer(FakeIssuerConfig {
            rotate: true,
            ..Default::default()
        })
        .await;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cache.json");
        write_expired_cache(&path, &issuer.url, None);
        let client = loopback_client(&path, &issuer.url);

        client.refresh_or_reuse().await.unwrap();
        let mut cache = RefreshTokenCache::load(&path).unwrap().unwrap();
        assert_eq!(cache.refresh_token, "rotated-refresh-1");

        // Expire again; the issuer rejects the spent seed, so success proves
        // the rotated token was persisted and used.
        cache.expires_at = absolute_expiry(0);
        cache.save(&path).unwrap();
        client.refresh_or_reuse().await.unwrap();
        assert_eq!(
            RefreshTokenCache::load(&path)
                .unwrap()
                .unwrap()
                .refresh_token,
            "rotated-refresh-2"
        );
        assert_eq!(issuer.exchange_count.load(Ordering::SeqCst), 2);
    }

    async fn rotating_issuer_with_expired_cache() -> (FakeIssuer, tempfile::TempDir, PathBuf) {
        let issuer = start_fake_issuer(FakeIssuerConfig {
            rotate: true,
            token_delay: Some(Duration::from_millis(100)),
            ..Default::default()
        })
        .await;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cache.json");
        write_expired_cache(&path, &issuer.url, None);
        (issuer, dir, path)
    }

    #[tokio::test]
    async fn rotating_issuer_concurrent_tasks_spend_the_token_once() {
        let (issuer, _dir, path) = rotating_issuer_with_expired_cache().await;
        // Clones share the in-process semaphore.
        let client = loopback_client(&path, &issuer.url);
        let (second, third) = (client.clone(), client.clone());
        let (a, b, c) = tokio::join!(
            client.refresh_or_reuse(),
            second.refresh_or_reuse(),
            third.refresh_or_reuse()
        );
        let (a, b, c) = (a.unwrap(), b.unwrap(), c.unwrap());
        assert_eq!(a, b);
        assert_eq!(b, c);
        assert_eq!(issuer.exchange_count.load(Ordering::SeqCst), 1);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn rotating_issuer_concurrent_processes_spend_the_token_once() {
        let (issuer, _dir, path) = rotating_issuer_with_expired_cache().await;
        // Independent clients have independent semaphores, standing in for
        // separate agent processes that share only the cache file and lock.
        let first = loopback_client(&path, &issuer.url);
        let second = loopback_client(&path, &issuer.url);
        let (a, b) = tokio::join!(first.refresh_or_reuse(), second.refresh_or_reuse());
        assert_eq!(a.unwrap(), b.unwrap());
        assert_eq!(issuer.exchange_count.load(Ordering::SeqCst), 1);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn refresh_gives_up_when_another_process_holds_the_lock_too_long() {
        let issuer = start_fake_issuer(FakeIssuerConfig::default()).await;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cache.json");
        write_expired_cache(&path, &issuer.url, None);
        let _held = CacheFileLock::acquire(&lock_sibling_path(&path), Duration::ZERO)
            .await
            .unwrap();

        let client = OidcRefreshClient::with_limits(
            path.clone(),
            binding_for(&issuer.url),
            IssuerTransport::AllowLoopbackHttp,
            OIDC_CONNECT_TIMEOUT,
            OIDC_REQUEST_TIMEOUT,
            Duration::from_millis(100),
        )
        .unwrap();
        let err = client.refresh_or_reuse().await.unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::TimedOut);
        assert_eq!(issuer.exchange_count.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn hung_token_endpoint_times_out_instead_of_blocking_reconnect() {
        let issuer = start_fake_issuer(FakeIssuerConfig {
            token_delay: Some(Duration::from_secs(30)),
            ..Default::default()
        })
        .await;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cache.json");
        write_expired_cache(&path, &issuer.url, None);
        let client = OidcRefreshClient::with_limits(
            path.clone(),
            binding_for(&issuer.url),
            IssuerTransport::AllowLoopbackHttp,
            Duration::from_millis(200),
            Duration::from_millis(200),
            CACHE_LOCK_WAIT,
        )
        .unwrap();

        let result = tokio::time::timeout(Duration::from_secs(5), client.refresh_or_reuse())
            .await
            .expect("refresh must be bounded by the request timeout");
        assert_eq!(result.unwrap_err().kind(), io::ErrorKind::TimedOut);
        assert_eq!(
            RefreshTokenCache::load(&path)
                .unwrap()
                .unwrap()
                .access_token,
            "stale-access-token"
        );
    }

    #[tokio::test]
    async fn discovery_issuer_mismatch_is_rejected_before_posting_the_refresh_token() {
        let issuer = start_fake_issuer(FakeIssuerConfig {
            discovery_issuer: Some("https://attacker.example".to_string()),
            ..Default::default()
        })
        .await;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cache.json");
        write_expired_cache(&path, &issuer.url, None);
        let err = loopback_client(&path, &issuer.url)
            .refresh_or_reuse()
            .await
            .unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
        assert_eq!(issuer.exchange_count.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn cross_origin_token_endpoint_is_rejected_before_posting_the_refresh_token() {
        let decoy = start_fake_issuer(FakeIssuerConfig::default()).await;
        let issuer = start_fake_issuer(FakeIssuerConfig {
            token_endpoint: Some(format!("{}/token", decoy.url)),
            ..Default::default()
        })
        .await;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cache.json");
        write_expired_cache(&path, &issuer.url, None);
        let err = loopback_client(&path, &issuer.url)
            .refresh_or_reuse()
            .await
            .unwrap_err();
        assert!(err.to_string().contains("issuer's origin"));
        assert_eq!(decoy.exchange_count.load(Ordering::SeqCst), 0);
        assert_eq!(issuer.exchange_count.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn refreshed_token_for_another_account_is_rejected_and_not_persisted() {
        let issuer = start_fake_issuer(FakeIssuerConfig {
            subject: "user-2".to_string(),
            ..Default::default()
        })
        .await;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cache.json");
        write_expired_cache(&path, &issuer.url, Some("user-1"));
        let err = loopback_client(&path, &issuer.url)
            .refresh_or_reuse()
            .await
            .unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::PermissionDenied);
        assert_eq!(
            RefreshTokenCache::load(&path)
                .unwrap()
                .unwrap()
                .access_token,
            "stale-access-token"
        );
    }

    #[tokio::test]
    async fn cache_swapped_to_another_binding_is_rejected_at_refresh() {
        let issuer = start_fake_issuer(FakeIssuerConfig::default()).await;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cache.json");
        write_expired_cache(&path, &issuer.url, None);
        let mut binding = binding_for(&issuer.url);
        binding.cloud_origin = "https://other-cloud.example".to_string();
        let client =
            OidcRefreshClient::new(path, binding, IssuerTransport::AllowLoopbackHttp).unwrap();
        let err = client.refresh_or_reuse().await.unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
        assert_eq!(issuer.exchange_count.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn invalid_grant_is_reported_by_code_only() {
        let issuer = start_fake_issuer(FakeIssuerConfig::default()).await;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cache.json");
        write_expired_cache(&path, &issuer.url, None);
        let mut cache = RefreshTokenCache::load(&path).unwrap().unwrap();
        cache.refresh_token = "unknown-refresh-token-value".to_string();
        cache.save(&path).unwrap();
        let err = loopback_client(&path, &issuer.url)
            .refresh_or_reuse()
            .await
            .unwrap_err();
        let message = err.to_string();
        assert!(message.contains("invalid_grant"), "{message}");
        assert!(!message.contains("unknown-refresh-token-value"));
    }

    #[test]
    fn save_new_never_replaces_an_existing_cache() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cache.json");
        let first = sample_cache(&absolute_expiry(3600));
        let mut second = first.clone();
        second.refresh_token = "spent-seed".to_string();
        assert!(first.save_new(&path).unwrap());
        assert!(!second.save_new(&path).unwrap());
        assert_eq!(RefreshTokenCache::load(&path).unwrap().unwrap(), first);
        let leftovers: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_name().to_string_lossy().contains(".tmp-"))
            .collect();
        assert!(leftovers.is_empty(), "temp files must be cleaned up");
    }

    #[tokio::test]
    async fn concurrent_callers_share_one_failed_attempt_against_a_hung_issuer() {
        let issuer = start_fake_issuer(FakeIssuerConfig {
            token_delay: Some(Duration::from_secs(30)),
            ..Default::default()
        })
        .await;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cache.json");
        write_expired_cache(&path, &issuer.url, None);
        let client = OidcRefreshClient::with_limits(
            path,
            binding_for(&issuer.url),
            IssuerTransport::AllowLoopbackHttp,
            Duration::from_millis(500),
            Duration::from_millis(500),
            CACHE_LOCK_WAIT,
        )
        .unwrap();
        let (second, third) = (client.clone(), client.clone());
        let (a, b, c) = tokio::time::timeout(Duration::from_secs(5), async {
            tokio::join!(
                client.refresh_or_reuse(),
                second.refresh_or_reuse(),
                third.refresh_or_reuse()
            )
        })
        .await
        .expect("queued callers must not each wait out their own timeout");
        assert!(a.is_err() && b.is_err() && c.is_err());
        assert!(client.refresh_or_reuse().await.is_err());
        // One attempt at most; zero only if discovery itself timed out.
        assert!(issuer.exchange_count.load(Ordering::SeqCst) <= 1);
    }

    #[tokio::test]
    async fn refresh_failure_falls_back_to_an_unexpired_cached_token() {
        let issuer = start_fake_issuer(FakeIssuerConfig {
            discovery_issuer: Some("https://attacker.example".to_string()),
            ..Default::default()
        })
        .await;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cache.json");
        write_expired_cache(&path, &issuer.url, None);
        let mut cache = RefreshTokenCache::load(&path).unwrap().unwrap();
        cache.expires_at = absolute_expiry(30); // inside the skew, not expired
        cache.save(&path).unwrap();

        let token = loopback_client(&path, &issuer.url)
            .refresh_or_reuse()
            .await
            .unwrap();
        assert_eq!(token, "stale-access-token");
    }

    #[tokio::test]
    async fn slow_issuer_does_not_hold_a_caller_with_an_unexpired_token() {
        let issuer = start_fake_issuer(FakeIssuerConfig {
            token_delay: Some(Duration::from_secs(10)),
            ..Default::default()
        })
        .await;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cache.json");
        write_expired_cache(&path, &issuer.url, None);
        let mut cache = RefreshTokenCache::load(&path).unwrap().unwrap();
        cache.expires_at = absolute_expiry(30); // inside the skew, not expired
        cache.save(&path).unwrap();

        let started = tokio::time::Instant::now();
        let token = loopback_client(&path, &issuer.url)
            .refresh_or_reuse()
            .await
            .unwrap();
        assert_eq!(token, "stale-access-token");
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[tokio::test]
    async fn cancelled_refresh_still_persists_the_rotated_token() {
        let issuer = start_fake_issuer(FakeIssuerConfig {
            rotate: true,
            token_delay: Some(Duration::from_millis(300)),
            ..Default::default()
        })
        .await;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cache.json");
        write_expired_cache(&path, &issuer.url, None);
        let client = loopback_client(&path, &issuer.url);

        // Drop the caller while the issuer is still answering.
        assert!(
            tokio::time::timeout(Duration::from_millis(50), client.refresh_or_reuse())
                .await
                .is_err()
        );
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        loop {
            let cache = RefreshTokenCache::load(&path).unwrap().unwrap();
            if cache.refresh_token == "rotated-refresh-1" {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "rotated refresh token was never persisted"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        // Expire again: the rotated token works, the spent seed would not.
        let mut cache = RefreshTokenCache::load(&path).unwrap().unwrap();
        cache.expires_at = absolute_expiry(0);
        cache.save(&path).unwrap();
        client.refresh_or_reuse().await.unwrap();
        assert_eq!(issuer.exchange_count.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn grant_without_expires_in_uses_the_access_token_exp() {
        let issuer = start_fake_issuer(FakeIssuerConfig {
            omit_expires_in: true,
            ..Default::default()
        })
        .await;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cache.json");
        write_expired_cache(&path, &issuer.url, None);
        loopback_client(&path, &issuer.url)
            .refresh_or_reuse()
            .await
            .unwrap();
        let cache = RefreshTokenCache::load(&path).unwrap().unwrap();
        let expires = chrono::DateTime::parse_from_rfc3339(&cache.expires_at)
            .unwrap()
            .timestamp();
        let expected = chrono::Utc::now().timestamp() + 3600;
        assert!((expires - expected).abs() <= 5, "{expires} vs {expected}");
    }

    #[tokio::test]
    async fn refresh_or_reuse_surfaces_io_error_without_panicking_when_no_cache() {
        let dir = tempfile::tempdir().unwrap();
        let client = loopback_client(&dir.path().join("missing.json"), "http://127.0.0.1:1");
        let err = client.refresh_or_reuse().await.unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::NotFound);
    }

    #[tokio::test]
    async fn error_messages_never_contain_the_refresh_token_value() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cache.json");
        let issuer = "http://127.0.0.1:1"; // nothing listens here
        write_expired_cache(&path, issuer, None);
        let mut cache = RefreshTokenCache::load(&path).unwrap().unwrap();
        cache.refresh_token = "super-secret-refresh-token-value".to_string();
        cache.save(&path).unwrap();

        let err = loopback_client(&path, issuer)
            .refresh_or_reuse()
            .await
            .unwrap_err();
        assert!(!err.to_string().contains("super-secret-refresh-token-value"));
    }
}
