from __future__ import annotations

import asyncio
import base64
import gzip
import logging
import sys
import threading
import time
from types import SimpleNamespace
from typing import Any, cast
from unittest.mock import Mock

import pytest
from IPython.core.formatters import DisplayFormatter
from nteract_kernel_launcher import _bokeh_handlers, _bokeh_session, _buffer_hook, _panel
from nteract_kernel_launcher._bokeh_handlers import (
    BOKEH_CLOSE_REPLY,
    BOKEH_CLOSE_REQUEST,
    BOKEH_DELTA,
    BOKEH_FOLD_REPLY,
    BOKEH_FOLD_REQUEST,
    BOKEH_PATCH_REPLY,
    BOKEH_PATCH_REQUEST,
)
from nteract_kernel_launcher._bokeh_session import (
    BOKEH_SESSION_MIME,
    INLINE_FLUSH_DELAY,
    BokehBuffer,
    BokehDelta,
    BokehDocumentSession,
    BokehFoldResult,
    BokehPatchApplyError,
    ref_props,
    session_registry,
)
from nteract_kernel_launcher._refs import BLOB_REF_MIME
from nteract_kernel_launcher.app import NteractKernel


@pytest.fixture(autouse=True)
def clear_bokeh_sessions():
    # A sink makes the registry live, as the kernel-hook install does; tests
    # that inspect deltas give their session its own sink.
    session_registry.set_event_sink(lambda delta: None)
    session_registry.clear()
    _buffer_hook.pending_buffers().clear()
    yield
    session_registry.clear()
    session_registry.set_event_sink(None)
    _buffer_hook.pending_buffers().clear()


def _formatter():
    display_formatter = DisplayFormatter()
    ip = SimpleNamespace(display_formatter=display_formatter)
    _panel.install(ip)
    return ip, display_formatter


def _format_panel(viewable):
    ip, display_formatter = _formatter()
    data, metadata = display_formatter.format(viewable)
    return ip, data, metadata


def _load_panel():
    pn = pytest.importorskip("panel")
    pn.extension()
    return pn


def _announced_panel(viewable):
    """Format a viewable and announce its session as the display hook would."""
    _ip, data, _metadata = _format_panel(viewable)
    payload = data[BOKEH_SESSION_MIME]
    session = session_registry.require(payload["session_id"])
    delivered: list[BokehDelta] = []
    session.set_event_sink(delivered.append)
    session.mark_announced()
    return payload, session, delivered


def _bokeh_model(viewable, payload):
    return viewable._models[payload["root_ids"][0]][0]


def _model_changed(model_id: str, attr: str, new: Any) -> dict[str, Any]:
    return {"kind": "ModelChanged", "model": {"id": model_id}, "attr": attr, "new": new}


def _data_session(data: dict[str, Any]):
    """A plain Bokeh document with one source, baselined and announced."""
    from bokeh.document import Document
    from bokeh.models import ColumnDataSource
    from bokeh.plotting import figure

    document = Document()
    source = ColumnDataSource(data=data)
    plot = figure(width=200, height=200)
    plot.line("x", "y", source=source)
    document.add_root(plot)
    session = BokehDocumentSession(
        document, [plot], producer_name="test", producer_version="0", announced=False
    )
    checkpoint = session.checkpoint()
    delivered: list[BokehDelta] = []
    session.set_event_sink(delivered.append)
    session.mark_announced()
    return session, source, checkpoint, delivered


def _values(delta: BokehDelta) -> dict[str, Any]:
    """``value`` changes by model; Panel 1.10 also sends ``TextInput.value_input``."""
    return {mid: props["value"] for mid, props in delta.props_changed.items() if "value" in props}


def _data_events(delivered: list[BokehDelta]) -> list[dict[str, Any]]:
    return [event for delta in delivered for event in delta.data_events]


def test_install_registers_panel_formatter_without_importing_panel():
    panel_was_loaded = "panel" in sys.modules
    ip, display_formatter = _formatter()

    printers = display_formatter.mimebundle_formatter.deferred_printers
    assert ("panel.viewable", "Viewable") in printers
    assert ("panel.viewable", "Viewer") in printers
    assert ("panel" in sys.modules) is panel_was_loaded

    _panel.uninstall(ip)
    assert ("panel.viewable", "Viewable") not in printers
    assert ("panel.viewable", "Viewer") not in printers


def test_viewer_renders_as_native_document_session():
    pn = _load_panel()

    class Counter(pn.viewable.Viewer):
        def __panel__(self):
            return pn.Row(pn.widgets.IntSlider(value=3))

    _ip, data, metadata = _format_panel(Counter())

    assert BOKEH_SESSION_MIME in data
    assert _panel._PANEL_FALLBACK_METADATA not in metadata
    session = session_registry.require(data[BOKEH_SESSION_MIME]["session_id"])
    assert session.root_ids == data[BOKEH_SESSION_MIME]["root_ids"]


def test_panel_bootstrap_filter_does_not_displace_buffer_hooks():
    class FakePub:
        def __init__(self):
            self._hooks = []

        def register_hook(self, hook):
            self._hooks.append(hook)

    ip = SimpleNamespace(display_pub=FakePub(), displayhook=FakePub())

    _panel._install_bootstrap_filter(ip)
    _buffer_hook.install(ip)
    _panel._install_bootstrap_filter(ip)

    for publisher in (ip.display_pub, ip.displayhook):
        assert len(publisher._hooks) == 3
        assert isinstance(publisher._hooks[0], _panel._SessionAnnouncer)
        assert getattr(publisher._hooks[1], "_nteract_panel_bootstrap_filter", False)
        assert publisher._hooks[2] is _buffer_hook.buffer_hook


def test_panel_bootstrap_filter_suppresses_legacy_autoloader():
    filter_bootstrap = _panel._PanelBootstrapFilter()
    code = r"const PN_RE = /^https:\/\/cdn\.holoviz\.org\/panel\/[^/]+\/dist\/panel/i;"
    msg = {
        "content": {
            "data": {
                "application/javascript": code,
                "application/vnd.holoviews_load.v0+json": code,
            },
            "metadata": {},
        }
    }

    assert filter_bootstrap(msg) is None


def test_panel_bootstrap_filter_suppresses_following_pyviz_manager_only():
    filter_bootstrap = _panel._PanelBootstrapFilter()
    panel_code = r"const PN_RE = /^https:\/\/cdn\.holoviz\.org\/panel\/[^/]+\/dist\/panel/i;"
    panel_msg = {
        "content": {
            "data": {
                "application/javascript": panel_code,
                "application/vnd.holoviews_load.v0+json": panel_code,
            },
            "metadata": {},
        }
    }
    manager_code = 'get_client_comm("hv-extension-comm")'
    manager_msg = {
        "content": {
            "data": {
                "application/javascript": manager_code,
                "application/vnd.holoviews_load.v0+json": manager_code,
            },
            "metadata": {},
        }
    }

    assert filter_bootstrap(panel_msg) is None
    assert filter_bootstrap(manager_msg) is None
    assert filter_bootstrap(manager_msg) == manager_msg


def test_panel_bootstrap_filter_suppresses_browser_info_output(monkeypatch):
    browser_info = object()
    panel_state = SimpleNamespace(
        _browser=browser_info,
        _views={"browser-root": (browser_info, object(), object(), object())},
    )
    monkeypatch.setitem(
        sys.modules,
        "panel.io.state",
        SimpleNamespace(state=panel_state),
    )
    msg = {
        "content": {
            "data": {
                "application/vnd.holoviews_exec.v0+json": "",
                "application/javascript": "window.PyViz = {};",
                "text/html": '<div id="legacy-panel-root"></div>',
            },
            "metadata": {"application/vnd.holoviews_exec.v0+json": {"id": "browser-root"}},
        }
    }

    assert _panel._PanelBootstrapFilter()(msg) is None


def test_panel_bootstrap_filter_preserves_unrelated_holoviews_outputs():
    filter_bootstrap = _panel._PanelBootstrapFilter()
    load_msg = {
        "content": {
            "data": {
                "application/javascript": "window.HoloViews = {};",
                "application/vnd.holoviews_load.v0+json": "window.HoloViews = {};",
            },
            "metadata": {},
        }
    }
    exec_msg = {
        "content": {
            "data": {
                "application/vnd.holoviews_exec.v0+json": "",
                "text/html": '<div id="holoviews-root"></div>',
            },
            "metadata": {"application/vnd.holoviews_exec.v0+json": {"id": "holoviews-root"}},
        }
    }

    assert filter_bootstrap(load_msg) == load_msg
    assert filter_bootstrap(exec_msg) == exec_msg


def test_panel_bootstrap_filter_allows_marked_formatter_fallback():
    filter_bootstrap = _panel._PanelBootstrapFilter()
    msg = {
        "content": {
            "data": {
                "application/vnd.holoviews_exec.v0+json": "",
                "text/html": '<div id="legacy-panel-root"></div>',
            },
            "metadata": {
                "application/vnd.nteract.panel-fallback.v1+json": True,
            },
        }
    }

    filtered = filter_bootstrap(msg)

    assert filtered is not None
    assert filtered["content"]["data"] == msg["content"]["data"]
    assert "application/vnd.nteract.panel-fallback.v1+json" not in filtered["content"]["metadata"]


def test_panel_bootstrap_filter_strips_marker_from_non_exec_fallback():
    msg = {
        "content": {
            "data": {"text/html": '<div id="legacy-panel-root"></div>'},
            "metadata": {"application/vnd.nteract.panel-fallback.v1+json": True},
        }
    }

    filtered = _panel._PanelBootstrapFilter()(msg)

    assert filtered == {
        "content": {
            "data": msg["content"]["data"],
            "metadata": {},
        }
    }


def test_native_formatter_failure_marks_legacy_fallback(monkeypatch):
    def fail_native_formatter(_viewable):
        raise RuntimeError("native failed")

    monkeypatch.setattr(
        _panel,
        "_native_panel_mimebundle",
        fail_native_formatter,
    )
    fallback_data = {
        "application/vnd.holoviews_exec.v0+json": "",
        "text/html": '<div id="legacy-panel-root"></div>',
    }

    data, metadata = _panel._format_panel(object(), lambda _viewable: fallback_data)

    assert data == fallback_data
    assert metadata["application/vnd.nteract.panel-fallback.v1+json"] is True


