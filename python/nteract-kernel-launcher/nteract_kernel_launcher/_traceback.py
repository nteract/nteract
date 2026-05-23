"""Rich traceback short-circuit for the nteract-kernel-launcher.

Replaces ``ZMQInteractiveShell._showtraceback`` with a wrapper that
builds a structured payload (file/line/name per frame with a source
window and highlight) and publishes a ``display_data`` carrying
``application/vnd.nteract.traceback+json``. One output per exception,
same shape the in-session prototype used.

**Safety invariant: this code MUST NEVER prevent a user from seeing a
traceback.** Every code path is wrapped so the original
``_showtraceback`` runs if anything goes wrong. The user would rather
see plain ANSI output than nothing.

Why this lives in a tiny module of its own: it has to be dead-simple
to audit. Reviewers should be able to read the file end-to-end and
convince themselves that no user-triggered exception can sabotage
error reporting.
"""

from __future__ import annotations

import contextlib
import hashlib
import linecache
import logging
import os
import traceback as _pytraceback
import types
from typing import Any

log = logging.getLogger("nteract_kernel_launcher")

TRACEBACK_MIME = "application/vnd.nteract.traceback+json"
"""Matches `src/components/outputs/traceback-output.tsx` on the frontend."""

_LIBRARY_PATH_MARKERS = (
    "site-packages",
    "dist-packages",
    "lib/python",
    "lib\\python",
    "python.framework",
)

_CONTEXT_BEFORE = 2
_CONTEXT_AFTER = 2

# Head + tail frames kept when a traceback is longer than head + tail.
# A RecursionError is 1000 frames; without a cap the payload balloons
# for no information gain (the frontend already clusters duplicates,
# but distinct-but-deep stacks still blow up). Head preserves the
# outermost (user-visible entry) frames; tail preserves the innermost
# (raise-site) frames. Between them, a sentinel records the count.
_MAX_HEAD_FRAMES = 5
_MAX_TAIL_FRAMES = 5
_MAX_CELL_REGISTRY_ENTRIES = 512

_CELL_REGISTRY_ATTR = "_nteract_traceback_cell_registry"
_CELL_REGISTRY_HOOK_ATTR = "_nteract_traceback_cell_registry_hook"
_NOTEBOOK_EXECUTION_SOURCE_KIND = "notebook_execution"

_REDACT_ENV_VALUES_FLAG = "NTERACT_REDACT_ENV_VALUES_IN_OUTPUTS"
_REDACTION_MARKER = "[redacted env]"
_MIN_REDACTION_VALUE_LEN = 8
_COMMON_ENV_VALUES = {
    "localhost",
    "127.0.0.1",
    "0.0.0.0",
    "disabled",
    "enabled",
}

