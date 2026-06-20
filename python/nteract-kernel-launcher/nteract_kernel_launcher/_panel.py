"""Panel runtime-state hook for the nteract kernel launcher.

This module deliberately does not import Panel on kernel startup. It installs a
small import hook that can patch Panel after user code imports it. The patched
manager is a compatibility adapter for Panel/PyViz's current notebook backend:
it preserves the API Panel calls today while emitting typed Panel/Bokeh channel
events for a future daemon-backed transport.
"""

from __future__ import annotations

import logging
import os
import sys
import traceback
import uuid
from collections.abc import Callable
from contextlib import suppress
from functools import wraps
from io import StringIO
from typing import Any

log = logging.getLogger("nteract_kernel_launcher")

PANEL_RUNTIME_STATE_ENV = "NTERACT_PANEL_RUNTIME_STATE"
NTERACT_PANEL_RUNTIME_MIME = "application/vnd.nteract.panel-runtime.v1+json"
_TRUE_VALUES = frozenset({"1", "true", "yes", "on", "enabled"})
_PANEL_IMPORT_TARGETS = frozenset(
    {"panel", "panel.viewable", "panel.io.notebook", "panel.io.state"}
)
_panel_import_hook: Any | None = None
_event_sink: Callable[[dict[str, Any]], None] | None = None


def panel_runtime_state_enabled() -> bool:
    """Return whether the experimental native Panel runtime path is enabled."""
    return os.environ.get(PANEL_RUNTIME_STATE_ENV, "").strip().lower() in _TRUE_VALUES


def set_panel_runtime_event_sink(sink: Callable[[dict[str, Any]], None] | None) -> None:
    """Install an in-process sink for typed Panel runtime events.

    The daemon transport is a later slice. Tests and future launcher glue can
    use this hook to observe the exact event surface without opening raw
    Jupyter comms.
    """
    global _event_sink
    _event_sink = sink


def _emit_panel_event(event: dict[str, Any]) -> None:
    event.setdefault("protocol", "nteract.panel.runtime.v1")
    sink = _event_sink
    if sink is not None:
        sink(event)
    else:
        log.debug("panel runtime event: %s", event)


class _CapturedStdout(list[str]):
    def __enter__(self) -> _CapturedStdout:
        self._stdout = sys.stdout
        sys.stdout = self._stringio = StringIO()
        return self

    def __exit__(self, *_args: Any) -> None:
        try:
            self.extend(self._stringio.getvalue().splitlines())
        finally:
            if sys.stdout is self._stringio:
                sys.stdout = self._stdout


