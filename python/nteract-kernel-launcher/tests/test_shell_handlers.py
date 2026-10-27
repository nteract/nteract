"""``NteractKernel.register_shell_handler`` against ipykernel's real dispatch."""

from __future__ import annotations

import asyncio
import logging
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
import zmq
from jupyter_client.session import Session
from nteract_kernel_launcher import _bokeh_handlers
from nteract_kernel_launcher._bokeh_session import BOKEH_SESSION_SCHEMA_VERSION, session_registry
from nteract_kernel_launcher.app import NteractKernel, NteractShell


@pytest.fixture(scope="module")
def real_kernel():
    kernel = NteractKernel(session=Session(key=b""), log=logging.getLogger(__name__))
    yield kernel
    session_registry.set_event_sink(None)
    NteractShell.clear_instance()


@pytest.fixture
def kernel(real_kernel):
    handlers = dict(real_kernel.shell_handlers)
    real_kernel.iopub_socket = Mock()
    real_kernel.session.send = Mock()
    yield real_kernel
    real_kernel.shell_handlers.clear()
    real_kernel.shell_handlers.update(handlers)
    del real_kernel.session.send


def _dispatch(kernel, msg_type, content):
    msg = kernel.session.msg(msg_type, content=content)
    wire = kernel.session.serialize(msg, ident=[b"client"])
    asyncio.run(kernel.dispatch_shell([zmq.Frame(part) for part in wire]))


def _replies(kernel, msg_type):
    return [call.args[2] for call in kernel.session.send.call_args_list if call.args[1] == msg_type]


def test_registered_handler_receives_its_msg_type(kernel):
    seen = []
    kernel.register_shell_handler("ext_request", lambda *args: seen.append(args))

    _dispatch(kernel, "ext_request", {"value": 1})

    [(stream, ident, parent)] = seen
    assert stream is kernel.shell_stream
    assert ident == [b"client"]
    assert parent["header"]["msg_type"] == "ext_request"
    assert parent["content"] == {"value": 1}


def test_coroutine_handler_is_awaited(kernel):
    seen = []

    async def handler(stream, ident, parent):
        seen.append(parent["content"])

    kernel.register_shell_handler("ext_request", handler)
    _dispatch(kernel, "ext_request", {"value": 2})

    assert seen == [{"value": 2}]


def test_unknown_msg_types_are_untouched(kernel):
    before = dict(kernel.shell_handlers)
    handler = Mock()
    kernel.register_shell_handler("ext_request", handler)

    _dispatch(kernel, "other_request", {})

    handler.assert_not_called()
    assert "other_request" not in kernel.shell_handlers
    assert {k: v for k, v in kernel.shell_handlers.items() if k != "ext_request"} == before


def test_double_registration_is_rejected(kernel):
    first = Mock()
    kernel.register_shell_handler("ext_request", first)

    with pytest.raises(ValueError, match="ext_request"):
        kernel.register_shell_handler("ext_request", Mock())
    with pytest.raises(ValueError, match="execute_request"):
        kernel.register_shell_handler("execute_request", Mock())

    assert kernel.shell_handlers["ext_request"] is first


def test_unregister_removes_only_its_own_handler(kernel):
    unregister = kernel.register_shell_handler("ext_request", Mock())
    unregister()
    assert "ext_request" not in kernel.shell_handlers

    replacement = Mock()
    kernel.register_shell_handler("ext_request", replacement)
    unregister()
    assert kernel.shell_handlers["ext_request"] is replacement


def test_install_is_noop_without_registry():
    _bokeh_handlers.install_kernel_hooks(SimpleNamespace())
    _bokeh_handlers.install_kernel_hooks(SimpleNamespace(kernel=SimpleNamespace()))


def test_failed_install_leaves_no_partial_registration(kernel):
    taken = Mock()
    kernel.register_shell_handler(_bokeh_handlers.BOKEH_CLOSE_REQUEST, taken)

    with pytest.raises(ValueError):
        _bokeh_handlers.install_kernel_hooks(kernel.shell)

    assert _bokeh_handlers.BOKEH_PATCH_REQUEST not in kernel.shell_handlers
    assert _bokeh_handlers.BOKEH_CHECKPOINT_REQUEST not in kernel.shell_handlers
    assert kernel.shell_handlers[_bokeh_handlers.BOKEH_CLOSE_REQUEST] is taken


def test_bokeh_close_request_dispatches_through_registry(kernel):
    _bokeh_handlers.install_kernel_hooks(kernel.shell)
    try:
        _dispatch(
            kernel,
            _bokeh_handlers.BOKEH_CLOSE_REQUEST,
            {
                "schema_version": BOKEH_SESSION_SCHEMA_VERSION,
                "session_id": "missing",
                "transaction_id": "close-1",
            },
        )
    finally:
        _bokeh_handlers.uninstall_kernel_hooks(kernel.shell)

    [reply] = _replies(kernel, _bokeh_handlers.BOKEH_CLOSE_REPLY)
    assert reply["status"] == "not_found"
    assert reply["transaction_id"] == "close-1"
    assert _bokeh_handlers.BOKEH_CLOSE_REQUEST not in kernel.shell_handlers
