from __future__ import annotations

from agent_repl import ReplManager


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
