"""Tests for nteract's reliable Python IOPub transport policy."""

from __future__ import annotations

import threading
from types import SimpleNamespace
from typing import Any

import pytest
import zmq
from nteract_kernel_launcher.transport import ReliableIOPubMixin


class _BindRecorder:
    def _bind_socket(self, s: Any, port: int) -> Any:
        s.calls.append(("bind", port))
        return port


class _TestApp(ReliableIOPubMixin, _BindRecorder):
    def __init__(self) -> None:
        self.log = SimpleNamespace(
            debug=lambda *args: self.debugs.append(args),
            warning=lambda *args: self.warnings.append(args),
        )
        self.debugs: list[tuple[Any, ...]] = []
        self.warnings: list[tuple[Any, ...]] = []


class _SocketSpy:
    def __init__(self, socket_type: int) -> None:
        self.socket_type = socket_type
        self.calls: list[tuple[Any, ...]] = []

    def getsockopt(self, option: int) -> int:
        assert option == zmq.TYPE
        return self.socket_type

    def setsockopt(self, option: int, value: int) -> None:
        self.calls.append(("setsockopt", option, value))


@pytest.mark.parametrize("socket_type", [zmq.PUB, zmq.XPUB])
def test_publisher_nodrop_is_set_before_bind(socket_type: int) -> None:
    socket = _SocketSpy(socket_type)

    assert _TestApp()._bind_socket(socket, 42) == 42

    assert socket.calls == [
        ("setsockopt", zmq.XPUB_NODROP, 1),
        ("bind", 42),
    ]


def test_nonpublisher_socket_is_unchanged() -> None:
    socket = _SocketSpy(zmq.ROUTER)

    assert _TestApp()._bind_socket(socket, 42) == 42

    assert socket.calls == [("bind", 42)]


def test_unsupported_nodrop_warns_and_still_binds(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delattr(zmq, "XPUB_NODROP")
    app = _TestApp()
    socket = _SocketSpy(zmq.XPUB)

    assert app._bind_socket(socket, 42) == 42

    assert socket.calls == [("bind", 42)]
    assert len(app.warnings) == 1


def test_rejected_nodrop_warns_and_still_binds() -> None:
    class RejectingSocket(_SocketSpy):
        def setsockopt(self, option: int, value: int) -> None:
            raise zmq.ZMQError(zmq.EINVAL)

    app = _TestApp()
    socket = RejectingSocket(zmq.XPUB)

    assert app._bind_socket(socket, 42) == 42

    assert socket.calls == [("bind", 42)]
    assert len(app.warnings) == 1


def test_rich_entrypoint_uses_reliable_transport_policy() -> None:
    from ipykernel.kernelapp import IPKernelApp
    from nteract_kernel_launcher.app import NteractKernelApp

    assert issubclass(NteractKernelApp, ReliableIOPubMixin)
    assert NteractKernelApp._bind_socket is ReliableIOPubMixin._bind_socket
    assert hasattr(IPKernelApp, "_bind_socket")


def _connected_xpub_pair(*, no_drop: bool) -> tuple[zmq.Context[Any], Any, Any]:
    context = zmq.Context()
    publisher = context.socket(zmq.XPUB)
    publisher.sndhwm = 2
    if no_drop:
        publisher.setsockopt(zmq.XPUB_NODROP, 1)
    endpoint = f"inproc://nteract-iopub-{id(publisher)}"
    publisher.bind(endpoint)

    subscriber = context.socket(zmq.SUB)
    subscriber.rcvhwm = 2
    subscriber.setsockopt(zmq.SUBSCRIBE, b"")
    subscriber.connect(endpoint)

    assert publisher.poll(1_000, zmq.POLLIN)
    assert publisher.recv() == b"\x01"
    return context, publisher, subscriber


def test_nodrop_turns_silent_loss_into_backpressure() -> None:
    lossy_context, lossy_publisher, lossy_subscriber = _connected_xpub_pair(no_drop=False)
    reliable_context, reliable_publisher, reliable_subscriber = _connected_xpub_pair(no_drop=True)
    payload = b"x" * 10_000
    try:
        for _ in range(100):
            # Lossy XPUB reports every nonblocking send as successful even
            # after its subscriber is removed from the active set.
            lossy_publisher.send(payload, zmq.NOBLOCK)

        lossy_received = 0
        while lossy_subscriber.poll(10, zmq.POLLIN):
            lossy_subscriber.recv()
            lossy_received += 1
        assert lossy_received < 100

        accepted = 0
        with pytest.raises(zmq.Again):
            for _ in range(10_000):
                reliable_publisher.send(payload, zmq.NOBLOCK)
                accepted += 1
        assert accepted < 10_000
    finally:
        lossy_publisher.close(linger=0)
        lossy_subscriber.close(linger=0)
        lossy_context.term()
        reliable_publisher.close(linger=0)
        reliable_subscriber.close(linger=0)
        reliable_context.term()


def test_blocking_nodrop_preserves_order_after_reader_resumes() -> None:
    context = zmq.Context()
    endpoint = f"inproc://nteract-iopub-blocking-{id(context)}"
    publisher_ready = threading.Event()
    subscription_ready = threading.Event()
    publisher_finished = threading.Event()
    publisher_errors: list[BaseException] = []
    message_count = 100
    padding = b"x" * 10_000

    def publish() -> None:
        publisher = context.socket(zmq.XPUB)
        publisher.sndhwm = 2
        # Test-only timeout: a transport regression must fail this test rather
        # than leave its publisher thread blocked forever.
        publisher.sndtimeo = 1_000
        publisher.setsockopt(zmq.XPUB_NODROP, 1)
        publisher.bind(endpoint)
        publisher_ready.set()
        try:
            if not publisher.poll(1_000, zmq.POLLIN):
                raise AssertionError("subscriber did not register")
            assert publisher.recv() == b"\x01"
            subscription_ready.set()
            for sequence in range(message_count):
                publisher.send_multipart([sequence.to_bytes(4, "big"), padding])
        except BaseException as exc:  # noqa: BLE001 - propagated to the test thread
            publisher_errors.append(exc)
            subscription_ready.set()
        finally:
            publisher.close(linger=0)
            publisher_finished.set()

    publisher_thread = threading.Thread(target=publish, daemon=True)
    publisher_thread.start()
    assert publisher_ready.wait(1)

    subscriber = context.socket(zmq.SUB)
    subscriber.rcvhwm = 2
    subscriber.setsockopt(zmq.SUBSCRIBE, b"")
    subscriber.connect(endpoint)
    try:
        assert subscription_ready.wait(1)
        assert not publisher_finished.wait(0.05), "publisher should backpressure"

        for expected in range(message_count):
            assert subscriber.poll(1_000, zmq.POLLIN)
            sequence, received_padding = subscriber.recv_multipart()
            assert int.from_bytes(sequence, "big") == expected
            assert received_padding == padding

        assert publisher_finished.wait(1)
        assert publisher_errors == []
    finally:
        subscriber.close(linger=0)
        publisher_thread.join(timeout=2)
        publisher_stuck = publisher_thread.is_alive()
        if publisher_stuck:
            context.destroy(linger=0)
        else:
            context.term()
        assert not publisher_stuck, "publisher thread did not shut down"
