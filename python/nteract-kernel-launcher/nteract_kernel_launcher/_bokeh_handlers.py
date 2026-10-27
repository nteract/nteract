"""Kernel shell handlers and IOPub delta publication for Bokeh document sessions.

The bootstrap extension calls :func:`install_kernel_hooks`, which registers the
request handlers through ``NteractKernel.register_shell_handler`` and publishes
session deltas through ``NteractKernel.iopub_publisher``, so the kernel class
carries no Bokeh-specific code.
"""

from __future__ import annotations

import hashlib
import logging
import traceback
import uuid
from collections.abc import Callable
from contextlib import redirect_stderr, redirect_stdout
from dataclasses import dataclass, field
from functools import partial
from io import StringIO
from typing import Any

from nteract_kernel_launcher._bokeh_session import (
    BOKEH_SESSION_SCHEMA_VERSION,
    BokehBuffer,
    BokehDelta,
    BokehPatchApplyError,
    session_registry,
)

log = logging.getLogger("nteract_kernel_launcher")

BOKEH_PATCH_REQUEST = "nteract_bokeh_patch_request"
BOKEH_PATCH_REPLY = "nteract_bokeh_patch_reply"
BOKEH_FOLD_REQUEST = "nteract_bokeh_fold_request"
BOKEH_FOLD_REPLY = "nteract_bokeh_fold_reply"
BOKEH_CLOSE_REQUEST = "nteract_bokeh_close_request"
BOKEH_CLOSE_REPLY = "nteract_bokeh_close_reply"
BOKEH_DELTA = "nteract_bokeh_delta"


def wire_bokeh_delta(delta: BokehDelta) -> tuple[dict[str, Any], list[bytes]]:
    content = {
        "schema_version": BOKEH_SESSION_SCHEMA_VERSION,
        **delta.content(),
        "buffers": [buffer.descriptor(index) for index, buffer in enumerate(delta.buffers)],
    }
    return content, [buffer.data for buffer in delta.buffers]


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


def patch_request(kernel: Any, stream: Any, ident: Any, parent: dict[str, Any]) -> None:
    content = parent.get("content", {})
    session_id = content.get("session_id")
    transaction_id = content.get("transaction_id") or str(uuid.uuid4())
    stdout = StringIO()
    stderr = StringIO()
    session = None
    patch = None

    try:
        if content.get("schema_version") != BOKEH_SESSION_SCHEMA_VERSION:
            raise ValueError("Unsupported Bokeh patch schema version")
        if not isinstance(session_id, str):
            raise TypeError("Bokeh patch request requires session_id")
        if not isinstance(transaction_id, str):
            raise TypeError("Bokeh patch request requires transaction_id")
        patch = content.get("patch")
        if not isinstance(patch, dict):
            raise TypeError("Bokeh patch request requires an object patch")
        session = session_registry.require(session_id)
        buffers = _request_buffers(parent, content)
        with redirect_stdout(stdout), redirect_stderr(stderr):
            result = session.apply_patch(
                patch=patch,
                buffers=buffers,
                transaction_id=transaction_id,
            )
        reply = {
            "status": "ok",
            "schema_version": BOKEH_SESSION_SCHEMA_VERSION,
            "session_id": session_id,
            "transaction_id": result.transaction_id,
            "stdout": stdout.getvalue(),
            "stderr": stderr.getvalue(),
        }
    except BokehPatchApplyError as exc:
        reply = {
            "status": "error",
            "schema_version": BOKEH_SESSION_SCHEMA_VERSION,
            "session_id": session_id,
            "transaction_id": exc.transaction_id,
            "stdout": stdout.getvalue(),
            "stderr": stderr.getvalue(),
            "error": _error_payload(exc.__cause__ or exc),
        }
    except Exception as exc:  # noqa: BLE001
        if session is not None and isinstance(patch, dict) and isinstance(transaction_id, str):
            # The peers already hold the values this patch asked for.
            try:
                session.correct(patch, transaction_id)
            except Exception:  # noqa: BLE001
                log.exception("Could not publish Bokeh corrections for %s", session_id)
        reply = {
            "status": "error",
            "schema_version": BOKEH_SESSION_SCHEMA_VERSION,
            "session_id": session_id,
            "transaction_id": transaction_id,
            "stdout": stdout.getvalue(),
            "stderr": stderr.getvalue(),
            "error": _error_payload(exc),
        }

    kernel.send_extension_reply(stream, ident, BOKEH_PATCH_REPLY, reply)


