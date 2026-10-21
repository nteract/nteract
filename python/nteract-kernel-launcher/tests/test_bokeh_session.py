from __future__ import annotations

import asyncio
import sys
import threading
import time
from collections import deque
from types import SimpleNamespace
from typing import Any, cast
from unittest.mock import Mock

import pytest
from IPython.core.formatters import DisplayFormatter
from nteract_kernel_launcher import _bokeh_session, _buffer_hook, _panel
from nteract_kernel_launcher._bokeh_session import (
    BOKEH_SESSION_MIME,
    INLINE_FLUSH_DELAY,
    BokehBuffer,
    BokehDelta,
    BokehDocumentSession,
    BokehPatchApplyError,
    ref_props,
    session_registry,
)
from nteract_kernel_launcher._refs import BLOB_REF_MIME


@pytest.fixture(autouse=True)
def clear_bokeh_sessions():
    session_registry.set_event_sink(None)
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

    assert session.fold(transaction_id="fold-1") == [source.id]
    assert delivered[-1].transaction_id == "fold-1"
    assert delivered[-1].data_events[0]["kind"] == "ColumnsFolded"
    # Nothing left to fold unless a source is named explicitly.
    assert session.fold() == []
    assert session.fold([source.id, "missing"]) == [source.id]
    session.close()


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
    def __init__(self):
        self.replies = []
        self.log = Mock()

    def send_response(self, stream, msg_type, **kwargs):
        self.replies.append({"stream": stream, "msg_type": msg_type, **kwargs})


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


def test_patch_shell_handler_captures_output_and_publishes_delta():
    pn = _load_panel()
    from nteract_kernel_launcher.app import _BOKEH_PATCH_REPLY, NteractKernel

    source = pn.widgets.FloatSlider(start=0, end=10, value=1)
    target = pn.widgets.FloatSlider(start=0, end=20, value=2)

    def callback(event):
        print(f"source={event.new}")
        target.value = event.new * 2

    source.param.watch(callback, "value")
    payload, session, delivered = _announced_panel(pn.Row(source, target))
    source_model = _bokeh_model(source, payload)
    kernel = _FakeKernel()

    NteractKernel.nteract_bokeh_patch_request(
        cast(Any, kernel),
        "SHELL",
        [b"client"],
        _patch_request(session.session_id, "tx-1", [_model_changed(source_model.id, "value", 6)]),
    )

    [reply] = kernel.replies
    assert reply["msg_type"] == _BOKEH_PATCH_REPLY
    assert reply["content"]["status"] == "ok"
    assert reply["content"]["transaction_id"] == "tx-1"
    assert reply["content"]["stdout"] == "source=6\n"
    assert "revision" not in reply["content"]
    assert target.value == 12
    [delta] = delivered
    assert delta.transaction_id == "tx-1"
    assert delta.props_changed == {_bokeh_model(target, payload).id: {"value": 12}}


def test_patch_shell_handler_corrects_when_apply_patch_raises(monkeypatch):
    """PR #4437 regression case 1: an edit the kernel never applied must not
    stay in the session document."""
    pn = _load_panel()
    from nteract_kernel_launcher.app import NteractKernel

    text = pn.widgets.TextInput(value="")
    payload, session, delivered = _announced_panel(pn.Column(text))
    text_model = _bokeh_model(text, payload)

    def reject(**_kwargs):
        raise RuntimeError("rejected by test")

    monkeypatch.setattr(session, "apply_patch", reject)
    kernel = _FakeKernel()

    NteractKernel.nteract_bokeh_patch_request(
        cast(Any, kernel),
        "SHELL",
        [b"client"],
        _patch_request(
            session.session_id, "tx-rejected", [_model_changed(text_model.id, "value", "edit")]
        ),
    )

    assert kernel.replies[0]["content"]["status"] == "error"
    [delta] = delivered
    assert delta.transaction_id == "tx-rejected"
    assert delta.props_changed == {text_model.id: {"value": ""}}


