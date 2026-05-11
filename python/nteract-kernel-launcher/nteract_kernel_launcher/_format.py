"""DataFrame / Arrow serialization (best-available encoder).

Arrow IPC stream is the canonical rich table payload. Producers that implement
the Arrow PyCapsule stream protocol are imported through ``__arrow_c_stream__``;
pandas and polars keep direct fallbacks for older versions. If the serialized
payload would exceed ``max_bytes``, the serializer downsamples via ``head(n)`` /
``slice(0, n)`` with a halving loop and the caller advertises the partial-data
state in the ``text/llm+plain`` summary and the ref-MIME ``summary`` hints.
"""

from __future__ import annotations

import hashlib
import io
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from typing import Any

PARQUET_MIME = "application/vnd.apache.parquet"
ARROW_STREAM_MIME = "application/vnd.apache.arrow.stream"
ARROW_STREAM_MANIFEST_MIME = "application/vnd.nteract.arrow-stream-manifest+json"
DEFAULT_ARROW_CHUNK_BYTES = 8 * 1024 * 1024


@dataclass(frozen=True)
class ArrowStreamChunk:
    """A self-contained Arrow IPC mini-stream chunk."""

    index: int
    data: bytes
    content_hash: str
    size: int
    row_count: int
    record_batch_count: int

    def manifest_entry(self) -> dict[str, Any]:
        return {
            "index": self.index,
            "hash": self.content_hash,
            "size": self.size,
            "row_count": self.row_count,
            "record_batch_count": self.record_batch_count,
            "encoding": "arrow-ipc-stream",
        }


def _detect_flavor(df: Any) -> str:
    mod = type(df).__module__.split(".")[0]
    return mod if mod in ("pandas", "polars") else "unknown"


def _row_count(obj: Any) -> int | None:
    for attr in ("num_rows", "height"):
        value = getattr(obj, attr, None)
        if isinstance(value, int):
            return value

    shape = getattr(obj, "shape", None)
    if isinstance(shape, tuple) and shape and isinstance(shape[0], int):
        return shape[0]

    try:
        return len(obj)
    except TypeError:
        return None


def _limit_rows(obj: Any, rows: int) -> Any:
    head = getattr(obj, "head", None)
    if callable(head):
        return head(rows)

    slice_ = getattr(obj, "slice", None)
    if callable(slice_):
        return slice_(0, rows)

    limit = getattr(obj, "limit", None)
    if callable(limit):
        return limit(rows)

    raise TypeError(f"{type(obj).__module__}.{type(obj).__name__} cannot be row-limited")


def _record_batch_reader_from_stream(source: Any) -> Any:
    import pyarrow as pa

    from_stream = getattr(pa.RecordBatchReader, "from_stream", None)
    if callable(from_stream):
        return from_stream(source)

    # PyArrow 14/15 expose producer-side `__arrow_c_stream__()` before the
    # public `RecordBatchReader.from_stream()` consumer. Keep this fallback
    # narrowly scoped to generic PyCapsule sources; known pyarrow.Table paths
    # write IPC directly and do not depend on this private bridge.
    import_capsule = getattr(pa.RecordBatchReader, "_import_from_c_capsule", None)
    if callable(import_capsule) and hasattr(source, "__arrow_c_stream__"):
        return import_capsule(source.__arrow_c_stream__())

    raise TypeError("pyarrow does not support Arrow PyCapsule stream import")


def _serialize_record_batch_reader(reader: Any) -> bytes:
    import pyarrow as pa

    sink = pa.BufferOutputStream()
    with pa.ipc.new_stream(sink, reader.schema) as writer:
        for batch in reader:
            writer.write_batch(batch)
    return sink.getvalue().to_pybytes()


def _serialize_record_batches(schema: Any, batches: list[Any]) -> bytes:
    import pyarrow as pa

    sink = pa.BufferOutputStream()
    with pa.ipc.new_stream(sink, schema) as writer:
        for batch in batches:
            writer.write_batch(batch)
    return sink.getvalue().to_pybytes()


