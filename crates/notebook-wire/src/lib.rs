//! Low-level wire constants and control-frame types for notebook connections.
//!
//! This crate deliberately contains no document schema or daemon/client I/O.
//! It is the common layer for crates that need to agree on frame bytes,
//! frame-size caps, and connection-local session status shapes.

#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]

use serde::{Deserialize, Serialize};

pub mod frame_types {
    //! First-byte typed-frame constants for notebook sync connections.

    /// Automerge sync message (binary).
    pub const AUTOMERGE_SYNC: u8 = 0x00;

    /// NotebookRequest (JSON).
    pub const REQUEST: u8 = 0x01;

    /// NotebookResponse (JSON).
    pub const RESPONSE: u8 = 0x02;

    /// NotebookBroadcast (JSON).
    pub const BROADCAST: u8 = 0x03;

    /// Presence (CBOR).
    pub const PRESENCE: u8 = 0x04;

    /// RuntimeStateDoc sync message (binary Automerge sync).
    pub const RUNTIME_STATE_SYNC: u8 = 0x05;

    /// PoolDoc sync message (binary Automerge sync).
    pub const POOL_STATE_SYNC: u8 = 0x06;

    /// Session-control message (JSON).
    pub const SESSION_CONTROL: u8 = 0x07;

    /// Blob upload payload (`u32 header_len | JSON header | raw bytes`).
    pub const PUT_BLOB: u8 = 0x08;

    /// CommsDoc sync message (binary Automerge sync).
    pub const COMMS_DOC_SYNC: u8 = 0x09;

    /// CommentsDoc sync message (binary Automerge sync).
    pub const COMMENTS_DOC_SYNC: u8 = 0x0a;

    /// Keyed document sync, multiplexed by `(kind, id)`
    /// (`u32 header_len | JSON KeyedDocFrameHeader | Automerge sync bytes`).
    pub const KEYED_DOC_SYNC: u8 = 0x0b;
}

const KIB: usize = 1024;
const MIB: usize = 1024 * 1024;

/// Outer ceiling for any frame.
pub const MAX_FRAME_SIZE: usize = 100 * MIB;

/// Maximum frame size for control/handshake frames.
pub const MAX_CONTROL_FRAME_SIZE: usize = 64 * KIB;

/// Per-type body cap and warn threshold for a typed frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FrameSizeLimits {
    /// Hard cap. Frames exceeding this are rejected.
    pub cap: usize,
    /// Soft threshold. Frames exceeding this log a warning but proceed.
    pub warn: usize,
}

/// Per-type body limits for typed frames.
///
/// Unknown type bytes get the outer [`MAX_FRAME_SIZE`] ceiling for forward
/// compatibility — but readers must not allocate for unknown frames; they
/// skip via bounded discard (see `recv_typed_frame`, WP-11). Known types
/// dispatch to the exhaustive [`typed_frame_size_limits`].
pub fn frame_size_limits(type_byte: u8) -> FrameSizeLimits {
    match NotebookFrameType::try_from(type_byte) {
        Ok(frame_type) => typed_frame_size_limits(frame_type),
        Err(_) => FrameSizeLimits {
            cap: MAX_FRAME_SIZE,
            warn: MAX_FRAME_SIZE / 2,
        },
    }
}

