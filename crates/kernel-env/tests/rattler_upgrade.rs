//! Exercise our gateway → solver → installer boundary with an isolated channel.
//! No public channel, credential store, or shared package cache is involved.
#![cfg(feature = "runtime")]
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};

use kernel_env::{
    lock::LockFile,
    progress::{EnvProgressPhase, ProgressHandler, RattlerReporter},
};
use rattler::package_cache::PackageCache;
use rattler_conda_types::{
    Channel, ChannelConfig, MatchSpec, ParseMatchSpecOptions, PrefixRecord, Subdir,
};
use rattler_solve::{resolvo, SolverImpl, SolverTask};
use serde_json::json;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[derive(Default)]
struct Progress(Mutex<Vec<EnvProgressPhase>>);

impl ProgressHandler for Progress {
    fn on_progress(&self, _: &str, phase: EnvProgressPhase) {
        self.0.lock().unwrap().push(phase);
    }
}

struct ChannelServer {
    url: String,
    requests: Arc<Mutex<Vec<String>>>,
    task: tokio::task::JoinHandle<()>,
    files: Arc<Mutex<HashMap<String, Vec<u8>>>>,
}

impl Drop for ChannelServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl ChannelServer {
    async fn start(files: HashMap<String, Vec<u8>>) -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let seen = requests.clone();
        let files = Arc::new(Mutex::new(files));
        let serve_files = files.clone();
        let task = tokio::spawn(async move {
            loop {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                loop {
                    let mut buffer = [0; 4096];
                    let count = stream.read(&mut buffer).await.unwrap();
                    assert!(count > 0);
                    request.extend_from_slice(&buffer[..count]);
                    if request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                        break;
                    }
                }
                let request = String::from_utf8(request).unwrap();
                let mut parts = request.split_whitespace();
                let method = parts.next().unwrap();
                let path = parts.next().unwrap();
                seen.lock().unwrap().push(path.to_string());
                let (status, body) = serve_files
                    .lock()
                    .unwrap()
                    .get(path)
                    .map_or(("404 Not Found", Vec::new()), |body| {
                        ("200 OK", body.clone())
                    });
                let header = format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\nCache-Control: public, max-age=3600\r\nConnection: close\r\n\r\n", body.len());
                stream.write_all(header.as_bytes()).await.unwrap();
                if method != "HEAD" {
                    stream.write_all(&body).await.unwrap();
                }
            }
        });
        Self {
            url,
            requests,
            task,
            files,
        }
    }
}

fn spec(value: &str) -> MatchSpec {
    MatchSpec::from_str(value, ParseMatchSpecOptions::strict()).unwrap()
}

/// A real relocatable conda package with one ordinary file eligible for hardlinking.
fn package(version: &str) -> (serde_json::Value, Vec<u8>) {
    named_package("upgrade-fixture", version)
}

fn named_package(name: &str, version: &str) -> (serde_json::Value, Vec<u8>) {
    let payload = format!("fixture version {version}\n");
    let index = json!({"name": name, "version": version, "build": "0",
        "build_number": 0, "subdir": "noarch", "depends": []});
    let paths = json!({"paths_version": 1, "paths": [{"_path": format!("share/{name}.txt"),
        "path_type": "hardlink", "sha256": hex::encode(Sha256::digest(payload.as_bytes())),
        "size_in_bytes": payload.len()}]});
    let mut archive = tar::Builder::new(bzip2::write::BzEncoder::new(
        Vec::new(),
        bzip2::Compression::fast(),
    ));
    for (path, contents) in [
        ("info/index.json", index.to_string()),
        ("info/paths.json", paths.to_string()),
        (format!("share/{name}.txt").as_str(), payload),
    ] {
        let mut header = tar::Header::new_gnu();
        header.set_size(contents.len() as u64);
        header.set_mode(0o644);
        header.set_cksum();
        archive
            .append_data(&mut header, path, contents.as_bytes())
            .unwrap();
    }
    let bytes = archive.into_inner().unwrap().finish().unwrap();
    let mut record = index;
    record["sha256"] = json!(hex::encode(Sha256::digest(&bytes)));
    record["size"] = json!(bytes.len());
    (record, bytes)
}

