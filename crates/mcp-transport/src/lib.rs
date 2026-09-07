//! Connection lifetime for stdio MCP request handlers.
//!
//! rmcp drains in-flight handlers on EOF without cancelling their request tokens.
//! Attach a separate connection token before dispatch so observation can end
//! immediately, while daemon-owned execution continues independently.

use rmcp::model::{GetExtensions, JsonRpcMessage};
use rmcp::service::{RequestContext, RoleServer, RxJsonRpcMessage, TxJsonRpcMessage};
use rmcp::transport::{IntoTransport, Transport};
use std::future::Future;
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
struct ConnectionClosed(CancellationToken);

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