/// Exhaustive per-variant limits. No wildcard arm (WP-6): adding a
/// [`NotebookFrameType`] variant fails to compile here until it gets an
/// explicit cap, so a forgotten clause can no longer silently land on the
/// 100 MiB outer ceiling.
pub fn typed_frame_size_limits(frame_type: NotebookFrameType) -> FrameSizeLimits {
    match frame_type {
        NotebookFrameType::AutomergeSync => FrameSizeLimits {
            cap: 64 * MIB,
            warn: 16 * MIB,
        },
        NotebookFrameType::Request => FrameSizeLimits {
            cap: 16 * MIB,
            warn: 256 * KIB,
        },
        NotebookFrameType::Response => FrameSizeLimits {
            cap: 64 * MIB,
            warn: 16 * MIB,
        },
        NotebookFrameType::Broadcast => FrameSizeLimits {
            cap: 16 * MIB,
            warn: 4 * MIB,
        },
        // Presence is CBOR-encoded `PresenceMessage` (cursor / selection /
        // focus / heartbeat). Real-world payloads are ~100 bytes. The cap
        // matches `notebook-doc::presence::MAX_PRESENCE_FRAME_SIZE`, which
        // is the semantic-layer ceiling enforced by `decode_message`. Both
        // values must stay in sync; the WP-3 contract test guards drift.
        NotebookFrameType::Presence => FrameSizeLimits {
            cap: 4 * KIB,
            warn: KIB,
        },
        NotebookFrameType::RuntimeStateSync => FrameSizeLimits {
            cap: 64 * MIB,
            warn: 16 * MIB,
        },
        NotebookFrameType::CommsDocSync => FrameSizeLimits {
            cap: 64 * MIB,
            warn: 16 * MIB,
        },
        NotebookFrameType::CommentsDocSync => FrameSizeLimits {
            cap: 64 * MIB,
            warn: 16 * MIB,
        },
        // Outer ceiling for every keyed document kind; the daemon applies
        // tighter per-kind limits after parsing the header.
        NotebookFrameType::KeyedDocSync => FrameSizeLimits {
            cap: 16 * MIB,
            warn: MIB,
        },
        NotebookFrameType::PoolStateSync => FrameSizeLimits {
            cap: MIB,
            warn: 256 * KIB,
        },
        NotebookFrameType::SessionControl => FrameSizeLimits {
            cap: MIB,
            warn: 256 * KIB,
        },
        NotebookFrameType::PutBlob => FrameSizeLimits {
            cap: 32 * MIB,
            warn: 8 * MIB,
        },
    }
}

/// Minimum protocol version accepted by v4 daemons.
///
/// `u8` because that is the wire width: the preamble carries the version in
/// one byte (WP-7). Widen with `u32::from(...)` where a JSON field wants it.
pub const MIN_PROTOCOL_VERSION: u8 = 4;

/// Magic bytes identifying the runtimed protocol.
pub const MAGIC: [u8; 4] = [0xC0, 0xDE, 0x01, 0xAC];

/// Total preamble size: 4-byte magic + 1-byte protocol version.
pub const PREAMBLE_LEN: usize = 5;

/// Frame types for notebook sync connections.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum NotebookFrameType {
    /// Automerge sync message (binary).
    AutomergeSync = frame_types::AUTOMERGE_SYNC,
    /// NotebookRequest (JSON).
    Request = frame_types::REQUEST,
    /// NotebookResponse (JSON).
    Response = frame_types::RESPONSE,
    /// NotebookBroadcast (JSON).
    Broadcast = frame_types::BROADCAST,
    /// Presence (CBOR).
    Presence = frame_types::PRESENCE,
    /// RuntimeStateDoc sync message (binary Automerge sync).
    RuntimeStateSync = frame_types::RUNTIME_STATE_SYNC,
    /// PoolDoc sync message (binary Automerge sync, global).
    PoolStateSync = frame_types::POOL_STATE_SYNC,
    /// Session-control message (JSON, server-originated connection status).
    SessionControl = frame_types::SESSION_CONTROL,
    /// Blob upload payload (`u32 header_len | JSON header | raw bytes`).
    PutBlob = frame_types::PUT_BLOB,
    /// CommsDoc sync message (binary Automerge sync).
    CommsDocSync = frame_types::COMMS_DOC_SYNC,
    /// CommentsDoc sync message (binary Automerge sync).
    CommentsDocSync = frame_types::COMMENTS_DOC_SYNC,
    /// Keyed document sync (`KeyedDocFrameHeader` + Automerge sync).
    KeyedDocSync = frame_types::KEYED_DOC_SYNC,
}

