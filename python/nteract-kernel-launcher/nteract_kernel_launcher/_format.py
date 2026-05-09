"""DataFrame / Arrow → parquet serialization (best-available encoder).

Pandas uses pyarrow (or fastparquet as a fallback). Polars uses its native
parquet writer. ``pyarrow.Table`` and ``pyarrow.RecordBatch`` round-trip
through ``pq.write_table``, which preserves schema KV metadata (the
``huggingface`` key Sift uses for rich-type detection on HF parquets is
the load-bearing case). If the serialized payload would exceed
``max_bytes``, the serializer downsamples via ``head(n)`` / ``slice(0, n)``
with a halving loop and the caller advertises the partial-data state in
the ``text/llm+plain`` summary and the ref-MIME ``summary`` hints.
"""

from __future__ import annotations

import io
from collections.abc import Callable
from typing import Any

PARQUET_MIME = "application/vnd.apache.parquet"


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


def _serialize_arrow_table(table: Any, rows: int | None = None) -> bytes:
    import pyarrow.parquet as pq

    if rows is not None:
        table = table.slice(0, rows)
    buf = io.BytesIO()
    pq.write_table(table, buf, compression="snappy")
    return buf.getvalue()


def _downsample_loop(encode: Callable[..., bytes], total_rows: int, *, max_bytes: int) -> bytes:
    """Encode at full size; if too big, halve target rows up to four rounds.

    Parquet compression is non-linear in row count, so the first guess
    (``rows * max_bytes / full_bytes``) tends to overshoot. Halving from
    there converges quickly; bottoming out at one row keeps this from
    raising for sampling.
    """
    full = encode()
    if len(full) <= max_bytes:
        return full
    if total_rows <= 1:
        return full
    target_rows = max(1, int(total_rows * (max_bytes / len(full))))
    for _ in range(4):
        sampled = encode(rows=target_rows)
        if len(sampled) <= max_bytes:
            return sampled
        target_rows = max(1, target_rows // 2)
    return encode(rows=1)


def serialize_dataframe(df: Any, *, max_bytes: int) -> tuple[bytes, str]:
    """Serialize ``df`` to parquet; downsample if it would exceed ``max_bytes``.

    Returns ``(bytes, content_type)``. Raises ``ValueError`` for unsupported
    DataFrame types.
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

    return _downsample_loop(
        lambda rows=None: encoder(df, rows=rows), n, max_bytes=max_bytes
    ), PARQUET_MIME


def serialize_arrow_table(table: Any, *, max_bytes: int) -> tuple[bytes, str]:
    """Serialize ``pa.Table`` to parquet, preserving schema KV metadata.

    Same downsample semantics as :func:`serialize_dataframe`. Schema KV
    metadata (``ARROW:schema``, ``huggingface``, ``content_defined_chunking``,
    etc.) survives the round-trip because ``pq.write_table`` writes whatever
    the table's schema carries. ``pa.Table.from_pandas`` does *not* survive
    KV metadata, so the dataframe path can't replace this one.
    """
    return _downsample_loop(
        lambda rows=None: _serialize_arrow_table(table, rows=rows),
        table.num_rows,
        max_bytes=max_bytes,
    ), PARQUET_MIME
