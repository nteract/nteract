#![cfg(unix)]
#![allow(clippy::unwrap_used, clippy::expect_used)]

#[path = "support/attachments.rs"]
mod attachments;
mod support;
use attachments::*;

struct ProbeLog {
    source: std::path::PathBuf,
    destination: Option<std::path::PathBuf>,
}
impl Drop for ProbeLog {
    fn drop(&mut self) {
        if let Some(destination) = &self.destination {
            std::fs::copy(&self.source, destination).unwrap();
        }
    }
}
fn probe_log(fixture: &Fixture, label: &str) -> ProbeLog {
    let destination = std::env::var_os("NTERACT_ATTACHMENT_PROBE_DIR").map(|dir| {
        let dir = std::path::PathBuf::from(dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.join(format!("same-room-{label}-daemon.log"))
    });
    ProbeLog {
        source: fixture.root.path().join("daemon.log"),
        destination,
    }
}

async fn probe(ready_per_open: bool, direct: bool, count: u64) {
    let fixture = if direct {
        Fixture::start_direct_with_trace().await
    } else {
        Fixture::start_with_trace().await
    };
    let path = fixture.notebook("same-room", "same-room sentinel");
    let mut wire = fixture.wire();
    let mut handles = Vec::new();
    let label = if direct {
        "direct-ready-per-open"
    } else if ready_per_open {
        "ready-per-open"
    } else {
        "unready-burst"
    };
    let logs = probe_log(&fixture, label);
    for index in 0..count {
        eprintln!("{label}: open {index}");
        let handle = open(&mut wire, 1000 + index, &path, true).await;
        if ready_per_open {
            fixture.ready(&handle).await;
        }
        handles.push(handle);
    }
    for (index, handle) in handles.iter().enumerate() {
        eprintln!("{label}: ready/read retained {index} {handle}");
        fixture.ready(handle).await;
        assert_eq!(
            read(&mut wire, 2000 + index as u64, handle, true).await["cells"][0]["source_preview"],
            "same-room sentinel"
        );
    }
    assert_eq!(
        handles
            .iter()
            .collect::<std::collections::HashSet<_>>()
            .len(),
        count as usize
    );
    release(&mut wire, 3000, &handles[0], true).await;
    let survivor = handles.last().unwrap();
    result(&mutate(&mut wire, 3001, survivor, "surviving logical owner", true).await);
    assert_eq!(
        read(&mut wire, 3002, survivor, true).await["cells"][0]["source_preview"],
        "surviving logical owner"
    );
    let stale = wire
        .request(
            3003,
            "resources/read",
            Some(native_params(
                serde_json::json!({"uri":format!("nteract://sessions/{}/cells", handles[0])}),
            )),
        )
        .await;
    assert_eq!(stale["error"]["data"]["code"], "attachment_expired");
    drop(logs);
    fixture.stop(wire).await;
}

#[tokio::test]
async fn unready_same_notebook_burst_retains_128_attachments() {
    probe(false, false, 128).await;
}

#[tokio::test]
async fn ready_per_open_same_notebook_retains_128_attachments() {
    probe(true, false, 128).await;
}

#[tokio::test]
#[ignore = "manual direct-daemon threshold probe; 128-owner regressions are the acceptance gate"]
async fn direct_same_notebook_ready_per_open_retains_27_attachments() {
    probe(true, true, 27).await;
}
