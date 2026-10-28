"""Kernel shell handlers and wire encoding for Bokeh document sessions.

The bootstrap extension registers the request handlers through
``NteractKernel.register_shell_handler`` so the kernel class carries no
Bokeh-specific message types.
"""

from __future__ import annotations

import hashlib
import traceback
import uuid
from collections.abc import Callable
from contextlib import redirect_stderr, redirect_stdout
from functools import partial
from io import StringIO
from typing import Any

from nteract_kernel_launcher._bokeh_session import (
    BOKEH_SESSION_SCHEMA_VERSION,
    BokehBuffer,
    BokehPatchApplyError,
    BokehSerialization,
    BokehServerEvent,
    StaleBokehRevisionError,
    session_registry,
)

BOKEH_PATCH_REQUEST = "nteract_bokeh_patch_request"
BOKEH_PATCH_REPLY = "nteract_bokeh_patch_reply"
BOKEH_CHECKPOINT_REQUEST = "nteract_bokeh_checkpoint_request"
BOKEH_CHECKPOINT_REPLY = "nteract_bokeh_checkpoint_reply"
BOKEH_CLOSE_REQUEST = "nteract_bokeh_close_request"
BOKEH_CLOSE_REPLY = "nteract_bokeh_close_reply"


def _wire_serialization(
    serialized: BokehSerialization | None,
    *,
    content_key: str,
    buffer_offset: int = 0,
) -> tuple[dict[str, Any] | None, list[bytes]]:
    if serialized is None:
        return None, []
    descriptors = serialized.buffer_descriptors()
    for descriptor in descriptors:
        descriptor["buffer_index"] += buffer_offset
    return (
        {content_key: serialized.content, "buffers": descriptors},
        [buffer.data for buffer in serialized.buffers],
    )


def wire_bokeh_event(event: BokehServerEvent) -> tuple[dict[str, Any], list[bytes]]:
    client_patch, client_buffers = _wire_serialization(
        event.client_patch,
        content_key="patch",
    )
    server_patch, server_buffers = _wire_serialization(
        event.server_patch,
        content_key="patch",
        buffer_offset=len(client_buffers),
    )
    checkpoint, checkpoint_buffers = _wire_serialization(
        event.checkpoint,
        content_key="document",
        buffer_offset=len(client_buffers) + len(server_buffers),
    )
    return (
        {
            "schema_version": BOKEH_SESSION_SCHEMA_VERSION,
            "session_id": event.session_id,
            "transaction_id": event.transaction_id,
            "base_revision": event.base_revision,
            "revision": event.revision,
            "client_patch": client_patch,
            "server_patch": server_patch,
            "checkpoint": checkpoint,
        },
        [*client_buffers, *server_buffers, *checkpoint_buffers],
    )


def _request_buffers(parent: dict[str, Any], content: dict[str, Any]) -> list[BokehBuffer]:
    descriptors = content.get("buffers", [])
    raw_buffers = parent.get("buffers", [])
    if not isinstance(descriptors, list) or not isinstance(raw_buffers, list):
        raise TypeError("Bokeh patch buffers must be arrays")

    buffers: list[BokehBuffer] = []
    seen_ids: set[str] = set()
    seen_indexes: set[int] = set()
    for descriptor in descriptors:
        if not isinstance(descriptor, dict):
            raise TypeError("Bokeh buffer descriptor must be an object")
        buffer_id = descriptor.get("id")
        buffer_index = descriptor.get("buffer_index")
        size = descriptor.get("size")
        expected_hash = descriptor.get("hash")
        if (
            not isinstance(buffer_id, str)
            or type(buffer_index) is not int
            or buffer_index < 0
            or type(size) is not int
            or size < 0
            or not isinstance(expected_hash, str)
        ):
            raise TypeError("Bokeh buffer descriptor requires string id and integer buffer_index")
        if buffer_id in seen_ids or buffer_index in seen_indexes:
            raise ValueError("Bokeh buffer descriptors require unique ids and indexes")
        try:
            data = bytes(raw_buffers[buffer_index])
        except IndexError as exc:
            raise ValueError(f"Bokeh buffer index {buffer_index} is out of range") from exc
        if len(data) != size:
            raise ValueError(
                f"Bokeh buffer {buffer_id} size mismatch: expected {size}, got {len(data)}"
            )
        actual_hash = hashlib.sha256(data).hexdigest()
        if actual_hash != expected_hash:
            raise ValueError(
                f"Bokeh buffer {buffer_id} hash mismatch: "
                f"expected {expected_hash}, got {actual_hash}"
            )
        seen_ids.add(buffer_id)
        seen_indexes.add(buffer_index)
        buffers.append(BokehBuffer(id=buffer_id, data=data))
    return buffers


