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


def test_buffer_hook_attaches_duplicate_content_hashes(monkeypatch):
    from nteract_kernel_launcher import _buffer_hook
    from nteract_kernel_launcher._refs import BLOB_REF_MIME

    ip, sent, _pub, _dh = _fake_ip_with_pubs()
    monkeypatch.setattr(_buffer_hook, "_get_ipython", lambda: ip)

    data = b"same-content"
    h = hashlib.sha256(data).hexdigest()
    _buffer_hook.pending_buffers()[h] = data
    refs = [
        {"hash": h, "size": len(data), "content_type": "application/octet-stream"},
        {"hash": h, "size": len(data), "content_type": "application/octet-stream"},
    ]
    msg = {
        "header": {"msg_type": "display_data"},
        "content": {"data": {BLOB_REF_MIME: {"refs": refs}}},
    }

    assert _buffer_hook.buffer_hook(msg) is None
    assert sent[0]["buffers"] == [data, data]
    assert [ref["buffer_index"] for ref in refs] == [0, 1]
    assert h not in _buffer_hook.pending_buffers()


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


def test_worker_thread_display_attaches_arrow_buffers():
    """A worker-thread display must publish every declared Arrow blob."""
    import time

    from jupyter_client import KernelManager
    from jupyter_client.kernelspec import KernelSpec
    from nteract_kernel_launcher._refs import BLOB_REF_MIME

    kernel_manager = KernelManager(kernel_name="nteract-launcher-test")
    kernel_manager._kernel_spec = KernelSpec(  # noqa: SLF001
        argv=[
            sys.executable,
            "-m",
            "nteract_kernel_launcher",
            "-f",
            "{connection_file}",
        ],
        display_name="nteract launcher test",
        language="python",
    )
    kernel_manager.start_kernel()
    client = kernel_manager.client()
    client.start_channels()
    try:
        client.wait_for_ready(timeout=30)
        message_id = client.execute(
            """
from concurrent.futures import ThreadPoolExecutor
import polars as pl
from IPython.display import display

df = pl.DataFrame({"a": range(100_000), "b": [f"x{i}" for i in range(100_000)]})
ThreadPoolExecutor(1).submit(display, df).result()
"""
        )

        display_messages = []
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            message = client.get_iopub_msg(timeout=max(0.1, deadline - time.monotonic()))
            if message.get("parent_header", {}).get("msg_id") != message_id:
                continue
            message_type = message.get("header", {}).get("msg_type")
            if message_type == "display_data":
                display_messages.append(message)
            if (
                message_type == "status"
                and message.get("content", {}).get("execution_state") == "idle"
            ):
                break

        assert len(display_messages) == 1
        display_message = display_messages[0]
        ref_bundle = display_message["content"]["data"][BLOB_REF_MIME]
        refs = ref_bundle.get("refs", [ref_bundle])
        buffers = display_message.get("buffers", [])

        assert refs
        assert len(buffers) == len(refs)
        for ref in refs:
            buffer = bytes(buffers[ref["buffer_index"]])
            assert len(buffer) == ref["size"]
            assert hashlib.sha256(buffer).hexdigest() == ref["hash"]
    finally:
        client.stop_channels()
        kernel_manager.shutdown_kernel(now=True)


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
    monkeypatch.setattr(_bootstrap._traceback, "install", lambda ip: calls.append("traceback"))

    _bootstrap.load_ipython_extension(SimpleNamespace())
    assert calls == ["llm", "formatters", "hooks", "redact", "renderers", "traceback"]


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
    monkeypatch.setattr(_bootstrap._traceback, "install", lambda ip: called.append("traceback"))

    # Must not raise.
    _bootstrap.load_ipython_extension(SimpleNamespace())
    assert called == ["hooks", "redact", "r", "traceback"]


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

    from nteract_kernel_launcher import _bootstrap, _buffer_hook, _format
    from nteract_kernel_launcher._format import ARROW_STREAM_MANIFEST_MIME
    from nteract_kernel_launcher._refs import BLOB_REF_MIME

    _buffer_hook.pending_buffers().clear()
    monkeypatch.setattr(_format, "DEFAULT_ARROW_CHUNK_BYTES", 1)
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