def test_patch_shell_error_reply_carries_no_revision_or_checkpoint():
    pn = _load_panel()
    from nteract_kernel_launcher.app import _BOKEH_PATCH_REPLY, NteractKernel

    slider = pn.widgets.IntSlider(start=0, end=10, value=1)
    payload, session, delivered = _announced_panel(slider)
    slider_model = _bokeh_model(slider, payload)
    kernel = _FakeKernel()

    NteractKernel.nteract_bokeh_patch_request(
        cast(Any, kernel),
        "SHELL",
        [b"client"],
        _patch_request(
            session.session_id, "tx-error", [_model_changed(slider_model.id, "value", "bad")]
        ),
    )

    [reply] = kernel.replies
    assert reply["msg_type"] == _BOKEH_PATCH_REPLY
    assert reply["content"]["status"] == "error"
    assert reply["content"]["transaction_id"] == "tx-error"
    assert "revision" not in reply["content"]
    assert "checkpoint" not in reply["content"]
    assert reply["buffers"] == []
    [delta] = delivered
    assert delta.props_changed == {slider_model.id: {"value": 1}}


def test_patch_request_buffers_reject_negative_index_and_hash_mismatch():
    from nteract_kernel_launcher.app import _request_buffers

    descriptor = BokehBuffer("buffer-1", b"payload").descriptor(0)
    descriptor["buffer_index"] = -1
    with pytest.raises(TypeError, match="descriptor"):
        _request_buffers({"buffers": [b"payload"]}, {"buffers": [descriptor]})

    descriptor = BokehBuffer("buffer-1", b"payload").descriptor(0)
    descriptor["hash"] = "0" * 64
    with pytest.raises(ValueError, match="hash mismatch"):
        _request_buffers({"buffers": [b"payload"]}, {"buffers": [descriptor]})


