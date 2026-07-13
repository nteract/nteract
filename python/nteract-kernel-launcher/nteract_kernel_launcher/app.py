"""IPKernelApp → IPythonKernel → ZMQInteractiveShell → ZMQShellDisplayHook
subclass cascade.

Three ``Type`` traits compose through subclassing to land
``NteractShellDisplayHook`` as the active displayhook when a kernel boots
via ``NteractKernelApp.launch_instance()``. The only behavioral change vs.
the upstream ``ipykernel`` cascade is a hook chain added to
``finish_displayhook`` — mirroring the one ``ZMQDisplayPublisher`` already
has for ``display_data``.

With the hook chain in place, ``execute_result`` messages (emitted for
bare-``df``-on-last-line) can carry ZeroMQ buffers via the same
transform pipeline. The ``ipython_display_formatter`` short-circuit that
dx's ``install()`` uses today to route bare last-expressions through
``display_data`` becomes unnecessary.
"""

from __future__ import annotations

import hashlib
import sys
import threading
import traceback
import uuid
from collections import deque
from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
from typing import Any

from ipykernel.displayhook import ZMQShellDisplayHook
from ipykernel.ipkernel import IPythonKernel
from ipykernel.kernelapp import IPKernelApp
from ipykernel.zmqshell import ZMQInteractiveShell
from traitlets import List, Type, Unicode

from nteract_kernel_launcher._bokeh_session import (
    BOKEH_SESSION_SCHEMA_VERSION,
    BokehBuffer,
    BokehPatchApplyError,
    BokehSerialization,
    BokehServerEvent,
    StaleBokehRevisionError,
    session_registry,
)

_BOKEH_PATCH_REQUEST = "nteract_bokeh_patch_request"
_BOKEH_PATCH_REPLY = "nteract_bokeh_patch_reply"
_BOKEH_CHECKPOINT_REQUEST = "nteract_bokeh_checkpoint_request"
_BOKEH_CHECKPOINT_REPLY = "nteract_bokeh_checkpoint_reply"
_BOKEH_CLOSE_REQUEST = "nteract_bokeh_close_request"
_BOKEH_CLOSE_REPLY = "nteract_bokeh_close_reply"
_BOKEH_EVENT = "nteract_bokeh_event"


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


def _wire_bokeh_event(event: BokehServerEvent) -> tuple[dict[str, Any], list[bytes]]:
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


