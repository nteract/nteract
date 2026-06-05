//! Launch and drive a local Jupyter (python `ipykernel`) kernel directly over
//! ZMQ, reusing the published `jupyter-protocol` + `jupyter-zmq-client` crates.
//!
//! The daemon's `JupyterKernel` is welded to daemon-only shared state
//! (`KernelSharedRefs`: BlobStore, broadcast channels, RuntimeStateHandle), so
//! it can't be called from a standalone binary. This is a thin re-implementation
//! of the launch + drive loop the daemon performs, mirroring its TCP branch in
//! `crates/runtimed/src/jupyter_kernel.rs`. We launch stock `ipykernel_launcher`
//! (no `nteract_kernel_launcher`, so no launcher cache), connect shell + iopub +
//! control, and route IOPub by `parent_header.msg_id == execution_id`.

use std::process::Stdio as ProcStdio;

use anyhow::{anyhow, Context, Result};
use jupyter_protocol::connection_info::Transport;
use jupyter_protocol::{
    ConnectionInfo, ExecuteRequest, JupyterMessage, JupyterMessageContent, KernelInfoRequest,
};
use tracing::{info, warn};
use uuid::Uuid;

/// A launched kernel plus the connections we drive it through.
pub struct Kernel {
    pub child: tokio::process::Child,
    pub connection_info: ConnectionInfo,
    pub session_id: String,
    pub iopub: jupyter_zmq_client::ClientIoPubConnection,
    pub shell: jupyter_zmq_client::ClientShellConnection,
    pub control: jupyter_zmq_client::ClientControlConnection,
    connection_file: std::path::PathBuf,
}

impl Kernel {
    /// Spawn `python -m ipykernel_launcher -f <conn>` on self-chosen TCP ports
    /// and connect the shell + iopub + control sockets. `python` is the
    /// interpreter path (must have `ipykernel`); `venv` is an optional
    /// `VIRTUAL_ENV` to export.
    pub async fn launch(python: &str, venv: Option<&str>) -> Result<Self> {
        let ports = allocate_ports().context("allocate kernel ports")?;
        let session_id = Uuid::new_v4().to_string();
        let connection_info = ConnectionInfo {
            transport: Transport::TCP,
            ip: "127.0.0.1".to_string(),
            stdin_port: ports[0],
            control_port: ports[1],
            hb_port: ports[2],
            shell_port: ports[3],
            iopub_port: ports[4],
            signature_scheme: "hmac-sha256".to_string(),
            key: Uuid::new_v4().to_string(),
            kernel_name: Some("python3".to_string()),
        };

        let connection_file = std::env::temp_dir().join(format!("runt-kernel-{session_id}.json"));
        tokio::fs::write(
            &connection_file,
            serde_json::to_string_pretty(&connection_info)?,
        )
        .await
        .context("write connection file")?;

        let mut cmd = tokio::process::Command::new(python);
        cmd.args(["-Xfrozen_modules=off", "-m", "ipykernel_launcher", "-f"]);
        cmd.arg(&connection_file);
        cmd.stdout(ProcStdio::null());
        cmd.stderr(ProcStdio::piped());
        if let Some(venv) = venv {
            cmd.env("VIRTUAL_ENV", venv);
        }
        let child = cmd.spawn().with_context(|| {
            format!("spawn `{python} -m ipykernel_launcher` (is ipykernel installed?)")
        })?;
        info!(
            "launched kernel: python={python} pid={:?} ports={ports:?}",
            child.id()
        );

        // Subscribe IOPub before any execute so we don't miss a SUB slow-joiner
        // window for our own requests.
        let iopub =
            jupyter_zmq_client::create_client_iopub_connection(&connection_info, "", &session_id)
                .await
                .context("connect iopub")?;
        let identity = jupyter_zmq_client::peer_identity_for_session(&session_id)
            .context("derive shell peer identity")?;
        let shell = jupyter_zmq_client::create_client_shell_connection_with_identity(
            &connection_info,
            &session_id,
            identity,
        )
        .await
        .context("connect shell")?;
        let control =
            jupyter_zmq_client::create_client_control_connection(&connection_info, &session_id)
                .await
                .context("connect control")?;

        Ok(Self {
            child,
            connection_info,
            session_id,
            iopub,
            shell,
            control,
            connection_file,
        })
    }

