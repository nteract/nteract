"""Tests for progressive Arrow stream display helpers."""

from __future__ import annotations

import io

import pytest


def test_display_arrow_stream_publishes_manifest_revisions():
    pa = pytest.importorskip("pyarrow")
    from nteract_kernel_launcher import _buffer_hook
    from nteract_kernel_launcher._format import ARROW_STREAM_MANIFEST_MIME
    from nteract_kernel_launcher._progressive import display_arrow_stream
    from nteract_kernel_launcher._refs import BLOB_REF_MIME

    messages = []

    class Handle:
        def update(self, obj, **kwargs):
            messages.append(("update", obj, kwargs))

    def fake_display(obj, **kwargs):
        messages.append(("display", obj, kwargs))
        return Handle()

    _buffer_hook.pending_buffers().clear()
    table = pa.table({"a": list(range(6))})
    batches = table.to_batches(max_chunksize=2)
    reader = pa.RecordBatchReader.from_batches(table.schema, batches)
    max_chunk_bytes = max(batch.nbytes for batch in batches)

    handle = display_arrow_stream(
        reader,
        display_fn=fake_display,
        max_chunk_bytes=max_chunk_bytes,
        total_rows=table.num_rows,
    )

    assert isinstance(handle, Handle)
    assert [kind for kind, _, _ in messages] == ["display", "update", "update", "update"]
    assert messages[0][2] == {"raw": True, "display_id": True}
    assert messages[1][2] == {"raw": True}

    manifests = [message[1][ARROW_STREAM_MANIFEST_MIME] for message in messages]
    assert [len(manifest["chunks"]) for manifest in manifests] == [1, 2, 3, 3]
    assert [manifest["complete"] for manifest in manifests] == [False, False, False, True]
    assert [message[1]["text/llm+plain"] for message in messages] == [
        "Arrow stream table: 2 of 6 rows loaded",
        "Arrow stream table: 4 of 6 rows loaded",
        "Arrow stream table: 6 of 6 rows loaded",
        "Arrow stream table: 6 rows",
    ]
    assert all("llm" not in manifest for manifest in manifests)
    assert BLOB_REF_MIME not in messages[-1][1]
    assert manifests[-1]["summary"] == {
        "total_rows": 6,
        "included_rows": 6,
        "sampled": False,
        "sample_strategy": "none",
    }

    first_hash = messages[0][1][BLOB_REF_MIME]["hash"]
    assert first_hash in _buffer_hook.pending_buffers()
    decoded = pa.ipc.open_stream(io.BytesIO(_buffer_hook.pending_buffers()[first_hash])).read_all()
    assert decoded.num_rows == 2


def test_display_arrow_stream_single_chunk_publishes_complete_once():
    pa = pytest.importorskip("pyarrow")
    from nteract_kernel_launcher._format import ARROW_STREAM_MANIFEST_MIME
    from nteract_kernel_launcher._progressive import display_arrow_stream
    from nteract_kernel_launcher._refs import BLOB_REF_MIME

    messages = []

    class Handle:
        def update(self, obj, **kwargs):
            messages.append(("update", obj, kwargs))

    def fake_display(obj, **kwargs):
        messages.append(("display", obj, kwargs))
        return Handle()

    table = pa.table({"a": list(range(3))})
    batches = table.to_batches()
    reader = pa.RecordBatchReader.from_batches(table.schema, batches)
    max_chunk_bytes = max(batch.nbytes for batch in batches)

    display_arrow_stream(
        reader,
        display_fn=fake_display,
        max_chunk_bytes=max_chunk_bytes,
        total_rows=3,
    )

    assert [kind for kind, _, _ in messages] == ["display"]
    assert BLOB_REF_MIME in messages[0][1]
    manifest = messages[0][1][ARROW_STREAM_MANIFEST_MIME]
    assert manifest["complete"] is True
    assert len(manifest["chunks"]) == 1
    assert manifest["summary"] == {
        "total_rows": 3,
        "included_rows": 3,
        "sampled": False,
        "sample_strategy": "none",
    }
    assert messages[0][1]["text/llm+plain"] == "Arrow stream table: 3 rows"
    assert "llm" not in manifest


def test_display_arrow_stream_is_exported_from_package():
    import nteract_kernel_launcher

    assert callable(nteract_kernel_launcher.display_arrow_stream)
