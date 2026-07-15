//! Notebook session state management.

use std::sync::Arc;

use notebook_sync::handle::DocHandle;
use notebook_sync::status::{
    ConnectionState, InitialLoadPhase, NotebookDocPhase, RuntimeStatePhase,
};
use runtimed_client::protocol::{
    NotebookAvailabilityPhase, NotebookProjection, NotebookSourcePhase,
};
use serde::Serialize;

use crate::session_activation::CanonicalNotebookTarget;

/// Where the active notebook document is hosted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NotebookSessionSource {
    /// Local daemon room, optionally backed by a file path.
    Local,
    /// Hosted notebook-cloud room at a configured domain.
    Hosted { domain: String },
}

/// Evidence backing the capabilities exposed by an MCP notebook session.
#[derive(Debug)]
enum SessionReadinessEvidence {
    /// A local daemon projection whose heads were found in the local replica.
    RetainedProjection {
        evidence: Arc<RetainedProjectionEvidence>,
    },
    /// Legacy local flow that waited for the full session-ready status.
    AwaitedSessionReady,
    /// Hosted rooms do not yet emit the local daemon's status control frame.
    HostedLegacy,
}

#[derive(Debug)]
struct RetainedProjectionEvidence {
    projection: Arc<NotebookProjection>,
}

impl RetainedProjectionEvidence {
    fn new(projection: NotebookProjection) -> Self {
        Self {
            projection: Arc::new(projection),
        }
    }

    fn refresh_head_proof(&self, handle: &DocHandle) -> (bool, bool) {
        // Do not cache positive containment across calls: daemon reconnect can
        // replace a DocHandle's local replica. These narrow graph queries avoid
        // serializing complete notebook/runtime documents on every MCP tool.
        let notebook_ready = handle
            .contains_notebook_heads(&self.projection.notebook_heads)
            .unwrap_or(false);
        let runtime_ready = handle
            .contains_runtime_state_heads(&self.projection.runtime_state_heads)
            .unwrap_or(false);
        (notebook_ready, runtime_ready)
    }

