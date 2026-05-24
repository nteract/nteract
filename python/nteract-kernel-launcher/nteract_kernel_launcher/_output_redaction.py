"""Install producer-side text redaction on Jupyter output sessions."""

from __future__ import annotations

import logging
import sys
from collections.abc import Iterable
from typing import Any

from nteract_kernel_launcher._redact import redact_message_content

log = logging.getLogger("nteract_kernel_launcher")

_INSTALLED_ATTR = "_nteract_output_redaction_installed"


def _candidate_sessions(ip: Any) -> Iterable[Any]:
    owners = [
        getattr(ip, "display_pub", None),
        getattr(ip, "displayhook", None),
        getattr(ip, "kernel", None),
        sys.stdout,
        sys.stderr,
    ]
    seen: set[int] = set()
    for owner in owners:
        session = getattr(owner, "session", None)
        if session is None:
            continue
        marker = id(session)
        if marker in seen:
            continue
        seen.add(marker)
        if callable(getattr(session, "send", None)):
            yield session


def _redact_msg_or_content(msg_or_type: Any, content: Any) -> tuple[Any, Any]:
    if isinstance(msg_or_type, dict):
        header = msg_or_type.get("header")
        msg_type = header.get("msg_type") if isinstance(header, dict) else None
        if not isinstance(msg_type, str):
            return msg_or_type, content
        message_content = msg_or_type.get("content")
        redacted_content = redact_message_content(msg_type, message_content)
        if redacted_content is message_content:
            return msg_or_type, content
        redacted_msg = dict(msg_or_type)
        redacted_msg["content"] = redacted_content
        return redacted_msg, content

    if isinstance(msg_or_type, str):
        return msg_or_type, redact_message_content(msg_or_type, content)

    return msg_or_type, content


def _wrap_session(session: Any) -> None:
    if getattr(session, _INSTALLED_ATTR, False):
        return

    original_send = session.send

    def send(stream: Any, msg_or_type: Any, content: Any = None, *args: Any, **kwargs: Any) -> Any:
        try:
            msg_or_type, content = _redact_msg_or_content(msg_or_type, content)
        except Exception as exc:  # noqa: BLE001
            log.debug("output redaction failed: %s", exc)
        return original_send(stream, msg_or_type, content, *args, **kwargs)

    send._nteract_installed = True
    send._nteract_original_send = original_send
    session.send = send
    setattr(session, _INSTALLED_ATTR, True)


def install(ip: Any) -> None:
    """Patch known Jupyter output sessions to scrub text before send."""
    for session in _candidate_sessions(ip):
        _wrap_session(session)
