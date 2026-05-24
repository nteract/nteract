"""Integration tests for nteract/dx — end-to-end via the dev daemon.

Verifies that `dx.display(df)` rides the ``display_data`` + IOPub ``buffers``
path (not the legacy raw-bytes-in-JSON path):

- The kernel publishes one ``display_data`` whose wire envelope carries a
  trailing ZMQ buffer frame with Arrow IPC stream bytes.
- The runtime agent writes the buffer to the blob store via
  ``preflight_ref_buffers`` and composes a ``ContentRef::Blob`` under
  ``application/vnd.apache.arrow.stream`` (the ``BLOB_REF_MIME`` entry is
  consumed, never emitted as a manifest entry).
- The resolved cell output surfaces Arrow stream bytes or an Arrow stream
  manifest with chunk refs, plus the Python-side ``text/llm+plain`` summary.

Running locally (with dev daemon already running):
    .venv/bin/python -m pytest python/runtimed/tests/test_dx_integration.py -v

Running in CI (spawns its own daemon):
    RUNTIMED_INTEGRATION_TEST=1 .venv/bin/python -m pytest \
        python/runtimed/tests/test_dx_integration.py -v

The test runs against the repo-root workspace venv (``.venv``) so both
``runtimed`` and ``dx`` are importable in the kernel from their workspace
installs — no ``sys.path`` gymnastics. Once dx ships on PyPI, the kernel
bootstrap will install it into managed environments directly and this
test no longer needs anything special.
"""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

import pytest

# Skip entire module if the runtimed Python bindings aren't built.
pytest.importorskip("runtimed")
# Skip if dx isn't installed in the venv — tells the user how to fix it.
pytest.importorskip(
    "dx",
    reason="dx not in the workspace venv; run `uv sync` from repo root",
)

# Re-use the daemon + client + session fixtures from the main integration
# module. Both files live in the same tests/ directory; add it to sys.path
# so the shared fixtures are importable.
sys.path.insert(0, str(Path(__file__).parent))

from test_daemon_integration import (  # noqa: E402, F401, F811
    async_create_cell_and_wait_for_sync,
    async_start_kernel_with_retry,
    client,
    daemon_health_check,
    daemon_process,
    session,
)

_BOOTSTRAP = "import dx\ndx.install()\n"
ARROW_STREAM_MIME = "application/vnd.apache.arrow.stream"
ARROW_STREAM_MANIFEST_MIME = "application/vnd.nteract.arrow-stream-manifest+json"
BLOB_REF_MIME = "application/vnd.nteract.blob-ref+json"


def _read_arrow_table(data: bytes):
    import pyarrow as pa

    return pa.ipc.open_stream(pa.BufferReader(bytes(data))).read_all()


def _arrow_manifest(data: dict) -> dict:
    raw = data[ARROW_STREAM_MANIFEST_MIME]
    if isinstance(raw, str):
        return json.loads(raw)
    assert isinstance(raw, dict), type(raw).__name__
    return raw


