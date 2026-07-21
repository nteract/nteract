use super::*;

const KERNEL_LAUNCH_RETRY_BACKOFF_INITIAL: std::time::Duration =
    std::time::Duration::from_millis(100);
const KERNEL_LAUNCH_RETRY_BACKOFF_MAX: std::time::Duration = std::time::Duration::from_millis(500);

pub(crate) async fn send_runtime_agent_command(
    room: &NotebookRoom,
    request: notebook_protocol::protocol::RuntimeAgentRequest,
) -> anyhow::Result<()> {
    let tx = {
        let guard = room.runtime_agent_request_tx.lock().await;
        guard
            .clone()
            .ok_or_else(|| anyhow::anyhow!("Runtime agent not connected"))?
    };
    let envelope = notebook_protocol::protocol::RuntimeAgentRequestEnvelope {
        id: uuid::Uuid::new_v4().to_string(),
        request,
    };
    tx.send(RuntimeAgentMessage::Command(envelope))
        .await
        .map_err(|_| anyhow::anyhow!("Runtime agent disconnected"))?;
    Ok(())
}

/// Send a query to the runtime agent and wait for a sync response.
///
/// Only used for Complete and GetHistory which need return values.
pub(crate) async fn send_runtime_agent_query(
    room: &NotebookRoom,
    request: notebook_protocol::protocol::RuntimeAgentRequest,
) -> anyhow::Result<notebook_protocol::protocol::RuntimeAgentResponse> {
    let timeout = runtime_agent_query_timeout(&request);
    let tx = {
        let guard = room.runtime_agent_request_tx.lock().await;
        guard
            .clone()
            .ok_or_else(|| anyhow::anyhow!("Runtime agent not connected"))?
    };
    let envelope = notebook_protocol::protocol::RuntimeAgentRequestEnvelope {
        id: uuid::Uuid::new_v4().to_string(),
        request,
    };
    let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
    tx.send(RuntimeAgentMessage::Query(envelope, reply_tx))
        .await
        .map_err(|_| anyhow::anyhow!("Runtime agent disconnected"))?;
    recv_runtime_agent_query_response(reply_rx, timeout).await
}

async fn recv_runtime_agent_query_response(
    reply_rx: tokio::sync::oneshot::Receiver<notebook_protocol::protocol::RuntimeAgentResponse>,
    timeout: std::time::Duration,
) -> anyhow::Result<notebook_protocol::protocol::RuntimeAgentResponse> {
    match tokio::time::timeout(timeout, reply_rx).await {
        Ok(response) => response.map_err(|_| anyhow::anyhow!("Runtime agent dropped reply")),
        Err(_) => Err(anyhow::anyhow!("Runtime agent query timed out")),
    }
}

/// Send an RPC request to the runtime agent.
///
/// Routes commands as fire-and-forget and queries as sync RPCs. Callers that
/// already know they do not need a response should use
/// `send_runtime_agent_command` directly.
pub(crate) async fn send_runtime_agent_request(
    room: &NotebookRoom,
    request: notebook_protocol::protocol::RuntimeAgentRequest,
) -> anyhow::Result<notebook_protocol::protocol::RuntimeAgentResponse> {
    if request.is_command() {
        send_runtime_agent_command(room, request).await?;
        Ok(notebook_protocol::protocol::RuntimeAgentResponse::Ok)
    } else {
        send_runtime_agent_query(room, request).await
    }
}

