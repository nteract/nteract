"""Tests for producer-side output text redaction."""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from nteract_kernel_launcher import _output_redaction, _redact


@pytest.fixture(autouse=True)
def clear_redaction_cache():
    _redact.clear_redaction_cache()


class _FakeSession:
    def __init__(self):
        self.sent = []

    def send(self, stream, msg_or_type, content=None, *args, **kwargs):
        self.sent.append(
            {
                "stream": stream,
                "msg_or_type": msg_or_type,
                "content": content,
                "args": args,
                "kwargs": kwargs,
            }
        )


def _fake_ip(session):
    return SimpleNamespace(
        display_pub=SimpleNamespace(session=session),
        displayhook=SimpleNamespace(session=session),
    )


def test_stream_output_redacts_environment_values(monkeypatch):
    secret = "launcher-stream-secret-12345"
    monkeypatch.setenv("STREAM_REDACTION_SECRET", secret)
    monkeypatch.delenv("NTERACT_REDACT_ENV_VALUES_IN_OUTPUTS", raising=False)

    session = _FakeSession()
    _output_redaction.install(_fake_ip(session))

    session.send(
        "socket",
        "stream",
        content={"name": "stdout", "text": f"token={secret}"},
        parent={"msg_id": "parent"},
    )

    sent = session.sent[0]
    assert sent["content"]["text"] == "token=[redacted env]"
    assert sent["kwargs"]["parent"] == {"msg_id": "parent"}


def test_display_and_error_text_redacts_environment_values(monkeypatch):
    secret = "launcher-display-secret-12345"
    monkeypatch.setenv("DISPLAY_REDACTION_SECRET", secret)
    monkeypatch.delenv("NTERACT_REDACT_ENV_VALUES_IN_OUTPUTS", raising=False)

    session = _FakeSession()
    _output_redaction.install(_fake_ip(session))

    display_msg = {
        "header": {"msg_type": "display_data"},
        "content": {
            "data": {
                "text/plain": f"value {secret}",
                "application/json": {"token": secret},
            }
        },
    }
    session.send("socket", display_msg)
    session.send(
        "socket",
        "error",
        content={"evalue": secret, "traceback": [f"line {secret}"]},
    )

    redacted_display = session.sent[0]["msg_or_type"]
    assert redacted_display["content"]["data"]["text/plain"] == "value [redacted env]"
    assert redacted_display["content"]["data"]["application/json"] == {"token": secret}
    assert display_msg["content"]["data"]["text/plain"] == f"value {secret}"

    redacted_error = session.sent[1]["content"]
    assert redacted_error["evalue"] == "[redacted env]"
    assert redacted_error["traceback"] == ["line [redacted env]"]


def test_output_redaction_install_is_idempotent(monkeypatch):
    secret = "launcher-idempotent-secret-12345"
    monkeypatch.setenv("IDEMPOTENT_REDACTION_SECRET", secret)
    monkeypatch.delenv("NTERACT_REDACT_ENV_VALUES_IN_OUTPUTS", raising=False)

    session = _FakeSession()
    ip = _fake_ip(session)
    _output_redaction.install(ip)
    first_send = session.send
    _output_redaction.install(ip)

    assert session.send is first_send
    session.send("socket", "stream", content={"name": "stdout", "text": secret})
    assert session.sent[0]["content"]["text"] == "[redacted env]"


def test_redaction_candidates_refresh_after_cache_window(monkeypatch):
    now = 1000.0
    monkeypatch.setattr(_redact.time, "monotonic", lambda: now)
    _redact.clear_redaction_cache()

    first_secret = "launcher-cache-secret-12345"
    second_secret = "launcher-cache-secret-67890"
    monkeypatch.setenv("CACHE_REDACTION_SECRET", first_secret)
    monkeypatch.delenv("NTERACT_REDACT_ENV_VALUES_IN_OUTPUTS", raising=False)

    assert first_secret in _redact.eligible_env_values()

    monkeypatch.setenv("CACHE_REDACTION_SECRET", second_secret)
    assert second_secret not in _redact.eligible_env_values()

    now += _redact.REDACTION_CACHE_TTL_SECONDS + 0.001
    assert second_secret in _redact.eligible_env_values()