impl TryFrom<u8> for NotebookFrameType {
    type Error = std::io::Error;

    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
            frame_types::AUTOMERGE_SYNC => Ok(Self::AutomergeSync),
            frame_types::REQUEST => Ok(Self::Request),
            frame_types::RESPONSE => Ok(Self::Response),
            frame_types::BROADCAST => Ok(Self::Broadcast),
            frame_types::PRESENCE => Ok(Self::Presence),
            frame_types::RUNTIME_STATE_SYNC => Ok(Self::RuntimeStateSync),
            frame_types::POOL_STATE_SYNC => Ok(Self::PoolStateSync),
            frame_types::SESSION_CONTROL => Ok(Self::SessionControl),
            frame_types::PUT_BLOB => Ok(Self::PutBlob),
            frame_types::COMMS_DOC_SYNC => Ok(Self::CommsDocSync),
            frame_types::COMMENTS_DOC_SYNC => Ok(Self::CommentsDocSync),
            frame_types::KEYED_DOC_SYNC => Ok(Self::KeyedDocSync),
            _ => Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("unknown notebook frame type: 0x{:02x}", value),
            )),
        }
    }
}

/// Frame types an intermediary may reject without leaving the connection
/// unusable. A sender that sees such a rejection disables the feature for the
/// connection instead of tearing it down.
pub fn is_optional_frame(type_byte: u8) -> bool {
    type_byte == frame_types::KEYED_DOC_SYNC
}

/// Frame types only the daemon sends to clients. Relays refuse these from a
/// client and forward every other type byte opaquely, so a new client frame
/// type needs no relay change; the daemon decides what it accepts.
pub fn is_daemon_originated_frame(type_byte: u8) -> bool {
    matches!(
        type_byte,
        frame_types::RESPONSE | frame_types::BROADCAST | frame_types::SESSION_CONTROL
    )
}

/// Upper bound on a `KeyedDocSync` JSON header.
pub const MAX_KEYED_DOC_FRAME_HEADER_LEN: usize = 4 * KIB;

/// Maximum length of a keyed document kind (`[a-z0-9_]`).
pub const MAX_KEYED_DOC_KIND_LEN: usize = 64;

/// Maximum length of a keyed document id, in UTF-8 bytes.
pub const MAX_KEYED_DOC_ID_LEN: usize = 512;

/// Identity of a keyed document within a room.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub struct KeyedDocKey {
    pub kind: String,
    pub id: String,
}

impl KeyedDocKey {
    pub fn new(kind: impl Into<String>, id: impl Into<String>) -> Self {
        Self {
            kind: kind.into(),
            id: id.into(),
        }
    }
}

/// Header of a `KeyedDocSync` frame payload.
///
/// The payload is `u32 header_len_be | JSON header | Automerge sync bytes`,
/// the sub-framing `PutBlob` uses. Each document has its own sync state per
/// peer and epoch, so receivers route on `(kind, id)` and drop frames for an
/// epoch that is not current. Unknown JSON fields are ignored so later
/// versions can extend the header.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub struct KeyedDocFrameHeader {
    pub kind: String,
    pub id: String,
    pub epoch: u64,
}

/// A malformed `KeyedDocSync` payload.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum KeyedDocFrameError {
    #[error("truncated keyed document frame")]
    Truncated,
    #[error("keyed document frame header too large: {0} bytes")]
    HeaderTooLarge(usize),
    #[error("invalid keyed document frame header: {0}")]
    InvalidHeader(String),
}

impl KeyedDocFrameHeader {
    pub fn new(kind: impl Into<String>, id: impl Into<String>, epoch: u64) -> Self {
        Self {
            kind: kind.into(),
            id: id.into(),
            epoch,
        }
    }

    pub fn key(&self) -> KeyedDocKey {
        KeyedDocKey::new(self.kind.clone(), self.id.clone())
    }

    /// Check the limits [`Self::try_parse`] enforces, so senders can reject a
    /// header the receiver would drop.
    pub fn validate(&self) -> Result<(), KeyedDocFrameError> {
        let kind_ok = !self.kind.is_empty()
            && self.kind.len() <= MAX_KEYED_DOC_KIND_LEN
            && self
                .kind
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_');
        if !kind_ok {
            return Err(KeyedDocFrameError::InvalidHeader(format!(
                "kind must match [a-z0-9_]{{1,{MAX_KEYED_DOC_KIND_LEN}}}"
            )));
        }
        if self.id.is_empty() || self.id.len() > MAX_KEYED_DOC_ID_LEN {
            return Err(KeyedDocFrameError::InvalidHeader(format!(
                "id must be 1..={MAX_KEYED_DOC_ID_LEN} bytes, got {}",
                self.id.len()
            )));
        }
        Ok(())
    }

