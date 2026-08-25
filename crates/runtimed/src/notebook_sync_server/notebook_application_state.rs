//! Versioned application metadata stored atomically with a `NotebookDoc`.
//!
//! The document store owns the commit sequence and durable causal frontier.
//! This codec therefore excludes the recovery journal's manifest version,
//! sequence, and `durable_heads`; callers inject the authoritative store values
//! while decoding. It intentionally has no room-selection or migration side
//! effects.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

use super::recovery::{
    PendingFileCheckpoint, RecoveryManifest, RecoverySourcePhase, SourceFingerprint,
    RECOVERY_MANIFEST_VERSION,
};

const NOTEBOOK_APPLICATION_STATE_FORMAT_VERSION: u16 = 1;
const NOTEBOOK_APPLICATION_STATE_RECOVERY_MANIFEST_VERSION: u16 = 2;
const AUTHORITY_EPOCH: u16 = 1;
pub(crate) const MAX_NOTEBOOK_APPLICATION_STATE_BYTES: usize = 256 * 1024;

// A RecoveryManifest semantic change requires an explicit application-state
// migration decision instead of silently restamping old bytes on decode.
const _: () =
    assert!(NOTEBOOK_APPLICATION_STATE_RECOVERY_MANIFEST_VERSION == RECOVERY_MANIFEST_VERSION);

/// Immutable provenance of the first authoritative repository generation.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct AuthorityActivation {
    authority_epoch: u16,
    origin: AuthorityOrigin,
}

impl AuthorityActivation {
    pub(crate) const fn native() -> Self {
        Self {
            authority_epoch: AUTHORITY_EPOCH,
            origin: AuthorityOrigin::Native,
        }
    }

    pub(crate) const fn recovery_journal(record_sequence: u64, had_torn_suffix: bool) -> Self {
        Self {
            authority_epoch: AUTHORITY_EPOCH,
            origin: AuthorityOrigin::RecoveryJournal {
                record_sequence,
                had_torn_suffix,
            },
        }
    }

    pub(crate) const fn legacy_untitled_mirror() -> Self {
        Self {
            authority_epoch: AUTHORITY_EPOCH,
            origin: AuthorityOrigin::LegacyUntitledMirror,
        }
    }

    pub(crate) const fn authority_epoch(&self) -> u16 {
        self.authority_epoch
    }

