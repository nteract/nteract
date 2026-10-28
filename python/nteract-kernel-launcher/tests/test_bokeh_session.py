from __future__ import annotations

import asyncio
import sys
import threading
from collections import deque
from types import SimpleNamespace
from typing import Any, cast
from unittest.mock import Mock

import pytest
from IPython.core.formatters import DisplayFormatter
from nteract_kernel_launcher import _buffer_hook, _panel
from nteract_kernel_launcher._bokeh_session import (
    BOKEH_SESSION_MIME,
    BokehBuffer,
    BokehDocumentSession,
    BokehPatchApplyError,
    BokehSerialization,
    BokehServerEvent,
    StaleBokehRevisionError,
    _replayable_client_patch,
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

    for publisher in (ip.display_pub, ip.displayhook):
        assert len(publisher._hooks) == 2
        assert getattr(publisher._hooks[0], "_nteract_panel_bootstrap_filter", False)
        assert publisher._hooks[1] is _buffer_hook.buffer_hook


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
    assert payload["revision"] == 0
    assert payload["producer"] == {"name": "panel", "version": pn.__version__}
    assert payload["document"]["version"] == payload["bokeh_version"]
    assert payload["root_ids"] == [payload["document"]["roots"][0]["id"]]
    assert metadata[BOKEH_SESSION_MIME] == {
        "session_id": payload["session_id"],
        "isolated": True,
    }

    javascript_urls = [
        entry["url"] for entry in payload["resources"]["javascript"] if entry["kind"] == "url"
    ]
    assert any("bokeh-widgets" in url for url in javascript_urls)
    assert any(url.endswith("/panel.min.js") for url in javascript_urls)

    session = session_registry.require(payload["session_id"])
    assert session.document is not None
    root_id = payload["root_ids"][0]
    assert state._views[root_id][3] is None


def test_panel_formatter_stashes_bokeh_binary_buffers():
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
    assert [buffer["id"] for buffer in payload["buffers"]]
    assert [buffer["buffer_index"] for buffer in payload["buffers"]] == [0, 1]
    assert [ref["buffer_index"] for ref in refs] == [0, 1]
    assert refs[0]["hash"] == refs[1]["hash"]
    assert refs[0]["hash"] in _buffer_hook.pending_buffers()


def test_replayable_client_patch_excludes_ephemeral_messages():
    model_event = {
        "kind": "ModelChanged",
        "model": {"id": "p1001"},
        "attr": "value",
        "new": 5,
    }
    message_event = {
        "kind": "MessageSent",
        "msg_type": "bokeh_event",
        "msg_data": {"type": "event", "name": "button_click", "values": {}},
    }

    replayable = _replayable_client_patch(
        {"events": [message_event, model_event]},
        [BokehBuffer(id="buffer-1", data=b"payload")],
    )

    assert replayable is not None
    assert replayable.content == {"events": [model_event]}
    assert [buffer.id for buffer in replayable.buffers] == ["buffer-1"]
    assert _replayable_client_patch({"events": [message_event]}, []) is None


def test_panel_patch_runs_python_callback_and_returns_only_derived_events():
    pn = _load_panel()

    source = pn.widgets.FloatSlider(label="source", start=0, end=10, value=1)
    target = pn.widgets.FloatSlider(label="target", start=0, end=20, value=2)
    source.param.watch(lambda event: setattr(target, "value", event.new * 2), "value")
    layout = pn.Row(source, target)

    _ip, data, _metadata = _format_panel(layout)
    payload = data[BOKEH_SESSION_MIME]
    session = session_registry.require(payload["session_id"])
    root_id = payload["root_ids"][0]
    source_model = source._models[root_id][0]
    target_model = target._models[root_id][0]

    result = session.apply_patch(
        base_revision=0,
        transaction_id="interaction-1",
        patch={
            "events": [
                {
                    "kind": "ModelChanged",
                    "model": {"id": source_model.id},
                    "attr": "value",
                    "new": 5,
                }
            ]
        },
    )

    assert source.value == 5
    assert target.value == 10
    assert result.transaction_id == "interaction-1"
    assert result.revision == 1
    assert result.derived is not None
    events = result.derived.content["events"]
    assert [event["model"]["id"] for event in events] == [target_model.id]
    assert events[0]["new"] == 10

    with pytest.raises(StaleBokehRevisionError) as error:
        session.apply_patch(base_revision=2, patch={"events": []})
    assert error.value.actual == 1


def test_patch_against_older_revision_is_rebased_onto_python_changes():
    """A browser patch racing Python-side updates applies on top of them, as
    on a Bokeh server, instead of forcing the browser to resync."""
    pn = _load_panel()

    slider = pn.widgets.FloatSlider(start=0, end=10, value=1)
    text = pn.widgets.TextInput(value="a")
    layout = pn.Row(slider, text)
    _ip, data, _metadata = _format_panel(layout)
    payload = data[BOKEH_SESSION_MIME]
    session = session_registry.require(payload["session_id"])
    root_id = payload["root_ids"][0]
    slider_model = slider._models[root_id][0]
    text_model = text._models[root_id][0]

    text.value = "b"
    slider.value = 2
    python_events = session.pop_server_events()
    # Panel can update additional properties (e.g. TextInput.value_input)
    # for one Python assignment. Every emitted revision must remain ordered,
    # and both requested property changes must reach the browser.
    assert [(event.base_revision, event.revision) for event in python_events] == [
        (revision - 1, revision) for revision in range(1, len(python_events) + 1)
    ]
    changes = {
        (change["model"]["id"], change["attr"]): change["new"]
        for event in python_events
        if event.server_patch is not None
        for change in event.server_patch.content["events"]
        if change["kind"] == "ModelChanged"
    }
    assert changes[(text_model.id, "value")] == "b"
    assert changes[(slider_model.id, "value")] == 2
    latest_revision = python_events[-1].revision
    assert session.revision == latest_revision

    result = session.apply_patch(
        base_revision=0,
        transaction_id="layout-1",
        patch={
            "events": [
                {
                    "kind": "ModelChanged",
                    "model": {"id": slider_model.id},
                    "attr": "value",
                    "new": 5,
                }
            ]
        },
    )

    assert slider.value == 5
    assert text.value == "b"
    assert (result.base_revision, result.revision) == (latest_revision, latest_revision + 1)
    [event] = session.pop_server_events()
    assert (event.transaction_id, event.base_revision, event.revision) == (
        "layout-1",
        latest_revision,
        latest_revision + 1,
    )
    assert event.client_patch is not None


def _coalescing_session(pn):
    slider = pn.widgets.FloatSlider(start=0, end=10, value=1)
    text = pn.widgets.TextInput(value="a")
    _ip, data, _metadata = _format_panel(pn.Row(slider, text))
    session = session_registry.require(data[BOKEH_SESSION_MIME]["session_id"])
    delivered: list[Any] = []
    session.set_event_sink(delivered.append)
    return slider, text, session, delivered


def test_python_changes_in_one_loop_iteration_share_a_revision():
    pn = _load_panel()

    async def change_both():
        slider, text, session, delivered = _coalescing_session(pn)
        root_id = session.root_ids[0]
        slider_model = slider._models[root_id][0]
        text_model = text._models[root_id][0]
        slider.value = 2
        text.value = "b"
        assert delivered == []
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        return delivered, slider_model.id, text_model.id

    [event], slider_id, text_id = asyncio.run(change_both())
    assert (event.base_revision, event.revision) == (0, 1)
    assert event.server_patch is not None
    changes = {
        (change["model"]["id"], change["attr"]): change["new"]
        for change in event.server_patch.content["events"]
        if change["kind"] == "ModelChanged"
    }
    assert changes[(slider_id, "value")] == 2
    assert changes[(text_id, "value")] == "b"


@pytest.mark.parametrize("transaction", [False, True], ids=["loop", "transaction"])
@pytest.mark.parametrize("nested", [False, True], ids=["root", "layout-child"])
@pytest.mark.parametrize("binary", [False, True], ids=["lists", "buffers"])
def test_new_models_replay_streams_once(nested, binary, transaction):
    pytest.importorskip("bokeh")

    from bokeh.core.serialization import Buffer, Serialized
    from bokeh.core.types import ID
    from bokeh.document import Document
    from bokeh.document.json import DocJson, PatchJson
    from bokeh.models import ColumnDataSource, Div, Row
    from bokeh.plotting import figure

    np = pytest.importorskip("numpy")

    def values(items):
        return np.array(items, dtype=np.float64) if binary else items

    async def change_and_replay():
        document = Document()
        root = Row(children=[]) if nested else Div(text="existing root")
        document.add_root(root)
        session = BokehDocumentSession(
            document, document.roots, producer_name="test", producer_version="0"
        )
        try:
            replica = Document.from_json(cast(DocJson, session.snapshot().content))
            source = ColumnDataSource(data={"x": values([1, 2]), "y": values([1, 2])})

            def add_and_stream():
                if nested:
                    plot = figure()
                    plot.line("x", "y", source=source)
                    root.children = [plot]
                else:
                    document.add_root(source)
                source.stream({"x": values([3]), "y": values([3])})

            if transaction:
                root.on_change("name", lambda attr, old, new: add_and_stream())
                client_patch = {
                    "events": [
                        {
                            "kind": "ModelChanged",
                            "model": {"id": root.id},
                            "attr": "name",
                            "new": "add source",
                        }
                    ]
                }
                result = session.apply_patch(
                    base_revision=0, transaction_id="add-and-stream", patch=client_patch
                )
                assert (result.base_revision, result.revision) == (0, 1)
                assert result.transaction_id == "add-and-stream"
                replica.apply_json_patch(cast(PatchJson, client_patch))
            else:
                add_and_stream()
            await asyncio.sleep(0)
            await asyncio.sleep(0)

            [event] = session.pop_server_events()
            assert (event.base_revision, event.revision) == (0, 1)
            patch = event.server_patch
            if transaction:
                assert event.transaction_id == result.transaction_id
                assert patch is result.derived
                assert event.client_patch is not None
                assert event.client_patch.content == client_patch
            else:
                assert event.client_patch is None
            assert patch is not None
            assert len(patch.content["events"]) == 2
            assert bool(patch.buffers) == binary
            if binary:
                # Equal payloads keep distinct Bokeh IDs across both events.
                assert len({buffer.id for buffer in patch.buffers}) == 4
                assert [buffer.data for buffer in patch.buffers] == [
                    values([1, 2]).tobytes(),
                    values([1, 2]).tobytes(),
                    values([3]).tobytes(),
                    values([3]).tobytes(),
                ]
            replica.apply_json_patch(
                Serialized(
                    content=cast(PatchJson, patch.content),
                    buffers=[Buffer(ID(buffer.id), buffer.data) for buffer in patch.buffers],
                )
            )
            replayed = replica.get_model_by_id(source.id)
            assert replayed is not None
            assert list(replayed.data["x"]) == list(source.data["x"]) == [1, 2, 3]
            assert list(replayed.data["y"]) == list(source.data["y"]) == [1, 2, 3]
        finally:
            session.close()

    asyncio.run(change_and_replay())


@pytest.mark.parametrize("nested", [False, True], ids=["root", "property"])
@pytest.mark.parametrize("binary", [False, True], ids=["lists", "buffers"])
def test_callback_references_client_created_models_without_redefining_them(nested, binary):
    pytest.importorskip("bokeh")
    from bokeh.core.serialization import Serialized, Serializer
    from bokeh.document import Document
    from bokeh.models import ColumnDataSource, CustomJS
    from nteract_kernel_launcher._bokeh_session import _serialize_bokeh_value

    np = pytest.importorskip("numpy")
    document = Document()
    holder = CustomJS(code="")
    trigger = CustomJS(code="")
    document.add_root(holder)
    document.add_root(trigger)
    session = BokehDocumentSession(
        document, document.roots, producer_name="test", producer_version="0"
    )
    source = ColumnDataSource(data={"x": np.array([1, 2], dtype="float64") if binary else [1, 2]})

    def stream_and_reference(model):
        model.stream({"x": np.array([3], dtype="float64") if binary else [3]})
        holder.args = {"source": model}

    if nested:
        trigger.on_change("args", lambda attr, old, new: stream_and_reference(new["source"]))
    else:

        def on_root(event):
            if event.kind == "RootAdded" and event.model.id == source.id:
                stream_and_reference(event.model)

        document.on_change(on_root)

    try:
        session.snapshot()
        serializer = Serializer(deferred=True)
        if nested:
            client_event = {
                "kind": "ModelChanged",
                "model": {"id": trigger.id},
                "attr": "args",
                "new": serializer.encode({"source": source}),
            }
        else:
            client_event = {"kind": "RootAdded", "model": serializer.encode(source)}
        client = _serialize_bokeh_value(
            Serialized(content={"events": [client_event]}, buffers=serializer.buffers)
        )
        result = session.apply_patch(
            base_revision=0,
            transaction_id="client-source",
            patch=client.content,
            buffers=client.buffers,
        )
        assert result.derived is not None
        stream, reference = result.derived.content["events"]
        assert stream["kind"] == "ColumnsStreamed"
        # BokehJS decodes every definition before applying any event. Redefining
        # this client model with its already-streamed data would append the row twice.
        assert reference["new"]["entries"] == [["source", {"id": source.id}]]
        assert list(holder.args["source"].data["x"]) == [1, 2, 3]
        assert len(result.derived.buffers) == (1 if binary else 0)
        [event] = session.pop_server_events()
        assert (event.transaction_id, event.base_revision, event.revision) == (
            "client-source",
            0,
            1,
        )
        assert event.client_patch is not None
        assert event.client_patch.buffers == client.buffers
    finally:
        session.close()


@pytest.mark.parametrize("binary", [False, True], ids=["lists", "buffers"])
def test_message_callback_defines_models_for_peers_without_replaying_the_message(binary):
    pytest.importorskip("bokeh")
    from bokeh.core.serialization import Buffer, Serialized, Serializer
    from bokeh.core.types import ID
    from bokeh.document import Document
    from bokeh.document.json import DocJson, PatchJson
    from bokeh.models import ColumnDataSource
    from nteract_kernel_launcher._bokeh_session import _serialize_bokeh_value

    np = pytest.importorskip("numpy")
    document = Document()
    session = BokehDocumentSession(
        document, document.roots, producer_name="test", producer_version="0"
    )
    try:
        replica = Document.from_json(cast(DocJson, session.snapshot().content))
        source = ColumnDataSource(data={"x": np.array([1, 2]) if binary else [1, 2]})
        document.callbacks.on_message("attach-source", document.add_root)
        serializer = Serializer(deferred=True)
        client = _serialize_bokeh_value(
            Serialized(
                content={
                    "events": [
                        {
                            "kind": "MessageSent",
                            "msg_type": "attach-source",
                            "msg_data": serializer.encode(source),
                        }
                    ]
                },
                buffers=serializer.buffers,
            )
        )
        result = session.apply_patch(
            base_revision=0,
            transaction_id="message-source",
            patch=client.content,
            buffers=client.buffers,
        )
        [event] = session.pop_server_events()
        assert event.client_patch is None
        assert event.server_patch is result.derived
        assert event.server_patch is not None
        assert (event.base_revision, event.revision) == (0, 1)
        replica.apply_json_patch(
            Serialized(
                content=cast(PatchJson, event.server_patch.content),
                buffers=[
                    Buffer(ID(buffer.id), buffer.data) for buffer in event.server_patch.buffers
                ],
            )
        )
        replayed = replica.get_model_by_id(source.id)
        assert replayed is not None
        assert list(replayed.data["x"]) == [1, 2]
    finally:
        session.close()


@pytest.mark.parametrize("failure", ["callback", "serialization"])
def test_failed_transaction_discards_partial_patches_and_recovers(failure):
    pytest.importorskip("bokeh")
    from bokeh.document import Document
    from bokeh.document.json import DocJson, PatchJson
    from bokeh.models import ColumnDataSource, Range1d

    document = Document()
    root = Range1d(start=0, end=1)
    document.add_root(root)
    source = ColumnDataSource(data={"x": [1, 2]})

    def fail_serialization(events):
        if failure == "serialization" and events[0].kind == "ColumnsStreamed":
            raise ValueError("cannot serialize stream")

    session = BokehDocumentSession(
        document,
        document.roots,
        producer_name="test",
        producer_version="0",
        event_transform=fail_serialization,
    )

    def add_stream_and_fail(attr, old, new):
        document.add_root(source)
        source.stream({"x": [3]})
        raise ValueError("callback failed after stream")

    root.on_change("start", add_stream_and_fail)
    try:
        session.snapshot()
        with pytest.raises(BokehPatchApplyError) as error:
            session.apply_patch(
                base_revision=0,
                transaction_id="failed-stream",
                patch={
                    "events": [
                        {
                            "kind": "ModelChanged",
                            "model": {"id": root.id},
                            "attr": "start",
                            "new": 1,
                        }
                    ]
                },
            )
        assert error.value.revision == 1
        [failed_event] = session.pop_server_events()
        assert (failed_event.base_revision, failed_event.revision) == (0, 1)
        assert failed_event.transaction_id == "failed-stream"
        assert failed_event.client_patch is failed_event.server_patch is None
        assert failed_event.checkpoint is error.value.checkpoint
        replica = Document.from_json(cast(DocJson, error.value.checkpoint.content))
        replayed = replica.get_model_by_id(source.id)
        assert replayed is not None
        assert list(replayed.data["x"]) == [1, 2, 3]

        # A later successful transaction is acknowledged without stale derived events.
        result = session.apply_patch(base_revision=1, transaction_id="next", patch={"events": []})
        assert (result.base_revision, result.revision) == (1, 2)
        assert result.derived is None
        [next_event] = session.pop_server_events()
        assert next_event.transaction_id == "next"
        assert next_event.server_patch is next_event.checkpoint is None

        # Callback state was cleared and checkpoint model references remain usable.
        source.name = "recovered"
        [event] = session.pop_server_events()
        assert (event.base_revision, event.revision) == (2, 3)
        assert event.server_patch is not None
        replica.apply_json_patch(cast(PatchJson, event.server_patch.content))
        assert replayed.name == "recovered"
    finally:
        session.close()


def test_checkpoint_includes_changes_still_waiting_for_the_loop():
    pn = _load_panel()

    async def checkpoint_before_flush():
        slider, _text, session, delivered = _coalescing_session(pn)
        slider.value = 4
        revision, snapshot = session.checkpoint()
        return revision, snapshot, delivered

    revision, snapshot, delivered = asyncio.run(checkpoint_before_flush())
    assert revision == 1
    assert [event.revision for event in delivered] == [1]
    assert '"value":4' in str(snapshot.content).replace(" ", "").replace("'", '"')


def test_python_change_queues_ordered_server_event():
    pn = _load_panel()

    slider = pn.widgets.FloatSlider(label="server", start=0, end=10, value=1)
    _ip, data, _metadata = _format_panel(slider)
    payload = data[BOKEH_SESSION_MIME]
    session = session_registry.require(payload["session_id"])
    root_id = payload["root_ids"][0]
    slider_model = slider._models[root_id][0]

    slider.value = 7

    events = session.pop_server_events()
    assert len(events) == 1
    assert events[0].revision == 1
    assert events[0].client_patch is None
    assert events[0].server_patch is not None
    patch_event = events[0].server_patch.content["events"][0]
    assert patch_event["model"]["id"] == slider_model.id
    assert patch_event["attr"] == "value"
    assert patch_event["new"] == 7
    assert session.pop_server_events() == []


def test_python_change_to_esm_component_queues_server_event():
    pn = _load_panel()
    param = pytest.importorskip("param")

    class Counter(pn.custom.JSComponent):
        value = param.Integer(default=0)

        _esm = "export function render() {}"

    async def change_from_python():
        counter = Counter()
        layout = pn.Column(counter)
        _ip, data, _metadata = _format_panel(layout)
        session = session_registry.require(data[BOKEH_SESSION_MIME]["session_id"])

        counter.value = 3
        layout.append(pn.pane.Markdown("appended"))
        # Panel 1.9 releases the hold on the next tick of the kernel loop.
        await asyncio.sleep(0.05)
        return session.pop_server_events()

    events = asyncio.run(change_from_python())
    changes = [
        (event["attr"], event.get("new"))
        for server_event in events
        for event in server_event.server_patch.content["events"]
        if event["kind"] == "ModelChanged"
    ]
    assert ("value", 3) in changes
    assert any(attr == "children" for attr, _ in changes)
    assert [(event.base_revision, event.revision) for event in events] == [
        (index, index + 1) for index in range(len(events))
    ]


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


def test_failed_patch_advances_revision_with_authoritative_checkpoint():
    pn = _load_panel()

    slider = pn.widgets.FloatSlider(start=0, end=10, value=1)

    def fail_after_update(event):
        raise RuntimeError(f"rejected {event.new}")

    slider.param.watch(fail_after_update, "value")
    _ip, data, _metadata = _format_panel(slider)
    payload = data[BOKEH_SESSION_MIME]
    session = session_registry.require(payload["session_id"])
    slider_model = slider._models[payload["root_ids"][0]][0]

    with pytest.raises(BokehPatchApplyError) as error:
        session.apply_patch(
            base_revision=0,
            transaction_id="failing-interaction",
            patch={
                "events": [
                    {
                        "kind": "ModelChanged",
                        "model": {"id": slider_model.id},
                        "attr": "value",
                        "new": 6,
                    }
                ]
            },
        )

    assert slider.value == 6
    assert session.revision == 1
    assert error.value.revision == 1
    assert error.value.checkpoint.content["roots"][0]
    events = session.pop_server_events()
    assert len(events) == 1
    assert events[0].transaction_id == "failing-interaction"
    assert events[0].base_revision == 0
    assert events[0].revision == 1
    assert events[0].client_patch is None
    assert events[0].server_patch is None
    assert events[0].checkpoint == error.value.checkpoint


def test_uninstall_closes_live_sessions():
    pn = _load_panel()
    slider = pn.widgets.FloatSlider(value=3)
    ip, data, _metadata = _format_panel(slider)
    session_id = data[BOKEH_SESSION_MIME]["session_id"]

    assert session_registry.get(session_id) is not None
    _panel.uninstall(ip)
    assert session_registry.get(session_id) is None


class _FakeKernel:
    """Shell-handler table and reply capture, using ``NteractKernel``'s registry."""

    def __init__(self):
        from ipykernel.ipkernel import IPythonKernel

        self.replies = []
        self.shell_handlers = {msg_type: Mock() for msg_type in IPythonKernel.msg_types}

    def register_shell_handler(self, msg_type, handler):
        from nteract_kernel_launcher.app import NteractKernel

        return NteractKernel.register_shell_handler(cast(Any, self), msg_type, handler)

    def send_response(self, stream, msg_type, **kwargs):
        self.replies.append({"stream": stream, "msg_type": msg_type, **kwargs})

    def dispatch(self, msg_type, ident, parent):
        # Mirrors Kernel.dispatch_shell's table lookup and call.
        self.shell_handlers[msg_type]("SHELL", ident, parent)


@pytest.fixture
def kernel():
    from nteract_kernel_launcher import _bokeh_handlers

    kernel = _FakeKernel()
    ip = SimpleNamespace(kernel=kernel)
    _bokeh_handlers.install_kernel_hooks(ip)
    yield kernel
    _bokeh_handlers.uninstall_kernel_hooks(ip)


def test_patch_shell_handler_captures_output_and_queues_canonical_event(kernel):
    pn = _load_panel()
    from nteract_kernel_launcher._bokeh_handlers import BOKEH_PATCH_REPLY, BOKEH_PATCH_REQUEST

    source = pn.widgets.FloatSlider(start=0, end=10, value=1)
    target = pn.widgets.FloatSlider(start=0, end=20, value=2)

    def callback(event):
        print(f"source={event.new}")
        target.value = event.new * 2

    source.param.watch(callback, "value")
    _ip, data, _metadata = _format_panel(pn.Row(source, target))
    payload = data[BOKEH_SESSION_MIME]
    session = session_registry.require(payload["session_id"])
    source_model = source._models[payload["root_ids"][0]][0]

    kernel.dispatch(
        BOKEH_PATCH_REQUEST,
        [b"client"],
        {
            "content": {
                "schema_version": 1,
                "session_id": session.session_id,
                "transaction_id": "tx-1",
                "base_revision": 0,
                "patch": {
                    "events": [
                        {
                            "kind": "ModelChanged",
                            "model": {"id": source_model.id},
                            "attr": "value",
                            "new": 6,
                        }
                    ]
                },
                "buffers": [],
            },
            "buffers": [],
        },
    )

    assert len(kernel.replies) == 1
    reply = kernel.replies[0]
    assert reply["msg_type"] == BOKEH_PATCH_REPLY
    assert reply["content"]["status"] == "ok"
    assert reply["content"]["transaction_id"] == "tx-1"
    assert reply["content"]["revision"] == 1
    assert reply["content"]["stdout"] == "source=6\n"
    assert target.value == 12

    events = session.pop_server_events()
    assert len(events) == 1
    assert events[0].transaction_id == "tx-1"
    assert events[0].client_patch is not None
    assert events[0].server_patch is not None


def test_patch_shell_error_reply_is_ack_only_and_event_carries_checkpoint(kernel):
    pn = _load_panel()
    from nteract_kernel_launcher._bokeh_handlers import BOKEH_PATCH_REPLY, BOKEH_PATCH_REQUEST

    slider = pn.widgets.FloatSlider(start=0, end=10, value=1)

    def fail(event):
        raise RuntimeError(f"callback rejected {event.new}")

    slider.param.watch(fail, "value")
    _ip, data, _metadata = _format_panel(slider)
    payload = data[BOKEH_SESSION_MIME]
    session = session_registry.require(payload["session_id"])
    slider_model = slider._models[payload["root_ids"][0]][0]

    kernel.dispatch(
        BOKEH_PATCH_REQUEST,
        [b"client"],
        {
            "content": {
                "schema_version": 1,
                "session_id": session.session_id,
                "transaction_id": "tx-error",
                "base_revision": 0,
                "patch": {
                    "events": [
                        {
                            "kind": "ModelChanged",
                            "model": {"id": slider_model.id},
                            "attr": "value",
                            "new": 8,
                        }
                    ]
                },
                "buffers": [],
            },
            "buffers": [],
        },
    )

    reply = kernel.replies[0]
    assert reply["msg_type"] == BOKEH_PATCH_REPLY
    assert reply["content"]["status"] == "error"
    assert reply["content"]["revision"] == 1
    assert "checkpoint" not in reply["content"]
    assert reply["buffers"] == []
    events = session.pop_server_events()
    assert len(events) == 1
    assert events[0].revision == 1
    assert events[0].checkpoint is not None


def test_patch_request_buffers_reject_negative_index_and_hash_mismatch():
    from nteract_kernel_launcher._bokeh_handlers import _request_buffers

    descriptor = BokehBuffer("buffer-1", b"payload").descriptor(0)
    descriptor["buffer_index"] = -1
    with pytest.raises(TypeError, match="descriptor"):
        _request_buffers({"buffers": [b"payload"]}, {"buffers": [descriptor]})

    descriptor = BokehBuffer("buffer-1", b"payload").descriptor(0)
    descriptor["hash"] = "0" * 64
    with pytest.raises(ValueError, match="hash mismatch"):
        _request_buffers({"buffers": [b"payload"]}, {"buffers": [descriptor]})


def test_checkpoint_and_close_shell_handlers(kernel):
    pn = _load_panel()
    from nteract_kernel_launcher._bokeh_handlers import (
        BOKEH_CHECKPOINT_REPLY,
        BOKEH_CHECKPOINT_REQUEST,
        BOKEH_CLOSE_REPLY,
        BOKEH_CLOSE_REQUEST,
    )

    _ip, data, _metadata = _format_panel(pn.widgets.FloatSlider(value=3))
    session_id = data[BOKEH_SESSION_MIME]["session_id"]

    kernel.dispatch(
        BOKEH_CHECKPOINT_REQUEST,
        [],
        {
            "content": {
                "schema_version": 1,
                "session_id": session_id,
                "transaction_id": "checkpoint-1",
            }
        },
    )
    checkpoint_reply = kernel.replies.pop()
    assert checkpoint_reply["msg_type"] == BOKEH_CHECKPOINT_REPLY
    assert checkpoint_reply["content"]["status"] == "ok"
    assert checkpoint_reply["content"]["revision"] == 0
    assert checkpoint_reply["content"]["checkpoint"]["document"]["roots"]

    kernel.dispatch(
        BOKEH_CLOSE_REQUEST,
        [],
        {
            "content": {
                "schema_version": 1,
                "session_id": session_id,
                "transaction_id": "close-1",
            }
        },
    )
    close_reply = kernel.replies.pop()
    assert close_reply["msg_type"] == BOKEH_CLOSE_REPLY
    assert close_reply["content"]["status"] == "ok"
    assert session_registry.get(session_id) is None


@pytest.mark.parametrize(
    ("handler_name", "reply_type", "error_match"),
    [
        (
            "nteract_bokeh_checkpoint_request",
            "nteract_bokeh_checkpoint_reply",
            "Unsupported Bokeh checkpoint schema version",
        ),
        (
            "nteract_bokeh_close_request",
            "nteract_bokeh_close_reply",
            "Unsupported Bokeh close schema version",
        ),
    ],
)
def test_checkpoint_and_close_handlers_reject_unsupported_schema(
    kernel, handler_name, reply_type, error_match
):
    kernel.dispatch(
        handler_name,
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


def test_wire_event_offsets_server_and_checkpoint_buffers():
    from nteract_kernel_launcher._bokeh_handlers import wire_bokeh_event

    event = BokehServerEvent(
        session_id="session-1",
        transaction_id="tx-1",
        base_revision=4,
        revision=5,
        client_patch=BokehSerialization(
            content={"events": [{"kind": "client"}]},
            buffers=(BokehBuffer("client-buffer", b"client"),),
        ),
        server_patch=BokehSerialization(
            content={"events": [{"kind": "server"}]},
            buffers=(BokehBuffer("server-buffer", b"server"),),
        ),
        checkpoint=BokehSerialization(
            content={"roots": []},
            buffers=(BokehBuffer("checkpoint-buffer", b"checkpoint"),),
        ),
    )

    content, buffers = wire_bokeh_event(event)

    assert content["client_patch"]["buffers"][0]["buffer_index"] == 0
    assert content["server_patch"]["buffers"][0]["buffer_index"] == 1
    assert content["checkpoint"]["buffers"][0]["buffer_index"] == 2
    assert buffers == [b"client", b"server", b"checkpoint"]


def test_bokeh_event_drain_discards_unserializable_event_and_continues(
    monkeypatch,
):
    import nteract_kernel_launcher.app as app

    bad_event = BokehServerEvent(
        session_id="session-bad",
        transaction_id="tx-bad",
        base_revision=0,
        revision=1,
        client_patch=None,
        server_patch=None,
    )
    good_event = BokehServerEvent(
        session_id="session-good",
        transaction_id="tx-good",
        base_revision=1,
        revision=2,
        client_patch=None,
        server_patch=None,
    )
    wire_event = app._wire_bokeh_event

    def fail_one_event(event):
        if event is bad_event:
            raise ValueError("malformed event")
        return wire_event(event)

    monkeypatch.setattr(app, "_wire_bokeh_event", fail_one_event)
    send = Mock()
    log = Mock()
    kernel = SimpleNamespace(
        _bokeh_event_lock=threading.Lock(),
        _bokeh_event_queue=deque([bad_event, good_event]),
        _bokeh_event_drain_scheduled=True,
        session=SimpleNamespace(send=send),
        iopub_socket=object(),
        log=log,
        _topic=lambda msg_type: msg_type,
    )

    app.NteractKernel._drain_bokeh_events(cast(Any, kernel))

    assert list(kernel._bokeh_event_queue) == []
    assert kernel._bokeh_event_drain_scheduled is False
    log.exception.assert_called_once_with("Could not serialize Bokeh session event; dropping event")
    send.assert_called_once()
    assert send.call_args.args[1] == app._BOKEH_EVENT
    assert send.call_args.args[2]["session_id"] == "session-good"


def test_bokeh_handlers_register_through_kernel_registry(kernel):
    from ipykernel.ipkernel import IPythonKernel
    from nteract_kernel_launcher import _bokeh_handlers
    from nteract_kernel_launcher.app import NteractKernel

    assert NteractKernel.msg_types == IPythonKernel.msg_types
    for msg_type, handler in _bokeh_handlers.SHELL_HANDLERS.items():
        registered = kernel.shell_handlers[msg_type]
        assert registered.func is handler
        assert registered.args == (kernel,)

    _bokeh_handlers.uninstall_kernel_hooks(SimpleNamespace(kernel=kernel))
    assert not set(_bokeh_handlers.SHELL_HANDLERS) & set(kernel.shell_handlers)
