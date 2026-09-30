//! OIDC discovery + `refresh_token` grant client, and the on-disk
//! [`RefreshTokenCache`] that lets a long-lived `--auth-kind oidc`
//! `cloud-runtime-agent` refresh its access token before it expires instead
//! of holding a static token for its whole process lifetime.
//!
//! This is the fresh-token source wired into
//! [`notebook_cloud_transport::TokenRefresher`]
//! (`crates/notebook-cloud-transport/src/lib.rs:143-147`) via
//! [`OidcRefreshClient::into_token_refresher`]. The transport calls the
//! refresher before every connect/reconnect
//! (`CloudWsFrameTransport::effective_auth`); this module only has to answer
//! "what's the bearer token right now", refreshing it first when needed.
//!
//! `workstation` (`nwc_`), `anaconda-key`, and `dev` credentials never go
//! through this module — they don't expire (see
//! `docs/adr/hosted-credential-transport.md:368`), so `cloud_agent_cli.rs`
//! only constructs an [`OidcRefreshClient`] for `--auth-kind oidc`.

use std::future::Future;
use std::io;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};

/// Safety skew applied before an access token's recorded expiry: refresh at
/// or before this many seconds remain, not only after outright expiry, so a
/// connect attempt never races a token that is about to lapse mid-handshake.
const REFRESH_SKEW: Duration = Duration::from_secs(60);

/// On-disk cache for a single OIDC-refreshable credential. Written with mode
/// `0600`.
///
/// `issuer`/`client_id`/`scope` are stored alongside the token pair so the
/// cache file is self-describing: the agent needs no new required CLI flag
/// or env var beyond the cache path to know where/how to refresh.
///
/// No derived `Debug`: `access_token`/`refresh_token` must never appear in
/// a log line, and a derived `Debug` would print them in full the moment
/// anything formats this struct with `{:?}`.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RefreshTokenCache {
    /// OIDC issuer base URL, e.g. `https://auth.stage.anaconda.com/api/auth`.
    pub issuer: String,
    /// Public OAuth client id (no secret involved).
    pub client_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    pub access_token: String,
    pub refresh_token: String,
    /// RFC 3339 (UTC) absolute expiry of `access_token`.
    pub expires_at: String,
}

impl std::fmt::Debug for RefreshTokenCache {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RefreshTokenCache")
            .field("issuer", &self.issuer)
            .field("client_id", &self.client_id)
            .field("scope", &self.scope)
            .field("access_token", &"[REDACTED]")
            .field("refresh_token", &"[REDACTED]")
            .field("expires_at", &self.expires_at)
            .finish()
    }
}

impl RefreshTokenCache {
    /// Load the cache at `path`. Returns `None` — never an error — for a
    /// missing file, an unreadable file, a file with permissions wider than
    /// owner-only, or a file that fails to parse all required fields.
    /// "No cache available" is not a fatal condition for the `oidc` auth
    /// kind — the caller falls back to the existing static-token behavior.
    ///
    /// The permission check and the content read happen against the same
    /// open file handle (not two separate path-based calls), so there is no
    /// window between checking the mode and reading the bytes for a
    /// concurrent rename/symlink swap to substitute a different file.
    pub fn load(path: &Path) -> Option<RefreshTokenCache> {
        let mut file = std::fs::File::open(path).ok()?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = file.metadata().ok()?.permissions().mode();
            if mode & 0o777 != 0o600 {
                tracing::debug!(
                    path = %path.display(),
                    "oidc refresh cache has non-0600 permissions; treating as unavailable"
                );
                return None;
            }
        }
        let mut contents = String::new();
        {
            use std::io::Read;
            file.read_to_string(&mut contents).ok()?;
        }
        match serde_json::from_str(&contents) {
            Ok(cache) => Some(cache),
            Err(_) => {
                tracing::debug!(
                    path = %path.display(),
                    "oidc refresh cache failed to parse; treating as unavailable"
                );
                None
            }
        }
    }

    /// Persist the cache atomically (write to a temp file in the same
    /// directory, then rename) with mode `0600`. A crash between exchange
    /// and persist can't strand a half-updated cache (old access token
    /// paired with an already-rotated refresh token).
    ///
    /// The temp file is created at mode `0600` from the moment it exists —
    /// never at a wider, umask-dependent mode that a later `chmod` would
    /// only narrow after the secret was already written — and is removed
    /// on any failure so a partially written credential file is never left
    /// behind at any permission.
    pub fn save(&self, path: &Path) -> io::Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let json = serde_json::to_string_pretty(self)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
        let tmp_path = tmp_sibling_path(path);
        let write_result = write_owner_only(&tmp_path, json.as_bytes());
        if let Err(e) = write_result {
            let _ = std::fs::remove_file(&tmp_path);
            return Err(e);
        }
        if let Err(e) = std::fs::rename(&tmp_path, path) {
            let _ = std::fs::remove_file(&tmp_path);
            return Err(e);
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
    Ok(())
}

