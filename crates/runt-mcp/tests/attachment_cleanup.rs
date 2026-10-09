#![cfg(unix)]
#![allow(clippy::unwrap_used, clippy::expect_used)]

#[path = "support/attachments.rs"]
mod attachments;
mod support;

#[tokio::test]
async fn acknowledged_shutdown_exits_during_accept_traffic() {
    let fixture = attachments::Fixture::start_with_trace().await;
    let socket = fixture.root.path().join("daemon.sock");
    let (started, active) = tokio::sync::oneshot::channel();
    let traffic = tokio::spawn(async move {
        let mut started = Some(started);
        for _ in 0..10_000 {
            let Ok(mut stream) = tokio::net::UnixStream::connect(&socket).await else {
                break;
            };
            if notebook_protocol::connection::send_preamble(&mut stream)
                .await
                .is_err()
            {
                break;
            }
            let _ = notebook_protocol::connection::send_json_frame(
                &mut stream,
                &notebook_protocol::connection::Handshake::Pool,
            )
            .await;
            if let Some(started) = started.take() {
                let _ = started.send(());
            }
        }
    });
    let mut wire = fixture.wire();
    wire.initialize("2025-11-25").await;
    wire.initialized().await;
    tokio::time::timeout(support::DEADLINE, active)
        .await
        .expect("accept traffic must start before shutdown")
        .unwrap();
    fixture.stop(wire).await;
    traffic.abort();
    let _ = traffic.await;
}
