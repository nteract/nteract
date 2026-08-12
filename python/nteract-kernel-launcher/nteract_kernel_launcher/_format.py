"""Arrow stream serialization helpers.

Arrow IPC stream is the canonical rich table payload. Producers that implement
the Arrow PyCapsule stream protocol are imported through ``__arrow_c_stream__``.
The formatter layer handles small streams as one blob and larger streams as an
Arrow manifest with multiple independently decodable stream chunks.
"""

from __future__ import annotations

import datetime as _dt
import hashlib
import logging
import sys
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any

ARROW_STREAM_MIME = "application/vnd.apache.arrow.stream"
ARROW_STREAM_MANIFEST_MIME = "application/vnd.nteract.arrow-stream-manifest+json"
DEFAULT_ARROW_CHUNK_BYTES = 8 * 1024 * 1024

log = logging.getLogger("nteract_kernel_launcher")


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


def build_arrow_stream_summary(
    *,
    total_rows: int | None,
    included_rows: int,
    complete: bool,
    sampled: bool | None = None,
) -> dict[str, Any]:
    """Build row-summary fields, with an explicit sampling override when known."""
    if sampled is None:
        sampled = (total_rows is not None and included_rows != total_rows) or not complete
    return {
        "total_rows": total_rows if total_rows is not None else included_rows,
        "included_rows": included_rows,
        "sampled": sampled,
        "sample_strategy": "none" if complete and not sampled else "head",
    }


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
    if not type(df).__module__.startswith("polars"):
        return df

    schema = getattr(df, "schema", None)
    if not schema or not hasattr(schema, "items"):
        return df

    get_column = getattr(df, "get_column", None)
    with_columns = getattr(df, "with_columns", None)
    if not callable(get_column) or not callable(with_columns):
        return df

    object_columns = [name for name, dtype in schema.items() if str(dtype) == "Object"]
    if not object_columns:
        return df

    date_columns = []
    for name in object_columns:
        try:
            values = get_column(name).drop_nulls().to_list()
        except Exception:
            continue

        if values and all(
            isinstance(value, _dt.date) and not isinstance(value, _dt.datetime) for value in values
        ):
            date_columns.append(name)

    if not date_columns:
        return df

    pl = sys.modules.get("polars")
    if pl is None:
        return df

    date_series = [
        pl.Series(name, get_column(name).to_list(), dtype=pl.Date) for name in date_columns
    ]

    try:
        return with_columns(date_series)
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


def _head_rows_within_bytes(table: Any, *, byte_limit: int, max_rows: int) -> int:
    """Find the largest measured head no larger than ``byte_limit``."""
    low = 0
    high = max(0, min(table.num_rows, max_rows))
    while low < high:
        middle = (low + high + 1) // 2
        if table.slice(0, middle).nbytes <= byte_limit:
            low = middle
        else:
            high = middle - 1
    return low


def _slice_arrow_chunk(
    chunk: Any,
    *,
    row_count: int,
    start_index: int,
    max_chunk_bytes: int,
) -> list[Any]:
    """Re-chunk a decoded head so an aggregate row limit is exact."""
    import pyarrow as pa

    table = pa.ipc.open_stream(pa.BufferReader(chunk.data)).read_all().slice(0, row_count)
    pieces = list(
        iter_arrow_stream_chunks(
            table,
            max_chunk_bytes=max_chunk_bytes,
        )
    )
    return [
        type(piece)(
            index=start_index + offset,
            data=piece.data,
            content_hash=piece.content_hash,
            size=piece.size,
            row_count=piece.row_count,
            record_batch_count=piece.record_batch_count,
        )
        for offset, piece in enumerate(pieces)
    ]


def _collect_arrow_chunks(
    source: Any,
    *,
    bound_stream: bool,
    min_rows: int,
    byte_budget: int,
    max_rows: int,
    max_payload_bytes: int,
) -> tuple[list[Any], bool]:
    """Collect chunks within explicit aggregate row and byte limits."""
    max_chunk_bytes = min(DEFAULT_ARROW_CHUNK_BYTES, max_payload_bytes)
    iterator = iter(
        iter_arrow_stream_chunks(
            source,
            max_chunk_bytes=max_chunk_bytes,
        )
    )
    chunks: list[Any] = []
    included_rows = 0
    included_bytes = 0

    for chunk in iterator:
        if bound_stream:
            next_rows = included_rows + chunk.row_count
            next_bytes = included_bytes + chunk.size
            if next_rows > max_rows:
                remaining_rows = max_rows - included_rows
                if remaining_rows > 0:
                    sliced_chunks = _slice_arrow_chunk(
                        chunk,
                        row_count=remaining_rows,
                        start_index=len(chunks),
                        max_chunk_bytes=max_chunk_bytes,
                    )
                    for sliced_chunk in sliced_chunks:
                        if included_bytes + sliced_chunk.size > max_payload_bytes:
                            return chunks, False
                        chunks.append(sliced_chunk)
                        included_bytes += sliced_chunk.size
                return chunks, False
            over_hard_limit = next_bytes > max_payload_bytes
            over_soft_limit = next_bytes > byte_budget and included_rows >= min_rows
            if over_hard_limit or over_soft_limit:
                return chunks, False
        chunks.append(chunk)
        included_rows += chunk.row_count
        included_bytes += chunk.size

    return chunks, True


def _bounded_arrow_table(
    source: Any,
    *,
    min_rows: int,
    byte_budget: int,
    max_rows: int,
    max_payload_bytes: int,
) -> Any | None:
    """Return a measured, row-clamped Arrow head when ``source`` is sliceable.

    Returns ``None`` when the head cannot be measured, which sends the source
    down the aggregate-bounded streaming path. That path bounds serialized
    chunk size and row count without requiring in-memory measurement.
    ``Table.nbytes`` raises ``ArrowTypeError`` for ``string_view`` columns, the
    layout Polars produces, so this fallback is part of normal operation.
    """
    try:
        import pyarrow as pa
    except Exception:
        return None

    if isinstance(source, pa.RecordBatch):
        source = pa.Table.from_batches([source])
    if not isinstance(source, pa.Table):
        return None

    total_rows = source.num_rows
    if total_rows == 0:
        return source

    try:
        budget_rows = _head_rows_within_bytes(
            source,
            byte_limit=byte_budget,
            max_rows=total_rows,
        )
        # max_rows wins when contradictory limits put it below min_rows.
        clamped_min_rows = min(min_rows, max_rows)
        selected_rows = min(total_rows, max(clamped_min_rows, min(max_rows, budget_rows)))
        selected_rows = _head_rows_within_bytes(
            source,
            byte_limit=max_payload_bytes,
            max_rows=selected_rows,
        )
    except Exception as exc:  # noqa: BLE001
        log.debug("arrow head measurement failed, falling back to stream bounds: %s", exc)
        return None
    return source.slice(0, selected_rows)


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