#[tokio::test]
async fn channel_priority_offline_cache_and_install_roundtrip() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let mut files = HashMap::new();
        for (channel, version) in [("first", "1.0"), ("second", "2.0")] {
            let (record, archive) = package(version);
            let filename = format!("upgrade-fixture-{version}-0.tar.bz2");
            let repodata = json!({"info": {"subdir": "noarch",
                "channel_relations": {"base": "../unapproved"}},
                "packages": {filename.clone(): record}, "packages.conda": {}, "repodata_version": 1});
            files.insert(format!("/{channel}/noarch/repodata.json"), serde_json::to_vec(&repodata).unwrap());
            files.insert(format!("/{channel}/noarch/{filename}"), archive);
        }
        let server = ChannelServer::start(files).await;
        let cache = tempfile::tempdir().unwrap();
        let config = ChannelConfig::default_with_root_dir(cache.path().to_path_buf());
        let channels = ["first", "second"].map(|name| Channel::from_str(format!("{}/{name}", server.url), &config).unwrap()).to_vec();
        let client = reqwest_middleware::ClientBuilder::new(reqwest_rattler::Client::new()).build();
        let progress = Arc::new(Progress::default());
        let specs = vec![spec("upgrade-fixture")];
        let query = |channels: Vec<Channel>, env_type| kernel_env::repodata::RepodataQuery {
            channels, platforms: vec![Subdir::NoArch], specs: specs.clone(), rattler_cache_dir: cache.path(),
            download_client: client.clone(), handler: progress.clone(), env_type,
        };
        let solved = kernel_env::repodata::solve_with_repodata(query(channels.clone(), "conda"), |records| {
            resolvo::Solver.solve(SolverTask { specs: specs.clone(), ..SolverTask::from_iter(records) })
        }).await.unwrap().records;
        assert_eq!(solved.len(), 1);
        assert_eq!(solved[0].package_record.version.to_string(), "1.0", "declared channel order wins over newer versions");
        assert!(solved[0].url.as_str().contains("/first/"));
        assert!(!server.requests.lock().unwrap().iter().any(|path| path.contains("unapproved")));

        // Positive control: the fixture must actually trigger discovery when
        // enabled, or the assertion above could pass with malformed metadata.
        rattler_repodata_gateway::Gateway::builder()
            .with_cache_dir(cache.path().join("discovery-control"))
            .with_client(client.clone())
            .finish()
            .query(channels.clone(), vec![Subdir::NoArch], specs.clone())
            .channel_relations(rattler_repodata_gateway::ChannelRelationsMode::Warn)
            .recursive(true)
            .await
            .unwrap();
        assert!(server.requests.lock().unwrap().iter().any(|path| path.contains("unapproved")));

        let prefix = tempfile::tempdir().unwrap();
        let package_cache = PackageCache::new(cache.path().join("pkgs"));
        let platform = kernel_env::conda_solve_platform().unwrap();
        let result = kernel_env::rattler_installer().with_package_cache(package_cache.clone())
            .with_download_client(client.clone()).with_target_platform(platform)
            .with_reporter(RattlerReporter::new(progress.clone()))
            .install(prefix.path(), solved.clone()).await.unwrap();
        assert_eq!(result.transaction.operations.len(), 1);
        assert_eq!(std::fs::read_to_string(prefix.path().join("share/upgrade-fixture.txt")).unwrap(), "fixture version 1.0\n");
        let installed = PrefixRecord::collect_from_prefix::<PrefixRecord>(prefix.path()).unwrap();
        assert_eq!(installed.len(), 1);
        assert_eq!(installed[0].repodata_record, solved[0]);
        #[cfg(unix)] {
            use std::os::unix::fs::MetadataExt;
            assert!(std::fs::metadata(prefix.path().join("share/upgrade-fixture.txt")).unwrap().nlink() >= 2, "ordinary package files should share a cache inode");
        }

        // Persist real records, not an empty lock. Restore them after dropping the server.
        let lock = LockFile::new(vec!["upgrade-fixture".into()], channels.iter().map(|c| c.name().to_string()).collect(), solved, platform);
        lock.write_to(prefix.path()).await.unwrap();
        let lock = LockFile::read_from(prefix.path()).await.unwrap();
        let seen = server.requests.clone();
        let before_offline = seen.lock().unwrap().len();
        server.task.abort();
        let cached = kernel_env::repodata::solve_with_repodata(query(channels, "pixi"), |records| {
            resolvo::Solver.solve(SolverTask { specs: specs.clone(), ..SolverTask::from_iter(records) })
        }).await.unwrap().records;
        assert_eq!(seen.lock().unwrap().len(), before_offline);
        assert!(progress.0.lock().unwrap().iter().any(|phase| matches!(phase, EnvProgressPhase::OfflineHit)));
        assert_eq!(cached, lock.packages);
        let restored = tempfile::tempdir().unwrap();
        kernel_env::rattler_installer().with_package_cache(package_cache.clone()).with_download_client(client.clone())
            .with_target_platform(platform).install(restored.path(), lock.packages.clone()).await.unwrap();
        assert_eq!(std::fs::read_to_string(restored.path().join("share/upgrade-fixture.txt")).unwrap(), "fixture version 1.0\n");
        let noop = kernel_env::rattler_installer().with_package_cache(package_cache).with_download_client(client)
            .with_target_platform(platform).install(restored.path(), lock.packages).await.unwrap();
        assert!(noop.transaction.operations.is_empty(), "reinstalling the same solution must be a no-op");
    }).await.expect("local gateway/install test timed out");
}

