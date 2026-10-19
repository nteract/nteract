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

    /// Bokeh session document sync, multiplexed by session
    /// (`u32 header_len | JSON BokehSessionFrameHeader | Automerge sync bytes`).
    pub const BOKEH_SESSION_DOC_SYNC: u8 = 0x0b;
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
        // Session documents measured 7 to 21 KB with every property value
        // over 1 KB (256 B for arrays) in the blob store.
        NotebookFrameType::BokehSessionDocSync => FrameSizeLimits {
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
    /// Bokeh session document sync (`BokehSessionFrameHeader` + Automerge sync).
    BokehSessionDocSync = frame_types::BOKEH_SESSION_DOC_SYNC,
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
            frame_types::BOKEH_SESSION_DOC_SYNC => Ok(Self::BokehSessionDocSync),
            _ => Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("unknown notebook frame type: 0x{:02x}", value),
            )),
        }
    }
}

/// Header of a `BokehSessionDocSync` frame payload.
///
/// The payload is `u32 header_len_be | JSON header | Automerge sync bytes`,
/// the sub-framing `PutBlob` uses. Each session document has its own sync
/// state per peer and epoch, so receivers route on both fields and drop frames
/// for an epoch that is not current.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BokehSessionFrameHeader {
    pub session_id: String,
    pub epoch: u64,
}

/// Upper bound on the JSON header; a session id and an integer fit easily.
pub const MAX_BOKEH_SESSION_FRAME_HEADER_LEN: usize = 4 * KIB;

/// A malformed `BokehSessionDocSync` payload.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BokehSessionFrameError {
    Truncated,
    HeaderTooLarge(usize),
    InvalidHeader(String),
}

impl std::fmt::Display for BokehSessionFrameError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Truncated => write!(f, "truncated Bokeh session frame"),
            Self::HeaderTooLarge(len) => {
                write!(f, "Bokeh session frame header too large: {len} bytes")
            }
            Self::InvalidHeader(err) => write!(f, "invalid Bokeh session frame header: {err}"),
        }
    }
}

impl std::error::Error for BokehSessionFrameError {}

impl BokehSessionFrameHeader {
    pub fn new(session_id: impl Into<String>, epoch: u64) -> Self {
        Self {
            session_id: session_id.into(),
            epoch,
        }
    }

    pub fn encode_frame(&self, sync_message: &[u8]) -> Vec<u8> {
        // Serializing a String and a u64 cannot fail.
        let header = serde_json::to_vec(self).unwrap_or_default();
        let mut frame = Vec::with_capacity(4 + header.len() + sync_message.len());
        frame.extend_from_slice(&(header.len() as u32).to_be_bytes());
        frame.extend_from_slice(&header);
        frame.extend_from_slice(sync_message);
        frame
    }

    /// Split a payload into its header and the Automerge sync bytes.
    pub fn try_parse(payload: &[u8]) -> Result<(Self, &[u8]), BokehSessionFrameError> {
        let Some(len_bytes) = payload.get(..4) else {
            return Err(BokehSessionFrameError::Truncated);
        };
        let header_len =
            u32::from_be_bytes([len_bytes[0], len_bytes[1], len_bytes[2], len_bytes[3]]) as usize;
        if header_len > MAX_BOKEH_SESSION_FRAME_HEADER_LEN {
            return Err(BokehSessionFrameError::HeaderTooLarge(header_len));
        }
        let Some(header_bytes) = payload.get(4..4 + header_len) else {
            return Err(BokehSessionFrameError::Truncated);
        };
        let header = serde_json::from_slice(header_bytes)
            .map_err(|err| BokehSessionFrameError::InvalidHeader(err.to_string()))?;
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
    /// The daemon refused this peer's `BokehSessionDocSync` changes and reset
    /// its sync state for the session. The rejected changes stay in the
    /// peer's replica, so the peer must drop it and sync a fresh one for
    /// `epoch`, then rewrite unsent values only if the session still accepts
    /// writes.
    BokehSessionResync {
        session_id: String,
        epoch: u64,
        reason: String,
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

    #[test]
    fn bokeh_session_frame_round_trips() {
        let header = BokehSessionFrameHeader::new("session-1", 3);
        let frame = header.encode_frame(b"\x42sync bytes");
        let (parsed, body) = BokehSessionFrameHeader::try_parse(&frame).unwrap();
        assert_eq!(parsed, header);
        assert_eq!(body, b"\x42sync bytes");
    }

    #[test]
    fn bokeh_session_frame_allows_empty_sync_body() {
        let frame = BokehSessionFrameHeader::new("s", 0).encode_frame(&[]);
        let (_, body) = BokehSessionFrameHeader::try_parse(&frame).unwrap();
        assert!(body.is_empty());
    }

    #[test]
    fn bokeh_session_frame_rejects_malformed_payloads() {
        assert_eq!(
            BokehSessionFrameHeader::try_parse(&[0, 0]),
            Err(BokehSessionFrameError::Truncated)
        );
        // Declared header longer than the payload.
        assert_eq!(
            BokehSessionFrameHeader::try_parse(&[0, 0, 0, 9, b'{']),
            Err(BokehSessionFrameError::Truncated)
        );
        let huge = (MAX_BOKEH_SESSION_FRAME_HEADER_LEN as u32 + 1).to_be_bytes();
        assert_eq!(
            BokehSessionFrameHeader::try_parse(&huge),
            Err(BokehSessionFrameError::HeaderTooLarge(
                MAX_BOKEH_SESSION_FRAME_HEADER_LEN + 1
            ))
        );
        let mut bad = 2u32.to_be_bytes().to_vec();
        bad.extend_from_slice(b"{}");
        assert!(matches!(
            BokehSessionFrameHeader::try_parse(&bad),
            Err(BokehSessionFrameError::InvalidHeader(_))
        ));
    }

    #[test]
    fn bokeh_session_frame_type_has_its_own_limits() {
        assert_eq!(
            NotebookFrameType::try_from(frame_types::BOKEH_SESSION_DOC_SYNC).unwrap(),
            NotebookFrameType::BokehSessionDocSync
        );
        let limits = frame_size_limits(frame_types::BOKEH_SESSION_DOC_SYNC);
        assert_eq!(limits.cap, 16 * MIB);
        assert_eq!(limits.warn, MIB);
    }
}
