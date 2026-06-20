"""Unit tests for the launcher package.

Covers the subclass cascade (traitlets wiring), the thread-local hook
chain on ``NteractShellDisplayHook``, the buffer-attachment hook, and
the extension loader. Full kernel hand-off is exercised by integration
tests against a running kernel.
"""

from __future__ import annotations

import hashlib
import importlib
import importlib.abc
import sys
import types
from importlib.machinery import ModuleSpec
from types import SimpleNamespace

import pytest

# ─── Subclass cascade ────────────────────────────────────────────────────


def test_subclass_cascade_shape():
    """The traitlets ``Type`` cascade must land our four classes in place."""
    from ipykernel.displayhook import ZMQShellDisplayHook
    from ipykernel.ipkernel import IPythonKernel
    from ipykernel.kernelapp import IPKernelApp
    from ipykernel.zmqshell import ZMQInteractiveShell
    from nteract_kernel_launcher.app import (
        NteractKernel,
        NteractKernelApp,
        NteractShell,
        NteractShellDisplayHook,
    )

    assert issubclass(NteractShellDisplayHook, ZMQShellDisplayHook)
    assert issubclass(NteractShell, ZMQInteractiveShell)
    assert issubclass(NteractKernel, IPythonKernel)
    assert issubclass(NteractKernelApp, IPKernelApp)

    # The traits themselves — these are what make the cascade activate.
    assert NteractShell.displayhook_class.default_value is NteractShellDisplayHook
    assert NteractKernel.shell_class.default_value is NteractShell
    assert NteractKernelApp.kernel_class.default_value is NteractKernel


def test_bootstrap_extension_in_default_extensions():
    """Bootstrap must load via ``default_extensions`` so the extension manager
    owns the lifecycle and failures become warnings instead of tracebacks."""
    from nteract_kernel_launcher.app import NteractKernelApp

    # List trait defaults come out of make_dynamic_default at class scope;
    # the usual .default_value is a Sentinel until an instance is built.
    defaults = NteractKernelApp.class_traits()["default_extensions"].make_dynamic_default()
    assert "nteract_kernel_launcher._bootstrap" in defaults
    # storemagic is IPython's own default — keep it.
    assert "storemagic" in defaults


# ─── Hook chain on NteractShellDisplayHook ───────────────────────────────


def _make_hook(instance):
    """Construct an instance with the guts the hook chain needs, avoiding
    ipykernel's full ``__init__`` (which needs a session + socket)."""
    from nteract_kernel_launcher.app import NteractShellDisplayHook

    # Bypass __init__ — we only exercise the hook-chain surface.
    hook = NteractShellDisplayHook.__new__(NteractShellDisplayHook)
    import threading

    hook._tls = threading.local()
    return hook


def test_register_and_unregister_hook():
    hook = _make_hook(None)

    def h(msg):
        return msg

    hook.register_hook(h)
    assert h in hook._hooks
    assert hook.unregister_hook(h) is True
    assert h not in hook._hooks
    assert hook.unregister_hook(h) is False  # idempotent


def test_hooks_are_thread_local():
    """Two threads each see an independent hook list — no cross-talk."""
    import threading

    hook = _make_hook(None)
    results = {}

    def worker(name, fn):
        hook.register_hook(fn)
        results[name] = list(hook._hooks)

    a = lambda m: m  # noqa: E731
    b = lambda m: m  # noqa: E731
    t1 = threading.Thread(target=worker, args=("t1", a))
    t2 = threading.Thread(target=worker, args=("t2", b))
    t1.start()
    t1.join()
    t2.start()
    t2.join()

    assert results["t1"] == [a]
    assert results["t2"] == [b]
    # Main thread: still empty.
    assert hook._hooks == []


# ─── buffer_hook behavior ────────────────────────────────────────────────


def _fake_ip_with_pubs():
    """A minimal stand-in for InteractiveShell's pubs. The hook only
    touches ``session.send``, ``pub_socket``, and ``topic``."""
    sent = []

    class Session:
        def send(self, socket, msg, ident=None, buffers=None):
            sent.append({"socket": socket, "msg": msg, "ident": ident, "buffers": buffers})

    pub = SimpleNamespace(session=Session(), pub_socket="PUB", topic=b"display_data")
    hook = SimpleNamespace(session=Session(), pub_socket="HOOK", topic=b"execute_result")
    return SimpleNamespace(display_pub=pub, displayhook=hook), sent, pub, hook