#[tokio::test]
async fn legacy_lock_records_remain_readable() {
    // v1 lock representation from rattler_conda_types 0.44: string build/fn,
    // millisecond timestamp, and no newly introduced package metadata fields.
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join(".lock.json"), r#"{
        "version": 1, "platform": "osx-arm64", "specs": ["python=3.12"],
        "channels": ["conda-forge"], "packages": [{
            "name": "python", "version": "3.12.9", "build": "h123_0", "build_number": 0,
            "subdir": "osx-arm64", "depends": ["openssl >=3"], "timestamp": 1735689600000,
            "fn": "python-3.12.9-h123_0.conda", "url": "https://conda.anaconda.org/conda-forge/osx-arm64/python-3.12.9-h123_0.conda",
            "channel": "https://conda.anaconda.org/conda-forge"
        }]
    }"#).unwrap();
    let lock = LockFile::read_from(dir.path()).await.unwrap();
    assert_eq!(lock.packages.len(), 1);
    assert_eq!(lock.packages[0].package_record.build.as_str(), "h123_0");
    assert_eq!(
        lock.packages[0].identifier.to_string(),
        "python-3.12.9-h123_0.conda"
    );
    assert!(lock.constraints.is_empty());
    assert_eq!(
        serde_json::to_value(&lock.packages[0]).unwrap()["timestamp"],
        json!(1735689600000_i64)
    );
    lock.write_to(dir.path()).await.unwrap();
    assert_eq!(
        LockFile::read_from(dir.path()).await.unwrap().packages,
        lock.packages
    );
}

