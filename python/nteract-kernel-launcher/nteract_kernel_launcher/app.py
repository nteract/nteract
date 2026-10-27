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

import sys
import threading
from collections import deque
from collections.abc import Awaitable, Callable
from typing import Any, Generic, TypeVar

from ipykernel.displayhook import ZMQShellDisplayHook
from ipykernel.ipkernel import IPythonKernel
from ipykernel.kernelapp import IPKernelApp
from ipykernel.zmqshell import ZMQInteractiveShell
from traitlets import List, Type, Unicode

from nteract_kernel_launcher.transport import ReliableIOPubMixin

ShellHandler = Callable[[Any, list[bytes], dict[str, Any]], None | Awaitable[None]]
T = TypeVar("T")
IOPubEncoder = Callable[[T], tuple[dict[str, Any], list[bytes]]]


class IOPubPublisher(Generic[T]):
    """Ordered, thread-safe IOPub publisher that sends from the calling thread.

    Scheduling sends on the kernel IOLoop would hold every message until a
    running cell finishes. The IOPub socket hands messages to ipykernel's IOPub
    thread, which is how ``print`` streams during a cell.

    Items are encoded at send time. An encode error is deterministic for that
    item, so it is dropped; a send error keeps it queued and the next
    ``publish`` retries it first. ``encode`` must not publish to this publisher.
    """

    def __init__(
        self,
        msg_type: str,
        encode: IOPubEncoder[T],
        send: Callable[[str, dict[str, Any], list[bytes]], None],
        log: Any,
    ) -> None:
        self.msg_type = msg_type
        self._encode = encode
        self._send = send
        self._log = log
        self._lock = threading.Lock()
        self._queue: deque[T] = deque()
        self._closed = False

    def publish(self, item: T) -> None:
        with self._lock:
            if self._closed:
                return
            self._queue.append(item)
            while self._queue:
                head = self._queue[0]
                try:
                    content, buffers = self._encode(head)
                except Exception:
                    self._queue.popleft()
                    self._log.exception("Could not encode %s; dropping it", self.msg_type)
                    continue
                try:
                    self._send(self.msg_type, content, buffers)
                except Exception:
                    self._log.exception("Could not publish %s", self.msg_type)
                    return
                self._queue.popleft()

    def close(self) -> None:
        """Drop queued items; later ``publish`` calls do nothing."""
        with self._lock:
            self._closed = True
            self._queue.clear()

    def __len__(self) -> int:
        with self._lock:
            return len(self._queue)


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

    def register_shell_handler(self, msg_type: str, handler: ShellHandler) -> Callable[[], None]:
        """Install *handler* for shell messages of *msg_type*; returns an unregister callable.

        ``Kernel.__init__`` has already built ``shell_handlers`` from ``msg_types``,
        so this writes the table directly, as ipykernel does for comm messages.
        Raises ``ValueError`` if *msg_type* already has a handler, built-ins
        included, so extensions cannot silently replace each other.
        """
        if msg_type in self.shell_handlers:
            raise ValueError(f"shell handler already registered for {msg_type!r}")
        self.shell_handlers[msg_type] = handler

        def unregister() -> None:
            if self.shell_handlers.get(msg_type) is handler:
                del self.shell_handlers[msg_type]

        return unregister

    def iopub_publisher(self, msg_type: str, encode: IOPubEncoder[T]) -> IOPubPublisher[T]:
        """An :class:`IOPubPublisher` for unparented *msg_type* messages on this kernel."""

        def send(msg_type: str, content: dict[str, Any], buffers: list[bytes]) -> None:
            wire_buffers: list[bytes | memoryview[bytes]] = list(buffers)
            self.session.send(
                self.iopub_socket,
                msg_type,
                content,
                parent=None,
                ident=self._topic(msg_type),
                buffers=wire_buffers,
            )

        return IOPubPublisher(msg_type, encode, send, self.log)

    def send_extension_reply(
        self,
        stream: Any,
        ident: Any,
        msg_type: str,
        content: dict[str, Any],
        buffers: list[bytes] | None = None,
    ) -> None:
        """Reply to the shell request being handled (ipykernel tracks its parent)."""
        self.send_response(stream, msg_type, content=content, ident=ident, buffers=buffers or [])


class NteractKernelApp(ReliableIOPubMixin, IPKernelApp):
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