def test_buffer_hook_routes_execute_result_via_displayhook(monkeypatch):
    from nteract_kernel_launcher import _buffer_hook
    from nteract_kernel_launcher._refs import BLOB_REF_MIME

    ip, sent, pub, dh = _fake_ip_with_pubs()
    monkeypatch.setattr(_buffer_hook, "_get_ipython", lambda: ip)

    data = b"fake-arrow"
    h = hashlib.sha256(data).hexdigest()
    _buffer_hook.pending_buffers()[h] = data

    msg = {
        "header": {"msg_type": "execute_result"},
        "content": {"data": {BLOB_REF_MIME: {"hash": h, "size": len(data)}}},
    }
    result = _buffer_hook.buffer_hook(msg)
    assert result is None  # we sent it ourselves
    assert len(sent) == 1
    assert sent[0]["socket"] == "HOOK"  # displayhook's pub_socket, not display_pub's
    assert sent[0]["buffers"] == [data]


def test_buffer_hook_routes_display_data_via_display_pub(monkeypatch):
    from nteract_kernel_launcher import _buffer_hook
    from nteract_kernel_launcher._refs import BLOB_REF_MIME

    ip, sent, pub, dh = _fake_ip_with_pubs()
    monkeypatch.setattr(_buffer_hook, "_get_ipython", lambda: ip)

    data = b"display-arrow"
    h = hashlib.sha256(data).hexdigest()
    _buffer_hook.pending_buffers()[h] = data

    msg = {
        "header": {"msg_type": "display_data"},
        "content": {"data": {BLOB_REF_MIME: {"hash": h, "size": len(data)}}},
    }
    result = _buffer_hook.buffer_hook(msg)
    assert result is None
    assert sent[0]["socket"] == "PUB"
    assert sent[0]["buffers"] == [data]


def test_buffer_hook_routes_update_display_data_via_display_pub(monkeypatch):
    from nteract_kernel_launcher import _buffer_hook
    from nteract_kernel_launcher._refs import BLOB_REF_MIME

    ip, sent, pub, dh = _fake_ip_with_pubs()
    monkeypatch.setattr(_buffer_hook, "_get_ipython", lambda: ip)

    data = b"updated-arrow"
    h = hashlib.sha256(data).hexdigest()
    _buffer_hook.pending_buffers()[h] = data

    msg = {
        "header": {"msg_type": "update_display_data"},
        "content": {
            "data": {BLOB_REF_MIME: {"hash": h, "size": len(data)}},
            "transient": {"display_id": "table-1"},
        },
    }
    result = _buffer_hook.buffer_hook(msg)
    assert result is None
    assert sent[0]["socket"] == "PUB"
    assert sent[0]["buffers"] == [data]
    assert sent[0]["msg"]["content"]["transient"] == {"display_id": "table-1"}
    assert h not in _buffer_hook.pending_buffers()


def test_buffer_hook_attaches_multiple_ref_buffers(monkeypatch):
    from nteract_kernel_launcher import _buffer_hook
    from nteract_kernel_launcher._refs import BLOB_REF_MIME

    ip, sent, pub, dh = _fake_ip_with_pubs()
    monkeypatch.setattr(_buffer_hook, "_get_ipython", lambda: ip)

    chunks = [b"chunk-one", b"chunk-two"]
    refs = []
    for chunk in chunks:
        h = hashlib.sha256(chunk).hexdigest()
        _buffer_hook.pending_buffers()[h] = chunk
        refs.append(
            {
                "hash": h,
                "size": len(chunk),
                "content_type": "application/vnd.apache.arrow.stream",
            }
        )

    msg = {
        "header": {"msg_type": "display_data"},
        "content": {"data": {BLOB_REF_MIME: {"refs": refs}}},
    }
    result = _buffer_hook.buffer_hook(msg)

    assert result is None
    assert sent[0]["socket"] == "PUB"
    assert sent[0]["buffers"] == chunks
    assert refs[0]["buffer_index"] == 0
    assert refs[1]["buffer_index"] == 1


def test_buffer_hook_passthrough_when_no_pending_bytes(monkeypatch):
    from nteract_kernel_launcher import _buffer_hook
    from nteract_kernel_launcher._refs import BLOB_REF_MIME

    ip, sent, pub, dh = _fake_ip_with_pubs()
    monkeypatch.setattr(_buffer_hook, "_get_ipython", lambda: ip)

    msg = {
        "header": {"msg_type": "display_data"},
        "content": {"data": {BLOB_REF_MIME: {"hash": "deadbeef", "size": 0}}},
    }
    assert _buffer_hook.buffer_hook(msg) is msg  # unchanged
    assert sent == []  # default send path will run


def test_buffer_hook_passthrough_for_other_msg_types():
    from nteract_kernel_launcher import _buffer_hook

    msg = {"header": {"msg_type": "stream"}, "content": {"text": "hi"}}
    assert _buffer_hook.buffer_hook(msg) is msg


