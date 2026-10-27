//! Registration site for output-type extensions. Generic daemon and runtime
//! agent code reaches extension behaviour only through what is listed here.

use std::sync::{Arc, OnceLock};

use runtime_doc::RuntimeStateHandle;
use runtimed_client::output_equivalence::ReplayFieldPolicy;

use crate::blob_store::BlobStore;
use crate::bokeh_session::agent::BokehAgentExtension;
use crate::bokeh_session::hub::BokehRoomKind;
use crate::bokeh_session::output_hook::{
    BokehAgentOutputHook, BokehRoomOutputHook, BokehRoomOutputs,
};
use crate::bokeh_session::store::BokehSessionStore;
use crate::keyed_doc::KeyedDocHub;
use crate::output_hooks::{OutputHook, OutputHookRegistry};
use crate::runtime_agent_extension::{AgentExtensionInit, AgentExtensions, RuntimeAgentExtension};

/// Hooks for one runtime agent's output committers. Without a Bokeh store,
/// Bokeh outputs are stored as static renders.
pub(crate) fn agent_output_hooks(bokeh: Option<BokehSessionStore>) -> OutputHookRegistry {
    OutputHookRegistry::new(vec![Arc::new(BokehAgentOutputHook::new(bokeh))])
}

/// Every extension of one runtime agent. `init.availability` tells
/// extensions which keyed document kinds the coordinator routes.
pub(crate) fn agent_extensions(init: &AgentExtensionInit) -> AgentExtensions {
    let exts: Vec<Arc<dyn RuntimeAgentExtension>> = vec![Arc::new(BokehAgentExtension::new(init))];
    AgentExtensions::new(exts).with_keyed_docs(crate::keyed_doc::agent_kinds())
}

/// What a new notebook room routes and hooks.
pub(crate) struct RoomExtensions {
    pub(crate) keyed_docs: Arc<KeyedDocHub>,
    pub(crate) output_hooks: OutputHookRegistry,
}

pub(crate) fn room_extensions(
    blob_store: &Arc<BlobStore>,
    state: &RuntimeStateHandle,
) -> RoomExtensions {
    let bokeh = Arc::new(BokehRoomKind::default());
    let mut kinds = crate::keyed_doc::room_kinds();
    kinds.push(bokeh.clone());
    let keyed_docs = Arc::new(KeyedDocHub::new(kinds));
    let output_hooks = room_output_hooks(Some(BokehRoomOutputs {
        kind: bokeh,
        hub: keyed_docs.clone(),
        state: state.clone(),
        blob_store: blob_store.clone(),
    }));
    RoomExtensions {
        keyed_docs,
        output_hooks,
    }
}

/// Hooks for one notebook room's save and retirement paths; without room
/// state they still declare their replay fields.
fn room_output_hooks(bokeh: Option<BokehRoomOutputs>) -> OutputHookRegistry {
    let hooks: Vec<Arc<dyn OutputHook>> = vec![Arc::new(BokehRoomOutputHook::new(bokeh))];
    // Lets save/load tests exercise declared replay fields on a MIME with no
    // other behaviour.
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
    POLICY.get_or_init(|| room_output_hooks(None))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::output_hooks::test_hooks::MUTABLE_REPLAY_TEST_MIME;

    #[test]
    fn replay_field_policy_agrees_with_room_hooks() {
        let tmp = tempfile::TempDir::new().unwrap();
        let blob_store = Arc::new(BlobStore::new(tmp.path().to_path_buf()));
        let state = RuntimeStateHandle::new(
            runtime_doc::RuntimeStateDoc::new(),
            tokio::sync::broadcast::channel(1).0,
        );
        let room = room_extensions(&blob_store, &state);
        let policy = replay_field_policy();
        for mime in [
            runtime_doc::BOKEH_SESSION_MIME,
            MUTABLE_REPLAY_TEST_MIME,
            "application/json",
            "text/plain",
        ] {
            assert_eq!(
                policy.mutable_fields(mime),
                room.output_hooks.mutable_fields(mime),
                "{mime}"
            );
        }
        assert_eq!(
            policy.mutable_fields(runtime_doc::BOKEH_SESSION_MIME),
            ["snapshot"]
        );
        assert!(policy.mutable_fields("application/json").is_empty());
    }

    #[test]
    fn rooms_route_bokeh_session_documents() {
        let tmp = tempfile::TempDir::new().unwrap();
        let blob_store = Arc::new(BlobStore::new(tmp.path().to_path_buf()));
        let state = RuntimeStateHandle::new(
            runtime_doc::RuntimeStateDoc::new(),
            tokio::sync::broadcast::channel(1).0,
        );
        let room = room_extensions(&blob_store, &state);
        assert_eq!(room.keyed_docs.advertised_kinds(), ["bokeh_session"]);
    }
}