@pytest.mark.integration
async def test_dx_display_emits_blob_ref_with_buffers(session):  # noqa: F811
    """`dx.display(df)` produces a display_data whose Arrow stream resolves
    to content matching the Python-side SHA-256 — proof the bytes rode the
    IOPub buffer frame and the agent stored them in the blob store."""
    await async_start_kernel_with_retry(session, env_source="uv:pyproject")

    # Bootstrap dx in the kernel — install formatters and open the session
    # helpers. No notebook dependency on dx (it's added to sys.path at runtime).
    bootstrap_id = await async_create_cell_and_wait_for_sync(session, _BOOTSTRAP)
    bootstrap_result = await session.execute_cell(bootstrap_id)
    assert bootstrap_result.success, f"dx bootstrap failed: {bootstrap_result.error}"

    # Emit a DataFrame. Bare `df` on the last line triggers dx's
    # `ipython_display_formatter` — it serializes, hashes, and publishes a
    # display_data via kernel.session.send with buffers=[arrow_stream].
    display_id = await async_create_cell_and_wait_for_sync(
        session,
        """
import pandas as pd
df = pd.DataFrame({"a": [1, 2, 3], "b": ["x", "y", "z"]})
df
""",
    )
    result = await session.execute_cell(display_id)
    assert result.success, f"display cell failed: {result.error}"

    # Exactly one display_data output — dx claims display so IPython skips
    # every other formatter (no duplicate HTML/plain).
    assert len(result.display_data) == 1, (
        f"expected one display_data, got {len(result.display_data)}: "
        f"{[o.data.keys() for o in result.display_data]}"
    )
    display = result.display_data[0]

    # The ref MIME is a transport detail — consumed by the agent, never in
    # the resolved manifest.
    assert BLOB_REF_MIME not in display.data, (
        "BLOB_REF_MIME leaked into the inline manifest — the ref-MIME branch "
        "in create_manifest should have consumed it."
    )

    # Arrow stream bytes — resolved from the blob store by the Python bindings.
    assert ARROW_STREAM_MIME in display.data, (
        f"Arrow stream MIME missing. keys: {list(display.data.keys())}"
    )
    arrow_bytes = display.data[ARROW_STREAM_MIME]
    assert isinstance(arrow_bytes, (bytes, bytearray)), (
        f"expected Arrow stream bytes, got {type(arrow_bytes).__name__}"
    )

    # Python-side llm summary.
    assert "text/llm+plain" in display.data, (
        f"Python-generated text/llm+plain missing. keys: {list(display.data.keys())}"
    )
    llm = display.data["text/llm+plain"]
    assert isinstance(llm, str)
    assert "3 rows" in llm
    assert "2 columns" in llm
    # Python-generated summary, not repr-llm — distinctive header format.
    assert llm.startswith("DataFrame (pandas)"), llm

    # Content-addressed round-trip: the Arrow stream we read back from the blob
    # store hashes to the same digest the kernel computed before uploading.
    # This proves the bytes we got are the exact bytes that rode the IOPub
    # buffer frame, not something re-encoded server-side.
    computed = hashlib.sha256(bytes(arrow_bytes)).hexdigest()

    # Use pyarrow to round-trip the stream and confirm row count matches —
    # extra sanity that what we got back is the DataFrame the kernel serialized.
    table = _read_arrow_table(bytes(arrow_bytes))
    assert table.num_rows == 3
    assert set(table.column_names) == {"a", "b"}
    manifest = _arrow_manifest(display.data)
    assert manifest["content_type"] == ARROW_STREAM_MIME
    assert manifest["chunks"][0]["hash"] == computed
    assert manifest["chunks"][0]["row_count"] == 3
    # sanity: the hash we computed is a valid hex sha256 (64 hex chars).
    assert len(computed) == 64 and all(c in "0123456789abcdef" for c in computed)


@pytest.mark.integration
async def test_dx_display_large_df_emits_chunked_arrow_manifest(session):  # noqa: F811
    """When the serialized payload would exceed the per-message ceiling,
    dx emits a multi-chunk Arrow stream manifest whose chunks ride attached
    IOPub buffers and are stored as blob refs."""
    await async_start_kernel_with_retry(session, env_source="uv:pyproject")

    bootstrap_id = await async_create_cell_and_wait_for_sync(session, _BOOTSTRAP)
    assert (await session.execute_cell(bootstrap_id)).success

    # Force chunking via a low DX_MAX_PAYLOAD_BYTES. The payload is large
    # enough to split, but small enough to keep the integration test quick.
    row_count = 10_000
    display_id = await async_create_cell_and_wait_for_sync(
        session,
        f"""
import os, importlib
os.environ["DX_MAX_PAYLOAD_BYTES"] = "4096"
# re-import so _format_install picks up the env
import dx._format_install as _fi
importlib.reload(_fi)

import pandas as pd
big = pd.DataFrame({{"i": list(range({row_count}))}})
big
""",
    )
    result = await session.execute_cell(display_id)
    assert result.success

    assert len(result.display_data) == 1
    display = result.display_data[0]

    assert ARROW_STREAM_MIME not in display.data, (
        "multi-chunk tables should resolve through the manifest rather than "
        "a single direct Arrow stream blob"
    )
    manifest = _arrow_manifest(display.data)
    assert manifest["content_type"] == ARROW_STREAM_MIME
    assert len(manifest["chunks"]) > 1
    assert sum(chunk["row_count"] for chunk in manifest["chunks"]) == row_count
    assert manifest["summary"]["total_rows"] == row_count
    assert manifest["summary"]["included_rows"] == row_count
    assert manifest["summary"]["sampled"] is False

    llm = display.data["text/llm+plain"]
    assert "10,000" in llm, f"summary did not include total row count: {llm!r}"