def test_buffer_hook_passthrough_when_no_ref_mime():
    from nteract_kernel_launcher import _buffer_hook

    msg = {
        "header": {"msg_type": "display_data"},
        "content": {"data": {"text/plain": "hi"}},
    }
    assert _buffer_hook.buffer_hook(msg) is msg


# ─── install idempotency ─────────────────────────────────────────────────


def test_install_registers_on_both_seats_once():
    from nteract_kernel_launcher import _buffer_hook

    class FakePub:
        def __init__(self):
            self._hooks = []

        def register_hook(self, hook):
            self._hooks.append(hook)

    ip = SimpleNamespace(display_pub=FakePub(), displayhook=FakePub())
    _buffer_hook.install(ip)
    assert len(ip.display_pub._hooks) == 1
    assert len(ip.displayhook._hooks) == 1

    # Idempotent — second call must not stack duplicates.
    _buffer_hook.install(ip)
    assert len(ip.display_pub._hooks) == 1
    assert len(ip.displayhook._hooks) == 1


# ─── LLM formatter contract ──────────────────────────────────────────────


def test_llm_formatter_uses_repr_llm_method():
    from IPython.core.formatters import DisplayFormatter
    from nteract_kernel_launcher import _bootstrap

    display_formatter = DisplayFormatter()
    ip = SimpleNamespace(display_formatter=display_formatter)

    class Example:
        def _repr_llm_(self):
            return "what up"

    formatter = _bootstrap._install_llm_formatter(ip)

    assert formatter is display_formatter.formatters["text/llm+plain"]
    data, metadata = display_formatter.format(Example())
    assert data["text/llm+plain"] == "what up"
    assert metadata == {}


def test_llm_formatter_preserves_existing_registration():
    from IPython.core.formatters import BaseFormatter
    from nteract_kernel_launcher import _bootstrap

    existing = BaseFormatter()
    display_formatter = SimpleNamespace(formatters={"text/llm+plain": existing})
    ip = SimpleNamespace(display_formatter=display_formatter)

    assert _bootstrap._install_llm_formatter(ip) is existing
    assert display_formatter.formatters["text/llm+plain"] is existing


def test_llm_formatter_supports_for_type_registration():
    from IPython.core.formatters import DisplayFormatter
    from nteract_kernel_launcher import _bootstrap

    display_formatter = DisplayFormatter()
    ip = SimpleNamespace(display_formatter=display_formatter)
    formatter = _bootstrap._install_llm_formatter(ip)

    class Example:
        pass

    formatter.for_type(Example, lambda obj: "registered")

    data, _metadata = display_formatter.format(Example())
    assert data["text/llm+plain"] == "registered"


# ─── load_ipython_extension contract ─────────────────────────────────────


def _isolate_renderer_import_hook(monkeypatch, _bootstrap):
    monkeypatch.setattr(
        sys,
        "meta_path",
        [
            finder
            for finder in sys.meta_path
            if not getattr(finder, "_nteract_renderer_import_hook", False)
        ],
    )
    monkeypatch.setattr(_bootstrap, "_renderer_import_hook", None)
    for name in list(sys.modules):
        if (
            name == "altair"
            or name.startswith("altair.")
            or name == "plotly"
            or name.startswith("plotly.")
            or name == "panel"
            or name.startswith("panel.")
        ):
            monkeypatch.delitem(sys.modules, name, raising=False)


def test_load_extension_invokes_the_install_steps(monkeypatch):
    from nteract_kernel_launcher import _bootstrap

    calls = []

    monkeypatch.setattr(_bootstrap, "_install_llm_formatter", lambda ip: calls.append("llm"))
    monkeypatch.setattr(
        _bootstrap, "_install_dataframe_formatters", lambda ip: calls.append("formatters")
    )
    monkeypatch.setattr(_bootstrap, "_install_buffer_hooks", lambda ip: calls.append("hooks"))
    monkeypatch.setattr(_bootstrap._output_redaction, "install", lambda ip: calls.append("redact"))
    monkeypatch.setattr(
        _bootstrap, "_enable_third_party_renderers", lambda: calls.append("renderers")
    )
    monkeypatch.setattr(_bootstrap._panel, "install", lambda: calls.append("panel"))
    monkeypatch.setattr(_bootstrap._traceback, "install", lambda ip: calls.append("traceback"))

    _bootstrap.load_ipython_extension(SimpleNamespace())
    assert calls == ["llm", "formatters", "hooks", "redact", "renderers", "panel", "traceback"]


