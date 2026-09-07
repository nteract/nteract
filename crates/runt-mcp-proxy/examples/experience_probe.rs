//! Controlled MCP host experiment; never connects to a notebook or daemon.
//!
//! Run with a new JSONL evidence path as the sole argument. Configure that
//! binary as a temporary MCP server in the host being measured. Wire evidence
//! distinguishes requesting progress/subscriptions from actually refreshing
//! model context. See `experience_probe.md` beside this example.

use std::io::Write;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rmcp::model::*;
use rmcp::service::{RequestContext, RoleServer, SubscriptionContext};
use rmcp::{ErrorData, ServerHandler, ServiceExt};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::watch;

const URI: &str = "probe://notebook";

struct Probe {
    revision: watch::Sender<u64>,
    legacy_watch: Mutex<Option<tokio::task::JoinHandle<()>>>,
    marker: String,
    completed_jobs: Arc<AtomicU64>,
}

impl Probe {
    fn snapshot(&self) -> Value {
        let revision = *self.revision.borrow();
        json!({"uri": URI, "revision": revision, "completed_jobs": self.completed_jobs.load(Ordering::Acquire), "value": if revision == 0 { "baseline" } else { &self.marker }})
    }

    fn schedule_change(&self) {
        let revisions = self.revision.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(3)).await;
            revisions.send_modify(|revision| *revision += 1);
        });
    }
}

impl Drop for Probe {
    fn drop(&mut self) {
        if let Ok(task) = self.legacy_watch.get_mut() {
            if let Some(task) = task.take() {
                task.abort();
            }
        }
    }
}

