//! Serial shell RPC for kernel extensions.
//!
//! Extension requests (custom `*_request` shell messages) run on their own
//! shell connection so a long kernel callback never holds the primary shell,
//! where execute, completion and history replies are read.

use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use jupyter_protocol::{ConnectionInfo, JupyterMessage, JupyterMessageContent, UnknownMessage};
use serde_json::Value;
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;

use crate::task_supervisor::spawn_best_effort;

/// A kernel's reply to an extension shell request.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ShellReply {
    pub(crate) msg_type: String,
    pub(crate) content: Value,
    pub(crate) buffers: Vec<Vec<u8>>,
}

/// One queued request. Public to the crate so tests can answer requests
/// from [`KernelShellRequester::for_test`] without a kernel.
#[derive(Debug)]
pub(crate) struct ShellCommand {
    pub(crate) msg_type: String,
    pub(crate) content: Value,
    pub(crate) buffers: Vec<Bytes>,
    pub(crate) timeout: Duration,
    /// Sent on a fresh connection instead of the serial queue.
    pub(crate) isolated: bool,
    pub(crate) reply: oneshot::Sender<anyhow::Result<ShellReply>>,
}

#[derive(Clone)]
pub(crate) struct KernelShellRequester {
    tx: mpsc::UnboundedSender<ShellCommand>,
    /// `None` for test requesters: isolated requests then share the queue.
    connection_info: Option<Arc<ConnectionInfo>>,
    kernel_session_id: Arc<str>,
}

impl KernelShellRequester {
    /// Enqueued when called, sent in call order on one dedicated shell. The
    /// future only waits for the reply, so callers keep ordering without
    /// awaiting the kernel.
    pub(crate) fn request(
        &self,
        msg_type: impl Into<String>,
        content: Value,
        buffers: Vec<Bytes>,
        timeout: Duration,
    ) -> impl Future<Output = anyhow::Result<ShellReply>> + Send + 'static {
        let (reply, response) = oneshot::channel();
        let command = ShellCommand {
            msg_type: msg_type.into(),
            content,
            buffers,
            timeout,
            isolated: false,
            reply,
        };
        if let Err(error) = self.tx.send(command) {
            let _ = error
                .0
                .reply
                .send(Err(anyhow::anyhow!("kernel shell requester stopped")));
        }
        async move {
            response
                .await
                .map_err(|_| anyhow::anyhow!("kernel shell requester dropped its reply"))?
        }
    }

    /// One request on a fresh shell connection, independent of the serial
    /// queue, for idempotent requests that must not wait behind it.
    pub(crate) fn request_isolated(
        &self,
        msg_type: impl Into<String>,
        content: Value,
        timeout: Duration,
    ) -> impl Future<Output = anyhow::Result<ShellReply>> + Send + 'static {
        let msg_type = msg_type.into();
        let connection_info = self.connection_info.clone();
        let tx = self.tx.clone();
        let client_session_id = format!(
            "{}-ext-isolated-{}",
            self.kernel_session_id,
            uuid::Uuid::new_v4()
        );
        async move {
            let Some(connection_info) = connection_info else {
                let (reply, response) = oneshot::channel();
                tx.send(ShellCommand {
                    msg_type,
                    content,
                    buffers: Vec::new(),
                    timeout,
                    isolated: true,
                    reply,
                })
                .map_err(|_| anyhow::anyhow!("kernel shell requester stopped"))?;
                return response
                    .await
                    .map_err(|_| anyhow::anyhow!("kernel shell requester dropped its reply"))?;
            };
            tokio::time::timeout(timeout, async {
                let mut shell = connect(&connection_info, &client_session_id).await?;
                send_and_read(&mut shell, &msg_type, content, Vec::new()).await
            })
            .await
            .map_err(|_| anyhow::anyhow!("{msg_type} timed out"))?
        }
    }

    /// A requester whose commands arrive on the returned receiver.
    #[cfg(test)]
    pub(crate) fn for_test() -> (Self, mpsc::UnboundedReceiver<ShellCommand>) {
        let (tx, rx) = mpsc::unbounded_channel();
        (
            Self {
                tx,
                connection_info: None,
                kernel_session_id: Arc::from("test-kernel-session"),
            },
            rx,
        )
    }
}

/// Start the serial requester task for a launched kernel.
pub(crate) fn spawn_shell_requester(
    connection_info: ConnectionInfo,
    kernel_session_id: &str,
) -> (KernelShellRequester, JoinHandle<()>) {
    let (tx, rx) = mpsc::unbounded_channel();
    let connection_info = Arc::new(connection_info);
    let task = spawn_best_effort(
        "kernel-extension-shell",
        run_shell_requester(
            connection_info.clone(),
            format!("{kernel_session_id}-ext-shell"),
            rx,
        ),
    );
    (
        KernelShellRequester {
            tx,
            connection_info: Some(connection_info),
            kernel_session_id: Arc::from(kernel_session_id),
        },
        task,
    )
}