class NteractPanelComm:
    """PyViz-compatible comm that emits typed nteract Panel runtime events."""

    def __init__(
        self,
        id: str | None = None,
        on_msg: Callable[[dict[str, Any]], None] | None = None,
        on_error: Callable[[Exception], None] | None = None,
        on_stdout: Callable[[list[str]], None] | None = None,
        on_open: Callable[[dict[str, Any]], None] | None = None,
        on_close: Callable[[str], None] | None = None,
        *,
        role: str,
    ) -> None:
        self.id = id if id else uuid.uuid4().hex
        self._on_msg = on_msg
        self._on_error = on_error
        self._on_stdout = on_stdout
        self._on_open = on_open
        self._on_close = on_close
        self.role = role
        self.active = True
        self.connected = True
        _emit_panel_event({"type": "panel_channel_open", "comm_id": self.id, "role": self.role})

    def init(self, on_msg: Callable[[dict[str, Any]], None] | None = None) -> None:
        if on_msg is not None:
            self._on_msg = on_msg
        if self._on_open:
            self._on_open({})
        _emit_panel_event({"type": "panel_comm_init", "comm_id": self.id, "role": self.role})

    def close(self) -> None:
        self.active = False
        self.connected = False
        _emit_panel_event({"type": "panel_channel_close", "comm_id": self.id, "role": self.role})
        if self._on_close:
            with suppress(Exception):
                self._on_close(self.id)

    def send(
        self,
        data: Any = None,
        metadata: dict[str, Any] | None = None,
        buffers: list[Any] | None = None,
    ) -> None:
        _emit_panel_event(
            {
                "type": _panel_event_type_for_send(self.role, metadata),
                "comm_id": self.id,
                "role": self.role,
                "data": data,
                "metadata": metadata or {},
                "buffers": buffers or [],
            }
        )

    @classmethod
    def decode(cls, msg: Any) -> dict[str, Any]:
        if not isinstance(msg, dict):
            return {"data": msg}

        content = msg.get("content")
        if isinstance(content, dict) and isinstance(content.get("data"), dict):
            decoded = dict(content["data"])
            buffers = msg.get("buffers")
            if buffers:
                decoded["_buffers"] = dict(enumerate(buffers))
            return decoded

        return dict(msg)

    def _handle_msg(self, msg: Any) -> None:
        """Mirror PyViz's callback/ACK behavior for future inbound patches."""
        comm_id = None
        stdout: list[str] = []
        try:
            decoded = self.decode(msg)
            comm_id = decoded.pop("comm_id", None)
            if self._on_msg:
                captured = None
                try:
                    with _CapturedStdout() as captured:
                        self._on_msg(decoded)
                finally:
                    if captured is not None:
                        stdout = list(captured)
                if stdout:
                    with suppress(Exception):
                        if self._on_stdout:
                            self._on_stdout(stdout)
        except Exception as exc:  # noqa: BLE001
            if stdout:
                with suppress(Exception):
                    if self._on_stdout:
                        self._on_stdout(stdout)
            with suppress(Exception):
                if self._on_error:
                    self._on_error(exc)
            frames = traceback.extract_tb(sys.exc_info()[2])
            lines = [""] + [f"{fname} {fn} L{lineno}" for fname, lineno, fn, _text in frames[-20:]]
            lines.append(f"\t{type(exc).__name__}: {exc!s}")
            if stdout:
                lines.insert(0, "\n\t" + "\n\t".join(stdout))
            reply: dict[str, Any] = {"msg_type": "Error", "traceback": "\n".join(lines)}
        else:
            reply = {
                "msg_type": "Ready",
                "content": "\n\t" + "\n\t".join(stdout) if stdout else "",
            }

        if comm_id:
            reply["comm_id"] = comm_id
        self.send(metadata=reply)


def _panel_event_type_for_send(role: str, metadata: dict[str, Any] | None) -> str:
    if isinstance(metadata, dict) and metadata.get("msg_type") in {"Ready", "Error"}:
        return "panel_ack"
    if role == "server":
        return "panel_server_patch"
    if role == "client":
        return "panel_client_patch"
    return "panel_message"


def _panel_event_comm_id(event: dict[str, Any]) -> str | None:
    comm_id = event.get("comm_id")
    if isinstance(comm_id, str) and comm_id:
        return comm_id

    payload = event.get("payload")
    if isinstance(payload, dict):
        comm_id = payload.get("commId") or payload.get("comm_id")
        if isinstance(comm_id, str) and comm_id:
            return comm_id

    channel = event.get("channel")
    if isinstance(channel, dict):
        comm_id = channel.get("commId") or channel.get("comm_id")
        if isinstance(comm_id, str) and comm_id:
            return comm_id

    return None


def _panel_event_patch(event: dict[str, Any], comm_id: str) -> dict[str, Any]:
    patch = event.get("patch")
    if not isinstance(patch, dict):
        payload = event.get("payload")
        patch = payload if isinstance(payload, dict) else event

    data = patch.get("data") if isinstance(patch, dict) else None
    metadata = patch.get("metadata") if isinstance(patch, dict) else None
    buffers = patch.get("buffers") if isinstance(patch, dict) else None

    content_data = dict(data) if isinstance(data, dict) else {"data": data}
    content_data.setdefault("comm_id", comm_id)

    return {
        "content": {"data": content_data},
        "metadata": metadata if isinstance(metadata, dict) else {},
        "buffers": buffers if isinstance(buffers, list) else [],
    }