def test_panel_bootstrap_filter_preserves_unrelated_mime_data():
    filter_bootstrap = _panel._PanelBootstrapFilter()
    code = r"const PN_RE = /^https:\/\/cdn\.holoviz\.org\/panel\/[^/]+\/dist\/panel/i;"
    msg = {
        "content": {
            "data": {
                "application/javascript": code,
                "application/vnd.holoviews_load.v0+json": code,
                "text/plain": "extension loaded",
            },
            "metadata": {
                "application/vnd.holoviews_load.v0+json": {"isolated": True},
                "text/plain": {"expanded": False},
            },
        }
    }

    filtered = filter_bootstrap(msg)

    assert filtered is not None
    assert filtered["content"]["data"] == {"text/plain": "extension loaded"}
    assert filtered["content"]["metadata"] == {"text/plain": {"expanded": False}}
    assert "application/vnd.holoviews_load.v0+json" in msg["content"]["data"]


# ── Display payload and normalized session state ─────────────────────────


def test_panel_formatter_emits_document_session_without_pyviz_comms():
    pn = _load_panel()
    from panel.io.state import state

    slider = pn.widgets.FloatSlider(label="probe", start=0, end=10, value=4)
    _ip, data, metadata = _format_panel(slider)

    assert BOKEH_SESSION_MIME in data
    assert "application/vnd.holoviews_exec.v0+json" not in data
    assert "application/javascript" not in data
    payload = data[BOKEH_SESSION_MIME]
    assert payload["schema_version"] == 1
    assert "revision" not in payload
    assert payload["producer"] == {"name": "panel", "version": pn.__version__}
    assert payload["document"]["version"] == payload["bokeh_version"]
    assert payload["root_ids"] == [payload["document"]["roots"][0]["id"]]
    assert metadata[BOKEH_SESSION_MIME] == {
        "session_id": payload["session_id"],
        "isolated": True,
    }

    # Released builds link CDN URLs; dev builds bundle the same files inline
    # with a "BEGIN <file>" banner.
    javascript = [
        entry["url"] if entry["kind"] == "url" else entry["code"][:200]
        for entry in payload["resources"]["javascript"]
    ]
    assert any("bokeh-widgets" in item for item in javascript)
    assert any("panel.min.js" in item for item in javascript)

    session = session_registry.require(payload["session_id"])
    assert session.document is not None
    assert not session.announced
    root_id = payload["root_ids"][0]
    assert state._views[root_id][3] is None


def test_session_doc_carries_every_model_with_ref_props_and_meta():
    pn = _load_panel()

    slider = pn.widgets.IntSlider(start=0, end=10, value=4)
    _ip, data, _metadata = _format_panel(pn.Row(slider))
    payload = data[BOKEH_SESSION_MIME]
    session = session_registry.require(payload["session_id"])
    session_doc = payload["session_doc"]

    assert set(session_doc["models"]) == {model.id for model in session.document.models}
    meta = session_doc["meta"]
    assert meta["session_id"] == payload["session_id"]
    assert meta["producer_name"] == "panel"
    assert meta["producer_version"] == pn.__version__
    assert meta["bokeh_version"] == payload["bokeh_version"]
    assert meta["root_ids"] == payload["root_ids"]
    assert "roots" not in meta.get("doc_extras", {})

    root = session_doc["models"][payload["root_ids"][0]]
    assert root["type"] == "Row"
    assert "children" in root["ref_props"]
    assert root["props"]["children"] == [{"id": _bokeh_model(slider, payload).id}]
    slider_state = session_doc["models"][_bokeh_model(slider, payload).id]
    assert slider_state["props"]["value"] == 4
    assert "value" not in slider_state["ref_props"]
    assert all(isinstance(model["ref_props"], list) for model in session_doc["models"].values())


def test_ref_props_come_from_property_descriptors():
    pytest.importorskip("bokeh")
    from bokeh.models import ColumnDataSource, GlyphRenderer, Row, Slider

    assert "children" in ref_props(Row)
    assert "width" not in ref_props(Row)
    assert {"data_source", "glyph"} <= set(ref_props(GlyphRenderer))
    assert "value" not in ref_props(Slider)
    assert "data" not in ref_props(ColumnDataSource)
    assert ref_props(Row) is ref_props(Row)


def test_panel_formatter_stashes_buffers_once_for_document_and_session_doc():
    pn = _load_panel()
    np = pytest.importorskip("numpy")
    from bokeh.models import ColumnDataSource
    from bokeh.plotting import figure

    source = ColumnDataSource(
        data={
            "x": np.arange(5, dtype=np.float64),
            "y": np.arange(5, dtype=np.float64),
        }
    )
    plot = figure(width=300, height=200)
    plot.line("x", "y", source=source)

    _ip, data, _metadata = _format_panel(pn.pane.Bokeh(plot))
    payload = data[BOKEH_SESSION_MIME]
    refs = data[BLOB_REF_MIME]["refs"]

    assert len(payload["buffers"]) == 2
    assert len(refs) == 2
    assert [buffer["buffer_index"] for buffer in payload["buffers"]] == [0, 1]
    assert [ref["buffer_index"] for ref in refs] == [0, 1]
    assert refs[0]["hash"] == refs[1]["hash"]
    assert refs[0]["hash"] in _buffer_hook.pending_buffers()

    # Column data lives in a fold, not in the source's props, and its buffers
    # point at frames the DocJson already sends.
    session_doc = payload["session_doc"]
    assert "data" not in session_doc["models"][source.id]["props"]
    [fold] = session_doc["data_events"]
    assert fold["kind"] == "ColumnsFolded"
    assert (fold["source_id"], fold["version"]) == (source.id, 0)
    assert set(fold["columns"]) == {"x", "y"}
    assert fold["columns"]["x"]["type"] == "ndarray"
    assert [buffer["buffer_index"] for buffer in payload["session_doc_buffers"]] == [0, 0]
    assert {buffer["hash"] for buffer in payload["session_doc_buffers"]} == {refs[0]["hash"]}


# ── Delta shape ──────────────────────────────────────────────────────────


def test_python_change_publishes_props_changed():
    pn = _load_panel()

    slider = pn.widgets.FloatSlider(label="server", start=0, end=10, value=1)
    payload, session, delivered = _announced_panel(slider)
    slider_model = _bokeh_model(slider, payload)

    slider.value = 7

    session.pop_deltas()
    [delta] = delivered
    assert delta.session_id == session.session_id
    assert delta.transaction_id
    assert delta.props_changed == {slider_model.id: {"value": 7}}
    assert delta.models_added == {}
    assert delta.models_removed == []
    assert delta.data_events == []
    assert delta.meta is None


def test_delta_adds_models_with_their_references_and_removes_them():
    pn = _load_panel()

    async def change_layout():
        column = pn.Column(pn.widgets.TextInput(value="a"))
        payload, _session, delivered = _announced_panel(column)
        column_id = payload["root_ids"][0]
        markdown = pn.pane.Markdown("added")
        column.append(markdown)
        await asyncio.sleep(0.05)
        added_delta = delivered[-1]
        markdown_id = markdown._models[column_id][0].id
        column.pop(-1)
        await asyncio.sleep(0.05)
        return column_id, markdown_id, added_delta, delivered[-1]

    column_id, markdown_id, added, removed = asyncio.run(change_layout())

    model = added.models_added[markdown_id]
    assert model["type"] == "panel.models.markup.HTML"
    assert "stylesheets" in model["ref_props"]
    assert "added" in model["props"]["text"]
    # The new model lands in the same delta as the reference to it.
    assert {"id": markdown_id} in added.props_changed[column_id]["children"]
    for state in added.models_added.values():
        assert set(state) == {"type", "ref_props", "props"}

    assert markdown_id in removed.models_removed
    assert {"id": markdown_id} not in removed.props_changed[column_id]["children"]
    assert set(removed.models_removed) == set(added.models_added)


def test_held_events_defer_the_delta_until_unhold():
    pytest.importorskip("bokeh")
    from bokeh.document import Document
    from bokeh.models import Div, Row

    document = Document()
    row = Row(children=[Div(text="a")])
    document.add_root(row)
    session = BokehDocumentSession(document, [row], producer_name="test", producer_version="0")
    delivered: list[BokehDelta] = []
    session.set_event_sink(delivered.append)

    document.hold()
    added = Div(text="b")
    row.children = [*row.children, added]
    assert session.pop_deltas() == []
    assert delivered == []
    document.unhold()

    [delta] = delivered
    assert list(delta.models_added) == [added.id]
    assert delta.props_changed[row.id]["children"][-1] == {"id": added.id}


def test_root_changes_publish_meta():
    pytest.importorskip("bokeh")
    from bokeh.document import Document
    from bokeh.models import Div

    document = Document()
    first = Div(text="a")
    document.add_root(first)
    session = BokehDocumentSession(document, [first], producer_name="test", producer_version="0")
    delivered: list[BokehDelta] = []
    session.set_event_sink(delivered.append)

    second = Div(text="b")
    document.add_root(second)

    [delta] = delivered
    assert delta.meta == {"root_ids": [first.id, second.id], "title": document.title}
    assert list(delta.models_added) == [second.id]


def test_python_change_to_esm_component_publishes_delta():
    pn = _load_panel()
    param = pytest.importorskip("param")

    class Counter(pn.custom.JSComponent):
        value = param.Integer(default=0)

        _esm = "export function render() {}"

    async def change_from_python():
        counter = Counter()
        layout = pn.Column(counter)
        _payload, session, delivered = _announced_panel(layout)

        counter.value = 3
        layout.append(pn.pane.Markdown("appended"))
        # Panel 1.9 releases the hold on the next tick of the kernel loop.
        await asyncio.sleep(0.05)
        session.pop_deltas()
        return delivered

    deltas = asyncio.run(change_from_python())
    changes = [
        (attr, value) for d in deltas for p in d.props_changed.values() for attr, value in p.items()
    ]
    assert ("value", 3) in changes
    assert any(attr == "children" for attr, _ in changes)
    assert any(d.models_added for d in deltas)