def test_load_extension_swallows_per_step_failures(monkeypatch):
    """A broken step must not abort the others — we log-warn and move on."""
    from nteract_kernel_launcher import _bootstrap

    called = []

    def boom(*_args, **_kwargs):
        raise RuntimeError("nope")

    monkeypatch.setattr(_bootstrap, "_install_llm_formatter", boom)
    monkeypatch.setattr(_bootstrap, "_install_dataframe_formatters", boom)
    monkeypatch.setattr(_bootstrap, "_install_buffer_hooks", lambda ip: called.append("hooks"))
    monkeypatch.setattr(_bootstrap._output_redaction, "install", lambda ip: called.append("redact"))
    monkeypatch.setattr(_bootstrap, "_enable_third_party_renderers", lambda: called.append("r"))
    monkeypatch.setattr(_bootstrap._panel, "install", lambda: called.append("panel"))
    monkeypatch.setattr(_bootstrap._traceback, "install", lambda ip: called.append("traceback"))

    # Must not raise.
    _bootstrap.load_ipython_extension(SimpleNamespace())
    assert called == ["hooks", "redact", "r", "panel", "traceback"]


def _isolate_panel_import_hook(monkeypatch, _panel):
    monkeypatch.setattr(
        sys,
        "meta_path",
        [
            finder
            for finder in sys.meta_path
            if not getattr(finder, "_nteract_panel_import_hook", False)
        ],
    )
    monkeypatch.setattr(_panel, "_panel_import_hook", None)
    for name in list(sys.modules):
        if name == "panel" or name.startswith("panel."):
            monkeypatch.delitem(sys.modules, name, raising=False)


def test_panel_runtime_hook_does_not_import_panel(monkeypatch):
    from nteract_kernel_launcher import _panel

    _isolate_panel_import_hook(monkeypatch, _panel)
    _panel.install()

    assert "panel" not in sys.modules
    assert any(getattr(finder, "_nteract_panel_import_hook", False) for finder in sys.meta_path)


def test_panel_runtime_hook_patches_loaded_panel_when_enabled(monkeypatch):
    from nteract_kernel_launcher import _panel

    _isolate_panel_import_hook(monkeypatch, _panel)
    monkeypatch.setenv(_panel.PANEL_RUNTIME_STATE_ENV, "1")

    class OriginalManager:
        pass

    panel = types.ModuleType("panel")
    notebook = types.ModuleType("panel.io.notebook")
    notebook.JupyterCommManagerBinary = OriginalManager
    notebook._JupyterCommManager = OriginalManager
    viewable = types.ModuleType("panel.viewable")
    viewable.JupyterCommManager = OriginalManager

    class MimeRenderMixin:
        def __init__(self):
            self._comms = {}

        def _render_mimebundle(self, model, doc, comm, location=None):
            self._comms[model.ref["id"]] = (comm, SimpleNamespace(id="client-comm"))
            return (
                {"text/html": "<div id='panel-root'></div>"},
                {"application/vnd.holoviews_exec.v0+json": {"id": model.ref["id"]}},
            )

    viewable.MimeRenderMixin = MimeRenderMixin
    state_mod = types.ModuleType("panel.io.state")
    state_mod.state = SimpleNamespace(_comm_manager=OriginalManager)

    monkeypatch.setitem(sys.modules, "panel", panel)
    monkeypatch.setitem(sys.modules, "panel.io.notebook", notebook)
    monkeypatch.setitem(sys.modules, "panel.viewable", viewable)
    monkeypatch.setitem(sys.modules, "panel.io.state", state_mod)

    _panel.install()

    assert notebook.JupyterCommManagerBinary is _panel.NteractPanelCommManager
    assert notebook._JupyterCommManager is _panel.NteractPanelCommManager
    assert viewable.JupyterCommManager is _panel.NteractPanelCommManager
    assert state_mod.state._comm_manager is _panel.NteractPanelCommManager
    assert _panel.NteractPanelCommManager._nteract_original_manager is OriginalManager

    mixin = viewable.MimeRenderMixin()
    data, metadata = mixin._render_mimebundle(
        SimpleNamespace(ref={"id": "plot-1"}),
        SimpleNamespace(id="doc-1"),
        SimpleNamespace(id="server-comm"),
    )
    assert data[_panel.NTERACT_PANEL_RUNTIME_MIME] == {
        "version": 1,
        "protocol": "nteract.panel.runtime.v1",
        "plot_id": "plot-1",
        "server_comm_id": "server-comm",
        "client_comm_id": "client-comm",
        "document_id": "doc-1",
    }
    assert metadata[_panel.NTERACT_PANEL_RUNTIME_MIME] == {
        "id": "plot-1",
        "server_comm_id": "server-comm",
        "client_comm_id": "client-comm",
    }