def fold_request(kernel: Any, stream: Any, ident: Any, parent: dict[str, Any]) -> None:
    """Fold sources on demand; the folds arrive as a delta with this transaction id."""
    content = parent.get("content", {})
    session_id = content.get("session_id")
    transaction_id = content.get("transaction_id") or str(uuid.uuid4())
    try:
        if content.get("schema_version") != BOKEH_SESSION_SCHEMA_VERSION:
            raise ValueError("Unsupported Bokeh fold schema version")
        if not isinstance(session_id, str):
            raise TypeError("Bokeh fold request requires session_id")
        source_ids = content.get("source_ids")
        if source_ids is not None and (
            not isinstance(source_ids, list)
            or not all(isinstance(source_id, str) for source_id in source_ids)
        ):
            raise TypeError("Bokeh fold request source_ids must be a list of strings")
        session = session_registry.require(session_id)
        folded = session.fold(source_ids, transaction_id=transaction_id)
        reply = {
            "status": "ok",
            "schema_version": BOKEH_SESSION_SCHEMA_VERSION,
            "session_id": session_id,
            "transaction_id": transaction_id,
            "source_ids": folded,
        }
    except Exception as exc:  # noqa: BLE001
        reply = {
            "status": "error",
            "schema_version": BOKEH_SESSION_SCHEMA_VERSION,
            "session_id": session_id,
            "transaction_id": transaction_id,
            "error": _error_payload(exc),
        }
    kernel.send_extension_reply(stream, ident, BOKEH_FOLD_REPLY, reply)


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
    kernel.send_extension_reply(stream, ident, BOKEH_CLOSE_REPLY, reply)


SHELL_HANDLERS: dict[str, Callable[[Any, Any, Any, dict[str, Any]], None]] = {
    BOKEH_PATCH_REQUEST: patch_request,
    BOKEH_FOLD_REQUEST: fold_request,
    BOKEH_CLOSE_REQUEST: close_request,
}


@dataclass
class _Installation:
    unregister: list[Callable[[], None]] = field(default_factory=list)
    publisher: Any = None


_installation: _Installation | None = None


def install_kernel_hooks(ip: Any) -> None:
    """Register the Bokeh shell handlers and the delta publisher on ``ip.kernel``.

    Plain ipykernel kernels have neither seam; the registry then stays without
    an event sink and Panel outputs render static. All or nothing, so a failed
    install leaves no handler behind and the Panel formatter sees no live sink.
    """
    global _installation

    kernel = getattr(ip, "kernel", None)
    register = getattr(kernel, "register_shell_handler", None)
    make_publisher = getattr(kernel, "iopub_publisher", None)
    if register is None or make_publisher is None:
        return
    installation = _Installation()
    try:
        for msg_type, handler in SHELL_HANDLERS.items():
            installation.unregister.append(register(msg_type, partial(handler, kernel)))
        installation.publisher = make_publisher(BOKEH_DELTA, wire_bokeh_delta)
    except BaseException:
        for unregister in installation.unregister:
            unregister()
        raise
    _installation = installation
    session_registry.set_event_sink(installation.publisher.publish)


def uninstall_kernel_hooks(ip: Any) -> None:
    global _installation

    installation, _installation = _installation, None
    if installation is None:
        return
    session_registry.set_event_sink(None)
    installation.publisher.close()
    for unregister in installation.unregister:
        unregister()
