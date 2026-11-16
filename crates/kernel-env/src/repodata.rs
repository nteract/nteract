//! Shared repodata fetching and solving with offline-first capability.
//!
//! [`solve_with_repodata`] serves Conda and Pixi environments. It solves
//! against the local repodata cache (`ForceCacheOnly`) first. When that cache
//! is missing, or when the solve on cached repodata fails, it fetches from the
//! network (`CacheOrFetch`) and solves once more. A cache entry can be weeks
//! old, so a failed cached solve is not evidence that a package is missing
//! upstream.

#[cfg(feature = "runtime")]
use std::{fmt, future::Future, path::Path, sync::Arc, time::Instant};

#[cfg(feature = "runtime")]
use anyhow::{anyhow, Result};
#[cfg(feature = "runtime")]
use log::info;
#[cfg(feature = "runtime")]
use rattler_conda_types::{Channel, MatchSpec, Subdir};
#[cfg(feature = "runtime")]
use rattler_repodata_gateway::{
    fetch::CacheAction, ChannelConfig, ChannelRelationsMode, Gateway, RepoData, SourceConfig,
};

#[cfg(feature = "runtime")]
use crate::progress::{EnvProgressPhase, ProgressHandler};

/// The inputs for one repodata query.
#[cfg(feature = "runtime")]
pub struct RepodataQuery<'a> {
    /// Conda channels to query.
    pub channels: Vec<Channel>,
    /// Target platforms, usually the solve platform plus `NoArch`.
    pub platforms: Vec<Subdir>,
    /// Package specs to resolve; dependencies are fetched recursively.
    pub specs: Vec<MatchSpec>,
    /// Base rattler cache directory.
    pub rattler_cache_dir: &'a Path,
    /// HTTP client for network fetches.
    pub download_client: reqwest_middleware::ClientWithMiddleware,
    /// Progress handler for events.
    pub handler: Arc<dyn ProgressHandler>,
    /// Label for progress events (`"conda"` or `"pixi"`).
    pub env_type: &'a str,
}

/// Why [`solve_with_repodata`] failed.
#[cfg(feature = "runtime")]
#[derive(Debug)]
pub enum RepodataSolveError<E> {
    /// No usable repodata: the cache missed and the network fetch failed.
    Fetch(anyhow::Error),
    /// The solver rejected the request on the freshest repodata available.
    Solve(E),
}

#[cfg(feature = "runtime")]
impl<E: fmt::Display> fmt::Display for RepodataSolveError<E> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Fetch(e) => write!(f, "{e}"),
            Self::Solve(e) => write!(f, "{e}"),
        }
    }
}

#[cfg(feature = "runtime")]
impl<E: fmt::Debug + fmt::Display> std::error::Error for RepodataSolveError<E> {}

/// Fetch repodata, preferring the local cache, and run `solve` on it.
///
/// 1. Query with `CacheAction::ForceCacheOnly`. On a hit, emit `OfflineHit`
///    and solve.
/// 2. If the cache misses, or the cached solve fails, fetch with the network
///    gateway (with its own transient-error retries) and solve again.
/// 3. If the cached solve failed and the network fetch also fails, return the
///    cached solve's error: offline users keep the solver's explanation.
///
/// `solve` runs at most twice.
#[cfg(feature = "runtime")]
pub async fn solve_with_repodata<T, E>(
    query: RepodataQuery<'_>,
    solve: impl FnMut(&[RepoData]) -> std::result::Result<T, E>,
) -> std::result::Result<T, RepodataSolveError<E>>
where
    E: fmt::Display,
{
    let env_type = query.env_type;
    let mut solve = solve;
    let result = solve_preferring_cache(
        query_cached(&query),
        || query_network(&query),
        env_type,
        |data: &Vec<RepoData>| solve(data),
    )
    .await;
    // Only a fetch error that is returned reaches the banner. After a failed
    // cached solve, the caller reports the solve error instead.
    if let Err(RepodataSolveError::Fetch(e)) = &result {
        query.handler.on_progress(
            env_type,
            EnvProgressPhase::Error {
                message: e.to_string(),
            },
        );
    }
    result
}

