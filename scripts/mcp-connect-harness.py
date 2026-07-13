#!/usr/bin/env python3
"""Exercise progressive MCP notebook connections against a running daemon.

The harness speaks MCP JSON-RPC directly over stdio, so it has no Python
package dependencies. By default it preserves the original basic profile: it
creates a temporary notebook with stable cell IDs, starts a fresh ``runt mcp``
child for each sample, and checks cold/warm projection responses plus eventual
document convergence. An immediate document read may now return the structured
``notebook_not_ready`` state; the harness records that transition and polls
until the document is usable.

Start the isolated daemon in another terminal first::

    cargo xtask dev-daemon

Then run a cold/warm profile::

    python3 scripts/mcp-connect-harness.py target/debug/runt \
        --fixture-cells 64 --samples 3

Use ``--parallel 2`` to probe duplicate connects against one MCP process.
Use ``--suite progressive`` to add same-target coalescing, target-switch, and
degraded-source scenarios. The progressive suite also starts one MCP child
with its NotebookDoc sync reactor deliberately stalled after handshake. This
proves that projection reads stay available while mutation and execution gates
remain closed, without changing the daemon used by the rest of the profile.
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
AUTOMERGE_HEAD_RE = re.compile(r"^[0-9a-f]{64}$")
TRANSIENT_READINESS_CODES = {"notebook_not_ready"}
# asyncio's subprocess streams otherwise inherit a 64 KiB line limit. MCP
# stdio frames are newline-delimited JSON and a legitimate notebook response
# can exceed that even when the progressive projection itself stays bounded.
MCP_STDIO_LIMIT_BYTES = 16 * 1024 * 1024


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


def tool_payload(result: dict[str, Any]) -> Any | None:
    """Return structured MCP content, falling back to the text representation."""

    for key in ("structuredContent", "structured_content"):
        value = result.get(key)
        if value is not None:
            return value
    return parse_json_value(tool_text(result))


def structured_error(result: dict[str, Any]) -> tuple[str | None, dict[str, Any]]:
    payload = tool_payload(result)
    if not isinstance(payload, dict):
        return None, {}
    error = payload.get("error")
    if not isinstance(error, dict):
        return None, payload
    code = error.get("code")
    return (code if isinstance(code, str) else None), payload


def readiness_transition_errors(code: str | None, payload: dict[str, Any]) -> list[str]:
    if code != "notebook_not_ready":
        return []
    errors: list[str] = []
    session = payload.get("session")
    if not isinstance(session, dict):
        return ["notebook_not_ready must carry structured session state"]
    generation = session.get("session_generation")
    if not isinstance(generation, int) or isinstance(generation, bool) or generation < 1:
        errors.append("notebook_not_ready session_generation must be positive")
    if not isinstance(session.get("source_state"), dict):
        errors.append("notebook_not_ready must carry source_state")
    for field in (
        "projection_ready",
        "document_ready",
        "runtime_ready",
        "interactive",
    ):
        if not isinstance(session.get(field), bool):
            errors.append(f"notebook_not_ready session.{field} must be boolean")
    capabilities = session.get("capabilities")
    if not isinstance(capabilities, dict):
        errors.append("notebook_not_ready must carry capabilities")
    else:
        for capability in ("read", "mutate", "execute"):
            if not isinstance(capabilities.get(capability), bool):
                errors.append(
                    f"notebook_not_ready session.capabilities.{capability} must be boolean"
                )
        if capabilities.get("mutate") is True or capabilities.get("execute") is True:
            errors.append("notebook_not_ready must keep mutate/execute capabilities closed")
    return errors


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
        self.stdout_reader_error: RuntimeError | None = None
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
            limit=MCP_STDIO_LIMIT_BYTES,
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
        try:
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
        except BaseException as error:
            if isinstance(error, asyncio.CancelledError):
                raise
            self.stdout_reader_error = RuntimeError(
                "MCP stdout reader failed before a response was decoded: "
                f"{type(error).__name__}: {error}"
            )

        error = self.stdout_reader_error or RuntimeError(
            f"MCP process exited before replying (exit={self.process.returncode})"
        )
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
            if self.stdout_reader_error is not None:
                raise self.stdout_reader_error from None
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


def create_fixture(
    root: Path,
    cell_count: int,
    *,
    filename: str = "mcp-connect-harness.ipynb",
    cell_id_prefix: str = "harness",
) -> tuple[Path, list[str]]:
    cell_ids = [f"{cell_id_prefix}-{index:06d}" for index in range(cell_count)]
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
    path = root / filename
    path.write_text(json.dumps(notebook), encoding="utf-8")
    return path, cell_ids


def create_degraded_fixture(root: Path) -> Path:
    path = root / "mcp-connect-harness-degraded.ipynb"
    path.write_text('{"cells": [', encoding="utf-8")
    return path


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
    response = tool_payload(result)
    response_object = response if isinstance(response, dict) else {}
    error_code, error_payload = structured_error(result)
    transition_errors = readiness_transition_errors(error_code, error_payload)
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
    contract_errors = progressive_contract_errors(response_object) if not is_error else []
    response_valid = (
        notebook_id is not None
        and response_kind in {"formatted", "structured"}
        and not contract_errors
    )
    summary: dict[str, Any] = {
        "elapsed_ms": round(elapsed_ms, 1),
        "ok": not is_error and response_valid,
        "tool_error": is_error,
        "error_code": error_code,
        "structured_state_errors": transition_errors,
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
        "session_generation": response_object.get("session_generation"),
        "source_state": response_object.get("source_state"),
        "readiness": response_object.get("readiness"),
        "projection": response_object.get("projection"),
        "capabilities": response_object.get("capabilities"),
        "contract_errors": contract_errors,
    }
    if is_error or not response_valid:
        summary["error_payload"] = error_payload
        summary["response_text"] = text[-4000:]
    return summary


def progressive_contract_errors(response: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    projected_cell_ids, _ = connect_cell_ids(response)
    if len(projected_cell_ids) != len(set(projected_cell_ids)):
        errors.append("projection cell IDs must be unique")
    generation = response.get("session_generation")
    if not isinstance(generation, int) or isinstance(generation, bool) or generation < 1:
        errors.append("session_generation must be a positive integer")

    source_state = response.get("source_state")
    if not isinstance(source_state, dict):
        errors.append("source_state must be an object")
    else:
        state_name = next(
            (
                source_state.get(key)
                for key in ("phase", "state", "kind")
                if isinstance(source_state.get(key), str)
            ),
            None,
        )
        if not state_name:
            errors.append("source_state must name its phase/state/kind")
        elif state_name not in {"preparing", "publishing", "ready", "failed"}:
            errors.append(f"source_state has unknown phase/state/kind: {state_name}")
        source_generation = source_state.get("generation")
        if (
            not isinstance(source_generation, int)
            or isinstance(source_generation, bool)
            or source_generation < 0
        ):
            errors.append("source_state.generation must be a non-negative integer")
        fingerprint = source_state.get("fingerprint")
        if fingerprint is not None and (
            not isinstance(fingerprint, str) or not AUTOMERGE_HEAD_RE.fullmatch(fingerprint)
        ):
            errors.append("source_state.fingerprint must be a 64-character hex digest")
        progress = source_state.get("progress")
        if not isinstance(progress, dict):
            errors.append("source_state.progress must be an object")
        else:
            completed = progress.get("completed")
            total = progress.get("total")
            if not isinstance(completed, int) or isinstance(completed, bool) or completed < 0:
                errors.append("source_state.progress.completed must be non-negative")
            if total is not None and (
                not isinstance(total, int) or isinstance(total, bool) or total < 0
            ):
                errors.append("source_state.progress.total must be null or non-negative")
        retry = source_state.get("retry")
        if not isinstance(retry, str) or not retry:
            errors.append("source_state.retry must be a non-empty string")
        if state_name == "failed" and not isinstance(source_state.get("error_code"), str):
            errors.append("failed source_state must carry error_code")
        if state_name == "failed" and not isinstance(source_state.get("error_message"), str):
            errors.append("failed source_state must carry error_message")

    readiness = response.get("readiness")
    readiness_values: dict[str, bool] = {}
    if not isinstance(readiness, dict):
        errors.append("readiness must be an object")
    else:
        for axis in ("projection", "document", "runtime", "interactive"):
            value = readiness.get(axis)
            if not isinstance(value, bool):
                errors.append(f"readiness.{axis} must be boolean")
            else:
                readiness_values[axis] = value
        if readiness_values.get("projection") is not True:
            errors.append("connect_notebook success must be ProjectionReady")
        if readiness_values.get("interactive") and readiness_values.get("document") is not True:
            errors.append("Interactive readiness requires document readiness")

    projection = response.get("projection")
    if not isinstance(projection, dict):
        errors.append("projection must be an object")
    else:
        for key in ("heads", "runtime_state_heads"):
            heads = projection.get(key)
            if not isinstance(heads, list) or not heads:
                errors.append(f"projection.{key} must be a non-empty list")
                continue
            if not all(
                isinstance(head, str) and AUTOMERGE_HEAD_RE.fullmatch(head) for head in heads
            ):
                errors.append(f"projection.{key} contains an invalid Automerge head")
        completeness = projection.get("completeness")
        if completeness not in {
            "complete_cell_index_bounded_source_preview",
            "partial_cell_index_bounded_source_preview",
        }:
            errors.append("projection.completeness must describe the bounded cell projection")

    capabilities = response.get("capabilities")
    capability_values: dict[str, bool] = {}
    if not isinstance(capabilities, dict):
        errors.append("capabilities must be an object")
    else:
        for capability in ("read", "mutate", "execute"):
            value = capabilities.get(capability)
            if not isinstance(value, bool):
                errors.append(f"capabilities.{capability} must be boolean")
            else:
                capability_values[capability] = value

    if capability_values.get("mutate") and readiness_values.get("interactive") is not True:
        errors.append("mutation capability opened before Interactive")
    if readiness_values.get("projection") and capability_values.get("read") is not True:
        errors.append("projection readiness must expose read capability")
    if capability_values.get("execute") and (
        readiness_values.get("interactive") is not True
        or readiness_values.get("runtime") is not True
    ):
        errors.append("execution capability opened before runtime/Interactive readiness")
    return errors


def projected_ids_match_document(connect: dict[str, Any], document_ids: list[str]) -> bool:
    projected_ids = connect.get("cell_ids")
    if not isinstance(projected_ids, list) or len(projected_ids) != len(set(projected_ids)):
        return False
    projection = connect.get("projection")
    completeness = projection.get("completeness") if isinstance(projection, dict) else None
    if completeness == "complete_cell_index_bounded_source_preview":
        return projected_ids == document_ids

    document_positions = {cell_id: index for index, cell_id in enumerate(document_ids)}
    try:
        positions = [document_positions[cell_id] for cell_id in projected_ids]
    except (KeyError, TypeError):
        return False
    return positions == sorted(positions)


def summarize_get_all(
    elapsed_ms: float,
    result: dict[str, Any] | None,
    error: str | None,
) -> dict[str, Any]:
    if error is not None or result is None:
        return {"elapsed_ms": round(elapsed_ms, 1), "ok": False, "error": error}
    text = tool_text(result)
    value = tool_payload(result)
    projection_details = (
        value if isinstance(value, dict) and isinstance(value.get("cells"), list) else None
    )
    cells = (
        value
        if isinstance(value, list)
        else projection_details.get("cells", [])
        if projection_details is not None
        else []
    )
    cell_ids = [
        cell["cell_id"]
        for cell in cells
        if isinstance(cell, dict) and isinstance(cell.get("cell_id"), str)
    ]
    is_error = bool(result.get("isError"))
    error_code, error_payload = structured_error(result)
    transition_errors = readiness_transition_errors(error_code, error_payload)
    cell_ids_unique = len(cell_ids) == len(set(cell_ids))
    valid_payload = isinstance(value, list) or projection_details is not None
    summary: dict[str, Any] = {
        "elapsed_ms": round(elapsed_ms, 1),
        "ok": not is_error and valid_payload and cell_ids_unique,
        "tool_error": is_error,
        "error_code": error_code,
        "structured_state_errors": transition_errors,
        "projection_only": projection_details is not None,
        "cell_count": len(cell_ids),
        "cell_ids_unique": cell_ids_unique,
        "cell_id_sample": cell_ids[:5],
        "cell_ids": cell_ids,
    }
    if projection_details is not None:
        raw_readiness = projection_details.get("readiness")
        if isinstance(raw_readiness, dict):
            summary["readiness"] = {
                "projection": raw_readiness.get("projection_ready"),
                "document": raw_readiness.get("document_ready"),
                "runtime": raw_readiness.get("runtime_ready"),
                "interactive": raw_readiness.get("interactive"),
            }
            summary["capabilities"] = raw_readiness.get("capabilities")
        summary["projection"] = projection_details.get("projection")
    if is_error or not valid_payload:
        summary["error_payload"] = error_payload
        summary["response_text"] = text[-4000:]
    return summary


def summarize_generic_tool(
    elapsed_ms: float,
    result: dict[str, Any] | None,
    error: str | None,
) -> dict[str, Any]:
    if error is not None or result is None:
        return {"elapsed_ms": round(elapsed_ms, 1), "ok": False, "error": error}
    error_code, payload = structured_error(result)
    transition_errors = readiness_transition_errors(error_code, payload)
    is_error = bool(result.get("isError"))
    return {
        "elapsed_ms": round(elapsed_ms, 1),
        "ok": not is_error,
        "tool_error": is_error,
        "error_code": error_code,
        "structured_state_errors": transition_errors,
        "payload": payload,
        "response_text": tool_text(result)[-4000:] if is_error else None,
    }


def summarized_runtime_gate(summary: dict[str, Any]) -> tuple[bool, bool] | None:
    """Extract an observed ``(runtime_ready, execute_capable)`` gate state."""

    readiness = summary.get("readiness")
    capabilities = summary.get("capabilities")
    if isinstance(readiness, dict) and isinstance(capabilities, dict):
        runtime_ready = readiness.get("runtime")
        execute_capable = capabilities.get("execute")
        if isinstance(runtime_ready, bool) and isinstance(execute_capable, bool):
            return runtime_ready, execute_capable

    payload = summary.get("error_payload")
    session = payload.get("session") if isinstance(payload, dict) else None
    capabilities = session.get("capabilities") if isinstance(session, dict) else None
    if isinstance(session, dict) and isinstance(capabilities, dict):
        runtime_ready = session.get("runtime_ready")
        execute_capable = capabilities.get("execute")
        if isinstance(runtime_ready, bool) and isinstance(execute_capable, bool):
            return runtime_ready, execute_capable
    return None


def validate_runtime_not_ready(samples: list[dict[str, Any]]) -> dict[str, Any]:
    """Require advertised and exercised proof that execution stayed closed."""

    observations: list[dict[str, Any]] = []
    execute_probe_evidence: list[dict[str, Any]] = []
    transition_codes: set[str] = set()
    for sample_index, sample in enumerate(samples, start=1):
        candidates: list[tuple[str, dict[str, Any]]] = [
            (f"sample[{sample_index}].connect[{connect_index}]", connect)
            for connect_index, connect in enumerate(sample.get("connects", []), start=1)
            if isinstance(connect, dict)
        ]
        for probe_name in ("document_convergence", "interactive_noop_mutation_probe"):
            probe = sample.get(probe_name)
            if not isinstance(probe, dict):
                continue
            transition_codes.update(
                code for code in probe.get("transient_error_codes", []) if isinstance(code, str)
            )
            candidates.extend(
                (f"sample[{sample_index}].{probe_name}.{phase}", summary)
                for phase in ("immediate", "final")
                for summary in (probe.get(phase),)
                if isinstance(summary, dict)
            )

        for location, candidate in candidates:
            state = summarized_runtime_gate(candidate)
            if state is None:
                continue
            runtime_ready, execute_capable = state
            observations.append(
                {
                    "location": location,
                    "runtime_ready": runtime_ready,
                    "execute_capable": execute_capable,
                }
            )

        execute_probe = sample.get("runtime_execute_probe")
        if (
            isinstance(execute_probe, dict)
            and execute_probe.get("skipped") is not True
            and execute_probe.get("error_code") == "notebook_not_ready"
            and not execute_probe.get("structured_state_errors")
        ):
            execute_probe_evidence.append(
                {
                    "location": f"sample[{sample_index}].runtime_execute_probe",
                    "error_code": "notebook_not_ready",
                }
            )

    runtime_closed = [item for item in observations if item["runtime_ready"] is False]
    gate_closed = [item for item in runtime_closed if item["execute_capable"] is False]
    return {
        "ok": bool(gate_closed) and bool(execute_probe_evidence),
        "observed": bool(runtime_closed),
        "runtime_closed_observed": bool(runtime_closed),
        "execute_and_runtime_closed_observed": bool(gate_closed),
        "closed_gate_evidence": gate_closed,
        "execute_probe_evidence": execute_probe_evidence,
        "structured_transition_codes": sorted(transition_codes),
        "note": (
            "runtime and execute readiness were closed and execute_cell returned notebook_not_ready"
            if gate_closed and execute_probe_evidence
            else "no sample proved both the advertised and exercised execution gate"
        ),
    }


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


async def poll_document_until_interactive(
    client: McpProcess,
    *,
    ready_timeout_secs: float,
    poll_interval_ms: float,
) -> dict[str, Any]:
    """Poll the document read gate through structured not-ready transitions.

    The MCP surface currently has no side-effect-free session-status tool. A
    successful document read is therefore the harness's observable boundary
    for local convergence. The connect response separately proves whether the
    session already advertised ``Interactive`` and mutation capabilities.
    """

    started = time.perf_counter()
    attempts: list[dict[str, Any]] = []
    while True:
        summary = summarize_get_all(
            *await measured_tool(client, "get_all_cells", {"format": "json"})
        )
        attempts.append(summary)
        if summary["ok"] and not summary.get("projection_only"):
            break
        if not summary["ok"] and summary.get("error_code") not in TRANSIENT_READINESS_CODES:
            break
        if time.perf_counter() - started >= ready_timeout_secs:
            break
        await asyncio.sleep(poll_interval_ms / 1000)

    final = attempts[-1]
    transient_codes = [
        attempt["error_code"]
        for attempt in attempts
        if attempt.get("error_code") in TRANSIENT_READINESS_CODES
    ]
    structured_transitions_valid = all(
        not attempt.get("structured_state_errors") for attempt in attempts
    )
    return {
        "ok": final["ok"] and not final.get("projection_only") and structured_transitions_valid,
        "attempt_count": len(attempts),
        "elapsed_ms": round((time.perf_counter() - started) * 1000, 1),
        "immediate": attempts[0],
        "final": final,
        "transient_error_codes": sorted(set(transient_codes)),
        "notebook_not_ready_observed": "notebook_not_ready" in transient_codes,
        "projection_only_observed": any(
            attempt.get("projection_only") is True for attempt in attempts
        ),
        "structured_transitions_valid": structured_transitions_valid,
        "timed_out": (
            (
                final.get("projection_only") is True
                or (not final["ok"] and final.get("error_code") in TRANSIENT_READINESS_CODES)
            )
            and time.perf_counter() - started >= ready_timeout_secs
        ),
    }


async def poll_noop_mutation_until_interactive(
    client: McpProcess,
    *,
    cell_id: str | None,
    ready_timeout_secs: float,
    poll_interval_ms: float,
) -> dict[str, Any]:
    """Prove the mutation gate opens without changing notebook state.

    ``set_cell`` with an existing ID and no updates is explicitly a no-op, but
    it still passes through the centralized DocumentMutation gate. That makes
    it a safe observable for the exact ``Interactive`` boundary.
    """

    if cell_id is None:
        return {
            "ok": True,
            "skipped": True,
            "reason": "projection contained no cell suitable for a no-op mutation probe",
            "attempt_count": 0,
            "notebook_not_ready_observed": False,
        }

    started = time.perf_counter()
    attempts: list[dict[str, Any]] = []
    while True:
        summary = summarize_generic_tool(
            *await measured_tool(client, "set_cell", {"cell_id": cell_id})
        )
        attempts.append(summary)
        if summary["ok"]:
            break
        if summary.get("error_code") not in TRANSIENT_READINESS_CODES:
            break
        if time.perf_counter() - started >= ready_timeout_secs:
            break
        await asyncio.sleep(poll_interval_ms / 1000)

    final = attempts[-1]
    transient_codes = [
        attempt["error_code"]
        for attempt in attempts
        if attempt.get("error_code") in TRANSIENT_READINESS_CODES
    ]
    structured_transitions_valid = all(
        not attempt.get("structured_state_errors") for attempt in attempts
    )
    return {
        "ok": final["ok"] and structured_transitions_valid,
        "skipped": False,
        "cell_id": cell_id,
        "attempt_count": len(attempts),
        "elapsed_ms": round((time.perf_counter() - started) * 1000, 1),
        "immediate": attempts[0],
        "final": final,
        "transient_error_codes": sorted(set(transient_codes)),
        "notebook_not_ready_observed": "notebook_not_ready" in transient_codes,
        "structured_transitions_valid": structured_transitions_valid,
    }


async def run_sample(
    sample: int,
    runt_exe: Path,
    env: dict[str, str],
    timeout_secs: float,
    connect_args: dict[str, Any],
    fixture_cell_ids: list[str] | None,
    parallel: int,
    ready_timeout_secs: float,
    poll_interval_ms: float,
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
        connect_summaries = [
            summarize_connect(elapsed, result, error, fixture_cell_ids)
            for elapsed, result, error in connect_measurements
        ]
        mutation_probe_cell_id = next(
            (
                cell_id
                for connect in connect_summaries
                for cell_id in connect.get("cell_ids", [])[:1]
            ),
            None,
        )
        runtime_execute_probe = {
            "ok": True,
            "skipped": True,
            "reason": "connect response did not advertise a closed runtime/execute gate",
        }
        runtime_gate_is_closed = any(
            isinstance(connect.get("readiness"), dict)
            and connect["readiness"].get("runtime") is False
            and isinstance(connect.get("capabilities"), dict)
            and connect["capabilities"].get("execute") is False
            for connect in connect_summaries
        )
        if runtime_gate_is_closed and mutation_probe_cell_id is not None:
            runtime_execute_probe = summarize_generic_tool(
                *await measured_tool(
                    client,
                    "execute_cell",
                    {"cell_id": mutation_probe_cell_id, "timeout_secs": 0.1},
                )
            )
            runtime_execute_probe["expected_error_code"] = "notebook_not_ready"
            runtime_execute_probe["gate_proved"] = runtime_execute_probe.get(
                "error_code"
            ) == "notebook_not_ready" and not runtime_execute_probe.get("structured_state_errors")
        convergence, interactive_probe = await asyncio.gather(
            poll_document_until_interactive(
                client,
                ready_timeout_secs=ready_timeout_secs,
                poll_interval_ms=poll_interval_ms,
            ),
            poll_noop_mutation_until_interactive(
                client,
                cell_id=mutation_probe_cell_id,
                ready_timeout_secs=ready_timeout_secs,
                poll_interval_ms=poll_interval_ms,
            ),
        )
        after_ms, after_result, after_error = await measured_tool(
            client, "list_active_notebooks", {}
        )

        before_value = tool_payload(before_result) if before_result else None
        after_value = tool_payload(after_result) if after_result else None
        sample_result = {
            "sample": sample,
            "profile_phase": "cold" if sample == 1 else "warm",
            "initialize_ms": round(initialize_ms, 1),
            "active_notebooks_before_ms": round(before_ms, 1),
            "active_notebooks_before": before_value,
            "active_notebooks_before_error": before_error,
            "connects": connect_summaries,
            "document_convergence": convergence,
            "interactive_noop_mutation_probe": interactive_probe,
            "runtime_execute_probe": runtime_execute_probe,
            # Compatibility alias for consumers of the original report.
            "immediate_get_all_cells": convergence["immediate"],
            "active_notebooks_after_ms": round(after_ms, 1),
            "active_notebooks_after": after_value,
            "active_notebooks_after_error": after_error,
            "parallel_peer_monitor": peer_monitor,
            "mcp_stderr_tail": client.stderr_lines[-80:],
        }
        immediate_ids = convergence["immediate"].get("cell_ids", [])
        actual_ids = convergence["final"].get("cell_ids", [])
        connects_ok = all(connect["ok"] for connect in sample_result["connects"])
        connect_ids_match_read = all(
            projected_ids_match_document(connect, actual_ids)
            for connect in sample_result["connects"]
            if connect["ok"]
        )
        connect_notebook_ids = [
            connect["notebook_id"] for connect in sample_result["connects"] if connect["ok"]
        ]
        connect_notebook_ids_consistent = len(set(connect_notebook_ids)) == 1
        connect_generations = [
            connect.get("session_generation")
            for connect in sample_result["connects"]
            if connect["ok"]
        ]
        same_target_generation_coalesced = (
            len(connect_generations) == parallel and len(set(connect_generations)) == 1
        )
        projection_signatures = [
            (
                tuple(connect.get("projection", {}).get("heads", [])),
                tuple(connect.get("projection", {}).get("runtime_state_heads", [])),
                connect.get("projection", {}).get("completeness"),
            )
            for connect in sample_result["connects"]
            if connect["ok"] and isinstance(connect.get("projection"), dict)
        ]
        same_target_projection_coalesced = (
            len(projection_signatures) == parallel and len(set(projection_signatures)) == 1
        )
        parallel_peer_count_bounded = (
            peer_monitor is None or peer_monitor.get("max_active_peers", 0) <= 1
        )
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
            and same_target_generation_coalesced
            and same_target_projection_coalesced
            and parallel_peer_count_bounded
            and connect_notebook_ids_match_active_room
            and connect_notebook_ids_match_target
            and convergence["ok"]
            and interactive_probe["ok"]
            and fixture_ids_match
        )
        sample_result["connect_cell_ids_match_immediate_read"] = (
            all(
                projected_ids_match_document(connect, immediate_ids)
                for connect in sample_result["connects"]
                if connect["ok"]
            )
            if convergence["immediate"]["ok"]
            else None
        )
        sample_result["connect_cell_ids_match_eventual_read"] = connect_ids_match_read
        sample_result["connect_notebook_ids_consistent"] = connect_notebook_ids_consistent
        sample_result["same_target_generation_coalesced"] = same_target_generation_coalesced
        sample_result["same_target_projection_coalesced"] = same_target_projection_coalesced
        sample_result["parallel_peer_count_bounded"] = parallel_peer_count_bounded
        sample_result["connect_session_generations"] = connect_generations
        sample_result["active_room_notebook_ids"] = active_room_ids
        sample_result["connect_notebook_ids_match_active_room"] = (
            connect_notebook_ids_match_active_room
        )
        sample_result["connect_notebook_ids_match_target"] = connect_notebook_ids_match_target
        sample_result["fixture_cell_ids_match_immediate_read"] = (
            (fixture_cell_ids is None or immediate_ids == fixture_cell_ids)
            if convergence["immediate"]["ok"]
            else None
        )
        sample_result["fixture_cell_ids_match_eventual_read"] = fixture_ids_match
        sample_result["runtime_not_ready_observed"] = any(
            connect.get("readiness", {}).get("runtime") is False
            for connect in sample_result["connects"]
            if isinstance(connect.get("readiness"), dict)
        )
        sample_result["progressive_transition_observed"] = (
            convergence.get("projection_only_observed") is True
            or interactive_probe.get("notebook_not_ready_observed") is True
        )
        return sample_result
    finally:
        await client.close()


def summary_generation(summary: dict[str, Any]) -> int | None:
    generation = summary.get("session_generation")
    if isinstance(generation, int) and not isinstance(generation, bool):
        return generation
    payload = summary.get("error_payload")
    if isinstance(payload, dict) and isinstance(payload.get("error"), dict):
        generation = payload["error"].get("session_generation")
        if isinstance(generation, int) and not isinstance(generation, bool):
            return generation
    return None


async def run_target_switch_scenario(
    runt_exe: Path,
    env: dict[str, str],
    timeout_secs: float,
    first_args: dict[str, Any],
    first_cell_ids: list[str] | None,
    second_args: dict[str, Any],
    second_cell_ids: list[str] | None,
    switch_delay_ms: float,
    ready_timeout_secs: float,
    poll_interval_ms: float,
) -> dict[str, Any]:
    client = await McpProcess.start(runt_exe, env, timeout_secs)
    try:
        first_task = asyncio.create_task(measured_tool(client, "connect_notebook", first_args))
        await asyncio.sleep(switch_delay_ms / 1000)
        second_measurement = await measured_tool(client, "connect_notebook", second_args)
        first_measurement = await first_task
        first = summarize_connect(*first_measurement, first_cell_ids)
        second = summarize_connect(*second_measurement, second_cell_ids)
        mutation_probe_cell_id = next(iter(second.get("cell_ids", [])), None)
        convergence, interactive_probe = await asyncio.gather(
            poll_document_until_interactive(
                client,
                ready_timeout_secs=ready_timeout_secs,
                poll_interval_ms=poll_interval_ms,
            ),
            poll_noop_mutation_until_interactive(
                client,
                cell_id=mutation_probe_cell_id,
                ready_timeout_secs=ready_timeout_secs,
                poll_interval_ms=poll_interval_ms,
            ),
        )
        _, active_result, active_error = await measured_tool(client, "list_active_notebooks", {})
        active_value = tool_payload(active_result) if active_result is not None else None

        final_ids = convergence["final"].get("cell_ids", [])
        second_ids_match = second_cell_ids is None or final_ids == second_cell_ids
        second_projection_ids_stable = projected_ids_match_document(second, final_ids)
        first_generation = summary_generation(first)
        second_generation = summary_generation(second)
        generations_ordered = (
            first_generation is not None
            and second_generation is not None
            and second_generation > first_generation
        )
        supersession_observed = first.get("error_code") == "session_superseded"
        active_rooms = matching_active_rooms(active_value, second_args)
        active_matches_second = len(active_rooms) == 1
        return {
            "ok": (
                supersession_observed
                and second["ok"]
                and generations_ordered
                and convergence["ok"]
                and interactive_probe["ok"]
                and second_ids_match
                and second_projection_ids_stable
                and active_matches_second
                and active_error is None
            ),
            "first_connect": first,
            "second_connect": second,
            "first_generation": first_generation,
            "second_generation": second_generation,
            "generations_ordered": generations_ordered,
            "supersession_observed": supersession_observed,
            "note": (
                "first activation was explicitly superseded"
                if supersession_observed
                else "overlapping first activation was not rejected as session_superseded"
            ),
            "document_convergence": convergence,
            "interactive_noop_mutation_probe": interactive_probe,
            "final_cell_ids_match_second_target": second_ids_match,
            "projection_cell_ids_match_second_document": second_projection_ids_stable,
            "active_notebooks": active_value,
            "active_notebooks_error": active_error,
            "active_room_matches_second_target": active_matches_second,
            "mcp_stderr_tail": client.stderr_lines[-80:],
        }
    finally:
        await client.close()


async def run_degraded_source_scenario(
    runt_exe: Path,
    env: dict[str, str],
    timeout_secs: float,
    degraded_path: Path,
) -> dict[str, Any]:
    client = await McpProcess.start(runt_exe, env, timeout_secs)
    try:
        measurement = await measured_tool(client, "connect_notebook", {"path": str(degraded_path)})
        summary = summarize_connect(*measurement, None)
        return {
            "ok": summary.get("tool_error") is True
            and summary.get("error_code") == "source_degraded",
            "expected_error_code": "source_degraded",
            "connect": summary,
            "false_success_observed": summary.get("ok") is True,
            "mcp_stderr_tail": client.stderr_lines[-80:],
        }
    finally:
        await client.close()


def validate_stalled_peer_observation(
    connect: dict[str, Any],
    projection_read: dict[str, Any],
    mutation_attempts: list[dict[str, Any]],
    execution_attempts: list[dict[str, Any]],
) -> dict[str, Any]:
    """Validate projection availability and closed document/runtime gates."""

    readiness = connect.get("readiness")
    capabilities = connect.get("capabilities")
    closed_interactive_caps = (
        isinstance(readiness, dict)
        and readiness.get("projection") is True
        and readiness.get("interactive") is False
        and isinstance(capabilities, dict)
        and capabilities.get("mutate") is False
        and capabilities.get("execute") is False
    )
    projection_available = (
        projection_read.get("ok") is True and projection_read.get("projection_only") is True
    )
    mutation_remained_not_ready = bool(mutation_attempts) and all(
        attempt.get("error_code") == "notebook_not_ready"
        and not attempt.get("structured_state_errors")
        for attempt in mutation_attempts
    )
    execution_remained_not_ready = bool(execution_attempts) and all(
        attempt.get("error_code") == "notebook_not_ready"
        and not attempt.get("structured_state_errors")
        for attempt in execution_attempts
    )
    return {
        "ok": (
            connect.get("ok") is True
            and closed_interactive_caps
            and projection_available
            and mutation_remained_not_ready
            and execution_remained_not_ready
        ),
        "mutation_attempt_count": len(mutation_attempts),
        "execution_attempt_count": len(execution_attempts),
        "observed_error_codes": sorted(
            {
                attempt["error_code"]
                for attempt in mutation_attempts + execution_attempts
                if isinstance(attempt.get("error_code"), str)
            }
        ),
        "closed_interactive_capabilities": closed_interactive_caps,
        "projection_read_available": projection_available,
        "mutation_remained_structured_notebook_not_ready": mutation_remained_not_ready,
        "execution_remained_structured_notebook_not_ready": execution_remained_not_ready,
    }


async def run_stalled_peer_scenario(
    runt_exe: Path,
    env: dict[str, str],
    timeout_secs: float,
    connect_args: dict[str, Any],
    observe_secs: float,
) -> dict[str, Any]:
    """Hold one MCP peer's NotebookDoc reactor behind its retained projection."""

    fault_env = env.copy()
    fault_env["NTERACT_NOTEBOOK_SYNC_FAULT"] = "stall-notebook-convergence"
    client = await McpProcess.start(runt_exe, fault_env, timeout_secs)
    try:
        connect = summarize_connect(
            *await measured_tool(client, "connect_notebook", connect_args),
            None,
        )
        projection_read = summarize_get_all(
            *await measured_tool(client, "get_all_cells", {"format": "json"})
        )
        cell_id = next(iter(connect.get("cell_ids", [])), None)
        mutation_attempts: list[dict[str, Any]] = []
        execution_attempts: list[dict[str, Any]] = []
        started = time.perf_counter()
        while cell_id is not None and (
            not mutation_attempts or time.perf_counter() - started < observe_secs
        ):
            mutation_attempts.append(
                summarize_generic_tool(
                    *await measured_tool(client, "set_cell", {"cell_id": cell_id})
                )
            )
            execution_attempts.append(
                summarize_generic_tool(
                    *await measured_tool(
                        client,
                        "execute_cell",
                        {"cell_id": cell_id, "timeout_secs": 0.1},
                    )
                )
            )
            remaining = observe_secs - (time.perf_counter() - started)
            if remaining > 0:
                await asyncio.sleep(min(0.05, remaining))

        validation = validate_stalled_peer_observation(
            connect,
            projection_read,
            mutation_attempts,
            execution_attempts,
        )
        return {
            **validation,
            "supported": True,
            "status": "exercised",
            "target": connect_args,
            "requested_observation_secs": observe_secs,
            "elapsed_ms": round((time.perf_counter() - started) * 1000, 1),
            "connect": connect,
            "projection_read": projection_read,
            "mutation_attempts": mutation_attempts,
            "execution_attempts": execution_attempts,
            "mcp_stderr_tail": client.stderr_lines[-80:],
        }
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

    effective_samples = max(args.samples, 2) if args.suite == "progressive" else args.samples
    effective_parallel = max(args.parallel, 2) if args.suite == "progressive" else args.parallel
    if effective_samples != args.samples or effective_parallel != args.parallel:
        log(
            "progressive suite expanded the basic profile to "
            f"{effective_samples} samples and {effective_parallel} parallel connects"
        )

    report: dict[str, Any] = {
        "suite": args.suite,
        "target": target,
        "connect_args": connect_args,
        "fixture_expected_cell_count": (
            len(fixture_cell_ids) if fixture_cell_ids is not None else None
        ),
        "samples_requested": args.samples,
        "samples_effective": effective_samples,
        "parallel_connects_requested": args.parallel,
        "parallel_connects": effective_parallel,
        "timeout_secs": args.timeout_secs,
        "ready_timeout_secs": args.ready_timeout_secs,
        "poll_interval_ms": args.poll_interval_ms,
        "daemon": {
            key: status.get(key)
            for key in (
                "pid",
                "version",
                "socket_path",
                "worktree_path",
                "fault_injection",
            )
            if key in status
        },
        "samples": [],
        "scenarios": {},
    }

    try:
        for sample in range(1, effective_samples + 1):
            log(f"running sample {sample}/{effective_samples}")
            report["samples"].append(
                await run_sample(
                    sample,
                    runt_exe,
                    env,
                    args.timeout_secs,
                    connect_args,
                    fixture_cell_ids,
                    effective_parallel,
                    args.ready_timeout_secs,
                    args.poll_interval_ms,
                )
            )

        if args.suite == "progressive":
            if fixture_root is None:
                fixture_root = Path(tempfile.mkdtemp(prefix="nteract-mcp-connect-scenarios-"))
            switch_a_path, switch_a_ids = create_fixture(
                fixture_root,
                args.switch_cells,
                filename="mcp-connect-switch-a.ipynb",
                cell_id_prefix="switch-a",
            )
            switch_b_path, switch_b_ids = create_fixture(
                fixture_root,
                max(1, min(args.fixture_cells, 32)),
                filename="mcp-connect-switch-b.ipynb",
                cell_id_prefix="switch-b",
            )
            log("running target-switch/supersession scenario")
            report["scenarios"]["target_switch"] = await run_target_switch_scenario(
                runt_exe,
                env,
                args.timeout_secs,
                {"path": str(switch_a_path)},
                switch_a_ids,
                {"path": str(switch_b_path)},
                switch_b_ids,
                args.switch_delay_ms,
                args.ready_timeout_secs,
                args.poll_interval_ms,
            )

            degraded_path = create_degraded_fixture(fixture_root)
            log("running degraded-source scenario")
            report["scenarios"]["source_degraded"] = await run_degraded_source_scenario(
                runt_exe,
                env,
                args.timeout_secs,
                degraded_path,
            )

        if args.suite == "progressive" or args.fault_mode == "stalled-peer":
            if args.fault_notebook_id:
                fault_args = {"notebook_id": args.fault_notebook_id}
            elif args.fault_path:
                fault_args = {"path": str(args.fault_path.expanduser().resolve())}
            else:
                fault_args = connect_args
            log("running deterministic stalled-peer projection/gating scenario")
            report["scenarios"]["stalled_peer"] = await run_stalled_peer_scenario(
                runt_exe,
                env,
                args.timeout_secs,
                fault_args,
                args.fault_observe_secs,
            )
    finally:
        if fixture_root is not None:
            if args.keep_fixture:
                report["fixture_kept_at"] = str(fixture_root)
            else:
                shutil.rmtree(fixture_root, ignore_errors=True)

    runtime_not_ready = validate_runtime_not_ready(report["samples"])
    report["runtime_not_ready_observed"] = runtime_not_ready["observed"]
    report["runtime_not_ready_note"] = runtime_not_ready["note"]
    if args.suite == "progressive":
        report["scenarios"]["runtime_not_ready"] = runtime_not_ready
        report["progressive_transition_observed"] = (
            any(
                sample.get("progressive_transition_observed") is True
                for sample in report["samples"]
            )
            or report["scenarios"].get("stalled_peer", {}).get("ok") is True
        )
    projected_id_sequences = [
        tuple(sample["connects"][0].get("cell_ids", []))
        for sample in report["samples"]
        if sample["connects"] and sample["connects"][0]["ok"]
    ]
    report["stable_cell_ids_across_samples"] = (
        len(projected_id_sequences) == len(report["samples"])
        and len(set(projected_id_sequences)) == 1
    )
    projected_notebook_ids = [
        sample["connects"][0].get("notebook_id")
        for sample in report["samples"]
        if sample["connects"] and sample["connects"][0]["ok"]
    ]
    report["stable_notebook_identity_across_samples"] = (
        len(projected_notebook_ids) == len(report["samples"])
        and len(set(projected_notebook_ids)) == 1
    )
    report["ok"] = (
        all(sample["ok"] for sample in report["samples"])
        and all(scenario["ok"] for scenario in report["scenarios"].values())
        and report["stable_cell_ids_across_samples"]
        and report["stable_notebook_identity_across_samples"]
        and (args.suite != "progressive" or report.get("progressive_transition_observed") is True)
    )
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
        "--suite",
        choices=("basic", "progressive"),
        default="basic",
        help=(
            "basic preserves the original profile; progressive also runs parallel, "
            "target-switch, and degraded-source scenarios"
        ),
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
        help="Per-request transport timeout (default: 125)",
    )
    parser.add_argument(
        "--ready-timeout-secs",
        type=float,
        default=30,
        help="Total time to poll structured not-ready reads (default: 30)",
    )
    parser.add_argument(
        "--poll-interval-ms",
        type=float,
        default=50,
        help="Delay between readiness probes (default: 50)",
    )
    parser.add_argument(
        "--switch-cells",
        type=int,
        default=512,
        help="Cells in the first fresh target-switch fixture (default: 512)",
    )
    parser.add_argument(
        "--switch-delay-ms",
        type=float,
        default=10,
        help="Delay between overlapping A and B target activations (default: 10)",
    )
    parser.add_argument("--report", type=Path, help="Also write the JSON report to this path")
    parser.add_argument("--keep-fixture", action="store_true")
    parser.add_argument(
        "--system-daemon",
        action="store_true",
        help="Do not force per-worktree RUNTIMED_DEV environment variables",
    )
    parser.add_argument(
        "--fault-mode",
        choices=("none", "stalled-peer"),
        default="none",
        help=(
            "Run the deterministic stalled-peer MCP fault scenario outside the progressive "
            "suite as well (default: none)."
        ),
    )
    fault_target = parser.add_mutually_exclusive_group()
    fault_target.add_argument(
        "--fault-path",
        type=Path,
        help="Requested stalled-peer .ipynb target; defaults to the primary target",
    )
    fault_target.add_argument(
        "--fault-notebook-id",
        type=notebook_id_arg,
        help="Requested stalled-peer daemon room UUID",
    )
    parser.add_argument(
        "--fault-observe-secs",
        type=float,
        default=2,
        help="How long stalled-peer reads must remain structured not-ready (default: 2)",
    )
    parser.add_argument(
        "--self-test",
        action="store_true",
        help="Run dependency-free parser/contract self-tests without a daemon",
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
    if args.ready_timeout_secs <= 0:
        parser.error("--ready-timeout-secs must be > 0")
    if args.poll_interval_ms <= 0:
        parser.error("--poll-interval-ms must be > 0")
    if args.switch_cells < 1:
        parser.error("--switch-cells must be >= 1")
    if args.switch_delay_ms < 0:
        parser.error("--switch-delay-ms must be >= 0")
    if args.fault_observe_secs <= 0:
        parser.error("--fault-observe-secs must be > 0")
    if (args.fault_path or args.fault_notebook_id) and args.fault_mode == "none":
        parser.error("--fault-path/--fault-notebook-id requires --fault-mode")
    if args.report:
        args.report = args.report.expanduser().resolve()
    return args


def run_self_tests() -> int:
    head = "a" * 64
    valid_response = {
        "notebook_id": "00000000-0000-4000-8000-000000000001",
        "cells": "⏺ ━━━ cell stable-cell (code)\n",
        "session_generation": 7,
        "source_state": {
            "phase": "ready",
            "generation": 3,
            "fingerprint": "b" * 64,
            "progress": {"completed": 1, "total": 1},
            "retry": "not_needed",
        },
        "readiness": {
            "projection": True,
            "document": False,
            "runtime": False,
            "interactive": False,
        },
        "projection": {
            "heads": [head],
            "runtime_state_heads": [head],
            "completeness": "complete_cell_index_bounded_source_preview",
        },
        "capabilities": {"read": True, "mutate": False, "execute": False},
    }
    connect_result = {
        "content": [{"type": "text", "text": json.dumps(valid_response)}],
        "structuredContent": valid_response,
    }
    connect_summary = summarize_connect(1.25, connect_result, None, ["stable-cell"])
    assert connect_summary["ok"]
    assert connect_summary["session_generation"] == 7
    assert connect_summary["cell_ids"] == ["stable-cell"]

    invalid_response = json.loads(json.dumps(valid_response))
    invalid_response["readiness"]["projection"] = False
    invalid_response["capabilities"]["mutate"] = True
    invalid_errors = progressive_contract_errors(invalid_response)
    assert "connect_notebook success must be ProjectionReady" in invalid_errors
    assert "mutation capability opened before Interactive" in invalid_errors

    error_payload = {
        "error": {
            "code": "notebook_not_ready",
            "message": "still converging",
        },
        "session": {
            "session_generation": 7,
            "source_state": valid_response["source_state"],
            "projection_ready": True,
            "document_ready": False,
            "runtime_ready": False,
            "interactive": False,
            "capabilities": {"read": False, "mutate": False, "execute": False},
        },
    }
    read_result = {
        "isError": True,
        "content": [{"type": "text", "text": json.dumps(error_payload)}],
        "structuredContent": error_payload,
    }
    read_summary = summarize_get_all(2.5, read_result, None)
    assert not read_summary["ok"]
    assert read_summary["error_code"] == "notebook_not_ready"
    assert read_summary["structured_state_errors"] == []
    assert parse_json_value(f"prefix {json.dumps(error_payload)} suffix") == error_payload

    runtime_closed = validate_runtime_not_ready(
        [
            {
                "connects": [connect_summary],
                "runtime_execute_probe": read_summary,
            }
        ]
    )
    assert runtime_closed["ok"]
    assert runtime_closed["execute_and_runtime_closed_observed"]

    runtime_open_summary = json.loads(json.dumps(connect_summary))
    runtime_open_summary["readiness"]["runtime"] = True
    runtime_open_summary["capabilities"]["execute"] = True
    assert not validate_runtime_not_ready([{"connects": [runtime_open_summary]}])["ok"]

    unsafe_runtime_summary = json.loads(json.dumps(connect_summary))
    unsafe_runtime_summary["capabilities"]["execute"] = True
    assert not validate_runtime_not_ready([{"connects": [unsafe_runtime_summary]}])["ok"]

    structured_runtime_closed = validate_runtime_not_ready(
        [
            {
                "connects": [],
                "document_convergence": {
                    "immediate": read_summary,
                    "transient_error_codes": ["notebook_not_ready"],
                },
                "runtime_execute_probe": read_summary,
            }
        ]
    )
    assert structured_runtime_closed["ok"]
    assert structured_runtime_closed["structured_transition_codes"] == ["notebook_not_ready"]

    projection_payload = {
        "cells": [{"cell_id": "stable-cell", "cell_type": "code"}],
        "projection": {"generation": 3, "heads": [head], "complete": True},
        "readiness": {
            "session_generation": 7,
            "projection_ready": True,
            "document_ready": False,
            "runtime_ready": False,
            "interactive": False,
            "capabilities": {"read": True, "mutate": False, "execute": False},
        },
    }
    projection_result = {
        "content": [{"type": "text", "text": json.dumps(projection_payload)}],
        "structuredContent": projection_payload,
    }
    projection_summary = summarize_get_all(1.0, projection_result, None)
    assert projection_summary["ok"]
    assert projection_summary["projection_only"]

    stalled_observation = validate_stalled_peer_observation(
        connect_summary,
        projection_summary,
        [read_summary],
        [read_summary],
    )
    assert stalled_observation["ok"]
    assert not validate_stalled_peer_observation(
        connect_summary,
        projection_summary,
        [],
        [],
    )["ok"]

    print(json.dumps({"ok": True, "self_tests": 22}, sort_keys=True))
    return 0


def main() -> None:
    try:
        args = parse_args()
        if args.self_test:
            raise SystemExit(run_self_tests())
        raise SystemExit(asyncio.run(run(args)))
    except KeyboardInterrupt:
        raise SystemExit(130) from None
    except Exception as error:
        log(f"ERROR: {error}")
        raise SystemExit(2) from None


if __name__ == "__main__":
    main()
