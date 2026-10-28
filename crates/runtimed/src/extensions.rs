//! Registration site for output-type extensions. Generic daemon and runtime
//! agent code reaches extension behaviour only through what is listed here.

use std::sync::{Arc, OnceLock};

use runtimed_client::output_equivalence::ReplayFieldPolicy;

use crate::bokeh_session::output_hook::BokehOutputHook;
use crate::output_hooks::{OutputHook, OutputHookRegistry};

/// Hooks for one runtime agent's output committers.
pub(crate) fn agent_output_hooks() -> OutputHookRegistry {
    OutputHookRegistry::new(vec![Arc::new(BokehOutputHook)])
}

/// Hooks for one notebook room's save and retirement paths.
pub(crate) fn room_output_hooks() -> OutputHookRegistry {
    let hooks: Vec<Arc<dyn OutputHook>> = vec![Arc::new(BokehOutputHook)];
    // Lets save/load tests exercise declared replay fields end to end before a
    // production hook declares any.
    #[cfg(test)]
    let hooks = {
        let mut hooks = hooks;
        hooks.push(Arc::new(
            crate::output_hooks::test_hooks::MutableReplayTestHook,
        ));
        hooks
    };
    OutputHookRegistry::new(hooks)
}

/// Mutable replay fields of the room hooks, for comparing durable execution
/// records with loaded notebook outputs. Fields are MIME-static, so one
/// process-wide policy serves every room.
pub(crate) fn replay_field_policy() -> &'static dyn ReplayFieldPolicy {
    static POLICY: OnceLock<OutputHookRegistry> = OnceLock::new();
    POLICY.get_or_init(room_output_hooks)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::output_hooks::test_hooks::MUTABLE_REPLAY_TEST_MIME;

    #[test]
    fn only_the_test_hook_declares_replay_fields() {
        let policy = replay_field_policy();
        assert_eq!(
            policy.mutable_fields(MUTABLE_REPLAY_TEST_MIME),
            ["snapshot"]
        );
        assert!(policy
            .mutable_fields(runtime_doc::BOKEH_SESSION_MIME)
            .is_empty());
        assert!(policy.mutable_fields("application/json").is_empty());
    }
}
