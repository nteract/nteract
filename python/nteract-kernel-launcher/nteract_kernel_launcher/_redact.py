"""Best-effort output text redaction shared by launcher output paths."""

from __future__ import annotations

import os
import time
from typing import Any

REDACT_ENV_VALUES_FLAG = "NTERACT_REDACT_ENV_VALUES_IN_OUTPUTS"
REDACTION_MARKER = "[redacted env]"
MIN_REDACTION_VALUE_LEN = 8
REDACTION_CACHE_TTL_SECONDS = 0.25
COMMON_ENV_VALUES = {
    "localhost",
    "127.0.0.1",
    "0.0.0.0",
    "disabled",
    "enabled",
}

KNOWN_NON_SECRET_ENV_KEYS = {
    "_",
    "__CF_USER_TEXT_ENCODING",
    "CARGO_HOME",
    "COLORFGBG",
    "COLORTERM",
    "CONDA_DEFAULT_ENV",
    "CONDA_EXE",
    "CONDA_PREFIX",
    "CONDA_PYTHON_EXE",
    "DISPLAY",
    "GOPATH",
    "GOROOT",
    "HOME",
    "LANG",
    "LANGUAGE",
    "LOGNAME",
    "OLDPWD",
    "PATH",
    "PWD",
    "PYENV_ROOT",
    "PYTHONHOME",
    "PYTHONPATH",
    "RUSTUP_HOME",
    "SHELL",
    "SHLVL",
    "SSH_AUTH_SOCK",
    "TEMP",
    "TERM",
    "TMP",
    "TMPDIR",
    "USER",
    "USERNAME",
    "VIRTUAL_ENV",
    "XPC_FLAGS",
    "XPC_SERVICE_NAME",
}

_cached_values: list[str] | None = None
_cached_at = 0.0
_cached_env_size = -1
_cached_flag: str | None = None


def redaction_enabled() -> bool:
    raw = os.environ.get(REDACT_ENV_VALUES_FLAG)
    if raw is None:
        return True
    return raw.strip().lower() not in {"0", "false", "no", "off"}


def is_known_non_secret_env_key(key: str) -> bool:
    key = key.upper()
    return (
        key in KNOWN_NON_SECRET_ENV_KEYS
        or key.startswith("LC_")
        or key.startswith("TERM_PROGRAM")
        or key.startswith("XDG_")
    )


def clear_redaction_cache() -> None:
    global _cached_at, _cached_env_size, _cached_flag, _cached_values
    _cached_values = None
    _cached_at = 0.0
    _cached_env_size = -1
    _cached_flag = None


def _compute_eligible_env_values() -> list[str]:
    if not redaction_enabled():
        return []

    values = set()
    for key, raw in os.environ.items():
        if is_known_non_secret_env_key(key):
            continue
        value = raw
        if len(value) < MIN_REDACTION_VALUE_LEN:
            continue
        if value.strip() != value:
            continue
        if value.lower() in COMMON_ENV_VALUES:
            continue
        values.add(value)

    return sorted(values, key=lambda value: (-len(value), value))


def eligible_env_values() -> list[str]:
    global _cached_at, _cached_env_size, _cached_flag, _cached_values
    now = time.monotonic()
    env_size = len(os.environ)
    flag = os.environ.get(REDACT_ENV_VALUES_FLAG)
    if (
        _cached_values is not None
        and env_size == _cached_env_size
        and flag == _cached_flag
        and now - _cached_at < REDACTION_CACHE_TTL_SECONDS
    ):
        return _cached_values

    _cached_values = _compute_eligible_env_values()
    _cached_at = now
    _cached_env_size = env_size
    _cached_flag = flag
    return _cached_values


def redact_text(text: str, values: list[str] | None = None) -> str:
    if values is None:
        values = eligible_env_values()
    for value in values:
        text = text.replace(value, REDACTION_MARKER)
    return text


def redact_payload_value(value: Any, values: list[str] | None = None) -> Any:
    if values is None:
        values = eligible_env_values()
    if not values:
        return value
    if isinstance(value, str):
        return redact_text(value, values)
    if isinstance(value, list):
        return [redact_payload_value(item, values) for item in value]
    if isinstance(value, dict):
        return {key: redact_payload_value(item, values) for key, item in value.items()}
    return value


def redact_payload(payload: dict[str, Any]) -> dict[str, Any]:
    values = eligible_env_values()
    if not values:
        return payload
    return redact_payload_value(payload, values)


def _redact_mime_data(data: Any, values: list[str]) -> Any:
    if not isinstance(data, dict):
        return data
    redacted = dict(data)
    for mime, value in data.items():
        if isinstance(value, str):
            redacted[mime] = redact_text(value, values)
    return redacted


def redact_message_content(msg_type: str, content: Any) -> Any:
    """Redact text-bearing Jupyter output message content.

    Binary buffers and non-string MIME values are intentionally left untouched.
    """
    values = eligible_env_values()
    if not values or not isinstance(content, dict):
        return content

    redacted = dict(content)
    if msg_type == "stream":
        text = content.get("text")
        if isinstance(text, str):
            redacted["text"] = redact_text(text, values)
    elif msg_type in {"display_data", "execute_result", "update_display_data"}:
        redacted["data"] = _redact_mime_data(content.get("data"), values)
    elif msg_type == "error":
        evalue = content.get("evalue")
        traceback = content.get("traceback")
        if isinstance(evalue, str):
            redacted["evalue"] = redact_text(evalue, values)
        if isinstance(traceback, list):
            redacted["traceback"] = [
                redact_text(line, values) if isinstance(line, str) else line for line in traceback
            ]
    return redacted
