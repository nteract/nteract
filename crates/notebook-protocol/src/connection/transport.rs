//! Transport abstraction for the runtime-agent sync wire.
//!
//! The runtime agent's `select!` loop reads typed frames from a source and
//! writes typed frames to a sink. Today that wire is the daemon's Unix-domain
//! socket (a Windows named pipe on Windows) carrying length-preamble framing.
//! A hosted runtime peer will instead carry the same typed frames over a cloud
//! WebSocket. The loop, queue dispatch, kernel drive, and RuntimeStateDoc
//! writes are identical across both; only the wire differs.
//!
//! This module abstracts exactly that wire into three pieces:
//!
//! - [`FrameSource`] — the read half: `recv_frame` yields the next typed frame.
//! - [`FrameSink`] — the write half: `send_frame` writes one typed frame.
//! - [`FrameTransport`] — a connector that establishes (or re-establishes) a
//!   connection and hands back a fresh `(Source, Sink)` pair, performing any
//!   transport-specific handshake/auth along the way.
//!
//! ## Why a split (source + sink), not one object
//!
//! The agent loop keeps the read half and write half in *separate* variables
//! on purpose: a `tokio::select!` arm awaiting `recv_frame` borrows the source
//! for the whole `select!`, while other arms call `send_frame` on the sink. A
//! single `&mut self` transport would make those borrows conflict. Splitting
//! the halves preserves the existing structure exactly.
//!
//! ## Why generics, not `dyn`
//!
//! These traits use `async fn` in trait (stable since Rust 1.75), consumed
//! through generics — the same pattern as [`crate::connection`]'s neighbour
//! `KernelConnection` in `runtimed`. Generics keep `notebook-protocol` free of
//! an `async-trait` dependency and let the concrete UDS types stay zero-cost.
//! Each transport impl is monomorphised at its single call site.

use std::path::{Path, PathBuf};

use tokio::io::AsyncWrite;

use super::framing::{send_typed_frame, FramedReader};
use super::handshake::Handshake;
use super::{send_json_frame, send_preamble, NotebookFrameType, TypedNotebookFrame};

/// Capacity of the in-flight frame queue for the reader actor. Matches the
/// value the runtime agent has always used; a slow consumer applies
/// backpressure to the source past this depth.
const FRAME_READER_CAPACITY: usize = 16;

/// The read half of a runtime-agent sync wire.
///
/// `recv_frame` mirrors [`FramedReader::recv`]: `Some(Ok(frame))` per frame,
/// `Some(Err(_))` once on a stream error, and `None` once the source is
/// exhausted (clean EOF or post-error close).
pub trait FrameSource: Send {
    /// Receive the next typed frame. Cancel-safe.
    fn recv_frame(
        &mut self,
    ) -> impl std::future::Future<Output = Option<std::io::Result<TypedNotebookFrame>>> + Send;
}

/// The write half of a runtime-agent sync wire.
pub trait FrameSink: Send {
    /// Write one typed frame to the wire.
    fn send_frame(
        &mut self,
        frame_type: NotebookFrameType,
        payload: &[u8],
    ) -> impl std::future::Future<Output = std::io::Result<()>> + Send;
}

/// A connector that establishes a runtime-agent sync wire.
///
/// `connect` performs the transport-specific dial + handshake/auth and returns
/// a fresh `(Source, Sink)` pair. It is called once at startup and again on
/// every reconnect, so it must be idempotent with respect to the connector's
/// own state (the UDS impl holds only immutable connection parameters).
pub trait FrameTransport: Send + Sync {
    /// The read half this transport produces.
    type Source: FrameSource;
    /// The write half this transport produces.
    type Sink: FrameSink;

    /// Establish a connection and return its read/write halves.
    fn connect(
        &self,
    ) -> impl std::future::Future<Output = std::io::Result<(Self::Source, Self::Sink)>> + Send;

