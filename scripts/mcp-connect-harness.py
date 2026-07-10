#!/usr/bin/env python3
"""Profile MCP ``connect_notebook`` against a running nteract daemon.

The harness speaks MCP JSON-RPC directly over stdio, so it has no Python
package dependencies. By default it creates a temporary notebook with stable
cell IDs, starts a fresh ``runt mcp`` child for each sample, and verifies that
``connect_notebook`` returns those IDs before an immediate ``get_all_cells``.

Start the isolated daemon in another terminal first::

    cargo xtask dev-daemon

Then run a cold/warm profile::

    python3 scripts/mcp-connect-harness.py target/debug/runt \
        --fixture-cells 64 --samples 3

Use ``--parallel 2`` to probe duplicate connects against one MCP process.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import shutil
import sys
import tempfile
import time
from pathlib import Path
from typing import Any
from uuid import UUID

REPO_ROOT = Path(__file__).resolve().parent.parent
FORMATTED_CELL_ID_RE = re.compile(r"^⏺ ━━━ cell (\S+) \(", re.MULTILINE)


def log(message: str) -> None:
    print(f"[mcp-connect-harness] {message}", file=sys.stderr)


def parse_json_value(text: str) -> Any | None:
    text = text.strip()
    if not text:
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    decoder = json.JSONDecoder()
    for index, char in enumerate(text):
        if char not in "[{":
            continue
        try:
            value, _ = decoder.raw_decode(text[index:])
        except json.JSONDecodeError:
            continue
        return value
    return None


def tool_text(result: dict[str, Any]) -> str:
    content = result.get("content")
    if not isinstance(content, list):
        return ""
    return "\n".join(
        item["text"]
        for item in content
        if isinstance(item, dict) and isinstance(item.get("text"), str)
    )


def connect_cell_ids(response: dict[str, Any]) -> tuple[list[str], str]:
    cells = response.get("cells")
    if isinstance(cells, list):
        ids = [
            cell_id
            for cell in cells
            if isinstance(cell, dict)
            for cell_id in (cell.get("id") or cell.get("cell_id"),)
            if isinstance(cell_id, str)
        ]
        return ids, "structured"
    if isinstance(cells, str):
        return FORMATTED_CELL_ID_RE.findall(cells), "formatted"
    return [], "missing"


def normalize_notebook_id(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    try:
        return str(UUID(value))
    except ValueError:
        return None


def notebook_id_arg(value: str) -> str:
    normalized = normalize_notebook_id(value)
    if normalized is None:
        raise argparse.ArgumentTypeError("notebook ID must be a UUID")
    return normalized


class McpProcess:
    def __init__(
        self,
        process: asyncio.subprocess.Process,
        timeout_secs: float,
    ) -> None:
        self.process = process
        self.timeout_secs = timeout_secs
        self.next_id = 1
        self.pending: dict[int, asyncio.Future[Any]] = {}
        self.stderr_lines: list[str] = []
        self.stdout_task = asyncio.create_task(self._read_stdout())
        self.stderr_task = asyncio.create_task(self._read_stderr())

    @classmethod
    async def start(
        cls,
        runt_exe: Path,
        env: dict[str, str],
        timeout_secs: float,
    ) -> McpProcess:
        process = await asyncio.create_subprocess_exec(
            str(runt_exe),
            "mcp",
            "--no-show",
            cwd=REPO_ROOT,
            env=env,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        client = cls(process, timeout_secs)
        try:
            await client.request(
                "initialize",
                {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {},
                    "clientInfo": {
                        "name": "nteract-mcp-connect-harness",
                        "version": "0.1.0",
                    },
                },
            )
            await client.notify("notifications/initialized", {})
            return client
        except BaseException:
            await client.close()
            raise

    async def _read_stdout(self) -> None:
        assert self.process.stdout is not None
        while line := await self.process.stdout.readline():
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                continue
            request_id = message.get("id")
            if not isinstance(request_id, int):
                continue
            future = self.pending.pop(request_id, None)
            if future is None or future.done():
                continue
            if isinstance(message.get("error"), dict):
                error = message["error"]
                future.set_exception(
                    RuntimeError(
                        f"MCP error {error.get('code', '')}: "
                        f"{error.get('message', 'unknown error')}"
                    )
                )
            else:
                future.set_result(message.get("result"))

        error = RuntimeError(f"MCP process exited before replying (exit={self.process.returncode})")
        for future in self.pending.values():
            if not future.done():
                future.set_exception(error)
        self.pending.clear()

    async def _read_stderr(self) -> None:
        assert self.process.stderr is not None
        while line := await self.process.stderr.readline():
            self.stderr_lines.append(line.decode("utf-8", errors="replace").rstrip())

    async def request(self, method: str, params: Any) -> Any:
        if self.process.returncode is not None:
            raise RuntimeError(f"MCP process already exited ({self.process.returncode})")
        assert self.process.stdin is not None
        request_id = self.next_id
        self.next_id += 1
        future = asyncio.get_running_loop().create_future()
        self.pending[request_id] = future
        message = {
            "jsonrpc": "2.0",
            "id": request_id,
            "method": method,
            "params": params,
        }
        try:
            self.process.stdin.write((json.dumps(message) + "\n").encode())
            await self.process.stdin.drain()
            return await asyncio.wait_for(future, timeout=self.timeout_secs)
        except TimeoutError:
            self.pending.pop(request_id, None)
            raise TimeoutError(f"MCP request {method} exceeded {self.timeout_secs:.1f}s") from None
        except BaseException:
            self.pending.pop(request_id, None)
            if not future.done():
                future.cancel()
            raise

    async def notify(self, method: str, params: Any) -> None:
        assert self.process.stdin is not None
        message = {"jsonrpc": "2.0", "method": method, "params": params}
        self.process.stdin.write((json.dumps(message) + "\n").encode())
        await self.process.stdin.drain()

    async def call_tool(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        result = await self.request(
            "tools/call",
            {"name": name, "arguments": arguments},
        )
        if not isinstance(result, dict):
            raise RuntimeError(f"MCP tool {name} returned a non-object result")
        return result

    async def close(self) -> None:
        if self.process.returncode is None:
            self.process.terminate()
            try:
                await asyncio.wait_for(self.process.wait(), timeout=2)
            except TimeoutError:
                self.process.kill()
                await self.process.wait()
        await asyncio.gather(self.stdout_task, self.stderr_task, return_exceptions=True)


def create_fixture(root: Path, cell_count: int) -> tuple[Path, list[str]]:
    cell_ids = [f"harness-{index:06d}" for index in range(cell_count)]
    notebook = {
        "cells": [
            {
                "cell_type": "code",
                "execution_count": None,
                "id": cell_id,
                "metadata": {},
                "outputs": [],
                "source": [f"value_{index} = {index}\n"],
            }
            for index, cell_id in enumerate(cell_ids)
        ],
        "metadata": {
            "kernelspec": {
                "display_name": "Python 3",
                "language": "python",
                "name": "python3",
            },
            "language_info": {"name": "python"},
        },
        "nbformat": 4,
        "nbformat_minor": 5,
    }
    path = root / "mcp-connect-harness.ipynb"
    path.write_text(json.dumps(notebook), encoding="utf-8")
    return path, cell_ids


async def daemon_status(runt_exe: Path, env: dict[str, str]) -> dict[str, Any]:
    process = await asyncio.create_subprocess_exec(
        str(runt_exe),
        "daemon",
        "status",
        "--json",
        cwd=REPO_ROOT,
        env=env,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await process.communicate()
    if process.returncode != 0:
        detail = stderr.decode("utf-8", errors="replace").strip()
        raise RuntimeError(
            "Dev daemon is not reachable. Run `cargo xtask dev-daemon` in another "
            f"terminal first. {detail}"
        )
    value = json.loads(stdout)
    if not isinstance(value, dict):
        raise RuntimeError("Daemon status returned a non-object JSON value")
    return value


async def measured_tool(
    client: McpProcess,
    name: str,
    arguments: dict[str, Any],
) -> tuple[float, dict[str, Any] | None, str | None]:
    started = time.perf_counter()
    try:
        result = await client.call_tool(name, arguments)
        return (time.perf_counter() - started) * 1000, result, None
    except Exception as error:  # The harness records all protocol/process failures.
        return (time.perf_counter() - started) * 1000, None, str(error)


def summarize_connect(
    elapsed_ms: float,
    result: dict[str, Any] | None,
    error: str | None,
    fixture_cell_ids: list[str] | None,
) -> dict[str, Any]:
    if error is not None or result is None:
        return {"elapsed_ms": round(elapsed_ms, 1), "ok": False, "error": error}

    text = tool_text(result)
    response = parse_json_value(text)
    response_object = response if isinstance(response, dict) else {}
    cells_text = response_object.get("cells")
    response_cell_ids, response_kind = connect_cell_ids(response_object)
    response_cell_id_set = set(response_cell_ids)
    present_fixture_ids = (
        None
        if fixture_cell_ids is None
        else [cell_id for cell_id in fixture_cell_ids if cell_id in response_cell_id_set]
    )
    if isinstance(cells_text, str):
        cells_bytes = len(cells_text.encode("utf-8"))
    elif isinstance(cells_text, list):
        cells_bytes = len(json.dumps(cells_text, separators=(",", ":")).encode("utf-8"))
    else:
        cells_bytes = 0
    is_error = bool(result.get("isError"))
    notebook_id = normalize_notebook_id(response_object.get("notebook_id"))
    response_valid = notebook_id is not None and response_kind in {"formatted", "structured"}
    summary: dict[str, Any] = {
        "elapsed_ms": round(elapsed_ms, 1),
        "ok": not is_error and response_valid,
        "tool_error": is_error,
        "response_valid": response_valid,
        "notebook_id": notebook_id,
        "response_cells_kind": response_kind,
        "response_cells_bytes": cells_bytes,
        "cell_count": len(response_cell_ids),
        "cell_ids": response_cell_ids,
        "fixture_cell_ids_returned": (
            len(present_fixture_ids) if present_fixture_ids is not None else None
        ),
        "fixture_cell_ids_total": len(fixture_cell_ids) if fixture_cell_ids is not None else None,
        "returned_cell_id_sample": response_cell_ids[:5],
    }
    if is_error or not response_valid:
        summary["response_text"] = text[-4000:]
    return summary


def summarize_get_all(
    elapsed_ms: float,
    result: dict[str, Any] | None,
    error: str | None,
) -> dict[str, Any]:
    if error is not None or result is None:
        return {"elapsed_ms": round(elapsed_ms, 1), "ok": False, "error": error}
    text = tool_text(result)
    value = parse_json_value(text)
    cells = value if isinstance(value, list) else []
    cell_ids = [
        cell["cell_id"]
        for cell in cells
        if isinstance(cell, dict) and isinstance(cell.get("cell_id"), str)
    ]
    is_error = bool(result.get("isError"))
    summary: dict[str, Any] = {
        "elapsed_ms": round(elapsed_ms, 1),
        "ok": not is_error and isinstance(value, list),
        "tool_error": is_error,
        "cell_count": len(cell_ids),
        "cell_id_sample": cell_ids[:5],
        "cell_ids": cell_ids,
    }
    if is_error or not isinstance(value, list):
        summary["response_text"] = text[-4000:]
    return summary


def matching_active_rooms(value: Any, connect_args: dict[str, Any]) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    target_notebook_id = normalize_notebook_id(connect_args.get("notebook_id"))
    target_path = connect_args.get("path")
    canonical_target_path = (
        os.path.realpath(os.path.expanduser(target_path)) if isinstance(target_path, str) else None
    )
    return [
        room
        for room in value
        if isinstance(room, dict)
        and (
            (
                target_notebook_id is not None
                and normalize_notebook_id(room.get("notebook_id")) == target_notebook_id
            )
            or (
                canonical_target_path is not None
                and isinstance(room.get("notebook_path"), str)
                and os.path.realpath(room["notebook_path"]) == canonical_target_path
            )
        )
    ]


async def monitor_active_peers(
    client: McpProcess,
    stop: asyncio.Event,
    connect_args: dict[str, Any],
) -> dict[str, Any]:
    peer_counts: list[int] = []
    errors: list[str] = []
    while True:
        _, result, error = await measured_tool(client, "list_active_notebooks", {})
        if error is not None:
            errors.append(error)
        elif result is not None:
            value = parse_json_value(tool_text(result))
            peer_counts.extend(
                int(room["active_peers"])
                for room in matching_active_rooms(value, connect_args)
                if isinstance(room.get("active_peers"), (int, float))
            )
        if stop.is_set():
            break
        await asyncio.sleep(0.01)
    return {
        "polls": len(peer_counts),
        "observed_peer_counts": sorted(set(peer_counts)),
        "max_active_peers": max(peer_counts, default=0),
        "errors": errors[-10:],
    }


async def run_sample(
    sample: int,
    runt_exe: Path,
    env: dict[str, str],
    timeout_secs: float,
    connect_args: dict[str, Any],
    fixture_cell_ids: list[str] | None,
    parallel: int,
) -> dict[str, Any]:
    initialize_started = time.perf_counter()
    client = await McpProcess.start(runt_exe, env, timeout_secs)
    initialize_ms = (time.perf_counter() - initialize_started) * 1000
    try:
        before_ms, before_result, before_error = await measured_tool(
            client, "list_active_notebooks", {}
        )
        monitor_stop = asyncio.Event()
        monitor_task = (
            asyncio.create_task(monitor_active_peers(client, monitor_stop, connect_args))
            if parallel > 1
            else None
        )
        connect_measurements = await asyncio.gather(
            *(measured_tool(client, "connect_notebook", connect_args) for _ in range(parallel))
        )
        monitor_stop.set()
        peer_monitor = await monitor_task if monitor_task is not None else None
        get_all = await measured_tool(client, "get_all_cells", {"format": "json"})
        after_ms, after_result, after_error = await measured_tool(
            client, "list_active_notebooks", {}
        )

        before_value = parse_json_value(tool_text(before_result)) if before_result else None
        after_value = parse_json_value(tool_text(after_result)) if after_result else None
        sample_result = {
            "sample": sample,
            "initialize_ms": round(initialize_ms, 1),
            "active_notebooks_before_ms": round(before_ms, 1),
            "active_notebooks_before": before_value,
            "active_notebooks_before_error": before_error,
            "connects": [
                summarize_connect(elapsed, result, error, fixture_cell_ids)
                for elapsed, result, error in connect_measurements
            ],
            "immediate_get_all_cells": summarize_get_all(*get_all),
            "active_notebooks_after_ms": round(after_ms, 1),
            "active_notebooks_after": after_value,
            "active_notebooks_after_error": after_error,
            "parallel_peer_monitor": peer_monitor,
            "mcp_stderr_tail": client.stderr_lines[-80:],
        }
        actual_ids = sample_result["immediate_get_all_cells"].get("cell_ids", [])
        connects_ok = all(connect["ok"] for connect in sample_result["connects"])
        connect_ids_match_read = all(
            connect.get("cell_ids") == actual_ids
            for connect in sample_result["connects"]
            if connect["ok"]
        )
        connect_notebook_ids = [
            connect["notebook_id"] for connect in sample_result["connects"] if connect["ok"]
        ]
        connect_notebook_ids_consistent = len(set(connect_notebook_ids)) == 1
        active_room_ids = [
            notebook_id
            for room in matching_active_rooms(after_value, connect_args)
            for notebook_id in (normalize_notebook_id(room.get("notebook_id")),)
            if notebook_id is not None
        ]
        connect_notebook_ids_match_active_room = len(active_room_ids) == 1 and all(
            notebook_id == active_room_ids[0] for notebook_id in connect_notebook_ids
        )
        requested_notebook_id_value = connect_args.get("notebook_id")
        requested_notebook_id = normalize_notebook_id(requested_notebook_id_value)
        connect_notebook_ids_match_target = not isinstance(requested_notebook_id_value, str) or (
            requested_notebook_id is not None
            and all(notebook_id == requested_notebook_id for notebook_id in connect_notebook_ids)
        )
        fixture_ids_match = fixture_cell_ids is None or actual_ids == fixture_cell_ids
        sample_result["ok"] = (
            connects_ok
            and connect_ids_match_read
            and connect_notebook_ids_consistent
            and connect_notebook_ids_match_active_room
            and connect_notebook_ids_match_target
            and sample_result["immediate_get_all_cells"]["ok"]
            and fixture_ids_match
        )
        sample_result["connect_cell_ids_match_immediate_read"] = connect_ids_match_read
        sample_result["connect_notebook_ids_consistent"] = connect_notebook_ids_consistent
        sample_result["active_room_notebook_ids"] = active_room_ids
        sample_result["connect_notebook_ids_match_active_room"] = (
            connect_notebook_ids_match_active_room
        )
        sample_result["connect_notebook_ids_match_target"] = connect_notebook_ids_match_target
        sample_result["fixture_cell_ids_match_immediate_read"] = fixture_ids_match
        return sample_result
    finally:
        await client.close()


async def run(args: argparse.Namespace) -> int:
    runt_exe = args.runt_exe.expanduser()
    if not runt_exe.is_absolute():
        runt_exe = (Path.cwd() / runt_exe).resolve()
    if not runt_exe.exists():
        raise RuntimeError(f"runt executable not found: {runt_exe}")

    env = os.environ.copy()
    if not args.system_daemon:
        env["RUNTIMED_DEV"] = "1"
        env["RUNTIMED_WORKSPACE_PATH"] = str(REPO_ROOT)

    status = await daemon_status(runt_exe, env)
    log(f"daemon ready at {status.get('socket_path', 'unknown socket')}")

    fixture_root: Path | None = None
    if args.notebook_id:
        connect_args = {"notebook_id": args.notebook_id}
        target = args.notebook_id
        fixture_cell_ids: list[str] | None = None
    elif args.path:
        target_path = args.path.expanduser().resolve()
        connect_args = {"path": str(target_path)}
        target = str(target_path)
        fixture_cell_ids = None
    else:
        fixture_root = Path(tempfile.mkdtemp(prefix="nteract-mcp-connect-"))
        target_path, fixture_cell_ids = create_fixture(fixture_root, args.fixture_cells)
        connect_args = {"path": str(target_path)}
        target = str(target_path)
        log(f"created {args.fixture_cells}-cell fixture at {target_path}")

    report: dict[str, Any] = {
        "target": target,
        "connect_args": connect_args,
        "fixture_expected_cell_count": (
            len(fixture_cell_ids) if fixture_cell_ids is not None else None
        ),
        "samples_requested": args.samples,
        "parallel_connects": args.parallel,
        "timeout_secs": args.timeout_secs,
        "daemon": {
            key: status.get(key)
            for key in ("pid", "version", "socket_path", "worktree_path")
            if key in status
        },
        "samples": [],
    }

    try:
        for sample in range(1, args.samples + 1):
            log(f"running sample {sample}/{args.samples}")
            report["samples"].append(
                await run_sample(
                    sample,
                    runt_exe,
                    env,
                    args.timeout_secs,
                    connect_args,
                    fixture_cell_ids,
                    args.parallel,
                )
            )
    finally:
        if fixture_root is not None:
            if args.keep_fixture:
                report["fixture_kept_at"] = str(fixture_root)
            else:
                shutil.rmtree(fixture_root, ignore_errors=True)

    report["ok"] = all(sample["ok"] for sample in report["samples"])
    encoded = json.dumps(report, indent=2, sort_keys=True)
    print(encoded)
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(encoded + "\n", encoding="utf-8")
        log(f"wrote report to {args.report}")
    return 0 if report["ok"] else 1


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "runt_exe",
        nargs="?",
        type=Path,
        default=Path("target/debug/runt"),
        help="Path to the runt executable (default: target/debug/runt)",
    )
    target = parser.add_mutually_exclusive_group()
    target.add_argument("--path", type=Path, help="Existing .ipynb path to connect")
    target.add_argument(
        "--notebook-id", type=notebook_id_arg, help="Existing daemon room UUID to connect"
    )
    parser.add_argument(
        "--fixture-cells",
        type=int,
        default=32,
        help="Cells in the generated fixture when no target is supplied (default: 32)",
    )
    parser.add_argument("--samples", type=int, default=3, help="Fresh MCP processes to profile")
    parser.add_argument(
        "--parallel",
        type=int,
        default=1,
        help="Concurrent connect_notebook calls per MCP process (default: 1)",
    )
    parser.add_argument(
        "--timeout-secs",
        type=float,
        default=125,
        help="Per-request timeout; default exceeds MCP's current 120s readiness wait",
    )
    parser.add_argument("--report", type=Path, help="Also write the JSON report to this path")
    parser.add_argument("--keep-fixture", action="store_true")
    parser.add_argument(
        "--system-daemon",
        action="store_true",
        help="Do not force per-worktree RUNTIMED_DEV environment variables",
    )
    args = parser.parse_args()
    if args.fixture_cells < 0:
        parser.error("--fixture-cells must be >= 0")
    if args.samples < 1:
        parser.error("--samples must be >= 1")
    if args.parallel < 1:
        parser.error("--parallel must be >= 1")
    if args.timeout_secs <= 0:
        parser.error("--timeout-secs must be > 0")
    if args.report:
        args.report = args.report.expanduser().resolve()
    return args


def main() -> None:
    try:
        raise SystemExit(asyncio.run(run(parse_args())))
    except KeyboardInterrupt:
        raise SystemExit(130) from None
    except Exception as error:
        log(f"ERROR: {error}")
        raise SystemExit(2) from None


if __name__ == "__main__":
    main()