@pytest.mark.integration
async def test_dx_polars_display_emits_blob_ref_with_buffers(session):  # noqa: F811
    """Same content-addressed round-trip as the pandas test, but exercising
    a polars object through the shared Arrow stream protocol.

    Skipped if polars isn't installed — dx ships with polars as an optional
    extra (`dx[polars]`), and minimal environments may not have it.
    """
    pytest.importorskip("polars")
    await async_start_kernel_with_retry(session, env_source="uv:pyproject")

    bootstrap_id = await async_create_cell_and_wait_for_sync(session, _BOOTSTRAP)
    assert (await session.execute_cell(bootstrap_id)).success

    display_id = await async_create_cell_and_wait_for_sync(
        session,
        """
import polars as pl
df = pl.DataFrame({"a": [1, 2, 3], "b": ["x", "y", "z"]})
df
""",
    )
    result = await session.execute_cell(display_id)
    assert result.success, f"polars display failed: {result.error}"

    rich_outputs = [
        o for o in result.outputs if o.output_type in ("display_data", "execute_result")
    ]
    assert len(rich_outputs) == 1, (
        f"expected one rich output, got {len(rich_outputs)}: "
        f"{[(o.output_type, list(o.data.keys())) for o in rich_outputs]}"
    )
    output = rich_outputs[0]
    # As of #1780 last-expression DataFrames flow through display_data.
    assert output.output_type == "display_data"

    # The transport ref MIME is consumed by the agent, never surfaces.
    assert BLOB_REF_MIME not in output.data, (
        "BLOB_REF_MIME leaked into the inline manifest — the ref-MIME branch "
        "in create_manifest should have consumed it."
    )

    # Arrow stream bytes resolved from the blob store.
    arrow_bytes = output.data.get(ARROW_STREAM_MIME)
    assert arrow_bytes is not None, (
        f"Arrow stream MIME missing — stream protocol may not have run. "
        f"keys: {list(output.data.keys())}"
    )
    assert isinstance(arrow_bytes, (bytes, bytearray))

    # Python-side llm summary identifies polars specifically.
    llm = output.data.get("text/llm+plain", "")
    assert llm.startswith("DataFrame (polars)"), f"expected polars summary, got: {llm[:80]!r}"

    # Round-trip via pyarrow to verify the bytes are a valid Arrow stream AND
    # contain the columns we sent.
    table = _read_arrow_table(bytes(arrow_bytes))
    assert table.num_rows == 3
    assert set(table.column_names) == {"a", "b"}


@pytest.mark.integration
async def test_dx_polars_last_expression_uses_arrow_stream_protocol(session):  # noqa: F811
    """Belt-and-suspenders for the polars path: confirm the payload is an
    Arrow stream and the manifest keeps the schema/row metadata."""
    pytest.importorskip("polars")
    await async_start_kernel_with_retry(session, env_source="uv:pyproject")

    bootstrap_id = await async_create_cell_and_wait_for_sync(session, _BOOTSTRAP)
    assert (await session.execute_cell(bootstrap_id)).success

    display_id = await async_create_cell_and_wait_for_sync(
        session,
        """
import polars as pl
pl.DataFrame({"id": list(range(100)), "name": [f"row-{i}" for i in range(100)]})
""",
    )
    result = await session.execute_cell(display_id)
    assert result.success

    rich = [o for o in result.outputs if o.output_type == "display_data"]
    assert len(rich) == 1
    output = rich[0]

    # Sanity on the summary side first — a useful diagnostic if the
    # Arrow stream check below fails.
    llm = output.data.get("text/llm+plain", "")
    assert "(polars)" in llm, f"expected (polars) marker in summary, got: {llm[:120]!r}"
    assert "100 rows" in llm
    assert "2 columns" in llm

    arrow_bytes = output.data[ARROW_STREAM_MIME]
    table = _read_arrow_table(bytes(arrow_bytes))
    assert table.num_rows == 100
    assert set(table.column_names) == {"id", "name"}

    manifest = _arrow_manifest(output.data)
    assert manifest["content_type"] == ARROW_STREAM_MIME
    assert manifest["chunks"][0]["row_count"] == 100
    assert [field["name"] for field in manifest["schema"]["columns"]] == ["id", "name"]