    /// Whether a *clean* end-of-stream (`recv_frame` → `None`, not an error)
    /// should be treated as recoverable — i.e. reconnect and keep the kernel
    /// alive — rather than as a terminal disconnect that tears the kernel down.
    ///
    /// Default `false`: a clean EOF means the peer deliberately half-closed the
    /// stream. For the daemon socket that means the daemon is gone, and the
    /// runtime agent should shut its kernel down — the historical behavior.
    ///
    /// A cloud-WebSocket transport overrides this to `true`: a clean WS close
    /// (idle timeout, server eviction, a network blip surfaced as a normal
    /// close) must NOT kill a healthy daemon-managed kernel. Instead the agent
    /// reconnects and resyncs, mirroring the framing-error recovery path. This
    /// is lifecycle requirement #1 in `docs/handoffs/16-lifecycle-analysis.md`:
    /// the default clean-EOF teardown is actively wrong for a cloud sink.
    fn clean_eof_is_recoverable(&self) -> bool {
        false
    }
}

// -- UDS implementation -----------------------------------------------------

/// Concrete write half for the daemon socket.
#[cfg(unix)]
type StreamWriteHalf = tokio::io::WriteHalf<tokio::net::UnixStream>;
#[cfg(windows)]
type StreamWriteHalf = tokio::io::WriteHalf<tokio::net::windows::named_pipe::NamedPipeClient>;

/// [`FrameSource`] backed by a [`FramedReader`] actor.
///
/// The reader half is type-erased inside `FramedReader::spawn`, so this struct
/// needs no platform `cfg`.
pub struct FramedReaderSource {
    reader: FramedReader,
}

impl FrameSource for FramedReaderSource {
    async fn recv_frame(&mut self) -> Option<std::io::Result<TypedNotebookFrame>> {
        self.reader.recv().await
    }
}

/// [`FrameSink`] backed by an `AsyncWrite` writer, using the length-preamble
/// typed framing. Generic over the writer so it covers both the Unix socket
/// and the Windows named-pipe write halves without `cfg`.
pub struct WriterFrameSink<W: AsyncWrite + Unpin + Send> {
    writer: W,
}

impl<W: AsyncWrite + Unpin + Send> WriterFrameSink<W> {
    /// Wrap an existing writer as a frame sink.
    pub fn new(writer: W) -> Self {
        Self { writer }
    }
}

impl<W: AsyncWrite + Unpin + Send> FrameSink for WriterFrameSink<W> {
    async fn send_frame(
        &mut self,
        frame_type: NotebookFrameType,
        payload: &[u8],
    ) -> std::io::Result<()> {
        send_typed_frame(&mut self.writer, frame_type, payload).await
    }
}

/// The daemon's Unix-domain-socket (Windows named-pipe) transport.
///
/// Holds only immutable connection parameters; `connect` opens a fresh stream,
/// sends the preamble and a [`Handshake::RuntimeAgent`] frame, and hands the
/// reader to a [`FramedReader`] actor so the busy `select!` loop reading via
/// [`FrameSource::recv_frame`] stays cancel-safe.
pub struct UdsFrameTransport {
    socket_path: PathBuf,
    notebook_id: String,
    runtime_agent_id: String,
    blob_root: PathBuf,
}

impl UdsFrameTransport {
    /// Build a transport for the daemon socket at `socket_path`.
    pub fn new(
        socket_path: impl Into<PathBuf>,
        notebook_id: impl Into<String>,
        runtime_agent_id: impl Into<String>,
        blob_root: impl Into<PathBuf>,
    ) -> Self {
        Self {
            socket_path: socket_path.into(),
            notebook_id: notebook_id.into(),
            runtime_agent_id: runtime_agent_id.into(),
            blob_root: blob_root.into(),
        }
    }

    /// The socket path this transport dials. Exposed for diagnostics/logging.
    pub fn socket_path(&self) -> &Path {
        &self.socket_path
    }
}

impl FrameTransport for UdsFrameTransport {
    type Source = FramedReaderSource;
    type Sink = WriterFrameSink<StreamWriteHalf>;