def test_panel_runtime_hook_ignores_loaded_panel_by_default(monkeypatch):
    from nteract_kernel_launcher import _panel

    _isolate_panel_import_hook(monkeypatch, _panel)
    monkeypatch.delenv(_panel.PANEL_RUNTIME_STATE_ENV, raising=False)

    class OriginalManager:
        pass

    viewable = types.ModuleType("panel.viewable")
    viewable.JupyterCommManager = OriginalManager
    monkeypatch.setitem(sys.modules, "panel.viewable", viewable)

    _panel.install()

    assert viewable.JupyterCommManager is OriginalManager


def test_panel_comm_manager_emits_typed_events(monkeypatch):
    from nteract_kernel_launcher import _panel

    events = []
    monkeypatch.setattr(_panel.NteractPanelCommManager, "_comms", {})
    _panel.set_panel_runtime_event_sink(events.append)
    try:
        opened = []
        comm = _panel.NteractPanelCommManager.get_server_comm(
            id="server-comm",
            on_open=lambda msg: opened.append(msg),
        )
        comm.init()
        comm.send({"content": []}, metadata={"msg_type": "PATCH-DOC"}, buffers=[b"abc"])
        comm.close()
    finally:
        _panel.set_panel_runtime_event_sink(None)

    assert opened == [{}]
    assert [event["type"] for event in events] == [
        "panel_channel_open",
        "panel_comm_init",
        "panel_server_patch",
        "panel_channel_close",
    ]
    assert events[2]["protocol"] == "nteract.panel.runtime.v1"
    assert events[2]["comm_id"] == "server-comm"
    assert events[2]["buffers"] == [b"abc"]


def test_panel_comm_manager_js_attaches_to_runtime():
    from nteract_kernel_launcher import _panel

    manager_js = _panel.NteractPanelCommManager.js_manager

    assert "window.__nteractPanelRuntime" in manager_js
    assert "attachCommManager" in manager_js
    assert "receiveServerPatch" in manager_js
    assert "receiveAck" in manager_js
    assert "setDisconnected" in manager_js


def test_enable_third_party_renderers_configures_loaded_modules(monkeypatch):
    from nteract_kernel_launcher import _bootstrap

    _isolate_renderer_import_hook(monkeypatch, _bootstrap)

    enabled = []

    class FakeAltairRenderers:
        def enable(self, name):
            enabled.append(name)

    class FakePlotlyRenderers:
        def __init__(self):
            self.default = "plotly_mimetype"

    fake_alt = types.ModuleType("altair")
    fake_alt.renderers = FakeAltairRenderers()
    fake_pio = types.ModuleType("plotly.io")
    fake_pio.renderers = FakePlotlyRenderers()
    monkeypatch.setitem(sys.modules, "altair", fake_alt)
    monkeypatch.setitem(sys.modules, "plotly.io", fake_pio)

    _bootstrap._enable_third_party_renderers()

    assert enabled == ["nteract"]
    assert fake_pio.renderers.default == "nteract"


def test_enable_third_party_renderers_lazily_configures_modules(monkeypatch):
    from nteract_kernel_launcher import _bootstrap

    _isolate_renderer_import_hook(monkeypatch, _bootstrap)
    enabled = []

    class FakeAltairRenderers:
        def enable(self, name):
            enabled.append(name)

    class FakePlotlyRenderers:
        def __init__(self):
            self.default = "plotly_mimetype"

    class FakeLoader(importlib.abc.Loader):
        def __init__(self, configure):
            self.configure = configure

        def create_module(self, spec):
            return None

        def exec_module(self, module):
            self.configure(module)

    class FakeFinder:
        def __init__(self):
            self.requests = []

        def find_spec(self, fullname, path=None, target=None):
            self.requests.append(fullname)
            if fullname == "altair":
                return ModuleSpec(
                    fullname,
                    FakeLoader(lambda module: setattr(module, "renderers", FakeAltairRenderers())),
                )
            if fullname == "plotly":
                spec = ModuleSpec(fullname, FakeLoader(lambda _module: None), is_package=True)
                spec.submodule_search_locations = []
                return spec
            if fullname == "plotly.io":
                return ModuleSpec(
                    fullname,
                    FakeLoader(lambda module: setattr(module, "renderers", FakePlotlyRenderers())),
                )
            return None

    fake_finder = FakeFinder()
    sys.meta_path.insert(0, fake_finder)

    _bootstrap._enable_third_party_renderers()

    assert fake_finder.requests == []

    importlib.import_module("altair")
    pio = importlib.import_module("plotly.io")

    assert enabled == ["nteract"]
    assert pio.renderers.default == "nteract"