def _rendered_arrow_table(bundle):
    import io

    pa = pytest.importorskip("pyarrow")

    from nteract_kernel_launcher import _buffer_hook
    from nteract_kernel_launcher._refs import BLOB_REF_MIME

    ref = bundle[BLOB_REF_MIME]
    hashes = [item["hash"] for item in ref.get("refs", [ref])]
    tables = [
        pa.ipc.open_stream(io.BytesIO(_buffer_hook.pending_buffers()[hash_])).read_all()
        for hash_ in hashes
    ]
    return pa.concat_tables(tables)


def test_large_arrow_table_emits_bounded_head_with_honest_manifest(monkeypatch):
    pa = pytest.importorskip("pyarrow")

    from nteract_kernel_launcher import _bootstrap, _buffer_hook
    from nteract_kernel_launcher._format import ARROW_STREAM_MANIFEST_MIME

    _buffer_hook.pending_buffers().clear()
    monkeypatch.setattr(_bootstrap, "_ARROW_REPR_MIN_ROWS", 2)
    monkeypatch.setattr(_bootstrap, "_ARROW_REPR_BYTE_BUDGET", 20)
    monkeypatch.setattr(_bootstrap, "_ARROW_REPR_MAX_ROWS", 5)
    monkeypatch.setattr(_bootstrap, "_MAX_PAYLOAD_BYTES", 1_000_000)
    table = pa.table({"value": list(range(20))})

    bundle = _bootstrap._arrow_stream_mimebundle(table)

    assert bundle is not None
    manifest = bundle[ARROW_STREAM_MANIFEST_MIME]
    assert manifest["complete"] is True
    assert manifest["summary"] == {
        "total_rows": 20,
        "included_rows": 2,
        "sampled": True,
        "sample_strategy": "head",
    }
    assert _rendered_arrow_table(bundle).column("value").to_pylist() == [0, 1]


def test_small_arrow_table_is_unaffected_by_repr_bounds(monkeypatch):
    pa = pytest.importorskip("pyarrow")

    from nteract_kernel_launcher import _bootstrap
    from nteract_kernel_launcher._format import ARROW_STREAM_MANIFEST_MIME

    monkeypatch.setattr(_bootstrap, "_ARROW_REPR_MIN_ROWS", 2)
    monkeypatch.setattr(_bootstrap, "_ARROW_REPR_BYTE_BUDGET", 1_000)
    monkeypatch.setattr(_bootstrap, "_ARROW_REPR_MAX_ROWS", 5)
    table = pa.table({"value": [0, 1, 2]})

    bundle = _bootstrap._arrow_stream_mimebundle(table)

    assert bundle is not None
    manifest = bundle[ARROW_STREAM_MANIFEST_MIME]
    assert manifest["complete"] is True
    assert manifest["summary"] == {
        "total_rows": 3,
        "included_rows": 3,
        "sampled": False,
        "sample_strategy": "none",
    }
    assert _rendered_arrow_table(bundle).num_rows == 3


def test_fat_arrow_rows_clamp_up_to_min_rows(monkeypatch):
    pa = pytest.importorskip("pyarrow")

    from nteract_kernel_launcher import _bootstrap
    from nteract_kernel_launcher._format import ARROW_STREAM_MANIFEST_MIME

    monkeypatch.setattr(_bootstrap, "_ARROW_REPR_MIN_ROWS", 10)
    monkeypatch.setattr(_bootstrap, "_ARROW_REPR_BYTE_BUDGET", 100)
    monkeypatch.setattr(_bootstrap, "_ARROW_REPR_MAX_ROWS", 50)
    monkeypatch.setattr(_bootstrap, "_MAX_PAYLOAD_BYTES", 10_000)
    table = pa.table({"value": ["x" * 50] * 100})

    bundle = _bootstrap._arrow_stream_mimebundle(table)

    assert bundle is not None
    summary = bundle[ARROW_STREAM_MANIFEST_MIME]["summary"]
    assert summary["included_rows"] == 10
    assert summary["sampled"] is True


def test_max_rows_wins_over_contradictory_min_rows(monkeypatch):
    pa = pytest.importorskip("pyarrow")

    from nteract_kernel_launcher import _format

    table = pa.table({"value": list(range(100))})

    bounded = _format._bounded_arrow_table(
        table,
        min_rows=60,
        byte_budget=1_000_000,
        max_rows=50,
        max_payload_bytes=1_000_000,
    )

    assert bounded is not None
    assert bounded.num_rows == 50


