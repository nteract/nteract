//! Read-only selection of the local runtime used by canonical notebook clients.
//! Starting it is deferred until an explicit local connect/create operation.

use std::path::PathBuf;

use runt_workspace::BuildChannel;
use runtimed_client::startup::{probe_local_runtime, RuntimeLaunch};

#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct LocalRuntimeOptions {
    pub enabled: bool,
    pub explicit_channel: bool,
}

pub(crate) struct LocalRuntimeSelection {
    pub endpoint: PathBuf,
    pub launch: Option<RuntimeLaunch>,
}

pub(crate) async fn select(
    options: LocalRuntimeOptions,
    explicit_socket: Option<PathBuf>,
) -> LocalRuntimeSelection {
    let custom_socket = explicit_socket.is_some()
        || std::env::var_os("RUNTIMED_SOCKET_PATH").is_some_and(|value| !value.is_empty());
    let endpoint = explicit_socket.unwrap_or_else(runtimed_client::daemon_paths::get_socket_path);
    if !options.enabled || custom_socket {
        return LocalRuntimeSelection {
            endpoint,
            launch: None,
        };
    }
    let channel = runt_workspace::build_channel();
    let dev = runt_workspace::is_dev_mode();
    if !options.explicit_channel && !dev {
        let alternate_channel = match channel {
            BuildChannel::Stable => BuildChannel::Nightly,
            BuildChannel::Nightly => BuildChannel::Stable,
        };
        let alternate = runt_workspace::socket_path_for_context(alternate_channel, None);
        let selected = select_shared_endpoint(endpoint.clone(), alternate, |endpoint| async move {
            matches!(probe_local_runtime(&endpoint).await, Ok(None))
        })
        .await;
        if selected != endpoint {
            return LocalRuntimeSelection {
                endpoint: selected,
                launch: None,
            };
        }
    }
    // Only the daemon shipped next to this exact CLI can be a lazy starter.
    // RuntimeLaunch verifies compiled identity and complete namespace before
    // spawning; never use PATH or cross-channel app fallback for this binary.
    let binary = sibling_runtime_binary();
    let worktree = dev.then(runt_workspace::get_workspace_path).flatten();
    let launch = if dev && worktree.is_none() {
        None
    } else {
        binary.map(|binary| RuntimeLaunch {
            binary,
            channel,
            worktree,
        })
    };
    LocalRuntimeSelection { endpoint, launch }
}

pub(crate) fn sibling_runtime_binary() -> Option<PathBuf> {
    std::env::current_exe().ok().and_then(|exe| {
        exe.parent().map(|dir| {
            let names = [runt_workspace::daemon_binary_basename(), "runtimed"];
            let candidates =
                names.map(|name| dir.join(format!("{name}{}", std::env::consts::EXE_SUFFIX)));
            candidates
                .iter()
                .find(|path| path.is_file())
                .cloned()
                .unwrap_or_else(|| candidates[0].clone())
        })
    })
}

async fn select_shared_endpoint<P, F>(
    preferred: PathBuf,
    alternate: PathBuf,
    mut absent: P,
) -> PathBuf
where
    P: FnMut(PathBuf) -> F,
    F: std::future::Future<Output = bool>,
{
    // "Not absent" includes incompatible and uninspectable endpoints. Local
    // admission will explain those errors rather than isolating around them.
    if absent(preferred.clone()).await && !absent(alternate.clone()).await {
        alternate
    } else {
        preferred
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::VecDeque;

    #[tokio::test]
    async fn shared_selection_reuses_present_endpoints_and_only_launches_when_both_absent() {
        for (answers, expected, expected_queries) in [
            (vec![false], "preferred", vec!["preferred"]),
            (
                vec![true, false],
                "alternate",
                vec!["preferred", "alternate"],
            ),
            (
                vec![true, true],
                "preferred",
                vec!["preferred", "alternate"],
            ),
        ] {
            let answers = RefCell::new(VecDeque::from(answers));
            let queries = RefCell::new(Vec::new());
            let selected =
                select_shared_endpoint("preferred".into(), "alternate".into(), |endpoint| {
                    queries.borrow_mut().push(endpoint);
                    std::future::ready(answers.borrow_mut().pop_front().unwrap())
                })
                .await;
            assert_eq!(selected, PathBuf::from(expected));
            assert_eq!(
                *queries.borrow(),
                expected_queries
                    .into_iter()
                    .map(PathBuf::from)
                    .collect::<Vec<_>>()
            );
        }
    }

    #[tokio::test]
    async fn explicit_socket_is_never_replaced_or_given_a_launcher() {
        let selected = select(
            LocalRuntimeOptions {
                enabled: true,
                explicit_channel: false,
            },
            Some("explicit-test.sock".into()),
        )
        .await;
        assert_eq!(selected.endpoint, PathBuf::from("explicit-test.sock"));
        assert!(selected.launch.is_none());
    }
}