# ── Foreign patches and the correction rule ──────────────────────────────


def test_foreign_patch_publishes_derived_changes_without_echo():
    pn = _load_panel()

    source = pn.widgets.FloatSlider(label="source", start=0, end=10, value=1)
    target = pn.widgets.FloatSlider(label="target", start=0, end=20, value=2)
    source.param.watch(lambda event: setattr(target, "value", event.new * 2), "value")
    payload, session, delivered = _announced_panel(pn.Row(source, target))
    source_model = _bokeh_model(source, payload)
    target_model = _bokeh_model(target, payload)

    result = session.apply_patch(
        transaction_id="interaction-1",
        patch={"events": [_model_changed(source_model.id, "value", 5)]},
    )

    assert source.value == 5
    assert target.value == 10
    assert result.transaction_id == "interaction-1"
    assert delivered == [result.delta]
    assert result.delta is not None
    assert result.delta.transaction_id == "interaction-1"
    # The accepted foreign value is already in the session document.
    assert result.delta.props_changed == {target_model.id: {"value": 10}}


def test_python_changes_publish_before_a_foreign_patch():
    pn = _load_panel()

    async def race():
        slider = pn.widgets.FloatSlider(start=0, end=10, value=1)
        text = pn.widgets.TextInput(value="a")
        payload, session, delivered = _announced_panel(pn.Row(slider, text))
        text.value = "b"
        session.apply_patch(
            transaction_id="tx",
            patch={"events": [_model_changed(_bokeh_model(slider, payload).id, "value", 5)]},
        )
        return delivered, _bokeh_model(text, payload).id

    delivered, text_id = asyncio.run(race())
    assert _values(delivered[0]) == {text_id: "b"}
    assert delivered[0].transaction_id != "tx"


def test_correction_writes_back_a_value_python_rejected():
    pn = _load_panel()

    slider = pn.widgets.IntSlider(start=0, end=10, value=0)

    def reject(event):
        if event.new > 5:
            slider.value = event.old

    slider.param.watch(reject, "value")
    payload, session, _delivered = _announced_panel(slider)
    slider_model = _bokeh_model(slider, payload)

    result = session.apply_patch(
        transaction_id="rejected",
        patch={"events": [_model_changed(slider_model.id, "value", 8)]},
    )

    assert slider.value == 0
    assert result.delta is not None
    assert result.delta.props_changed == {slider_model.id: {"value": 0}}


def test_correction_bypasses_bokehs_equal_value_no_op():
    """A value restored under the patch's own setter emits no event Bokeh would
    publish, so only the comparison with the requested value catches it."""
    pytest.importorskip("bokeh")
    from bokeh.document import Document
    from bokeh.models import Slider

    document = Document()
    slider = Slider(start=0, end=10, value=0)
    document.add_root(slider)
    session = BokehDocumentSession(document, [slider], producer_name="test", producer_version="0")

    def restore(attr, old, new):
        if new > 5:
            slider.set_from_json("value", old, setter=cast(Any, session._active_setter))

    slider.on_change("value", restore)

    result = session.apply_patch(
        transaction_id="restore", patch={"events": [_model_changed(slider.id, "value", 8)]}
    )

    assert slider.value == 0
    assert result.delta is not None
    assert result.delta.props_changed == {slider.id: {"value": 0}}

    # Equal values need no correction, whatever their JSON number type.
    accepted = session.apply_patch(patch={"events": [_model_changed(slider.id, "start", 0)]})
    assert accepted.delta is None


def test_apply_error_publishes_current_values_of_all_touched_keys():
    pn = _load_panel()

    slider = pn.widgets.IntSlider(start=0, end=10, value=1)
    text = pn.widgets.TextInput(value="a")
    payload, session, delivered = _announced_panel(pn.Row(text, slider))
    slider_model = _bokeh_model(slider, payload)
    text_model = _bokeh_model(text, payload)

    with pytest.raises(BokehPatchApplyError) as error:
        session.apply_patch(
            transaction_id="failing",
            patch={
                "events": [
                    _model_changed(text_model.id, "value", "b"),
                    _model_changed(slider_model.id, "value", "not a number"),
                ]
            },
        )

    assert error.value.transaction_id == "failing"
    assert not hasattr(error.value, "checkpoint")
    [delta] = delivered
    assert delta.transaction_id == "failing"
    assert delta.props_changed == {
        text_model.id: {"value": text_model.value},
        slider_model.id: {"value": 1},
    }


def test_equal_array_in_another_encoding_needs_no_correction():
    """Peers gzip base64 buffers with other settings than Python, so the JSON differs."""
    np = pytest.importorskip("numpy")
    from bokeh.core.serialization import Serializer
    from bokeh.document import Document
    from bokeh.models import FixedTicker

    document = Document()
    ticker = FixedTicker(ticks=np.arange(300.0))
    document.add_root(ticker)
    session = BokehDocumentSession(document, [ticker], producer_name="test", producer_version="0")
    requested = Serializer(deferred=False).encode(ticker.ticks)
    raw = gzip.decompress(base64.b64decode(requested["array"]["data"]))
    requested["array"]["data"] = base64.b64encode(
        gzip.compress(raw, compresslevel=1, mtime=0)
    ).decode()

    result = session.apply_patch(patch={"events": [_model_changed(ticker.id, "ticks", requested)]})

    assert result.delta is None
    session.close()


def test_callback_joining_a_thread_that_changes_the_document_does_not_deadlock():
    pytest.importorskip("bokeh")
    from bokeh.document import Document
    from bokeh.models import Div, Row, Slider

    document = Document()
    slider = Slider(start=0, end=10, value=0)
    div = Div(text="before")
    row = Row(children=[slider, div])
    document.add_root(row)
    session = BokehDocumentSession(document, [row], producer_name="test", producer_version="0")
    delivered: list[BokehDelta] = []
    session.set_event_sink(delivered.append)

    def on_value(attr, old, new):
        worker = threading.Thread(target=setattr, args=(div, "text", f"worker {new}"), daemon=True)
        worker.start()
        worker.join()

    slider.on_change("value", on_value)
    results = []
    patcher = threading.Thread(
        target=lambda: results.append(
            session.apply_patch(
                transaction_id="tx", patch={"events": [_model_changed(slider.id, "value", 5)]}
            )
        ),
        daemon=True,
    )
    patcher.start()
    patcher.join(5)

    assert not patcher.is_alive(), "apply_patch deadlocked"
    [result] = results
    assert result.delta is not None
    assert result.delta.transaction_id == "tx"
    assert result.delta.props_changed == {div.id: {"text": "worker 5"}}
    assert delivered == [result.delta]
    session.close()


def test_fold_from_another_thread_during_a_foreign_patch_follows_its_delta():
    """Folding mid-transaction would encode rows whose stream is not versioned yet."""
    pytest.importorskip("bokeh")
    session, source, checkpoint, delivered = _data_session(
        {"x": list(range(100)), "y": list(range(100))}
    )
    plot = session.roots[0]
    folds = []

    def on_width(attr, old, new):
        source.stream({"x": [100], "y": [100]})
        worker = threading.Thread(
            target=lambda: folds.append(session.fold([source.id], transaction_id="fold")),
            daemon=True,
        )
        worker.start()
        worker.join()

    plot.on_change("width", on_width)
    patcher = threading.Thread(
        target=session.apply_patch,
        kwargs={"patch": {"events": [_model_changed(plot.id, "width", 300)]}},
        daemon=True,
    )
    patcher.start()
    patcher.join(5)

    assert not patcher.is_alive(), "apply_patch deadlocked"
    assert folds == [BokehFoldResult([], deferred=True)]
    events = _data_events(delivered)
    assert [event["kind"] for event in events] == ["ColumnsStreamed", "ColumnsFolded"]
    assert delivered[-1].transaction_id == "fold"
    assert events[-1]["version"] == 1
    replayed = _replayed_source(checkpoint, delivered, source.id)
    assert list(replayed.data["x"]) == list(source.data["x"])
    session.close()


def _row_session():
    from bokeh.document import Document
    from bokeh.models import Row, Slider

    document = Document()
    slider = Slider(start=0, end=10, value=0)
    row = Row(children=[slider])
    document.add_root(row)
    session = BokehDocumentSession(document, [row], producer_name="test", producer_version="0")
    delivered: list[BokehDelta] = []
    session.set_event_sink(delivered.append)
    return session, row, slider, delivered


def test_unencodable_property_is_logged_and_does_not_block_later_deltas(caplog):
    pytest.importorskip("bokeh")
    from bokeh.models import Div

    session, row, slider, delivered = _row_session()
    bad = Div(text="bad", tags=[object()])

    with caplog.at_level(logging.WARNING, logger="nteract_kernel_launcher"):
        # Without a loop each change flushes inline, inside the user's assignment.
        row.children = [slider, bad]
        slider.value = 3

    added, changed = delivered
    assert added.models_added[bad.id]["props"] == {"text": "bad"}
    assert added.props_changed == {row.id: {"children": [{"id": slider.id}, {"id": bad.id}]}}
    assert changed.props_changed == {slider.id: {"value": 3}}
    assert "tags" in caplog.text
    session.close()


def test_unencodable_message_is_logged_and_dropped(caplog):
    pytest.importorskip("bokeh")
    from bokeh.document.events import MessageSentEvent

    session, _row, slider, delivered = _row_session()

    with caplog.at_level(logging.WARNING, logger="nteract_kernel_launcher"):
        session.document.callbacks.trigger_on_change(
            MessageSentEvent(session.document, "custom", object())
        )
        slider.value = 4

    assert [delta.messages for delta in delivered] == [[]]
    assert delivered[0].props_changed == {slider.id: {"value": 4}}
    assert "custom" in caplog.text
    session.close()


