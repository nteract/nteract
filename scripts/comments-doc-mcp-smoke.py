"""Multi-client MCP smoke test for durable CommentsDoc collaboration.

Spawns real `runt mcp` stdio servers and drives two independent MCP clients
against the same local notebook. The scenario proves that comment tools and the
comments resource converge through the daemon-backed CommentsDoc sync path.

Usage:
    uv run --with 'mcp>=1.0' python scripts/comments-doc-mcp-smoke.py \
        --runt ./target/debug/runt

    uv run --with 'mcp>=1.0' python scripts/comments-doc-mcp-smoke.py \
        --runt ./target/debug/runt \
        --runtimed ./target/debug/runtimed \
        --start-daemon \
        --restart-daemon-for-persistence
"""

from __future__ import annotations

import argparse
import asyncio
import builtins
import contextlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from collections.abc import Callable
from pathlib import Path
from typing import Any
from urllib.parse import quote

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if sys.stderr.encoding and sys.stderr.encoding.lower() != "utf-8":
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

try:
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client
    from mcp.shared.exceptions import McpError
except ModuleNotFoundError as exc:  # pragma: no cover - dependency guard
    print(
        "FAIL: missing MCP Python SDK. Run with: "
        "uv run --with 'mcp>=1.0' python scripts/comments-doc-mcp-smoke.py ...",
        file=sys.stderr,
    )
    raise SystemExit(1) from exc

COMMENTS_TOOLS = {
    "list_comments",
    "create_comment_thread",
    "reply_comment_thread",
    "resolve_comment_thread",
    "reopen_comment_thread",
}
COMMENTS_TEMPLATES = {
    "nteract://notebooks/{notebook_id}/comments",
    "nteract://notebooks/{notebook_id}/cells/{cell_id}/comments",
    "nteract://notebooks/{notebook_id}/comments/threads/{thread_id}",
}
CELL_SUMMARY_RE = re.compile(r"\bcell\s+([A-Za-z0-9_.:-]+)\s+\(")
COMMENT_SYNC_TIMEOUT_SECS = 20
DAEMON_READY_TIMEOUT_SECS = 30
BASE_EXCEPTION_GROUP = getattr(builtins, "BaseExceptionGroup", None)
COMMENTS_AUTHORITY = "runtimed:comments"


class SmokeFailure(RuntimeError):
    """Raised when the smoke scenario finds an invariant violation."""


def fail(message: str) -> None:
    raise SmokeFailure(message)


def log(message: str) -> None:
    print(f"[comments-smoke] {message}")


def text_of(result: Any) -> str:
    return "\n".join(c.text for c in result.content if hasattr(c, "text"))


def parse_json_value(body: str) -> Any:
    text = body.strip()
    if not text:
        fail("empty JSON body")
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        start = text.find("{")
        end = text.rfind("}")
        if start == -1 or end == -1 or end <= start:
            fail(f"could not find JSON object in body:\n{text}")
        return json.loads(text[start : end + 1])