@pytest.mark.parametrize(
    "entrypoint",
    ["plotly.express", "plotly.graph_objects", "plotly.graph_objs"],
)
def test_plotly_entrypoint_imports_lazily_configure_plotly_io(monkeypatch, entrypoint):
    from nteract_kernel_launcher import _bootstrap

    _isolate_renderer_import_hook(monkeypatch, _bootstrap)

    class FakePlotlyRenderers:
        def __init__(self):
            self.default = "plotly_mimetype"

    class FakeLoader(importlib.abc.Loader):
        def __init__(self, configure=lambda _module: None):
            self.configure = configure

        def create_module(self, spec):
            return None

        def exec_module(self, module):
            self.configure(module)

    class FakeFinder:
        def find_spec(self, fullname, path=None, target=None):
            if fullname == "plotly":
                spec = ModuleSpec(fullname, FakeLoader(), is_package=True)
                spec.submodule_search_locations = []
                return spec
            if fullname == "plotly.io":
                return ModuleSpec(
                    fullname,
                    FakeLoader(lambda module: setattr(module, "renderers", FakePlotlyRenderers())),
                )
            if fullname == entrypoint:
                return ModuleSpec(fullname, FakeLoader())
            return None

    sys.meta_path.insert(0, FakeFinder())
    _bootstrap._enable_third_party_renderers()

    assert "plotly.io" not in sys.modules

    importlib.import_module(entrypoint)

    pio = sys.modules["plotly.io"]
    assert pio.renderers.default == "nteract"


def test_real_plotly_express_import_lazily_configures_plotly_io(monkeypatch):
    from nteract_kernel_launcher import _bootstrap

    _isolate_renderer_import_hook(monkeypatch, _bootstrap)
    pytest.importorskip("plotly.express")
    _isolate_renderer_import_hook(monkeypatch, _bootstrap)
    _bootstrap._enable_third_party_renderers()

    import plotly.express as px
    import plotly.io as pio

    assert px.__name__ == "plotly.express"
    assert pio.renderers.default == "nteract"


def test_install_registers_iterable_dataset_formatter():
    """Streaming HF datasets must reach the summary-only formatter path."""
    from IPython.core.formatters import DisplayFormatter
    from nteract_kernel_launcher import _bootstrap
    from nteract_kernel_launcher._format import ARROW_STREAM_MANIFEST_MIME
    from nteract_kernel_launcher._refs import BLOB_REF_MIME

    display_formatter = DisplayFormatter()
    ip = SimpleNamespace(display_formatter=display_formatter)

    _bootstrap._install_dataframe_formatters(ip)

    assert isinstance(
        display_formatter.formatters[BLOB_REF_MIME],
        _bootstrap.ArrowBlobRefFormatter,
    )
    assert isinstance(
        display_formatter.formatters[ARROW_STREAM_MANIFEST_MIME],
        _bootstrap.ArrowStreamManifestFormatter,
    )
    deferred = display_formatter.mimebundle_formatter.deferred_printers
    assert ("datasets.iterable_dataset", "IterableDataset") in deferred


def test_generic_arrow_formatters_emit_pycapsule_bundle_once():
    """Bare Arrow-capable objects should use the generic per-MIME formatters.

    This is the launcher replacement for the old dx per-type formatter path:
    the object only exposes ``__arrow_c_stream__`` and should still produce the
    blob ref, Arrow manifest, and LLM summary through one shared serialization.
    """
    import io

    pa = pytest.importorskip("pyarrow")
    from IPython.core.formatters import DisplayFormatter
    from nteract_kernel_launcher import _bootstrap, _buffer_hook
    from nteract_kernel_launcher._format import ARROW_STREAM_MANIFEST_MIME
    from nteract_kernel_launcher._refs import BLOB_REF_MIME

    class StreamOnlyTable:
        def __init__(self):
            self._table = pa.table({"a": [1, 2, 3]})
            self.exports = 0

        def __arrow_c_stream__(self, requested_schema=None):
            if self.exports:
                raise RuntimeError("stream already consumed")
            self.exports += 1
            return self._table.__arrow_c_stream__(requested_schema)

        def __len__(self):
            return self._table.num_rows

    display_formatter = DisplayFormatter()
    ip = SimpleNamespace(display_formatter=display_formatter)
    _bootstrap._install_llm_formatter(ip)
    _bootstrap._install_dataframe_formatters(ip)
    _buffer_hook.pending_buffers().clear()

    source = StreamOnlyTable()
    data, _metadata = display_formatter.format(source)

    assert source.exports == 1
    assert BLOB_REF_MIME in data
    assert ARROW_STREAM_MANIFEST_MIME in data
    assert "text/llm+plain" in data

    h = data[BLOB_REF_MIME]["hash"]
    assert data[ARROW_STREAM_MANIFEST_MIME]["chunks"][0]["hash"] == h
    assert h in _buffer_hook.pending_buffers()

    table = pa.ipc.open_stream(io.BytesIO(_buffer_hook.pending_buffers()[h])).read_all()
    assert table.column_names == ["a"]
    assert table.num_rows == 3