def test_fold_and_close_shell_handlers():
    from nteract_kernel_launcher.app import _BOKEH_CLOSE_REPLY, _BOKEH_FOLD_REPLY, NteractKernel

    session, source, _checkpoint, delivered = _data_session({"x": [1], "y": [2]})
    session_registry.register(session)
    session.set_event_sink(delivered.append)
    kernel = _FakeKernel()

    NteractKernel.nteract_bokeh_fold_request(
        cast(Any, kernel),
        "SHELL",
        [],
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
    assert fold_reply["msg_type"] == _BOKEH_FOLD_REPLY
    assert fold_reply["content"]["status"] == "ok"
    assert fold_reply["content"]["source_ids"] == [source.id]
    assert delivered[-1].transaction_id == "fold-1"
    assert delivered[-1].data_events[0]["kind"] == "ColumnsFolded"

    NteractKernel.nteract_bokeh_close_request(
        cast(Any, kernel),
        "SHELL",
        [],
        {
            "content": {
                "schema_version": 1,
                "session_id": session.session_id,
                "transaction_id": "close-1",
            }
        },
    )
    close_reply = kernel.replies.pop()
    assert close_reply["msg_type"] == _BOKEH_CLOSE_REPLY
    assert close_reply["content"]["status"] == "ok"
    assert session_registry.get(session.session_id) is None


@pytest.mark.parametrize(
    ("handler_name", "reply_type", "error_match"),
    [
        (
            "nteract_bokeh_fold_request",
            "nteract_bokeh_fold_reply",
            "Unsupported Bokeh fold schema version",
        ),
        (
            "nteract_bokeh_close_request",
            "nteract_bokeh_close_reply",
            "Unsupported Bokeh close schema version",
        ),
    ],
)
def test_fold_and_close_handlers_reject_unsupported_schema(handler_name, reply_type, error_match):
    from nteract_kernel_launcher.app import NteractKernel

    kernel = _FakeKernel()

    getattr(NteractKernel, handler_name)(
        cast(Any, kernel),
        "SHELL",
        [],
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
    assert reply["content"]["error"]["evalue"] == error_match


def test_wire_delta_has_the_apply_delta_field_names_and_indexed_buffers():
    from nteract_kernel_launcher.app import _wire_bokeh_delta

    delta = BokehDelta(
        session_id="session-1",
        transaction_id="tx-1",
        models_added={"p2": {"type": "Div", "ref_props": ["tags"], "props": {"text": "hi"}}},
        props_changed={"p1": {"children": [{"id": "p2"}]}},
        models_removed=["p0"],
        data_events=[{"kind": "ColumnsStreamed", "source_id": "p3"}],
        buffers=(BokehBuffer("a", b"one"), BokehBuffer("b", b"two")),
    )

    content, buffers = _wire_bokeh_delta(delta)

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


def _delta(name: str) -> BokehDelta:
    return BokehDelta(session_id=name, transaction_id=f"tx-{name}")


def _publishing_kernel(send):
    import nteract_kernel_launcher.app as app

    kernel = SimpleNamespace(
        _bokeh_event_lock=threading.Lock(),
        _bokeh_event_queue=deque(),
        session=SimpleNamespace(send=send),
        iopub_socket=object(),
        log=Mock(),
        _topic=lambda msg_type: msg_type,
    )
    kernel._publish_bokeh_events = lambda: app.NteractKernel._publish_bokeh_events(
        cast(Any, kernel)
    )
    return kernel


def test_bokeh_delta_publication_discards_unserializable_delta_and_continues(monkeypatch):
    import nteract_kernel_launcher.app as app

    bad, good = _delta("bad"), _delta("good")
    wire_delta = app._wire_bokeh_delta

    def fail_one(delta):
        if delta is bad:
            raise ValueError("malformed delta")
        return wire_delta(delta)

    monkeypatch.setattr(app, "_wire_bokeh_delta", fail_one)
    send = Mock()
    kernel = _publishing_kernel(send)
    kernel._bokeh_event_queue.extend([bad, good])

    app.NteractKernel._publish_bokeh_events(cast(Any, kernel))

    assert list(kernel._bokeh_event_queue) == []
    kernel.log.exception.assert_called_once_with(
        "Could not serialize Bokeh session delta; dropping it"
    )
    send.assert_called_once()
    assert send.call_args.args[1] == app._BOKEH_DELTA
    assert send.call_args.args[2]["session_id"] == "good"


def test_bokeh_deltas_publish_on_the_calling_thread_without_the_io_loop():
    import nteract_kernel_launcher.app as app

    send = Mock()
    # No io_loop attribute: publication must not depend on the kernel loop.
    kernel = _publishing_kernel(send)

    app.NteractKernel._enqueue_bokeh_event(cast(Any, kernel), _delta("one"))
    app.NteractKernel._enqueue_bokeh_event(cast(Any, kernel), _delta("two"))

    assert [call.args[2]["session_id"] for call in send.call_args_list] == ["one", "two"]
    assert list(kernel._bokeh_event_queue) == []


def test_failed_bokeh_publication_is_retried_before_the_next_delta():
    import nteract_kernel_launcher.app as app

    send = Mock(side_effect=[OSError("socket busy"), None, None])
    kernel = _publishing_kernel(send)

    app.NteractKernel._enqueue_bokeh_event(cast(Any, kernel), _delta("one"))
    assert [delta.session_id for delta in kernel._bokeh_event_queue] == ["one"]

    app.NteractKernel._enqueue_bokeh_event(cast(Any, kernel), _delta("two"))

    assert [call.args[2]["session_id"] for call in send.call_args_list] == ["one", "one", "two"]
    assert list(kernel._bokeh_event_queue) == []


def test_nteract_kernel_registers_bokeh_shell_messages():
    from nteract_kernel_launcher.app import (
        _BOKEH_CLOSE_REQUEST,
        _BOKEH_FOLD_REQUEST,
        _BOKEH_PATCH_REQUEST,
        NteractKernel,
    )

    assert _BOKEH_PATCH_REQUEST in NteractKernel.msg_types
    assert _BOKEH_FOLD_REQUEST in NteractKernel.msg_types
    assert _BOKEH_CLOSE_REQUEST in NteractKernel.msg_types
    assert "nteract_bokeh_checkpoint_request" not in NteractKernel.msg_types