def require_dict(value: Any, context: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        fail(f"{context} did not return a JSON object: {value!r}")
    return value


async def call_json(
    session: ClientSession,
    label: str,
    tool: str,
    args: dict[str, Any] | None = None,
) -> dict[str, Any]:
    try:
        result = await session.call_tool(tool, args or {})
    except McpError as exc:
        fail(f"[{label}] {tool} raised MCP error: {exc}")
    body = text_of(result)
    if result.isError:
        fail(f"[{label}] {tool} errored:\n{body}")
    parsed = parse_json_value(body)
    return require_dict(parsed, f"[{label}] {tool}")


async def read_resource_json(
    session: ClientSession,
    label: str,
    uri: str,
) -> dict[str, Any]:
    try:
        result = await session.read_resource(uri)
    except McpError as exc:
        fail(f"[{label}] read_resource {uri} raised MCP error: {exc}")
    texts = [c.text for c in result.contents if hasattr(c, "text")]
    if not texts:
        fail(f"[{label}] {uri} returned no text resource contents")
    return require_dict(parse_json_value(texts[0]), f"[{label}] read_resource {uri}")


def resource_template_uris(result: Any) -> set[str]:
    templates = getattr(result, "resourceTemplates", None)
    if templates is None:
        templates = getattr(result, "resource_templates", None)
    if templates is None:
        templates = getattr(result, "templates", None)
    return {str(getattr(t, "uriTemplate", getattr(t, "uri_template", ""))) for t in templates or []}


def segment(value: str) -> str:
    return quote(value, safe="-._~")


def comments_uri(notebook_id: str) -> str:
    return f"nteract://notebooks/{segment(notebook_id)}/comments"


def cell_comments_uri(notebook_id: str, cell_id: str) -> str:
    return f"nteract://notebooks/{segment(notebook_id)}/cells/{segment(cell_id)}/comments"


def comment_thread_uri(notebook_id: str, thread_id: str) -> str:
    return f"nteract://notebooks/{segment(notebook_id)}/comments/threads/{segment(thread_id)}"


@contextlib.asynccontextmanager
async def mcp_session(label: str, runt: Path, socket: Path | None = None):
    args = ["mcp", "--no-show"]
    if socket is not None:
        args.extend(["--socket", str(socket)])
    params = StdioServerParameters(command=str(runt), args=args)
    async with stdio_client(params) as (read, write), ClientSession(read, write) as session:
        await session.initialize()
        log(f"{label}: MCP session initialized")
        yield session


async def assert_comment_surface(session: ClientSession, label: str) -> None:
    tools = await session.list_tools()
    tool_names = {tool.name for tool in tools.tools}
    missing = sorted(COMMENTS_TOOLS - tool_names)
    if missing:
        fail(f"[{label}] missing comment tools: {missing}")

    templates = await session.list_resource_templates()
    template_uris = resource_template_uris(templates)
    missing_templates = sorted(COMMENTS_TEMPLATES - template_uris)
    if missing_templates:
        fail(
            f"[{label}] missing comments resource templates: "
            f"{missing_templates}; got {sorted(template_uris)}"
        )


async def wait_for_comments(
    session: ClientSession,
    label: str,
    uri: str,
    predicate: Callable[[dict[str, Any], dict[str, Any]], bool],
    description: str,
) -> tuple[dict[str, Any], dict[str, Any]]:
    loop = asyncio.get_running_loop()
    deadline = loop.time() + COMMENT_SYNC_TIMEOUT_SECS
    last_summary = ""

    while True:
        tool_json = await call_json(session, label, "list_comments")
        resource_json = await read_resource_json(session, label, uri)
        summary = summarize_threads(tool_json.get("threads", []))
        if predicate(tool_json, resource_json):
            log(f"{label}: observed {description}: {summary}")
            return tool_json, resource_json
        if summary != last_summary:
            log(f"{label}: waiting for {description}; current threads: {summary}")
            last_summary = summary
        if loop.time() >= deadline:
            fail(f"[{label}] timed out waiting for {description}; last={tool_json}")
        await asyncio.sleep(0.5)


def summarize_threads(threads: Any) -> str:
    if not isinstance(threads, list):
        return "<invalid threads payload>"
    parts = []
    for thread in threads:
        if isinstance(thread, dict):
            messages = thread.get("messages")
            count = len(messages) if isinstance(messages, list) else "?"
            parts.append(f"{thread.get('id')}:{thread.get('status')}:{count}")
    return ", ".join(parts) if parts else "<none>"


def thread_with_body(payload: dict[str, Any], body: str) -> dict[str, Any] | None:
    for thread in iter_threads(payload):
        for message in thread.get("messages", []):
            if isinstance(message, dict) and message.get("body") == body:
                return thread
    return None


def contains_message(payload: dict[str, Any], body: str) -> bool:
    return thread_with_body(payload, body) is not None


def contains_thread_and_reply(payload: dict[str, Any], first: str, reply: str) -> bool:
    thread = thread_with_body(payload, first)
    if not thread:
        return False
    return any(
        isinstance(message, dict) and message.get("body") == reply
        for message in thread.get("messages", [])
    )


def thread_ids(payload: dict[str, Any]) -> set[str]:
    return {thread["id"] for thread in iter_threads(payload) if isinstance(thread.get("id"), str)}


def thread_by_id(payload: dict[str, Any], thread_id: str) -> dict[str, Any] | None:
    for thread in iter_threads(payload):
        if thread.get("id") == thread_id:
            return thread
    return None


def thread_status(payload: dict[str, Any], thread_id: str) -> str | None:
    thread = thread_by_id(payload, thread_id)
    status = thread.get("status") if thread else None
    return status if isinstance(status, str) else None


def require_thread(
    payload: dict[str, Any],
    thread_id: str,
    context: str,
) -> dict[str, Any]:
    thread = thread_by_id(payload, thread_id)
    if not thread:
        fail(f"{context} did not include thread {thread_id}: {payload}")
    return thread


def require_message_by_body(
    thread: dict[str, Any],
    body: str,
    context: str,
) -> dict[str, Any]:
    for message in thread.get("messages", []):
        if isinstance(message, dict) and message.get("body") == body:
            return message
    fail(f"{context} did not include message body {body!r}: {thread}")


def assert_authority_accepted_thread(
    payload: dict[str, Any],
    thread_id: str,
    body: str,
    context: str,
) -> None:
    thread = require_thread(payload, thread_id, context)
    if thread.get("status") != "open":
        fail(f"{context} thread status was not open: {thread}")
    if thread.get("mutation_state") != "accepted" or thread.get("trusted") is not True:
        fail(f"{context} thread was not authority-accepted/trusted: {thread}")
    if thread.get("created_by_authority") != COMMENTS_AUTHORITY:
        fail(f"{context} thread authority mismatch: {thread}")
    if not isinstance(thread.get("created_by_actor_label"), str):
        fail(f"{context} thread missing actor label: {thread}")
    assert_authority_accepted_message(thread, body, context)


def assert_authority_accepted_message(
    thread: dict[str, Any],
    body: str,
    context: str,
) -> None:
    message = require_message_by_body(thread, body, context)
    if message.get("mutation_state") != "accepted" or message.get("trusted") is not True:
        fail(f"{context} message was not authority-accepted/trusted: {message}")
    if message.get("created_by_authority") != COMMENTS_AUTHORITY:
        fail(f"{context} message authority mismatch: {message}")
    if not isinstance(message.get("created_by_actor_label"), str):
        fail(f"{context} message missing actor label: {message}")


def iter_threads(payload: dict[str, Any]) -> list[dict[str, Any]]:
    threads = [thread for thread in payload.get("threads", []) if isinstance(thread, dict)]
    thread = payload.get("thread")
    if isinstance(thread, dict):
        threads.append(thread)
    return threads


def message_bodies(payload: dict[str, Any]) -> set[str]:
    bodies: set[str] = set()
    for thread in iter_threads(payload):
        for message in thread.get("messages", []):
            if isinstance(message, dict) and isinstance(message.get("body"), str):
                bodies.add(message["body"])
    return bodies


def first_cell_id(connect_response: dict[str, Any]) -> str:
    cells = connect_response.get("cells")
    if isinstance(cells, str):
        match = CELL_SUMMARY_RE.search(cells)
        if match:
            return match.group(1)
        fail(f"connect response cell summary did not include a cell id: {cells}")
    if not isinstance(cells, list) or not cells:
        fail(f"connect response did not include cells: {connect_response}")
    first = cells[0]
    if not isinstance(first, dict) or not isinstance(first.get("id"), str):
        fail(f"connect response cell did not include an id: {first!r}")
    return first["id"]


def write_notebook(path: Path) -> None:
    notebook = {
        "cells": [
            {
                "cell_type": "code",
                "execution_count": None,
                "id": "comments-smoke-cell",
                "metadata": {},
                "outputs": [],
                "source": ["# comments smoke cell\n", "1 + 1\n"],
            }
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
    path.write_text(json.dumps(notebook, indent=2), encoding="utf-8")


async def run_pair_scenario(
    alice: ClientSession,
    bob: ClientSession,
    notebook_path: Path,
) -> tuple[str, str]:
    await asyncio.gather(
        assert_comment_surface(alice, "alice"),
        assert_comment_surface(bob, "bob"),
    )

    # Open by path once, then have the second client join by notebook_id. Two
    # simultaneous path opens can race room creation before the catalog has the
    # first path association.
    alice_open = await call_json(alice, "alice", "connect_notebook", {"path": str(notebook_path)})
    notebook_id = alice_open.get("notebook_id")
    if not isinstance(notebook_id, str) or not notebook_id:
        fail(f"alice connect did not return notebook_id: {alice_open}")
    bob_open = await call_json(bob, "bob", "connect_notebook", {"notebook_id": notebook_id})
    if bob_open.get("notebook_id") != notebook_id:
        fail(f"alice/bob connected to different notebooks: {alice_open} vs {bob_open}")
    cell_id = first_cell_id(alice_open)
    notebook_comments_uri = comments_uri(notebook_id)
    cell_resource_uri = cell_comments_uri(notebook_id, cell_id)
    log(
        f"connected notebook_id={notebook_id} cell_id={cell_id} "
        f"comments_uri={notebook_comments_uri}"
    )

    alice_initial, bob_initial = await asyncio.gather(
        call_json(alice, "alice", "list_comments"),
        call_json(bob, "bob", "list_comments"),
    )
    comments_doc_id = alice_initial.get("comments_doc_id")
    if not isinstance(comments_doc_id, str) or not comments_doc_id:
        fail(f"alice did not receive comments_doc_id: {alice_initial}")
    if bob_initial.get("comments_doc_id") != comments_doc_id:
        fail(f"alice/bob comments_doc_id mismatch: {alice_initial} vs {bob_initial}")

    existing_bodies = message_bodies(alice_initial) | message_bodies(bob_initial)
    if existing_bodies:
        log(
            "notebook already has comments; continuing with unique bodies: "
            f"{sorted(existing_bodies)}"
        )

    alice_body = "comments-smoke alice notebook note"
    bob_reply = "comments-smoke bob reply"
    resolved_reply = "comments-smoke reply reopens resolved"
    cell_body = "comments-smoke alice cell note"
    concurrent_a = "comments-smoke concurrent alice"
    concurrent_b = "comments-smoke concurrent bob"

    created = await call_json(
        alice,
        "alice",
        "create_comment_thread",
        {"anchor": {"kind": "notebook"}, "body": alice_body},
    )
    created_thread_id = created.get("thread_id")
    if not isinstance(created_thread_id, str) or not created_thread_id:
        fail(f"create_comment_thread did not return thread_id: {created}")
    assert_authority_accepted_thread(
        created,
        created_thread_id,
        alice_body,
        "alice create result",
    )

    bob_seen, bob_resource = await wait_for_comments(
        bob,
        "bob",
        notebook_comments_uri,
        lambda tool, resource: (
            contains_message(tool, alice_body) and contains_message(resource, alice_body)
        ),
        "alice notebook thread",
    )
    assert_authority_accepted_thread(
        bob_seen,
        created_thread_id,
        alice_body,
        "bob list after alice create",
    )
    assert_authority_accepted_thread(
        bob_resource,
        created_thread_id,
        alice_body,
        "bob resource after alice create",
    )

    replied = await call_json(
        bob,
        "bob",
        "reply_comment_thread",
        {"thread_id": created_thread_id, "body": bob_reply},
    )
    assert_authority_accepted_message(
        require_thread(replied, created_thread_id, "bob reply result"),
        bob_reply,
        "bob reply result",
    )
    alice_seen, alice_resource = await wait_for_comments(
        alice,
        "alice",
        notebook_comments_uri,
        lambda tool, resource: (
            contains_thread_and_reply(tool, alice_body, bob_reply)
            and contains_thread_and_reply(resource, alice_body, bob_reply)
        ),
        "bob reply",
    )
    assert_authority_accepted_message(
        require_thread(alice_seen, created_thread_id, "alice list after bob reply"),
        bob_reply,
        "alice list after bob reply",
    )
    assert_authority_accepted_message(
        require_thread(alice_resource, created_thread_id, "alice resource after bob reply"),
        bob_reply,
        "alice resource after bob reply",
    )
    created_thread_resource = await read_resource_json(
        alice,
        "alice",
        comment_thread_uri(notebook_id, created_thread_id),
    )
    if not contains_thread_and_reply(created_thread_resource, alice_body, bob_reply):
        fail(f"thread resource did not include notebook thread reply: {created_thread_resource}")
    assert_authority_accepted_thread(
        created_thread_resource,
        created_thread_id,
        alice_body,
        "created thread resource",
    )
    assert_authority_accepted_message(
        require_thread(created_thread_resource, created_thread_id, "created thread resource"),
        bob_reply,
        "created thread resource",
    )

    cell_created = await call_json(
        alice,
        "alice",
        "create_comment_thread",
        {"anchor": {"kind": "cell", "cell_id": cell_id}, "body": cell_body},
    )
    cell_thread_id = cell_created.get("thread_id")
    if not isinstance(cell_thread_id, str) or not cell_thread_id:
        fail(f"cell create did not return thread_id: {cell_created}")
    assert_authority_accepted_thread(
        cell_created,
        cell_thread_id,
        cell_body,
        "cell create result",
    )
    filtered = await call_json(alice, "alice", "list_comments", {"cell_id": cell_id})
    matching = thread_with_body(filtered, cell_body)
    if not matching:
        fail(f"cell-filtered list did not include cell thread: {filtered}")
    assert_authority_accepted_thread(
        filtered,
        cell_thread_id,
        cell_body,
        "cell-filtered list",
    )
    badge_cell_ids = matching.get("badge_cell_ids")
    if cell_id not in badge_cell_ids:
        fail(f"cell thread did not badge {cell_id}: {matching}")
    cell_resource = await read_resource_json(alice, "alice", cell_resource_uri)
    if not contains_message(cell_resource, cell_body):
        fail(f"cell comments resource did not include cell thread: {cell_resource}")
    assert_authority_accepted_thread(
        cell_resource,
        cell_thread_id,
        cell_body,
        "cell comments resource",
    )
    cell_thread_resource = await read_resource_json(
        bob,
        "bob",
        comment_thread_uri(notebook_id, cell_thread_id),
    )
    if not contains_message(cell_thread_resource, cell_body):
        fail(f"cell thread resource did not include cell message: {cell_thread_resource}")
    assert_authority_accepted_thread(
        cell_thread_resource,
        cell_thread_id,
        cell_body,
        "cell thread resource",
    )

    await call_json(
        bob,
        "bob",
        "resolve_comment_thread",
        {"thread_id": created_thread_id},
    )
    await wait_for_comments(
        alice,
        "alice",
        notebook_comments_uri,
        lambda tool, resource: (
            thread_status(tool, created_thread_id) == "resolved"
            and thread_status(resource, created_thread_id) == "resolved"
        ),
        "bob resolved notebook thread",
    )
    hidden_resolved = await call_json(
        alice,
        "alice",
        "list_comments",
        {"include_resolved": False},
    )
    if created_thread_id in thread_ids(hidden_resolved):
        fail(f"resolved thread was not hidden by include_resolved=false: {hidden_resolved}")
    resolved_thread_resource = await read_resource_json(
        bob,
        "bob",
        comment_thread_uri(notebook_id, created_thread_id),
    )
    if thread_status(resolved_thread_resource, created_thread_id) != "resolved":
        fail(f"thread resource did not show resolved status: {resolved_thread_resource}")
    resolved_thread = require_thread(
        resolved_thread_resource,
        created_thread_id,
        "resolved thread resource",
    )
    if resolved_thread.get("resolved_by_authority") != COMMENTS_AUTHORITY:
        fail(f"resolved thread authority mismatch: {resolved_thread}")
    if not isinstance(resolved_thread.get("resolved_by_actor_label"), str):
        fail(f"resolved thread missing actor label: {resolved_thread}")
    if not isinstance(resolved_thread.get("resolved_at"), str):
        fail(f"resolved thread missing resolved_at: {resolved_thread}")

    resolved_reply_result = await call_json(
        alice,
        "alice",
        "reply_comment_thread",
        {"thread_id": created_thread_id, "body": resolved_reply},
    )
    assert_authority_accepted_message(
        require_thread(resolved_reply_result, created_thread_id, "resolved reply result"),
        resolved_reply,
        "resolved reply result",
    )
    bob_after_resolved_reply, bob_resolved_reply_resource = await wait_for_comments(
        bob,
        "bob",
        notebook_comments_uri,
        lambda tool, resource: (
            thread_status(tool, created_thread_id) == "open"
            and thread_status(resource, created_thread_id) == "open"
            and contains_thread_and_reply(tool, alice_body, resolved_reply)
            and contains_thread_and_reply(resource, alice_body, resolved_reply)
        ),
        "reply reopened resolved notebook thread",
    )
    assert_authority_accepted_message(
        require_thread(
            bob_after_resolved_reply,
            created_thread_id,
            "bob list after resolved reply",
        ),
        resolved_reply,
        "bob list after resolved reply",
    )
    assert_authority_accepted_message(
        require_thread(
            bob_resolved_reply_resource,
            created_thread_id,
            "bob resource after resolved reply",
        ),
        resolved_reply,
        "bob resource after resolved reply",
    )
    auto_reopened_thread_resource = await read_resource_json(
        bob,
        "bob",
        comment_thread_uri(notebook_id, created_thread_id),
    )
    auto_reopened_thread = require_thread(
        auto_reopened_thread_resource,
        created_thread_id,
        "auto-reopened thread resource",
    )
    if auto_reopened_thread.get("status") != "open":
        fail(f"reply did not reopen resolved thread: {auto_reopened_thread}")
    if auto_reopened_thread.get("resolved_at") is not None:
        fail(f"reply-reopened thread kept resolved_at: {auto_reopened_thread}")
    if auto_reopened_thread.get("resolved_by_actor_label") is not None:
        fail(f"reply-reopened thread kept resolved actor: {auto_reopened_thread}")
    if auto_reopened_thread.get("resolved_by_authority") is not None:
        fail(f"reply-reopened thread kept resolved authority: {auto_reopened_thread}")

    await call_json(
        bob,
        "bob",
        "resolve_comment_thread",
        {"thread_id": created_thread_id},
    )
    await wait_for_comments(
        alice,
        "alice",
        notebook_comments_uri,
        lambda tool, resource: (
            thread_status(tool, created_thread_id) == "resolved"
            and thread_status(resource, created_thread_id) == "resolved"
        ),
        "bob resolved notebook thread again",
    )

    await call_json(
        alice,
        "alice",
        "reopen_comment_thread",
        {"thread_id": created_thread_id},
    )
    await wait_for_comments(
        bob,
        "bob",
        notebook_comments_uri,
        lambda tool, resource: (
            thread_status(tool, created_thread_id) == "open"
            and thread_status(resource, created_thread_id) == "open"
        ),
        "alice reopened notebook thread",
    )
    reopened_thread_resource = await read_resource_json(
        bob,
        "bob",
        comment_thread_uri(notebook_id, created_thread_id),
    )
    reopened_thread = require_thread(
        reopened_thread_resource,
        created_thread_id,
        "reopened thread resource",
    )
    if reopened_thread.get("resolved_at") is not None:
        fail(f"reopened thread kept resolved_at: {reopened_thread}")
    if reopened_thread.get("resolved_by_actor_label") is not None:
        fail(f"reopened thread kept resolved actor: {reopened_thread}")
    if reopened_thread.get("resolved_by_authority") is not None:
        fail(f"reopened thread kept resolved authority: {reopened_thread}")

    concurrent_results = await asyncio.gather(
        call_json(
            alice,
            "alice",
            "create_comment_thread",
            {"anchor": {"kind": "notebook"}, "body": concurrent_a},
        ),
        call_json(
            bob,
            "bob",
            "create_comment_thread",
            {"anchor": {"kind": "notebook"}, "body": concurrent_b},
        ),
    )
    expected_concurrent_ids = {
        result["thread_id"]
        for result in concurrent_results
        if isinstance(result.get("thread_id"), str)
    }
    if len(expected_concurrent_ids) != 2:
        fail(f"concurrent create did not return two thread ids: {concurrent_results}")
    for result, body in zip(concurrent_results, [concurrent_a, concurrent_b], strict=True):
        assert_authority_accepted_thread(
            result,
            result["thread_id"],
            body,
            "concurrent create result",
        )

    alice_final, _ = await wait_for_comments(
        alice,
        "alice",
        notebook_comments_uri,
        lambda tool, resource: (
            expected_concurrent_ids.issubset(thread_ids(tool))
            and expected_concurrent_ids.issubset(thread_ids(resource))
        ),
        "both concurrent notebook threads",
    )
    bob_final, _ = await wait_for_comments(
        bob,
        "bob",
        notebook_comments_uri,
        lambda tool, resource: (
            thread_ids(alice_final).issubset(thread_ids(tool))
            and thread_ids(alice_final).issubset(thread_ids(resource))
        ),
        "alice final thread set",
    )
    if thread_ids(alice_final) != thread_ids(bob_final):
        fail(f"alice/bob final thread ids diverged: {alice_final} vs {bob_final}")
    for thread_id, body in [
        (created_thread_id, alice_body),
        (cell_thread_id, cell_body),
        *[
            (result["thread_id"], body)
            for result, body in zip(
                concurrent_results,
                [concurrent_a, concurrent_b],
                strict=True,
            )
        ],
    ]:
        assert_authority_accepted_thread(
            bob_final,
            thread_id,
            body,
            "bob final comments",
        )

    log(
        "user-test friction: comments require polling; tool results are JSON text plus "
        "resource links; scoped resources made cell and thread reads easier; "
        "actor labels are stable but not Alice/Bob display labels; "
        "multi-client tests should join by notebook_id after one path open to avoid "
        "the current concurrent path-open race"
    )
    return comments_doc_id, created_thread_id


async def run_persistence_check(
    runt: Path,
    socket: Path | None,
    notebook_path: Path,
    expected_comments_doc_id: str,
    expected_bodies: set[str],
    reopened_thread_id: str,
    reopened_body: str,
) -> None:
    async with mcp_session("charlie", runt, socket) as charlie:
        connected = await call_json(
            charlie,
            "charlie",
            "connect_notebook",
            {"path": str(notebook_path)},
        )
        notebook_id = connected.get("notebook_id")
        if not isinstance(notebook_id, str):
            fail(f"charlie connect did not return notebook_id: {connected}")
        notebook_comments_uri = comments_uri(notebook_id)
        comments, resource = await wait_for_comments(
            charlie,
            "charlie",
            notebook_comments_uri,
            lambda tool, res: (
                expected_bodies.issubset(message_bodies(tool))
                and expected_bodies.issubset(message_bodies(res))
                and thread_status(tool, reopened_thread_id) == "open"
                and thread_status(res, reopened_thread_id) == "open"
            ),
            "persisted comment bodies and reopened status after daemon restart",
        )
        if comments.get("comments_doc_id") != resource.get("comments_doc_id"):
            fail(f"tool/resource comments_doc_id mismatch after restart: {comments} vs {resource}")
        if comments.get("comments_doc_id") != expected_comments_doc_id:
            fail(
                "comments_doc_id changed after restart: "
                f"expected {expected_comments_doc_id}, got {comments.get('comments_doc_id')}"
            )
        for body in sorted(expected_bodies):
            thread = thread_with_body(comments, body)
            if not thread:
                fail(f"persisted comments missing body {body!r}: {comments}")
            assert_authority_accepted_message(
                thread,
                body,
                "persisted comments",
            )
        assert_authority_accepted_thread(
            comments,
            reopened_thread_id,
            reopened_body,
            "persisted reopened thread",
        )
        thread_resource = await read_resource_json(
            charlie,
            "charlie",
            comment_thread_uri(notebook_id, reopened_thread_id),
        )
        if thread_status(thread_resource, reopened_thread_id) != "open":
            fail(f"thread resource did not persist reopened status: {thread_resource}")
        assert_authority_accepted_thread(
            thread_resource,
            reopened_thread_id,
            reopened_body,
            "persisted reopened thread resource",
        )


def env_for_socket(socket: Path | None) -> dict[str, str] | None:
    if socket is None:
        return None
    env = dict(os.environ)
    env["RUNTIMED_SOCKET_PATH"] = str(socket)
    env["RUNTIMED_DEV"] = "1"
    env["RUNTIMED_WORKSPACE_PATH"] = str(socket.parent)
    return env


async def daemon_status(runt: Path, socket: Path | None = None) -> dict[str, Any] | None:
    proc = await asyncio.create_subprocess_exec(
        str(runt),
        "daemon",
        "status",
        "--json",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=env_for_socket(socket),
    )
    stdout, _stderr = await proc.communicate()
    if proc.returncode != 0:
        return None
    try:
        value = json.loads(stdout.decode("utf-8", errors="replace"))
    except json.JSONDecodeError:
        return None
    return value if isinstance(value, dict) else None


async def wait_for_daemon_ready(runt: Path, proc: subprocess.Popen[bytes], socket: Path) -> None:
    loop = asyncio.get_running_loop()
    deadline = loop.time() + DAEMON_READY_TIMEOUT_SECS
    while True:
        if proc.poll() is not None:
            fail(f"daemon exited before ready with code {proc.returncode}")
        status = await daemon_status(runt, socket)
        pid = None
        if status and isinstance(status.get("daemon_info"), dict):
            pid = status["daemon_info"].get("pid")
        if status and status.get("running") and pid == proc.pid:
            log("daemon ready")
            return
        if loop.time() >= deadline:
            fail(
                f"daemon pid {proc.pid} did not become ready within "
                f"{DAEMON_READY_TIMEOUT_SECS}s; last status={status}"
            )
        await asyncio.sleep(1)


async def start_daemon(
    runt: Path,
    runtimed: Path,
    logs_dir: Path,
    socket: Path,
) -> subprocess.Popen[bytes]:
    status = await daemon_status(runt, socket)
    if status and status.get("running"):
        socket_path = status.get("socket_path")
        daemon_info = status.get("daemon_info")
        pid = daemon_info.get("pid") if isinstance(daemon_info, dict) else None
        fail(
            "--start-daemon found an already-running daemon "
            f"(pid={pid}, socket={socket_path}). Shut it down first or pass a different --socket."
        )
    logs_dir.mkdir(parents=True, exist_ok=True)
    socket.parent.mkdir(parents=True, exist_ok=True)
    stdout = (logs_dir / "runtimed.stdout.log").open("ab")
    stderr = (logs_dir / "runtimed.stderr.log").open("ab")
    proc = subprocess.Popen(
        [
            str(runtimed),
            "run",
            "--socket",
            str(socket),
            "--cache-dir",
            str(logs_dir.parent / "envs"),
            "--blob-store-dir",
            str(logs_dir.parent / "blobs"),
            "--uv-pool-size",
            "1",
            "--conda-pool-size",
            "0",
            "--pixi-pool-size",
            "0",
        ],
        stdout=stdout,
        stderr=stderr,
        env=env_for_socket(socket),
    )
    await wait_for_daemon_ready(runt, proc, socket)
    return proc


def stop_daemon_process(proc: subprocess.Popen[bytes] | None) -> None:
    if proc is None or proc.poll() is not None:
        return
    proc.terminate()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=10)


async def active_daemon_socket(runt: Path) -> Path:
    status = await daemon_status(runt)
    socket_path = status.get("socket_path") if status else None
    if not isinstance(socket_path, str) or not socket_path:
        fail(f"daemon status did not include socket_path: {status}")
    return Path(socket_path)


async def smoke(args: argparse.Namespace) -> None:
    root = Path(tempfile.mkdtemp(prefix="nteract-comments-mcp-"))
    daemon_proc: subprocess.Popen[bytes] | None = None
    socket = args.socket
    try:
        notebook_path = root / "comments-smoke.ipynb"
        write_notebook(notebook_path)
        log(f"notebook path: {notebook_path}")

        if args.start_daemon:
            if args.runtimed is None:
                fail("--start-daemon requires --runtimed")
            if socket is None:
                socket = root / "runtimed.sock"
            daemon_proc = await start_daemon(args.runt, args.runtimed, root / "logs", socket)
            log(f"using daemon socket: {socket}")

        async with (
            mcp_session("alice", args.runt, socket) as alice,
            mcp_session("bob", args.runt, socket) as bob,
        ):
            comments_doc_id, reopened_thread_id = await run_pair_scenario(
                alice,
                bob,
                notebook_path,
            )

        if args.restart_daemon_for_persistence:
            if not args.start_daemon:
                fail("--restart-daemon-for-persistence requires --start-daemon")
            log("restarting daemon for persistence check")
            stop_daemon_process(daemon_proc)
            daemon_proc = await start_daemon(args.runt, args.runtimed, root / "logs", socket)
            log(f"using daemon socket after restart: {socket}")
            await run_persistence_check(
                args.runt,
                socket,
                notebook_path,
                comments_doc_id,
                {
                    "comments-smoke alice notebook note",
                    "comments-smoke bob reply",
                    "comments-smoke reply reopens resolved",
                    "comments-smoke alice cell note",
                    "comments-smoke concurrent alice",
                    "comments-smoke concurrent bob",
                },
                reopened_thread_id,
                "comments-smoke alice notebook note",
            )

        log("ALL PASSES GREEN")
    finally:
        stop_daemon_process(daemon_proc)
        if args.keep_tmp:
            log(f"kept temp directory: {root}")
        else:
            shutil.rmtree(root, ignore_errors=True)


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runt", type=Path, required=True, help="Path to runt binary")
    parser.add_argument("--runtimed", type=Path, help="Path to runtimed binary")
    parser.add_argument("--socket", type=Path, help="Explicit daemon socket path for runt mcp")
    parser.add_argument("--start-daemon", action="store_true", help="Start runtimed for the smoke")
    parser.add_argument(
        "--restart-daemon-for-persistence",
        action="store_true",
        help="Restart the daemon and verify comment sidecar persistence",
    )
    parser.add_argument("--keep-tmp", action="store_true", help="Keep temporary files/logs")
    args = parser.parse_args(argv)

    if not args.runt.exists():
        parser.error(f"--runt does not exist: {args.runt}")
    if args.runtimed is not None and not args.runtimed.exists():
        parser.error(f"--runtimed does not exist: {args.runtimed}")
    if args.restart_daemon_for_persistence and not args.start_daemon:
        parser.error("--restart-daemon-for-persistence requires --start-daemon")
    if args.start_daemon and args.runtimed is None:
        parser.error("--start-daemon requires --runtimed")
    return args


def smoke_failures(exc: BaseException) -> list[SmokeFailure]:
    if isinstance(exc, SmokeFailure):
        return [exc]
    if BASE_EXCEPTION_GROUP is not None and isinstance(exc, BASE_EXCEPTION_GROUP):
        failures: list[SmokeFailure] = []
        for child in exc.exceptions:
            failures.extend(smoke_failures(child))
        return failures
    return []


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    try:
        asyncio.run(smoke(args))
    except SmokeFailure as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    except BaseException as exc:
        failures = smoke_failures(exc)
        if not failures:
            raise
        for failure in failures:
            print(f"FAIL: {failure}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
