use std::io::ErrorKind;

use notebook_protocol::protocol::KernelLaunchFailureKind;

pub(crate) fn classify(error: &anyhow::Error) -> KernelLaunchFailureKind {
    if error.chain().any(is_retryable_startup_transport_cause) {
        return KernelLaunchFailureKind::RetryableStartupTransport;
    }

    let message = error
        .chain()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join("\n");
    classify_message(&message)
}

pub(crate) fn uses_fresh_port_retry(kind: KernelLaunchFailureKind) -> bool {
    matches!(
        kind,
        KernelLaunchFailureKind::PortBind | KernelLaunchFailureKind::RetryableStartupTransport
    )
}

/// Whether a launch failure from a notebook-captured environment may be
/// repaired by rebuilding that environment once.
pub(crate) fn uses_captured_env_rebuild(kind: KernelLaunchFailureKind) -> bool {
    matches!(
        kind,
        KernelLaunchFailureKind::ProcessExited
            | KernelLaunchFailureKind::StartupTimeout
            | KernelLaunchFailureKind::ToolBootstrap
    )
}

/// Runtime-agent launch failures for which the coordinator owns a retry
/// decision. The agent must not publish a terminal lifecycle before that
/// decision is made.
pub(crate) fn coordinator_may_retry(kind: KernelLaunchFailureKind) -> bool {
    uses_fresh_port_retry(kind) || uses_captured_env_rebuild(kind)
}

fn classify_message(message: &str) -> KernelLaunchFailureKind {
    let lower = message.to_ascii_lowercase();

    if crate::kernel_ports::is_kernel_port_bind_error(&lower) {
        return KernelLaunchFailureKind::PortBind;
    }

    if contains_retryable_startup_transport_text(&lower) {
        return KernelLaunchFailureKind::RetryableStartupTransport;
    }

    if lower.contains("kernel process exited") || lower.contains("kernel process died") {
        return KernelLaunchFailureKind::ProcessExited;
    }

    if lower.contains("timed out")
        || lower.contains("did not respond within")
        || lower.contains("connect timed out")
    {
        return KernelLaunchFailureKind::StartupTimeout;
    }

    if lower.contains("unsupported kernel type") {
        return KernelLaunchFailureKind::Unsupported;
    }

    if lower.contains("no such file or directory")
        || lower.contains("command not found")
        || lower.contains("failed to execute")
    {
        return KernelLaunchFailureKind::ToolBootstrap;
    }

    KernelLaunchFailureKind::Other
}