# ─── emit path — only runs if pandas + pyarrow are importable ────────────


def test_arrow_stream_formatter_stashes_bytes_and_returns_bundle():
    pd = pytest.importorskip("pandas")
    pytest.importorskip("pyarrow")

    from nteract_kernel_launcher import _bootstrap, _buffer_hook
    from nteract_kernel_launcher._format import ARROW_STREAM_MANIFEST_MIME
    from nteract_kernel_launcher._refs import BLOB_REF_MIME

    _buffer_hook.pending_buffers().clear()
    df = pd.DataFrame({"a": [1, 2, 3], "b": ["x", "y", "z"]})
    bundle = _bootstrap._arrow_stream_mimebundle(df)
    assert bundle is not None
    assert BLOB_REF_MIME in bundle
    assert "text/llm+plain" in bundle
    # Bytes are stashed under the ref's hash.
    h = bundle[BLOB_REF_MIME]["hash"]
    assert h in _buffer_hook.pending_buffers()
    assert isinstance(_buffer_hook.pending_buffers()[h], bytes)
    assert bundle[ARROW_STREAM_MANIFEST_MIME]["chunks"][0]["hash"] == h
    assert bundle[ARROW_STREAM_MANIFEST_MIME]["summary"]["included_rows"] == 3
    assert "llm" not in bundle[ARROW_STREAM_MANIFEST_MIME]
    assert bundle[ARROW_STREAM_MANIFEST_MIME]["schema"]["columns"] == [
        {"name": "a", "type": "int64", "nullable": True},
        {"name": "b", "type": "large_string", "nullable": True},
    ]


# ─── Arrow stream path — preserves schema KV metadata ────────────────────


def _pa_table_with_hf_metadata():
    """Build a small ``pa.Table`` carrying a ``huggingface`` schema KV entry.

    Mirrors the shape of HF Arrow-backed tables: features under ``huggingface``,
    one column declared ``Image`` with ``Struct{bytes, path}``.
    """
    pa = pytest.importorskip("pyarrow")

    image_struct = pa.struct([pa.field("bytes", pa.binary()), pa.field("path", pa.string())])
    schema = pa.schema(
        [pa.field("id", pa.string()), pa.field("image", image_struct)],
        metadata={
            "huggingface": (
                '{"info": {"features": {'
                '"id": {"dtype": "string", "_type": "Value"}, '
                '"image": {"_type": "Image"}}}}'
            )
        },
    )
    return pa.Table.from_pylist(
        [
            {"id": "row-0", "image": {"bytes": b"\x89PNG\r\n", "path": "0.png"}},
            {"id": "row-1", "image": {"bytes": b"\x89PNG\r\n", "path": "1.png"}},
        ],
        schema=schema,
    )


def test_emit_pyarrow_table_preserves_huggingface_kv_metadata():
    """The pa.Table path is the load-bearing one for Sift's rich-type
    detection — the dataframe path drops schema KV metadata, this one
    keeps it. Verify by reading the Arrow IPC schema back out."""
    import io

    pa = pytest.importorskip("pyarrow")

    from nteract_kernel_launcher import _bootstrap, _buffer_hook
    from nteract_kernel_launcher._format import ARROW_STREAM_MANIFEST_MIME
    from nteract_kernel_launcher._refs import BLOB_REF_MIME

    _buffer_hook.pending_buffers().clear()
    table = _pa_table_with_hf_metadata()

    bundle = _bootstrap._arrow_stream_mimebundle(table)

    assert bundle is not None
    assert BLOB_REF_MIME in bundle
    assert "text/llm+plain" in bundle

    h = bundle[BLOB_REF_MIME]["hash"]
    assert bundle[BLOB_REF_MIME]["content_type"] == "application/vnd.apache.arrow.stream"
    assert bundle[ARROW_STREAM_MANIFEST_MIME]["schema"]["metadata"]["huggingface"] is True
    data = _buffer_hook.pending_buffers()[h]
    md = pa.ipc.open_stream(io.BytesIO(data)).read_all().schema.metadata or {}
    assert b"huggingface" in md, f"missing huggingface KV; got keys: {[k.decode() for k in md]}"
    assert b'"_type": "Image"' in md[b"huggingface"]