/// The cache-then-network control flow, separate from rattler I/O so every
/// branch can be tested.
#[cfg(feature = "runtime")]
async fn solve_preferring_cache<D, T, E, NF>(
    cached: impl Future<Output = Option<D>>,
    network: impl FnOnce() -> NF,
    env_type: &str,
    mut solve: impl FnMut(&D) -> std::result::Result<T, E>,
) -> std::result::Result<T, RepodataSolveError<E>>
where
    NF: Future<Output = Result<D>>,
    E: fmt::Display,
{
    let cached_error = match cached.await {
        Some(data) => match solve(&data) {
            Ok(result) => return Ok(result),
            Err(e) => {
                info!(
                    "[{}] Solve failed on cached repodata; refreshing from the network: {}",
                    env_type, e
                );
                Some(e)
            }
        },
        None => None,
    };

    let fresh = match network().await {
        Ok(data) => data,
        Err(fetch_error) => {
            return Err(match cached_error {
                Some(solve_error) => {
                    info!(
                        "[{}] Repodata refresh failed; reporting the cached solve error: {}",
                        env_type, fetch_error
                    );
                    RepodataSolveError::Solve(solve_error)
                }
                None => RepodataSolveError::Fetch(fetch_error),
            });
        }
    };
    solve(&fresh).map_err(RepodataSolveError::Solve)
}

#[cfg(feature = "runtime")]
fn gateway(query: &RepodataQuery<'_>, channel_config: Option<ChannelConfig>) -> Gateway {
    use rattler::package_cache::PackageCache;

    let builder = Gateway::builder()
        .with_cache_dir(
            query
                .rattler_cache_dir
                .join(rattler_cache::REPODATA_CACHE_DIR),
        )
        .with_package_cache(PackageCache::new(
            query
                .rattler_cache_dir
                .join(rattler_cache::PACKAGE_CACHE_DIR),
        ))
        .with_client(query.download_client.clone());
    match channel_config {
        Some(config) => builder.with_channel_config(config).finish(),
        None => builder.finish(),
    }
}

/// Repodata from the local cache only, or `None` on a miss.
#[cfg(feature = "runtime")]
async fn query_cached(query: &RepodataQuery<'_>) -> Option<Vec<RepoData>> {
    let offline_gateway = gateway(
        query,
        Some(ChannelConfig {
            default: SourceConfig {
                cache_action: CacheAction::ForceCacheOnly,
                ..Default::default()
            },
            ..Default::default()
        }),
    );

    match offline_gateway
        .query(
            query.channels.clone(),
            query.platforms.clone(),
            query.specs.clone(),
        )
        // Only query explicitly approved channels. CEP-42 discovery can add
        // channels from repodata; enabling it needs nteract's trust policy.
        .channel_relations(ChannelRelationsMode::Disabled)
        .recursive(true)
        .await
    {
        Ok(repo_data) => {
            info!(
                "[{}] Resolved repodata from local cache (offline mode)",
                query.env_type
            );
            query
                .handler
                .on_progress(query.env_type, EnvProgressPhase::OfflineHit);
            Some(repo_data.repodata)
        }
        Err(e) => {
            info!(
                "[{}] Offline repodata query failed (expected if not cached): {}",
                query.env_type, e
            );
            None
        }
    }
}