    /// Payload without the type byte.
    pub fn encode_frame(&self, sync_message: &[u8]) -> Vec<u8> {
        // Serializing two strings and a u64 cannot fail.
        let header = serde_json::to_vec(self).unwrap_or_default();
        let mut frame = Vec::with_capacity(4 + header.len() + sync_message.len());
        frame.extend_from_slice(&(header.len() as u32).to_be_bytes());
        frame.extend_from_slice(&header);
        frame.extend_from_slice(sync_message);
        frame
    }

    /// Split a payload into its validated header and the Automerge sync bytes.
    /// An empty sync body is valid.
    pub fn try_parse(payload: &[u8]) -> Result<(Self, &[u8]), KeyedDocFrameError> {
        let Some(len_bytes) = payload.get(..4) else {
            return Err(KeyedDocFrameError::Truncated);
        };
        let header_len =
            u32::from_be_bytes([len_bytes[0], len_bytes[1], len_bytes[2], len_bytes[3]]) as usize;
        if header_len > MAX_KEYED_DOC_FRAME_HEADER_LEN {
            return Err(KeyedDocFrameError::HeaderTooLarge(header_len));
        }
        let Some(header_bytes) = payload.get(4..4 + header_len) else {
            return Err(KeyedDocFrameError::Truncated);
        };
        let invalid = |err: serde_json::Error| KeyedDocFrameError::InvalidHeader(err.to_string());
        // serde also accepts a struct as a JSON array; only the object form is
        // the wire format, so non-Rust peers parse the same set of headers.
        let value: serde_json::Value = serde_json::from_slice(header_bytes).map_err(invalid)?;
        if !value.is_object() {
            return Err(KeyedDocFrameError::InvalidHeader(
                "header must be a JSON object".into(),
            ));
        }
        let header: Self = serde_json::from_value(value).map_err(invalid)?;
        header.validate()?;
        Ok((header, &payload[4 + header_len..]))
    }
}

/// A typed notebook frame with its type and payload.
#[derive(Debug)]
pub struct TypedNotebookFrame {
    pub frame_type: NotebookFrameType,
    pub payload: Vec<u8>,
}

/// Session-control messages sent by the daemon on the notebook sync socket.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SessionControlMessage {
    SyncStatus(SessionSyncStatusWire),
    HostedBridgeStatus {
        status: HostedBridgeStatusWire,
    },
    /// The daemon refused this peer's `KeyedDocSync` changes for
    /// `(kind, id)` and reset its sync state. The rejected changes stay in the
    /// peer's replica, so the peer drops it and syncs a fresh one for `epoch`.
    /// Sent only to a connection that sent `KeyedDocSync` for that key.
    DocResync {
        kind: String,
        id: String,
        epoch: u64,
        reason: String,
    },
    /// Sent by the coordinator to a runtime agent as the first frame after
    /// accepting its handshake, on every connect. Lists the keyed document
    /// kinds the coordinator routes for this agent; the agent sends
    /// `KeyedDocSync` only for these. A coordinator that never sends it
    /// (older daemon, cloud room) routes none.
    RuntimeAgentCapabilities {
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        keyed_doc_kinds: Vec<String>,
    },
}

/// Daemon-to-hosted-room bridge health for a notebook room.
///
/// This is connection-local control state, not notebook or runtime document
/// state. Local rooms report `NotApplicable`; hosted rooms advance through the
/// remaining phases as the daemon's outbound bridge connects and recovers.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HostedBridgeStatusWire {
    NotApplicable,
    Connecting,
    Connected,
    Reconnecting,
    AuthenticationFailed,
    TerminalError,
}

/// Full connection bootstrap/readiness snapshot.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionSyncStatusWire {
    pub notebook_doc: NotebookDocPhaseWire,
    pub runtime_state: RuntimeStatePhaseWire,
    pub initial_load: InitialLoadPhaseWire,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum NotebookDocPhaseWire {
    Pending,
    Syncing,
    Interactive,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeStatePhaseWire {
    Pending,
    Syncing,
    Ready,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "phase", rename_all = "snake_case")]