class NteractPanelServerComm(NteractPanelComm):
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, role="server", **kwargs)


class NteractPanelClientComm(NteractPanelComm):
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, role="client", **kwargs)


class NteractPanelCommManager:
    """Panel/PyViz compatibility adapter backed by typed nteract runtime events."""

    # The browser-side comm manager is installed by the isolated renderer's
    # TypeScript bundle so it can be type-checked and tested with the transport
    # it uses. Panel still expects this attribute to exist when composing its
    # extension JavaScript, so keep it as an empty no-op string.
    js_manager = ""

    _comms: dict[str, NteractPanelComm] = {}
    server_comm = NteractPanelServerComm
    client_comm = NteractPanelClientComm
    _nteract_panel_comm_manager = True
    _nteract_original_manager: Any | None = None
    _nteract_original_bindings: dict[tuple[str, str], Any] = {}

    @classmethod
    def _remember_original_manager(cls, manager: Any | None) -> None:
        if manager is None or getattr(manager, "_nteract_panel_comm_manager", False):
            return
        if cls._nteract_original_manager is None:
            cls._nteract_original_manager = manager

    @classmethod
    def _remember_original_binding(cls, module_name: str, attr: str, value: Any) -> None:
        if getattr(value, "_nteract_panel_comm_manager", False):
            return
        cls._remember_original_manager(value)
        cls._nteract_original_bindings.setdefault((module_name, attr), value)

    @classmethod
    def _forget_comm(cls, comm_id: str) -> None:
        cls._comms.pop(comm_id, None)

    @classmethod
    def clear_comms(cls) -> None:
        for comm in list(cls._comms.values()):
            with suppress(Exception):
                comm.close()
        cls._comms.clear()

    @classmethod
    def get_server_comm(
        cls,
        on_msg: Callable[[dict[str, Any]], None] | None = None,
        id: str | None = None,
        on_error: Callable[[Exception], None] | None = None,
        on_stdout: Callable[[list[str]], None] | None = None,
        on_open: Callable[[dict[str, Any]], None] | None = None,
    ) -> NteractPanelComm:
        comm = cls.server_comm(id, on_msg, on_error, on_stdout, on_open, on_close=cls._forget_comm)
        cls._comms[comm.id] = comm
        return comm

    @classmethod
    def get_client_comm(
        cls,
        on_msg: Callable[[dict[str, Any]], None] | None = None,
        id: str | None = None,
        on_error: Callable[[Exception], None] | None = None,
        on_stdout: Callable[[list[str]], None] | None = None,
        on_open: Callable[[dict[str, Any]], None] | None = None,
    ) -> NteractPanelComm:
        comm = cls.client_comm(id, on_msg, on_error, on_stdout, on_open, on_close=cls._forget_comm)
        cls._comms[comm.id] = comm
        return comm

    @classmethod
    def receive_runtime_event(cls, event: dict[str, Any]) -> bool:
        """Deliver a typed nteract Panel runtime event into Panel's callbacks."""
        event_type = event.get("type")
        if event_type not in {"panel_client_patch", "client_patch"}:
            return False

        comm_id = _panel_event_comm_id(event)
        if comm_id is None:
            return False

        comm = cls._comms.get(comm_id)
        if comm is None:
            return False

        comm._handle_msg(_panel_event_patch(event, comm_id))
        return True


