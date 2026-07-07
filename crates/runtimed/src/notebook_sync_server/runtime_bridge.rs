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
}