def test_unencodable_stream_is_logged_and_sent_as_a_replacement(caplog):
    pytest.importorskip("bokeh")
    session, source, _checkpoint, delivered = _data_session({"x": [0, 1], "y": ["a", "b"]})

    with caplog.at_level(logging.WARNING, logger="nteract_kernel_launcher"):
        source.stream({"x": [2], "y": [object()]})
        source.stream({"x": [3], "y": ["d"]})

    replaced, streamed = [e for e in _data_events(delivered) if e["kind"] != "ColumnsFolded"]
    assert replaced["kind"] == "ColumnDataChanged"
    assert (replaced["base_version"], replaced["new_version"]) == (0, 1)
    # The column that cannot be encoded is left out rather than failing the delta.
    assert replaced["columns"] == {"x": [0, 1, 2]}
    assert (streamed["base_version"], streamed["new_version"]) == (1, 2)
    assert "ColumnsStreamed" in caplog.text
    session.close()


def test_failed_build_commits_no_versions_and_keeps_its_events(monkeypatch, caplog):
    pytest.importorskip("bokeh")
    session, source, checkpoint, delivered = _data_session(
        {"x": list(range(10)), "y": list(range(10))}
    )
    plot = session.roots[0]

    def on_width(attr, old, new):
        source.stream({"x": [10], "y": [10]})
        session.document.title = "streamed"

    plot.on_change("width", on_width)
    meta = BokehDocumentSession._meta
    failures = []

    def fail_once(self):
        if not failures:
            failures.append(True)
            raise RuntimeError("build failed")
        return meta(self)

    monkeypatch.setattr(BokehDocumentSession, "_meta", fail_once)

    with caplog.at_level(logging.WARNING, logger="nteract_kernel_launcher"):
        session.apply_patch(patch={"events": [_model_changed(plot.id, "width", 300)]})
        source.stream({"x": [11], "y": [11]})

    assert failures
    assert "build failed" in caplog.text
    events = [event for event in _data_events(delivered) if event["kind"] != "ColumnsFolded"]
    assert [(event["base_version"], event["new_version"]) for event in events] == [(0, 1), (1, 2)]
    assert any(delta.meta == {"root_ids": [plot.id], "title": "streamed"} for delta in delivered)
    replayed = _replayed_source(checkpoint, delivered, source.id)
    assert list(replayed.data["x"]) == list(source.data["x"])
    session.close()


def test_events_whose_build_keeps_failing_are_dropped_and_their_source_refolded(
    monkeypatch, caplog
):
    pytest.importorskip("bokeh")
    session, source, checkpoint, delivered = _data_session({"x": [0, 1], "y": [0, 1]})
    plot = session.roots[0]
    build = BokehDocumentSession._build_delta_unlocked
    poisoned: list[Any] = []
    attempts = []

    def fail_on_first_stream(self, events, *args, **kwargs):
        if not poisoned:
            poisoned.extend(e for e in events if getattr(e, "kind", None) == "ColumnsStreamed")
        if any(e in poisoned for e in events):
            attempts.append(len(events))
            raise RuntimeError("build failed")
        return build(self, events, *args, **kwargs)

    monkeypatch.setattr(BokehDocumentSession, "_build_delta_unlocked", fail_on_first_stream)

    with caplog.at_level(logging.WARNING, logger="nteract_kernel_launcher"):
        source.stream({"x": [2], "y": [2]})
        plot.width = 300
        plot.height = 300
        plot.width = 400
        source.stream({"x": [3], "y": [3]})

    # The stream flushes at its trigger and again at its dispatch.
    assert attempts == [1, 1, 2]
    errors = [r for r in caplog.records if r.levelno >= logging.ERROR]
    assert len(errors) == 1
    assert "dropping" in errors[0].getMessage()
    # Events that failed alongside the dropped ones still go out.
    widths = [d.props_changed.get(plot.id, {}).get("width") for d in delivered]
    widths = [width for width in widths if width is not None]
    assert widths == [300, 400]
    # The fold restores the dropped rows at the same version, so no gap follows.
    events = _data_events(delivered)
    assert [(e["kind"], e.get("version"), e.get("base_version")) for e in events[:2]] == [
        ("ColumnsFolded", 0, None),
        ("ColumnsStreamed", None, 0),
    ]
    replayed = _replayed_source(checkpoint, delivered, source.id)
    assert list(replayed.data["x"]) == list(source.data["x"]) == [0, 1, 2, 3]
    session.close()


# ── Data events and folding ──────────────────────────────────────────────


def test_stream_and_patch_become_versioned_data_events():
    np = pytest.importorskip("numpy")
    session, source, _checkpoint, delivered = _data_session(
        {"x": np.arange(1000, dtype=float), "y": np.zeros(1000)}
    )

    source.stream({"x": np.array([1000.0]), "y": np.array([1.0])}, rollover=1000)
    source.patch({"y": [(0, 5.0)]})

    streamed, patched = _data_events(delivered)
    assert streamed["kind"] == "ColumnsStreamed"
    assert (streamed["source_id"], streamed["base_version"], streamed["new_version"]) == (
        source.id,
        0,
        1,
    )
    assert streamed["rollover"] == 1000
    assert delivered[0].buffers
    assert patched["kind"] == "ColumnsPatched"
    assert (patched["base_version"], patched["new_version"]) == (1, 2)
    assert patched["patches"]
    session.close()


def test_full_data_replacement_reports_removed_columns():
    session, source, _checkpoint, delivered = _data_session({"x": [1, 2], "y": [3, 4]})

    source.data = {"x": [5, 6], "z": [7, 8]}

    [event] = _data_events(delivered)
    assert event["kind"] == "ColumnDataChanged"
    assert (event["base_version"], event["new_version"]) == (0, 1)
    assert event["columns"] == {"x": [5, 6], "z": [7, 8]}
    assert event["columns_removed"] == ["y"]
    session.close()


def test_partial_replacement_sends_only_replaced_columns():
    session, source, _checkpoint, delivered = _data_session({"x": [1, 2], "y": [3, 4]})

    source.data.update(y=[9, 9])

    [event] = _data_events(delivered)
    assert event["kind"] == "ColumnDataChanged"
    assert event["columns"] == {"y": [9, 9]}
    assert event["columns_removed"] == []
    session.close()


def test_replacement_after_unfolded_events_sends_every_column():
    session, source, _checkpoint, delivered = _data_session(
        {"x": list(range(100)), "y": list(range(100))}
    )

    source.stream({"x": [100], "y": [100]})
    source.data.update(y=[0] * 101)

    streamed, replaced = _data_events(delivered)
    assert streamed["kind"] == "ColumnsStreamed"
    assert replaced["kind"] == "ColumnDataChanged"
    assert set(replaced["columns"]) == {"x", "y"}
    assert (replaced["base_version"], replaced["new_version"]) == (1, 2)
    session.close()


def test_fold_when_event_bytes_reach_twice_the_last_fold():
    session, source, _checkpoint, delivered = _data_session({"x": [0], "y": [0]})

    for i in range(1, 50):
        source.stream({"x": [i], "y": [i]})
        if any(event["kind"] == "ColumnsFolded" for event in _data_events(delivered)):
            break

    events = _data_events(delivered)
    fold_index = next(i for i, event in enumerate(events) if event["kind"] == "ColumnsFolded")
    fold = events[fold_index]
    stream = events[fold_index - 1]
    # The fold follows the event that crossed the threshold, at its version.
    assert stream["kind"] == "ColumnsStreamed"
    assert fold["version"] == stream["new_version"]
    assert fold["columns"]["x"] == source.data["x"]
    assert session._sources[source.id].bytes_since_fold == 0
    session.close()


def test_fold_after_quiet_period(monkeypatch):
    monkeypatch.setattr(_bokeh_session, "FOLD_QUIET_SECONDS", 0.05)

    async def stream_then_wait():
        session, source, _checkpoint, delivered = _data_session(
            {"x": list(range(1000)), "y": list(range(1000))}
        )
        source.stream({"x": [1000], "y": [1000]})
        await asyncio.sleep(0)
        await asyncio.sleep(0.2)
        session.close()
        return source, delivered

    source, delivered = asyncio.run(stream_then_wait())
    kinds = [event["kind"] for event in _data_events(delivered)]
    assert kinds == ["ColumnsStreamed", "ColumnsFolded"]
    fold = _data_events(delivered)[-1]
    assert fold["version"] == 1
    assert len(fold["columns"]["x"]) == 1001
    assert delivered[-1].data_events == [fold]


def test_fold_on_demand():
    session, source, _checkpoint, delivered = _data_session(
        {"x": list(range(1000)), "y": list(range(1000))}
    )
    source.stream({"x": [1000], "y": [1000]})

    assert session.fold(transaction_id="fold-1") == BokehFoldResult([source.id])
    assert delivered[-1].transaction_id == "fold-1"
    assert delivered[-1].data_events[0]["kind"] == "ColumnsFolded"
    # Nothing left to fold unless a source is named explicitly.
    assert session.fold() == BokehFoldResult([])
    assert session.fold([source.id, "missing"]) == BokehFoldResult([source.id])
    session.close()


@pytest.mark.parametrize("release", ["unhold", "drain"])
def test_fold_requested_while_held_follows_once_the_hold_ends(kernel, release):
    """A refused fold would leave a late joiner waiting for columns that never come."""
    pytest.importorskip("bokeh")

    async def run():
        session, source, checkpoint, delivered = _data_session(
            {"x": list(range(100)), "y": list(range(100))}
        )
        session_registry.register(session)
        session.set_event_sink(delivered.append)
        source.stream({"x": [100], "y": [100]})
        session.document.hold()
        source.stream({"x": [101], "y": [101]})
        kernel.dispatch(
            BOKEH_FOLD_REQUEST,
            {
                "content": {
                    "schema_version": 1,
                    "session_id": session.session_id,
                    "transaction_id": "held-fold",
                    "source_ids": [source.id],
                }
            },
        )
        reply = kernel.replies.pop()["content"]
        if release == "unhold":
            session.document.unhold()
        else:
            # Panel's ``_drain_unconnected_events`` clears a hold without dispatch.
            session.document.callbacks._held_events = []
            session.document.callbacks._hold = None
        await asyncio.sleep(INLINE_FLUSH_DELAY * 4)
        session.close()
        return source, checkpoint, reply, delivered

    source, checkpoint, reply, delivered = asyncio.run(run())
    assert (reply["status"], reply["source_ids"], reply["deferred"]) == ("ok", [], True)
    [fold] = [delta for delta in delivered if delta.transaction_id == "held-fold"]
    assert [event["kind"] for event in fold.data_events] == ["ColumnsFolded"]
    assert fold.data_events[0]["version"] == 2
    replayed = _replayed_source(checkpoint, delivered, source.id)
    assert list(replayed.data["x"]) == list(source.data["x"])


