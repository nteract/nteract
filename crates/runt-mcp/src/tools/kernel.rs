//! Kernel management tools: interrupt_kernel, restart_kernel.

use rmcp::model::{CallToolRequestParams, CallToolResult};
use rmcp::ErrorData as McpError;

use notebook_protocol::protocol::{NotebookRequest, NotebookResponse};
use notebook_sync::SyncError;

use crate::NteractMcp;

use super::{tool_error, tool_success};

#[derive(Debug)]
enum RestartRetryAccessError {
    Disconnected,
    SessionAccess(crate::session::SessionAccessError),
}

fn restart_retry_access(
    access: Result<Option<crate::session::SessionAccess>, crate::session::SessionAccessError>,
) -> Result<crate::session::SessionAccess, RestartRetryAccessError> {
    match access {
        Ok(Some(access)) => Ok(access),
        Ok(None) => Err(RestartRetryAccessError::Disconnected),
        Err(error) => Err(RestartRetryAccessError::SessionAccess(error)),
    }
}

/// Interrupt the currently executing cell.
pub async fn interrupt_kernel(
    server: &NteractMcp,
    _request: &CallToolRequestParams,
) -> Result<CallToolResult, McpError> {
    let access = require_session_access!(server, Execute);
    let handle = access.handle.clone();

    let response = handle
        .send_request(NotebookRequest::InterruptExecution {})
        .await;
    if let Err(error) = server.ensure_session_access_current(&access).await {
        return super::session_access_error(error);
    }
    match response {
        Ok(_) => {
            let result = serde_json::json!({ "interrupted": true });
            tool_success(&serde_json::to_string_pretty(&result).unwrap_or_default())
        }
        Err(e) => tool_error(&format!("Failed to interrupt kernel: {e}")),
    }
}

