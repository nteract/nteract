use tokio::sync::oneshot;

use crate::error::SyncError;

pub(crate) async fn recv<T>(rx: oneshot::Receiver<Result<T, SyncError>>) -> Result<T, SyncError> {
    rx.await.map_err(|_| SyncError::Disconnected)?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn returns_success_value() {
        let (tx, rx) = oneshot::channel();
        tx.send(Ok(42)).expect("receiver should be live");

        assert_eq!(recv(rx).await.expect("reply should succeed"), 42);
    }

    #[tokio::test]
    async fn returns_operation_error() {
        let (tx, rx) = oneshot::channel::<Result<(), SyncError>>();
        tx.send(Err(SyncError::Timeout))
            .expect("receiver should be live");

        assert!(matches!(recv(rx).await, Err(SyncError::Timeout)));
    }

    #[tokio::test]
    async fn dropped_sender_is_disconnected() {
        let (tx, rx) = oneshot::channel::<Result<(), SyncError>>();
        drop(tx);

        assert!(matches!(recv(rx).await, Err(SyncError::Disconnected)));
    }
}