fn tmp_sibling_path(path: &Path) -> PathBuf {
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("oidc-refresh.json");
    path.with_file_name(format!(".{file_name}.tmp-{}", std::process::id()))
}

/// Default cache file location, delegating to
/// [`runt_workspace::config_or_dev_file`] — the same shared dev/production
/// path convention `workstation_credentials_path` (`workstation.json`) uses,
/// so this cannot drift from that convention independently.
pub fn default_cache_path() -> PathBuf {
    runt_workspace::config_or_dev_file("oidc-refresh.json")
}

/// The one discovery-document field this module needs. Browser OIDC clients
/// also parse `authorization_endpoint`, but nothing here needs it (no
/// authorization-code flow in a headless agent), so it's not carried.
#[derive(Debug, Clone)]
pub struct OidcDiscovery {
    pub token_endpoint: String,
}

#[derive(Debug, Clone, Deserialize)]
struct OidcDiscoveryResponse {
    #[serde(default)]
    token_endpoint: Option<String>,
}

fn discovery_url(issuer: &str) -> String {
    format!(
        "{}/.well-known/openid-configuration",
        issuer.trim_end_matches('/')
    )
}

/// `GET {issuer}/.well-known/openid-configuration`. A non-2xx response or a
/// response missing/non-string `token_endpoint` returns an `io::Error`,
/// never a guessed URL.
pub async fn discover(client: &reqwest::Client, issuer: &str) -> io::Result<OidcDiscovery> {
    let url = discovery_url(issuer);
    let response = client
        .get(&url)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| io::Error::other(format!("oidc discovery request failed: {e}")))?;
    if !response.status().is_success() {
        return Err(io::Error::other(format!(
            "oidc discovery failed with status {}",
            response.status()
        )));
    }
    let body: OidcDiscoveryResponse = response.json().await.map_err(|e| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("oidc discovery response was not valid JSON: {e}"),
        )
    })?;
    let token_endpoint = body.token_endpoint.ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "oidc discovery response missing token_endpoint",
        )
    })?;
    Ok(OidcDiscovery { token_endpoint })
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
    pub expires_in: i64,
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

/// `POST {token_endpoint}` with `grant_type=refresh_token`, `client_id`,
/// `refresh_token`, and `scope` only if `Some` — no `client_secret` (public
/// client, mirroring `exchangeRefreshToken` in
/// `apps/notebook-cloud/viewer/oidc-auth.ts:529-562`). A non-2xx or
/// malformed response returns an `io::Error`, never a partial/default
/// [`RefreshGrantResponse`].
pub async fn exchange_refresh_token(
    client: &reqwest::Client,
    token_endpoint: &str,
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
        .post(token_endpoint)
        .header("Accept", "application/json")
        .form(&form)
        .send()
        .await
        .map_err(|e| io::Error::other(format!("oidc token refresh request failed: {e}")))?;
    if !response.status().is_success() {
        return Err(io::Error::other(format!(
            "oidc token refresh failed with status {}",
            response.status()
        )));
    }
    response.json().await.map_err(|e| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("oidc token refresh response was not valid JSON: {e}"),
        )
    })
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

/// Fresh-token source for a `TokenRefresher`: checks a cached access
/// token's expiry, exchanges the refresh token when needed, and persists
/// the result — bounded to one in-flight exchange at a time so two
/// concurrent connect attempts cannot both spend the same (possibly
/// rotating) refresh token.
///
/// Concurrency is bounded with a [`tokio::sync::Semaphore`], not a
/// `Mutex`/`RwLock`: a semaphore permit is designed to be held across
/// `.await` points (that's what it's for), whereas holding a `Mutex`/
/// `RwLock` guard across `.await` risks deadlock and is forbidden here
/// (checked by `cargo test -p runtimed --test tokio_mutex_lint`).
#[derive(Clone)]
pub struct OidcRefreshClient {
    cache_path: PathBuf,
    http: reqwest::Client,
    single_flight: Arc<tokio::sync::Semaphore>,
}

impl OidcRefreshClient {
    pub fn new(cache_path: PathBuf) -> Self {
        Self {
            cache_path,
            http: reqwest::Client::new(),
            single_flight: Arc::new(tokio::sync::Semaphore::new(1)),
        }
    }

