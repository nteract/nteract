//! Real IPC coverage for reviewed inline Conda launch. The live test uses the
//! normal Rattler download cache and public conda-forge, so it is opt-in.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use notebook_protocol::{
    connection::LaunchSpec,
    protocol::{NotebookRequest, NotebookResponse},
};
use notebook_sync::connect;
use runtimed::{
    client::PoolClient,
    daemon::{Daemon, DaemonConfig},
};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

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
    async fn start(live: bool) -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let captured = requests.clone();
        let task = tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                let captured = captured.clone();
                tokio::spawn(async move {
                    let mut request = vec![0; 8192];
                    let n = stream.read(&mut request).await.unwrap();
                    let request = String::from_utf8_lossy(&request[..n]);
                    let path = request.split_whitespace().nth(1).unwrap_or("/").to_string();
                    captured.lock().unwrap().push(path.clone());
                    if live && path.starts_with("/related/") {
                        // CEP-42 relationships are relative. This loopback
                        // related channel serves real conda-forge data via the
                        // same redirects used by ordinary channel/CDN hosts.
                        let location = format!(
                            "https://conda.anaconda.org/conda-forge/{}",
                            path.strip_prefix("/related/").unwrap()
                        );
                        let header = format!("HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                        let _ = stream.write_all(header.as_bytes()).await;
                        return;
                    }
                    let exists = path.ends_with("/repodata.json");
                    let subdir = path.split('/').rev().nth(1).unwrap_or("noarch");
                    let mut info = serde_json::json!({"subdir": subdir});
                    if path.starts_with("/declared/") {
                        info["channel_relations"] = serde_json::json!({"base": "../related"});
                    }
                    let body = serde_json::to_vec(&serde_json::json!({"info": info, "packages": {}, "packages.conda": {}, "repodata_version": 1})).unwrap();
                    let header = format!(
                        "HTTP/1.1 {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        if exists { "200 OK" } else { "404 Not Found" },
                        if exists { body.len() } else { 0 }
                    );
                    if stream.write_all(header.as_bytes()).await.is_ok() && exists {
                        let _ = stream.write_all(&body).await;
                    }
                });
            }
        });
        Self {
            url,
            requests,
            task,
        }
    }
}

async fn next_review(
    handle: &notebook_sync::DocHandle,
    previous: Option<&str>,
) -> runtime_doc::RelatedChannelReview {
    let mut state = handle.subscribe_runtime_state();
    tokio::time::timeout(Duration::from_secs(60), async {
        loop {
            if let Some(review) = state.borrow().trust.related_channel_review.clone() {
                if Some(review.review_id.as_str()) != previous {
                    return review;
                }
            }
            state.changed().await.unwrap();
        }
    })
    .await
    .expect("the launch must publish a fresh review")
}