/// Reserve daemon-owned kernel ports, send a launch/restart request, and retry
/// with a fresh reservation if the runtime agent reports a retryable launch
/// failure.
pub(crate) async fn send_runtime_agent_request_with_kernel_ports<F>(
    room: &NotebookRoom,
    mut build_request: F,
) -> anyhow::Result<notebook_protocol::protocol::RuntimeAgentResponse>
where
    F: FnMut(
        notebook_protocol::protocol::KernelPorts,
    ) -> notebook_protocol::protocol::RuntimeAgentRequest,
{
    for attempt in 1..=crate::kernel_ports::MAX_KERNEL_PORT_LAUNCH_ATTEMPTS {
        let port_reservation = crate::kernel_ports::reserve_kernel_ports().await?;
        let response =
            send_runtime_agent_request(room, build_request(port_reservation.ports())).await?;

        if let Some(delay) = kernel_launch_retry_delay(
            &response,
            attempt,
            crate::kernel_ports::MAX_KERNEL_PORT_LAUNCH_ATTEMPTS,
        ) {
            warn!(
                "[notebook-sync] Runtime agent reported retryable kernel launch failure on attempt {}/{}; retrying with fresh ports after {:?}: {}",
                attempt,
                crate::kernel_ports::MAX_KERNEL_PORT_LAUNCH_ATTEMPTS,
                delay,
                kernel_launch_failure_error(&response).unwrap_or("unknown launch failure")
            );
            tokio::time::sleep(delay).await;
            continue;
        }

        return Ok(response);
    }

    unreachable!("kernel port launch retry loop must return from the final attempt")
}

/// Send a launch/restart request and, for a captured environment only, force
/// one environment rebuild and one relaunch after a qualifying infrastructure
/// failure. The existing fresh-port retry loop remains inside each launch
/// attempt.
pub(crate) async fn send_runtime_agent_request_with_captured_env_repair<F>(
    room: &NotebookRoom,
    captured: Option<&CapturedEnv>,
    build_request: F,
) -> anyhow::Result<notebook_protocol::protocol::RuntimeAgentResponse>
where
    F: Fn(
        notebook_protocol::protocol::KernelPorts,
    ) -> notebook_protocol::protocol::RuntimeAgentRequest,
{
    run_with_one_captured_env_repair(
        captured.cloned(),
        || send_runtime_agent_request_with_kernel_ports(room, |ports| build_request(ports)),
        |captured| async move {
            rebuild_captured_environment(room, &captured)
                .await
                .map(|_| ())
        },
    )
    .await
}

async fn run_with_one_captured_env_repair<Send, SendFuture, Repair, RepairFuture>(
    captured: Option<CapturedEnv>,
    mut send: Send,
    repair: Repair,
) -> anyhow::Result<notebook_protocol::protocol::RuntimeAgentResponse>
where
    Send: FnMut() -> SendFuture,
    SendFuture: std::future::Future<
        Output = anyhow::Result<notebook_protocol::protocol::RuntimeAgentResponse>,
    >,
    Repair: FnOnce(CapturedEnv) -> RepairFuture,
    RepairFuture: std::future::Future<Output = anyhow::Result<()>>,
{
    use notebook_protocol::protocol::RuntimeAgentResponse;

    let first_response = send().await?;
    let RuntimeAgentResponse::KernelLaunchFailed {
        kind,
        error: original_error,
    } = &first_response
    else {
        return Ok(first_response);
    };

    if !crate::kernel_launch_failure::uses_captured_env_rebuild(*kind) {
        return Ok(first_response);
    }

    let Some(captured) = captured else {
        return Ok(first_response);
    };
    let original_kind = *kind;
    let original_error = original_error.clone();

    warn!(
        "[notebook-sync] Captured environment for env_id={} failed during kernel startup; rebuilding once",
        captured.env_id()
    );

    if let Err(rebuild_error) = repair(captured).await {
        return Ok(captured_env_repair_terminal_response(
            original_kind,
            &original_error,
            &format!("the rebuild failed: {rebuild_error}"),
        ));
    }

    match send().await {
        Ok(RuntimeAgentResponse::KernelLaunchFailed {
            error: retry_error, ..
        })
        | Ok(RuntimeAgentResponse::Error { error: retry_error }) => {
            Ok(captured_env_repair_terminal_response(
                original_kind,
                &original_error,
                &format!("the retry failed: {retry_error}"),
            ))
        }
        Ok(response) => Ok(response),
        Err(retry_error) => Ok(captured_env_repair_terminal_response(
            original_kind,
            &original_error,
            &format!("the retry could not be sent: {retry_error}"),
        )),
    }
}

fn captured_env_repair_terminal_response(
    original_kind: notebook_protocol::protocol::KernelLaunchFailureKind,
    original_error: &str,
    retry_detail: &str,
) -> notebook_protocol::protocol::RuntimeAgentResponse {
    notebook_protocol::protocol::RuntimeAgentResponse::KernelLaunchFailed {
        kind: original_kind,
        error: format!(
            "{original_error}\nAutomatic captured-environment rebuild was attempted, but {retry_detail}."
        ),
    }
}