def _panel_runtime_marker(self: Any, model: Any, doc: Any, comm: Any) -> dict[str, Any]:
    ref = getattr(model, "ref", {})
    plot_id = ref.get("id") if isinstance(ref, dict) else getattr(ref, "id", None)
    comms = getattr(self, "_comms", {})
    pair = comms.get(plot_id) if plot_id is not None and hasattr(comms, "get") else None
    client_comm = pair[1] if isinstance(pair, tuple) and len(pair) > 1 else None

    marker = {
        "version": 1,
        "protocol": "nteract.panel.runtime.v1",
        "plot_id": plot_id,
        "server_comm_id": getattr(comm, "id", None),
        "client_comm_id": getattr(client_comm, "id", None),
    }
    document_id = getattr(doc, "id", None)
    if document_id is not None:
        marker["document_id"] = document_id
    return {key: value for key, value in marker.items() if value is not None}


def _add_panel_runtime_marker(
    mimebundle: tuple[dict[str, Any], dict[str, Any]],
    self: Any,
    model: Any,
    doc: Any,
    comm: Any,
) -> tuple[dict[str, Any], dict[str, Any]]:
    data, metadata = mimebundle
    if not isinstance(data, dict) or not isinstance(metadata, dict):
        return mimebundle

    marker = _panel_runtime_marker(self, model, doc, comm)
    data[NTERACT_PANEL_RUNTIME_MIME] = marker
    marker_metadata = {
        "id": marker.get("plot_id"),
        "server_comm_id": marker.get("server_comm_id"),
        "client_comm_id": marker.get("client_comm_id"),
    }
    metadata[NTERACT_PANEL_RUNTIME_MIME] = {
        key: value for key, value in marker_metadata.items() if value is not None
    }
    return data, metadata


def _patch_panel_mimebundle(viewable: Any) -> bool:
    mixin = getattr(viewable, "MimeRenderMixin", None)
    render_mimebundle = getattr(mixin, "_render_mimebundle", None) if mixin is not None else None
    if render_mimebundle is None or getattr(
        render_mimebundle, "_nteract_panel_runtime_mime", False
    ):
        return False

    @wraps(render_mimebundle)
    def _nteract_render_mimebundle(
        self: Any, model: Any, doc: Any, comm: Any, location: Any = None
    ):
        mimebundle = render_mimebundle(self, model, doc, comm, location)
        if isinstance(mimebundle, tuple) and len(mimebundle) == 2:
            return _add_panel_runtime_marker(mimebundle, self, model, doc, comm)
        return mimebundle

    _nteract_render_mimebundle._nteract_panel_runtime_mime = True  # type: ignore[attr-defined]
    _nteract_render_mimebundle._nteract_original = render_mimebundle  # type: ignore[attr-defined]
    type.__setattr__(mixin, "_render_mimebundle", _nteract_render_mimebundle)
    return True


def _unpatch_panel_mimebundle(viewable: Any) -> bool:
    mixin = getattr(viewable, "MimeRenderMixin", None)
    render_mimebundle = getattr(mixin, "_render_mimebundle", None) if mixin is not None else None
    original = getattr(render_mimebundle, "_nteract_original", None)
    if original is None:
        return False

    type.__setattr__(mixin, "_render_mimebundle", original)
    return True


def _patch_panel_modules() -> bool:
    if not panel_runtime_state_enabled():
        return False

    patched = False
    notebook = sys.modules.get("panel.io.notebook")
    if notebook is not None:
        for name in ("JupyterCommManagerBinary", "_JupyterCommManager"):
            if hasattr(notebook, name):
                NteractPanelCommManager._remember_original_binding(
                    "panel.io.notebook",
                    name,
                    getattr(notebook, name),
                )
                setattr(notebook, name, NteractPanelCommManager)
                patched = True

    viewable = sys.modules.get("panel.viewable")
    if viewable is not None and hasattr(viewable, "JupyterCommManager"):
        current = viewable.JupyterCommManager
        if not getattr(current, "_nteract_panel_comm_manager", False):
            # Keep the first original binding so a future restore path knows
            # which manager Panel exposed before nteract patched any module.
            NteractPanelCommManager._remember_original_binding(
                "panel.viewable",
                "JupyterCommManager",
                current,
            )
        viewable.JupyterCommManager = NteractPanelCommManager
        patched = True
        patched = _patch_panel_mimebundle(viewable) or patched

    state_module = sys.modules.get("panel.io.state")
    state = getattr(state_module, "state", None) if state_module is not None else None
    if state is not None:
        current = getattr(state, "_comm_manager", None)
        if not getattr(current, "_nteract_panel_comm_manager", False):
            NteractPanelCommManager._remember_original_binding(
                "panel.io.state",
                "state._comm_manager",
                current,
            )
            state._comm_manager = NteractPanelCommManager
            patched = True

    if patched:
        log.debug("patched Panel comm manager for nteract runtime state")
    return patched


