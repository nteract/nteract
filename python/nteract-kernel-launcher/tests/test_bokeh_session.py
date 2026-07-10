from __future__ import annotations

import sys
from types import SimpleNamespace
from typing import Any, cast

import pytest
from IPython.core.formatters import DisplayFormatter
from nteract_kernel_launcher import _buffer_hook, _panel
from nteract_kernel_launcher._bokeh_session import (
    BOKEH_SESSION_MIME,
    BokehBuffer,
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

    assert ("panel.viewable", "Viewable") in (
        display_formatter.mimebundle_formatter.deferred_printers
    )
    assert ("panel" in sys.modules) is panel_was_loaded

    _panel.uninstall(ip)
    assert ("panel.viewable", "Viewable") not in (
        display_formatter.mimebundle_formatter.deferred_printers
    )


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
        session.apply_patch(base_revision=0, patch={"events": []})
    assert error.value.actual == 1


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
    def __init__(self):
        self.replies = []

    def send_response(self, stream, msg_type, **kwargs):
        self.replies.append({"stream": stream, "msg_type": msg_type, **kwargs})


def test_patch_shell_handler_captures_output_and_queues_canonical_event():
    pn = _load_panel()
    from nteract_kernel_launcher.app import _BOKEH_PATCH_REPLY, NteractKernel

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
    kernel = _FakeKernel()

    NteractKernel.nteract_bokeh_patch_request(
        cast(Any, kernel),
        "SHELL",
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
    assert reply["msg_type"] == _BOKEH_PATCH_REPLY
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


def test_patch_shell_error_reply_is_ack_only_and_event_carries_checkpoint():
    pn = _load_panel()
    from nteract_kernel_launcher.app import _BOKEH_PATCH_REPLY, NteractKernel

    slider = pn.widgets.FloatSlider(start=0, end=10, value=1)

    def fail(event):
        raise RuntimeError(f"callback rejected {event.new}")

    slider.param.watch(fail, "value")
    _ip, data, _metadata = _format_panel(slider)
    payload = data[BOKEH_SESSION_MIME]
    session = session_registry.require(payload["session_id"])
    slider_model = slider._models[payload["root_ids"][0]][0]
    kernel = _FakeKernel()

    NteractKernel.nteract_bokeh_patch_request(
        cast(Any, kernel),
        "SHELL",
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
    assert reply["msg_type"] == _BOKEH_PATCH_REPLY
    assert reply["content"]["status"] == "error"
    assert reply["content"]["revision"] == 1
    assert "checkpoint" not in reply["content"]
    assert reply["buffers"] == []
    events = session.pop_server_events()
    assert len(events) == 1
    assert events[0].revision == 1
    assert events[0].checkpoint is not None


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


def test_checkpoint_and_close_shell_handlers():
    pn = _load_panel()
    from nteract_kernel_launcher.app import (
        _BOKEH_CHECKPOINT_REPLY,
        _BOKEH_CLOSE_REPLY,
        NteractKernel,
    )

    _ip, data, _metadata = _format_panel(pn.widgets.FloatSlider(value=3))
    session_id = data[BOKEH_SESSION_MIME]["session_id"]
    kernel = _FakeKernel()

    NteractKernel.nteract_bokeh_checkpoint_request(
        cast(Any, kernel),
        "SHELL",
        [],
        {"content": {"session_id": session_id, "transaction_id": "checkpoint-1"}},
    )
    checkpoint_reply = kernel.replies.pop()
    assert checkpoint_reply["msg_type"] == _BOKEH_CHECKPOINT_REPLY
    assert checkpoint_reply["content"]["status"] == "ok"
    assert checkpoint_reply["content"]["revision"] == 0
    assert checkpoint_reply["content"]["checkpoint"]["document"]["roots"]

    NteractKernel.nteract_bokeh_close_request(
        cast(Any, kernel),
        "SHELL",
        [],
        {"content": {"session_id": session_id, "transaction_id": "close-1"}},
    )
    close_reply = kernel.replies.pop()
    assert close_reply["msg_type"] == _BOKEH_CLOSE_REPLY
    assert close_reply["content"]["status"] == "ok"
    assert session_registry.get(session_id) is None


def test_wire_event_offsets_server_and_checkpoint_buffers():
    from nteract_kernel_launcher.app import _wire_bokeh_event

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

    content, buffers = _wire_bokeh_event(event)

    assert content["client_patch"]["buffers"][0]["buffer_index"] == 0
    assert content["server_patch"]["buffers"][0]["buffer_index"] == 1
    assert content["checkpoint"]["buffers"][0]["buffer_index"] == 2
    assert buffers == [b"client", b"server", b"checkpoint"]


def test_nteract_kernel_registers_bokeh_shell_messages():
    from nteract_kernel_launcher.app import (
        _BOKEH_CHECKPOINT_REQUEST,
        _BOKEH_CLOSE_REQUEST,
        _BOKEH_PATCH_REQUEST,
        NteractKernel,
    )

    assert _BOKEH_PATCH_REQUEST in NteractKernel.msg_types
    assert _BOKEH_CHECKPOINT_REQUEST in NteractKernel.msg_types
    assert _BOKEH_CLOSE_REQUEST in NteractKernel.msg_types