    /// Send a `kernel_info_request` and wait for the kernel to report Idle on
    /// IOPub, confirming the connection is live and the kernel is ready.
    pub async fn wait_until_ready(&mut self, timeout: std::time::Duration) -> Result<()> {
        let req: JupyterMessage = KernelInfoRequest {}.into();
        self.shell.send(req).await.context("send kernel_info")?;
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let msg = tokio::time::timeout_at(deadline, self.iopub.read())
                .await
                .map_err(|_| anyhow!("kernel did not become ready within {timeout:?}"))?
                .context("read iopub during readiness")?;
            if let JupyterMessageContent::Status(status) = &msg.content {
                if matches!(
                    status.execution_state,
                    jupyter_protocol::ExecutionState::Idle
                ) {
                    info!("kernel ready (idle)");
                    return Ok(());
                }
            }
        }
    }

    /// Send an `execute_request` for `source`, with `msg_id = execution_id` so
    /// IOPub replies carry `parent_header.msg_id == execution_id`.
    pub async fn execute(
        &mut self,
        execution_id: &str,
        cell_id: Option<&str>,
        source: &str,
    ) -> Result<()> {
        let mut message: JupyterMessage = ExecuteRequest::new(source.to_string()).into();
        message.header.msg_id = execution_id.to_string();
        let mut nteract = serde_json::json!({ "execution_id": execution_id });
        if let Some(cell_id) = cell_id {
            nteract["cell_id"] = serde_json::Value::String(cell_id.to_string());
        }
        message.metadata = serde_json::json!({ "nteract": nteract });
        self.shell
            .send(message)
            .await
            .context("send execute_request")?;
        Ok(())
    }
}

/// Bind five ephemeral TCP ports, record them, and release the listeners so the
/// kernel can claim them. There is a small race window between release and the
/// kernel binding; acceptable for a single-tenant host.
fn allocate_ports() -> Result<[u16; 5]> {
    let mut ports = [0u16; 5];
    for slot in &mut ports {
        let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
        *slot = listener.local_addr()?.port();
    }
    Ok(ports)
}

/// Convert an IOPub message's content to an nbformat output value, mirroring the
/// daemon's `output_prep::message_content_to_nbformat` (which is `pub(crate)`).
/// Returns `None` for content that is not an output (status, execute_input, ...).
pub fn content_to_nbformat(content: &JupyterMessageContent) -> Option<serde_json::Value> {
    use serde_json::json;
    match content {
        JupyterMessageContent::StreamContent(stream) => {
            let name = match stream.name {
                jupyter_protocol::Stdio::Stdout => "stdout",
                jupyter_protocol::Stdio::Stderr => "stderr",
            };
            Some(json!({ "output_type": "stream", "name": name, "text": stream.text }))
        }
        JupyterMessageContent::DisplayData(data) => {
            let mut output = json!({
                "output_type": "display_data",
                "data": data.data,
                "metadata": data.metadata,
            });
            if let Some(ref transient) = data.transient {
                if let Some(ref display_id) = transient.display_id {
                    output["transient"] = json!({ "display_id": display_id });
                }
            }
            Some(output)
        }
        JupyterMessageContent::ExecuteResult(result) => Some(json!({
            "output_type": "execute_result",
            "data": result.data,
            "metadata": result.metadata,
            "execution_count": result.execution_count.0,
        })),
        JupyterMessageContent::ErrorOutput(error) => Some(json!({
            "output_type": "error",
            "ename": error.ename,
            "evalue": error.evalue,
            "traceback": error.traceback,
        })),
        _ => None,
    }
}

/// Standalone self-test: launch a kernel, run one cell, and log the IOPub
/// outputs + lifecycle. Proves the kernel-drive layer without the cloud.
pub async fn self_test(python: &str, venv: Option<&str>, source: &str) -> Result<()> {
    let mut kernel = Kernel::launch(python, venv).await?;
    kernel
        .wait_until_ready(std::time::Duration::from_secs(30))
        .await?;

    let execution_id = Uuid::new_v4().to_string();
    info!("executing: {source:?} (execution_id={execution_id})");
    kernel.execute(&execution_id, None, source).await?;

    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(30);
    loop {
        let msg = match tokio::time::timeout_at(deadline, kernel.iopub.read()).await {
            Ok(Ok(m)) => m,
            Ok(Err(e)) => {
                warn!("iopub read error: {e}");
                break;
            }
            Err(_) => {
                warn!("timed out waiting for execution to finish");
                break;
            }
        };
        let parent = msg
            .parent_header
            .as_ref()
            .map(|h| h.msg_id.as_str())
            .unwrap_or("");
        if parent != execution_id {
            continue;
        }
        match &msg.content {
            JupyterMessageContent::ExecuteInput(input) => {
                info!("execute_input: execution_count={}", input.execution_count.0);
            }
            JupyterMessageContent::Status(status) => {
                info!("status: {:?}", status.execution_state);
                if matches!(
                    status.execution_state,
                    jupyter_protocol::ExecutionState::Idle
                ) {
                    info!("execution complete");
                    break;
                }
            }
            other => {
                if let Some(nb) = content_to_nbformat(other) {
                    info!("output: {nb}");
                }
            }
        }
    }

    let _ = kernel.child.start_kill();
    Ok(())
}
