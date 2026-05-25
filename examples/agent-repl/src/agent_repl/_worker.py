"""Worker process for one persistent Python session.

The parent owns MCP/inline tool state. This child owns the Python namespace.
JSON lines are used for the prototype RPC. Normal Python stdout/stderr is
captured during execution so ordinary ``print()`` calls do not corrupt the
transport.
"""

from __future__ import annotations

import argparse
import ast
import asyncio
import base64
import contextlib
import inspect
import io
import json
import sys
import traceback
import warnings
from typing import Any


def _jsonable(value: Any) -> Any:
    if value is None or isinstance(value, str | int | float | bool):
        return value
    if isinstance(value, bytes):
        return {"encoding": "base64", "data": base64.b64encode(value).decode("ascii")}
    if isinstance(value, list | tuple):
        return [_jsonable(item) for item in value]
    if isinstance(value, dict):
        return {str(key): _jsonable(item) for key, item in value.items()}
    return repr(value)


async def _maybe_await(value: Any) -> Any:
    if inspect.isawaitable(value):
        return await value
    return value


class PlainPythonBackend:
    """Small stdlib-only backend.

    This is intentionally modest. It keeps a namespace and returns a value for
    expression-only snippets. It does not recreate IPython's display hook,
    magics, rich formatters, or full top-level await behavior for statement
    blocks.
    """

    name = "python"

    def __init__(self) -> None:
        self.namespace: dict[str, Any] = {"__name__": "__console__", "__doc__": None}
        self.execution_count = 0

    async def run(self, code: str) -> dict[str, Any]:
        self.execution_count += 1
        stdout = io.StringIO()
        stderr = io.StringIO()

        try:
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                value = await self._eval_or_exec(code)
        except BaseException as exc:
            return {
                "backend": self.name,
                "ok": False,
                "stdout": stdout.getvalue(),
                "stderr": stderr.getvalue(),
                "error_name": type(exc).__name__,
                "traceback": traceback.format_exc(),
                "execution_count": self.execution_count,
            }

        return {
            "backend": self.name,
            "ok": True,
            "stdout": stdout.getvalue(),
            "stderr": stderr.getvalue(),
            "result_repr": repr(value) if value is not None else None,
            "displays": [],
            "execution_count": self.execution_count,
        }

    async def _eval_or_exec(self, code: str) -> Any:
        flags = ast.PyCF_ALLOW_TOP_LEVEL_AWAIT
        try:
            compiled = compile(code, "<agent-repl>", "eval", flags=flags)
        except SyntaxError:
            tree = ast.parse(code, mode="exec")
            if tree.body and isinstance(tree.body[-1], ast.Expr):
                prefix = ast.Module(body=tree.body[:-1], type_ignores=tree.type_ignores)
                ast.fix_missing_locations(prefix)
                if prefix.body:
                    prefix_code = compile(prefix, "<agent-repl>", "exec", flags=flags)
                    await _maybe_await(eval(prefix_code, self.namespace, self.namespace))

                expression = ast.Expression(body=tree.body[-1].value)
                ast.fix_missing_locations(expression)
                expression_code = compile(expression, "<agent-repl>", "eval", flags=flags)
                value = eval(expression_code, self.namespace, self.namespace)
                return await _maybe_await(value)

            compiled = compile(tree, "<agent-repl>", "exec", flags=flags)
            value = eval(compiled, self.namespace, self.namespace)
            return await _maybe_await(value)

        value = eval(compiled, self.namespace, self.namespace)
        return await _maybe_await(value)


class IPythonBackend:
    """IPython backend using InteractiveShell.run_cell_async."""

    name = "ipython"

    def __init__(self) -> None:
        from IPython.core.interactiveshell import InteractiveShell

        self.shell = InteractiveShell.instance()
        self.shell.user_ns.setdefault("__name__", "__console__")
        self.shell.user_ns.setdefault("__doc__", None)

    async def run(self, code: str) -> dict[str, Any]:
        from IPython.utils.capture import capture_output

        with (
            capture_output(stdout=True, stderr=True, display=True) as captured,
            warnings.catch_warnings(),
        ):
            warnings.filterwarnings(
                "ignore",
                message="`run_cell_async` will not call `transform_cell` automatically.*",
                category=DeprecationWarning,
            )
            result = await self.shell.run_cell_async(code, store_history=True, silent=False)

        error = result.error_before_exec or result.error_in_exec
        return {
            "backend": self.name,
            "ok": error is None,
            "stdout": captured.stdout,
            "stderr": captured.stderr,
            "result_repr": repr(result.result) if result.result is not None else None,
            "displays": [self._serialize_display(output) for output in captured.outputs],
            "error_name": type(error).__name__ if error else None,
            "traceback": "".join(traceback.format_exception(error)) if error else None,
            "execution_count": getattr(result, "execution_count", None),
        }

    @staticmethod
    def _serialize_display(output: Any) -> dict[str, Any]:
        return {
            "data": _jsonable(getattr(output, "data", {})),
            "metadata": _jsonable(getattr(output, "metadata", {})),
            "transient": _jsonable(getattr(output, "transient", {})),
            "update": bool(getattr(output, "update", False)),
        }


def _create_backend(kind: str) -> PlainPythonBackend | IPythonBackend:
    if kind == "python":
        return PlainPythonBackend()
    if kind == "ipython":
        return IPythonBackend()
    if kind == "auto":
        try:
            return IPythonBackend()
        except Exception:
            return PlainPythonBackend()
    raise ValueError(f"unknown backend: {kind}")


async def _handle_request(backend: PlainPythonBackend | IPythonBackend, request: dict[str, Any]):
    op = request.get("op")
    if op == "run":
        payload = await backend.run(str(request.get("code", "")))
    elif op == "status":
        payload = {
            "backend": backend.name,
            "ok": True,
            "execution_count": getattr(backend, "execution_count", None),
        }
    else:
        payload = {
            "backend": backend.name,
            "ok": False,
            "error_name": "UnknownOperation",
            "traceback": f"unknown operation: {op!r}",
        }

    payload["id"] = request.get("id")
    return payload


async def _run_loop(backend_kind: str) -> None:
    backend = _create_backend(backend_kind)
    while True:
        line = await asyncio.to_thread(sys.stdin.readline)
        if line == "":
            return

        try:
            request = json.loads(line)
            response = await _handle_request(backend, request)
        except BaseException as exc:
            response = {
                "id": None,
                "backend": getattr(backend, "name", backend_kind),
                "ok": False,
                "error_name": type(exc).__name__,
                "traceback": traceback.format_exc(),
            }

        print(json.dumps(response, ensure_ascii=False), flush=True)


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="agent-repl worker process")
    parser.add_argument("--backend", choices=["auto", "ipython", "python"], default="auto")
    args = parser.parse_args(argv)
    asyncio.run(_run_loop(args.backend))


if __name__ == "__main__":
    main()