pub enum InitialLoadPhaseWire {
    NotNeeded,
    Streaming,
    Ready,
    Failed { reason: String },
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload_with_header(header: &[u8], body: &[u8]) -> Vec<u8> {
        let mut payload = (header.len() as u32).to_be_bytes().to_vec();
        payload.extend_from_slice(header);
        payload.extend_from_slice(body);
        payload
    }

    fn invalid_header(header: &str) -> String {
        match KeyedDocFrameHeader::try_parse(&payload_with_header(header.as_bytes(), b"")) {
            Err(KeyedDocFrameError::InvalidHeader(reason)) => reason,
            other => panic!("expected InvalidHeader for {header}, got {other:?}"),
        }
    }

    #[test]
    fn keyed_doc_frame_type_and_limits() {
        assert_eq!(
            NotebookFrameType::try_from(frame_types::KEYED_DOC_SYNC).unwrap(),
            NotebookFrameType::KeyedDocSync
        );
        assert_eq!(NotebookFrameType::KeyedDocSync as u8, 0x0b);
        let limits = frame_size_limits(frame_types::KEYED_DOC_SYNC);
        assert_eq!(limits.cap, 16 * MIB);
        assert_eq!(limits.warn, MIB);
        assert!(is_optional_frame(frame_types::KEYED_DOC_SYNC));
        assert!(!is_optional_frame(frame_types::AUTOMERGE_SYNC));
        assert!(!is_optional_frame(frame_types::SESSION_CONTROL));
    }

    #[test]
    fn daemon_originated_frames_are_the_relay_deny_list() {
        let denied: Vec<u8> = (0..=u8::MAX)
            .filter(|ty| is_daemon_originated_frame(*ty))
            .collect();
        assert_eq!(
            denied,
            [
                frame_types::RESPONSE,
                frame_types::BROADCAST,
                frame_types::SESSION_CONTROL
            ]
        );
    }

    #[test]
    fn keyed_doc_header_round_trips() {
        let header = KeyedDocFrameHeader::new("bokeh_session", "s1", 3);
        let payload = header.encode_frame(b"sync bytes");
        let (parsed, body) = KeyedDocFrameHeader::try_parse(&payload).unwrap();
        assert_eq!(parsed, header);
        assert_eq!(body, b"sync bytes");
        assert_eq!(parsed.key(), KeyedDocKey::new("bokeh_session", "s1"));

        let json_len = u32::from_be_bytes(payload[..4].try_into().unwrap()) as usize;
        let json: serde_json::Value = serde_json::from_slice(&payload[4..4 + json_len]).unwrap();
        assert_eq!(
            json,
            serde_json::json!({"kind": "bokeh_session", "id": "s1", "epoch": 3})
        );
    }

    #[test]
    fn keyed_doc_header_accepts_empty_body_field_order_and_extra_fields() {
        let payload = payload_with_header(
            br#"{"epoch":7,"future":true,"id":"x/y z","kind":"test_kv"}"#,
            b"",
        );
        let (parsed, body) = KeyedDocFrameHeader::try_parse(&payload).unwrap();
        assert_eq!(parsed, KeyedDocFrameHeader::new("test_kv", "x/y z", 7));
        assert!(body.is_empty());
    }

    #[test]
    fn keyed_doc_header_allows_unknown_kinds() {
        // Routing decides whether a kind is served; the wire only checks shape.
        let header = KeyedDocFrameHeader::new("some_future_kind_2", "id", 0);
        let (parsed, _) = KeyedDocFrameHeader::try_parse(&header.encode_frame(b"")).unwrap();
        assert_eq!(parsed.kind, "some_future_kind_2");
    }

    #[test]
    fn keyed_doc_header_rejects_truncated_payloads() {
        assert_eq!(
            KeyedDocFrameHeader::try_parse(&[0, 0, 0]),
            Err(KeyedDocFrameError::Truncated)
        );
        let mut payload = KeyedDocFrameHeader::new("k", "i", 1).encode_frame(b"");
        payload.pop();
        assert_eq!(
            KeyedDocFrameHeader::try_parse(&payload),
            Err(KeyedDocFrameError::Truncated)
        );
    }