    fn projection(&self) -> Arc<NotebookProjection> {
        Arc::clone(&self.projection)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionRequirement {
    /// A bounded, room-owned projection is sufficient. Callers must use the
    /// projection carried by [`SessionAccess`] until `document_ready` is true.
    ProjectionRead,
    DocumentRead,
    DocumentMutation,
    RuntimeRead,
    Execute,
}

#[derive(Debug, Clone, Serialize)]
pub struct SessionCapabilities {
    pub read: bool,
    pub mutate: bool,
    pub execute: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct SessionReadiness {
    pub session_generation: u64,
    pub target: String,
    pub source_state: serde_json::Value,
    pub projection_ready: bool,
    pub document_ready: bool,
    pub runtime_ready: bool,
    pub interactive: bool,
    pub projection_heads: Vec<String>,
    pub runtime_state_heads: Vec<String>,
    pub projection_completeness: Option<String>,
    pub capabilities: SessionCapabilities,
}

#[derive(Debug, Clone)]
pub struct SessionAccess {
    pub handle: DocHandle,
    pub notebook_id: String,
    pub notebook_path: Option<String>,
    pub projection: Option<Arc<NotebookProjection>>,
    pub readiness: SessionReadiness,
}

#[derive(Debug, Clone)]
pub struct SessionAccessError {
    pub code: &'static str,
    pub message: String,
    pub readiness: Box<SessionReadiness>,
}

/// An active notebook session connected via the daemon.
pub struct NotebookSession {
    /// The Automerge document handle for this notebook.
    pub handle: DocHandle,
    /// The notebook ID (always a UUID).
    pub notebook_id: String,
    /// The file path for file-backed notebooks (opened via `open_notebook`).
    /// `None` for ephemeral notebooks created via `create_notebook`.
    pub notebook_path: Option<String>,
    /// Session source. Hosted sessions do not depend on the local daemon.
    pub source: NotebookSessionSource,
    /// Monotonic MCP activation generation. Daemon rejoin/create legacy paths
    /// use generation zero until they are replaced by an explicit activation.
    pub activation_generation: u64,
    /// Canonical target that owns this activation generation.
    pub activation_target: String,
    readiness_evidence: SessionReadinessEvidence,
}

impl NotebookSession {
    pub fn local(handle: DocHandle, notebook_id: String, notebook_path: Option<String>) -> Self {
        let activation_target = format!("local:id:{notebook_id}");
        Self {
            handle,
            notebook_id,
            notebook_path,
            source: NotebookSessionSource::Local,
            activation_generation: 0,
            activation_target,
            readiness_evidence: SessionReadinessEvidence::AwaitedSessionReady,
        }
    }

    pub fn local_with_projection(
        handle: DocHandle,
        notebook_id: String,
        notebook_path: Option<String>,
        activation_generation: u64,
        activation_target: CanonicalNotebookTarget,
        projection: NotebookProjection,
    ) -> Self {
        Self {
            handle,
            notebook_id,
            notebook_path,
            source: NotebookSessionSource::Local,
            activation_generation,
            activation_target: activation_target.as_str().to_string(),
            readiness_evidence: SessionReadinessEvidence::RetainedProjection {
                evidence: Arc::new(RetainedProjectionEvidence::new(projection)),
            },
        }
    }

    pub fn hosted(handle: DocHandle, notebook_id: String, domain: String) -> Self {
        let activation_target = crate::cloud::hosted_notebook_url(&domain, &notebook_id);
        Self {
            handle,
            notebook_id,
            notebook_path: None,
            source: NotebookSessionSource::Hosted { domain },
            activation_generation: 0,
            activation_target,
            readiness_evidence: SessionReadinessEvidence::HostedLegacy,
        }
    }

    pub fn hosted_activated(
        handle: DocHandle,
        notebook_id: String,
        domain: String,
        activation_generation: u64,
        activation_target: CanonicalNotebookTarget,
    ) -> Self {
        Self {
            handle,
            notebook_id,
            notebook_path: None,
            source: NotebookSessionSource::Hosted { domain },
            activation_generation,
            activation_target: activation_target.as_str().to_string(),
            readiness_evidence: SessionReadinessEvidence::HostedLegacy,
        }
    }

    pub fn is_hosted(&self) -> bool {
        matches!(self.source, NotebookSessionSource::Hosted { .. })
    }

    pub fn session_key(&self) -> String {
        match &self.source {
            NotebookSessionSource::Local => self.notebook_id.clone(),
            NotebookSessionSource::Hosted { domain } => {
                crate::cloud::hosted_notebook_url(domain, &self.notebook_id)
            }
        }
    }

    pub fn rejoin_target(&self) -> String {
        match &self.source {
            NotebookSessionSource::Local => self
                .notebook_path
                .clone()
                .unwrap_or_else(|| self.notebook_id.clone()),
            NotebookSessionSource::Hosted { domain } => {
                crate::cloud::hosted_notebook_url(domain, &self.notebook_id)
            }
        }
    }

    pub fn reactivate(
        &mut self,
        activation_generation: u64,
        activation_target: &CanonicalNotebookTarget,
    ) {
        self.activation_generation = activation_generation;
        self.activation_target = activation_target.as_str().to_string();
    }

    pub fn readiness(&self) -> SessionReadiness {
        let status = self.handle.status();
        let connected = status.connection == ConnectionState::Connected;
        let source_terminal = matches!(
            &status.initial_load,
            InitialLoadPhase::NotNeeded | InitialLoadPhase::Ready
        );
        let notebook_interactive =
            connected && status.notebook_doc == NotebookDocPhase::Interactive && source_terminal;
        let runtime_doc_ready = connected && status.runtime_state == RuntimeStatePhase::Ready;
        let runtime_running = self.handle.get_runtime_state().ok().is_some_and(|state| {
            matches!(
                state.kernel.lifecycle,
                runtime_doc::RuntimeLifecycle::Running(_)
            )
        });

        let (
            mut source_state,
            projection_ready,
            document_ready,
            runtime_ready,
            mut interactive,
            projection_heads,
            runtime_state_heads,
            projection_completeness,
        ) = match &self.readiness_evidence {
            SessionReadinessEvidence::RetainedProjection { evidence } => {
                let projection = &evidence.projection;
                let (notebook_heads_present, runtime_state_heads_present) =
                    evidence.refresh_head_proof(&self.handle);
                let (document_ready, runtime_ready, mut interactive) = retained_readiness_axes(
                    connected,
                    notebook_interactive,
                    runtime_doc_ready,
                    runtime_running,
                    notebook_heads_present,
                    runtime_state_heads_present,
                );
                // A retained degraded projection remains useful for safe
                // reads, but it must never become mutable merely because the
                // local replica later reports convergence.
                if projection.availability.phase == NotebookAvailabilityPhase::Degraded {
                    interactive = false;
                }
                let mut source_state = serde_json::to_value(&projection.source_state)
                    .unwrap_or_else(|_| {
                        serde_json::json!({
                            "phase": "failed",
                            "generation": projection.load_generation,
                            "error_message": "failed to serialize daemon source state",
                        })
                    });
                match &status.initial_load {
                    InitialLoadPhase::Ready => {
                        source_state["phase"] = serde_json::json!(NotebookSourcePhase::Ready);
                    }
                    InitialLoadPhase::Failed { reason } => {
                        source_state["phase"] = serde_json::json!(NotebookSourcePhase::Failed);
                        source_state["error_message"] = serde_json::json!(reason);
                    }
                    InitialLoadPhase::NotNeeded | InitialLoadPhase::Streaming => {}
                }
                (
                    source_state,
                    projection.readiness.projection,
                    document_ready,
                    runtime_ready,
                    interactive,
                    projection.projection_heads.clone(),
                    projection.runtime_state_heads.clone(),
                    Some(if projection.projection_complete {
                        "complete_cell_index_bounded_source_preview".to_string()
                    } else {
                        "partial_cell_index_bounded_source_preview".to_string()
                    }),
                )
            }
            SessionReadinessEvidence::AwaitedSessionReady => {
                let document_ready = notebook_interactive;
                let runtime_ready = runtime_doc_ready && runtime_running;
                (
                    source_state_from_initial_load(&status.initial_load),
                    false,
                    document_ready,
                    runtime_ready,
                    document_ready,
                    Vec::new(),
                    Vec::new(),
                    None,
                )
            }
            SessionReadinessEvidence::HostedLegacy => {
                // Hosted sync does not yet carry the daemon's room lifecycle
                // control frame. Preserve the established hosted capability
                // contract once its replica is connected; otherwise routing
                // hosted sessions through the new centralized gate disables
                // every read and mutation despite a successful connection.
                let document_ready = connected && self.handle.current_heads_hex().is_ok();
                (
                    serde_json::json!({
                        "phase": "legacy_hosted",
                        "warning": "hosted room lifecycle readiness is unavailable; using connected-replica readiness",
                    }),
                    false,
                    document_ready,
                    runtime_doc_ready && runtime_running,
                    document_ready,
                    Vec::new(),
                    Vec::new(),
                    None,
                )
            }
        };

        // RuntimeStateDoc carries source-health changes that happen after the
        // retained connect projection was captured (for example an external
        // file edit or a later journal fsync failure). Treat that durable
        // projection as authoritative and close mutation immediately even if
        // the older session-control frame still says Interactive.
        if let Ok(runtime_state) = self.handle.get_runtime_state() {
            if let Some(issue) = runtime_state.file_checkpoint.source_issue {
                let (error_code, error_message) = match issue {
                    runtime_doc::FileSourceIssue::Conflict { reason } => {
                        ("source_conflict", reason)
                    }
                    runtime_doc::FileSourceIssue::Degraded { reason } => {
                        ("source_degraded", reason)
                    }
                };
                source_state["phase"] = serde_json::json!(NotebookSourcePhase::Failed);
                source_state["error_code"] = serde_json::json!(error_code);
                source_state["error_message"] = serde_json::json!(error_message);
                interactive = false;
            }
        }

        let capabilities = SessionCapabilities {
            // A bounded projection is independently readable before the local
            // replica converges. Full-document readers are gated separately
            // by `SessionRequirement::DocumentRead` below.
            read: projection_ready || interactive,
            mutate: interactive,
            execute: interactive && runtime_ready,
        };
        SessionReadiness {
            session_generation: self.activation_generation,
            target: self.activation_target.clone(),
            source_state,
            projection_ready,
            document_ready,
            runtime_ready,
            interactive,
            projection_heads,
            runtime_state_heads,
            projection_completeness,
            capabilities,
        }
    }

    /// Central capability gate for all tool/resource paths that need a
    /// `DocHandle`. It keeps readiness policy out of individual handlers.
    pub fn access(
        &self,
        requirement: SessionRequirement,
    ) -> Result<SessionAccess, SessionAccessError> {
        let readiness = self.readiness();
        let allowed = match requirement {
            SessionRequirement::ProjectionRead => {
                readiness.projection_ready || readiness.interactive
            }
            SessionRequirement::DocumentRead => readiness.interactive,
            SessionRequirement::DocumentMutation => readiness.capabilities.mutate,
            SessionRequirement::RuntimeRead => {
                let status = self.handle.status();
                status.connection == ConnectionState::Connected
                    && status.runtime_state == RuntimeStatePhase::Ready
            }
            SessionRequirement::Execute => readiness.capabilities.execute,
        };
        if !allowed {
            let (code, message) = if self.handle.status().connection
                == ConnectionState::Disconnected
            {
                (
                    "sync_failed",
                    "Notebook synchronization is disconnected; reconnect before using this operation"
                        .to_string(),
                )
            } else if readiness
                .source_state
                .get("error_code")
                .and_then(serde_json::Value::as_str)
                == Some("source_conflict")
            {
                (
                    "source_conflict",
                    readiness
                        .source_state
                        .get("error_message")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("Notebook source conflicts with recovered journal state")
                        .to_string(),
                )
            } else if let Some(error_code) = readiness
                .source_state
                .get("error_code")
                .and_then(serde_json::Value::as_str)
            {
                (
                    "source_degraded",
                    readiness
                        .source_state
                        .get("error_message")
                        .and_then(serde_json::Value::as_str)
                        .map(ToString::to_string)
                        .unwrap_or_else(|| format!("Notebook source is degraded ({error_code})")),
                )
            } else if let InitialLoadPhase::Failed { reason } = &self.handle.status().initial_load {
                (
                    "source_degraded",
                    format!("Notebook source materialization failed: {reason}"),
                )
            } else if matches!(
                requirement,
                SessionRequirement::RuntimeRead | SessionRequirement::Execute
            ) && readiness.interactive
            {
                // The document side is fully interactive; only the runtime is
                // missing. `notebook_not_ready` promises closed mutate/execute
                // capabilities, which would contradict the open mutate gate in
                // this payload, so runtime-only failures carry their own code.
                (
                    "runtime_not_ready",
                    format!(
                        "Notebook runtime is not ready for {}; launch a kernel or wait for the runtime to become ready",
                        requirement.label()
                    ),
                )
            } else {
                (
                    "notebook_not_ready",
                    format!("Notebook session is not ready for {}", requirement.label()),
                )
            };
            return Err(SessionAccessError {
                code,
                message,
                readiness: Box::new(readiness),
            });
        }

        Ok(SessionAccess {
            handle: self.handle.clone(),
            notebook_id: self.notebook_id.clone(),
            notebook_path: self.notebook_path.clone(),
            projection: match &self.readiness_evidence {
                SessionReadinessEvidence::RetainedProjection { evidence } => {
                    Some(evidence.projection())
                }
                SessionReadinessEvidence::AwaitedSessionReady
                | SessionReadinessEvidence::HostedLegacy => None,
            },
            readiness,
        })
    }
}

impl SessionRequirement {
    fn label(self) -> &'static str {
        match self {
            Self::ProjectionRead => "projection reads",
            Self::DocumentRead => "document reads",
            Self::DocumentMutation => "document mutations",
            Self::RuntimeRead => "runtime reads",
            Self::Execute => "execution",
        }
    }
}

fn source_state_from_initial_load(initial_load: &InitialLoadPhase) -> serde_json::Value {
    match initial_load {
        InitialLoadPhase::NotNeeded => serde_json::json!({ "phase": "not_needed" }),
        InitialLoadPhase::Streaming => serde_json::json!({ "phase": "preparing" }),
        InitialLoadPhase::Ready => serde_json::json!({ "phase": "ready" }),
        InitialLoadPhase::Failed { reason } => {
            serde_json::json!({ "phase": "failed", "reason": reason })
        }
    }
}

fn retained_readiness_axes(
    connected: bool,
    notebook_interactive: bool,
    runtime_doc_ready: bool,
    runtime_running: bool,
    notebook_heads_present: bool,
    runtime_state_heads_present: bool,
) -> (bool, bool, bool) {
    let document_ready = connected && notebook_heads_present;
    let runtime_ready =
        connected && runtime_doc_ready && runtime_running && runtime_state_heads_present;
    let interactive = notebook_interactive && document_ready;
    (document_ready, runtime_ready, interactive)
}

/// Why the session was dropped. Recorded when the session transitions from
/// `Some` → `None` so the "no active session" error can tell agents *why*
/// and *how to recover* instead of a generic message.
#[derive(Debug, Clone)]
pub enum SessionDropReason {
    /// Room was evicted by the daemon (idle timeout).
    Evicted,
    /// Agent switched to a different notebook (normal, not an error).
    Switched,
    /// Daemon connection was lost and rejoin failed.
    Disconnected,
}

impl std::fmt::Display for SessionDropReason {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Evicted => write!(f, "notebook was evicted (idle timeout)"),
            Self::Switched => write!(f, "switched to a different notebook"),
            Self::Disconnected => write!(f, "daemon connection lost"),
        }
    }
}

/// Context from the most recently dropped session — enough for the error
/// message to tell the agent what happened and how to recover.
#[derive(Debug, Clone)]
pub struct SessionDropInfo {
    pub reason: SessionDropReason,
    pub notebook_id: String,
    pub notebook_path: Option<String>,
    pub rejoin_target: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stalled_local_peer_keeps_document_capabilities_closed() {
        // The daemon projection can already be returned to connect_notebook,
        // while a stalled local peer has neither required causal history.
        assert_eq!(
            retained_readiness_axes(true, false, false, false, false, false),
            (false, false, false)
        );

        // Notebook containment is independent from runtime lifecycle. It can
        // make the local document readable without opening mutation.
        assert_eq!(
            retained_readiness_axes(true, false, true, false, true, true),
            (true, false, false)
        );
        assert_eq!(
            retained_readiness_axes(true, true, true, true, true, true),
            (true, true, true)
        );

        // Interactive document mutation does not wait for a running kernel.
        assert_eq!(
            retained_readiness_axes(true, true, true, false, true, true),
            (true, false, true)
        );
    }
}
