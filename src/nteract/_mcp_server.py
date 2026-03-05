"""nteract MCP server for AI-powered Jupyter notebooks.

This server exposes notebook operations as MCP tools, allowing AI agents
to create cells, execute code, and read outputs. For realtime sync with
users, use the nteract desktop app connected to the same notebook.

Usage:
    python -m nteract._mcp_server

Or via the entry point:
    nteract

Requires: pip install nteract
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import sys
from typing import Any

import runtimed
from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations

logger = logging.getLogger(__name__)

# Create the MCP server
mcp = FastMCP("nteract")

# Session state - single active session at a time
_session: runtimed.AsyncSession | None = None
_daemon_client: runtimed.DaemonClient | None = None


def _get_daemon_client() -> runtimed.DaemonClient:
    """Get or create the daemon client."""
    global _daemon_client
    if _daemon_client is None:
        _daemon_client = runtimed.DaemonClient()
    return _daemon_client


async def _get_session() -> runtimed.AsyncSession:
    """Get the current session, raising error if not connected."""
    if _session is None:
        raise RuntimeError("No active notebook session. Call connect_notebook first.")
    return _session


def _output_to_dict(output: runtimed.Output) -> dict[str, Any]:
    """Convert an Output to a JSON-serializable dict."""
    result: dict[str, Any] = {"output_type": output.output_type}

    if output.name is not None:
        result["name"] = output.name
    if output.text is not None:
        result["text"] = output.text
    if output.data is not None:
        result["data"] = output.data
    if output.ename is not None:
        result["ename"] = output.ename
    if output.evalue is not None:
        result["evalue"] = output.evalue
    if output.traceback is not None:
        result["traceback"] = output.traceback
    if output.execution_count is not None:
        result["execution_count"] = output.execution_count

    return result


def _cell_to_dict(cell: runtimed.Cell) -> dict[str, Any]:
    """Convert a Cell to a JSON-serializable dict with outputs from Automerge."""
    return {
        "id": cell.id,
        "cell_type": cell.cell_type,
        "source": cell.source,
        "execution_count": cell.execution_count,
        "outputs": [_output_to_dict(o) for o in cell.outputs],
    }


def _execution_to_dict(
    cell_id: str,
    events: list[Any],  # list[runtimed.ExecutionEvent] - type not exported yet
    complete: bool,
) -> dict[str, Any]:
    """Convert execution events to agent-friendly format.

    Returns ordered outputs preserving interleaving (stdout/display_data/etc).
    Status reflects execution outcome:
    - "running": execution in progress
    - "idle": completed successfully
    - "error": execution raised an exception or kernel error
    """
    outputs: list[dict[str, Any]] = []
    execution_count: int | None = None
    status = "running"
    has_error_output = False

    for event in events:
        if event.event_type == "execution_started":
            execution_count = event.execution_count
        elif event.event_type == "output":
            output_dict = _output_to_dict(event.output)
            outputs.append(output_dict)
            # Check for error output from user code exceptions (e.g., 1/0)
            if output_dict.get("output_type") == "error":
                has_error_output = True
        elif event.event_type == "done":
            # Set status based on whether any error output was produced
            status = "error" if has_error_output else "idle"
        elif event.event_type == "error":
            # Transport/kernel-level error
            status = "error"

    return {
        "cell_id": cell_id,
        "status": status,
        "execution_count": execution_count,
        "outputs": outputs,
        "complete": complete,
    }


# =============================================================================
# Session Management Tools
# =============================================================================


@mcp.tool(annotations=ToolAnnotations(destructiveHint=False))
async def connect_notebook(
    notebook_id: str | None = None,
) -> dict[str, Any]:
    """Connect to a notebook session.

    Creates or connects to a notebook session in the daemon. Multiple calls
    with the same notebook_id will share the same kernel.

    Args:
        notebook_id: Optional ID for the notebook. If not provided, generates
            a unique ID. Use the same ID to reconnect to an existing session.

    Returns:
        Session info including the notebook_id.
    """
    global _session

    # Close existing session if any
    if _session is not None:
        with contextlib.suppress(Exception):
            await _session.close()

    # Create new session
    _session = runtimed.AsyncSession(notebook_id=notebook_id)
    await _session.connect()

    return {
        "notebook_id": _session.notebook_id,
        "connected": True,
    }


@mcp.tool(annotations=ToolAnnotations(destructiveHint=True))
async def disconnect_notebook() -> dict[str, Any]:
    """Disconnect from the current notebook session.

    Closes the connection but does not shutdown the kernel (other clients
    may still be using it).

    Returns:
        Confirmation of disconnection.
    """
    global _session

    if _session is not None:
        with contextlib.suppress(Exception):
            await _session.close()
        _session = None

    return {"disconnected": True}


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=True))
async def list_notebooks() -> list[dict[str, Any]]:
    """List all active notebook rooms in the daemon.

    Returns:
        List of notebook rooms with their status.
    """
    client = _get_daemon_client()
    rooms = client.list_rooms()
    # rooms is a list of dicts with keys: notebook_id, active_peers, has_kernel,
    # kernel_type (optional), kernel_status (optional), env_source (optional)
    return [dict(room) for room in rooms]


# =============================================================================
# Kernel Management Tools
# =============================================================================


@mcp.tool(annotations=ToolAnnotations(destructiveHint=False))
async def start_kernel(
    kernel_type: str = "python",
    env_source: str = "auto",
) -> dict[str, Any]:
    """Start a kernel for the current session.

    If a kernel is already running for this notebook_id (from any client),
    it will be reused.

    Args:
        kernel_type: Type of kernel - "python" or "deno".
        env_source: Environment source. Options:
            - "auto" (default) - Auto-detect from notebook metadata/project files
            - "uv:prewarmed" - Fast startup from UV pool
            - "conda:prewarmed" - Conda environment from pool
            - "uv:inline" - Use notebook's inline UV dependencies
            - "conda:inline" - Use notebook's inline conda dependencies
            For Deno kernels, this is ignored (always uses "deno").

    Returns:
        Kernel info including the actual env_source used.
    """
    session = await _get_session()
    await session.start_kernel(kernel_type=kernel_type, env_source=env_source)

    return {
        "kernel_type": kernel_type,
        "env_source": await session.env_source(),
        "started": True,
    }


@mcp.tool(annotations=ToolAnnotations(destructiveHint=True))
async def shutdown_kernel() -> dict[str, Any]:
    """Shutdown the kernel for the current session.

    Returns:
        Confirmation of shutdown.
    """
    session = await _get_session()
    await session.shutdown_kernel()

    return {"shutdown": True}


@mcp.tool(annotations=ToolAnnotations(destructiveHint=True))
async def interrupt_kernel() -> dict[str, Any]:
    """Interrupt the currently executing cell.

    Use this to stop long-running or infinite loops.

    Returns:
        Confirmation of interrupt.
    """
    session = await _get_session()
    await session.interrupt()

    return {"interrupted": True}


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=True))
async def get_kernel_status() -> dict[str, Any]:
    """Get the kernel status for the current session.

    Returns:
        Kernel status including whether it's running and the env_source.
    """
    session = await _get_session()

    return {
        "connected": await session.is_connected(),
        "kernel_started": await session.kernel_started(),
        "env_source": await session.env_source(),
    }


# =============================================================================
# Cell Operations Tools
# =============================================================================


@mcp.tool(annotations=ToolAnnotations(destructiveHint=False))
async def create_cell(
    source: str = "",
    cell_type: str = "code",
    index: int | None = None,
    and_run: bool = False,
    timeout_secs: float = 5.0,
) -> dict[str, Any]:
    """Create a new cell in the notebook, optionally executing it.

    The cell is added to the shared document and synced to all connected
    clients (including nteract if open with the same notebook).

    Args:
        source: Initial source code for the cell.
        cell_type: Cell type - "code", "markdown", or "raw".
        index: Position to insert the cell. None appends at the end.
        and_run: If True, execute the cell after creating it.
        timeout_secs: Max time to wait for execution (default 5s). If execution
            takes longer, returns partial results with complete=False.

    Returns:
        Cell info including id. If and_run=True, includes outputs and status.
        Check 'complete' field to know if execution finished.
    """
    session = await _get_session()
    cell_id = await session.create_cell(
        source=source,
        cell_type=cell_type,
        index=index,
    )

    result: dict[str, Any] = {"cell_id": cell_id, "created": True}

    if and_run and cell_type == "code":
        exec_result = await _execute_cell_internal(cell_id, timeout_secs=timeout_secs)
        result.update(exec_result)

    return result


@mcp.tool(annotations=ToolAnnotations(destructiveHint=True))
async def set_cell_source(cell_id: str, source: str) -> dict[str, Any]:
    """Update a cell's source code.

    The change is synced to all connected clients.

    Args:
        cell_id: The cell ID to update.
        source: The new source code.

    Returns:
        Confirmation of update.
    """
    session = await _get_session()
    await session.set_source(cell_id=cell_id, source=source)

    return {"cell_id": cell_id, "updated": True}


@mcp.tool(annotations=ToolAnnotations(destructiveHint=False))
async def append_source(cell_id: str, text: str) -> dict[str, Any]:
    """Append text to a cell's source code.

    Uses direct CRDT insertion (no diff) - ideal for streaming LLM tokens.
    Changes sync to all connected clients in real-time.

    Args:
        cell_id: The cell ID to append to.
        text: The text to append.

    Returns:
        Confirmation of append.
    """
    session = await _get_session()
    await session.append_source(cell_id=cell_id, text=text)

    return {"cell_id": cell_id, "appended": True}


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=True))
async def get_cell(cell_id: str) -> dict[str, Any]:
    """Get a cell by ID, including outputs if available.

    Outputs are resolved from the Automerge document, so you can see
    outputs from cells executed by other clients.

    Args:
        cell_id: The cell ID.

    Returns:
        Cell info including id, cell_type, source, execution_count,
        and outputs if available.
    """
    session = await _get_session()
    cell = await session.get_cell(cell_id=cell_id)
    return _cell_to_dict(cell)


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=True))
async def get_all_cells() -> list[dict[str, Any]]:
    """Get all cells in the current notebook, including outputs.

    Outputs are resolved from the Automerge document, so you can see
    outputs from cells executed by other clients.

    Returns:
        List of cells with their info and outputs.
    """
    session = await _get_session()
    cells = await session.get_cells()
    return [_cell_to_dict(cell) for cell in cells]


@mcp.tool(annotations=ToolAnnotations(destructiveHint=True))
async def delete_cell(cell_id: str) -> dict[str, Any]:
    """Delete a cell from the notebook.

    The change is synced to all connected clients.

    Args:
        cell_id: The cell ID to delete.

    Returns:
        Confirmation of deletion.
    """
    session = await _get_session()
    await session.delete_cell(cell_id=cell_id)

    return {"cell_id": cell_id, "deleted": True}


# =============================================================================
# Execution Tools
# =============================================================================


async def _execute_cell_internal(
    cell_id: str,
    timeout_secs: float = 5.0,
) -> dict[str, Any]:
    """Internal execution with streaming and partial results."""
    session = await _get_session()
    events: list[Any] = []  # list[runtimed.ExecutionEvent]
    complete = False

    async def collect_events() -> None:
        nonlocal complete
        async for event in await session.stream_execute(cell_id):
            events.append(event)
            if event.event_type in ("done", "error"):
                complete = True
                break

    with contextlib.suppress(asyncio.TimeoutError):
        await asyncio.wait_for(collect_events(), timeout=timeout_secs)

    return _execution_to_dict(cell_id, events, complete)


@mcp.tool(annotations=ToolAnnotations(destructiveHint=True))
async def execute_cell(
    cell_id: str,
    timeout_secs: float = 5.0,
) -> dict[str, Any]:
    """Execute a cell by ID.

    Returns partial results after timeout_secs if still running.
    Check 'complete' field - if False, use get_cell() to poll for more outputs.

    If no kernel is running, one will be started automatically.

    Args:
        cell_id: The cell ID to execute.
        timeout_secs: Maximum time to wait for execution (default: 5s).

    Returns:
        Execution result with ordered outputs preserving interleaving.
        Fields: cell_id, status, execution_count, outputs, complete.
    """
    return await _execute_cell_internal(cell_id, timeout_secs=timeout_secs)


# =============================================================================
# Resources
# =============================================================================


@mcp.resource("notebook://cells")
async def resource_cells() -> str:
    """Get all cells in the current notebook as JSON."""
    if _session is None:
        return json.dumps({"error": "No active session"})

    try:
        cells = await _session.get_cells()
        return json.dumps([_cell_to_dict(cell) for cell in cells])
    except Exception as e:
        return json.dumps({"error": str(e)})


@mcp.resource("notebook://status")
async def resource_status() -> str:
    """Get the current session and kernel status as JSON."""
    if _session is None:
        return json.dumps(
            {
                "connected": False,
                "kernel_started": False,
                "env_source": None,
            }
        )

    try:
        return json.dumps(
            {
                "notebook_id": _session.notebook_id,
                "connected": await _session.is_connected(),
                "kernel_started": await _session.kernel_started(),
                "env_source": await _session.env_source(),
            }
        )
    except Exception as e:
        return json.dumps({"error": str(e)})


@mcp.resource("notebook://rooms")
async def resource_rooms() -> str:
    """Get all active notebook rooms as JSON."""
    try:
        client = _get_daemon_client()
        rooms = client.list_rooms()
        return json.dumps([dict(room) for room in rooms])
    except Exception as e:
        return json.dumps({"error": str(e)})


# =============================================================================
# Entry Point
# =============================================================================


def main():
    """Run the MCP server."""
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
        stream=sys.stderr,
    )
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