impl ServerHandler for Probe {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().enable_resources().enable_resources_subscribe().build())
            .with_server_info(Implementation::new("nteract-experience-probe", "1"))
            .with_instructions("Controlled host capability experiment. Read probe://notebook for current state. Resource notifications invalidate prior reads. Use wait_for_change for a bounded wait if your host cannot subscribe. No real notebooks or kernels are involved.")
    }

    async fn list_tools(
        &self,
        _: Option<PaginatedRequestParams>,
        _: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        let schema: Arc<serde_json::Map<String, Value>> = Arc::new(
            serde_json::from_value(
                json!({"type":"object","properties":{},"additionalProperties":false}),
            )
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?,
        );
        Ok(ListToolsResult::with_all_items(vec![
            Tool::new("schedule_change", "Change the resource after three seconds. Returns the baseline immediately; the new value is available only from a later resource read or wait_for_change.", schema.clone()),
            Tool::new("long_job", "Run an eight-second fixture job, emitting progress if requested. Returns a completion receipt, without the resource value. Canceling this request only cancels waiting.", schema),
            Tool::new("wait_for_change", "Wait up to 25 seconds for the resource to change after the supplied revision, then return the latest resource value. This does not schedule a change.", Arc::new(serde_json::from_value(json!({"type":"object","properties":{"after":{"type":"integer","minimum":0}},"required":["after"],"additionalProperties":false})).map_err(|e| ErrorData::internal_error(e.to_string(), None))?)),
        ]))
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        let result = match request.name.as_ref() {
            "schedule_change" => {
                let baseline = self.snapshot();
                self.schedule_change();
                baseline
            }
            "long_job" => {
                // A detached job models daemon-owned execution. Dropping the
                // request future must not cancel the underlying work.
                let (done_tx, mut done_rx) = watch::channel(false);
                let completed_jobs = self.completed_jobs.clone();
                let revisions = self.revision.clone();
                tokio::spawn(async move {
                    tokio::time::sleep(Duration::from_secs(8)).await;
                    completed_jobs.fetch_add(1, Ordering::Release);
                    revisions.send_modify(|revision| *revision += 1);
                    done_tx.send_replace(true);
                });
                let token = context.meta.get_progress_token();
                if let Some(token) = token.clone() {
                    context
                        .peer
                        .notify_progress(
                            ProgressNotificationParam::new(token, 0.0)
                                .with_message("Fixture job started"),
                        )
                        .await
                        .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
                }
                tokio::select! {
                    _ = done_rx.changed() => {},
                    _ = tokio::time::sleep(Duration::from_secs(5)) => {
                        if let Some(token) = token {
                            context.peer.notify_progress(ProgressNotificationParam::new(token, 5.0).with_message("Fixture job still running: five seconds elapsed")).await.map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
                        }
                        let _ = done_rx.changed().await;
                    }
                }
                json!({"status":"completed", "elapsed_seconds":8})
            }
            "wait_for_change" => {
                let after = request
                    .arguments
                    .as_ref()
                    .and_then(|args| args.get("after"))
                    .and_then(Value::as_u64)
                    .ok_or_else(|| {
                        ErrorData::invalid_params("after must be a nonnegative integer", None)
                    })?;
                let mut revisions = self.revision.subscribe();
                let changed = tokio::time::timeout(Duration::from_secs(25), async {
                    loop {
                        if *revisions.borrow_and_update() > after {
                            break;
                        }
                        if revisions.changed().await.is_err() {
                            break;
                        }
                    }
                })
                .await
                .is_ok();
                json!({"outcome": if changed { "changed" } else { "timed_out" }, "resource": self.snapshot()})
            }
            _ => return Err(ErrorData::invalid_params("Unknown fixture tool", None)),
        };
        Ok(CallToolResult::structured(result).into())
    }

    async fn list_resources(
        &self,
        _: Option<PaginatedRequestParams>,
        _: RequestContext<RoleServer>,
    ) -> Result<ListResourcesResult, ErrorData> {
        Ok(ListResourcesResult::with_all_items(vec![Resource::new(
            URI,
            "Controlled notebook state",
        )]))
    }

    async fn read_resource(
        &self,
        request: ReadResourceRequestParams,
        _: RequestContext<RoleServer>,
    ) -> Result<ReadResourceResponse, ErrorData> {
        if request.uri != URI {
            return Err(ErrorData::resource_not_found(
                "Unknown fixture resource",
                None,
            ));
        }
        Ok(ReadResourceResult::new(vec![ResourceContents::text(
            self.snapshot().to_string(),
            URI,
        )])
        .with_ttl_ms(0)
        .with_cache_scope(CacheScope::Private)
        .into())
    }

    #[allow(deprecated)]
    async fn subscribe(
        &self,
        request: SubscribeRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<(), ErrorData> {
        if request.uri != URI {
            return Err(ErrorData::resource_not_found(
                "Unknown fixture resource",
                None,
            ));
        }
        let mut task = self
            .legacy_watch
            .lock()
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        if task.is_none() {
            let mut revisions = self.revision.subscribe();
            *task = Some(tokio::spawn(async move {
                while revisions.changed().await.is_ok() {
                    if context
                        .peer
                        .notify_resource_updated(ResourceUpdatedNotificationParam::new(URI))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
            }));
        }
        Ok(())
    }

    #[allow(deprecated)]
    async fn unsubscribe(
        &self,
        _: UnsubscribeRequestParams,
        _: RequestContext<RoleServer>,
    ) -> Result<(), ErrorData> {
        if let Some(task) = self
            .legacy_watch
            .lock()
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?
            .take()
        {
            task.abort();
        }
        Ok(())
    }

    fn accepted_subscription_filter(&self, _: &SubscriptionFilter) -> Option<SubscriptionFilter> {
        Some(
            SubscriptionFilter::builder()
                .resource_subscription(URI)
                .build(),
        )
    }

    async fn listen(&self, context: SubscriptionContext) -> Result<(), ErrorData> {
        let mut revisions = self.revision.subscribe();
        loop {
            tokio::select! {
                _ = context.cancelled() => return Ok(()),
                changed = revisions.changed() => {
                    if changed.is_err() { return Ok(()); }
                    if context.accepted().resource_subscriptions.as_ref().is_some_and(|uris| uris.iter().any(|uri| uri == URI)) {
                        context.sink().notify_resource_updated(URI).await.map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
                    }
                }
            }
        }
    }
}

type Evidence = Arc<Mutex<std::fs::File>>;

fn record(log: &Evidence, direction: &str, line: &str) -> std::io::Result<()> {
    let message: Value = serde_json::from_str(line)?;
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(std::io::Error::other)?
        .as_millis();
    let mut file = log
        .lock()
        .map_err(|e| std::io::Error::other(e.to_string()))?;
    writeln!(
        file,
        "{}",
        json!({"timestamp_ms":timestamp,"direction":direction,"message":message})
    )?;
    file.flush()
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = std::env::args_os()
        .nth(1)
        .ok_or("Pass a new JSONL evidence path")?;
    let log = Arc::new(Mutex::new(
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)?,
    ));
    let (server, bridge) = tokio::io::duplex(64 * 1024);
    let (reader, mut writer) = tokio::io::split(bridge);
    let inbound_log = log.clone();
    let input = tokio::spawn(async move {
        let mut lines = BufReader::new(tokio::io::stdin()).lines();
        while let Some(line) = lines.next_line().await? {
            record(&inbound_log, "client_to_server", &line)?;
            writer.write_all(line.as_bytes()).await?;
            writer.write_all(b"\n").await?;
        }
        Ok::<(), std::io::Error>(())
    });
    let output = tokio::spawn(async move {
        let mut lines = BufReader::new(reader).lines();
        let mut stdout = tokio::io::stdout();
        while let Some(line) = lines.next_line().await? {
            record(&log, "server_to_client", &line)?;
            stdout.write_all(line.as_bytes()).await?;
            stdout.write_all(b"\n").await?;
            stdout.flush().await?;
        }
        Ok::<(), std::io::Error>(())
    });
    let probe = Probe {
        revision: watch::channel(0).0,
        legacy_watch: Mutex::new(None),
        marker: uuid::Uuid::new_v4().to_string(),
        completed_jobs: Arc::new(AtomicU64::new(0)),
    };
    probe.serve(server).await?.waiting().await?;
    input.abort();
    output.await??;
    Ok(())
}