#[tokio::test]
async fn channel_review_requires_consent_before_fetching_and_can_finish_offline() {
    use kernel_env::channel_review::{
        authorization::{ApprovalScope, ChannelConsentSession, ReviewFence},
        discover_channel_review, DiscoveryLimits,
    };
    use rattler_repodata_gateway::{
        fetch::CacheAction, ChannelConfig as GatewayConfig, Gateway, SourceConfig,
    };

    let mut files = HashMap::new();
    for (channel, relations) in [
        ("declared", json!({"base": "../related"})),
        ("related", json!({"base": "../transitive"})),
        ("transitive", json!({})),
    ] {
        files.insert(
            format!("/{channel}/noarch/repodata.json"),
            serde_json::to_vec(&json!({
                "info": {"subdir": "noarch", "channel_relations": relations},
                "packages": {}, "packages.conda": {}, "repodata_version": 1
            }))
            .unwrap(),
        );
    }
    let server = ChannelServer::start(files).await;
    let cache = tempfile::tempdir().unwrap();
    let config = ChannelConfig::default_with_root_dir(cache.path().to_path_buf());
    let declared = Channel::from_str(format!("{}/declared", server.url), &config).unwrap();
    let related = Channel::from_str(format!("{}/related", server.url), &config)
        .unwrap()
        .base_url
        .to_string();
    let transitive = Channel::from_str(format!("{}/transitive", server.url), &config)
        .unwrap()
        .base_url
        .to_string();
    let gateway = |offline| {
        Gateway::builder()
            .with_cache_dir(cache.path())
            .with_channel_config(GatewayConfig {
                default: SourceConfig {
                    cache_action: if offline {
                        CacheAction::ForceCacheOnly
                    } else {
                        CacheAction::CacheOrFetch
                    },
                    ..Default::default()
                },
                ..Default::default()
            })
            .finish()
    };
    let offline = gateway(true);
    let network = gateway(false);
    assert!(discover_channel_review(
        vec![declared.clone()],
        vec![Subdir::NoArch],
        vec![],
        &offline,
        None,
        DiscoveryLimits::default()
    )
    .await
    .is_err());
    assert!(
        server.requests.lock().unwrap().is_empty(),
        "offline cache miss must not contact the server"
    );
    let fence = ReviewFence {
        owner: "fixture-owner".into(),
        dependency_revision: "fixture-revision".into(),
        environment: "fixture-prefix".into(),
        generation: 1,
    };
    let mut consent =
        ChannelConsentSession::new(fence.clone(), vec![declared.base_url.to_string()], true);
    let request = consent.begin_discovery(&fence).unwrap();
    let first = discover_channel_review(
        vec![declared.clone()],
        vec![Subdir::NoArch],
        request.approved_metadata_channels().to_vec(),
        &offline,
        Some(&network),
        DiscoveryLimits::default(),
    )
    .await
    .unwrap();
    assert_eq!(
        first.review().uninspected_channels.as_slice(),
        std::slice::from_ref(&related)
    );
    assert!(
        !server
            .requests
            .lock()
            .unwrap()
            .iter()
            .any(|path| path.starts_with("/related/") || path.starts_with("/transitive/")),
        "reviewing a URL must not contact it before consent"
    );
    consent.discovered(&fence, request, first.clone()).unwrap();
    assert!(consent.take_authorization(&fence).is_err());
    let review = consent.pending_review().unwrap().clone();
    assert_eq!(review.scope, ApprovalScope::Metadata);
    consent.approve(&fence, &review.review_id).unwrap();
    let request = consent.begin_discovery(&fence).unwrap();
    let second = discover_channel_review(
        vec![declared.clone()],
        vec![Subdir::NoArch],
        request.approved_metadata_channels().to_vec(),
        &offline,
        Some(&network),
        DiscoveryLimits::default(),
    )
    .await
    .unwrap();
    assert_eq!(
        second.review().uninspected_channels.as_slice(),
        std::slice::from_ref(&transitive)
    );
    assert!(!server
        .requests
        .lock()
        .unwrap()
        .iter()
        .any(|path| path.starts_with("/transitive/")));
    // Approval enables metadata reads, not an installer. The complete graph
    // carries exactly the effective order the owner will later authorize.
    consent.discovered(&fence, request, second.clone()).unwrap();
    let review = consent.pending_review().unwrap().clone();
    consent.approve(&fence, &review.review_id).unwrap();
    assert!(consent.take_authorization(&fence).is_err());
    let request = consent.begin_discovery(&fence).unwrap();
    let approved = request.approved_metadata_channels().to_vec();
    assert_eq!(approved, vec![related.clone(), transitive.clone()]);
    let final_review = discover_channel_review(
        vec![declared.clone()],
        vec![Subdir::NoArch],
        approved.clone(),
        &offline,
        Some(&network),
        DiscoveryLimits::default(),
    )
    .await
    .unwrap();
    assert!(final_review.review().uninspected_channels.is_empty());
    assert_eq!(
        final_review.review().effective_channels,
        [transitive, related, declared.base_url.to_string()]
    );
    let expected = final_review.review().effective_channels.clone();
    consent
        .discovered(&fence, request, final_review.clone())
        .unwrap();
    let review = consent.pending_review().unwrap().clone();
    assert_eq!(review.scope, ApprovalScope::Install);
    assert!(consent.take_authorization(&fence).is_err());
    consent.approve(&fence, &review.review_id).unwrap();
    let plan = consent.take_authorization(&fence).unwrap();
    assert_eq!(plan.into_channels(&fence).unwrap(), expected);
    assert!(consent.take_authorization(&fence).is_err());
    // A real completed discovery is still insufficient if the owner changes
    // before the first staged installer effect. No new HTTP or prefix writes.
    let staging_root = cache.path().join("unpublished");
    let prepared = kernel_env::conda::reviewed::PreparedCondaInstall::new(
        "fixture-owner".into(),
        1,
        "document-heads",
        kernel_env::CondaDependencies {
            dependencies: vec!["numpy".into()],
            channels: vec![declared.base_url.to_string()],
            python: None,
            env_id: None,
        },
        &staging_root,
    )
    .unwrap();
    let prepared_fence = prepared.fence().clone();
    let mut prepared_consent = prepared.consent_session(true);
    for outcome in [first, second, final_review.clone()] {
        let request = prepared_consent.begin_discovery(&prepared_fence).unwrap();
        prepared_consent
            .discovered(&prepared_fence, request, outcome)
            .unwrap();
        let id = prepared_consent.pending_review().unwrap().review_id.clone();
        prepared_consent.approve(&prepared_fence, &id).unwrap();
    }
    let token = prepared_consent
        .take_authorization(&prepared_fence)
        .unwrap();
    let before_stage = server.requests.lock().unwrap().len();
    let result = prepared
        .stage(
            token,
            &|_| anyhow::bail!("document changed"),
            Arc::new(Progress::default()),
        )
        .await;
    assert!(result.is_err());
    assert!(!staging_root.exists());
    assert_eq!(server.requests.lock().unwrap().len(), before_stage);

    let all_subdirs = vec![kernel_env::conda_solve_platform().unwrap(), Subdir::NoArch];
    let with_absent_subdir = discover_channel_review(
        vec![declared.clone()],
        all_subdirs.clone(),
        approved.clone(),
        &offline,
        Some(&network),
        DiscoveryLimits::default(),
    )
    .await
    .unwrap();
    assert!(matches!(
        with_absent_subdir,
        kernel_env::channel_review::DiscoveryOutcome::Complete(_)
    ));
    let before_offline = server.requests.lock().unwrap().len();
    server.task.abort();
    // Rattler does not persist a 404 as a cache entry. An offline review
    // cannot assume that an unrecorded subdir is absent rather than unread.
    assert!(discover_channel_review(
        vec![declared.clone()],
        all_subdirs,
        approved.clone(),
        &gateway(true),
        None,
        DiscoveryLimits::default()
    )
    .await
    .is_err());
    let cached = discover_channel_review(
        vec![declared],
        vec![Subdir::NoArch],
        approved,
        &gateway(true),
        None,
        DiscoveryLimits::default(),
    )
    .await
    .unwrap();
    assert_eq!(cached, final_review);
    assert_eq!(server.requests.lock().unwrap().len(), before_offline);
}

