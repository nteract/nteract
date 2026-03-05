"""Integration tests for nteract MCP server.

These tests require a running runtimed daemon. They use MCP's in-memory
transport (anyio memory streams) to test the server without stdio.

Run locally:
    # Start runtimed daemon first
    runtimed

    # Run tests
    uv run pytest tests/test_mcp_integration.py -v

Skip in CI (requires daemon):
    uv run pytest tests/ -v --ignore=tests/test_mcp_integration.py
"""

from __future__ import annotations

import asyncio
import contextlib
import json
from typing import Any

import anyio
import pytest
from mcp import ClientSession

from nteract._mcp_server import mcp


@pytest.fixture
async def mcp_client():
    """Create in-memory MCP client connected to our server.

    Uses asyncio for task management to avoid anyio cancel scope
    issues with pytest-asyncio fixture teardown.
    """
    # Bidirectional streams: client->server and server->client
    client_send, server_recv = anyio.create_memory_object_stream[Any](0)
    server_send, client_recv = anyio.create_memory_object_stream[Any](0)

    # Start server as asyncio task (not anyio task group)
    server_task = asyncio.create_task(
        mcp._mcp_server.run(
            server_recv,
            server_send,
            mcp._mcp_server.create_initialization_options(),
            raise_exceptions=True,
        )
    )

    # Give server a moment to start
    await asyncio.sleep(0.01)

    # Create client - use manual __aenter__/__aexit__ to control cleanup
    client = ClientSession(client_recv, client_send)
    await client.__aenter__()

    try:
        await client.initialize()
        yield client
    finally:
        # Cancel server first
        server_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await server_task

        # Close streams to unblock any pending operations
        await client_send.aclose()
        await server_send.aclose()

        # Best-effort client cleanup - suppress task context errors
        with contextlib.suppress(RuntimeError):
            await client.__aexit__(None, None, None)


def _parse_tool_result(result: Any) -> dict[str, Any]:
    """Parse tool result from MCP response."""
    # Tool results come as a list of content blocks
    if hasattr(result, "content") and result.content:
        content = result.content[0]
        if hasattr(content, "text"):
            return json.loads(content.text)
    return {}


@pytest.mark.asyncio
async def test_list_tools(mcp_client: ClientSession):
    """Verify all expected tools are exposed."""
    tools = await mcp_client.list_tools()
    tool_names = {t.name for t in tools.tools}

    # Core tools should be present
    assert "connect_notebook" in tool_names
    assert "disconnect_notebook" in tool_names
    assert "list_notebooks" in tool_names
    assert "start_kernel" in tool_names
    assert "shutdown_kernel" in tool_names
    assert "interrupt_kernel" in tool_names
    assert "get_kernel_status" in tool_names
    assert "create_cell" in tool_names
    assert "set_cell_source" in tool_names
    assert "append_source" in tool_names
    assert "get_cell" in tool_names
    assert "get_all_cells" in tool_names
    assert "delete_cell" in tool_names
    assert "execute_cell" in tool_names

    # run_code should be removed
    assert "run_code" not in tool_names


@pytest.mark.asyncio
async def test_connect_and_create_cell(mcp_client: ClientSession):
    """Connect to notebook and create a cell."""
    # Connect
    result = await mcp_client.call_tool("connect_notebook", {})
    data = _parse_tool_result(result)
    assert data["connected"] is True
    assert "notebook_id" in data

    # Create cell
    result = await mcp_client.call_tool(
        "create_cell",
        {"source": "print('hello')", "cell_type": "code"},
    )
    data = _parse_tool_result(result)
    assert data["created"] is True
    assert "cell_id" in data

    # Get cell
    cell_id = data["cell_id"]
    result = await mcp_client.call_tool("get_cell", {"cell_id": cell_id})
    data = _parse_tool_result(result)
    assert data["source"] == "print('hello')"
    assert data["cell_type"] == "code"


@pytest.mark.asyncio
async def test_append_source(mcp_client: ClientSession):
    """Test streaming tokens into a cell."""
    # Connect
    await mcp_client.call_tool("connect_notebook", {})

    # Create empty cell
    result = await mcp_client.call_tool("create_cell", {"source": ""})
    data = _parse_tool_result(result)
    cell_id = data["cell_id"]

    # Stream tokens
    tokens = ["print", "(", "'hello", " ", "world", "'", ")"]
    for token in tokens:
        result = await mcp_client.call_tool(
            "append_source",
            {"cell_id": cell_id, "text": token},
        )
        data = _parse_tool_result(result)
        assert data["appended"] is True

    # Verify final source
    result = await mcp_client.call_tool("get_cell", {"cell_id": cell_id})
    data = _parse_tool_result(result)
    assert data["source"] == "print('hello world')"


@pytest.mark.asyncio
async def test_execute_cell_basic(mcp_client: ClientSession):
    """Test basic cell execution."""
    # Connect and start kernel
    await mcp_client.call_tool("connect_notebook", {})
    await mcp_client.call_tool("start_kernel", {})

    # Create and execute cell
    result = await mcp_client.call_tool(
        "create_cell",
        {
            "source": "print('hello from kernel')",
            "and_run": True,
            "timeout_secs": 30.0,  # Give enough time for kernel warmup
        },
    )
    data = _parse_tool_result(result)

    assert data["created"] is True
    assert "cell_id" in data
    # Should have status and outputs
    assert "status" in data
    assert "outputs" in data