def test_unmeasurable_table_degrades_instead_of_raising(monkeypatch):
    """A measurement failure falls back to bounded streaming on every pyarrow."""
    pa = pytest.importorskip("pyarrow")

    from nteract_kernel_launcher import _bootstrap, _format

    def fail_measurement(*args, **kwargs):
        raise RuntimeError("forced measurement failure")

    monkeypatch.setattr(_format, "_head_rows_within_bytes", fail_measurement)
    table = pa.table({"s": ["x"] * 500})

    assert (
        _format._bounded_arrow_table(
            table,
            min_rows=100,
            byte_budget=16 * 1024 * 1024,
            max_rows=50_000,
            max_payload_bytes=90 * 1024 * 1024,
        )
        is None
    )

    bundle = _bootstrap._arrow_stream_mimebundle(table)
    assert bundle is not None
    manifest = bundle[_format.ARROW_STREAM_MANIFEST_MIME]
    assert manifest["complete"] is True
    assert manifest["summary"]["sampled"] is False


def test_bounded_unknown_length_stream_is_final_but_sampled(monkeypatch):
    pa = pytest.importorskip("pyarrow")

    from nteract_kernel_launcher import _bootstrap
    from nteract_kernel_launcher._format import ARROW_STREAM_MANIFEST_MIME

    table = pa.table({"value": list(range(20))})
    monkeypatch.setattr(_bootstrap, "arrow_stream_row_count", lambda source: None)
    monkeypatch.setattr(_bootstrap, "_bounded_arrow_table", lambda source, **limits: None)
    monkeypatch.setattr(_bootstrap, "_ARROW_REPR_MIN_ROWS", 2)
    monkeypatch.setattr(_bootstrap, "_ARROW_REPR_BYTE_BUDGET", 1_000_000)
    monkeypatch.setattr(_bootstrap, "_ARROW_REPR_MAX_ROWS", 5)

    bundle = _bootstrap._arrow_stream_mimebundle(table)

    assert bundle is not None
    manifest = bundle[ARROW_STREAM_MANIFEST_MIME]
    assert manifest["complete"] is True
    assert manifest["summary"] == {
        "total_rows": 5,
        "included_rows": 5,
        "sampled": True,
        "sample_strategy": "head",
    }


def test_skinny_arrow_rows_clamp_down_to_max_rows(monkeypatch):
    pa = pytest.importorskip("pyarrow")

    from nteract_kernel_launcher import _bootstrap
    from nteract_kernel_launcher._format import ARROW_STREAM_MANIFEST_MIME

    monkeypatch.setattr(_bootstrap, "_ARROW_REPR_MIN_ROWS", 2)
    monkeypatch.setattr(_bootstrap, "_ARROW_REPR_BYTE_BUDGET", 1_000_000)
    monkeypatch.setattr(_bootstrap, "_ARROW_REPR_MAX_ROWS", 25)
    table = pa.table({"value": list(range(1_000))})

    bundle = _bootstrap._arrow_stream_mimebundle(table)

    assert bundle is not None
    summary = bundle[ARROW_STREAM_MANIFEST_MIME]["summary"]
    assert summary["included_rows"] == 25
    assert summary["sampled"] is True


def test_pathologically_fat_rows_shrink_below_min_for_hard_ceiling(monkeypatch):
    pa = pytest.importorskip("pyarrow")

    from nteract_kernel_launcher import _bootstrap
    from nteract_kernel_launcher._format import ARROW_STREAM_MANIFEST_MIME

    monkeypatch.setattr(_bootstrap, "_ARROW_REPR_MIN_ROWS", 10)
    monkeypatch.setattr(_bootstrap, "_ARROW_REPR_BYTE_BUDGET", 100)
    monkeypatch.setattr(_bootstrap, "_ARROW_REPR_MAX_ROWS", 50)
    monkeypatch.setattr(_bootstrap, "_MAX_PAYLOAD_BYTES", 700)
    table = pa.table({"value": ["x" * 100] * 100})

    bundle = _bootstrap._arrow_stream_mimebundle(table)

    assert bundle is not None
    manifest = bundle[ARROW_STREAM_MANIFEST_MIME]
    summary = manifest["summary"]
    assert 0 < summary["included_rows"] < 10
    assert sum(chunk["size"] for chunk in manifest["chunks"]) <= 700


