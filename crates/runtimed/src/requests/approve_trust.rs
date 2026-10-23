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
    "Dependencies changed while the trust dialog was open. Close this review and retry the original action to review the updated notebook.";

#[cfg(test)]
pub(crate) async fn handle(
    room: &NotebookRoom,
    observed_heads: Option<Vec<String>>,
) -> NotebookResponse {
    handle_with_pep723(room, observed_heads, true).await
}

#[cfg(test)]
pub(crate) async fn handle_with_pep723(
    room: &NotebookRoom,
    observed_heads: Option<Vec<String>>,
    include_pep723: bool,
) -> NotebookResponse {
    handle_reviewed(room, observed_heads, include_pep723, None).await
}

pub(crate) async fn handle_reviewed(
    room: &NotebookRoom,
    observed_heads: Option<Vec<String>>,
    include_pep723: bool,
    reviewed_pep723_dependencies: Option<Vec<String>>,
) -> NotebookResponse {
    let trust_info = {
        let doc = room.doc.read().await;
        match apply_trust_approval_scoped(
            &doc,
            observed_heads.as_deref(),
            include_pep723,
            reviewed_pep723_dependencies.as_deref(),
        ) {
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
    InvalidPep723(String),
    Persist(String),
}

impl TrustApprovalError {
    fn into_response(self) -> NotebookResponse {
        match self {
            TrustApprovalError::StaleDependencies => NotebookResponse::GuardRejected {
                reason: TRUST_APPROVAL_STALE_REASON.to_string(),
            },
            TrustApprovalError::InvalidPep723(error) => NotebookResponse::Error {
                error: format!("Invalid PEP 723 metadata: {error}"),
            },
            TrustApprovalError::Persist(error) => NotebookResponse::Error { error },
        }
    }
}

/// Validate the approval guard and pull the dependency lists out of the
/// current doc snapshot. The returned `TrustInfo` is what feeds the
/// allowlist write in the handler. The doc is not mutated.
fn apply_trust_approval_scoped(
    doc: &notebook_doc::NotebookDoc,
    observed_heads: Option<&[String]>,
    include_pep723: bool,
    reviewed_pep723_dependencies: Option<&[String]>,
) -> Result<runt_trust::TrustInfo, TrustApprovalError> {
    if let Some(observed_heads) = observed_heads {
        guarded::validate_dependencies_unchanged_since_observed(doc, observed_heads)
            .map_err(|_| TrustApprovalError::StaleDependencies)?;
    }
    if include_pep723 {
        let current = crate::notebook_sync_server::pep723_dependencies_from_cells(&doc.get_cells())
            .map_err(|error| TrustApprovalError::InvalidPep723(error.to_string()))?;
        if let Some(reviewed) = reviewed_pep723_dependencies {
            if current != reviewed {
                return Err(TrustApprovalError::StaleDependencies);
            }
        }
    }

    if include_pep723 {
        Ok(crate::notebook_sync_server::trust_info_from_doc(doc))
    } else {
        let snapshot = doc.get_metadata_snapshot().unwrap_or_default();
        let mut metadata = std::collections::HashMap::new();
        if let Ok(runt_value) = serde_json::to_value(&snapshot.runt) {
            metadata.insert("runt".to_string(), runt_value);
        }
        Ok(runt_trust::extract_trust_info(&metadata))
    }
}

#[cfg(test)]
fn apply_trust_approval(
    doc: &notebook_doc::NotebookDoc,
    observed_heads: Option<&[String]>,
) -> Result<runt_trust::TrustInfo, TrustApprovalError> {
    apply_trust_approval_scoped(doc, observed_heads, true, None)
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
    fn approval_rejects_empty_observed_heads() {
        let doc = doc_with_uv_deps(&["numpy"]);
        assert!(matches!(
            apply_trust_approval(&doc, Some(&[])),
            Err(TrustApprovalError::StaleDependencies)
        ));
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
    fn approval_extracts_pep723_dependencies() {
        let mut doc = NotebookDoc::new("trust-approval-pep723-test");
        doc.add_cell(0, "cell-1", "code").unwrap();
        doc.update_source(
            "cell-1",
            "# /// script\n# dependencies = [\"payload @ https://example.test/payload.tar.gz\"]\n# ///\n",
        )
        .unwrap();
        let observed_heads = doc.get_heads_hex();

        let info = apply_trust_approval(&doc, Some(&observed_heads)).unwrap();

        assert_eq!(
            info.uv_dependencies,
            vec!["payload @ https://example.test/payload.tar.gz"]
        );
    }

    #[test]
    fn metadata_scoped_approval_excludes_pep723_dependencies() {
        let mut doc = NotebookDoc::new("metadata-approval-pep723-test");
        doc.add_cell(0, "cell-1", "code").unwrap();
        doc.update_source(
            "cell-1",
            "# /// script\n# dependencies = [\"payload @ https://example.test/payload.tar.gz\"]\n# ///\n",
        )
        .unwrap();

        let info = apply_trust_approval_scoped(&doc, None, false, None).unwrap();

        assert!(info.uv_dependencies.is_empty());
    }

    #[test]
    fn approval_rejects_stale_pep723_dependencies() {
        let mut doc = NotebookDoc::new("trust-approval-pep723-test");
        doc.add_cell(0, "cell-1", "code").unwrap();
        doc.update_source(
            "cell-1",
            "# /// script\n# dependencies = [\"numpy\"]\n# ///\n",
        )
        .unwrap();
        let observed_heads = doc.get_heads_hex();
        doc.update_source(
            "cell-1",
            "# /// script\n# dependencies = [\"payload @ https://example.test/payload.tar.gz\"]\n# ///\n",
        )
        .unwrap();

        let result = apply_trust_approval(&doc, Some(&observed_heads));

        assert!(matches!(result, Err(TrustApprovalError::StaleDependencies)));
    }

    #[test]
    fn approval_rejects_pep723_dependencies_not_shown_to_reviewer() {
        let mut doc = NotebookDoc::new("trust-approval-reviewed-pep723-test");
        doc.add_cell(0, "cell-1", "code").unwrap();
        doc.update_source(
            "cell-1",
            "# /// script\n# dependencies = [\"payload @ https://example.test/payload.tar.gz\"]\n# ///\n",
        )
        .unwrap();

        let result = apply_trust_approval_scoped(&doc, None, true, Some(&[]));

        assert!(matches!(result, Err(TrustApprovalError::StaleDependencies)));
    }

    #[test]
    fn malformed_pep723_is_a_validation_error_not_a_stale_review() {
        let mut doc = NotebookDoc::new("trust-approval-malformed-pep723-test");
        doc.add_cell(0, "cell-1", "code").unwrap();
        for source in [
            "# /// script\n# dependencies = \"numpy\"\n# ///\n",
            "# /// script\n# dependencies = [\"numpy\"]\n# ///\n# /// script\n# dependencies = [\"pandas\"]\n# ///\n",
        ] {
            doc.update_source("cell-1", source).unwrap();
            // Programmatic approval can omit the displayed list, but must
            // still reject malformed or duplicate PEP 723 blocks.
            for reviewed in [Some(&[][..]), None] {
                let result = apply_trust_approval_scoped(&doc, None, true, reviewed);
                assert!(matches!(result, Err(TrustApprovalError::InvalidPep723(_))));
            }
        }
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
