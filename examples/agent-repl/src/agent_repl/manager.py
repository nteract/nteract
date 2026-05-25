"""Inline manager for persistent Python worker sessions."""

from __future__ import annotations

import json
import os
import queue
import subprocess
import sys
import threading
import time
from dataclasses import asdict
from itertools import count
from pathlib import Path
from typing import Any

from agent_repl.types import RunResult, SessionInfo


class ReplTimeout(TimeoutError):
    """Raised when a worker does not return before the requested timeout."""


class _WorkerSession:
    def __init__(
        self,
        name: str,
        backend: str,
        python_executable: str,
        extra_env: dict[str, str] | None = None,
    ) -> None:
        self.name = name
        self.backend = backend
        self.python_executable = python_executable
        self.extra_env = extra_env or {}
        self._ids = count(1)
        self._request_lock = threading.Lock()
        self._responses: queue.Queue[dict[str, Any]] = queue.Queue()
        self._stderr_lines: list[str] = []
        self._stderr_lock = threading.Lock()
        self._executions = 0
        self._closed = False
        self._process = self._start()
        self._reader = threading.Thread(target=self._read_stdout, daemon=True)
        self._stderr_reader = threading.Thread(target=self._read_stderr, daemon=True)
        self._reader.start()
        self._stderr_reader.start()

    @property
    def pid(self) -> int:
        return self._process.pid

    @property
    def alive(self) -> bool:
        return self._process.poll() is None

    @property
    def executions(self) -> int:
        return self._executions

    def run(self, code: str, timeout_s: float) -> RunResult:
        with self._request_lock:
            response = self._request({"op": "run", "code": code}, timeout_s=timeout_s)
        self._executions += 1
        return RunResult(
            session=self.name,
            backend=str(response.get("backend", self.backend)),
            ok=bool(response.get("ok")),
            stdout=str(response.get("stdout", "")),
            stderr=str(response.get("stderr", "")),
            result_repr=response.get("result_repr"),
            displays=list(response.get("displays") or []),
            error_name=response.get("error_name"),
            traceback=response.get("traceback"),
            execution_count=response.get("execution_count"),
        )

    def status(self) -> SessionInfo:
        return SessionInfo(
            session=self.name,
            backend=self.backend,
            pid=self.pid,
            alive=self.alive,
            executions=self.executions,
        )

    def close(self) -> None:
        self._closed = True
        if self._process.poll() is None:
            self._process.terminate()
            try:
                self._process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self._process.kill()
                self._process.wait(timeout=2)

    def kill(self) -> None:
        self._closed = True
        if self._process.poll() is None:
            self._process.kill()
            self._process.wait(timeout=2)

    def _request(self, request: dict[str, Any], timeout_s: float) -> dict[str, Any]:
        if not self.alive:
            message = f"session {self.name!r} worker is not running"
            stderr_tail = self.stderr_tail()
            if stderr_tail:
                message = f"{message}\n\nworker stderr:\n{stderr_tail}"
            raise RuntimeError(message)

        request_id = next(self._ids)
        request["id"] = request_id
        assert self._process.stdin is not None
        self._process.stdin.write(json.dumps(request) + "\n")
        self._process.stdin.flush()
        deadline = time.monotonic() + timeout_s

        try:
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise queue.Empty
                response = self._responses.get(timeout=remaining)
                if response.get("id") == request_id:
                    return response
        except queue.Empty as exc:
            self.kill()
            raise ReplTimeout(f"session {self.name!r} timed out after {timeout_s:g}s") from exc

    def _start(self) -> subprocess.Popen[str]:
        env = os.environ.copy()
        env.update(self.extra_env)
        env["PYTHONUNBUFFERED"] = "1"

        src_root = Path(__file__).resolve().parents[1]
        pythonpath = env.get("PYTHONPATH")
        env["PYTHONPATH"] = (
            str(src_root) if not pythonpath else os.pathsep.join([str(src_root), pythonpath])
        )

        return subprocess.Popen(
            [
                self.python_executable,
                "-m",
                "agent_repl._worker",
                "--backend",
                self.backend,
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            env=env,
        )

    def _read_stdout(self) -> None:
        assert self._process.stdout is not None
        for line in self._process.stdout:
            if self._closed:
                return
            try:
                self._responses.put(json.loads(line))
            except json.JSONDecodeError:
                self._responses.put(
                    {
                        "id": None,
                        "backend": self.backend,
                        "ok": False,
                        "error_name": "WorkerProtocolError",
                        "traceback": f"worker wrote non-JSON stdout: {line!r}",
                    }
                )

    def _read_stderr(self) -> None:
        assert self._process.stderr is not None
        for line in self._process.stderr:
            with self._stderr_lock:
                self._stderr_lines.append(line)
                del self._stderr_lines[:-40]

    def stderr_tail(self) -> str:
        with self._stderr_lock:
            return "".join(self._stderr_lines).strip()


class ReplManager:
    """Owns named persistent Python sessions."""

    def __init__(
        self,
        *,
        backend: str = "auto",
        python_executable: str | None = None,
        extra_env: dict[str, str] | None = None,
    ) -> None:
        self.backend = backend
        self.python_executable = python_executable or sys.executable
        self.extra_env = extra_env
        self._sessions: dict[str, _WorkerSession] = {}
        self._lock = threading.Lock()

    def run(
        self,
        code: str,
        *,
        session: str = "default",
        timeout_s: float = 30,
        backend: str | None = None,
    ) -> RunResult:
        with self._lock:
            worker = self._session(session, backend or self.backend)

        try:
            return worker.run(code, timeout_s=timeout_s)
        except ReplTimeout:
            with self._lock:
                self._sessions.pop(session, None)
            return RunResult(
                session=session,
                backend=worker.backend,
                ok=False,
                error_name="Timeout",
                traceback=f"execution timed out after {timeout_s:g}s; session was killed",
                timed_out=True,
                restarted=True,
            )
        except RuntimeError as exc:
            with self._lock:
                if self._sessions.get(session) is worker:
                    self._sessions.pop(session, None)
            return RunResult(
                session=session,
                backend=worker.backend,
                ok=False,
                error_name="SessionUnavailable",
                traceback=str(exc),
                restarted=True,
            )

    def reset(self, session: str = "default") -> bool:
        with self._lock:
            worker = self._sessions.pop(session, None)
        if worker is None:
            return False
        worker.close()
        return True

    def status(self, session: str = "default") -> SessionInfo | None:
        with self._lock:
            worker = self._sessions.get(session)
        return worker.status() if worker is not None else None

    def list_sessions(self) -> list[SessionInfo]:
        with self._lock:
            workers = list(self._sessions.values())
        return [worker.status() for worker in workers]

    def close(self) -> None:
        with self._lock:
            workers = list(self._sessions.values())
            self._sessions.clear()
        for worker in workers:
            worker.close()

    def _session(self, name: str, backend: str) -> _WorkerSession:
        worker = self._sessions.get(name)
        if worker is not None and worker.alive and worker.backend == backend:
            return worker

        if worker is not None:
            worker.close()

        worker = _WorkerSession(
            name=name,
            backend=backend,
            python_executable=self.python_executable,
            extra_env=self.extra_env,
        )
        self._sessions[name] = worker
        return worker


def as_jsonable(value: RunResult | SessionInfo | list[SessionInfo] | None) -> Any:
    if value is None:
        return None
    if isinstance(value, list):
        return [asdict(item) for item in value]
    return asdict(value)