#[cfg(test)]
#[path = "../../runt-mcp/tests/support/mod.rs"]
mod support;

#[cfg(test)]
mod tests {
    use super::*;
    use support::{modern_meta, Wire};

    fn probe() -> Probe {
        Probe {
            revision: watch::channel(0).0,
            legacy_watch: Mutex::new(None),
            marker: "changed-value".into(),
            completed_jobs: Arc::new(AtomicU64::new(0)),
        }
    }

    #[tokio::test]
    async fn legacy_subscription_delivers_change_and_wait_returns_new_context() {
        let server = probe();
        let revisions = server.revision.clone();
        let mut wire = Wire::start(server);
        wire.initialize("2025-11-25").await;
        wire.initialized().await;
        let response = wire
            .request(2, "resources/subscribe", Some(json!({"uri":URI})))
            .await;
        assert!(response.get("error").is_none(), "{response}");
        revisions.send_replace(1);
        wire.notification("notifications/resources/updated").await;
        let response = wire
            .request(
                3,
                "tools/call",
                Some(json!({"name":"wait_for_change", "arguments":{"after":0}})),
            )
            .await;
        assert_eq!(
            response["result"]["structuredContent"]["resource"]["value"],
            "changed-value"
        );
        let response = wire
            .request(4, "resources/unsubscribe", Some(json!({"uri":URI})))
            .await;
        assert!(response.get("error").is_none(), "{response}");
        assert!(wire.finish().await);
    }

    #[tokio::test]
    async fn native_listen_correlates_change_without_initialize() {
        let server = probe();
        let revisions = server.revision.clone();
        let mut wire = Wire::start(server);
        let meta = modern_meta("2026-07-28", true);
        let discovery = wire
            .request(0, "server/discover", Some(json!({"_meta":meta})))
            .await;
        assert!(discovery.get("error").is_none(), "{discovery}");
        wire.send(json!({"jsonrpc":"2.0","id":1,"method":"subscriptions/listen","params":{"notifications":{"resourceSubscriptions":[URI]},"_meta":meta}})).await;
        wire.notification("notifications/subscriptions/acknowledged")
            .await;
        revisions.send_replace(1);
        wire.notification("notifications/resources/updated").await;
        let update = wire
            .notifications
            .iter()
            .find(|message| message["method"] == "notifications/resources/updated");
        assert_eq!(
            update.map(
                |message| &message["params"]["_meta"]["io.modelcontextprotocol/subscriptionId"]
            ),
            Some(&json!(1))
        );
        wire.send(
            json!({"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":1}}),
        )
        .await;
        let response = wire
            .request(
                2,
                "resources/read",
                Some(json!({"uri":URI,"_meta":modern_meta("2026-07-28",true)})),
            )
            .await;
        assert_eq!(response["result"]["ttlMs"], 0);
        assert_eq!(response["result"]["cacheScope"], "private");
        assert!(wire.finish().await);
    }

    #[tokio::test]
    async fn canceling_progress_request_leaves_fixture_job_running() {
        let server = probe();
        let completed_jobs = server.completed_jobs.clone();
        let mut revisions = server.revision.subscribe();
        let mut wire = Wire::start(server);
        wire.initialize("2025-11-25").await;
        wire.initialized().await;
        wire.send(json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"long_job","arguments":{},"_meta":{"progressToken":"job-2"}}})).await;
        wire.notification("notifications/progress").await;
        assert_eq!(wire.notifications[0]["params"]["progressToken"], "job-2");
        wire.send(
            json!({"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":2}}),
        )
        .await;
        assert!(
            tokio::time::timeout(Duration::from_secs(10), revisions.changed())
                .await
                .is_ok()
        );
        assert_eq!(completed_jobs.load(Ordering::Acquire), 1);
        assert!(wire.finish().await);
    }
}
