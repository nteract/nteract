"""DataFrame / Arrow serialization (best-available encoder).

Pandas uses pyarrow. Polars uses its native parquet writer.
``pyarrow.Table`` and ``pyarrow.RecordBatch`` emit Arrow IPC
streams, which preserve schema KV metadata (the ``huggingface`` key Sift uses
for rich-type detection is the load-bearing case). If the serialized payload
would exceed ``max_bytes``, the serializer downsamples via ``head(n)`` /
``slice(0, n)`` with a halving loop and the caller advertises the partial-data
state in the ``text/llm+plain`` summary and the ref-MIME ``summary`` hints.
"""

from __future__ import annotations

import io
from collections.abc import Callable
from typing import Any

PARQUET_MIME = "application/vnd.apache.parquet"
ARROW_STREAM_MIME = "application/vnd.apache.arrow.stream"


def _detect_flavor(df: Any) -> str:
    mod = type(df).__module__.split(".")[0]
    return mod if mod in ("pandas", "polars") else "unknown"


def _serialize_pandas(df: Any, rows: int | None = None) -> bytes:
    import pyarrow as pa
    import pyarrow.parquet as pq

    if rows is not None:
        df = df.head(rows)
    table = pa.Table.from_pandas(df, preserve_index=False)
    buf = io.BytesIO()
    pq.write_table(table, buf, compression="snappy")
    return buf.getvalue()


def _serialize_polars(df: Any, rows: int | None = None) -> bytes:
    if rows is not None:
        df = df.head(rows)
    buf = io.BytesIO()
    df.write_parquet(buf, compression="snappy")
    return buf.getvalue()


def _serialize_arrow_stream_table(table: Any, rows: int | None = None) -> bytes:
    import pyarrow as pa

    if rows is not None:
        table = table.slice(0, rows)
    sink = pa.BufferOutputStream()
    with pa.ipc.new_stream(sink, table.schema) as writer:
        writer.write_table(table)
    return sink.getvalue().to_pybytes()


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
    """Serialize ``df`` to parquet; downsample if it would exceed ``max_bytes``.

    Returns ``(bytes, content_type, included_rows)``. Raises ``ValueError`` for
    unsupported DataFrame types.
    """
    flavor = _detect_flavor(df)
    if flavor == "pandas":
        encoder = _serialize_pandas
        n = len(df)
    elif flavor == "polars":
        encoder = _serialize_polars
        n = df.height
    else:
        raise ValueError(f"unsupported DataFrame type: {type(df).__module__}.{type(df).__name__}")

    data, included_rows = _downsample_loop(
        lambda rows=None: encoder(df, rows=rows), n, max_bytes=max_bytes
    )
    return data, PARQUET_MIME, included_rows


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