#[tokio::test]
async fn missing_related_dependency_does_not_modify_existing_prefix() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let mut files = HashMap::new();
        let mut records = serde_json::Map::new();
        for name in ["python", "ipykernel", "ipywidgets", "anywidget", "pip", "nbformat", "pyarrow", "upgrade-fixture"] {
            let version = if name == "python" { "3.12.0" } else { "20.0" };
            let (record, archive) = named_package(name, version);
            let filename = format!("{name}-{version}-0.tar.bz2");
            records.insert(filename.clone(), record);
            files.insert(format!("/declared/noarch/{filename}"), archive);
        }
        files.insert("/declared/noarch/repodata.json".into(), serde_json::to_vec(&json!({
            "info": {"subdir": "noarch", "channel_relations": {"base": "../related"}},
            "packages": records, "packages.conda": {}, "repodata_version": 1
        })).unwrap());
        let (related_record, related_archive) = named_package("related-only", "1.0");
        files.insert("/related/noarch/related-only-1.0-0.tar.bz2".into(), related_archive);
        files.insert("/related/noarch/repodata.json".into(), serde_json::to_vec(&json!({
            "info": {"subdir": "noarch"}, "packages": {"related-only-1.0-0.tar.bz2": related_record},
            "packages.conda": {}, "repodata_version": 1
        })).unwrap());
        let server = ChannelServer::start(files).await;
        let cache = tempfile::tempdir().unwrap();
        let prefix = tempfile::tempdir().unwrap();
        let config = ChannelConfig::default_with_root_dir(cache.path().to_path_buf());
        let declared = Channel::from_str(format!("{}/declared", server.url), &config).unwrap();
        let related = Channel::from_str(format!("{}/related", server.url), &config).unwrap();
        let client = reqwest_middleware::ClientBuilder::new(reqwest_rattler::Client::new()).build();
        let progress = Arc::new(Progress::default());
        let mut specs = kernel_env::conda_base_packages().iter().map(|value| spec(value)).collect::<Vec<_>>();
        specs.extend([spec("python"), spec("upgrade-fixture")]);
        let solved = kernel_env::repodata::solve_with_repodata(kernel_env::repodata::RepodataQuery {
            channels: vec![declared.clone()], platforms: vec![Subdir::NoArch], specs: specs.clone(), rattler_cache_dir: cache.path(), download_client: client.clone(), handler: progress.clone(), env_type: "conda",
        }, |repodata| resolvo::Solver.solve(SolverTask { specs: specs.clone(), ..SolverTask::from_iter(repodata) })).await.unwrap().records;
        let platform = kernel_env::conda_solve_platform().unwrap();
        kernel_env::rattler_installer().with_package_cache(PackageCache::new(cache.path().join("pkgs")))
            .with_download_client(client.clone()).with_target_platform(platform)
            .install(prefix.path(), solved).await.unwrap();
        let mut before = PrefixRecord::collect_from_prefix::<PrefixRecord>(prefix.path()).unwrap();
        before.sort_by(|a,b| a.repodata_record.package_record.name.cmp(&b.repodata_record.package_record.name));
        let contents = std::fs::read(prefix.path().join("share/upgrade-fixture.txt")).unwrap();
        progress.0.lock().unwrap().clear();
        let error = kernel_env::conda::sync_dependencies_with_cache(&kernel_env::CondaEnvironment {
            env_path: prefix.path().to_path_buf(), python_path: prefix.path().join("bin/python"),
        }, &kernel_env::CondaDependencies {
            dependencies: vec!["upgrade-fixture".into(), "related-only".into()], channels: vec![declared.base_url.to_string()], python: None, env_id: None,
        }, kernel_env::conda::EnvOwnership::Daemon, cache.path(), client.clone(), progress.clone()).await.unwrap_err();
        assert!(error.to_string().contains("related-only"), "{error:#}");
        assert!(!progress.0.lock().unwrap().iter().any(|phase| matches!(phase, EnvProgressPhase::Installing { .. } | EnvProgressPhase::InstallComplete { .. })));
        let mut after = PrefixRecord::collect_from_prefix::<PrefixRecord>(prefix.path()).unwrap();
        after.sort_by(|a,b| a.repodata_record.package_record.name.cmp(&b.repodata_record.package_record.name));
        assert_eq!(before, after);
        assert_eq!(contents, std::fs::read(prefix.path().join("share/upgrade-fixture.txt")).unwrap());
        assert!(!prefix.path().join("share/related-only.txt").exists());
        assert!(!server.requests.lock().unwrap().iter().any(|path| path.starts_with("/related/")));
        // Positive control uses the same sync path, with the related source
        // explicitly selected. The package is then installed successfully.
        kernel_env::conda::sync_dependencies_with_cache(&kernel_env::CondaEnvironment {
            env_path: prefix.path().to_path_buf(), python_path: prefix.path().join("bin/python"),
        }, &kernel_env::CondaDependencies {
            dependencies: vec!["upgrade-fixture".into(), "related-only".into()], channels: vec![related.base_url.to_string(), declared.base_url.to_string()], python: None, env_id: None,
        }, kernel_env::conda::EnvOwnership::Daemon, cache.path(), client, progress).await.unwrap();
        assert!(prefix.path().join("share/related-only.txt").exists());
    }).await.expect("prefix preservation test timed out");
}

