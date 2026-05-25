"""Tests for the table serialization helpers in ``_format``.

Coverage focus: table-like producers emit Arrow IPC, preserve schema metadata,
and expose chunked manifests when one blob would be too large.
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


def test_serialize_arrow_table_requires_manifest_when_oversized():
    pytest.importorskip("pyarrow")
    from nteract_kernel_launcher._format import serialize_arrow_table

    table = _pa_table_with_hf_metadata()
    full_data, _, _ = serialize_arrow_table(table, max_bytes=10_000_000)
    cap = max(1, len(full_data) // 4)

    with pytest.raises(ValueError, match="chunked manifest is required"):
        serialize_arrow_table(table, max_bytes=cap)


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
    import nteract_kernel_launcher._format as fmt

    df = pd.DataFrame({"value": [1, 2]}, index=pd.Index(["x", "y"], name="label"))
    data, _, _ = fmt.serialize_dataframe(df, max_bytes=10_000_000)

    table = pa.ipc.open_stream(io.BytesIO(data)).read_all()
    md = table.schema.metadata or {}
    assert b"pandas" in md
    assert "label" in table.column_names


def test_serialize_dataframe_pandas_uses_arrow_stream_protocol(monkeypatch):
    pd = pytest.importorskip("pandas")
    import nteract_kernel_launcher._format as fmt

    calls = 0
    original = fmt._record_batch_reader_from_stream

    def spy(source):
        nonlocal calls
        calls += 1
        return original(source)

    monkeypatch.setattr(fmt, "_record_batch_reader_from_stream", spy)

    data, ct, included_rows = fmt.serialize_dataframe(
        pd.DataFrame({"a": [1, 2, 3]}),
        max_bytes=10_000_000,
    )

    assert ct == fmt.ARROW_STREAM_MIME
    assert included_rows == 3
    assert data
    assert calls == 1


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


def test_serialize_dataframe_polars_object_dates_emit_arrow_date32():
    import datetime as dt

    np = pytest.importorskip("numpy")
    pa = pytest.importorskip("pyarrow")
    pl = pytest.importorskip("polars")
    from nteract_kernel_launcher._format import serialize_dataframe

    date_options = [
        dt.date(1997, 1, 10),
        dt.date(1985, 2, 15),
        dt.date(1983, 3, 22),
        dt.date(1981, 4, 30),
    ]
    birthdates = np.random.default_rng(0).choice(date_options, size=8)
    df = pl.DataFrame({"birthdate": birthdates})
    assert df.schema["birthdate"] == pl.Object

    data, _, _ = serialize_dataframe(df, max_bytes=10_000_000)

    table = pa.ipc.open_stream(io.BytesIO(data)).read_all()
    assert table.schema.field("birthdate").type == pa.date32()
    assert table.to_pydict()["birthdate"] == list(birthdates)


def test_serialize_dataframe_polars_uses_arrow_stream_protocol(monkeypatch):
    pl = pytest.importorskip("polars")
    import nteract_kernel_launcher._format as fmt

    calls = 0
    original = fmt._record_batch_reader_from_stream

    def spy(source):
        nonlocal calls
        calls += 1
        return original(source)

    monkeypatch.setattr(fmt, "_record_batch_reader_from_stream", spy)

    data, ct, included_rows = fmt.serialize_dataframe(
        pl.DataFrame({"a": [1, 2, 3]}),
        max_bytes=10_000_000,
    )

    assert ct == fmt.ARROW_STREAM_MIME
    assert included_rows == 3
    assert data
    assert calls == 1


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


def test_serialize_dataframe_rejects_oversized_generic_pycapsule_stream():
    pa = pytest.importorskip("pyarrow")
    from nteract_kernel_launcher._format import serialize_dataframe

    class SinglePassStream:
        def __init__(self):
            self._used = False
            self._table = pa.table({"a": list(range(100))})

        def __arrow_c_stream__(self, requested_schema=None):
            if self._used:
                raise RuntimeError("stream already consumed")
            self._used = True
            return self._table.__arrow_c_stream__(requested_schema)

        def __len__(self):
            return self._table.num_rows

    with pytest.raises(ValueError, match="chunked manifest is required"):
        serialize_dataframe(SinglePassStream(), max_bytes=1)


def test_serialize_arrow_table_uses_arrow_stream_protocol(monkeypatch):
    pa = pytest.importorskip("pyarrow")
    import nteract_kernel_launcher._format as fmt

    calls = 0
    original = fmt._record_batch_reader_from_stream

    def spy(source):
        nonlocal calls
        calls += 1
        return original(source)

    monkeypatch.setattr(fmt, "_record_batch_reader_from_stream", spy)

    data, ct, included_rows = fmt.serialize_arrow_table(
        pa.table({"a": [1, 2, 3]}),
        max_bytes=10_000_000,
    )

    table = pa.ipc.open_stream(io.BytesIO(data)).read_all()
    assert ct == fmt.ARROW_STREAM_MIME
    assert included_rows == 3
    assert table.num_rows == 3
    assert calls == 1


def test_build_arrow_stream_manifest_describes_one_chunk():
    pa = pytest.importorskip("pyarrow")
    from nteract_kernel_launcher._format import (
        ARROW_STREAM_MANIFEST_MIME,
        ARROW_STREAM_MIME,
        build_arrow_stream_manifest,
    )

    table = pa.table({"a": [1, 2, 3]})
    sink = pa.BufferOutputStream()
    with pa.ipc.new_stream(sink, table.schema) as writer:
        writer.write_table(table)
    data = sink.getvalue().to_pybytes()

    manifest = build_arrow_stream_manifest(
        data,
        content_hash="abc123",
        content_size=len(data),
        row_count=3,
        record_batch_count=1,
        summary={"total_rows": 3, "included_rows": 3},
    )

    assert ARROW_STREAM_MANIFEST_MIME == "application/vnd.nteract.arrow-stream-manifest+json"
    assert manifest["content_type"] == ARROW_STREAM_MIME
    assert manifest["complete"] is True
    assert manifest["schema"]["fields"] == 1
    assert manifest["schema"]["columns"] == [{"name": "a", "type": "int64", "nullable": True}]
    assert manifest["schema"]["content_type"] == "application/vnd.apache.arrow.schema"
    assert manifest["chunks"] == [
        {
            "index": 0,
            "hash": "abc123",
            "size": len(data),
            "row_count": 3,
            "record_batch_count": 1,
            "encoding": "arrow-ipc-stream",
        }
    ]


def test_iter_arrow_stream_chunks_yields_decodable_mini_streams():
    pa = pytest.importorskip("pyarrow")
    from nteract_kernel_launcher._format import iter_arrow_stream_chunks

    table = pa.table({"a": list(range(6)), "b": [f"row-{i}" for i in range(6)]})
    reader = pa.RecordBatchReader.from_batches(table.schema, table.to_batches(max_chunksize=2))

    chunks = list(iter_arrow_stream_chunks(reader, max_chunk_bytes=1))

    assert [chunk.index for chunk in chunks] == list(range(len(chunks)))
    assert sum(chunk.row_count for chunk in chunks) == 6
    assert [chunk.record_batch_count for chunk in chunks] == [1] * len(chunks)
    decoded = [pa.ipc.open_stream(io.BytesIO(chunk.data)).read_all() for chunk in chunks]
    assert sum(part.num_rows for part in decoded) == 6
    assert [part.column_names for part in decoded] == [["a", "b"]] * len(chunks)
    assert [chunk.manifest_entry()["hash"] for chunk in chunks] == [
        chunk.content_hash for chunk in chunks
    ]


def test_iter_arrow_stream_chunks_preserves_schema_metadata():
    pa = pytest.importorskip("pyarrow")
    from nteract_kernel_launcher._format import iter_arrow_stream_chunks

    table = _pa_table_with_hf_metadata()
    reader = pa.RecordBatchReader.from_batches(table.schema, table.to_batches(max_chunksize=500))

    chunks = list(iter_arrow_stream_chunks(reader, max_chunk_bytes=1))

    assert len(chunks) > 2
    assert sum(chunk.row_count for chunk in chunks) == table.num_rows
    for chunk in chunks:
        decoded = pa.ipc.open_stream(io.BytesIO(chunk.data)).read_all()
        md = decoded.schema.metadata or {}
        assert b"huggingface" in md
        assert md[b"custom"] == b"value"


def test_iter_arrow_stream_chunks_consumes_pycapsule_stream_once():
    pa = pytest.importorskip("pyarrow")
    from nteract_kernel_launcher._format import iter_arrow_stream_chunks

    class SinglePassStream:
        def __init__(self):
            self._used = False
            self._table = pa.table({"a": list(range(4))})

        def __arrow_c_stream__(self, requested_schema=None):
            if self._used:
                raise RuntimeError("stream already consumed")
            self._used = True
            return self._table.__arrow_c_stream__(requested_schema)

    source = SinglePassStream()
    chunks = list(iter_arrow_stream_chunks(source, max_chunk_bytes=1))

    assert len(chunks) == 4
    assert sum(chunk.row_count for chunk in chunks) == 4
    assert source._used is True


def test_iter_arrow_stream_chunks_emits_empty_stream_for_empty_reader():
    pa = pytest.importorskip("pyarrow")
    from nteract_kernel_launcher._format import iter_arrow_stream_chunks

    schema = pa.schema([pa.field("a", pa.int64())])
    reader = pa.RecordBatchReader.from_batches(schema, [])

    chunks = list(iter_arrow_stream_chunks(reader))

    assert len(chunks) == 1
    assert chunks[0].row_count == 0
    assert chunks[0].record_batch_count == 0
    decoded = pa.ipc.open_stream(io.BytesIO(chunks[0].data)).read_all()
    assert decoded.schema == schema
    assert decoded.num_rows == 0
