import io

import pandas as pd
import pytest
from dx._format import ARROW_STREAM_MIME, iter_arrow_stream_chunks, serialize_dataframe


def test_serialize_pandas_to_arrow_stream():
    df = pd.DataFrame({"a": [1, 2, 3], "b": ["x", "y", "z"]})
    data, content_type, included_rows = serialize_dataframe(df, max_bytes=10_000_000)
    assert content_type == ARROW_STREAM_MIME
    assert included_rows == 3
    assert isinstance(data, bytes)


def test_serialize_pandas_round_trip():
    import pyarrow as pa

    df = pd.DataFrame({"a": [1, 2, 3]})
    data, _, _ = serialize_dataframe(df, max_bytes=10_000_000)
    table = pa.ipc.open_stream(io.BytesIO(data)).read_all()
    assert table.column("a").to_pylist() == [1, 2, 3]


def test_iter_arrow_stream_chunks_when_oversized():
    big = pd.DataFrame({"a": list(range(200_000))})
    chunks = list(iter_arrow_stream_chunks(big, max_chunk_bytes=2_000))
    assert len(chunks) > 1
    assert sum(chunk.row_count for chunk in chunks) == len(big)


def test_serialize_polars_when_available():
    import pyarrow as pa

    pl = pytest.importorskip("polars")
    df = pl.DataFrame({"a": [1, 2, 3]})
    data, content_type, included_rows = serialize_dataframe(df, max_bytes=10_000_000)
    assert content_type == ARROW_STREAM_MIME
    assert included_rows == 3
    table = pa.ipc.open_stream(io.BytesIO(data)).read_all()
    assert table.column("a").to_pylist() == [1, 2, 3]


def test_serialize_rejects_unsupported():
    with pytest.raises(ValueError):
        serialize_dataframe([1, 2, 3], max_bytes=10_000)
