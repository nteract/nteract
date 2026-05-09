"""Unit tests for the launcher package.

Covers the subclass cascade (traitlets wiring), the thread-local hook
chain on ``NteractShellDisplayHook``, the buffer-attachment hook, and
the extension loader. Full kernel hand-off is exercised by integration
tests against a running kernel.
"""

from __future__ import annotations

import hashlib
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

    data = b"fake-parquet"
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

    data = b"display-parquet"
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


def test_load_extension_invokes_the_install_steps(monkeypatch):
    from nteract_kernel_launcher import _bootstrap

    calls = []

    monkeypatch.setattr(_bootstrap, "_install_llm_formatter", lambda ip: calls.append("llm"))
    monkeypatch.setattr(
        _bootstrap, "_install_dataframe_formatters", lambda ip: calls.append("formatters")
    )
    monkeypatch.setattr(_bootstrap, "_install_buffer_hooks", lambda ip: calls.append("hooks"))
    monkeypatch.setattr(
        _bootstrap, "_enable_third_party_renderers", lambda: calls.append("renderers")
    )

    _bootstrap.load_ipython_extension(SimpleNamespace())
    assert calls == ["llm", "formatters", "hooks", "renderers"]


def test_load_extension_swallows_per_step_failures(monkeypatch):
    """A broken step must not abort the others — we log-warn and move on."""
    from nteract_kernel_launcher import _bootstrap

    called = []

    def boom(*_args, **_kwargs):
        raise RuntimeError("nope")

    monkeypatch.setattr(_bootstrap, "_install_llm_formatter", boom)
    monkeypatch.setattr(_bootstrap, "_install_dataframe_formatters", boom)
    monkeypatch.setattr(_bootstrap, "_install_buffer_hooks", lambda ip: called.append("hooks"))
    monkeypatch.setattr(_bootstrap, "_enable_third_party_renderers", lambda: called.append("r"))

    # Must not raise.
    _bootstrap.load_ipython_extension(SimpleNamespace())
    assert called == ["hooks", "r"]


def test_install_registers_iterable_dataset_formatter():
    """Streaming HF datasets must reach the summary-only formatter path."""
    from IPython.core.formatters import DisplayFormatter
    from nteract_kernel_launcher import _bootstrap

    display_formatter = DisplayFormatter()
    ip = SimpleNamespace(display_formatter=display_formatter)

    _bootstrap._install_dataframe_formatters(ip)

    deferred = display_formatter.mimebundle_formatter.deferred_printers
    assert ("datasets.iterable_dataset", "IterableDataset") in deferred


# ─── emit path — only runs if pandas + pyarrow are importable ────────────


def test_emit_dataframe_stashes_bytes_and_returns_bundle():
    pd = pytest.importorskip("pandas")
    pytest.importorskip("pyarrow")

    from nteract_kernel_launcher import _bootstrap, _buffer_hook
    from nteract_kernel_launcher._refs import BLOB_REF_MIME

    _buffer_hook.pending_buffers().clear()
    df = pd.DataFrame({"a": [1, 2, 3], "b": ["x", "y", "z"]})
    bundle = _bootstrap._pandas_mimebundle(df)
    assert bundle is not None
    assert BLOB_REF_MIME in bundle
    assert "text/llm+plain" in bundle
    # Bytes are stashed under the ref's hash.
    h = bundle[BLOB_REF_MIME]["hash"]
    assert h in _buffer_hook.pending_buffers()
    assert isinstance(_buffer_hook.pending_buffers()[h], bytes)


# ─── pyarrow.Table path — preserves schema KV metadata ───────────────────


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
    from nteract_kernel_launcher._refs import BLOB_REF_MIME

    _buffer_hook.pending_buffers().clear()
    table = _pa_table_with_hf_metadata()

    bundle = _bootstrap._pyarrow_table_mimebundle(table)

    assert bundle is not None
    assert BLOB_REF_MIME in bundle
    assert "text/llm+plain" in bundle

    h = bundle[BLOB_REF_MIME]["hash"]
    assert bundle[BLOB_REF_MIME]["content_type"] == "application/vnd.apache.arrow.stream"
    data = _buffer_hook.pending_buffers()[h]
    md = pa.ipc.open_stream(io.BytesIO(data)).read_all().schema.metadata or {}
    assert b"huggingface" in md, f"missing huggingface KV; got keys: {[k.decode() for k in md]}"
    assert b'"_type": "Image"' in md[b"huggingface"]


def test_emit_pyarrow_record_batch_promotes_to_table():
    """RecordBatch should produce the same kind of bundle as Table."""
    pytest.importorskip("pyarrow")

    from nteract_kernel_launcher import _bootstrap, _buffer_hook
    from nteract_kernel_launcher._refs import BLOB_REF_MIME

    _buffer_hook.pending_buffers().clear()
    table = _pa_table_with_hf_metadata()
    batch = table.to_batches()[0]

    bundle = _bootstrap._pyarrow_record_batch_mimebundle(batch)

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