/// Repodata from the network gateway, retrying transient errors. The caller
/// decides whether a fetch error reaches the progress banner.
#[cfg(feature = "runtime")]
async fn query_network(query: &RepodataQuery<'_>) -> Result<Vec<RepoData>> {
    const MAX_RETRIES: u32 = 3;
    const INITIAL_DELAY_MS: u64 = 1000;

    let env_type = query.env_type;
    let handler = &query.handler;
    let gateway = gateway(query, None);

    handler.on_progress(
        env_type,
        EnvProgressPhase::FetchingRepodata {
            channels: query
                .channels
                .iter()
                .map(|c| c.name().to_string())
                .collect(),
        },
    );

    let repodata_start = Instant::now();
    let mut last_error = None;
    let mut repo_data = None;

    for attempt in 0..MAX_RETRIES {
        if attempt > 0 {
            let delay_ms = INITIAL_DELAY_MS * (1 << (attempt - 1));
            info!(
                "[{}] Retrying repodata fetch (attempt {}/{}) after {}ms...",
                env_type,
                attempt + 1,
                MAX_RETRIES,
                delay_ms
            );
            tokio::time::sleep(tokio::time::Duration::from_millis(delay_ms)).await;
        }

        match gateway
            .query(
                query.channels.clone(),
                query.platforms.clone(),
                query.specs.clone(),
            )
            .channel_relations(ChannelRelationsMode::Disabled)
            .recursive(true)
            .await
        {
            Ok(data) => {
                repo_data = Some(data.repodata);
                break;
            }
            Err(e) => {
                let error_str = e.to_string();
                let is_retryable = error_str.contains("500")
                    || error_str.contains("502")
                    || error_str.contains("503")
                    || error_str.contains("504")
                    || error_str.contains("timeout")
                    || error_str.contains("connection");

                if is_retryable && attempt < MAX_RETRIES - 1 {
                    info!(
                        "[{}] Transient error fetching repodata (attempt {}): {}",
                        env_type,
                        attempt + 1,
                        error_str
                    );
                    last_error = Some(e);
                    continue;
                }
                return Err(anyhow!("Failed to fetch package metadata: {}", e));
            }
        }
    }

    let repo_data = match repo_data {
        Some(data) => data,
        None => {
            return Err(anyhow!(
                "Failed to fetch package metadata after {} retries: {}",
                MAX_RETRIES,
                last_error
                    .map(|e| e.to_string())
                    .unwrap_or_else(|| "unknown error".to_string())
            ));
        }
    };

    let elapsed = repodata_start.elapsed();
    let total_records: usize = repo_data.iter().map(|r| r.len()).sum();
    handler.on_progress(
        env_type,
        EnvProgressPhase::RepodataComplete {
            record_count: total_records,
            elapsed_ms: elapsed.as_millis() as u64,
        },
    );

    Ok(repo_data)
}

#[cfg(all(test, feature = "runtime"))]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// A fake index: the versions of one package a source knows about.
    fn solve_for(wanted: u32) -> impl FnMut(&Vec<u32>) -> std::result::Result<u32, String> {
        move |versions: &Vec<u32>| {
            versions
                .iter()
                .copied()
                .find(|v| *v == wanted)
                .ok_or_else(|| format!("No candidates were found for {wanted}"))
        }
    }

    async fn run(
        cached: Option<Vec<u32>>,
        network: Result<Vec<u32>>,
        wanted: u32,
    ) -> (std::result::Result<u32, RepodataSolveError<String>>, usize) {
        let fetches = AtomicUsize::new(0);
        let result = solve_preferring_cache(
            async { cached },
            || {
                fetches.fetch_add(1, Ordering::SeqCst);
                async { network }
            },
            "conda",
            solve_for(wanted),
        )
        .await;
        (result, fetches.load(Ordering::SeqCst))
    }

    #[tokio::test]
    async fn cached_solve_success_skips_the_network() {
        let (result, fetches) = run(Some(vec![3, 4]), Ok(vec![3, 4, 5]), 4).await;
        assert_eq!(result.unwrap(), 4);
        assert_eq!(fetches, 0);
    }

    #[tokio::test]
    async fn stale_cache_refetches_once_and_solves() {
        let (result, fetches) = run(Some(vec![3]), Ok(vec![3, 4]), 4).await;
        assert_eq!(result.unwrap(), 4);
        assert_eq!(fetches, 1);
    }

    #[tokio::test]
    async fn missing_upstream_reports_the_fresh_solve_error() {
        let (result, fetches) = run(Some(vec![3]), Ok(vec![3, 4]), 9).await;
        assert!(matches!(result, Err(RepodataSolveError::Solve(ref e)) if e.contains('9')));
        assert_eq!(fetches, 1);
    }

    #[tokio::test]
    async fn cache_miss_fetches_and_solves() {
        let (result, fetches) = run(None, Ok(vec![4]), 4).await;
        assert_eq!(result.unwrap(), 4);
        assert_eq!(fetches, 1);
    }

    #[tokio::test]
    async fn cache_miss_with_fetch_failure_reports_the_fetch() {
        let (result, fetches) = run(None, Err(anyhow!("offline")), 4).await;
        assert!(matches!(result, Err(RepodataSolveError::Fetch(_))));
        assert_eq!(fetches, 1);
    }

    #[tokio::test]
    async fn offline_refresh_failure_keeps_the_cached_solve_error() {
        let (result, fetches) = run(Some(vec![3]), Err(anyhow!("offline")), 4).await;
        assert!(matches!(result, Err(RepodataSolveError::Solve(ref e)) if e.contains('4')));
        assert_eq!(fetches, 1);
    }
}