def _record_batch_estimated_bytes(batch: Any) -> int:
    nbytes = getattr(batch, "nbytes", None)
    if isinstance(nbytes, int):
        return nbytes
    get_total_buffer_size = getattr(batch, "get_total_buffer_size", None)
    if callable(get_total_buffer_size):
        size = get_total_buffer_size()
        if isinstance(size, int):
            return size
    return 0


def _make_arrow_stream_chunk(
    *,
    index: int,
    schema: Any,
    batches: list[Any],
    row_count: int,
) -> ArrowStreamChunk:
    data = _serialize_record_batches(schema, batches)
    return ArrowStreamChunk(
        index=index,
        data=data,
        content_hash=hashlib.sha256(data).hexdigest(),
        size=len(data),
        row_count=row_count,
        record_batch_count=len(batches),
    )


def iter_arrow_stream_chunks(
    source: Any,
    *,
    max_chunk_bytes: int = DEFAULT_ARROW_CHUNK_BYTES,
) -> Iterator[ArrowStreamChunk]:
    """Yield independently decodable Arrow IPC stream chunks from ``source``.

    The source is consumed once as a ``RecordBatchReader``. Chunk boundaries are
    record-batch boundaries; this intentionally avoids splitting serialized IPC
    bytes after the fact.
    """
    if max_chunk_bytes <= 0:
        raise ValueError("max_chunk_bytes must be positive")

    reader = _record_batch_reader_from_stream(source)
    schema = reader.schema
    chunk_index = 0
    batches: list[Any] = []
    row_count = 0
    estimated_bytes = 0

    for batch in reader:
        batch_rows = getattr(batch, "num_rows", 0)
        batch_bytes = _record_batch_estimated_bytes(batch)
        if batches and estimated_bytes + batch_bytes > max_chunk_bytes:
            yield _make_arrow_stream_chunk(
                index=chunk_index,
                schema=schema,
                batches=batches,
                row_count=row_count,
            )
            chunk_index += 1
            batches = []
            row_count = 0
            estimated_bytes = 0

        batches.append(batch)
        row_count += batch_rows
        estimated_bytes += batch_bytes

    if batches or chunk_index == 0:
        yield _make_arrow_stream_chunk(
            index=chunk_index,
            schema=schema,
            batches=batches,
            row_count=row_count,
        )


def _serialize_arrow_stream_exportable(source: Any, rows: int | None = None) -> bytes:
    if rows is not None:
        source = _limit_rows(source, rows)
    reader = _record_batch_reader_from_stream(source)
    return _serialize_record_batch_reader(reader)


def _serialize_arrow_table_direct(table: Any) -> bytes:
    import pyarrow as pa

    sink = pa.BufferOutputStream()
    with pa.ipc.new_stream(sink, table.schema) as writer:
        writer.write_table(table)
    return sink.getvalue().to_pybytes()


def _serialize_pandas(df: Any, rows: int | None = None) -> bytes:
    import pyarrow as pa

    if rows is not None:
        df = df.head(rows)
    table = pa.Table.from_pandas(df)
    return _serialize_arrow_table_direct(table)


def _serialize_polars(df: Any, rows: int | None = None) -> bytes:
    if rows is not None:
        df = df.head(rows)
    buf = io.BytesIO()
    df.write_ipc_stream(buf)
    return buf.getvalue()


def _serialize_arrow_stream_table(table: Any, rows: int | None = None) -> bytes:
    if rows is not None:
        table = table.slice(0, rows)
    return _serialize_arrow_table_direct(table)


