use std::time::Duration;

use tokio::{sync::oneshot, task::JoinError};

/// Outcome of waiting for a one-shot reply with a timeout.
///
/// This flattens `timeout(duration, rx).await` from
/// `Result<Result<T, oneshot::error::RecvError>, Elapsed>` into the three
/// states callers actually care about.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum TimedOneShot<T> {
    Received(T),
    SenderDropped,
    TimedOut,
}

pub(crate) async fn recv_oneshot_with_timeout<T>(
    rx: oneshot::Receiver<T>,
    timeout: Duration,
) -> TimedOneShot<T> {
    match tokio::time::timeout(timeout, rx).await {
        Ok(Ok(value)) => TimedOneShot::Received(value),
        Ok(Err(_)) => TimedOneShot::SenderDropped,
        Err(_) => TimedOneShot::TimedOut,
    }
}

/// Outcome of a task whose `JoinHandle` itself returns `Result<T, E>`.
#[derive(Debug)]
pub(crate) enum JoinedResult<T, E> {
    Completed(T),
    Failed(E),
    JoinFailed(JoinError),
}

pub(crate) fn flatten_joined_result<T, E>(
    result: Result<Result<T, E>, JoinError>,
) -> JoinedResult<T, E> {
    match result {
        Ok(Ok(value)) => JoinedResult::Completed(value),
        Ok(Err(error)) => JoinedResult::Failed(error),
        Err(error) => JoinedResult::JoinFailed(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn receives_value_before_timeout() {
        let (tx, rx) = oneshot::channel();
        tx.send(7).expect("send value");

        let outcome = recv_oneshot_with_timeout(rx, Duration::from_secs(1)).await;

        assert_eq!(outcome, TimedOneShot::Received(7));
    }

    #[tokio::test]
    async fn reports_dropped_sender() {
        let (tx, rx) = oneshot::channel::<()>();
        drop(tx);

        let outcome = recv_oneshot_with_timeout(rx, Duration::from_secs(1)).await;

        assert_eq!(outcome, TimedOneShot::SenderDropped);
    }

    #[tokio::test(start_paused = true)]
    async fn reports_timeout() {
        let (_tx, rx) = oneshot::channel::<()>();

        let outcome = recv_oneshot_with_timeout(rx, Duration::from_secs(5)).await;

        assert_eq!(outcome, TimedOneShot::TimedOut);
    }

    #[test]
    fn flattens_joined_success() {
        let result = Ok::<_, JoinError>(Ok::<_, &'static str>(7));

        match flatten_joined_result(result) {
            JoinedResult::Completed(value) => assert_eq!(value, 7),
            other => panic!("expected completed, got {other:?}"),
        }
    }

    #[test]
    fn flattens_joined_task_error() {
        let result = Ok::<_, JoinError>(Err::<(), _>("task error"));

        match flatten_joined_result(result) {
            JoinedResult::Failed(error) => assert_eq!(error, "task error"),
            other => panic!("expected failed, got {other:?}"),
        }
    }
}