async fn run_review(live: bool, shutdown_pending: bool) {
    let temp = tempfile::tempdir().unwrap();
    let server = ChannelServer::start(live).await;
    let notebook = temp.path().join("review.ipynb");
    std::fs::write(&notebook, serde_json::to_vec(&serde_json::json!({
        "nbformat": 4, "nbformat_minor": 5,
        "metadata": {"kernelspec": {"name":"python3", "display_name":"Python 3", "language":"python"},
            "runt": {"schema_version":"1", "conda": {"dependencies":["rich"], "channels":[format!("{}/declared", server.url)], "python":"3.13"}}},
        "cells": [{"id":"verify", "cell_type":"code", "source":"import rich, sys\nassert sys.prefix == __import__('os').environ.get('CONDA_PREFIX', sys.prefix)\nprint('reviewed kernel executed')", "metadata":{}, "outputs":[], "execution_count":null}]
    })).unwrap()).unwrap();
    #[cfg(not(windows))]
    let socket = temp.path().join("daemon.sock");
    #[cfg(windows)]
    let socket = std::path::PathBuf::from(format!(r"\\.\pipe\review-{}", uuid::Uuid::new_v4()));
    let daemon = Daemon::new_for_test(DaemonConfig {
        socket_path: socket.clone(),
        cache_dir: temp.path().join("cache"),
        blob_store_dir: temp.path().join("blobs"),
        execution_store_dir: temp.path().join("executions"),
        notebook_docs_dir: temp.path().join("docs"),
        trusted_packages_db_path: temp.path().join("trust.sqlite"),
        notebook_registry_db_path: temp.path().join("registry.sqlite"),
        lock_dir: Some(temp.path().join("locks")),
        settings_json_path: Some(temp.path().join("settings.json")),
        use_preferred_blob_port: false,
        uv_pool_size: 0,
        conda_pool_size: 0,
        pixi_pool_size: 0,
        runtime_agent_exe: Some(env!("CARGO_BIN_EXE_runtimed").into()),
        ..Default::default()
    })
    .unwrap();
    let task = tokio::spawn(async move { daemon.run().await });
    let pool = PoolClient::new(socket.clone());
    tokio::time::timeout(Duration::from_secs(10), async {
        while pool.ping().await.is_err() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let observer = connect::connect_open(socket.clone(), notebook, "review-observer")
        .await
        .unwrap();
    observer.handle.await_runtime_state_ready().await.unwrap();
    observer.handle.confirm_sync().await.unwrap();
    assert!(matches!(
        observer
            .handle
            .send_request(NotebookRequest::ApproveTrust {
                observed_heads: None,
                include_pep723: false,
                reviewed_pep723_dependencies: None,
            })
            .await
            .unwrap(),
        NotebookResponse::Ok {}
    ));
    let (frames, mut frame_rx) = tokio::sync::mpsc::unbounded_channel();
    let drain = tokio::spawn(async move { while frame_rx.recv().await.is_some() {} });
    let relay = connect::connect_relay_with_options(
        socket,
        observer.info.notebook_id.clone(),
        frames,
        Some("review-owner".into()),
        connect::RelayOptions {
            scoped_channel_review_v1: true,
        },
    )
    .await
    .unwrap();
    assert!(relay.capabilities.scoped_channel_review_v1);
    let launch = relay.handle.clone();
    let mut launch = tokio::spawn(async move {
        launch
            .send_request(NotebookRequest::LaunchKernel {
                kernel_type: "python".into(),
                env_source: LaunchSpec::parse("conda:inline"),
                notebook_path: None,
            })
            .await
    });
    let metadata = tokio::select! {
        review = next_review(&observer.handle, None) => review,
        result = &mut launch => panic!("Launch ended before metadata review: {result:?}"),
    };
    eprintln!(
        "Metadata review received: {:?}",
        metadata.uninspected_channels
    );
    assert_eq!(
        metadata.scope,
        runtime_doc::RelatedChannelReviewScope::Metadata
    );
    assert!(!server
        .requests
        .lock()
        .unwrap()
        .iter()
        .any(|p| p.starts_with("/related/")));
    assert!(
        matches!(
            observer
                .handle
                .send_request(NotebookRequest::ApproveRelatedChannels {
                    review_id: metadata.review_id.clone()
                })
                .await
                .unwrap(),
            NotebookResponse::Error { .. }
        ),
        "a second connection must not redeem the owner's ID"
    );
    assert!(matches!(
        relay
            .handle
            .send_request(NotebookRequest::ApproveRelatedChannels {
                review_id: metadata.review_id.clone()
            })
            .await
            .unwrap(),
        NotebookResponse::Ok {}
    ));
    let install = tokio::select! {
        review = next_review(&observer.handle, Some(&metadata.review_id)) => review,
        result = &mut launch => panic!("Launch ended before install review: {result:?}"),
    };
    eprintln!("Install review received: {:?}", install.effective_channels);
    assert_eq!(
        install.scope,
        runtime_doc::RelatedChannelReviewScope::Install
    );
    assert!(
        matches!(
            relay
                .handle
                .send_request(NotebookRequest::ApproveRelatedChannels {
                    review_id: metadata.review_id
                })
                .await
                .unwrap(),
            NotebookResponse::Error { .. }
        ),
        "metadata consent cannot be replayed as install consent"
    );
    if shutdown_pending {
        let shutdown = tokio::time::timeout(
            Duration::from_secs(10),
            relay
                .handle
                .send_request(NotebookRequest::ShutdownKernel {}),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(matches!(
            shutdown,
            NotebookResponse::KernelShuttingDown {} | NotebookResponse::NoKernel {}
        ));
        assert!(matches!(
            launch.await.unwrap().unwrap(),
            NotebookResponse::Error { .. }
        ));
        assert!(matches!(
            relay
                .handle
                .send_request(NotebookRequest::ApproveRelatedChannels {
                    review_id: install.review_id
                })
                .await
                .unwrap(),
            NotebookResponse::Error { .. }
        ));
        assert!(observer
            .handle
            .get_runtime_state()
            .unwrap()
            .trust
            .related_channel_review
            .is_none());
    } else if live {
        assert!(matches!(
            relay
                .handle
                .send_request(NotebookRequest::ApproveRelatedChannels {
                    review_id: install.review_id.clone()
                })
                .await
                .unwrap(),
            NotebookResponse::Ok {}
        ));
        let response = launch.await.unwrap().unwrap();
        let NotebookResponse::KernelLaunched {
            launched_config, ..
        } = response
        else {
            panic!("expected real kernel launch, got {response:?}")
        };
        let prefix = launched_config.venv_path.unwrap();
        assert!(prefix.to_string_lossy().contains("reviewed-conda-envs"));
        assert!(prefix.join("conda-meta").is_dir());
        assert!(matches!(
            relay
                .handle
                .send_request(NotebookRequest::ApproveRelatedChannels {
                    review_id: install.review_id
                })
                .await
                .unwrap(),
            NotebookResponse::Error { .. }
        ));
        let response = observer
            .handle
            .send_request(NotebookRequest::ExecuteCell {
                cell_id: "verify".into(),
                execution_id: None,
            })
            .await
            .unwrap();
        let NotebookResponse::CellQueued { execution_id, .. } = response else {
            panic!("{response:?}")
        };
        let execution = notebook_sync::execution_wait::await_execution_terminal(
            &observer.handle,
            &execution_id,
            Duration::from_secs(30),
            None,
        )
        .await
        .unwrap();
        assert!(execution.success, "{execution:?}");
        assert!(serde_json::to_string(&execution.output_manifests)
            .unwrap()
            .contains("reviewed kernel executed"));
        relay
            .handle
            .send_request(NotebookRequest::ShutdownKernel {})
            .await
            .unwrap();
    } else {
        assert!(server
            .requests
            .lock()
            .unwrap()
            .iter()
            .any(|p| p.starts_with("/related/")));
        assert!(matches!(
            relay
                .handle
                .send_request(NotebookRequest::DeclineRelatedChannels {
                    review_id: install.review_id
                })
                .await
                .unwrap(),
            NotebookResponse::Ok {}
        ));
        assert!(
            matches!(launch.await.unwrap().unwrap(), NotebookResponse::Error { error } if error.contains("declined"))
        );
        assert!(observer
            .handle
            .get_runtime_state()
            .unwrap()
            .trust
            .related_channel_review
            .is_none());
    }
    pool.shutdown().await.unwrap();
    tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    drain.abort();
}

#[tokio::test]
async fn scoped_channel_metadata_and_install_consent_over_real_ipc() {
    run_review(false, false).await;
}

#[tokio::test]
#[ignore = "downloads a real Conda environment from conda-forge and launches Python"]
async fn scoped_channel_live_install_launch_and_execute() {
    run_review(true, false).await;
}

#[tokio::test]
async fn shutdown_on_reviewing_connection_unblocks_launch_and_revokes_review() {
    run_review(false, true).await;
}