fn kernel_launch_retry_delay(
    response: &notebook_protocol::protocol::RuntimeAgentResponse,
    attempt: usize,
    max_attempts: usize,
) -> Option<std::time::Duration> {
    use notebook_protocol::protocol::RuntimeAgentResponse;

    let RuntimeAgentResponse::KernelLaunchFailed { kind, .. } = response else {
        return None;
    };

    if attempt >= max_attempts {
        return None;
    }

    if crate::kernel_launch_failure::uses_fresh_port_retry(*kind) {
        Some(kernel_launch_backoff(attempt))
    } else {
        None
    }
}

fn kernel_launch_backoff(attempt: usize) -> std::time::Duration {
    let multiplier = 1_u32
        .checked_shl(attempt.saturating_sub(1) as u32)
        .unwrap_or(u32::MAX);
    KERNEL_LAUNCH_RETRY_BACKOFF_INITIAL
        .saturating_mul(multiplier)
        .min(KERNEL_LAUNCH_RETRY_BACKOFF_MAX)
}

fn kernel_launch_failure_error(
    response: &notebook_protocol::protocol::RuntimeAgentResponse,
) -> Option<&str> {
    match response {
        notebook_protocol::protocol::RuntimeAgentResponse::KernelLaunchFailed { error, .. } => {
            Some(error.as_str())
        }
        notebook_protocol::protocol::RuntimeAgentResponse::Error { error } => Some(error.as_str()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    use kernel_env::UvDependencies;
    use notebook_protocol::protocol::{KernelLaunchFailureKind, RuntimeAgentResponse};

    use super::*;

    #[tokio::test]
    async fn runtime_agent_query_response_returns_success() {
        let (tx, rx) = tokio::sync::oneshot::channel();
        tx.send(RuntimeAgentResponse::Ok)
            .expect("receiver should be live");

        let response = recv_runtime_agent_query_response(rx, std::time::Duration::from_secs(1))
            .await
            .expect("response should succeed");

        assert!(matches!(response, RuntimeAgentResponse::Ok));
    }

    #[tokio::test]
    async fn runtime_agent_query_response_reports_dropped_reply() {
        let (tx, rx) = tokio::sync::oneshot::channel();
        drop(tx);

        let error = recv_runtime_agent_query_response(rx, std::time::Duration::from_secs(1))
            .await
            .expect_err("dropped reply should fail");

        assert_eq!(error.to_string(), "Runtime agent dropped reply");
    }

    #[tokio::test]
    async fn runtime_agent_query_response_reports_timeout() {
        let (_tx, rx) = tokio::sync::oneshot::channel();

        let error = recv_runtime_agent_query_response(rx, std::time::Duration::from_millis(1))
            .await
            .expect_err("timeout should fail");

        assert_eq!(error.to_string(), "Runtime agent query timed out");
    }

    #[test]
    fn kernel_launch_retry_delay_retries_startup_transport_before_final_attempt() {
        let response = RuntimeAgentResponse::KernelLaunchFailed {
            kind: KernelLaunchFailureKind::RetryableStartupTransport,
            error: "Failed to launch kernel: Connection reset by peer".to_string(),
        };

        assert_eq!(
            kernel_launch_retry_delay(&response, 1, 4),
            Some(std::time::Duration::from_millis(100))
        );
        assert_eq!(
            kernel_launch_retry_delay(&response, 3, 4),
            Some(std::time::Duration::from_millis(400))
        );
    }

    #[test]
    fn kernel_launch_retry_delay_retries_port_bind_before_final_attempt() {
        let response = RuntimeAgentResponse::KernelLaunchFailed {
            kind: KernelLaunchFailureKind::PortBind,
            error: "Failed to launch kernel: Address already in use".to_string(),
        };

        assert_eq!(
            kernel_launch_retry_delay(&response, 2, 4),
            Some(std::time::Duration::from_millis(200))
        );
    }

    #[test]
    fn kernel_launch_retry_delay_stops_on_final_attempt() {
        let response = RuntimeAgentResponse::KernelLaunchFailed {
            kind: KernelLaunchFailureKind::RetryableStartupTransport,
            error: "Failed to launch kernel: Connection reset by peer".to_string(),
        };

        assert_eq!(kernel_launch_retry_delay(&response, 4, 4), None);
    }

    #[test]
    fn kernel_launch_retry_delay_does_not_retry_process_exit() {
        let response = RuntimeAgentResponse::KernelLaunchFailed {
            kind: KernelLaunchFailureKind::ProcessExited,
            error: "Failed to launch kernel: Kernel process exited: exit status: 1".to_string(),
        };

        assert_eq!(kernel_launch_retry_delay(&response, 1, 4), None);
    }

    fn captured_uv() -> CapturedEnv {
        CapturedEnv::Uv {
            deps: UvDependencies {
                dependencies: vec!["pandas".to_string()],
                requires_python: None,
                prerelease: None,
            },
            env_id: "captured-test".to_string(),
        }
    }

    #[tokio::test]
    async fn captured_env_failure_rebuilds_and_relaunches_exactly_once() {
        let sends = Arc::new(AtomicUsize::new(0));
        let repairs = Arc::new(AtomicUsize::new(0));

        let response = run_with_one_captured_env_repair(
            Some(captured_uv()),
            {
                let sends = sends.clone();
                move || {
                    let attempt = sends.fetch_add(1, Ordering::SeqCst);
                    async move {
                        if attempt == 0 {
                            Ok(RuntimeAgentResponse::KernelLaunchFailed {
                                kind: KernelLaunchFailureKind::ProcessExited,
                                error: "original launch failure".to_string(),
                            })
                        } else {
                            Ok(RuntimeAgentResponse::KernelLaunched {
                                env_source: notebook_protocol::connection::EnvSource::parse(
                                    "uv:prewarmed",
                                ),
                            })
                        }
                    }
                }
            },
            {
                let repairs = repairs.clone();
                move |_| {
                    repairs.fetch_add(1, Ordering::SeqCst);
                    std::future::ready(Ok(()))
                }
            },
        )
        .await
        .expect("retry should complete");

        assert!(matches!(
            response,
            RuntimeAgentResponse::KernelLaunched { .. }
        ));
        assert_eq!(sends.load(Ordering::SeqCst), 2);
        assert_eq!(repairs.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn non_captured_launch_never_rebuilds_or_retries() {
        let sends = Arc::new(AtomicUsize::new(0));
        let repairs = Arc::new(AtomicUsize::new(0));

        let response = run_with_one_captured_env_repair(
            None,
            {
                let sends = sends.clone();
                move || {
                    sends.fetch_add(1, Ordering::SeqCst);
                    std::future::ready(Ok(RuntimeAgentResponse::KernelLaunchFailed {
                        kind: KernelLaunchFailureKind::ProcessExited,
                        error: "original launch failure".to_string(),
                    }))
                }
            },
            {
                let repairs = repairs.clone();
                move |_| {
                    repairs.fetch_add(1, Ordering::SeqCst);
                    std::future::ready(Ok(()))
                }
            },
        )
        .await
        .expect("failure response should be returned");

        assert!(matches!(
            response,
            RuntimeAgentResponse::KernelLaunchFailed { .. }
        ));
        assert_eq!(sends.load(Ordering::SeqCst), 1);
        assert_eq!(repairs.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn fresh_port_failure_never_enters_captured_env_rebuild_layer() {
        let sends = Arc::new(AtomicUsize::new(0));
        let repairs = Arc::new(AtomicUsize::new(0));

        let response = run_with_one_captured_env_repair(
            Some(captured_uv()),
            {
                let sends = sends.clone();
                move || {
                    sends.fetch_add(1, Ordering::SeqCst);
                    std::future::ready(Ok(RuntimeAgentResponse::KernelLaunchFailed {
                        kind: KernelLaunchFailureKind::PortBind,
                        error: "fresh-port retries exhausted".to_string(),
                    }))
                }
            },
            {
                let repairs = repairs.clone();
                move |_| {
                    repairs.fetch_add(1, Ordering::SeqCst);
                    std::future::ready(Ok(()))
                }
            },
        )
        .await
        .expect("port failure should be returned");

        assert!(matches!(
            response,
            RuntimeAgentResponse::KernelLaunchFailed {
                kind: KernelLaunchFailureKind::PortBind,
                ..
            }
        ));
        assert_eq!(sends.load(Ordering::SeqCst), 1);
        assert_eq!(repairs.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn second_failure_preserves_original_error_without_a_retry_loop() {
        let sends = Arc::new(AtomicUsize::new(0));
        let repairs = Arc::new(AtomicUsize::new(0));

        let response = run_with_one_captured_env_repair(
            Some(captured_uv()),
            {
                let sends = sends.clone();
                move || {
                    let attempt = sends.fetch_add(1, Ordering::SeqCst);
                    std::future::ready(Ok(RuntimeAgentResponse::KernelLaunchFailed {
                        kind: KernelLaunchFailureKind::ProcessExited,
                        error: if attempt == 0 {
                            "original launch failure".to_string()
                        } else {
                            "different retry failure".to_string()
                        },
                    }))
                }
            },
            {
                let repairs = repairs.clone();
                move |_| {
                    repairs.fetch_add(1, Ordering::SeqCst);
                    std::future::ready(Ok(()))
                }
            },
        )
        .await
        .expect("terminal response should be returned");

        let RuntimeAgentResponse::KernelLaunchFailed { error, .. } = response else {
            panic!("expected terminal launch failure");
        };
        assert!(error.starts_with("original launch failure"));
        assert!(error.contains("Automatic captured-environment rebuild was attempted"));
        assert!(error.contains("different retry failure"));
        assert_eq!(sends.load(Ordering::SeqCst), 2);
        assert_eq!(repairs.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn retry_transport_failure_preserves_original_error_without_a_third_send() {
        let sends = Arc::new(AtomicUsize::new(0));
        let repairs = Arc::new(AtomicUsize::new(0));

        let response = run_with_one_captured_env_repair(
            Some(captured_uv()),
            {
                let sends = sends.clone();
                move || {
                    let attempt = sends.fetch_add(1, Ordering::SeqCst);
                    async move {
                        if attempt == 0 {
                            Ok(RuntimeAgentResponse::KernelLaunchFailed {
                                kind: KernelLaunchFailureKind::ProcessExited,
                                error: "original launch failure".to_string(),
                            })
                        } else {
                            Err(anyhow::anyhow!("runtime-agent channel closed"))
                        }
                    }
                }
            },
            {
                let repairs = repairs.clone();
                move |_| {
                    repairs.fetch_add(1, Ordering::SeqCst);
                    std::future::ready(Ok(()))
                }
            },
        )
        .await
        .expect("transport failure should be normalized to a terminal response");

        let RuntimeAgentResponse::KernelLaunchFailed { error, .. } = response else {
            panic!("expected terminal launch failure");
        };
        assert!(error.starts_with("original launch failure"));
        assert!(error.contains("the retry could not be sent"));
        assert!(error.contains("runtime-agent channel closed"));
        assert_eq!(sends.load(Ordering::SeqCst), 2);
        assert_eq!(repairs.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn rebuild_failure_preserves_original_error_without_relaunching() {
        let sends = Arc::new(AtomicUsize::new(0));

        let response = run_with_one_captured_env_repair(
            Some(captured_uv()),
            {
                let sends = sends.clone();
                move || {
                    sends.fetch_add(1, Ordering::SeqCst);
                    std::future::ready(Ok(RuntimeAgentResponse::KernelLaunchFailed {
                        kind: KernelLaunchFailureKind::ToolBootstrap,
                        error: "original launch failure".to_string(),
                    }))
                }
            },
            |_| std::future::ready(Err(anyhow::anyhow!("package index unavailable"))),
        )
        .await
        .expect("terminal response should be returned");

        let RuntimeAgentResponse::KernelLaunchFailed { error, .. } = response else {
            panic!("expected terminal launch failure");
        };
        assert!(error.starts_with("original launch failure"));
        assert!(error.contains("package index unavailable"));
        assert_eq!(sends.load(Ordering::SeqCst), 1);
    }
}
