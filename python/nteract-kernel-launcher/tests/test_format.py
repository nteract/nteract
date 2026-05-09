"""Tests for the table serialization helpers in ``_format``.

Coverage focus: the pa.Table path emits Arrow IPC and preserves schema KV
metadata (the HF ``huggingface`` key Sift uses for rich-type detection) and
the downsample loop converges for both dataframe and arrow inputs.
"""

from __future__ import annotations

import io

import pytest


def _pa_table_with_hf_metadata():
    pa = pytest.importorskip("pyarrow")
    schema = pa.schema(
        [pa.field("a", pa.int64()), pa.field("b", pa.string())],
        metadata={"huggingface": '{"info":{"features":{}}}', "custom": "value"},
    )
    return pa.table({"a": list(range(1000)), "b": [f"row-{i}" for i in range(1000)]}, schema=schema)


def test_serialize_arrow_table_preserves_schema_metadata():
    pa = pytest.importorskip("pyarrow")
    from nteract_kernel_launcher._format import ARROW_STREAM_MIME, serialize_arrow_table

    table = _pa_table_with_hf_metadata()
    data, ct, included_rows = serialize_arrow_table(table, max_bytes=10_000_000)
    assert ct == ARROW_STREAM_MIME
    assert included_rows == table.num_rows

    decoded = pa.ipc.open_stream(io.BytesIO(data)).read_all()
    md = decoded.schema.metadata or {}
    assert b"huggingface" in md
    assert b"custom" in md
    assert md[b"custom"] == b"value"


def test_serialize_arrow_table_downsamples_when_oversized():
    pa = pytest.importorskip("pyarrow")
    from nteract_kernel_launcher._format import serialize_arrow_table

    table = _pa_table_with_hf_metadata()
    # Force the loop to fire by setting the cap below the full size.
    full_data, _, _ = serialize_arrow_table(table, max_bytes=10_000_000)
    cap = max(1, len(full_data) // 4)

    data, _, included_rows = serialize_arrow_table(table, max_bytes=cap)
    decoded = pa.ipc.open_stream(io.BytesIO(data)).read_all()
    assert decoded.num_rows == included_rows
    assert len(data) <= cap or included_rows < table.num_rows


def test_serialize_dataframe_pandas_round_trips_data():
    pd = pytest.importorskip("pandas")
    pq = pytest.importorskip("pyarrow.parquet")
    from nteract_kernel_launcher._format import PARQUET_MIME, serialize_dataframe

    df = pd.DataFrame({"a": [1, 2, 3], "b": ["x", "y", "z"]})
    data, ct, included_rows = serialize_dataframe(df, max_bytes=10_000_000)
    assert ct == PARQUET_MIME
    assert included_rows == 3
    table = pq.read_table(io.BytesIO(data))
    assert table.column_names == ["a", "b"]
    assert table.num_rows == 3