@pytest.mark.integration
async def test_dx_last_expression_emits_display_data_not_execute_result(session):  # noqa: F811
    """Regression test for #1780: last-expression `df` (bare ``df`` on the
    last line of a cell) must produce an ``output_type: display_data``
    output, not ``execute_result``.

    Why this matters: dx registers a handler on
    ``ip.display_formatter.ipython_display_formatter`` for ``pd.DataFrame``.
    When IPython's ``DisplayFormatter.format()`` runs, it short-circuits to
    ``({}, {})`` once our handler fires, which causes ``finish_displayhook``
    to skip its guarded send — no ``execute_result`` message is published.
    Our handler publishes a ``display_data`` directly via
    ``publish_display_data``, which the publisher hook augments with Arrow stream
    buffers.

    The lumped ``ExecutionResult.display_data`` accessor in the Python
    bindings returns BOTH display_data AND execute_result outputs, so the
    `test_dx_display_emits_blob_ref_with_buffers` test would still pass even
    if ipython_display_formatter regressed back to mimebundle_formatter
    only. This test pins the actual ``output_type`` so a regression is
    visible.
    """
    await async_start_kernel_with_retry(session, env_source="uv:pyproject")

    bootstrap_id = await async_create_cell_and_wait_for_sync(session, _BOOTSTRAP)
    assert (await session.execute_cell(bootstrap_id)).success

    display_id = await async_create_cell_and_wait_for_sync(
        session,
        """
import pandas as pd
df = pd.DataFrame({"a": [1, 2, 3], "b": ["x", "y", "z"]})
df
""",
    )
    result = await session.execute_cell(display_id)
    assert result.success, f"display cell failed: {result.error}"

    # Find display/execute outputs in the raw outputs list (preserves output_type).
    rich_outputs = [
        o for o in result.outputs if o.output_type in ("display_data", "execute_result")
    ]
    assert len(rich_outputs) == 1, (
        f"expected one rich output, got {len(rich_outputs)}: "
        f"{[(o.output_type, list(o.data.keys())) for o in rich_outputs]}"
    )
    output = rich_outputs[0]
    assert output.output_type == "display_data", (
        f"expected display_data (ipython_display_formatter short-circuits the "
        f"execute_result path), got {output.output_type!r}. The "
        f"ipython_display_formatter registration in dx._format_install may have "
        f"regressed."
    )
    assert ARROW_STREAM_MIME in output.data, (
        f"Arrow stream MIME missing — bytes did not ride through to the daemon: "
        f"{list(output.data.keys())}"
    )


@pytest.mark.integration
async def test_dx_non_dataframe_last_expression_still_emits_execute_result(session):  # noqa: F811
    """Negative regression: a non-DataFrame last expression (e.g. an int)
    must NOT trigger our ipython_display_formatter handler — it should
    follow the normal IPython path and produce an ``execute_result`` with a
    ``text/plain`` repr. If our handler ever started intercepting non-df
    types, every cell with a bare last expression would lose its ``Out[N]:``
    prompt and become a ``display_data``."""
    await async_start_kernel_with_retry(session, env_source="uv:pyproject")

    bootstrap_id = await async_create_cell_and_wait_for_sync(session, _BOOTSTRAP)
    assert (await session.execute_cell(bootstrap_id)).success

    display_id = await async_create_cell_and_wait_for_sync(session, "42 + 8\n")
    result = await session.execute_cell(display_id)
    assert result.success

    rich_outputs = [
        o for o in result.outputs if o.output_type in ("display_data", "execute_result")
    ]
    assert len(rich_outputs) == 1
    output = rich_outputs[0]
    assert output.output_type == "execute_result", (
        f"non-DataFrame last expression must remain execute_result, got "
        f"{output.output_type!r}. dx's ipython_display_formatter handler "
        f"should only fire for registered DataFrame types."
    )
    assert output.data.get("text/plain") == "50"