    #[test]
    fn keyed_doc_header_rejects_oversize_header_before_reading_it() {
        let len = (MAX_KEYED_DOC_FRAME_HEADER_LEN + 1) as u32;
        assert_eq!(
            KeyedDocFrameHeader::try_parse(&len.to_be_bytes()),
            Err(KeyedDocFrameError::HeaderTooLarge(len as usize))
        );
        assert_eq!(
            KeyedDocFrameHeader::try_parse(&u32::MAX.to_be_bytes()),
            Err(KeyedDocFrameError::HeaderTooLarge(u32::MAX as usize))
        );
    }

    #[test]
    fn keyed_doc_header_rejects_malformed_json_and_missing_fields() {
        invalid_header("not json");
        invalid_header(r#"{"kind":"k","id":"i"}"#);
        invalid_header(r#"{"kind":"k","epoch":1}"#);
        invalid_header(r#"{"id":"i","epoch":1}"#);
        invalid_header(r#"{"kind":"k","id":"i","epoch":-1}"#);
        invalid_header(r#"{"kind":"k","id":"i","epoch":"1"}"#);
        invalid_header(r#"["k","i",1]"#);
    }

    #[test]
    fn keyed_doc_header_rejects_bad_kind_and_id() {
        for kind in ["", "Bokeh", "bokeh-session", "bokeh session", "kind\\u00e9"] {
            let reason = invalid_header(&format!(r#"{{"kind":"{kind}","id":"i","epoch":1}}"#));
            assert!(reason.contains("kind"), "{kind}: {reason}");
        }
        let long_kind = "a".repeat(MAX_KEYED_DOC_KIND_LEN + 1);
        invalid_header(&format!(r#"{{"kind":"{long_kind}","id":"i","epoch":1}}"#));
        let max_kind = "a".repeat(MAX_KEYED_DOC_KIND_LEN);
        assert!(KeyedDocFrameHeader::new(max_kind, "i", 1)
            .validate()
            .is_ok());

        let reason = invalid_header(r#"{"kind":"k","id":"","epoch":1}"#);
        assert!(reason.contains("id"), "{reason}");
        let long_id = "x".repeat(MAX_KEYED_DOC_ID_LEN + 1);
        invalid_header(&format!(r#"{{"kind":"k","id":"{long_id}","epoch":1}}"#));
        // The id limit counts UTF-8 bytes, not characters.
        let multibyte_id = "\u{e9}".repeat(MAX_KEYED_DOC_ID_LEN / 2 + 1);
        assert!(KeyedDocFrameHeader::new("k", multibyte_id, 1)
            .validate()
            .is_err());
        let max_id = "x".repeat(MAX_KEYED_DOC_ID_LEN);
        assert!(KeyedDocFrameHeader::new("k", max_id, 1).validate().is_ok());
    }

    #[test]
    fn doc_resync_serde() {
        let msg = SessionControlMessage::DocResync {
            kind: "bokeh_session".into(),
            id: "s1".into(),
            epoch: 3,
            reason: "rejected".into(),
        };
        let json = serde_json::to_value(&msg).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "type": "doc_resync",
                "kind": "bokeh_session",
                "id": "s1",
                "epoch": 3,
                "reason": "rejected",
            })
        );
        assert_eq!(
            serde_json::from_value::<SessionControlMessage>(json).unwrap(),
            msg
        );
    }

    #[test]
    fn runtime_agent_capabilities_serde_defaults_to_no_kinds() {
        let msg = SessionControlMessage::RuntimeAgentCapabilities {
            keyed_doc_kinds: vec!["bokeh_session".into()],
        };
        let json = serde_json::to_value(&msg).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "type": "runtime_agent_capabilities",
                "keyed_doc_kinds": ["bokeh_session"],
            })
        );
        assert_eq!(
            serde_json::from_value::<SessionControlMessage>(json).unwrap(),
            msg
        );

        let empty = SessionControlMessage::RuntimeAgentCapabilities {
            keyed_doc_kinds: Vec::new(),
        };
        let json = serde_json::to_value(&empty).unwrap();
        assert_eq!(
            json,
            serde_json::json!({"type": "runtime_agent_capabilities"})
        );
        assert_eq!(
            serde_json::from_value::<SessionControlMessage>(json).unwrap(),
            empty
        );
    }
}
