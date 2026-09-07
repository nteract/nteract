//! Connection lifetime for stdio MCP request handlers.
//!
//! rmcp drains in-flight handlers on EOF without cancelling their request tokens.
//! Attach a separate connection token before dispatch so observation can end
//! immediately, while daemon-owned execution continues independently.

use rmcp::model::{GetExtensions, GetMeta, JsonRpcMessage};
use rmcp::service::{RequestContext, RoleServer, RxJsonRpcMessage, TxJsonRpcMessage};
use rmcp::transport::{IntoTransport, Transport};
use std::future::Future;
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
struct ConnectionClosed(CancellationToken);

pub fn cancellation_error() -> rmcp::ErrorData {
    rmcp::ErrorData::new(
        rmcp::model::ErrorCode(-32800),
        "Request observation cancelled; daemon execution may continue",
        None,
    )
}

/// Wait for either explicit request cancellation or transport teardown.
pub async fn cancelled(context: &RequestContext<RoleServer>) {
    let connection = context.extensions.get::<ConnectionClosed>();
    match connection {
        Some(connection) => {
            tokio::select! {
                _ = context.ct.cancelled() => {},
                _ = connection.0.cancelled() => {},
            }
        }
        None => context.ct.cancelled().await,
    }
}

/// Apply once at each server entry point, including in-memory wire tests.
pub fn server<T, E, A>(transport: T) -> impl Transport<RoleServer, Error = E>
where
    T: IntoTransport<RoleServer, E, A>,
    E: std::error::Error + Send + Sync + 'static,
{
    ServerTransport {
        inner: transport.into_transport(),
        closed: CancellationToken::new(),
    }
}

struct ServerTransport<T> {
    inner: T,
    closed: CancellationToken,
}
impl<T> Drop for ServerTransport<T> {
    fn drop(&mut self) {
        self.closed.cancel();
    }
}
impl<T: Transport<RoleServer>> Transport<RoleServer> for ServerTransport<T> {
    type Error = T::Error;
    fn send(
        &mut self,
        item: TxJsonRpcMessage<RoleServer>,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send + 'static {
        let sent = self.inner.send(item);
        let closed = self.closed.clone();
        async move {
            let result = sent.await;
            if result.is_err() {
                closed.cancel();
            }
            result
        }
    }
    async fn receive(&mut self) -> Option<RxJsonRpcMessage<RoleServer>> {
        let mut message = self.inner.receive().await;
        match &mut message {
            Some(JsonRpcMessage::Request(request)) => {
                request
                    .request
                    .extensions_mut()
                    .insert(ConnectionClosed(self.closed.clone()));
            }
            None => self.closed.cancel(),
            _ => {}
        }
        message
    }
    async fn close(&mut self) -> Result<(), Self::Error> {
        self.closed.cancel();
        self.inner.close().await
    }
}

#[derive(Clone, Default)]
pub struct ConnectionLifetime(CancellationToken);
#[derive(Clone)]
struct SuppressProgress;
/// Override the SDK's automatic private token when the upstream did not opt in.
pub fn suppress_progress(request: &mut rmcp::model::ClientRequest) {
    request.extensions_mut().insert(SuppressProgress);
}
impl ConnectionLifetime {
    pub async fn closed(&self) {
        self.0.cancelled().await;
    }
}

/// Expose private-child EOF without relying on the SDK's later response drain.
pub fn client<T, E, A>(
    transport: T,
) -> (
    impl Transport<rmcp::service::RoleClient, Error = E>,
    ConnectionLifetime,
)
where
    T: IntoTransport<rmcp::service::RoleClient, E, A>,
    E: std::error::Error + Send + Sync + 'static,
{
    let lifetime = ConnectionLifetime::default();
    (
        ClientTransport {
            inner: transport.into_transport(),
            lifetime: lifetime.clone(),
        },
        lifetime,
    )
}
struct ClientTransport<T> {
    inner: T,
    lifetime: ConnectionLifetime,
}
impl<T> Drop for ClientTransport<T> {
    fn drop(&mut self) {
        self.lifetime.0.cancel();
    }
}
impl<T: Transport<rmcp::service::RoleClient>> Transport<rmcp::service::RoleClient>
    for ClientTransport<T>
{
    type Error = T::Error;
    fn send(
        &mut self,
        mut message: TxJsonRpcMessage<rmcp::service::RoleClient>,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send + 'static {
        if let JsonRpcMessage::Request(request) = &mut message {
            if request
                .request
                .extensions()
                .get::<SuppressProgress>()
                .is_some()
            {
                request.request.get_meta_mut().remove("progressToken");
            }
        }
        let send = self.inner.send(message);
        let lifetime = self.lifetime.clone();
        async move {
            let result = send.await;
            if result.is_err() {
                lifetime.0.cancel();
            }
            result
        }
    }
    async fn receive(&mut self) -> Option<RxJsonRpcMessage<rmcp::service::RoleClient>> {
        let result = self.inner.receive().await;
        if result.is_none() {
            self.lifetime.0.cancel();
        }
        result
    }
    async fn close(&mut self) -> Result<(), Self::Error> {
        self.lifetime.0.cancel();
        self.inner.close().await
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use rmcp::model::*;
    struct Mock {
        next: Option<RxJsonRpcMessage<RoleServer>>,
        fail_write: bool,
    }
    impl Transport<RoleServer> for Mock {
        type Error = std::io::Error;
        fn send(
            &mut self,
            _: TxJsonRpcMessage<RoleServer>,
        ) -> impl Future<Output = Result<(), Self::Error>> + Send + 'static {
            let fail = self.fail_write;
            async move {
                if fail {
                    Err(std::io::Error::other("fixture write failure"))
                } else {
                    Ok(())
                }
            }
        }
        async fn receive(&mut self) -> Option<RxJsonRpcMessage<RoleServer>> {
            self.next.take()
        }
        async fn close(&mut self) -> Result<(), Self::Error> {
            Ok(())
        }
    }
    #[tokio::test]
    async fn request_lifetime_ends_on_failed_write_close_drop_and_eof() {
        for ending in ["write", "close", "drop", "eof"] {
            let mut transport = server(Mock {
                next: Some(JsonRpcMessage::request(
                    ClientRequest::PingRequest(PingRequest::default()),
                    RequestId::Number(1),
                )),
                fail_write: ending == "write",
            });
            let Some(JsonRpcMessage::Request(request)) = transport.receive().await else {
                panic!("expected request")
            };
            let closed = request
                .request
                .extensions()
                .get::<ConnectionClosed>()
                .unwrap()
                .clone();
            assert!(!closed.0.is_cancelled());
            match ending {
                "write" => assert!(transport
                    .send(JsonRpcMessage::response(
                        ServerResult::empty(()),
                        RequestId::Number(1)
                    ))
                    .await
                    .is_err()),
                "close" => transport.close().await.unwrap(),
                "eof" => assert!(transport.receive().await.is_none()),
                _ => drop(transport),
            }
            assert!(closed.0.is_cancelled(), "{ending}");
        }
    }
}