_KNOWN_NON_SECRET_ENV_KEYS = {
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


# ─── Environment value redaction ───────────────────────────────────────────


def _redaction_enabled() -> bool:
    raw = os.environ.get(_REDACT_ENV_VALUES_FLAG)
    if raw is None:
        return True
    return raw.strip().lower() not in {"0", "false", "no", "off"}


def _is_known_non_secret_env_key(key: str) -> bool:
    key = key.upper()
    return (
        key in _KNOWN_NON_SECRET_ENV_KEYS
        or key.startswith("LC_")
        or key.startswith("TERM_PROGRAM")
        or key.startswith("XDG_")
    )


def _eligible_env_values() -> list[str]:
    if not _redaction_enabled():
        return []

    values = set()
    for key, raw in os.environ.items():
        if _is_known_non_secret_env_key(key):
            continue
        value = raw
        if len(value) < _MIN_REDACTION_VALUE_LEN:
            continue
        if value.strip() != value:
            continue
        if value.lower() in _COMMON_ENV_VALUES:
            continue
        values.add(value)

    return sorted(values, key=lambda value: (-len(value), value))


def _redact_text(text: str, values: list[str]) -> str:
    for value in values:
        text = text.replace(value, _REDACTION_MARKER)
    return text


def _redact_payload_value(value: Any, values: list[str]) -> Any:
    if isinstance(value, str):
        return _redact_text(value, values)
    if isinstance(value, list):
        return [_redact_payload_value(item, values) for item in value]
    if isinstance(value, dict):
        return {key: _redact_payload_value(item, values) for key, item in value.items()}
    return value


def _redact_payload(payload: dict[str, Any]) -> dict[str, Any]:
    values = _eligible_env_values()
    if not values:
        return payload
    return _redact_payload_value(payload, values)


# ─── Payload construction ───────────────────────────────────────────────────


def _coerce_metadata_str(value: Any) -> str | None:
    if isinstance(value, str) and value:
        return value
    return None


def _coerce_execution_count(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int) and value >= 0:
        return value
    if isinstance(value, str) and value.isdecimal():
        return int(value)
    return None


def _current_input_count(ip: Any | None) -> int | None:
    """Return the current user-visible `In[N]` count when IPython exposes it."""
    if ip is None:
        return None
    count = _coerce_execution_count(getattr(ip, "execution_count", None))
    if count is None:
        return None
    # IPython increments `shell.execution_count` before firing pre_run_cell and
    # before running user code. The visible prompt for the active cell is one
    # behind that value.
    return count - 1 if count > 0 else count


def _execution_count_for_info(ip: Any, info: Any) -> int | None:
    if getattr(info, "silent", False):
        return None
    if not getattr(info, "store_history", True):
        return None
    return _current_input_count(ip)


def _source_hash(source: str) -> str:
    return "sha256:" + hashlib.sha256(source.encode("utf-8")).hexdigest()


def _parent_metadata(parent: Any) -> dict[str, Any]:
    if not isinstance(parent, dict):
        return {}
    metadata = parent.get("metadata")
    return metadata if isinstance(metadata, dict) else {}


def _metadata_execution_id(metadata: dict[str, Any]) -> str | None:
    nteract = metadata.get("nteract")
    nteract_execution_id = nteract.get("execution_id") if isinstance(nteract, dict) else None
    return _coerce_metadata_str(nteract_execution_id)


def _current_parent(ip: Any | None) -> dict[str, Any]:
    if ip is None:
        return {}

    get_parent = getattr(ip, "get_parent", None)
    if callable(get_parent):
        with contextlib.suppress(BaseException):
            parent = get_parent()
            if isinstance(parent, dict):
                return parent

    parent = getattr(ip, "parent_header", None)
    return parent if isinstance(parent, dict) else {}


def _current_execution_context(ip: Any | None) -> dict[str, Any]:
    parent = _current_parent(ip)
    metadata = _parent_metadata(parent)
    header = parent.get("header") if isinstance(parent, dict) else None
    header = header if isinstance(header, dict) else {}

    context: dict[str, Any] = {
        "execution_id": _metadata_execution_id(metadata)
        or _coerce_metadata_str(header.get("msg_id")),
        "execution_count": _current_input_count(ip),
    }
    return {key: value for key, value in context.items() if value}


def _filename_for_cell_source(raw_cell: str) -> str | None:
    try:
        from ipykernel.compiler import get_file_name

        return get_file_name(raw_cell)
    except BaseException as err:  # noqa: BLE001
        log.debug("rich traceback cell filename unavailable: %r", err)
        return None


def _cell_registry(ip: Any) -> dict[str, dict[str, Any]]:
    registry = getattr(ip, _CELL_REGISTRY_ATTR, None)
    if not isinstance(registry, dict):
        registry = {}
        setattr(ip, _CELL_REGISTRY_ATTR, registry)
    return registry


def _register_cell_source(
    ip: Any,
    raw_cell: Any,
    *,
    execution_id: str | None,
    execution_count: int | None,
) -> None:
    if not isinstance(raw_cell, str):
        return
    filename = _filename_for_cell_source(raw_cell)
    if not filename:
        return

    source_hash = _source_hash(raw_cell)
    source_ref = {
        "kind": _NOTEBOOK_EXECUTION_SOURCE_KIND,
        "execution_id": execution_id,
        "execution_count": execution_count,
        "source_hash": source_hash,
        "compiled_filename": filename,
    }
    source_ref = {key: value for key, value in source_ref.items() if value}
    provenance = {
        "execution_id": execution_id,
        "execution_count": execution_count,
        "source_hash": source_hash,
        "source_ref": source_ref,
    }
    provenance = {key: value for key, value in provenance.items() if value}
    if not provenance:
        return

    registry = _cell_registry(ip)
    registry[filename] = provenance
    while len(registry) > _MAX_CELL_REGISTRY_ENTRIES:
        with contextlib.suppress(StopIteration):
            registry.pop(next(iter(registry)))


def _provenance_for_filename(ip: Any | None, filename: str) -> dict[str, Any]:
    if ip is None or not filename:
        return {}
    registry = getattr(ip, _CELL_REGISTRY_ATTR, None)
    if not isinstance(registry, dict):
        return {}
    provenance = registry.get(filename)
    return provenance.copy() if isinstance(provenance, dict) else {}


def _install_cell_registry_hook(ip: Any) -> None:
    if getattr(ip, _CELL_REGISTRY_HOOK_ATTR, False):
        return

    events = getattr(ip, "events", None)
    register = getattr(events, "register", None)
    if not callable(register):
        return

    callbacks = getattr(events, "callbacks", {})
    callbacks = callbacks.get("pre_run_cell", []) if isinstance(callbacks, dict) else []
    if any(getattr(callback, "_nteract_cell_registry_hook", False) for callback in callbacks):
        setattr(ip, _CELL_REGISTRY_HOOK_ATTR, True)
        return

    def _nteract_pre_run_cell(info: Any) -> None:
        try:
            parent = _current_parent(ip)
            metadata = _parent_metadata(parent)
            header = parent.get("header") if isinstance(parent, dict) else None
            header = header if isinstance(header, dict) else {}
            execution_id = _metadata_execution_id(metadata) or _coerce_metadata_str(
                header.get("msg_id")
            )
            execution_count = _execution_count_for_info(ip, info)
            _register_cell_source(
                ip,
                getattr(info, "raw_cell", None),
                execution_id=execution_id,
                execution_count=execution_count,
            )
        except BaseException as err:  # noqa: BLE001
            log.debug("rich traceback cell registry hook failed: %r", err)

    _nteract_pre_run_cell._nteract_cell_registry_hook = True
    with contextlib.suppress(BaseException):
        register("pre_run_cell", _nteract_pre_run_cell)
        setattr(ip, _CELL_REGISTRY_HOOK_ATTR, True)


def _is_library_frame(filename: str) -> bool:
    if not filename:
        return True
    norm = os.path.normpath(filename).lower()
    return any(m in norm for m in _LIBRARY_PATH_MARKERS)


def _source_window(filename: str, lineno: int) -> list[dict[str, Any]]:
    """Return the source-context lines around ``lineno`` (inclusive range)."""
    out: list[dict[str, Any]] = []
    start = max(1, lineno - _CONTEXT_BEFORE)
    end = lineno + _CONTEXT_AFTER
    for n in range(start, end + 1):
        src = linecache.getline(filename, n)
        if not src:
            continue
        entry: dict[str, Any] = {"lineno": n, "source": src.rstrip("\n")}
        if n == lineno:
            entry["highlight"] = True
        out.append(entry)
    return out


def _clip_frames(frames: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Keep head + tail; summarize the middle with a sentinel frame.

    No-op when the stack fits under the cap. Otherwise returns the head,
    a sentinel row describing how many frames were elided, then the
    tail. The sentinel is marked ``library: True`` so the frontend's
    dimming/collapse rules match its "this is noise" semantic.
    """
    total = len(frames)
    if total <= _MAX_HEAD_FRAMES + _MAX_TAIL_FRAMES:
        return frames
    head = frames[:_MAX_HEAD_FRAMES]
    tail = frames[-_MAX_TAIL_FRAMES:]
    omitted = total - len(head) - len(tail)
    sentinel: dict[str, Any] = {
        "filename": "",
        "lineno": 0,
        "name": f"… {omitted} frames omitted …",
        "lines": [],
        "library": True,
    }
    return head + [sentinel] + tail


def _strip_leading_library_frames(frames: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Drop library frames above the first user frame.

    IPython's ``run_code`` wraps every cell execution, so a cell raising
    a bare ``NameError`` ends up with two frames: the IPython wrapper and
    the user's cell. The wrapper is pure ceremony — no user code lives
    there — so we strip it.

    Any library frames *after* a user frame are kept: if a user call into
    a library raised inside that library, those frames carry real info.

    If *every* frame is library (e.g. a failing ``import`` inside a
    worker thread before any user code runs), keep everything so we
    don't emit an empty stack.
    """
    if not any(not f.get("library") for f in frames):
        return frames
    for i, f in enumerate(frames):
        if not f.get("library"):
            return frames[i:]
    return frames


def _is_notebook_source(item: dict[str, Any]) -> bool:
    source_ref = item.get("source_ref")
    return (
        isinstance(source_ref, dict) and source_ref.get("kind") == _NOTEBOOK_EXECUTION_SOURCE_KIND
    )


def _execution_count_label(item: dict[str, Any]) -> str | None:
    source_ref = item.get("source_ref")
    count = None
    if isinstance(source_ref, dict):
        count = _coerce_execution_count(source_ref.get("execution_count"))
    if count is None:
        count = _coerce_execution_count(item.get("execution_count"))
    return f"In[{count}]" if count is not None else None


def _notebook_source_label(item: dict[str, Any], current_execution_id: str | None) -> str:
    source_ref = item.get("source_ref")
    execution_id = item.get("execution_id")
    if isinstance(source_ref, dict):
        execution_id = source_ref.get("execution_id") or execution_id
    if execution_id and execution_id == current_execution_id:
        return "Current Cell"
    if execution_id:
        return "Earlier Cell"
    return "Notebook Cell"


def _format_traceback_location(
    item: dict[str, Any],
    *,
    current_execution_id: str | None,
    function_name: str | None = None,
) -> str:
    lineno = item.get("lineno") or 0
    if _is_notebook_source(item):
        label = _notebook_source_label(item, current_execution_id)
        count_label = _execution_count_label(item)
        location = f"Line {lineno} in {label}"
        if count_label:
            location += f" ({count_label})"
        if function_name and function_name != "<module>":
            location += f", in {function_name}"
        return location

    filename = item.get("filename") or "<unknown>"
    function = function_name or "<module>"
    return f'File "{filename}", line {lineno}, in {function}'


def _highlighted_source_line(lines: Any) -> str | None:
    if not isinstance(lines, list):
        return None
    for line in lines:
        if isinstance(line, dict) and line.get("highlight"):
            source = line.get("source")
            return source if isinstance(source, str) else None
    for line in lines:
        if isinstance(line, dict):
            source = line.get("source")
            return source if isinstance(source, str) else None
    return None


def _caret_line(syntax: dict[str, Any]) -> str | None:
    text = syntax.get("text")
    if not isinstance(text, str) or not text:
        return None
    line_len = len(text)
    offset = _coerce_execution_count(syntax.get("offset")) or 1
    start_col = max(1, min(offset, line_len + 1))
    end_lineno = _coerce_execution_count(syntax.get("end_lineno"))
    end_offset = _coerce_execution_count(syntax.get("end_offset")) or 0
    same_line = not end_lineno or end_lineno == syntax.get("lineno")
    end_col = (
        min(end_offset, line_len + 1) if same_line and end_offset > start_col else start_col + 1
    )
    return " " * (start_col - 1) + "^" * max(1, end_col - start_col)


def _format_rich_traceback_text(
    ename: str,
    evalue: str,
    *,
    frames: list[dict[str, Any]],
    syntax: dict[str, Any] | None,
    current_execution_id: str | None,
) -> str:
    out = ["Traceback (most recent call last):"]
    if syntax is not None:
        out.append(
            "  "
            + _format_traceback_location(
                syntax,
                current_execution_id=current_execution_id,
            )
        )
        text = syntax.get("text")
        if isinstance(text, str) and text:
            out.append(f"    {text}")
            caret = _caret_line(syntax)
            if caret:
                out.append(f"    {caret}")
    else:
        for frame in frames:
            name = frame.get("name") if isinstance(frame.get("name"), str) else "<module>"
            out.append(
                "  "
                + _format_traceback_location(
                    frame,
                    current_execution_id=current_execution_id,
                    function_name=name,
                )
            )
            source = _highlighted_source_line(frame.get("lines"))
            if source:
                out.append(f"    {source}")
    out.append(f"{ename}: {evalue}")
    return "\n".join(out)


def _build_syntax_error_payload(
    etype: Any,
    evalue: Any,
    tb: Any,
    ip: Any | None,
) -> dict[str, Any]:
    """Special-case payload for `SyntaxError` and friends.

    Parse errors never have a user-code frame — IPython raises from
    inside ``ast_parse`` before any cell bytecode runs, so the traceback
    is all internals and pure noise from the user's perspective.

    The useful information lives on the exception object itself:
    ``offset``, ``text``, ``msg``, ``lineno``. We emit a payload with
    empty ``frames`` and an additional ``syntax`` slot carrying the
    caret location, so the renderer can show something like:

        SyntaxError: invalid syntax
          | This is not valid syntax
          |     ^

    Applies to ``SyntaxError``, ``IndentationError``, ``TabError`` —
    they all share the same attribute surface.
    """
    filename = getattr(evalue, "filename", "") or ""
    lineno = getattr(evalue, "lineno", 0) or 0
    offset = getattr(evalue, "offset", 0) or 0
    # `end_lineno` / `end_offset` exist on 3.11+ SyntaxError. When the
    # parser knows the end of the offending token, we can underline a
    # range (e.g. `^^^^`) instead of a single caret — Python's own
    # traceback format does this since 3.11.
    # `-1` is a documented sentinel meaning "unknown" (see cpython
    # Objects/exceptions.c); normalize to 0 so the renderer can treat
    # 0 as "absent".
    end_lineno_raw = getattr(evalue, "end_lineno", None)
    end_offset_raw = getattr(evalue, "end_offset", None)
    end_lineno = end_lineno_raw if isinstance(end_lineno_raw, int) and end_lineno_raw > 0 else 0
    end_offset = end_offset_raw if isinstance(end_offset_raw, int) and end_offset_raw > 0 else 0
    text = getattr(evalue, "text", "") or ""
    msg = getattr(evalue, "msg", None) or str(evalue)
    syntax = {
        "filename": filename,
        "lineno": lineno,
        "offset": offset,
        "end_lineno": end_lineno,
        "end_offset": end_offset,
        "text": text.rstrip("\n"),
        "msg": msg,
    }
    syntax.update(_provenance_for_filename(ip, filename))
    execution = _current_execution_context(ip)
    current_execution_id = execution.get("execution_id")
    raw_text = "".join(_pytraceback.format_exception(etype, evalue, tb))
    ename = etype.__name__ if isinstance(etype, type) else str(etype)
    payload: dict[str, Any] = {
        "ename": ename,
        "evalue": str(evalue),
        "frames": [],
        "language": "python",
        "text": _format_rich_traceback_text(
            ename,
            str(evalue),
            frames=[],
            syntax=syntax,
            current_execution_id=current_execution_id
            if isinstance(current_execution_id, str)
            else None,
        ),
        "raw_text": raw_text,
        "syntax": syntax,
    }
    if execution:
        payload["execution"] = execution
    return payload


def build_rich_payload(
    etype: Any,
    evalue: Any,
    tb: Any,
    ip: Any | None = None,
) -> dict[str, Any]:
    """Structure an exception into the rich traceback payload.

    Assumes the caller protects against exceptions from this function —
    see `_safe_showtraceback` below.
    """
    # Parse errors take a dedicated code path — their traceback carries
    # no user-code frame, but the exception object has the caret info
    # (offset, text) we want to render.
    if isinstance(evalue, SyntaxError):
        return _redact_payload(_build_syntax_error_payload(etype, evalue, tb, ip))

    raw_frames = []
    for f in _pytraceback.extract_tb(tb):
        # `FrameSummary.lineno` is typed as `int | None`; treat missing
        # as 0 so the manifest stays numeric. `linecache.getline` with
        # lineno=0 returns "" which is what we want (no context).
        lineno = f.lineno or 0
        frame = {
            "filename": f.filename,
            "lineno": lineno,
            "name": f.name,
            "lines": _source_window(f.filename, lineno),
            "library": _is_library_frame(f.filename),
        }
        frame.update(_provenance_for_filename(ip, f.filename))
        raw_frames.append(frame)
    frames = _clip_frames(_strip_leading_library_frames(raw_frames))
    raw_text = "".join(_pytraceback.format_exception(etype, evalue, tb))
    ename = etype.__name__ if isinstance(etype, type) else str(etype)
    execution = _current_execution_context(ip)
    current_execution_id = execution.get("execution_id")
    payload: dict[str, Any] = {
        "ename": ename,
        "evalue": str(evalue),
        "frames": frames,
        "language": "python",
        "text": _format_rich_traceback_text(
            ename,
            str(evalue),
            frames=frames,
            syntax=None,
            current_execution_id=current_execution_id
            if isinstance(current_execution_id, str)
            else None,
        ),
        "raw_text": raw_text,
    }
    if execution:
        payload["execution"] = execution
    return _redact_payload(payload)


# ─── Safe showtraceback wrapper ─────────────────────────────────────────────


def install(ip: Any) -> None:
    """Install a safe, short-circuiting ``_showtraceback`` on *ip*.

    Tagged with ``_nteract_installed`` so re-installs (e.g. dev
    hot-reload) don't stack.
    """
    _install_cell_registry_hook(ip)

    existing = getattr(ip, "_showtraceback", None)
    if existing is not None and getattr(existing, "_nteract_installed", False):
        return

    original = existing

    def _safe_showtraceback(self: Any, etype: Any, evalue: Any, stb: Any) -> None:
        """Emit the rich payload, falling back to *original* on any error.

        Catches ``BaseException`` rather than ``Exception`` so nothing a
        user can trigger inside payload construction or the publish call
        can take down the error path. ``SystemExit`` and
        ``KeyboardInterrupt`` are re-raised — those are intentional
        control flow.
        """
        try:
            # Lazy import inside the function body so a missing IPython
            # at extension-load time never strands us without a traceback
            # path.
            from IPython.display import publish_display_data

            tb = evalue.__traceback__ if isinstance(evalue, BaseException) else None
            payload = build_rich_payload(etype, evalue, tb, self)
            publish_display_data(data={TRACEBACK_MIME: payload}, metadata={})
        except (SystemExit, KeyboardInterrupt):
            # Intentional control flow — propagate.
            raise
        except BaseException as err:  # noqa: BLE001
            # Anything else — including MemoryError, RecursionError,
            # OSError from IPython internals — must not starve the
            # user of a traceback. Log at debug (we're literally inside
            # the error path; loud logging is worse than silent fallback).
            log.debug("rich traceback fallback: %r", err)
            if original is not None:
                # If the *original* also fails, there's nothing more we
                # can usefully do. Swallow to avoid obscuring the root
                # exception with a meta-error.
                with contextlib.suppress(BaseException):
                    original(etype, evalue, stb)

    # Tag for idempotency.
    _safe_showtraceback._nteract_installed = True

    ip._showtraceback = types.MethodType(_safe_showtraceback, ip)