def build_arrow_stream_manifest(
    data: bytes,
    *,
    content_hash: str,
    content_size: int,
    row_count: int,
    record_batch_count: int | None = None,
    summary: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build a one-chunk Arrow stream manifest for ``data``.

    Phase 2 keeps the direct Arrow IPC stream MIME in the bundle for existing
    renderers. The manifest is a structured sidecar describing that same blob
    so runtime/frontends can learn the durable shape before progressive chunks
    become the selected render path.
    """
    chunk = ArrowStreamChunk(
        index=0,
        data=data,
        content_hash=content_hash,
        size=content_size,
        row_count=row_count,
        record_batch_count=record_batch_count or 0,
    )
    manifest = build_arrow_stream_manifest_from_chunks(
        [chunk],
        complete=True,
        summary=summary,
    )
    if record_batch_count is None:
        manifest["chunks"][0].pop("record_batch_count", None)
    return manifest


def build_arrow_stream_manifest_from_chunks(
    chunks: list[ArrowStreamChunk],
    *,
    complete: bool,
    summary: dict[str, Any] | None = None,
    schema: Any | None = None,
) -> dict[str, Any]:
    """Build an Arrow stream manifest for ordered IPC mini-stream chunks."""
    import pyarrow as pa

    if not chunks:
        raise ValueError("at least one Arrow stream chunk is required")

    if schema is None:
        schema = pa.ipc.open_stream(pa.BufferReader(chunks[0].data)).schema
    schema_bytes = schema.serialize().to_pybytes()
    metadata = schema.metadata or {}

    return {
        "version": 1,
        "content_type": ARROW_STREAM_MIME,
        "schema": {
            "hash": hashlib.sha256(schema_bytes).hexdigest(),
            "content_type": "application/vnd.apache.arrow.schema",
            "fields": len(schema),
            "metadata": {
                "pandas": b"pandas" in metadata,
                "huggingface": b"huggingface" in metadata,
            },
        },
        "chunks": [chunk.manifest_entry() for chunk in chunks],
        "complete": complete,
        "summary": summary or {},
    }


def _downsample_loop(
    encode: Callable[..., bytes], total_rows: int, *, max_bytes: int
) -> tuple[bytes, int]:
    """Encode at full size; if too big, halve target rows up to four rounds.

    Compression and Arrow encoding overhead are non-linear in row count, so the
    first guess (``rows * max_bytes / full_bytes``) tends to overshoot. Halving
    from there converges quickly; bottoming out at one row keeps this from
    raising for sampling.
    """
    full = encode()
    if len(full) <= max_bytes:
        return full, total_rows
    if total_rows <= 1:
        return full, total_rows
    target_rows = max(1, int(total_rows * (max_bytes / len(full))))
    for _ in range(4):
        sampled = encode(rows=target_rows)
        if len(sampled) <= max_bytes:
            return sampled, target_rows
        target_rows = max(1, target_rows // 2)
    return encode(rows=1), 1


def serialize_dataframe(df: Any, *, max_bytes: int) -> tuple[bytes, str, int]:
    """Serialize ``df`` to Arrow IPC; downsample if it would exceed ``max_bytes``.

    Returns ``(bytes, content_type, included_rows)``. Raises ``ValueError`` for
    unsupported DataFrame types.
    """
    flavor = _detect_flavor(df)
    if flavor == "polars":
        encoder = _serialize_polars
        n = df.height
    elif flavor == "pandas":
        encoder = _serialize_pandas
        n = len(df)
    elif hasattr(df, "__arrow_c_stream__"):
        n = _row_count(df)
        if n is None:
            raise ValueError(
                f"unsupported row count for: {type(df).__module__}.{type(df).__name__}"
            )
        data = _serialize_arrow_stream_exportable(df)
        if len(data) > max_bytes:
            raise ValueError(
                "generic Arrow PyCapsule stream exceeds max_bytes; progressive chunking is required"
            )
        return data, ARROW_STREAM_MIME, n
    else:
        raise ValueError(f"unsupported DataFrame type: {type(df).__module__}.{type(df).__name__}")

    if n is None:
        raise ValueError(f"unsupported row count for: {type(df).__module__}.{type(df).__name__}")

    data, included_rows = _downsample_loop(
        lambda rows=None: encoder(df, rows=rows), n, max_bytes=max_bytes
    )
    return data, ARROW_STREAM_MIME, included_rows


def serialize_arrow_table(table: Any, *, max_bytes: int) -> tuple[bytes, str, int]:
    """Serialize ``pa.Table`` to Arrow IPC stream bytes.

    Same downsample semantics as :func:`serialize_dataframe`. Schema KV metadata
    (``huggingface``, ``content_defined_chunking``, etc.) survives because the
    stream carries the Arrow schema directly.
    """
    data, included_rows = _downsample_loop(
        lambda rows=None: _serialize_arrow_stream_table(table, rows=rows),
        table.num_rows,
        max_bytes=max_bytes,
    )
    return data, ARROW_STREAM_MIME, included_rows