#[tokio::test]
async fn failed_cached_solve_refreshes_http_fresh_repodata() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let index = |version: &str| {
            let (record, _) = package(version);
            serde_json::to_vec(&json!({"info": {"subdir": "noarch"},
                "packages": {format!("upgrade-fixture-{version}-0.tar.bz2"): record},
                "packages.conda": {}, "repodata_version": 1}))
            .unwrap()
        };
        let path = "/channel/noarch/repodata.json";
        let server = ChannelServer::start(HashMap::from([(path.into(), index("1.0"))])).await;
        let cache = tempfile::tempdir().unwrap();
        let config = ChannelConfig::default_with_root_dir(cache.path().to_path_buf());
        let channels = vec![Channel::from_str(format!("{}/channel", server.url), &config).unwrap()];
        let client = reqwest_middleware::ClientBuilder::new(reqwest_rattler::Client::new()).build();
        let progress = Arc::new(Progress::default());
        let solve = |wanted: &'static str| {
            let specs = vec![spec(wanted)];
            let query = kernel_env::repodata::RepodataQuery {
                channels: channels.clone(),
                platforms: vec![Subdir::NoArch],
                specs: specs.clone(),
                rattler_cache_dir: cache.path(),
                download_client: client.clone(),
                handler: progress.clone(),
                env_type: "conda",
            };
            async move {
                kernel_env::repodata::solve_with_repodata(query, |records| {
                    resolvo::Solver.solve(SolverTask {
                        specs: specs.clone(),
                        ..SolverTask::from_iter(records)
                    })
                })
                .await
            }
        };
        assert_eq!(
            solve("upgrade-fixture=1.0").await.unwrap().records[0]
                .package_record
                .version
                .to_string(),
            "1.0"
        );
        let requests = || {
            server
                .requests
                .lock()
                .unwrap()
                .iter()
                .filter(|p| p.as_str() == path)
                .count()
        };
        let before = requests();
        assert!(before > 0);
        // The server advertises max-age=3600. Change its index while the cached
        // response is still HTTP-fresh, with no sleeps or cache-file edits.
        server
            .files
            .lock()
            .unwrap()
            .insert(path.into(), index("2.0"));
        solve("upgrade-fixture=1.0").await.unwrap();
        assert_eq!(
            requests(),
            before,
            "a satisfiable cache must stay offline-first"
        );
        progress.0.lock().unwrap().clear();
        assert_eq!(
            solve("upgrade-fixture=2.0").await.unwrap().records[0]
                .package_record
                .version
                .to_string(),
            "2.0"
        );
        assert!(progress
            .0
            .lock()
            .unwrap()
            .iter()
            .any(|p| matches!(p, EnvProgressPhase::OfflineHit)));
        assert_eq!(
            requests(),
            before + 1,
            "failed cached solve must fetch the real index once"
        );
        // A failed forced refresh must not destroy the last usable index.
        server.task.abort();
        let error = solve("upgrade-fixture=3.0").await.unwrap_err();
        assert!(matches!(
            error,
            kernel_env::repodata::RepodataSolveError::Solve(_)
        ));
        assert_eq!(
            solve("upgrade-fixture=2.0").await.unwrap().records[0]
                .package_record
                .version
                .to_string(),
            "2.0"
        );
    })
    .await
    .expect("local cache refresh test timed out");
}
