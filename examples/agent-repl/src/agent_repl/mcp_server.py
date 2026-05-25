"""MCP server exposing the prototype REPL as tools."""

from __future__ import annotations

import asyncio
import atexit
from typing import Any, Literal

from agent_repl.manager import ReplManager, as_jsonable

Backend = Literal["auto", "ipython", "python"]
MAX_TIMEOUT_S = 300.0
manager = ReplManager()
atexit.register(manager.close)


def _mcp():
    from mcp.server.fastmcp import FastMCP

    return FastMCP("agent-repl")


mcp = _mcp()


@mcp.tool()
async def run_python(
    code: str,
    session: str = "default",
    timeout_s: float = 30,
    backend: Backend = "auto",
) -> dict[str, Any]:
    """Run Python code in a persistent named session."""
    clamped_timeout_s = min(max(timeout_s, 0.1), MAX_TIMEOUT_S)
    result = await asyncio.to_thread(
        manager.run,
        code,
        session=session,
        timeout_s=clamped_timeout_s,
        backend=backend,
    )
    return as_jsonable(result)


@mcp.tool()
async def reset_python(session: str = "default") -> dict[str, Any]:
    """Reset a named Python session, killing its worker process if needed."""
    reset = await asyncio.to_thread(manager.reset, session)
    return {"session": session, "reset": reset}


@mcp.tool()
async def python_status(session: str = "default") -> dict[str, Any]:
    """Return status for a named Python session."""
    status = await asyncio.to_thread(manager.status, session)
    return {"session": session, "status": as_jsonable(status)}


@mcp.tool()
async def list_python_sessions() -> dict[str, Any]:
    """List active Python sessions for this MCP server process."""
    sessions = await asyncio.to_thread(manager.list_sessions)
    return {"sessions": as_jsonable(sessions)}


def main() -> None:
    try:
        mcp.run()
    finally:
        manager.close()


if __name__ == "__main__":
    main()