/// Restart the kernel, clearing all state.
pub async fn restart_kernel(
    server: &NteractMcp,
    _request: &CallToolRequestParams,
) -> Result<CallToolResult, McpError> {
    let access = require_session_access!(server, Execute);
    let handle = access.handle.clone();
    let notebook_id = access.notebook_id.clone();

    // Capture kernel_type and env_source from the *current* RuntimeState
    // before shutdown. After a daemon restart the fresh RuntimeStateDoc has
    // kernel.name = "" and env_source = "", so reading it post-reconnect
    // would silently regress to "python" / "auto:uv".
    let (pre_shutdown_kernel_type, pre_shutdown_env_source) = {
        let state = handle.get_runtime_state().ok();
        let kernel_type = state
            .as_ref()
            .and_then(|s| {
                let name = &s.kernel.name;
                if name.is_empty() {
                    None
                } else {
                    Some(name.clone())
                }
            })
            .unwrap_or_else(|| "python".to_string());
        let env_source = state
            .as_ref()
            .map(|s| s.kernel.env_source.clone())
            .filter(|s| !s.is_empty());
        (kernel_type, env_source)
    };

    // Step 1: Shutdown existing kernel
    match handle
        .send_request(NotebookRequest::ShutdownKernel {})
        .await
    {
        Ok(_) | Err(_) => {
            // Even if shutdown fails (no kernel), proceed to launch
        }
    }
    if let Err(error) = server.ensure_session_access_current(&access).await {
        return super::session_access_error(error);
    }

    // Brief pause for shutdown to complete
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    if let Err(error) = server.ensure_session_access_current(&access).await {
        return super::session_access_error(error);
    }

    // Step 2: Get a fresh handle (the original may have been invalidated by
    // a daemon restart during the shutdown sequence). If the session was
    // replaced by daemon_watch's rejoin, we pick up the new one.
    let refreshed_access = match server
        .session_access(crate::session::SessionRequirement::Execute)
        .await
    {
        Ok(Some(access)) => access,
        Err(error) => return super::session_access_error(error),
        Ok(None) => {
            // Session dropped — wait for daemon_watch to rejoin.
            tokio::time::sleep(std::time::Duration::from_secs(8)).await;
            match server
                .session_access(crate::session::SessionRequirement::Execute)
                .await
            {
                Ok(Some(access)) => access,
                Err(error) => return super::session_access_error(error),
                Ok(None) => {
                    return tool_error(
                        "Lost connection to daemon during kernel restart. \
                         The session will auto-reconnect — retry in a few seconds.",
                    )
                }
            }
        }
    };
    if refreshed_access.readiness.session_generation != access.readiness.session_generation
        || refreshed_access.readiness.target != access.readiness.target
        || refreshed_access.notebook_id != access.notebook_id
    {
        return super::session_access_error(crate::session::SessionAccessError {
            code: "session_superseded",
            message: "Notebook target changed during kernel restart".to_string(),
            readiness: Box::new(access.readiness.clone()),
        });
    }
    let handle = refreshed_access.handle.clone();

    // Ensure daemon has latest metadata (deps may have changed since last sync)
    if let Err(e) = handle.confirm_sync().await {
        tracing::warn!("confirm_sync failed before restart_kernel launch: {e}");
    }
    if let Err(error) = server
        .ensure_session_access_current(&refreshed_access)
        .await
    {
        return super::session_access_error(error);
    }

    // Step 3: Determine env_source. Prefer the pre-shutdown env_source
    // captured above — it's authoritative for the kernel that was running.
    // After shutdown (or after a daemon restart that clears RuntimeStateDoc)
    // the handle's runtime state may be empty, and detect_package_manager
    // would fall through to the Uv default, losing conda/pixi context.
    let kernel_type = pre_shutdown_kernel_type;
    let env_source = {
        use notebook_protocol::connection::{EnvSource, PackageManager};
        if let Some(ref prev) = pre_shutdown_env_source {
            // Derive the scoped auto-detect from the previous env_source,
            // preserving the package manager family. The daemon's auto:*
            // variants re-resolve through the normal launch priority
            // (project files unless opted out, then notebook metadata and prewarmed).
            match EnvSource::parse(prev) {
                EnvSource::Prewarmed(PackageManager::Conda) => "auto:conda".to_string(),
                EnvSource::Prewarmed(PackageManager::Pixi) => "auto:pixi".to_string(),
                EnvSource::Prewarmed(PackageManager::Uv) => "auto:uv".to_string(),
                EnvSource::Deno => "deno".to_string(),
                other => {
                    // For inline, pep723, project-file etc. use the scoped
                    // auto variant matching the package manager, or fall back
                    // to the raw value.
                    if let Some(pm) = other.package_manager() {
                        match pm {
                            PackageManager::Conda => "auto:conda".to_string(),
                            PackageManager::Pixi => "auto:pixi".to_string(),
                            _ => "auto:uv".to_string(),
                        }
                    } else {
                        other.as_str().to_string()
                    }
                }
            }
        } else {
            // No pre-shutdown env_source (daemon may have been fresh).
            // Fall back to metadata-based detection.
            let detected_manager = super::deps::detect_package_manager(&handle);
            match detected_manager.as_str() {
                "pixi" => "auto:pixi".to_string(),
                "conda" => "auto:conda".to_string(),
                _ => "auto:uv".to_string(),
            }
        }
    };

    // Step 4: Launch kernel
    let notebook_path = if notebook_id.contains('/') || notebook_id.contains('\\') {
        Some(notebook_id)
    } else {
        None
    };

    let launch_result = handle
        .send_request(NotebookRequest::LaunchKernel {
            kernel_type: kernel_type.clone(),
            env_source: notebook_protocol::connection::LaunchSpec::parse(&env_source),
            notebook_path: notebook_path.clone(),
        })
        .await;

    // If LaunchKernel failed with a disconnection, the daemon may have
    // restarted. Wait for the health monitor to reconnect and retry once.
    let launch_result = match launch_result {
        Err(SyncError::Disconnected) => {
            tracing::warn!("LaunchKernel disconnected during restart, waiting for reconnection");
            tokio::time::sleep(std::time::Duration::from_secs(8)).await;
            if let Err(error) = server
                .ensure_session_access_current(&refreshed_access)
                .await
            {
                return super::session_access_error(error);
            }
            match restart_retry_access(
                server
                    .session_access(crate::session::SessionRequirement::Execute)
                    .await,
            ) {
                Ok(access) => {
                    if access.readiness.session_generation
                        != refreshed_access.readiness.session_generation
                        || access.readiness.target != refreshed_access.readiness.target
                        || access.notebook_id != refreshed_access.notebook_id
                    {
                        return super::session_access_error(crate::session::SessionAccessError {
                            code: "session_superseded",
                            message: "Notebook target changed while retrying kernel restart"
                                .to_string(),
                            readiness: Box::new(refreshed_access.readiness.clone()),
                        });
                    }
                    let fresh_handle = access.handle;
                    if let Err(e) = fresh_handle.confirm_sync().await {
                        tracing::warn!(
                            "confirm_sync failed before restart_kernel retry launch: {e}"
                        );
                    }
                    fresh_handle
                        .send_request(NotebookRequest::LaunchKernel {
                            kernel_type: kernel_type.clone(),
                            env_source: notebook_protocol::connection::LaunchSpec::parse(
                                &env_source,
                            ),
                            notebook_path,
                        })
                        .await
                }
                Err(RestartRetryAccessError::Disconnected) => Err(SyncError::Disconnected),
                Err(RestartRetryAccessError::SessionAccess(error)) => {
                    return super::session_access_error(error)
                }
            }
        }
        other => other,
    };

    match launch_result {
        Ok(NotebookResponse::KernelLaunched { .. })
        | Ok(NotebookResponse::KernelAlreadyRunning { .. }) => {
            // Poll RuntimeState for kernel to become ready.
            // Re-read the session handle each iteration in case it was
            // replaced by the health monitor during reconnection.
            let start = std::time::Instant::now();
            let timeout = std::time::Duration::from_secs(120);
            loop {
                if start.elapsed() >= timeout {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                if let Err(error) = server
                    .ensure_session_access_current(&refreshed_access)
                    .await
                {
                    return super::session_access_error(error);
                }
                let current_access = server
                    .session_access(crate::session::SessionRequirement::RuntimeRead)
                    .await
                    .ok()
                    .flatten();
                let Some(current_access) = current_access else {
                    continue;
                };
                if current_access.readiness.session_generation
                    != refreshed_access.readiness.session_generation
                    || current_access.readiness.target != refreshed_access.readiness.target
                {
                    return super::session_access_error(crate::session::SessionAccessError {
                        code: "session_superseded",
                        message: "Notebook target changed while waiting for kernel restart"
                            .to_string(),
                        readiness: Box::new(refreshed_access.readiness.clone()),
                    });
                }
                let h = current_access.handle;
                if let Ok(state) = h.get_runtime_state() {
                    if matches!(
                        state.kernel.lifecycle,
                        runtime_doc::RuntimeLifecycle::Running(_)
                    ) {
                        break;
                    }
                    if matches!(state.kernel.lifecycle, runtime_doc::RuntimeLifecycle::Error) {
                        return tool_error("Kernel failed to start");
                    }
                }
            }

            let result = serde_json::json!({
                "restarted": true,
                "env_source": env_source,
            });
            tool_success(&serde_json::to_string_pretty(&result).unwrap_or_default())
        }
        Ok(NotebookResponse::Error { error }) => {
            tool_error(&format!("Failed to restart kernel: {error}"))
        }
        Ok(NotebookResponse::GuardRejected { reason }) => tool_error(&format!(
            "Kernel restart blocked by notebook trust: {reason}"
        )),
        Ok(_) => tool_success(&serde_json::json!({ "restarted": true }).to_string()),
        Err(e) => tool_error(&format!("Failed to restart kernel: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn readiness(target: &str) -> crate::session::SessionReadiness {
        crate::session::SessionReadiness {
            session_generation: 7,
            target: target.to_string(),
            source_state: serde_json::json!({ "state": "ready" }),
            projection_ready: true,
            document_ready: true,
            runtime_ready: true,
            interactive: true,
            projection_heads: vec!["notebook-head".to_string()],
            runtime_state_heads: vec!["runtime-head".to_string()],
            projection_completeness: Some("complete".to_string()),
            capabilities: crate::session::SessionCapabilities {
                read: true,
                mutate: true,
                execute: true,
            },
        }
    }

    #[test]
    fn restart_retry_treats_missing_session_as_disconnected() {
        let result = restart_retry_access(Ok(None));

        assert!(matches!(result, Err(RestartRetryAccessError::Disconnected)));
    }

    #[test]
    fn restart_retry_preserves_structured_session_access_error() {
        let error = crate::session::SessionAccessError {
            code: "session_superseded",
            message: "A newer notebook target superseded this session".to_string(),
            readiness: Box::new(readiness("notebook:new-target")),
        };

        let result = restart_retry_access(Err(error));
        let Err(RestartRetryAccessError::SessionAccess(error)) = result else {
            panic!("expected structured session access error");
        };

        assert_eq!(error.code, "session_superseded");
        assert_eq!(
            error.message,
            "A newer notebook target superseded this session"
        );
        assert_eq!(error.readiness.session_generation, 7);
        assert_eq!(error.readiness.target, "notebook:new-target");
    }
}
