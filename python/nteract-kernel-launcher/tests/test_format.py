"""Tests for the table serialization helpers in ``_format``.

Coverage focus: table-like producers emit Arrow IPC, preserve schema metadata,
and downsample through the same bounded head/slice loop.
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
    pa = pytest.importorskip("pyarrow")
    from nteract_kernel_launcher._format import ARROW_STREAM_MIME, serialize_dataframe

    df = pd.DataFrame({"a": [1, 2, 3], "b": ["x", "y", "z"]})
    data, ct, included_rows = serialize_dataframe(df, max_bytes=10_000_000)
    assert ct == ARROW_STREAM_MIME
    assert included_rows == 3
    table = pa.ipc.open_stream(io.BytesIO(data)).read_all()
    assert table.column_names == ["a", "b"]
    assert table.num_rows == 3


def test_serialize_dataframe_pandas_preserves_index_metadata():
    pd = pytest.importorskip("pandas")
    pa = pytest.importorskip("pyarrow")
    from nteract_kernel_launcher._format import serialize_dataframe

    df = pd.DataFrame({"value": [1, 2]}, index=pd.Index(["x", "y"], name="label"))
    data, _, _ = serialize_dataframe(df, max_bytes=10_000_000)

    table = pa.ipc.open_stream(io.BytesIO(data)).read_all()
    md = table.schema.metadata or {}
    assert b"pandas" in md
    assert "label" in table.column_names


def test_serialize_dataframe_polars_emits_arrow_stream():
    pa = pytest.importorskip("pyarrow")
    pl = pytest.importorskip("polars")
    from nteract_kernel_launcher._format import ARROW_STREAM_MIME, serialize_dataframe

    df = pl.DataFrame({"a": [1, 2, 3], "b": ["x", "y", "z"]})
    data, ct, included_rows = serialize_dataframe(df, max_bytes=10_000_000)

    table = pa.ipc.open_stream(io.BytesIO(data)).read_all()
    assert ct == ARROW_STREAM_MIME
    assert included_rows == 3
    assert table.column_names == ["a", "b"]
    assert table.num_rows == 3


def test_serialize_dataframe_accepts_arrow_pycapsule_stream_protocol():
    pa = pytest.importorskip("pyarrow")
    from nteract_kernel_launcher._format import ARROW_STREAM_MIME, serialize_dataframe

    class StreamOnlyTable:
        def __init__(self, table):
            self._table = table

        def __arrow_c_stream__(self, requested_schema=None):
            return self._table.__arrow_c_stream__(requested_schema)

        def __len__(self):
            return self._table.num_rows

        def head(self, rows):
            return type(self)(self._table.slice(0, rows))

    source = StreamOnlyTable(pa.table({"a": list(range(10))}))
    data, ct, included_rows = serialize_dataframe(source, max_bytes=10_000_000)

    table = pa.ipc.open_stream(io.BytesIO(data)).read_all()
    assert ct == ARROW_STREAM_MIME
    assert included_rows == 10
    assert table.column_names == ["a"]
    assert table.num_rows == 10