@pytest.mark.asyncio
async def test_execute_cell_partial_results(mcp_client: ClientSession):
    """Execute long-running code, verify partial results returned."""
    # Connect and start kernel
    await mcp_client.call_tool("connect_notebook", {})
    await mcp_client.call_tool("start_kernel", {})

    # Create cell with slow code - print immediately, then sleep
    result = await mcp_client.call_tool(
        "create_cell",
        {
            "source": "import time; print('start'); time.sleep(10); print('done')",
            "and_run": True,
            "timeout_secs": 2.0,  # Short timeout to test partial results
        },
    )
    data = _parse_tool_result(result)

    # Should have partial output and complete=False
    assert data.get("complete") is False
    assert data.get("status") == "running"
    # Should have at least the "start" output
    outputs = data.get("outputs", [])
    output_text = "".join(
        o.get("text", "") for o in outputs if o.get("output_type") == "stream"
    )
    assert "start" in output_text


@pytest.mark.asyncio
async def test_poll_for_outputs(mcp_client: ClientSession):
    """Create cell, execute, poll get_cell for updated outputs."""
    # Connect and start kernel
    await mcp_client.call_tool("connect_notebook", {})
    await mcp_client.call_tool("start_kernel", {})

    # Create cell with short delay
    result = await mcp_client.call_tool(
        "create_cell",
        {
            "source": "import time; time.sleep(1); print('done')",
            "and_run": True,
            "timeout_secs": 0.5,  # Return before completion
        },
    )
    data = _parse_tool_result(result)
    cell_id = data["cell_id"]

    # Should be incomplete
    assert data.get("complete") is False

    # Wait and poll
    await anyio.sleep(2)
    result = await mcp_client.call_tool("get_cell", {"cell_id": cell_id})
    data = _parse_tool_result(result)

    # Should now have the output
    outputs = data.get("outputs", [])
    output_text = "".join(
        o.get("text", "") for o in outputs if o.get("output_type") == "stream"
    )
    assert "done" in output_text


@pytest.mark.asyncio
async def test_output_ordering(mcp_client: ClientSession):
    """Verify interleaved outputs maintain order."""
    # Connect and start kernel
    await mcp_client.call_tool("connect_notebook", {})
    await mcp_client.call_tool("start_kernel", {})

    # Code that produces interleaved outputs
    code = """
import sys
print('a', flush=True)
from IPython.display import display
display('b')
print('c', flush=True)
"""
    result = await mcp_client.call_tool(
        "create_cell",
        {
            "source": code,
            "and_run": True,
            "timeout_secs": 30.0,
        },
    )
    data = _parse_tool_result(result)

    outputs = data.get("outputs", [])
    # Should be: stream(a), display_data(b), stream(c) in order
    # Filter to just the main output types
    main_outputs = [
        o for o in outputs if o.get("output_type") in ("stream", "display_data")
    ]

    # Strict assertion: must have exactly 3 outputs in the expected order
    assert len(main_outputs) == 3, f"Expected 3 outputs, got {len(main_outputs)}: {main_outputs}"
    assert main_outputs[0]["output_type"] == "stream", "First output should be stream"
    assert "a" in main_outputs[0].get("text", ""), "First output should contain 'a'"
    assert main_outputs[1]["output_type"] == "display_data", "Second output should be display_data"
    assert main_outputs[2]["output_type"] == "stream", "Third output should be stream"
    assert "c" in main_outputs[2].get("text", ""), "Third output should contain 'c'"


@pytest.mark.asyncio
async def test_get_kernel_status(mcp_client: ClientSession):
    """Test kernel status reporting."""
    # Connect
    await mcp_client.call_tool("connect_notebook", {})

    # Check status before starting kernel
    result = await mcp_client.call_tool("get_kernel_status", {})
    data = _parse_tool_result(result)
    assert data.get("kernel_started") is False

    # Start kernel
    await mcp_client.call_tool("start_kernel", {})

    # Check status after starting
    result = await mcp_client.call_tool("get_kernel_status", {})
    data = _parse_tool_result(result)
    assert data.get("kernel_started") is True


@pytest.mark.asyncio
async def test_delete_cell(mcp_client: ClientSession):
    """Test cell deletion."""
    # Connect
    await mcp_client.call_tool("connect_notebook", {})

    # Create cell
    result = await mcp_client.call_tool("create_cell", {"source": "x = 1"})
    data = _parse_tool_result(result)
    cell_id = data["cell_id"]

    # Delete cell
    result = await mcp_client.call_tool("delete_cell", {"cell_id": cell_id})
    data = _parse_tool_result(result)
    assert data["deleted"] is True

    # Verify it's gone
    result = await mcp_client.call_tool("get_all_cells", {})
    data = _parse_tool_result(result)
    cell_ids = [c.get("id") for c in data] if isinstance(data, list) else []
    assert cell_id not in cell_ids
