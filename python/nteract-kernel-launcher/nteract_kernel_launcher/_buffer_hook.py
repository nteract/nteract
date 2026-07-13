"""Buffer-attachment hook — shared between ``display_pub`` and ``displayhook``.

When the DataFrame formatter emits an output bundle, it stashes the Arrow
bytes in a thread-local dict keyed by the blob-ref hash. Later, when the
Jupyter message is about to go on the wire, this hook:

1. Looks at the message's ``content.data`` for our ref MIME.
2. If present, pops the pending bytes by hash.
3. Sends the message manually with ``buffers=[bytes]`` attached.
4. Returns ``None`` so the default bufferless ``session.send`` is suppressed.

Registered on both ``ZMQDisplayPublisher`` and ``NteractShellDisplayHook``,
so ``display_data``, ``update_display_data``, and ``execute_result`` all
pick up the same buffer-attachment behavior.
"""

from __future__ import annotations

import json
import logging
import threading
from typing import Any

from nteract_kernel_launcher._refs import BLOB_REF_MIME

log = logging.getLogger("nteract_kernel_launcher")

# Per-thread stash of pending table bytes, keyed by content hash.
# The formatter writes; the hook reads + pops.
_pending = threading.local()


def pending_buffers() -> dict[str, bytes]:
    """Return the per-thread pending-buffers dict, creating it lazily."""
    if not hasattr(_pending, "buffers"):
        _pending.buffers = {}
    return _pending.buffers


def _get_ipython() -> Any | None:
    try:
        from IPython import get_ipython

        return get_ipython()
    except ImportError:
        return None


def _pub_for_msg_type(msg_type: str) -> Any | None:
    """Route the manual ``session.send`` through the correct publisher.

    ``execute_result`` needs ``ip.displayhook`` (session/pub_socket/topic
    wired for that message type). ``display_data`` and
    ``update_display_data`` go through ``ip.display_pub``.
    """
    ip = _get_ipython()
    if ip is None:
        return None
    if msg_type == "execute_result":
        return ip.displayhook
    return ip.display_pub


def _ref_entries(ref: dict) -> list[dict]:
    refs = ref.get("refs")
    if isinstance(refs, list):
        return [entry for entry in refs if isinstance(entry, dict)]
    if isinstance(ref.get("hash"), str):
        return [ref]
    return []


def buffer_hook(msg: dict) -> dict | None:
    """Attach ``buffers=[bytes]`` to outgoing messages that reference a
    blob we previously stashed. Return ``None`` if we sent it ourselves.
    """
    try:
        msg_type = msg.get("header", {}).get("msg_type", "")
        if msg_type not in ("display_data", "update_display_data", "execute_result"):
            return msg

        data = msg.get("content", {}).get("data") or {}
        ref_raw = data.get(BLOB_REF_MIME)
        if ref_raw is None:
            return msg

        # Data values are JSON-cleaned before the hook runs; tolerate
        # both dict (ordinary) and str (some legacy paths) shapes.
        if isinstance(ref_raw, dict):
            ref = ref_raw
        elif isinstance(ref_raw, str):
            try:
                ref = json.loads(ref_raw)
            except json.JSONDecodeError:
                return msg
        else:
            return msg

        if not isinstance(ref, dict):
            return msg

        entries = _ref_entries(ref)
        if not entries:
            return msg

        hashes = [entry.get("hash") for entry in entries]
        if not all(isinstance(h, str) for h in hashes):
            return msg

        pending = pending_buffers()
        if not all(h in pending for h in hashes):
            # No stashed payload for this hash — maybe a re-publish of a
            # historical message, or a ref emitted outside our formatter.
            # Pass through unchanged; the daemon can still resolve via the
            # blob store if it already has the hash.
            return msg
        # Multiple logical buffers may contain identical bytes and therefore
        # share a content hash. Read all frames before deleting unique hashes.
        buffers = [pending[h] for h in hashes if isinstance(h, str)]
        for h in set(hashes):
            if isinstance(h, str):
                pending.pop(h, None)
        for index, entry in enumerate(entries):
            entry["buffer_index"] = index

        pub = _pub_for_msg_type(msg_type)
        if pub is None:
            return msg

        pub.session.send(
            pub.pub_socket,
            msg,
            ident=pub.topic,
            buffers=buffers,
        )
        return None
    except Exception as exc:  # noqa: BLE001
        # Never let a hook error mask the underlying output.
        log.debug("buffer_hook error: %s — falling back to default send", exc)
        return msg


# Tag the callable so re-installs can detect us without stacking duplicates.
buffer_hook._nteract_installed = True


def install(ip: Any) -> None:
    """Register ``buffer_hook`` on both seats — display_pub and displayhook.

    Idempotent: if a previously installed copy is tagged with
    ``_nteract_installed``, skip.
    """
    for pub in (ip.display_pub, ip.displayhook):
        existing = list(getattr(pub, "_hooks", []))
        if any(getattr(h, "_nteract_installed", False) for h in existing):
            continue
        register = getattr(pub, "register_hook", None)
        if register is not None:
            register(buffer_hook)