    /// One check-refresh-persist cycle. Returns the bearer token to present
    /// on the next connect: the cached token unchanged if still within the
    /// skew window (zero HTTP calls, zero contention with an unrelated
    /// in-flight refresh), or a freshly exchanged one.
    ///
    /// The semaphore permit is acquired only when a refresh actually looks
    /// necessary, not unconditionally — otherwise every connect attempt
    /// with a perfectly valid cached token would queue behind an unrelated
    /// in-flight refresh's two HTTP round trips for no reason. The check is
    /// repeated once more after acquiring the permit (double-checked)
    /// because another task may have just finished refreshing while this
    /// one was waiting.
    async fn refresh_or_reuse(&self) -> io::Result<String> {
        let cache = RefreshTokenCache::load(&self.cache_path).ok_or_else(|| {
            io::Error::new(io::ErrorKind::NotFound, "no oidc refresh cache available")
        })?;
        if !needs_refresh(&cache.expires_at) {
            return Ok(cache.access_token);
        }

        let _permit = self.single_flight.acquire().await.map_err(|e| {
            io::Error::other(format!("oidc refresh single-flight semaphore closed: {e}"))
        })?;

        // Re-check: whoever held the permit before us may have already
        // refreshed while we were waiting to acquire it.
        let cache = RefreshTokenCache::load(&self.cache_path).ok_or_else(|| {
            io::Error::new(io::ErrorKind::NotFound, "no oidc refresh cache available")
        })?;
        if !needs_refresh(&cache.expires_at) {
            return Ok(cache.access_token);
        }

        let discovery = discover(&self.http, &cache.issuer).await?;
        let grant = exchange_refresh_token(
            &self.http,
            &discovery.token_endpoint,
            &cache.client_id,
            &cache.refresh_token,
            cache.scope.as_deref(),
        )
        .await?;

        let updated = RefreshTokenCache {
            issuer: cache.issuer,
            client_id: cache.client_id,
            scope: cache.scope,
            access_token: grant.access_token.clone(),
            refresh_token: grant.refresh_token.unwrap_or(cache.refresh_token),
            expires_at: absolute_expiry(grant.expires_in),
        };
        updated.save(&self.cache_path)?;
        tracing::debug!("oidc access token refreshed"); // no token value logged
        Ok(updated.access_token)
    }

    /// Wrap this client into the `Arc<dyn Fn() -> ...>` shape
    /// `CloudWsFrameTransport::with_token_refresher` requires
    /// (`crates/notebook-cloud-transport/src/lib.rs:143-147`). Every failure
    /// path above is already `io::Error`; this never panics.
    pub fn into_token_refresher(self) -> notebook_cloud_transport::TokenRefresher {
        Arc::new(move || {
            let this = self.clone();
            Box::pin(async move { this.refresh_or_reuse().await })
                as Pin<Box<dyn Future<Output = io::Result<String>> + Send>>
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn sample_cache(expires_at: &str) -> RefreshTokenCache {
        RefreshTokenCache {
            issuer: "https://issuer.example/api/auth".to_string(),
            client_id: "client-123".to_string(),
            scope: Some("openid profile".to_string()),
            access_token: "at-1".to_string(),
            refresh_token: "rt-1".to_string(),
            expires_at: expires_at.to_string(),
        }
    }

    #[test]
    fn cache_round_trip_preserves_all_fields() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cache.json");
        let cache = sample_cache(&absolute_expiry(3600));
        cache.save(&path).unwrap();
        let loaded = RefreshTokenCache::load(&path).unwrap();
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
        assert!(RefreshTokenCache::load(&path).is_none());
    }

    #[test]
    fn malformed_cache_file_is_none_not_error() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cache.json");
        std::fs::write(&path, "not json").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        }
        assert!(RefreshTokenCache::load(&path).is_none());
    }