def _send_bokeh_reply(
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


class NteractShellDisplayHook(ZMQShellDisplayHook):
    """``ZMQShellDisplayHook`` + a thread-local hook chain on ``finish_displayhook``.

    Mirrors ``ZMQDisplayPublisher._hooks`` / ``.register_hook`` exactly so the
    same hook function can be registered on both seats and be agnostic about
    which message type is being built.

    Hook contract (identical to ``ZMQDisplayPublisher``):

    - ``hook(msg) -> msg``  — pass through; default ``session.send`` runs.
    - ``hook(msg) -> None`` — hook handled send itself; default is suppressed.
    """

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._tls = threading.local()

    @property
    def _hooks(self):
        if not hasattr(self._tls, "hooks"):
            self._tls.hooks = []
        return self._tls.hooks

    def register_hook(self, hook):
        """Append *hook* to the thread-local hook chain."""
        self._hooks.append(hook)

    def unregister_hook(self, hook):
        """Remove *hook* from the hook chain. Returns ``True`` on success."""
        try:
            self._hooks.remove(hook)
            return True
        except ValueError:
            return False

    def finish_displayhook(self):
        """Override: run the hook chain before ``session.send``.

        Preserves the parent's guards — only sends if ``self.msg`` exists,
        ``content.data`` is non-empty, and ``self.session`` is configured.
        That keeps any ``ipython_display_formatter`` returning ``True``
        from producing a bufferless follow-up send.
        """
        sys.stdout.flush()
        sys.stderr.flush()
        if self.msg and self.msg["content"]["data"] and self.session:
            msg = self.msg
            for hook in self._hooks:
                msg = hook(msg)
                if msg is None:
                    self.msg = None
                    return
            self.session.send(self.pub_socket, msg, ident=self.topic)
        self.msg = None


class NteractShell(ZMQInteractiveShell):
    """Shell subclass that wires in ``NteractShellDisplayHook``."""

    displayhook_class = Type(NteractShellDisplayHook)


class NteractKernel(IPythonKernel):
    """Kernel subclass that wires in ``NteractShell``."""

    shell_class = Type(NteractShell)
    msg_types = [
        *IPythonKernel.msg_types,
        _BOKEH_PATCH_REQUEST,
        _BOKEH_CHECKPOINT_REQUEST,
        _BOKEH_CLOSE_REQUEST,
    ]

    def __init__(self, *args, **kwargs):
        self._bokeh_event_lock = threading.Lock()
        self._bokeh_event_queue: deque[BokehServerEvent] = deque()
        self._bokeh_event_drain_scheduled = False
        super().__init__(*args, **kwargs)
        session_registry.set_event_sink(self._enqueue_bokeh_event)

    def _enqueue_bokeh_event(self, event: BokehServerEvent) -> None:
        with self._bokeh_event_lock:
            self._bokeh_event_queue.append(event)
            if self._bokeh_event_drain_scheduled:
                return
            self._bokeh_event_drain_scheduled = True
        try:
            self.io_loop.add_callback(self._drain_bokeh_events)
        except Exception:
            with self._bokeh_event_lock:
                self._bokeh_event_drain_scheduled = False
            self.log.exception("Could not schedule Bokeh session event publication")

    def _drain_bokeh_events(self) -> None:
        while True:
            with self._bokeh_event_lock:
                if not self._bokeh_event_queue:
                    self._bokeh_event_drain_scheduled = False
                    return
                event = self._bokeh_event_queue.popleft()

            try:
                content, buffers = _wire_bokeh_event(event)
                wire_buffers: list[bytes | memoryview[bytes]] = list(buffers)
            except Exception:
                # Serialization failures are deterministic for this event. Drop
                # it so one malformed payload cannot wedge the publication loop.
                self.log.exception("Could not serialize Bokeh session event; dropping event")
                continue
            try:
                self.session.send(
                    self.iopub_socket,
                    _BOKEH_EVENT,
                    content,
                    parent=None,
                    ident=self._topic(_BOKEH_EVENT),
                    buffers=wire_buffers,
                )
            except Exception:
                with self._bokeh_event_lock:
                    self._bokeh_event_queue.appendleft(event)
                    self._bokeh_event_drain_scheduled = False
                self.log.exception("Could not publish Bokeh session event")
                return

    def nteract_bokeh_patch_request(self, stream, ident, parent):
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
                raise TypeError(
                    "Bokeh patch request requires integer base_revision and object patch"
                )
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

        _send_bokeh_reply(
            self,
            stream,
            ident,
            _BOKEH_PATCH_REPLY,
            reply,
        )

    def nteract_bokeh_checkpoint_request(self, stream, ident, parent):
        content = parent.get("content", {})
        session_id = content.get("session_id")
        transaction_id = content.get("transaction_id") or str(uuid.uuid4())
        reply_buffers: list[bytes] = []
        try:
            if not isinstance(session_id, str):
                raise TypeError("Bokeh checkpoint request requires session_id")
            session = session_registry.require(session_id)
            checkpoint, reply_buffers = _wire_serialization(
                session.snapshot(),
                content_key="document",
            )
            reply = {
                "status": "ok",
                "schema_version": BOKEH_SESSION_SCHEMA_VERSION,
                "session_id": session_id,
                "transaction_id": transaction_id,
                "revision": session.revision,
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
        _send_bokeh_reply(
            self,
            stream,
            ident,
            _BOKEH_CHECKPOINT_REPLY,
            reply,
            reply_buffers,
        )

    def nteract_bokeh_close_request(self, stream, ident, parent):
        content = parent.get("content", {})
        session_id = content.get("session_id")
        transaction_id = content.get("transaction_id") or str(uuid.uuid4())
        if not isinstance(session_id, str):
            reply = {
                "status": "error",
                "schema_version": BOKEH_SESSION_SCHEMA_VERSION,
                "session_id": session_id,
                "transaction_id": transaction_id,
                "error": _error_payload(TypeError("Bokeh close request requires session_id")),
            }
        else:
            reply = {
                "status": "ok" if session_registry.close(session_id) else "not_found",
                "schema_version": BOKEH_SESSION_SCHEMA_VERSION,
                "session_id": session_id,
                "transaction_id": transaction_id,
            }
        _send_bokeh_reply(self, stream, ident, _BOKEH_CLOSE_REPLY, reply)


class NteractKernelApp(IPKernelApp):
    """Kernel-app subclass. Activates the full ``Nteract*`` cascade and
    auto-loads the bootstrap extension before any user code runs.

    ``default_extensions`` is an ``InteractiveShellApp`` trait consulted by
    ``init_extensions`` during kernel startup. Extensions listed here load
    via ``ExtensionManager.load_extension``, which log-warns on failure
    rather than raising — bootstrap problems never present as a traceback
    to the user.
    """

    kernel_class = Type(NteractKernel)

    default_extensions = List(
        Unicode(),
        [
            "storemagic",  # IPython's own default
            "nteract_kernel_launcher._bootstrap",
        ],
    )