@pytest.mark.parametrize("encoder", ["quiet-fold", "fold-request", "replacement"])
def test_encoding_on_another_thread_waits_for_a_stream_in_flight(monkeypatch, encoder):
    """Bokeh mutates ``source.data`` before it triggers the stream, as with Panel nthreads."""
    pytest.importorskip("bokeh")
    from bokeh.document.events import ColumnsStreamedEvent

    monkeypatch.setattr(_bokeh_session, "FOLD_QUIET_SECONDS", 0.0)
    session, source, checkpoint, delivered = _data_session(
        {"x": list(range(100)), "y": list(range(100))}
    )
    source.stream({"x": [100], "y": [100]})
    callbacks = session.document.callbacks
    record = callbacks.trigger_on_change
    mutated = threading.Event()
    release = threading.Event()

    def paused_trigger(event):
        if isinstance(event, ColumnsStreamedEvent) and not release.is_set():
            mutated.set()
            release.wait(5)
        record(event)

    callbacks.trigger_on_change = paused_trigger
    streamer = threading.Thread(target=source.stream, args=({"x": [101], "y": [101]},), daemon=True)
    streamer.start()
    assert mutated.wait(5)

    def encode():
        if encoder == "quiet-fold":
            session._quiet_fold()
        elif encoder == "fold-request":
            session.fold([source.id])
        else:
            source.data.update(y=[value * 2 for value in range(102)])

    other = threading.Thread(target=encode, daemon=True)
    other.start()
    other.join(0.2)
    release.set()
    streamer.join(5)
    other.join(5)
    assert not streamer.is_alive()
    assert not other.is_alive()
    session.close()

    replayed = _replayed_source(checkpoint, delivered, source.id)
    assert {name: list(values) for name, values in replayed.data.items()} == {
        name: list(values) for name, values in source.data.items()
    }


def test_new_source_arrives_with_a_fold():
    pytest.importorskip("bokeh")
    from bokeh.document import Document
    from bokeh.models import ColumnDataSource, Row
    from bokeh.plotting import figure

    document = Document()
    row = Row()
    document.add_root(row)
    session = BokehDocumentSession(document, [row], producer_name="test", producer_version="0")
    delivered: list[BokehDelta] = []
    session.set_event_sink(delivered.append)

    source = ColumnDataSource(data={"x": [1], "y": [2]})
    plot = figure(width=200, height=200)
    plot.line("x", "y", source=source)
    row.children = [plot]

    [delta] = delivered
    assert "data" not in delta.models_added[source.id]["props"]
    assert delta.data_events == [
        {
            "kind": "ColumnsFolded",
            "source_id": source.id,
            "version": 0,
            "columns": {"x": [1], "y": [2]},
        }
    ]
    session.close()


def _replay_data_events(document: Any, delivered: list[BokehDelta]) -> None:
    """Apply data events to a replica as a peer at the exact base would.

    A fold resets the source, as for a late joiner reading the folded columns
    and the tail after them.
    """
    from bokeh.core.serialization import Buffer, Deserializer, Serialized
    from bokeh.core.types import ID

    versions: dict[str, int] = {}
    for delta in delivered:
        buffers = [Buffer(ID(buffer.id), buffer.data) for buffer in delta.buffers]
        for event in delta.data_events:
            kind, source_id = event["kind"], event["source_id"]
            if kind == "ColumnsFolded":
                assert event["version"] >= versions.get(source_id, 0)
                versions[source_id] = event["version"]
                source = document.get_model_by_id(source_id)
                source.data = Deserializer().deserialize(
                    Serialized(content=event["columns"], buffers=buffers)
                )
                continue
            assert event["base_version"] == versions.get(source_id, 0)
            versions[source_id] = event["new_version"]
            model = {"id": source_id}
            if kind == "ColumnDataChanged":
                source = document.get_model_by_id(source_id)
                columns = Deserializer().deserialize(
                    Serialized(content=event["columns"], buffers=buffers)
                )
                data = {
                    name: value
                    for name, value in source.data.items()
                    if name not in event["columns_removed"]
                }
                source.data = {**data, **columns}
                continue
            if kind == "ColumnsStreamed":
                patch_event = {
                    "kind": kind,
                    "model": model,
                    "attr": "data",
                    "data": event["data"],
                    "rollover": event["rollover"],
                }
            else:
                patch_event = {
                    "kind": kind,
                    "model": model,
                    "attr": "data",
                    "patches": event["patches"],
                }
            document.apply_json_patch(
                Serialized(content={"events": [patch_event]}, buffers=buffers)
            )


def _replayed_source(checkpoint: Any, delivered: list[BokehDelta], source_id: str) -> Any:
    """The source as a peer holds it after replaying the deltas onto the checkpoint."""
    from bokeh.core.serialization import Buffer, Serialized
    from bokeh.core.types import ID
    from bokeh.document import Document

    replica = Document.from_json(
        cast(
            Any,
            Serialized(
                content=checkpoint.document.content,
                buffers=[Buffer(ID(b.id), b.data) for b in checkpoint.document.buffers],
            ),
        )
    )
    _replay_data_events(replica, delivered)
    replayed = cast(Any, replica.get_model_by_id(cast(Any, source_id)))
    assert replayed is not None
    return replayed


@pytest.mark.parametrize("batch", ["loop", "transaction", "hold"])
@pytest.mark.parametrize("payload", ["list", "ndarray"])
@pytest.mark.parametrize("operation", ["stream", "patch"])
def test_reused_stream_and_patch_payloads_replay_their_values_at_the_call(
    operation, payload, batch
):
    np = pytest.importorskip("numpy")

    def column(values):
        return np.array(values, dtype=float) if payload == "ndarray" else list(values)

    def mutate_and_reapply(source):
        # Callers may reuse a payload, mutating it in place between calls.
        if operation == "stream":
            values = {"x": column([3.0]), "y": column([3.0])}
            source.stream(values)
            values["x"][0] = 4.0
            values["y"][0] = 4.0
            source.stream(values)
        elif payload == "ndarray":
            new = np.array([5.0])
            patches = {"y": [(slice(0, 1), new)]}
            source.patch(patches)
            new[0] = 6.0
            patches["y"][0] = (slice(1, 2), new)
            source.patch(patches)
        else:
            patches = {"y": [(0, 5.0)]}
            source.patch(patches)
            patches["y"][0] = (1, 6.0)
            source.patch(patches)

    async def run():
        session, source, checkpoint, delivered = _data_session(
            {"x": column([0.0, 1.0, 2.0]), "y": column([0.0, 0.0, 0.0])}
        )
        plot = session.roots[0]
        if batch == "transaction":
            plot.on_change("width", lambda attr, old, new: mutate_and_reapply(source))
            session.apply_patch(patch={"events": [_model_changed(plot.id, "width", 300)]})
        elif batch == "hold":
            # Bokeh dispatches held events only at unhold, after the mutation.
            session.document.hold()
            mutate_and_reapply(source)
            session.document.unhold()
            await asyncio.sleep(0)
            await asyncio.sleep(0)
        else:
            mutate_and_reapply(source)
            await asyncio.sleep(0)
            await asyncio.sleep(0)
        session.close()
        return source, checkpoint, delivered

    source, checkpoint, delivered = asyncio.run(run())
    # Both events reach the peer in one delta, so both were encoded after the mutation.
    [delta] = delivered
    kinds = [event["kind"] for event in delta.data_events if event["kind"] != "ColumnsFolded"]
    assert kinds == ["ColumnsStreamed" if operation == "stream" else "ColumnsPatched"] * 2
    replayed = _replayed_source(checkpoint, delivered, source.id)
    if operation == "stream":
        assert list(source.data["x"]) == [0.0, 1.0, 2.0, 3.0, 4.0]
    else:
        assert list(source.data["y"]) == [5.0, 6.0, 0.0]
    for name in ("x", "y"):
        assert list(replayed.data[name]) == list(source.data[name])


@pytest.mark.parametrize("batch", ["loop", "transaction"])
def test_callback_edit_of_the_same_source_is_versioned_after_its_trigger(batch):
    pytest.importorskip("bokeh")

    async def run():
        session, source, checkpoint, delivered = _data_session(
            {"x": [0.0, 1.0, 2.0], "y": [0.0, 0.0, 0.0]}
        )

        def clamp(attr, old, new):
            if source.data["y"][0] > 3.0:
                source.patch({"y": [(0, 3.0)]})

        source.on_change("data", clamp)
        if batch == "transaction":
            session.apply_patch(
                transaction_id="browser-patch",
                patch={
                    "events": [
                        {
                            "kind": "ColumnsPatched",
                            "model": {"id": source.id},
                            "attr": "data",
                            "patches": {"y": [[0, 5.0]]},
                        }
                    ]
                },
            )
        else:
            source.patch({"y": [(0, 5.0)]})
            await asyncio.sleep(0)
            await asyncio.sleep(0)
        session.close()
        return source, checkpoint, delivered

    source, checkpoint, delivered = asyncio.run(run())
    assert source.data["y"][0] == 3.0
    patched = [event for event in _data_events(delivered) if event["kind"] == "ColumnsPatched"]
    assert [(event["base_version"], event["new_version"]) for event in patched] == [(0, 1), (1, 2)]
    assert [event["patches"]["entries"][0][1] for event in patched] == [[[0, 5.0]], [[0, 3.0]]]
    if batch == "transaction":
        # The browser applied its own edit; the clamp it has not seen.
        assert patched[0]["echo_of"] == 0
        assert "echo_of" not in patched[1]
    else:
        assert all("echo_of" not in event for event in patched)
    replayed = _replayed_source(checkpoint, delivered, source.id)
    assert list(replayed.data["y"]) == list(source.data["y"])