fn is_retryable_startup_transport_cause(error: &(dyn std::error::Error + 'static)) -> bool {
    if let Some(io) = error.downcast_ref::<std::io::Error>() {
        return is_retryable_startup_io_error(io.kind());
    }

    if let Some(jupyter) = error.downcast_ref::<jupyter_zmq_client::RuntimeError>() {
        return is_retryable_jupyter_startup_transport_error(jupyter);
    }

    false
}

fn is_retryable_jupyter_startup_transport_error(error: &jupyter_zmq_client::RuntimeError) -> bool {
    match error {
        jupyter_zmq_client::RuntimeError::IoError(source) => {
            is_retryable_startup_io_error(source.kind())
        }
        jupyter_zmq_client::RuntimeError::ZmqError(source) => {
            contains_retryable_startup_transport_text(&source.to_string().to_ascii_lowercase())
        }
        _ => false,
    }
}

fn is_retryable_startup_io_error(kind: ErrorKind) -> bool {
    matches!(
        kind,
        ErrorKind::ConnectionReset
            | ErrorKind::UnexpectedEof
            | ErrorKind::BrokenPipe
            | ErrorKind::ConnectionAborted
    )
}

fn contains_retryable_startup_transport_text(lowercase_message: &str) -> bool {
    lowercase_message.contains("connection reset")
        || lowercase_message.contains("broken pipe")
        || lowercase_message.contains("connection aborted")
        || lowercase_message.contains("unexpected eof")
        || lowercase_message.contains("unexpected end of file")
        || lowercase_message.contains("early eof")
        || lowercase_message.contains("failed to fill whole buffer")
}

#[cfg(test)]
mod tests {
    use anyhow::anyhow;

    use super::*;

    #[test]
    fn classifies_typed_io_connection_reset_as_retryable_startup_transport() {
        let error = anyhow::Error::new(jupyter_zmq_client::RuntimeError::IoError(
            std::io::Error::from(ErrorKind::ConnectionReset),
        ));

        assert_eq!(
            classify(&error),
            KernelLaunchFailureKind::RetryableStartupTransport
        );
    }

    #[test]
    fn classifies_issue_reset_message_as_retryable_startup_transport() {
        let error = anyhow!(
            "Failed to launch kernel: Codec/Network Error: Connection reset by peer (os error 104)"
        );

        assert_eq!(
            classify(&error),
            KernelLaunchFailureKind::RetryableStartupTransport
        );
    }

    #[test]
    fn classifies_port_bind_as_port_bind() {
        let error = anyhow!("Failed to launch kernel: Address already in use (os error 48)");

        assert_eq!(classify(&error), KernelLaunchFailureKind::PortBind);
    }

    #[test]
    fn classifies_process_exit_as_process_exited() {
        let error = anyhow!("Kernel process exited: exit status: 1");

        assert_eq!(classify(&error), KernelLaunchFailureKind::ProcessExited);
    }

    #[test]
    fn classifies_startup_timeout_without_retryable_transport() {
        let error = anyhow!("Kernel did not respond within 30s");

        assert_eq!(classify(&error), KernelLaunchFailureKind::StartupTimeout);
    }

    #[test]
    fn fresh_port_retry_applies_only_to_retryable_launch_kinds() {
        assert!(uses_fresh_port_retry(
            KernelLaunchFailureKind::RetryableStartupTransport
        ));
        assert!(uses_fresh_port_retry(KernelLaunchFailureKind::PortBind));
        assert!(!uses_fresh_port_retry(
            KernelLaunchFailureKind::ProcessExited
        ));
        assert!(!uses_fresh_port_retry(
            KernelLaunchFailureKind::StartupTimeout
        ));
        assert!(!uses_fresh_port_retry(
            KernelLaunchFailureKind::ToolBootstrap
        ));
        assert!(!uses_fresh_port_retry(
            KernelLaunchFailureKind::Misconfiguration
        ));
        assert!(!uses_fresh_port_retry(KernelLaunchFailureKind::Unsupported));
        assert!(!uses_fresh_port_retry(KernelLaunchFailureKind::Other));
    }

    #[test]
    fn captured_env_rebuild_applies_only_to_environment_infrastructure_failures() {
        assert!(uses_captured_env_rebuild(
            KernelLaunchFailureKind::ProcessExited
        ));
        assert!(uses_captured_env_rebuild(
            KernelLaunchFailureKind::StartupTimeout
        ));
        assert!(uses_captured_env_rebuild(
            KernelLaunchFailureKind::ToolBootstrap
        ));

        for kind in [
            KernelLaunchFailureKind::RetryableStartupTransport,
            KernelLaunchFailureKind::PortBind,
            KernelLaunchFailureKind::Misconfiguration,
            KernelLaunchFailureKind::Unsupported,
            KernelLaunchFailureKind::Other,
        ] {
            assert!(
                !uses_captured_env_rebuild(kind),
                "unexpected retry: {kind:?}"
            );
        }
    }

    #[test]
    fn coordinator_owns_all_retryable_launch_failures() {
        for kind in [
            KernelLaunchFailureKind::RetryableStartupTransport,
            KernelLaunchFailureKind::PortBind,
            KernelLaunchFailureKind::ProcessExited,
            KernelLaunchFailureKind::StartupTimeout,
            KernelLaunchFailureKind::ToolBootstrap,
        ] {
            assert!(coordinator_may_retry(kind), "missing retry owner: {kind:?}");
        }
    }
}