def test_hard_ceiling_shrink_is_geometrically_bounded(monkeypatch):
    from nteract_kernel_launcher import _bootstrap

    class SliceableSource:
        def __init__(self, num_rows):
            self.num_rows = num_rows

        def slice(self, offset, row_count):
            assert offset == 0
            return SliceableSource(row_count)

    attempted_rows = []

    def collect(source, *, bound_stream, **limits):
        assert bound_stream is False
        attempted_rows.append(source.num_rows)
        return [SimpleNamespace(size=101, row_count=source.num_rows)], True

    source = SliceableSource(64)
    monkeypatch.setattr(_bootstrap, "_MAX_PAYLOAD_BYTES", 100)
    monkeypatch.setattr(_bootstrap, "has_arrow_stream_protocol", lambda source: True)
    monkeypatch.setattr(_bootstrap, "_bounded_arrow_table", lambda source, **limits: source)
    monkeypatch.setattr(_bootstrap, "_collect_arrow_chunks", collect)

    assert _bootstrap._emit_arrow_stream(source, total_rows=64) is None
    assert attempted_rows == [64, 32, 16, 8, 4, 2, 1, 0]


def test_stream_row_cap_slice_still_honors_hard_byte_ceiling(monkeypatch):
    from nteract_kernel_launcher import _format

    source_chunk = SimpleNamespace(size=1, row_count=10)
    oversized_slice = SimpleNamespace(size=11, row_count=5)
    monkeypatch.setattr(_format, "iter_arrow_stream_chunks", lambda *args, **kwargs: [source_chunk])
    monkeypatch.setattr(_format, "_slice_arrow_chunk", lambda *args, **kwargs: [oversized_slice])

    chunks, complete = _format._collect_arrow_chunks(
        object(),
        bound_stream=True,
        min_rows=1,
        byte_budget=10,
        max_rows=5,
        max_payload_bytes=10,
    )

    assert complete is False
    assert sum(chunk.size for chunk in chunks) <= 10


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


def test_dataset_mimebundle_applies_logical_indices_mapping():
    """Selected/shuffled datasets must render their logical rows, not every
    row in the physical backing table that ``Dataset.data.table`` exposes."""
    import io

    pa = pytest.importorskip("pyarrow")
    pytest.importorskip("datasets")
    from datasets import Dataset
    from nteract_kernel_launcher import _bootstrap, _buffer_hook
    from nteract_kernel_launcher._format import ARROW_STREAM_MANIFEST_MIME
    from nteract_kernel_launcher._refs import BLOB_REF_MIME

    _buffer_hook.pending_buffers().clear()

    ds = Dataset.from_dict({"id": [0, 1, 2, 3, 4], "value": ["a", "b", "c", "d", "e"]})
    selected = ds.select([4, 2, 0])
    assert selected._indices is not None
    assert selected.data.table.num_rows == 5

    bundle = _bootstrap._dataset_mimebundle(selected)

    assert bundle is not None
    ref = bundle[BLOB_REF_MIME]
    data = _buffer_hook.pending_buffers()[ref["hash"]]
    rendered = pa.ipc.open_stream(io.BytesIO(data)).read_all()
    assert rendered.column("id").to_pylist() == [4, 2, 0]
    assert rendered.num_rows == selected.num_rows
    assert bundle[ARROW_STREAM_MANIFEST_MIME]["summary"] == {
        "total_rows": 3,
        "included_rows": 3,
        "sampled": False,
        "sample_strategy": "none",
    }


def test_dataset_mimebundle_caps_rows_before_logical_arrow_materialization(monkeypatch):
    pa = pytest.importorskip("pyarrow")

    from nteract_kernel_launcher import _bootstrap
    from nteract_kernel_launcher._format import ARROW_STREAM_MANIFEST_MIME

    requested = []

    class FakeDataset:
        num_rows = 1_000_000
        data = SimpleNamespace(table=object())

        def with_format(self, format_name):
            assert format_name == "arrow"
            return self

        def __getitem__(self, key):
            requested.append(key)
            return pa.table({"value": list(range(key.stop))})

    monkeypatch.setattr(_bootstrap, "_ARROW_REPR_MAX_ROWS", 5)
    monkeypatch.setattr(_bootstrap, "summarize_dataset", lambda dataset: "dataset summary")

    bundle = _bootstrap._dataset_mimebundle(FakeDataset())

    assert bundle is not None
    assert requested == [slice(None, 5, None)]
    assert bundle[ARROW_STREAM_MANIFEST_MIME]["complete"] is True
    assert bundle[ARROW_STREAM_MANIFEST_MIME]["summary"] == {
        "total_rows": 1_000_000,
        "included_rows": 5,
        "sampled": True,
        "sample_strategy": "head",
    }


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