    #[cfg(unix)]
    #[test]
    fn wide_permission_cache_file_is_none_not_error() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cache.json");
        sample_cache(&absolute_expiry(3600)).save(&path).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(RefreshTokenCache::load(&path).is_none());
    }

    #[test]
    fn needs_refresh_false_well_before_expiry() {
        let far_future = absolute_expiry(3600);
        assert!(!needs_refresh(&far_future));
    }

    #[test]
    fn needs_refresh_true_within_skew() {
        let almost_now = absolute_expiry(10); // inside the 60s skew window
        assert!(needs_refresh(&almost_now));
    }

    #[test]
    fn needs_refresh_true_when_unparseable() {
        assert!(needs_refresh("not-a-timestamp"));
    }

    struct FakeIssuer {
        addr: std::net::SocketAddr,
        exchange_count: Arc<AtomicUsize>,
        _shutdown: tokio::sync::oneshot::Sender<()>,
    }

    /// Minimal local HTTP server standing in for an OIDC issuer: serves
    /// discovery and a token endpoint that always returns a fresh grant.
    /// Counts exchanges so tests can assert "exactly one" / "zero" calls.
    async fn start_fake_issuer() -> FakeIssuer {
        use std::convert::Infallible;
        use std::sync::atomic::AtomicUsize;

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let exchange_count = Arc::new(AtomicUsize::new(0));
        let counter = exchange_count.clone();
        let (shutdown_tx, mut shutdown_rx) = tokio::sync::oneshot::channel::<()>();

        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = &mut shutdown_rx => break,
                    accepted = listener.accept() => {
                        let Ok((stream, _)) = accepted else { break };
                        let counter = counter.clone();
                        let addr = addr;
                        tokio::spawn(async move {
                            let io = hyper_util::rt::TokioIo::new(stream);
                            let counter = counter.clone();
                            let service = hyper::service::service_fn(move |req: hyper::Request<hyper::body::Incoming>| {
                                let counter = counter.clone();
                                async move {
                                    let body: String = match req.uri().path() {
                                        "/.well-known/openid-configuration" => format!(
                                            "{{\"authorization_endpoint\":\"http://{addr}/authorize\",\"token_endpoint\":\"http://{addr}/token\"}}"
                                        ),
                                        "/token" => {
                                            counter.fetch_add(1, Ordering::SeqCst);
                                            "{\"access_token\":\"fresh-access-token\",\"refresh_token\":\"fresh-refresh-token\",\"expires_in\":3600}".to_string()
                                        }
                                        _ => "{}".to_string(),
                                    };
                                    Ok::<_, Infallible>(hyper::Response::new(http_body_util::Full::new(bytes::Bytes::from(body))))
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
            addr,
            exchange_count,
            _shutdown: shutdown_tx,
        }
    }

    #[tokio::test]
    async fn refresh_or_reuse_exchanges_exactly_once_when_expired_then_reuses_cache() {
        let issuer = start_fake_issuer().await;
        let issuer_url = format!("http://{}", issuer.addr);

        let dir = tempfile::tempdir().unwrap();
        let cache_path = dir.path().join("cache.json");
        RefreshTokenCache {
            issuer: issuer_url,
            client_id: "client-123".to_string(),
            scope: None,
            access_token: "stale-access-token".to_string(),
            refresh_token: "seed-refresh-token".to_string(),
            expires_at: absolute_expiry(0), // already expired
        }
        .save(&cache_path)
        .unwrap();

        let client = OidcRefreshClient::new(cache_path.clone());

        // First call: expired -> exactly one exchange, returns the fresh token.
        let token = client.refresh_or_reuse().await.unwrap();
        assert_eq!(token, "fresh-access-token");
        assert_eq!(issuer.exchange_count.load(Ordering::SeqCst), 1);

        // Second call: the cache we just wrote is now far in the future ->
        // zero further exchanges, returns the (now cached) fresh token.
        let token_again = client.refresh_or_reuse().await.unwrap();
        assert_eq!(token_again, "fresh-access-token");
        assert_eq!(issuer.exchange_count.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn into_token_refresher_produces_a_working_closure() {
        let issuer = start_fake_issuer().await;
        let issuer_url = format!("http://{}", issuer.addr);

        let dir = tempfile::tempdir().unwrap();
        let cache_path = dir.path().join("cache.json");
        RefreshTokenCache {
            issuer: issuer_url,
            client_id: "client-123".to_string(),
            scope: None,
            access_token: "stale".to_string(),
            refresh_token: "seed".to_string(),
            expires_at: absolute_expiry(0),
        }
        .save(&cache_path)
        .unwrap();

        let refresher = OidcRefreshClient::new(cache_path).into_token_refresher();
        let token = refresher().await.unwrap();
        assert_eq!(token, "fresh-access-token");
    }

    #[tokio::test]
    async fn refresh_or_reuse_surfaces_io_error_without_panicking_when_no_cache() {
        let dir = tempfile::tempdir().unwrap();
        let cache_path = dir.path().join("missing.json");
        let client = OidcRefreshClient::new(cache_path);
        let err = client.refresh_or_reuse().await.unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::NotFound);
    }

    #[tokio::test]
    async fn error_messages_never_contain_the_refresh_token_value() {
        let dir = tempfile::tempdir().unwrap();
        let cache_path = dir.path().join("cache.json");
        RefreshTokenCache {
            issuer: "http://127.0.0.1:1".to_string(), // nothing listens here
            client_id: "client-123".to_string(),
            scope: None,
            access_token: "stale".to_string(),
            refresh_token: "super-secret-refresh-token-value".to_string(),
            expires_at: absolute_expiry(0),
        }
        .save(&cache_path)
        .unwrap();

        let client = OidcRefreshClient::new(cache_path);
        let err = client.refresh_or_reuse().await.unwrap_err();
        assert!(!err.to_string().contains("super-secret-refresh-token-value"));
    }
}
