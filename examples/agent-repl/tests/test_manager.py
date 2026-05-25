from __future__ import annotations

import sys
import time

from agent_repl import ReplManager
from agent_repl.manager import ReplTimeout, _WorkerSession


def test_plain_python_session_persists_state() -> None:
    manager = ReplManager(backend="python")
    try:
        first = manager.run("x = 41")
        second = manager.run("y = x + 1\ny")
    finally:
        manager.close()

    assert first.ok
    assert second.ok
    assert second.result_repr == "42"


def test_plain_python_captures_stdout_and_errors() -> None:
    manager = ReplManager(backend="python")
    try:
        printed = manager.run("print('hello')")
        failed = manager.run("1 / 0")
    finally:
        manager.close()

    assert printed.ok
    assert printed.stdout == "hello\n"
    assert not failed.ok
    assert failed.error_name == "ZeroDivisionError"
    assert failed.traceback


def test_timeout_kills_only_that_session() -> None:
    manager = ReplManager(backend="python")
    try:
        manager.run("x = 7", session="keep")
        timed_out = manager.run("import time; time.sleep(5)", session="drop", timeout_s=0.2)
        still_alive = manager.run("x", session="keep")
        restarted = manager.run("99", session="drop")
    finally:
        manager.close()

    assert not timed_out.ok
    assert timed_out.timed_out
    assert still_alive.result_repr == "7"
    assert restarted.ok
    assert restarted.result_repr == "99"


def test_timeout_budget_is_not_reset_by_discarded_responses() -> None:
    worker = _WorkerSession("test", "python", sys.executable)
    try:
        worker._responses.put({"id": 999, "ok": True})
        started = time.monotonic()
        try:
            worker._request({"op": "run", "code": "import time; time.sleep(5)"}, timeout_s=0.2)
        except ReplTimeout:
            elapsed = time.monotonic() - started
        else:
            raise AssertionError("expected timeout")
    finally:
        worker.close()

    assert elapsed < 0.35


def test_broken_pipe_during_request_is_structured_error() -> None:
    class BrokenStdin:
        def write(self, text: str) -> None:
            raise BrokenPipeError("closed pipe")

        def flush(self) -> None:
            pass

    worker = _WorkerSession("test", "python", sys.executable)
    try:
        worker._process.stdin = BrokenStdin()
        try:
            worker._request({"op": "run", "code": "1"}, timeout_s=0.2)
        except RuntimeError as exc:
            message = str(exc)
        else:
            raise AssertionError("expected broken pipe")
    finally:
        worker.close()

    assert "worker died while accepting a request" in message


def test_protocol_error_response_is_not_discarded() -> None:
    worker = _WorkerSession("test", "python", sys.executable)
    try:
        worker._responses.put(
            {
                "id": None,
                "ok": False,
                "error_name": "WorkerProtocolError",
                "traceback": "bad stdout",
            }
        )
        try:
            worker._request({"op": "run", "code": "import time; time.sleep(5)"}, timeout_s=1)
        except RuntimeError as exc:
            message = str(exc)
        else:
            raise AssertionError("expected protocol error")
    finally:
        worker.close()

    assert "WorkerProtocolError" in message
    assert "bad stdout" in message


def test_manager_returns_structured_error_if_worker_dies_before_run() -> None:
    class BrokenWorker:
        backend = "python"
        alive = True

        def run(self, code: str, timeout_s: float):  # noqa: ARG002
            raise RuntimeError("worker disappeared")

        def close(self) -> None:
            pass

    manager = ReplManager(backend="python")
    manager._sessions["default"] = BrokenWorker()

    result = manager.run("1")

    assert not result.ok
    assert result.error_name == "SessionUnavailable"
    assert result.restarted
    assert "worker disappeared" in (result.traceback or "")
    assert "default" not in manager._sessions


def test_dead_worker_error_includes_stderr_tail() -> None:
    worker = _WorkerSession("bad", "bogus", sys.executable)
    try:
        for _ in range(20):
            if not worker.alive:
                break
            time.sleep(0.05)

        try:
            worker._request({"op": "run", "code": "1"}, timeout_s=0.2)
        except RuntimeError as exc:
            message = str(exc)
        else:
            raise AssertionError("expected worker startup failure")
    finally:
        worker.close()

    assert "worker stderr:" in message
    assert "invalid choice" in message


def test_ipython_backend_captures_rich_display() -> None:
    manager = ReplManager(backend="ipython")
    try:
        result = manager.run(
            "from IPython.display import display\n"
            "display({'text/plain': 'hi', 'application/json': {'answer': 42}}, raw=True)"
        )
    finally:
        manager.close()

    assert result.ok
    assert result.displays
    assert result.displays[0]["data"]["application/json"] == {"answer": 42}