def _error_payload(exc: BaseException) -> dict[str, Any]:
    return {
        "ename": type(exc).__name__,
        "evalue": str(exc),
        "traceback": traceback.format_exception(type(exc), exc, exc.__traceback__),
    }


def _send_reply(
    kernel: Any,
    stream: Any,
    ident: Any,
    msg_type: str,
    content: dict[str, Any],
    buffers: list[bytes] | None = None,
) -> None:
    kernel.send_response(
        stream,
        msg_type,
        content=content,
        ident=ident,
        buffers=buffers or [],
    )


def patch_request(kernel: Any, stream: Any, ident: Any, parent: dict[str, Any]) -> None:
    content = parent.get("content", {})
    session_id = content.get("session_id")
    transaction_id = content.get("transaction_id") or str(uuid.uuid4())
    stdout = StringIO()
    stderr = StringIO()

    try:
        if content.get("schema_version") != BOKEH_SESSION_SCHEMA_VERSION:
            raise ValueError("Unsupported Bokeh patch schema version")
        if not isinstance(session_id, str):
            raise TypeError("Bokeh patch request requires session_id")
        if not isinstance(transaction_id, str):
            raise TypeError("Bokeh patch request requires transaction_id")
        base_revision = content.get("base_revision")
        patch = content.get("patch")
        if type(base_revision) is not int or not isinstance(patch, dict):
            raise TypeError("Bokeh patch request requires integer base_revision and object patch")
        buffers = _request_buffers(parent, content)
        session = session_registry.require(session_id)
        with redirect_stdout(stdout), redirect_stderr(stderr):
            result = session.apply_patch(
                base_revision=base_revision,
                patch=patch,
                buffers=buffers,
                transaction_id=transaction_id,
            )
        reply = {
            "status": "ok",
            "schema_version": BOKEH_SESSION_SCHEMA_VERSION,
            "session_id": session_id,
            "transaction_id": result.transaction_id,
            "revision": result.revision,
            "stdout": stdout.getvalue(),
            "stderr": stderr.getvalue(),
        }
    except StaleBokehRevisionError as exc:
        reply = {
            "status": "stale",
            "schema_version": BOKEH_SESSION_SCHEMA_VERSION,
            "session_id": session_id,
            "transaction_id": transaction_id,
            "revision": exc.actual,
            "stdout": stdout.getvalue(),
            "stderr": stderr.getvalue(),
        }
    except BokehPatchApplyError as exc:
        reply = {
            "status": "error",
            "schema_version": BOKEH_SESSION_SCHEMA_VERSION,
            "session_id": session_id,
            "transaction_id": exc.transaction_id,
            "revision": exc.revision,
            "stdout": stdout.getvalue(),
            "stderr": stderr.getvalue(),
            "error": _error_payload(exc.__cause__ or exc),
        }
    except Exception as exc:  # noqa: BLE001
        reply = {
            "status": "error",
            "schema_version": BOKEH_SESSION_SCHEMA_VERSION,
            "session_id": session_id,
            "transaction_id": transaction_id,
            "stdout": stdout.getvalue(),
            "stderr": stderr.getvalue(),
            "error": _error_payload(exc),
        }

    _send_reply(kernel, stream, ident, BOKEH_PATCH_REPLY, reply)