def test_held_python_edit_is_versioned_before_a_later_foreign_edit():
    pytest.importorskip("bokeh")
    session, source, checkpoint, delivered = _data_session({"x": [0, 1], "y": [0, 1]})

    session.document.hold()
    source.stream({"x": [2], "y": [2]})
    result = session.apply_patch(
        transaction_id="browser-stream",
        patch={
            "events": [
                {
                    "kind": "ColumnsStreamed",
                    "model": {"id": source.id},
                    "attr": "data",
                    "data": {"x": [3], "y": [3]},
                    "rollover": None,
                }
            ]
        },
    )
    session.document.unhold()

    assert result.delta is not None
    streamed = [e for e in _data_events(delivered) if e["kind"] == "ColumnsStreamed"]
    assert [(e["base_version"], e["new_version"], e.get("echo_of")) for e in streamed] == [
        (0, 1, None),
        (1, 2, 0),
    ]
    replayed = _replayed_source(checkpoint, delivered, source.id)
    assert list(replayed.data["x"]) == list(source.data["x"]) == [0, 1, 2, 3]
    session.close()


@pytest.mark.parametrize("change", ["replace-then-patch", "add-column-then-stream"])
def test_held_replacement_subsumes_held_edits_taken_by_a_foreign_patch(change):
    pytest.importorskip("bokeh")
    session, source, checkpoint, delivered = _data_session(
        {"x": list(range(1000)), "y": list(range(1000))}
    )
    plot = session.roots[0]

    session.document.hold()
    if change == "replace-then-patch":
        source.data = {"x": list(range(1002)), "y": list(range(1002))}
        source.patch({"y": [(1001, 30)]})
    else:
        source.data.update(z=list(range(1000)))
        source.stream({"x": [1000], "y": [1000], "z": [1000]})
    session.apply_patch(patch={"events": [_model_changed(plot.id, "width", 300)]})
    session.document.unhold()

    # As on the plain unhold path: one replacement from current values.
    [event] = [e for e in _data_events(delivered) if e["kind"] != "ColumnsFolded"]
    assert event["kind"] == "ColumnDataChanged"
    assert (event["base_version"], event["new_version"]) == (0, 1)
    replayed = _replayed_source(checkpoint, delivered, source.id)
    assert {name: list(values) for name, values in replayed.data.items()} == {
        name: list(values) for name, values in source.data.items()
    }
    session.close()


def test_hold_released_without_dispatch_still_flushes():
    """Panel's ``_drain_unconnected_events`` clears a hold without ``unhold``."""
    pytest.importorskip("bokeh")

    async def run():
        session, source, _checkpoint, delivered = _data_session({"x": [0], "y": [0]})
        callbacks = session.document.callbacks
        session.document.hold()
        source.stream({"x": [1], "y": [1]})
        await asyncio.sleep(0)
        assert delivered == []
        callbacks._held_events = []
        callbacks._hold = None
        await asyncio.sleep(INLINE_FLUSH_DELAY * 4)
        session.close()
        return delivered

    delivered = asyncio.run(run())
    assert [e["kind"] for e in _data_events(delivered)][:1] == ["ColumnsStreamed"]


def test_close_removes_the_trigger_hook():
    pytest.importorskip("bokeh")
    session, source, _checkpoint, delivered = _data_session({"x": [0], "y": [0]})
    callbacks = session.document.callbacks
    assert "trigger_on_change" in callbacks.__dict__

    session.close()
    source.stream({"x": [1], "y": [1]})

    assert "trigger_on_change" not in callbacks.__dict__
    assert delivered == []


def test_reemitted_browser_edits_are_marked_but_callback_edits_are_not(kernel):
    pytest.importorskip("bokeh")
    from bokeh.document import Document
    from bokeh.models import ColumnDataSource
    from bokeh.plotting import figure

    document = Document()
    browser_source = ColumnDataSource(data={"x": [1], "y": [1]})
    derived_source = ColumnDataSource(data={"x": [1], "y": [1]})
    for source in (browser_source, derived_source):
        plot = figure(width=200, height=200)
        plot.line("x", "y", source=source)
        document.add_root(plot)
    session = BokehDocumentSession(
        document, document.roots, producer_name="test", producer_version="0"
    )
    session_registry.register(session)
    delivered: list[BokehDelta] = []
    session.set_event_sink(delivered.append)

    def follow(attr, old, new):
        derived_source.stream({"x": [new["x"][-1]], "y": [new["y"][-1] * 10]})

    browser_source.on_change("data", follow)

    kernel.dispatch(
        BOKEH_PATCH_REQUEST,
        _patch_request(
            session.session_id,
            "browser-stream",
            [
                {"kind": "MessageSent", "msg_type": "unhandled", "msg_data": None},
                {
                    "kind": "ColumnsStreamed",
                    "model": {"id": browser_source.id},
                    "attr": "data",
                    "data": {"x": [2], "y": [2]},
                    "rollover": None,
                },
            ],
        ),
    )

    assert kernel.replies[0]["content"]["status"] == "ok"
    assert list(derived_source.data["y"]) == [1, 20]
    [delta] = delivered
    assert delta.transaction_id == "browser-stream"
    events = {
        event["source_id"]: event
        for event in delta.data_events
        if event["kind"] == "ColumnsStreamed"
    }
    assert set(events) == {browser_source.id, derived_source.id}
    # The browser applied its own stream; the derived one it has never seen.
    assert events[browser_source.id]["echo_of"] == 1
    assert "echo_of" not in events[derived_source.id]
    assert events[derived_source.id]["data"] == {
        "type": "map",
        "entries": [["x", [2]], ["y", [20]]],
    }
    assert (
        events[derived_source.id]["base_version"],
        events[derived_source.id]["new_version"],
    ) == (
        0,
        1,
    )


# ── Flush timing and the display window ──────────────────────────────────


def _two_widget_session(pn):
    slider = pn.widgets.FloatSlider(start=0, end=10, value=1)
    text = pn.widgets.TextInput(value="a")
    payload, session, delivered = _announced_panel(pn.Row(slider, text))
    return slider, text, payload, session, delivered


def test_changes_in_one_loop_iteration_share_a_delta():
    pn = _load_panel()

    async def change_both():
        slider, text, payload, _session, delivered = _two_widget_session(pn)
        slider.value = 2
        text.value = "b"
        assert delivered == []
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        return payload, slider, text, delivered

    payload, slider, text, delivered = asyncio.run(change_both())
    [delta] = delivered
    assert _values(delta) == {
        _bokeh_model(slider, payload).id: 2,
        _bokeh_model(text, payload).id: "b",
    }


def test_inline_flush_only_once_the_scheduled_flush_has_waited():
    pn = _load_panel()

    async def blocking_cell():
        slider, text, payload, _session, delivered = _two_widget_session(pn)
        slider.value = 2
        # Like a cell that sleeps between updates: the loop never runs.
        time.sleep(INLINE_FLUSH_DELAY + 0.01)
        assert delivered == []
        text.value = "b"
        flushed_while_blocked = list(delivered)
        # The window restarts after an inline flush.
        slider.value = 3
        still_blocked = list(delivered)
        await asyncio.sleep(0)
        return payload, slider, text, flushed_while_blocked, still_blocked, delivered

    payload, slider, text, blocked, still_blocked, delivered = asyncio.run(blocking_cell())
    slider_id = _bokeh_model(slider, payload).id
    text_id = _bokeh_model(text, payload).id
    [first] = blocked
    assert _values(first) == {slider_id: 2, text_id: "b"}
    assert still_blocked == blocked
    assert [_values(delta) for delta in delivered[1:]] == [{slider_id: 3}]


def test_quiet_change_waits_for_the_loop_rather_than_flushing_inline():
    pn = _load_panel()

    async def after_idle():
        slider, _text, payload, _session, delivered = _two_widget_session(pn)
        # Long idle before the change: no flush is scheduled, so none has waited.
        time.sleep(INLINE_FLUSH_DELAY + 0.01)
        slider.value = 4
        before_loop = list(delivered)
        await asyncio.sleep(0)
        return before_loop, delivered

    before_loop, delivered = asyncio.run(after_idle())
    assert before_loop == []
    assert len(delivered) == 1


def test_onload_changes_wait_for_the_display_announcement(monkeypatch):
    pn = _load_panel()
    checkpoint = BokehDocumentSession.checkpoint

    def slow_checkpoint(self):
        time.sleep(INLINE_FLUSH_DELAY + 0.01)  # stands in for a large document
        return checkpoint(self)

    monkeypatch.setattr(BokehDocumentSession, "checkpoint", slow_checkpoint)

    async def cell():
        markdown = pn.pane.Markdown("loading")
        column = pn.Column(markdown)
        mark_loaded = _panel._mark_document_loaded

        def onload(document):
            mark_loaded(document)
            markdown.object = "loaded"  # what an onload callback or defer_load does

        monkeypatch.setattr(_panel, "_mark_document_loaded", onload)
        _ip, data, _metadata = _format_panel(column)
        payload = data[BOKEH_SESSION_MIME]
        session = session_registry.require(payload["session_id"])
        delivered: list[BokehDelta] = []
        session.set_event_sink(delivered.append)
        time.sleep(INLINE_FLUSH_DELAY + 0.01)
        markdown.object = "later"
        await asyncio.sleep(0.05)
        before_announcement = list(delivered)
        session.mark_announced()
        return payload, markdown, before_announcement, delivered

    payload, markdown, before, delivered = asyncio.run(cell())
    markdown_id = _bokeh_model(markdown, payload).id
    assert before == []
    assert "loading" in payload["session_doc"]["models"][markdown_id]["props"]["text"]
    [delta] = delivered
    assert "later" in delta.props_changed[markdown_id]["text"]


