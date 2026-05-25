"""Shared result types for the prototype REPL."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

JsonObject = dict[str, Any]


@dataclass
class RunResult:
    """Execution result returned by the worker."""

    session: str
    backend: str
    ok: bool
    stdout: str = ""
    stderr: str = ""
    result_repr: str | None = None
    displays: list[JsonObject] = field(default_factory=list)
    error_name: str | None = None
    traceback: str | None = None
    execution_count: int | None = None
    timed_out: bool = False
    restarted: bool = False


@dataclass
class SessionInfo:
    """Lightweight status for a named session."""

    session: str
    backend: str
    pid: int
    alive: bool
    executions: int