def test_emit_pyarrow_table_chunks_when_full_stream_exceeds_limit(monkeypatch):
    pytest.importorskip("pyarrow")

    from nteract_kernel_launcher import _bootstrap, _buffer_hook
    from nteract_kernel_launcher._format import ARROW_STREAM_MANIFEST_MIME
    from nteract_kernel_launcher._refs import BLOB_REF_MIME

    _buffer_hook.pending_buffers().clear()
    monkeypatch.setattr(_bootstrap, "_MAX_PAYLOAD_BYTES", 1)
    table = _pa_table_with_hf_metadata()

    bundle = _bootstrap._arrow_stream_mimebundle(table)

    assert bundle is not None
    manifest = bundle[ARROW_STREAM_MANIFEST_MIME]
    assert manifest["complete"] is True
    assert manifest["summary"] == {
        "total_rows": table.num_rows,
        "included_rows": table.num_rows,
        "sampled": False,
        "sample_strategy": "none",
    }
    assert "llm" not in manifest
    assert len(manifest["chunks"]) > 1
    refs = bundle[BLOB_REF_MIME]["refs"]
    assert len(refs) == len(manifest["chunks"])
    assert [ref["hash"] for ref in refs] == [chunk["hash"] for chunk in manifest["chunks"]]
    for ref in refs:
        assert ref["hash"] in _buffer_hook.pending_buffers()


def test_emit_pyarrow_record_batch_promotes_to_table():
    """RecordBatch should produce the same kind of bundle as Table."""
    pytest.importorskip("pyarrow")

    from nteract_kernel_launcher import _bootstrap, _buffer_hook
    from nteract_kernel_launcher._refs import BLOB_REF_MIME

    _buffer_hook.pending_buffers().clear()
    table = _pa_table_with_hf_metadata()
    batch = table.to_batches()[0]

    bundle = _bootstrap._arrow_stream_mimebundle(batch)

    assert bundle is not None
    assert BLOB_REF_MIME in bundle


def test_emit_table_bytes_carries_sampled_row_hints():
    from nteract_kernel_launcher import _bootstrap, _buffer_hook
    from nteract_kernel_launcher._refs import BLOB_REF_MIME

    _buffer_hook.pending_buffers().clear()

    bundle = _bootstrap._emit_table_bytes(
        b"sampled-table-bytes",
        content_type="application/vnd.apache.arrow.stream",
        total_rows=10,
        included_rows=3,
        summary_fn=lambda included, sampled: f"{included}:{sampled}",
    )

    ref = bundle[BLOB_REF_MIME]
    assert ref["content_type"] == "application/vnd.apache.arrow.stream"
    assert ref["summary"] == {
        "total_rows": 10,
        "included_rows": 3,
        "sampled": True,
        "sample_strategy": "head",
    }
    assert bundle["text/llm+plain"] == "3:True"


def test_dataset_mimebundle_emits_arrow_ipc_with_hf_features():
    """``datasets.Dataset`` carries HF features both on ``ds.features`` and
    on the underlying ``ds.data.table`` schema KV. The bundle must include
    Arrow IPC bytes whose schema carries the ``huggingface`` key, not just
    the legacy text-summary path."""
    import io

    pa = pytest.importorskip("pyarrow")
    pytest.importorskip("datasets")
    from datasets import Dataset
    from nteract_kernel_launcher import _bootstrap, _buffer_hook
    from nteract_kernel_launcher._refs import BLOB_REF_MIME

    _buffer_hook.pending_buffers().clear()

    table = _pa_table_with_hf_metadata()
    ds = Dataset(arrow_table=table)

    bundle = _bootstrap._dataset_mimebundle(ds)

    assert bundle is not None
    assert BLOB_REF_MIME in bundle
    assert "text/llm+plain" in bundle
    # Summary should still go through summarize_dataset (HF-feature aware),
    # not the generic pandas-style summary.
    assert "HuggingFace Dataset" in bundle["text/llm+plain"]

    h = bundle[BLOB_REF_MIME]["hash"]
    assert bundle[BLOB_REF_MIME]["content_type"] == "application/vnd.apache.arrow.stream"
    data = _buffer_hook.pending_buffers()[h]
    md = pa.ipc.open_stream(io.BytesIO(data)).read_all().schema.metadata or {}
    assert b"huggingface" in md
    assert b'"_type": "Image"' in md[b"huggingface"]


def test_dataset_mimebundle_falls_back_to_summary_when_no_table():
    """Streaming / iterable datasets have no ``.data.table``; the formatter
    must keep the legacy text-only behavior so it stays best-effort."""
    pytest.importorskip("datasets")

    from nteract_kernel_launcher import _bootstrap

    class FakeFeatures(dict):
        pass

    class FakeStreamingDataset:
        features = FakeFeatures(id="string")
        info = None

        def __getitem__(self, _idx):
            raise RuntimeError("streaming")

        # No `data` attribute — mirrors IterableDataset.

    bundle = _bootstrap._dataset_mimebundle(FakeStreamingDataset())
    assert bundle is not None
    assert "text/llm+plain" in bundle