def test_announcer_sends_the_display_message_before_any_delta():
    pn = _load_panel()
    wire: list[tuple[str, Any]] = []

    class FakePub:
        def __init__(self):
            self._hooks: list[Any] = []
            self.pub_socket = object()
            self.topic = b"display_data"
            self.session = SimpleNamespace(
                send=lambda _socket, msg, ident=None, buffers=None: wire.append(("display", msg))
            )

        def register_hook(self, hook):
            self._hooks.append(hook)

        def publish(self, msg):
            for hook in self._hooks:
                msg = hook(msg)
                if msg is None:
                    return
            self.session.send(self.pub_socket, msg, ident=self.topic)

    publisher = FakePub()
    sent_by_hook: list[Any] = []

    def sends_itself(msg):
        # Like the buffer hook: send directly and suppress the default send.
        sent_by_hook.append(msg)
        publisher.session.send(publisher.pub_socket, msg, ident=publisher.topic)
        return None

    publisher.register_hook(sends_itself)
    _panel._install_session_announcer(publisher)
    slider = pn.widgets.FloatSlider(start=0, end=10, value=1)
    _ip, data, _metadata = _format_panel(slider)
    session = session_registry.require(data[BOKEH_SESSION_MIME]["session_id"])
    session.set_event_sink(lambda delta: wire.append(("delta", delta)))
    slider.value = 5
    assert wire == []

    publisher.publish({"header": {"msg_type": "display_data"}, "content": {"data": data}})

    assert [kind for kind, _ in wire] == ["display", "delta"]
    assert len(sent_by_hook) == 1
    assert session.announced
    # Other messages pass through untouched.
    other = {"header": {"msg_type": "display_data"}, "content": {"data": {"text/plain": "x"}}}
    publisher.publish(other)
    assert sent_by_hook[-1] is other


# ── Session callbacks ────────────────────────────────────────────────────


def test_session_runs_bokeh_session_callbacks_on_the_kernel_loop():
    pytest.importorskip("bokeh")
    from bokeh.document import Document
    from bokeh.models import Div

    async def schedule():
        document = Document()
        document.add_root(Div(text="root"))
        session = BokehDocumentSession(
            document, document.roots, producer_name="test", producer_version="0"
        )
        ran = []
        document.add_next_tick_callback(lambda: ran.append("next_tick"))
        document.add_timeout_callback(lambda: ran.append("timeout"), 10)
        cancelled = document.add_timeout_callback(lambda: ran.append("cancelled"), 10)
        document.remove_timeout_callback(cancelled)
        await asyncio.sleep(0.1)
        session.close()
        return ran, document.session_callbacks

    ran, remaining = asyncio.run(schedule())
    assert ran == ["next_tick", "timeout"]
    assert not remaining


@pytest.mark.parametrize("operation", ["remove", "close"])
def test_queued_next_tick_callback_observes_cancellation(operation):
    pytest.importorskip("bokeh")
    from bokeh.document import Document
    from tornado.ioloop import IOLoop

    async def schedule():
        document = Document()
        session = BokehDocumentSession(document, [], producer_name="test", producer_version="0")
        ran = []
        cancelled = asyncio.Event()
        callback = document.add_next_tick_callback(lambda: ran.append("unexpected"))

        def cancel():
            if operation == "remove":
                document.remove_next_tick_callback(callback)
            else:
                session.close()
            cancelled.set()

        # The start callback queues invocation before cancellation queues cleanup.
        IOLoop.current().add_callback(cancel)
        try:
            await asyncio.wait_for(cancelled.wait(), timeout=1)
            await asyncio.sleep(0)
            return ran
        finally:
            session.close()

    assert asyncio.run(schedule()) == []


def test_session_created_off_the_kernel_thread_releases_a_threaded_hold(monkeypatch):
    """Panel releases a threaded hold through a next tick callback on the kernel loop."""
    pn = _load_panel()
    from panel.io.document import hold
    from panel.io.state import set_curdoc
    from tornado.ioloop import IOLoop

    slider = pn.widgets.IntSlider(start=0, end=10, value=1)

    async def run():
        loop = IOLoop.current()
        monkeypatch.setattr(_bokeh_session, "_kernel_io_loop", lambda: loop)
        created: dict[str, Any] = {}

        def worker():
            payload, session, delivered = _announced_panel(slider)
            created.update(payload=payload, session=session, delivered=delivered)
            with set_curdoc(session.document), hold(session.document):
                slider.value = 5

        thread = threading.Thread(target=worker, daemon=True)
        thread.start()
        while thread.is_alive():
            await asyncio.sleep(0.01)
        await asyncio.sleep(0.2)
        return created

    created = asyncio.run(run())
    session = created["session"]
    assert not session._held()
    slider_id = _bokeh_model(slider, created["payload"]).id
    assert {slider_id: 5} in [_values(delta) for delta in created["delivered"]]


def test_install_gives_off_thread_sessions_the_kernel_loop():
    kernel = _FakeKernel()
    ip = SimpleNamespace(kernel=kernel)
    loop = object()
    _bokeh_handlers.install_kernel_hooks(ip)
    try:
        kernel.io_loop = loop
        assert _bokeh_session._kernel_io_loop is not None
        assert _bokeh_session._kernel_io_loop() is loop
    finally:
        _bokeh_handlers.uninstall_kernel_hooks(ip)
    assert _bokeh_session._kernel_io_loop is None


def test_uninstall_closes_live_sessions():
    pn = _load_panel()
    slider = pn.widgets.FloatSlider(value=3)
    ip, data, _metadata = _format_panel(slider)
    session_id = data[BOKEH_SESSION_MIME]["session_id"]

    assert session_registry.get(session_id) is not None
    _panel.uninstall(ip)
    assert session_registry.get(session_id) is None


# ── Shell handlers and IOPub publication ─────────────────────────────────


class _FakeKernel:
    """``NteractKernel``'s extension seams over a fake shell table and IOPub socket."""

    register_shell_handler = NteractKernel.register_shell_handler
    iopub_publisher = NteractKernel.iopub_publisher
    send_extension_reply = NteractKernel.send_extension_reply

    def __init__(self):
        from ipykernel.ipkernel import IPythonKernel

        self.replies: list[dict[str, Any]] = []
        self.iopub: list[dict[str, Any]] = []
        self.shell_handlers = {msg_type: Mock() for msg_type in IPythonKernel.msg_types}
        self.log = Mock()
        self.iopub_socket = object()
        self.io_loop: Any = None
        self.session = SimpleNamespace(send=self._send_iopub)

    def _topic(self, msg_type: str) -> bytes:
        return f"kernel.test.{msg_type}".encode()

    def _send_iopub(self, socket, msg_type, content, *, parent, ident, buffers):
        assert socket is self.iopub_socket
        self.iopub.append(
            {
                "msg_type": msg_type,
                "content": content,
                "parent": parent,
                "ident": ident,
                "buffers": buffers,
            }
        )

    def send_response(self, stream, msg_type, **kwargs):
        self.replies.append({"stream": stream, "msg_type": msg_type, **kwargs})

    def dispatch(self, msg_type: str, parent: dict[str, Any], ident: Any = ()):
        # Mirrors Kernel.dispatch_shell's table lookup and call.
        self.shell_handlers[msg_type]("SHELL", list(ident), parent)


@pytest.fixture
def kernel():
    kernel = _FakeKernel()
    ip = SimpleNamespace(kernel=kernel)
    _bokeh_handlers.install_kernel_hooks(ip)
    yield kernel
    _bokeh_handlers.uninstall_kernel_hooks(ip)


def _patch_request(session_id: str, transaction_id: str, events: list[dict[str, Any]]):
    return {
        "content": {
            "schema_version": 1,
            "session_id": session_id,
            "transaction_id": transaction_id,
            "patch": {"events": events},
            "buffers": [],
        },
        "buffers": [],
    }


def test_patch_shell_handler_captures_output_and_publishes_delta(kernel):
    pn = _load_panel()

    source = pn.widgets.FloatSlider(start=0, end=10, value=1)
    target = pn.widgets.FloatSlider(start=0, end=20, value=2)

    def callback(event):
        print(f"source={event.new}")
        target.value = event.new * 2

    source.param.watch(callback, "value")
    _ip, data, _metadata = _format_panel(pn.Row(source, target))
    payload = data[BOKEH_SESSION_MIME]
    session = session_registry.require(payload["session_id"])
    session.mark_announced()
    source_model = _bokeh_model(source, payload)

    kernel.dispatch(
        BOKEH_PATCH_REQUEST,
        _patch_request(session.session_id, "tx-1", [_model_changed(source_model.id, "value", 6)]),
        ident=[b"client"],
    )

    [reply] = kernel.replies
    assert reply["msg_type"] == BOKEH_PATCH_REPLY
    assert reply["ident"] == [b"client"]
    assert reply["content"]["status"] == "ok"
    assert reply["content"]["transaction_id"] == "tx-1"
    assert reply["content"]["stdout"] == "source=6\n"
    assert "revision" not in reply["content"]
    assert target.value == 12
    # The registry's sink is the installed publisher, so the delta is on IOPub.
    [sent] = kernel.iopub
    assert sent["msg_type"] == BOKEH_DELTA
    assert sent["parent"] is None
    assert sent["ident"] == kernel._topic(BOKEH_DELTA)
    assert sent["content"]["transaction_id"] == "tx-1"
    assert sent["content"]["props_changed"] == {_bokeh_model(target, payload).id: {"value": 12}}


def test_patch_shell_handler_corrects_when_apply_patch_raises(kernel, monkeypatch):
    """PR #4437 regression case 1: an edit the kernel never applied must not
    stay in the session document."""
    pn = _load_panel()

    text = pn.widgets.TextInput(value="")
    payload, session, delivered = _announced_panel(pn.Column(text))
    text_model = _bokeh_model(text, payload)

    def reject(**_kwargs):
        raise RuntimeError("rejected by test")

    monkeypatch.setattr(session, "apply_patch", reject)

    kernel.dispatch(
        BOKEH_PATCH_REQUEST,
        _patch_request(
            session.session_id, "tx-rejected", [_model_changed(text_model.id, "value", "edit")]
        ),
    )

    assert kernel.replies[0]["content"]["status"] == "error"
    [delta] = delivered
    assert delta.transaction_id == "tx-rejected"
    assert delta.props_changed == {text_model.id: {"value": ""}}


def test_patch_shell_handler_corrects_when_request_buffers_are_invalid(kernel):
    pn = _load_panel()

    text = pn.widgets.TextInput(value="kept")
    payload, session, delivered = _announced_panel(pn.Column(text))
    text_model = _bokeh_model(text, payload)
    request = _patch_request(
        session.session_id, "tx-bad-buffer", [_model_changed(text_model.id, "value", "edit")]
    )
    request["content"]["buffers"] = [{"id": "b", "buffer_index": 3, "size": 1, "hash": "0"}]

    kernel.dispatch(BOKEH_PATCH_REQUEST, request)

    [reply] = kernel.replies
    assert reply["content"]["status"] == "error"
    assert "out of range" in reply["content"]["error"]["evalue"]
    assert text.value == "kept"
    [delta] = delivered
    assert delta.transaction_id == "tx-bad-buffer"
    assert delta.props_changed == {text_model.id: {"value": "kept"}}