async fn run_shell_requester(
    connection_info: Arc<ConnectionInfo>,
    client_session_id: String,
    mut requests: mpsc::UnboundedReceiver<ShellCommand>,
) {
    let mut shell: Option<jupyter_zmq_client::ClientShellConnection> = None;
    while let Some(command) = requests.recv().await {
        if shell.is_none() {
            match connect(&connection_info, &client_session_id).await {
                Ok(connection) => shell = Some(connection),
                Err(error) => {
                    let _ = command.reply.send(Err(error));
                    continue;
                }
            }
        }
        let Some(connection) = shell.as_mut() else {
            continue;
        };
        let ShellCommand {
            msg_type,
            content,
            buffers,
            timeout,
            isolated,
            reply,
        } = command;
        debug_assert!(!isolated, "isolated requests open their own connection");
        let result = tokio::time::timeout(
            timeout,
            send_and_read(connection, &msg_type, content, buffers),
        )
        .await
        .unwrap_or_else(|_| Err(anyhow::anyhow!("{msg_type} timed out")));
        if result.is_err() {
            // A late reply would otherwise answer the next request.
            shell = None;
        }
        let _ = reply.send(result);
    }
}

async fn connect(
    connection_info: &ConnectionInfo,
    client_session_id: &str,
) -> anyhow::Result<jupyter_zmq_client::ClientShellConnection> {
    let identity = jupyter_zmq_client::peer_identity_for_session(client_session_id)?;
    Ok(
        jupyter_zmq_client::create_client_shell_connection_with_identity(
            connection_info,
            client_session_id,
            identity,
        )
        .await?,
    )
}

async fn send_and_read(
    shell: &mut jupyter_zmq_client::ClientShellConnection,
    msg_type: &str,
    content: Value,
    buffers: Vec<Bytes>,
) -> anyhow::Result<ShellReply> {
    let mut request: JupyterMessage = UnknownMessage {
        msg_type: msg_type.to_string(),
        content,
    }
    .into();
    request.buffers = buffers;
    let request_id = request.header.msg_id.clone();
    shell.send(request).await?;
    let message = shell.read().await?;
    anyhow::ensure!(
        message
            .parent_header
            .as_ref()
            .is_some_and(|parent| parent.msg_id == request_id),
        "{msg_type} reply had an unexpected parent"
    );
    let buffers = message
        .buffers
        .iter()
        .map(|buffer| buffer.to_vec())
        .collect();
    let JupyterMessageContent::UnknownMessage(unknown) = message.content else {
        anyhow::bail!("{msg_type} received an unexpected reply type");
    };
    Ok(ShellReply {
        msg_type: unknown.msg_type,
        content: unknown.content,
        buffers,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn requests_are_queued_in_call_order_before_any_reply_is_awaited() {
        let (requester, mut rx) = KernelShellRequester::for_test();
        let first = requester.request(
            "a_request",
            serde_json::json!({"n": 1}),
            vec![Bytes::from_static(b"x")],
            Duration::from_secs(1),
        );
        let second = requester.request(
            "b_request",
            serde_json::json!({"n": 2}),
            Vec::new(),
            Duration::from_secs(1),
        );
        let a = rx.try_recv().expect("queued without polling");
        let b = rx.try_recv().expect("queued without polling");
        assert_eq!(
            (a.msg_type.as_str(), b.msg_type.as_str()),
            ("a_request", "b_request")
        );
        assert_eq!(a.buffers, vec![Bytes::from_static(b"x")]);
        assert!(!a.isolated);
        let reply = |msg_type: &str| ShellReply {
            msg_type: msg_type.to_string(),
            content: serde_json::json!({"status": "ok"}),
            buffers: Vec::new(),
        };
        b.reply.send(Ok(reply("b_reply"))).unwrap();
        a.reply.send(Ok(reply("a_reply"))).unwrap();
        assert_eq!(first.await.unwrap().msg_type, "a_reply");
        assert_eq!(second.await.unwrap().msg_type, "b_reply");
    }

    #[tokio::test]
    async fn a_stopped_requester_fails_requests_instead_of_hanging() {
        let (requester, rx) = KernelShellRequester::for_test();
        drop(rx);
        let error = requester
            .request("a_request", Value::Null, Vec::new(), Duration::from_secs(1))
            .await
            .unwrap_err();
        assert!(error.to_string().contains("stopped"), "{error}");
        assert!(requester
            .request_isolated("a_request", Value::Null, Duration::from_secs(1))
            .await
            .is_err());
    }
}
