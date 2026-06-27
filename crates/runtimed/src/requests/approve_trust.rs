//! `NotebookRequest::ApproveTrust` handler.
//!
//! Trust approval records the notebook's current dependency names in the
//! per-machine package allowlist. The notebook doc itself is not mutated -
//! the allowlist is the source of truth for "I have approved these packages
//! before."

use crate::notebook_sync_server::{check_and_update_trust_state, NotebookRoom};
use crate::protocol::NotebookResponse;
use crate::requests::guarded;
use tracing::error;

const TRUST_APPROVAL_STALE_REASON: &str =
    "Dependencies changed while the trust dialog was open. Review before approving.";

pub(crate) async fn handle(
    room: &NotebookRoom,
    observed_heads: Option<Vec<String>>,
) -> NotebookResponse {
    let trust_info = {
        let doc = room.doc.read().await;
        match apply_trust_approval(&doc, observed_heads.as_deref()) {
            Ok(trust_info) => trust_info,
            Err(error) => return error.into_response(),
        }
    };

    // Approval is now allowlist-driven: the SQLite store is the only place
    // approval is recorded. If persistence fails we have to surface a real
    // error rather than silently report Ok while trust stays blocked.
    if let Err(persist_error) = room
        .trusted_packages
        .add_from_info(&trust_info, "trust_dialog")
    {
        error!(
            "[trusted-packages] approval failed to persist allowlist entries: {}",
            persist_error
        );
        return TrustApprovalError::Persist(format!(
            "Could not record trusted packages: {persist_error}"
        ))
        .into_response();
    }

    let _ = room.broadcasts.changed_tx.send(());
    check_and_update_trust_state(room).await;

    NotebookResponse::Ok {}
}

#[derive(Debug, PartialEq, Eq)]
enum TrustApprovalError {
    StaleDependencies,
    Persist(String),
}

impl TrustApprovalError {
    fn into_response(self) -> NotebookResponse {
        match self {
            TrustApprovalError::StaleDependencies => NotebookResponse::GuardRejected {
                reason: TRUST_APPROVAL_STALE_REASON.to_string(),
            },
            TrustApprovalError::Persist(error) => NotebookResponse::Error { error },
        }
    }
}

/// Validate the approval guard and pull the dependency lists out of the
/// current doc snapshot. The returned `TrustInfo` is what feeds the
/// allowlist write in the handler. The doc is not mutated.
fn apply_trust_approval(
    doc: &notebook_doc::NotebookDoc,
    observed_heads: Option<&[String]>,
) -> Result<runt_trust::TrustInfo, TrustApprovalError> {
    if let Some(observed_heads) = observed_heads {
        guarded::validate_dependencies_unchanged_since_observed(doc, observed_heads)
            .map_err(|_| TrustApprovalError::StaleDependencies)?;
    }

    let snapshot = doc.get_metadata_snapshot().unwrap_or_default();

    let mut metadata = std::collections::HashMap::new();
    if let Ok(runt_value) = serde_json::to_value(&snapshot.runt) {
        metadata.insert("runt".to_string(), runt_value);
    }
    let trust_info = runt_trust::extract_trust_info(&metadata);

    Ok(trust_info)
}

#[cfg(test)]
mod tests {
    use notebook_doc::{
        metadata::{NotebookMetadataSnapshot, UvInlineMetadata},
        NotebookDoc,
    };

    use super::*;

    fn doc_with_uv_deps(deps: &[&str]) -> NotebookDoc {
        let mut doc = NotebookDoc::new("trust-approval-test");
        let mut snapshot = NotebookMetadataSnapshot::default();
        snapshot.runt.uv = Some(UvInlineMetadata {
            dependencies: deps.iter().map(|dep| dep.to_string()).collect(),
            requires_python: None,
            prerelease: None,
        });
        doc.set_metadata_snapshot(&snapshot).unwrap();
        doc
    }

    #[test]
    fn approval_extracts_dep_info_without_mutating_doc() {
        let mut doc = doc_with_uv_deps(&["numpy"]);
        let observed_heads = doc.get_heads_hex();

        let info = apply_trust_approval(&doc, Some(&observed_heads)).unwrap();
        assert_eq!(info.uv_dependencies, vec!["numpy"]);

        // Approval feeds the allowlist; the doc itself stays untouched.
        // Heads stay identical because nothing was written.
        assert_eq!(
            doc.get_heads_hex(),
            observed_heads,
            "approval must not mutate the doc"
        );
    }

    #[test]
    fn approval_rejects_stale_observed_dependencies() {
        let mut doc = doc_with_uv_deps(&["numpy"]);
        let observed_heads = doc.get_heads_hex();
        doc.add_uv_dependency("pandas").unwrap();

        let result = apply_trust_approval(&doc, Some(&observed_heads));

        assert!(matches!(result, Err(TrustApprovalError::StaleDependencies)));
    }

    #[test]
    fn approval_without_metadata_is_noop_no_dependencies() {
        let mut doc = NotebookDoc::new("trust-approval-test");
        let observed_heads = doc.get_heads_hex();

        let info = apply_trust_approval(&doc, Some(&observed_heads)).unwrap();

        assert_eq!(info.status, runt_trust::TrustStatus::NoDependencies);
        assert!(info.uv_dependencies.is_empty());
        assert!(info.conda_dependencies.is_empty());
        assert!(info.pixi_dependencies.is_empty());
        assert!(info.pixi_pypi_dependencies.is_empty());
        assert_eq!(
            doc.get_heads_hex(),
            observed_heads,
            "approval extraction must stay read-only even with missing metadata"
        );
    }
}