def test_patch_shell_error_reply_carries_no_revision_or_checkpoint(kernel):
    pn = _load_panel()

    slider = pn.widgets.IntSlider(start=0, end=10, value=1)
    payload, session, delivered = _announced_panel(slider)
    slider_model = _bokeh_model(slider, payload)

    kernel.dispatch(
        BOKEH_PATCH_REQUEST,
        _patch_request(
            session.session_id, "tx-error", [_model_changed(slider_model.id, "value", "bad")]
        ),
    )

    [reply] = kernel.replies
    assert reply["msg_type"] == BOKEH_PATCH_REPLY
    assert reply["content"]["status"] == "error"
    assert reply["content"]["transaction_id"] == "tx-error"
    assert "revision" not in reply["content"]
    assert "checkpoint" not in reply["content"]
    assert reply["buffers"] == []
    [delta] = delivered
    assert delta.props_changed == {slider_model.id: {"value": 1}}


def test_patch_request_for_unknown_session_replies_error_without_corrections(kernel):
    kernel.dispatch(
        BOKEH_PATCH_REQUEST,
        _patch_request("missing", "tx-missing", [_model_changed("p1", "value", 1)]),
    )

    [reply] = kernel.replies
    assert reply["content"]["status"] == "error"
    assert reply["content"]["session_id"] == "missing"
    assert kernel.iopub == []


def test_patch_request_buffers_reject_negative_index_and_hash_mismatch():
    descriptor = BokehBuffer("buffer-1", b"payload").descriptor(0)
    descriptor["buffer_index"] = -1
    with pytest.raises(TypeError, match="descriptor"):
        _bokeh_handlers._request_buffers({"buffers": [b"payload"]}, {"buffers": [descriptor]})

    descriptor = BokehBuffer("buffer-1", b"payload").descriptor(0)
    descriptor["hash"] = "0" * 64
    with pytest.raises(ValueError, match="hash mismatch"):
        _bokeh_handlers._request_buffers({"buffers": [b"payload"]}, {"buffers": [descriptor]})


def test_fold_and_close_shell_handlers(kernel):
    session, source, _checkpoint, delivered = _data_session({"x": [1], "y": [2]})
    session_registry.register(session)
    session.set_event_sink(delivered.append)

    kernel.dispatch(
        BOKEH_FOLD_REQUEST,
        {
            "content": {
                "schema_version": 1,
                "session_id": session.session_id,
                "transaction_id": "fold-1",
                "source_ids": [source.id],
            }
        },
    )
    fold_reply = kernel.replies.pop()
    assert fold_reply["msg_type"] == BOKEH_FOLD_REPLY
    assert fold_reply["content"]["status"] == "ok"
    assert fold_reply["content"]["source_ids"] == [source.id]
    assert delivered[-1].transaction_id == "fold-1"
    assert delivered[-1].data_events[0]["kind"] == "ColumnsFolded"

    kernel.dispatch(
        BOKEH_CLOSE_REQUEST,
        {
            "content": {
                "schema_version": 1,
                "session_id": session.session_id,
                "transaction_id": "close-1",
            }
        },
    )
    close_reply = kernel.replies.pop()
    assert close_reply["msg_type"] == BOKEH_CLOSE_REPLY
    assert close_reply["content"]["status"] == "ok"
    assert session_registry.get(session.session_id) is None


def test_fold_request_rejects_non_string_source_ids(kernel):
    kernel.dispatch(
        BOKEH_FOLD_REQUEST,
        {"content": {"schema_version": 1, "session_id": "s", "source_ids": [1]}},
    )

    reply = kernel.replies.pop()
    assert reply["content"]["status"] == "error"
    assert reply["content"]["error"]["ename"] == "TypeError"


@pytest.mark.parametrize(
    ("msg_type", "reply_type", "error_match"),
    [
        (BOKEH_FOLD_REQUEST, BOKEH_FOLD_REPLY, "Unsupported Bokeh fold schema version"),
        (BOKEH_CLOSE_REQUEST, BOKEH_CLOSE_REPLY, "Unsupported Bokeh close schema version"),
        (BOKEH_PATCH_REQUEST, BOKEH_PATCH_REPLY, "Unsupported Bokeh patch schema version"),
    ],
)
def test_handlers_reject_unsupported_schema(kernel, msg_type, reply_type, error_match):
    kernel.dispatch(
        msg_type,
        {
            "content": {
                "schema_version": 999,
                "session_id": "session-1",
                "transaction_id": "transaction-1",
            }
        },
    )

    reply = kernel.replies.pop()
    assert reply["msg_type"] == reply_type
    assert reply["content"]["status"] == "error"
    assert reply["content"]["transaction_id"] == "transaction-1"
    assert reply["content"]["error"]["evalue"] == error_match


def test_wire_delta_has_the_apply_delta_field_names_and_indexed_buffers():
    delta = BokehDelta(
        session_id="session-1",
        transaction_id="tx-1",
        models_added={"p2": {"type": "Div", "ref_props": ["tags"], "props": {"text": "hi"}}},
        props_changed={"p1": {"children": [{"id": "p2"}]}},
        models_removed=["p0"],
        data_events=[{"kind": "ColumnsStreamed", "source_id": "p3"}],
        buffers=(BokehBuffer("a", b"one"), BokehBuffer("b", b"two")),
    )

    content, buffers = _bokeh_handlers.wire_bokeh_delta(delta)

    assert content["schema_version"] == 1
    assert {
        "schema_version",
        "session_id",
        "transaction_id",
        "models_added",
        "props_changed",
        "models_removed",
        "data_events",
        "messages",
        "buffers",
    } == set(content)
    assert content["models_added"]["p2"]["ref_props"] == ["tags"]
    assert [b["buffer_index"] for b in content["buffers"]] == [0, 1]
    assert [b["id"] for b in content["buffers"]] == ["a", "b"]
    assert buffers == [b"one", b"two"]


def test_install_registers_patch_fold_and_close_and_a_live_sink():
    kernel = _FakeKernel()
    ip = SimpleNamespace(kernel=kernel)
    session_registry.set_event_sink(None)

    _bokeh_handlers.install_kernel_hooks(ip)
    try:
        assert {BOKEH_PATCH_REQUEST, BOKEH_FOLD_REQUEST, BOKEH_CLOSE_REQUEST} <= set(
            kernel.shell_handlers
        )
        assert "nteract_bokeh_checkpoint_request" not in kernel.shell_handlers
        assert session_registry.live
    finally:
        _bokeh_handlers.uninstall_kernel_hooks(ip)

    assert not set(_bokeh_handlers.SHELL_HANDLERS) & set(kernel.shell_handlers)
    assert not session_registry.live


def test_uninstall_closes_the_delta_publisher():
    kernel = _FakeKernel()
    ip = SimpleNamespace(kernel=kernel)
    _bokeh_handlers.install_kernel_hooks(ip)
    publish = session_registry._event_sink
    assert publish is not None
    _bokeh_handlers.uninstall_kernel_hooks(ip)

    publish(BokehDelta(session_id="late", transaction_id="tx"))

    assert kernel.iopub == []


# ── Static fallback when live sessions are unavailable ───────────────────


def test_panel_output_is_static_without_a_live_sink():
    pn = _load_panel()
    session_registry.set_event_sink(None)
    slider = pn.widgets.FloatSlider(start=0, end=10, value=3)

    _ip, data, metadata = _format_panel(slider)

    payload = data[BOKEH_SESSION_MIME]
    assert payload["document"]["roots"]
    assert "session_doc" not in payload
    assert "session_doc_buffers" not in payload
    assert metadata[BOKEH_SESSION_MIME]["session_id"] == payload["session_id"]
    assert session_registry.get(payload["session_id"]) is None
    assert len(session_registry) == 0
    # The closed session ran Panel's cleanup, so later changes go nowhere.
    slider.value = 7
    assert payload["root_ids"][0] not in slider._models


def test_failed_handler_install_renders_panel_outputs_static():
    pn = _load_panel()
    session_registry.set_event_sink(None)
    kernel = _FakeKernel()
    taken = Mock()
    kernel.register_shell_handler(BOKEH_CLOSE_REQUEST, taken)

    with pytest.raises(ValueError, match=BOKEH_CLOSE_REQUEST):
        _bokeh_handlers.install_kernel_hooks(SimpleNamespace(kernel=kernel))

    assert BOKEH_PATCH_REQUEST not in kernel.shell_handlers
    assert BOKEH_FOLD_REQUEST not in kernel.shell_handlers
    assert kernel.shell_handlers[BOKEH_CLOSE_REQUEST] is taken
    assert not session_registry.live
    _ip, data, _metadata = _format_panel(pn.widgets.TextInput(value="x"))
    assert "session_doc" not in data[BOKEH_SESSION_MIME]
    assert len(session_registry) == 0


def test_bootstrap_step_failure_leaves_panel_outputs_static(monkeypatch):
    pn = _load_panel()
    from nteract_kernel_launcher import _bootstrap

    session_registry.set_event_sink(None)
    kernel = _FakeKernel()

    def fail(_msg_type, _encode):
        raise RuntimeError("no IOPub")

    monkeypatch.setattr(kernel, "iopub_publisher", fail)
    display_formatter = DisplayFormatter()
    ip = SimpleNamespace(kernel=kernel, display_formatter=display_formatter)

    # Each step's failure is logged; the Panel formatter is still installed.
    _bootstrap.load_ipython_extension(ip)
    try:
        assert not set(_bokeh_handlers.SHELL_HANDLERS) & set(kernel.shell_handlers)
        data, _metadata = display_formatter.format(pn.widgets.TextInput(value="x"))
        assert "session_doc" not in data[BOKEH_SESSION_MIME]
        assert len(session_registry) == 0
    finally:
        _bootstrap.unload_ipython_extension(ip)