def _restore_panel_modules() -> None:
    viewable = sys.modules.get("panel.viewable")
    if viewable is not None:
        _unpatch_panel_mimebundle(viewable)

    for (module_name, attr), original in list(
        NteractPanelCommManager._nteract_original_bindings.items()
    ):
        module = sys.modules.get(module_name)
        if module is None:
            continue
        if attr == "state._comm_manager":
            state = getattr(module, "state", None)
            if (
                state is not None
                and getattr(state, "_comm_manager", None) is NteractPanelCommManager
            ):
                state._comm_manager = original
            continue
        if getattr(module, attr, None) is NteractPanelCommManager:
            setattr(module, attr, original)


class _PanelLoader:
    def __init__(self, loader: Any) -> None:
        self._loader = loader

    def create_module(self, spec: Any) -> Any:
        create_module = getattr(self._loader, "create_module", None)
        if create_module is None:
            return None
        return create_module(spec)

    def exec_module(self, module: Any) -> None:
        self._loader.exec_module(module)
        _patch_panel_modules()

    def load_module(self, fullname: str) -> Any:
        module = self._loader.load_module(fullname)
        _patch_panel_modules()
        return module

    def __getattr__(self, name: str) -> Any:
        return getattr(self._loader, name)


class _PanelImportHook:
    _nteract_panel_import_hook = True

    def find_spec(self, fullname: str, path: Any = None, target: Any = None) -> Any:
        if fullname not in _PANEL_IMPORT_TARGETS:
            return None

        for finder in sys.meta_path:
            if getattr(finder, "_nteract_panel_import_hook", False):
                continue
            find_spec = getattr(finder, "find_spec", None)
            if find_spec is None:
                continue
            spec = find_spec(fullname, path, target)
            if spec is None:
                continue
            loader = spec.loader
            if (
                loader is not None
                and not isinstance(loader, _PanelLoader)
                and getattr(loader, "exec_module", None) is not None
            ):
                spec.loader = _PanelLoader(loader)
            return spec

        return None


def _install_panel_import_hook() -> None:
    global _panel_import_hook

    for finder in sys.meta_path:
        if getattr(finder, "_nteract_panel_import_hook", False):
            _panel_import_hook = finder
            return

    hook = _PanelImportHook()
    sys.meta_path.insert(0, hook)
    _panel_import_hook = hook


def _uninstall_panel_import_hook() -> None:
    global _panel_import_hook

    sys.meta_path[:] = [
        finder
        for finder in sys.meta_path
        if not getattr(finder, "_nteract_panel_import_hook", False)
    ]
    _panel_import_hook = None


def install() -> None:
    """Install the lazy Panel hook and patch already-loaded Panel modules."""
    _patch_panel_modules()
    _install_panel_import_hook()


def uninstall() -> None:
    """Remove the lazy import hook and restore any loaded Panel monkeypatches."""
    _restore_panel_modules()
    NteractPanelCommManager.clear_comms()
    NteractPanelCommManager._nteract_original_manager = None
    NteractPanelCommManager._nteract_original_bindings.clear()
    _uninstall_panel_import_hook()
