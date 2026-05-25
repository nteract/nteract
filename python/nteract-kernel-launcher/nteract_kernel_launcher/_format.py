"""Arrow stream serialization helpers.

Arrow IPC stream is the canonical rich table payload. Producers that implement
the Arrow PyCapsule stream protocol are imported through ``__arrow_c_stream__``.
The formatter layer handles small streams as one blob and larger streams as an
Arrow manifest with multiple independently decodable stream chunks.
"""

from __future__ import annotations

import datetime as _dt
import hashlib
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any

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


def arrow_stream_row_count(obj: Any) -> int | None:
    """Return the best available row count for an Arrow stream producer."""
    return _row_count(obj)


def has_arrow_stream_protocol(obj: Any) -> bool:
    """Return ``True`` when ``obj`` can be consumed as an Arrow stream."""
    if callable(getattr(obj, "__arrow_c_stream__", None)):
        return True
    try:
        import pyarrow as pa

        return isinstance(obj, pa.RecordBatchReader)
    except Exception:
        return False


def _normalize_polars_object_dates(df: Any) -> Any:
    try:
        import polars as pl
    except Exception:
        return df

    schema = getattr(df, "schema", None)
    if not schema:
        return df

    object_columns = [name for name, dtype in schema.items() if dtype == pl.Object]
    if not object_columns:
        return df

    date_exprs = []
    for name in object_columns:
        try:
            values = df.get_column(name).drop_nulls().to_list()
        except Exception:
            continue

        if values and all(
            isinstance(value, _dt.date) and not isinstance(value, _dt.datetime) for value in values
        ):
            date_exprs.append(pl.col(name).map_elements(lambda value: value, return_dtype=pl.Date))

    if not date_exprs:
        return df

    try:
        return df.with_columns(date_exprs)
    except Exception:
        return df


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


def _split_record_batch(batch: Any, *, max_chunk_bytes: int) -> Iterator[Any]:
    batch_rows = getattr(batch, "num_rows", 0)
    if batch_rows <= 1:
        yield batch
        return

    batch_bytes = _record_batch_estimated_bytes(batch)
    if batch_bytes <= max_chunk_bytes:
        yield batch
        return

    bytes_per_row = max(1, batch_bytes // batch_rows)
    rows_per_chunk = max(1, max_chunk_bytes // bytes_per_row)
    for offset in range(0, batch_rows, rows_per_chunk):
        yield batch.slice(offset, min(rows_per_chunk, batch_rows - offset))


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
    record-batch boundaries unless a single batch is itself too large, in which
    case the batch is sliced into smaller Arrow batches before IPC encoding.
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
        if (
            _record_batch_estimated_bytes(batch) > max_chunk_bytes
            and getattr(batch, "num_rows", 0) > 1
        ):
            if batches:
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

            for piece in _split_record_batch(batch, max_chunk_bytes=max_chunk_bytes):
                piece_rows = getattr(piece, "num_rows", 0)
                yield _make_arrow_stream_chunk(
                    index=chunk_index,
                    schema=schema,
                    batches=[piece],
                    row_count=piece_rows,
                )
                chunk_index += 1
            continue

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

    manifest = {
        "version": 1,
        "content_type": ARROW_STREAM_MIME,
        "schema": {
            "hash": hashlib.sha256(schema_bytes).hexdigest(),
            "content_type": "application/vnd.apache.arrow.schema",
            "fields": len(schema),
            "columns": [
                {
                    "name": field.name,
                    "type": str(field.type),
                    "nullable": bool(field.nullable),
                }
                for field in schema
            ],
            "metadata": {
                "pandas": b"pandas" in metadata,
                "huggingface": b"huggingface" in metadata,
            },
        },
        "chunks": [chunk.manifest_entry() for chunk in chunks],
        "complete": complete,
        "summary": summary or {},
    }
    return manifest


def serialize_arrow_stream(source: Any, *, max_bytes: int) -> tuple[bytes, str, int, int]:
    """Serialize an Arrow stream producer into one IPC stream blob.

    Returns ``(bytes, content_type, row_count, record_batch_count)``. Raises
    ``ValueError`` when the stream needs multiple chunks; callers that can emit
    manifests should use :func:`iter_arrow_stream_chunks` instead.
    """
    chunks = list(iter_arrow_stream_chunks(source, max_chunk_bytes=max_bytes))
    if len(chunks) != 1 or chunks[0].size > max_bytes:
        raise ValueError("Arrow stream exceeds max_bytes; chunked manifest is required")
    chunk = chunks[0]
    return chunk.data, ARROW_STREAM_MIME, chunk.row_count, chunk.record_batch_count


def serialize_dataframe(df: Any, *, max_bytes: int) -> tuple[bytes, str, int]:
    """Serialize an Arrow-stream-capable dataframe-like object to Arrow IPC.

    Returns ``(bytes, content_type, included_rows)``. Raises ``ValueError`` for
    objects that do not expose the Arrow stream protocol or that need a chunked
    manifest.
    """
    df = _normalize_polars_object_dates(df)
    if not has_arrow_stream_protocol(df):
        raise ValueError(f"unsupported DataFrame type: {type(df).__module__}.{type(df).__name__}")
    data, content_type, included_rows, _record_batch_count = serialize_arrow_stream(
        df,
        max_bytes=max_bytes,
    )
    return data, content_type, included_rows


def serialize_arrow_table(table: Any, *, max_bytes: int) -> tuple[bytes, str, int]:
    """Serialize an Arrow table-like object to one Arrow IPC stream blob.

    Schema KV metadata (``huggingface``, ``content_defined_chunking``, etc.)
    survives because the stream carries the Arrow schema directly.
    """
    data, content_type, included_rows, _record_batch_count = serialize_arrow_stream(
        table,
        max_bytes=max_bytes,
    )
    return data, content_type, included_rows
