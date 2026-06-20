"""Panel runtime-state hook for the nteract kernel launcher.

This module deliberately does not import Panel on kernel startup. It installs a
small import hook that can patch Panel after user code imports it. The patched
comm manager exposes Panel/PyViz's expected Python and JavaScript surfaces while
emitting typed Panel/Bokeh channel events for a future daemon-backed transport.
"""

from __future__ import annotations

import logging
import os
import sys
import traceback
import uuid
from collections.abc import Callable
from contextlib import suppress
from io import StringIO
from typing import Any

log = logging.getLogger("nteract_kernel_launcher")

PANEL_RUNTIME_STATE_ENV = "NTERACT_PANEL_RUNTIME_STATE"
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
        self.extend(self._stringio.getvalue().splitlines())
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
        *,
        role: str,
    ) -> None:
        self.id = id if id else uuid.uuid4().hex
        self._on_msg = on_msg
        self._on_error = on_error
        self._on_stdout = on_stdout
        self._on_open = on_open
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
                with _CapturedStdout() as captured:
                    self._on_msg(decoded)
                stdout = list(captured)
                if stdout:
                    with suppress(Exception):
                        if self._on_stdout:
                            self._on_stdout(stdout)
        except Exception as exc:  # noqa: BLE001
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


class NteractPanelServerComm(NteractPanelComm):
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, role="server", **kwargs)


class NteractPanelClientComm(NteractPanelComm):
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, role="client", **kwargs)


class NteractPanelCommManager:
    """Panel/PyViz comm manager backed by typed nteract runtime events."""

    js_manager = """
    (function() {
      if ((window.PyViz === undefined) || (window.PyViz instanceof HTMLElement)) {
        window.PyViz = {comms: {}, comm_status: {}, kernels: {}, receivers: {}, plot_index: []};
      }

      function runtime() {
        return window.__nteractPanelRuntime || null;
      }

      function NteractPanelCommManager() {
        this.targets = {};
        this.comms = {};
      }

      NteractPanelCommManager.prototype.register_target = function(plot_id, comm_id, msg_handler) {
        this.targets[comm_id] = {plot_id: plot_id, msg_handler: msg_handler};
        var rt = runtime();
        if (rt && rt.registerTarget) {
          rt.registerTarget({plotId: plot_id, commId: comm_id});
        }
      };

      NteractPanelCommManager.prototype.get_client_comm = function(plot_id, comm_id, msg_handler) {
        if (comm_id in this.comms) {
          return this.comms[comm_id];
        }
        var comm = {
          active: true,
          connected: true,
          onMsg: msg_handler,
          on_msg: function(handler) { comm.onMsg = handler; },
          send: function(data, metadata, buffers) {
            var rt = runtime();
            if (!rt || !rt.sendClientPatch) {
              console.warn("nteract Panel runtime transport is not connected");
              return;
            }
            rt.sendClientPatch({
              plotId: plot_id,
              commId: comm_id,
              data: data,
              metadata: metadata || {},
              buffers: buffers || []
            });
          },
          close: function() {
            comm.active = false;
            comm.connected = false;
            var rt = runtime();
            if (rt && rt.closeChannel) {
              rt.closeChannel({plotId: plot_id, commId: comm_id});
            }
          }
        };
        if (msg_handler) {
          comm.onMsg = msg_handler;
        }
        this.comms[comm_id] = comm;
        window.PyViz.comms[comm_id] = comm;
        return comm;
      };

      window.PyViz.comm_manager = new NteractPanelCommManager();
    })();
    """

    _comms: dict[str, NteractPanelComm] = {}
    server_comm = NteractPanelServerComm
    client_comm = NteractPanelClientComm
    _nteract_panel_comm_manager = True
    _nteract_original_manager: Any | None = None

    @classmethod
    def get_server_comm(
        cls,
        on_msg: Callable[[dict[str, Any]], None] | None = None,
        id: str | None = None,
        on_error: Callable[[Exception], None] | None = None,
        on_stdout: Callable[[list[str]], None] | None = None,
        on_open: Callable[[dict[str, Any]], None] | None = None,
    ) -> NteractPanelComm:
        comm = cls.server_comm(id, on_msg, on_error, on_stdout, on_open)
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
        comm = cls.client_comm(id, on_msg, on_error, on_stdout, on_open)
        cls._comms[comm.id] = comm
        return comm


def _patch_panel_modules() -> bool:
    if not panel_runtime_state_enabled():
        return False

    patched = False
    original_manager: Any | None = None
    notebook = sys.modules.get("panel.io.notebook")
    if notebook is not None:
        original_manager = getattr(notebook, "JupyterCommManagerBinary", None) or getattr(
            notebook, "_JupyterCommManager", None
        )
        if original_manager is not None and not getattr(
            original_manager, "_nteract_panel_comm_manager", False
        ):
            NteractPanelCommManager._nteract_original_manager = original_manager
        for name in ("JupyterCommManagerBinary", "_JupyterCommManager"):
            if hasattr(notebook, name):
                setattr(notebook, name, NteractPanelCommManager)
                patched = True

    viewable = sys.modules.get("panel.viewable")
    if viewable is not None and hasattr(viewable, "JupyterCommManager"):
        current = viewable.JupyterCommManager
        if not getattr(current, "_nteract_panel_comm_manager", False):
            original_manager = current
            NteractPanelCommManager._nteract_original_manager = current
        viewable.JupyterCommManager = NteractPanelCommManager
        patched = True

    state_module = sys.modules.get("panel.io.state")
    state = getattr(state_module, "state", None) if state_module is not None else None
    if state is not None:
        current = getattr(state, "_comm_manager", None)
        if current is original_manager or getattr(current, "_nteract_panel_comm_manager", False):
            state._comm_manager = NteractPanelCommManager
            patched = True

    if patched:
        log.debug("patched Panel comm manager for nteract runtime state")
    return patched


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
    """Remove the lazy import hook. Existing Panel monkeypatches are left intact."""
    _uninstall_panel_import_hook()