    pub(crate) const fn origin(&self) -> &AuthorityOrigin {
        &self.origin
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum AuthorityOrigin {
    Native,
    RecoveryJournal {
        record_sequence: u64,
        had_torn_suffix: bool,
    },
    LegacyUntitledMirror,
}

/// Validated application state paired with store-owned causal metadata.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DecodedNotebookApplicationState {
    pub(crate) manifest: RecoveryManifest,
    pub(crate) activation: AuthorityActivation,
}

#[derive(Debug, Error)]
pub(crate) enum NotebookApplicationStateError {
    #[error("notebook application state serialization failed: {0}")]
    Serialization(#[from] serde_json::Error),
    #[error("notebook application state is {actual} bytes; maximum is {maximum}")]
    StateTooLarge { actual: usize, maximum: usize },
    #[error("unsupported notebook application state format version {version}")]
    UnsupportedFormatVersion { version: u16 },
    #[error("unsupported notebook authority epoch {epoch}")]
    UnsupportedAuthorityEpoch { epoch: u16 },
    #[error(
        "notebook application state claims identity {actual}, but the store requested {expected}"
    )]
    NotebookIdentityMismatch { expected: Uuid, actual: Uuid },
    #[error("{field} contains malformed SHA-256 digest at index {index}: {value}")]
    MalformedDigest {
        field: &'static str,
        index: usize,
        value: String,
    },
    #[error("{field} contains duplicate head {head}")]
    DuplicateHead { field: &'static str, head: String },
    #[error("notebook application state is inconsistent: {0}")]
    InconsistentState(String),
}

#[derive(Debug, Deserialize)]
struct FormatHeader {
    format_version: u16,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct EncodedNotebookApplicationState {
    format_version: u16,
    notebook_id: Uuid,
    activation: AuthorityActivation,
    canonical_path: Option<PathBuf>,
    notebook_schema_version: u64,
    source_fingerprint: String,
    source_generation: u64,
    source_phase: RecoverySourcePhase,
    staged_change_count: u64,
    peer_change_count: u64,
    exported_heads: Vec<String>,
    file_save_sequence: Option<u64>,
    pending_file_checkpoint: Option<EncodedPendingFileCheckpoint>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct EncodedPendingFileCheckpoint {
    canonical_path: PathBuf,
    file_fingerprint: String,
    exported_heads: Vec<String>,
    save_sequence: u64,
    source_generation: Option<u64>,
}

/// Encode caller-owned projection state without duplicating store authority.
pub(crate) fn encode_notebook_application_state(
    manifest: &RecoveryManifest,
    activation: &AuthorityActivation,
) -> Result<Vec<u8>, NotebookApplicationStateError> {
    validate_activation(activation)?;
    validate_paths_and_checkpoint(manifest)?;

    let encoded = EncodedNotebookApplicationState {
        format_version: NOTEBOOK_APPLICATION_STATE_FORMAT_VERSION,
        notebook_id: manifest.notebook_id,
        activation: activation.clone(),
        canonical_path: manifest.canonical_path.clone(),
        notebook_schema_version: manifest.notebook_schema_version,
        source_fingerprint: hex::encode(manifest.source_fingerprint.as_bytes()),
        source_generation: manifest.source_generation,
        source_phase: manifest.source_phase,
        staged_change_count: manifest.staged_change_count,
        peer_change_count: manifest.peer_change_count,
        exported_heads: encode_heads(&manifest.exported_heads, "exported_heads")?,
        file_save_sequence: manifest.file_save_sequence,
        pending_file_checkpoint: manifest
            .pending_file_checkpoint
            .as_ref()
            .map(|pending| -> Result<_, NotebookApplicationStateError> {
                Ok(EncodedPendingFileCheckpoint {
                    canonical_path: pending.canonical_path.clone(),
                    file_fingerprint: hex::encode(pending.file_fingerprint.as_bytes()),
                    exported_heads: encode_heads(
                        &pending.exported_heads,
                        "pending_file_checkpoint.exported_heads",
                    )?,
                    save_sequence: pending.save_sequence,
                    source_generation: pending.source_generation,
                })
            })
            .transpose()?,
    };
    let bytes = serde_json::to_vec(&encoded)?;
    ensure_bounded(bytes.len())?;
    Ok(bytes)
}

/// Decode projection state using the store row's identity, sequence, and
/// frontier as the only authoritative values for those fields.
pub(crate) fn decode_notebook_application_state(
    bytes: &[u8],
    expected_notebook_id: Uuid,
    store_sequence: u64,
    store_durable_heads: &[[u8; 32]],
) -> Result<DecodedNotebookApplicationState, NotebookApplicationStateError> {
    ensure_bounded(bytes.len())?;
    let header: FormatHeader = serde_json::from_slice(bytes)?;
    if header.format_version != NOTEBOOK_APPLICATION_STATE_FORMAT_VERSION {
        return Err(NotebookApplicationStateError::UnsupportedFormatVersion {
            version: header.format_version,
        });
    }

    let encoded: EncodedNotebookApplicationState = serde_json::from_slice(bytes)?;
    validate_activation(&encoded.activation)?;
    if encoded.notebook_id != expected_notebook_id {
        return Err(NotebookApplicationStateError::NotebookIdentityMismatch {
            expected: expected_notebook_id,
            actual: encoded.notebook_id,
        });
    }
    validate_unique_raw_heads(store_durable_heads, "store.durable_heads")?;

    let source_fingerprint = SourceFingerprint::from_digest(decode_digest(
        &encoded.source_fingerprint,
        "source_fingerprint",
        0,
    )?);
    let exported_heads = decode_heads(&encoded.exported_heads, "exported_heads")?;
    let pending_file_checkpoint = encoded
        .pending_file_checkpoint
        .map(|pending| -> Result<_, NotebookApplicationStateError> {
            Ok(PendingFileCheckpoint {
                canonical_path: pending.canonical_path,
                file_fingerprint: SourceFingerprint::from_digest(decode_digest(
                    &pending.file_fingerprint,
                    "pending_file_checkpoint.file_fingerprint",
                    0,
                )?),
                exported_heads: decode_heads(
                    &pending.exported_heads,
                    "pending_file_checkpoint.exported_heads",
                )?,
                save_sequence: pending.save_sequence,
                source_generation: pending.source_generation,
            })
        })
        .transpose()?;

    let manifest = RecoveryManifest {
        version: NOTEBOOK_APPLICATION_STATE_RECOVERY_MANIFEST_VERSION,
        sequence: store_sequence,
        notebook_id: encoded.notebook_id,
        canonical_path: encoded.canonical_path,
        notebook_schema_version: encoded.notebook_schema_version,
        source_fingerprint,
        source_generation: encoded.source_generation,
        source_phase: encoded.source_phase,
        staged_change_count: encoded.staged_change_count,
        peer_change_count: encoded.peer_change_count,
        durable_heads: store_durable_heads.to_vec(),
        exported_heads,
        file_save_sequence: encoded.file_save_sequence,
        pending_file_checkpoint,
    };
    validate_paths_and_checkpoint(&manifest)?;

    Ok(DecodedNotebookApplicationState {
        manifest,
        activation: encoded.activation,
    })
}

fn ensure_bounded(actual: usize) -> Result<(), NotebookApplicationStateError> {
    if actual > MAX_NOTEBOOK_APPLICATION_STATE_BYTES {
        return Err(NotebookApplicationStateError::StateTooLarge {
            actual,
            maximum: MAX_NOTEBOOK_APPLICATION_STATE_BYTES,
        });
    }
    Ok(())
}

fn validate_activation(
    activation: &AuthorityActivation,
) -> Result<(), NotebookApplicationStateError> {
    if activation.authority_epoch != AUTHORITY_EPOCH {
        return Err(NotebookApplicationStateError::UnsupportedAuthorityEpoch {
            epoch: activation.authority_epoch,
        });
    }
    Ok(())
}

fn validate_paths_and_checkpoint(
    manifest: &RecoveryManifest,
) -> Result<(), NotebookApplicationStateError> {
    if manifest
        .canonical_path
        .as_deref()
        .is_some_and(path_is_empty)
    {
        return Err(NotebookApplicationStateError::InconsistentState(
            "canonical_path must not be empty".to_string(),
        ));
    }
    if manifest.file_save_sequence.is_some() && manifest.canonical_path.is_none() {
        return Err(NotebookApplicationStateError::InconsistentState(
            "file_save_sequence requires a canonical_path".to_string(),
        ));
    }
    if let Some(pending) = &manifest.pending_file_checkpoint {
        if path_is_empty(&pending.canonical_path) {
            return Err(NotebookApplicationStateError::InconsistentState(
                "pending_file_checkpoint.canonical_path must not be empty".to_string(),
            ));
        }
        if manifest
            .file_save_sequence
            .is_some_and(|committed| pending.save_sequence <= committed)
        {
            return Err(NotebookApplicationStateError::InconsistentState(
                "pending file checkpoint sequence must follow the committed checkpoint".to_string(),
            ));
        }
    }
    Ok(())
}

fn path_is_empty(path: &Path) -> bool {
    path.as_os_str().is_empty()
}

fn encode_heads(
    heads: &[[u8; 32]],
    field: &'static str,
) -> Result<Vec<String>, NotebookApplicationStateError> {
    validate_unique_raw_heads(heads, field)?;
    let mut encoded = heads.iter().map(hex::encode).collect::<Vec<_>>();
    encoded.sort_unstable();
    Ok(encoded)
}

fn decode_heads(
    heads: &[String],
    field: &'static str,
) -> Result<Vec<[u8; 32]>, NotebookApplicationStateError> {
    let decoded = heads
        .iter()
        .enumerate()
        .map(|(index, head)| decode_digest(head, field, index))
        .collect::<Result<Vec<_>, _>>()?;
    validate_unique_raw_heads(&decoded, field)?;
    Ok(decoded)
}

fn decode_digest(
    value: &str,
    field: &'static str,
    index: usize,
) -> Result<[u8; 32], NotebookApplicationStateError> {
    let mut digest = [0; 32];
    if value.len() != 64 || hex::decode_to_slice(value, &mut digest).is_err() {
        return Err(NotebookApplicationStateError::MalformedDigest {
            field,
            index,
            value: value.to_string(),
        });
    }
    Ok(digest)
}

fn validate_unique_raw_heads(
    heads: &[[u8; 32]],
    field: &'static str,
) -> Result<(), NotebookApplicationStateError> {
    let mut seen = HashSet::with_capacity(heads.len());
    for head in heads {
        if !seen.insert(*head) {
            return Err(NotebookApplicationStateError::DuplicateHead {
                field,
                head: hex::encode(head),
            });
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use serde_json::{json, Value};

    use super::*;
    use crate::notebook_sync_server::recovery::source_fingerprint;

    fn manifest(notebook_id: Uuid) -> RecoveryManifest {
        let mut manifest = RecoveryManifest::new(
            17,
            notebook_id,
            Some(PathBuf::from("/tmp/source.ipynb")),
            4,
            source_fingerprint(b"source"),
            8,
        );
        manifest.source_phase = RecoverySourcePhase::Ready;
        manifest.staged_change_count = 11;
        manifest.peer_change_count = 12;
        manifest.durable_heads = vec![[9; 32], [8; 32]];
        manifest.exported_heads = vec![[2; 32], [1; 32]];
        manifest.file_save_sequence = Some(4);
        manifest.pending_file_checkpoint = Some(PendingFileCheckpoint {
            // A Save As intent may legitimately differ from the currently
            // committed canonical path.
            canonical_path: PathBuf::from("/tmp/destination.ipynb"),
            file_fingerprint: source_fingerprint(b"destination"),
            exported_heads: vec![[4; 32], [3; 32]],
            save_sequence: 5,
            source_generation: Some(9),
        });
        manifest
    }

    fn mutate_json(bytes: &[u8], mutation: impl FnOnce(&mut Value)) -> Vec<u8> {
        let mut value: Value = serde_json::from_slice(bytes).unwrap();
        mutation(&mut value);
        serde_json::to_vec(&value).unwrap()
    }

    #[test]
    fn round_trip_uses_store_sequence_and_heads_as_authority() {
        let notebook_id = Uuid::new_v4();
        let source = manifest(notebook_id);
        let activation = AuthorityActivation::recovery_journal(17, true);
        let bytes = encode_notebook_application_state(&source, &activation).unwrap();
        let encoded: Value = serde_json::from_slice(&bytes).unwrap();
        let object = encoded.as_object().unwrap();

        assert!(!object.contains_key("version"));
        assert!(!object.contains_key("sequence"));
        assert!(!object.contains_key("durable_heads"));
        assert_eq!(object["format_version"], 1);
        assert_eq!(
            encode_notebook_application_state(&source, &activation).unwrap(),
            bytes
        );
        let mut different_store_authority = source.clone();
        different_store_authority.sequence = u64::MAX;
        different_store_authority.durable_heads = vec![[42; 32]];
        assert_eq!(
            encode_notebook_application_state(&different_store_authority, &activation).unwrap(),
            bytes
        );

        let store_heads = vec![[7; 32], [6; 32]];
        let decoded =
            decode_notebook_application_state(&bytes, notebook_id, 29, &store_heads).unwrap();
        assert_eq!(decoded.activation, activation);
        assert_eq!(decoded.manifest.version, RECOVERY_MANIFEST_VERSION);
        assert_eq!(decoded.manifest.sequence, 29);
        assert_eq!(decoded.manifest.durable_heads, store_heads);
        assert_eq!(decoded.manifest.notebook_id, source.notebook_id);
        assert_eq!(decoded.manifest.canonical_path, source.canonical_path);
        assert_eq!(
            decoded.manifest.source_fingerprint,
            source.source_fingerprint
        );
        assert_eq!(decoded.manifest.source_phase, source.source_phase);
        assert_eq!(decoded.manifest.staged_change_count, 11);
        assert_eq!(decoded.manifest.peer_change_count, 12);
        assert_eq!(decoded.manifest.exported_heads, vec![[1; 32], [2; 32]]);
        assert_eq!(
            decoded
                .manifest
                .pending_file_checkpoint
                .unwrap()
                .exported_heads,
            vec![[3; 32], [4; 32]]
        );
    }

    #[test]
    fn all_activation_origins_are_stable() {
        let notebook_id = Uuid::new_v4();
        let manifest = manifest(notebook_id);
        let activations = [
            AuthorityActivation::native(),
            AuthorityActivation::recovery_journal(41, false),
            AuthorityActivation::legacy_untitled_mirror(),
        ];

        for activation in activations {
            let bytes = encode_notebook_application_state(&manifest, &activation).unwrap();
            let decoded =
                decode_notebook_application_state(&bytes, notebook_id, 1, &[[1; 32]]).unwrap();
            assert_eq!(decoded.activation.authority_epoch(), AUTHORITY_EPOCH);
            assert_eq!(decoded.activation.origin(), activation.origin());
        }
    }

    #[test]
    fn rejects_unknown_format_version_and_authority_epoch() {
        let notebook_id = Uuid::new_v4();
        let bytes = encode_notebook_application_state(
            &manifest(notebook_id),
            &AuthorityActivation::native(),
        )
        .unwrap();
        let unknown_format = mutate_json(&bytes, |value| value["format_version"] = json!(2));
        assert!(matches!(
            decode_notebook_application_state(&unknown_format, notebook_id, 1, &[]),
            Err(NotebookApplicationStateError::UnsupportedFormatVersion { version: 2 })
        ));

        let unknown_epoch = mutate_json(&bytes, |value| {
            value["activation"]["authority_epoch"] = json!(2);
        });
        assert!(matches!(
            decode_notebook_application_state(&unknown_epoch, notebook_id, 1, &[]),
            Err(NotebookApplicationStateError::UnsupportedAuthorityEpoch { epoch: 2 })
        ));
    }

    #[test]
    fn rejects_identity_mismatch_and_oversized_state() {
        let notebook_id = Uuid::new_v4();
        let bytes = encode_notebook_application_state(
            &manifest(notebook_id),
            &AuthorityActivation::native(),
        )
        .unwrap();
        assert!(matches!(
            decode_notebook_application_state(&bytes, Uuid::new_v4(), 1, &[]),
            Err(NotebookApplicationStateError::NotebookIdentityMismatch { .. })
        ));

        let oversized = vec![b' '; MAX_NOTEBOOK_APPLICATION_STATE_BYTES + 1];
        assert!(matches!(
            decode_notebook_application_state(&oversized, notebook_id, 1, &[]),
            Err(NotebookApplicationStateError::StateTooLarge { .. })
        ));

        let mut oversized_manifest = manifest(notebook_id);
        oversized_manifest.canonical_path = Some(PathBuf::from(
            "x".repeat(MAX_NOTEBOOK_APPLICATION_STATE_BYTES),
        ));
        assert!(matches!(
            encode_notebook_application_state(&oversized_manifest, &AuthorityActivation::native()),
            Err(NotebookApplicationStateError::StateTooLarge { .. })
        ));
    }

    #[test]
    fn rejects_malformed_and_duplicate_heads() {
        let notebook_id = Uuid::new_v4();
        let bytes = encode_notebook_application_state(
            &manifest(notebook_id),
            &AuthorityActivation::native(),
        )
        .unwrap();
        let malformed = mutate_json(&bytes, |value| {
            value["exported_heads"] = json!(["not-a-change-hash"]);
        });
        assert!(matches!(
            decode_notebook_application_state(&malformed, notebook_id, 1, &[]),
            Err(NotebookApplicationStateError::MalformedDigest {
                field: "exported_heads",
                ..
            })
        ));

        let duplicate = hex::encode([5; 32]);
        let duplicate_state = mutate_json(&bytes, |value| {
            value["pending_file_checkpoint"]["exported_heads"] = json!([duplicate, duplicate]);
        });
        assert!(matches!(
            decode_notebook_application_state(&duplicate_state, notebook_id, 1, &[]),
            Err(NotebookApplicationStateError::DuplicateHead {
                field: "pending_file_checkpoint.exported_heads",
                ..
            })
        ));

        assert!(matches!(
            decode_notebook_application_state(&bytes, notebook_id, 1, &[[8; 32], [8; 32]]),
            Err(NotebookApplicationStateError::DuplicateHead {
                field: "store.durable_heads",
                ..
            })
        ));
    }

    #[test]
    fn rejects_inconsistent_checkpoint_and_path_fields() {
        let notebook_id = Uuid::new_v4();
        let mut missing_path = manifest(notebook_id);
        missing_path.canonical_path = None;
        assert!(matches!(
            encode_notebook_application_state(
                &missing_path,
                &AuthorityActivation::legacy_untitled_mirror()
            ),
            Err(NotebookApplicationStateError::InconsistentState(_))
        ));

        let mut stale_intent = manifest(notebook_id);
        stale_intent
            .pending_file_checkpoint
            .as_mut()
            .unwrap()
            .save_sequence = 4;
        assert!(matches!(
            encode_notebook_application_state(&stale_intent, &AuthorityActivation::native()),
            Err(NotebookApplicationStateError::InconsistentState(_))
        ));

        let mut empty_pending_path = manifest(notebook_id);
        empty_pending_path
            .pending_file_checkpoint
            .as_mut()
            .unwrap()
            .canonical_path = PathBuf::new();
        assert!(matches!(
            encode_notebook_application_state(&empty_pending_path, &AuthorityActivation::native()),
            Err(NotebookApplicationStateError::InconsistentState(_))
        ));
    }
}