    async fn connect(&self) -> std::io::Result<(Self::Source, Self::Sink)> {
        #[cfg(unix)]
        let stream = tokio::net::UnixStream::connect(&self.socket_path).await?;

        #[cfg(windows)]
        let stream = super::pipe::connect_named_pipe_client(
            &self.socket_path,
            std::time::Duration::from_secs(2),
        )
        .await?;

        let (reader, mut writer) = tokio::io::split(stream);

        send_preamble(&mut writer).await?;
        send_json_frame(
            &mut writer,
            &Handshake::RuntimeAgent {
                notebook_id: self.notebook_id.clone(),
                runtime_agent_id: self.runtime_agent_id.clone(),
                blob_root: self.blob_root.display().to_string(),
            },
        )
        .await
        // `send_json_frame` returns `anyhow::Error` only for the (effectively
        // impossible) serialization failure of a `Handshake`; normalise it to
        // an io error so the transport surface stays io-typed.
        .map_err(|e| std::io::Error::other(e.to_string()))?;

        let source = FramedReaderSource {
            reader: FramedReader::spawn(reader, FRAME_READER_CAPACITY),
        };
        let sink = WriterFrameSink::new(writer);
        Ok((source, sink))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connection::recv_typed_frame;

    /// `WriterFrameSink` writes the same length-preamble typed frame that the
    /// receive side decodes — the behavioural contract the daemon relies on.
    #[tokio::test]
    async fn writer_frame_sink_roundtrips_through_recv_typed_frame() {
        let mut buf = Vec::new();
        let mut sink = WriterFrameSink::new(&mut buf);
        let payload = b"\x05runtime state sync bytes";
        sink.send_frame(NotebookFrameType::RuntimeStateSync, payload)
            .await
            .unwrap();

        let mut cursor = std::io::Cursor::new(buf);
        let frame = recv_typed_frame(&mut cursor).await.unwrap().unwrap();
        assert_eq!(frame.frame_type, NotebookFrameType::RuntimeStateSync);
        assert_eq!(frame.payload, payload);
    }

    /// `FramedReaderSource` yields frames produced by the writer side and then
    /// `None` on clean EOF — matching the loop's source contract.
    #[tokio::test]
    async fn framed_reader_source_yields_frames_then_eof() {
        // Encode two typed frames into a buffer, then read them back through
        // the source over an in-memory pipe.
        let mut wire = Vec::new();
        {
            let mut sink = WriterFrameSink::new(&mut wire);
            sink.send_frame(NotebookFrameType::AutomergeSync, b"first")
                .await
                .unwrap();
            sink.send_frame(NotebookFrameType::Request, b"second")
                .await
                .unwrap();
        }

        let reader = std::io::Cursor::new(wire);
        let mut source = FramedReaderSource {
            reader: FramedReader::spawn(reader, FRAME_READER_CAPACITY),
        };

        let f1 = source.recv_frame().await.unwrap().unwrap();
        assert_eq!(f1.frame_type, NotebookFrameType::AutomergeSync);
        assert_eq!(f1.payload, b"first");

        let f2 = source.recv_frame().await.unwrap().unwrap();
        assert_eq!(f2.frame_type, NotebookFrameType::Request);
        assert_eq!(f2.payload, b"second");

        assert!(source.recv_frame().await.is_none(), "clean EOF -> None");
    }

    /// The UDS transport keeps the historical clean-EOF teardown policy: a
    /// clean daemon-socket close tears the kernel down (the agent breaks its
    /// loop). Cloud transports override this; the default must stay `false` so
    /// desktop behavior is unchanged.
    #[test]
    fn uds_clean_eof_is_not_recoverable_by_default() {
        let transport = UdsFrameTransport::new(
            "/tmp/does-not-need-to-exist.sock",
            "nb",
            "runtime-agent:test",
            "/tmp/blobs",
        );
        assert!(!transport.clean_eof_is_recoverable());
    }
}
