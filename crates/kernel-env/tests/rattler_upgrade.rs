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
                let (status, body) = files.get(path).map_or(("404 Not Found", &[][..]), |body| {
                    ("200 OK", body.as_slice())
                });
                let header = format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\nCache-Control: public, max-age=3600\r\nConnection: close\r\n\r\n", body.len());
                stream.write_all(header.as_bytes()).await.unwrap();
                if method != "HEAD" {
                    stream.write_all(body).await.unwrap();
                }
            }
        });
        Self {
            url,
            requests,
            task,
        }
    }
}

fn spec(value: &str) -> MatchSpec {
    MatchSpec::from_str(value, ParseMatchSpecOptions::strict()).unwrap()
}

/// A real relocatable conda package with one ordinary file eligible for hardlinking.
fn package(version: &str) -> (serde_json::Value, Vec<u8>) {
    let payload = format!("fixture version {version}\n");
    let index = json!({"name": "upgrade-fixture", "version": version, "build": "0",
        "build_number": 0, "subdir": "noarch", "depends": []});
    let paths = json!({"paths_version": 1, "paths": [{"_path": "share/upgrade-fixture.txt",
        "path_type": "hardlink", "sha256": hex::encode(Sha256::digest(payload.as_bytes())),
        "size_in_bytes": payload.len()}]});
    let mut archive = tar::Builder::new(bzip2::write::BzEncoder::new(
        Vec::new(),
        bzip2::Compression::fast(),
    ));
    for (path, contents) in [
        ("info/index.json", index.to_string()),
        ("info/paths.json", paths.to_string()),
        ("share/upgrade-fixture.txt", payload),
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
