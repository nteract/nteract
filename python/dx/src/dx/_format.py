"""Arrow stream serialization for legacy ``dx`` display enrichment.

The nteract kernel launcher owns the active bootstrap path. ``dx`` keeps this
small compatibility copy so direct ``dx.install()`` users follow the same
object protocol: if an object exposes ``__arrow_c_stream__``, serialize that
Arrow stream instead of branching on pandas, polars, or wrapper types.
"""

from __future__ import annotations

import hashlib
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any

ARROW_STREAM_MIME = "application/vnd.apache.arrow.stream"
ARROW_STREAM_MANIFEST_MIME = "application/vnd.nteract.arrow-stream-manifest+json"
DEFAULT_ARROW_CHUNK_BYTES = 8 * 1024 * 1024


@dataclass(frozen=True)
class ArrowStreamChunk:
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


def row_count(obj: Any) -> int | None:
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


def has_arrow_stream_protocol(obj: Any) -> bool:
    if callable(getattr(obj, "__arrow_c_stream__", None)):
        return True
    try:
        import pyarrow as pa

        return isinstance(obj, pa.RecordBatchReader)
    except Exception:
        return False


def _record_batch_reader_from_stream(source: Any) -> Any:
    import pyarrow as pa

    from_stream = getattr(pa.RecordBatchReader, "from_stream", None)
    if callable(from_stream):
        return from_stream(source)

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
    if max_chunk_bytes <= 0:
        raise ValueError("max_chunk_bytes must be positive")

    reader = _record_batch_reader_from_stream(source)
    schema = reader.schema
    chunk_index = 0
    batches: list[Any] = []
    rows = 0
    estimated_bytes = 0

    for batch in reader:
        batch_bytes = _record_batch_estimated_bytes(batch)
        if batch_bytes > max_chunk_bytes and getattr(batch, "num_rows", 0) > 1:
            if batches:
                yield _make_arrow_stream_chunk(
                    index=chunk_index,
                    schema=schema,
                    batches=batches,
                    row_count=rows,
                )
                chunk_index += 1
                batches = []
                rows = 0
                estimated_bytes = 0

            for piece in _split_record_batch(batch, max_chunk_bytes=max_chunk_bytes):
                yield _make_arrow_stream_chunk(
                    index=chunk_index,
                    schema=schema,
                    batches=[piece],
                    row_count=getattr(piece, "num_rows", 0),
                )
                chunk_index += 1
            continue

        batch_rows = getattr(batch, "num_rows", 0)
        if batches and estimated_bytes + batch_bytes > max_chunk_bytes:
            yield _make_arrow_stream_chunk(
                index=chunk_index,
                schema=schema,
                batches=batches,
                row_count=rows,
            )
            chunk_index += 1
            batches = []
            rows = 0
            estimated_bytes = 0

        batches.append(batch)
        rows += batch_rows
        estimated_bytes += batch_bytes

    if batches or chunk_index == 0:
        yield _make_arrow_stream_chunk(
            index=chunk_index,
            schema=schema,
            batches=batches,
            row_count=rows,
        )


def serialize_arrow_stream(source: Any, *, max_bytes: int) -> tuple[bytes, str, int, int]:
    """Serialize one Arrow-stream-capable object into a single IPC blob."""
    if not has_arrow_stream_protocol(source):
        raise ValueError(
            f"unsupported DataFrame type: {type(source).__module__}.{type(source).__name__}"
        )

    chunks = list(iter_arrow_stream_chunks(source, max_chunk_bytes=max_bytes))
    if len(chunks) != 1 or chunks[0].size > max_bytes:
        raise ValueError("Arrow stream exceeds max_bytes; chunked manifest is required")
    chunk = chunks[0]
    return chunk.data, ARROW_STREAM_MIME, chunk.row_count, chunk.record_batch_count


def serialize_dataframe(df: Any, *, max_bytes: int) -> tuple[bytes, str, int]:
    data, content_type, included_rows, _record_batch_count = serialize_arrow_stream(
        df,
        max_bytes=max_bytes,
    )
    return data, content_type, included_rows


def build_arrow_stream_manifest_from_chunks(
    chunks: list[ArrowStreamChunk],
    *,
    complete: bool,
    summary: dict[str, Any] | None = None,
    schema: Any | None = None,
) -> dict[str, Any]:
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
