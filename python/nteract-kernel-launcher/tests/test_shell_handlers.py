"""``NteractKernel``'s extension seams against ipykernel's real dispatch and session."""

from __future__ import annotations

import asyncio
import logging
import threading
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
import zmq
from jupyter_client.session import Session
from nteract_kernel_launcher import _bokeh_handlers
from nteract_kernel_launcher._bokeh_session import BOKEH_SESSION_SCHEMA_VERSION, session_registry
from nteract_kernel_launcher.app import IOPubPublisher, NteractKernel, NteractShell


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
    return msg


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
    assert _bokeh_handlers.BOKEH_FOLD_REQUEST not in kernel.shell_handlers
    assert kernel.shell_handlers[_bokeh_handlers.BOKEH_CLOSE_REQUEST] is taken
    assert not session_registry.live


def test_bokeh_close_request_dispatches_through_registry(kernel):
    _bokeh_handlers.install_kernel_hooks(kernel.shell)
    try:
        request = _dispatch(
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
    [call] = [c for c in kernel.session.send.call_args_list if c.args[1].endswith("_reply")]
    assert call.args[0] is kernel.shell_stream
    assert call.args[3]["header"]["msg_id"] == request["header"]["msg_id"]
    assert _bokeh_handlers.BOKEH_CLOSE_REQUEST not in kernel.shell_handlers
    assert not session_registry.live


def test_msg_types_are_ipykernels():
    from ipykernel.ipkernel import IPythonKernel

    assert NteractKernel.msg_types == IPythonKernel.msg_types


# ── IOPubPublisher ────────────────────────────────────────────────────────


def _encode(item):
    return {"item": item}, [f"buf-{item}".encode()]


def _sent_items(kernel, msg_type="ext_event"):
    return [c.args[2]["item"] for c in kernel.session.send.call_args_list if c.args[1] == msg_type]


def test_publisher_sends_unparented_messages_on_iopub(kernel):
    publisher = kernel.iopub_publisher("ext_event", _encode)

    publisher.publish("one")

    [call] = kernel.session.send.call_args_list
    assert call.args[0] is kernel.iopub_socket
    assert call.args[1:3] == ("ext_event", {"item": "one"})
    assert call.kwargs["parent"] is None
    assert call.kwargs["ident"] == kernel._topic("ext_event")
    assert call.kwargs["buffers"] == [b"buf-one"]
    assert len(publisher) == 0


def test_publisher_sends_from_a_worker_thread_while_the_main_thread_blocks(kernel):
    publisher = kernel.iopub_publisher("ext_event", _encode)
    sent = threading.Event()
    senders: list[int] = []

    def send(*_args, **_kwargs):
        senders.append(threading.get_ident())
        sent.set()

    kernel.session.send.side_effect = send
    worker = threading.Thread(target=publisher.publish, args=("from-worker",))
    worker.start()
    # The main thread runs no loop here; a loop-scheduled send would never happen.
    assert sent.wait(timeout=5)
    worker.join(timeout=5)

    assert senders == [worker.ident]
    assert _sent_items(kernel) == ["from-worker"]


def test_publisher_keeps_per_thread_order_and_never_sends_concurrently(kernel):
    publisher = kernel.iopub_publisher("ext_event", _encode)
    in_send = threading.Lock()
    overlaps: list[object] = []

    def send(*_args, **_kwargs):
        if not in_send.acquire(blocking=False):
            overlaps.append(object())
            return
        try:
            threading.Event().wait(0.0005)
        finally:
            in_send.release()

    kernel.session.send.side_effect = send
    start = threading.Barrier(4)

    def run(name):
        start.wait()
        for index in range(25):
            publisher.publish(f"{name}-{index}")

    workers = [threading.Thread(target=run, args=(f"t{n}",)) for n in range(4)]
    for worker in workers:
        worker.start()
    for worker in workers:
        worker.join(timeout=10)

    items = _sent_items(kernel)
    assert overlaps == []
    assert len(items) == 100
    for n in range(4):
        assert [i for i in items if i.startswith(f"t{n}-")] == [f"t{n}-{i}" for i in range(25)]


def test_publisher_drops_an_unencodable_item_and_continues(kernel):
    def encode(item):
        if item == "bad":
            raise ValueError("malformed")
        return _encode(item)

    log = Mock()
    sends: list[tuple] = []
    publisher = IOPubPublisher("ext_event", encode, lambda *args: sends.append(args), log)

    publisher.publish("bad")
    publisher.publish("good")

    assert [content["item"] for _msg_type, content, _buffers in sends] == ["good"]
    log.exception.assert_called_once_with("Could not encode %s; dropping it", "ext_event")


def test_publisher_retries_a_failed_send_before_the_next_item(kernel):
    publisher = kernel.iopub_publisher("ext_event", _encode)
    kernel.session.send.side_effect = [OSError("socket busy"), None, None]

    publisher.publish("one")
    assert len(publisher) == 1
    publisher.publish("two")

    assert _sent_items(kernel) == ["one", "one", "two"]
    assert len(publisher) == 0


def test_closed_publisher_drops_queued_and_later_items(kernel):
    publisher = kernel.iopub_publisher("ext_event", _encode)
    kernel.session.send.side_effect = [OSError("socket busy")]
    publisher.publish("one")

    publisher.close()
    kernel.session.send.side_effect = None
    publisher.publish("two")

    assert len(publisher) == 0
    assert _sent_items(kernel) == ["one"]


def test_bokeh_install_publishes_deltas_through_the_kernel_publisher(kernel):
    from nteract_kernel_launcher._bokeh_session import BokehDelta

    _bokeh_handlers.install_kernel_hooks(kernel.shell)
    try:
        publish = session_registry._event_sink
        assert publish is not None
        publish(BokehDelta(session_id="s1", transaction_id="tx-1"))
    finally:
        _bokeh_handlers.uninstall_kernel_hooks(kernel.shell)

    [call] = kernel.session.send.call_args_list
    assert call.args[0] is kernel.iopub_socket
    assert call.args[1] == _bokeh_handlers.BOKEH_DELTA
    assert call.args[2]["session_id"] == "s1"
    assert call.kwargs["parent"] is None