def checkpoint_request(kernel: Any, stream: Any, ident: Any, parent: dict[str, Any]) -> None:
    content = parent.get("content", {})
    session_id = content.get("session_id")
    transaction_id = content.get("transaction_id") or str(uuid.uuid4())
    reply_buffers: list[bytes] = []
    try:
        if content.get("schema_version") != BOKEH_SESSION_SCHEMA_VERSION:
            raise ValueError("Unsupported Bokeh checkpoint schema version")
        if not isinstance(session_id, str):
            raise TypeError("Bokeh checkpoint request requires session_id")
        session = session_registry.require(session_id)
        revision, snapshot = session.checkpoint()
        checkpoint, reply_buffers = _wire_serialization(snapshot, content_key="document")
        reply = {
            "status": "ok",
            "schema_version": BOKEH_SESSION_SCHEMA_VERSION,
            "session_id": session_id,
            "transaction_id": transaction_id,
            "revision": revision,
            "checkpoint": checkpoint,
        }
    except Exception as exc:  # noqa: BLE001
        reply = {
            "status": "error",
            "schema_version": BOKEH_SESSION_SCHEMA_VERSION,
            "session_id": session_id,
            "transaction_id": transaction_id,
            "error": _error_payload(exc),
        }
    _send_reply(kernel, stream, ident, BOKEH_CHECKPOINT_REPLY, reply, reply_buffers)


def close_request(kernel: Any, stream: Any, ident: Any, parent: dict[str, Any]) -> None:
    content = parent.get("content", {})
    session_id = content.get("session_id")
    transaction_id = content.get("transaction_id") or str(uuid.uuid4())
    try:
        if content.get("schema_version") != BOKEH_SESSION_SCHEMA_VERSION:
            raise ValueError("Unsupported Bokeh close schema version")
        if not isinstance(session_id, str):
            raise TypeError("Bokeh close request requires session_id")
        reply = {
            "status": "ok" if session_registry.close(session_id) else "not_found",
            "schema_version": BOKEH_SESSION_SCHEMA_VERSION,
            "session_id": session_id,
            "transaction_id": transaction_id,
        }
    except Exception as exc:  # noqa: BLE001
        reply = {
            "status": "error",
            "schema_version": BOKEH_SESSION_SCHEMA_VERSION,
            "session_id": session_id,
            "transaction_id": transaction_id,
            "error": _error_payload(exc),
        }
    _send_reply(kernel, stream, ident, BOKEH_CLOSE_REPLY, reply)


SHELL_HANDLERS: dict[str, Callable[[Any, Any, Any, dict[str, Any]], None]] = {
    BOKEH_PATCH_REQUEST: patch_request,
    BOKEH_CHECKPOINT_REQUEST: checkpoint_request,
    BOKEH_CLOSE_REQUEST: close_request,
}

_unregister: list[Callable[[], None]] = []


def install_kernel_hooks(ip: Any) -> None:
    """Register the Bokeh shell handlers on ``ip.kernel``.

    Plain ipykernel kernels have no registry; Bokeh requests stay unhandled there.
    """
    register = getattr(getattr(ip, "kernel", None), "register_shell_handler", None)
    if register is None:
        return
    kernel = ip.kernel
    registered: list[Callable[[], None]] = []
    try:
        for msg_type, handler in SHELL_HANDLERS.items():
            registered.append(register(msg_type, partial(handler, kernel)))
    except BaseException:
        # All or nothing, so a retry after the failure can register cleanly.
        for unregister in registered:
            unregister()
        raise
    _unregister.extend(registered)


def uninstall_kernel_hooks(ip: Any) -> None:
    while _unregister:
        _unregister.pop()()
