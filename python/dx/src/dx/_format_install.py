"""DataFrame display wiring for ``dx.install()``.

Three IPython extension points, each via documented public ``for_type``
registration or hook API — no internals are patched:

1. A ``mimebundle_formatter`` for Arrow-stream-capable table objects serializes
   the stream to Arrow IPC, hashes locally, stashes the bytes in a
   thread-local keyed by hash, and returns
   ``{BLOB_REF_MIME: {...}, "text/llm+plain": ...}``. IPython's default
   chain then merges pandas' ``text/html`` and ``text/plain`` so hosts
   that don't understand the ref MIME still render normally.

2. A ``ZMQDisplayPublisher.register_hook`` callback attaches the
   stashed bytes to every outgoing ``display_data`` / ``update_display_data``
   message whose bundle carries the ref MIME. The hook pops the bytes
   by hash and calls ``session.send(..., buffers=[arrow])`` directly,
   returning ``None`` so the default (buffer-less) send is skipped.
   This is why ``h.update(df2)`` on a ``DisplayHandle`` works — the
   hook fires on updates just like initial displays, with
   ``transient.display_id`` already populated on the message.

3. ``ipython_display_formatter`` handlers for Arrow-stream-capable
   DataFrames handle the **last-expression** case (``df`` at the end
   of a cell, not wrapped in ``display()``). That path goes through
   ``ZMQShellDisplayHook``, which has no ``register_hook`` equivalent —
   the publisher hook alone can't attach buffers to the resulting
   ``execute_result`` message, and the daemon would drop the
   ``BLOB_REF_MIME`` as an unresolvable ref.

   ``IPythonDisplayFormatter`` gets checked first inside
   ``DisplayFormatter.format()`` — if our handler returns truthy,
   ``format()`` short-circuits to ``({}, {})`` and the displayhook's
   send is skipped (guarded by ``if format_dict:`` in ``write_format_data``
   and ``if msg["content"]["data"]:`` in ``finish_displayhook``). Our
   handler then calls ``publish_display_data`` directly, which flows
   through ``display_pub.publish`` → the publisher hook (step 2) →
   buffers attached. **Net result: a single ``display_data`` message
   instead of a bufferless ``execute_result``.** The cell's ``_`` /
   ``__`` / ``___`` and ``ExecutionResult`` bookkeeping still update
   normally — they happen at separate steps of ``DisplayHook.__call__``.

All three extension points are documented public API
(``ipython_display_formatter.for_type``, ``mimebundle_formatter.for_type``,
``ZMQDisplayPublisher.register_hook``).
"""

from __future__ import annotations

import logging
import os
import threading
from typing import Any

from dx._env import Environment, detect_environment
from dx._format import (
    ARROW_STREAM_MANIFEST_MIME,
    ARROW_STREAM_MIME,
    DEFAULT_ARROW_CHUNK_BYTES,
    build_arrow_stream_manifest_from_chunks,
    has_arrow_stream_protocol,
    iter_arrow_stream_chunks,
)
from dx._refs import BLOB_REF_MIME, BlobRef, build_multi_ref_bundle, build_ref_bundle
from dx._summary import summarize_dataframe, summarize_dataset

log = logging.getLogger("dx")

_INSTALLED = False

# Payload ceiling enforced on the kernel side. Server-side MAX_BLOB_SIZE is
# 100 MiB; leave ~10 MiB for overhead and safety.
_MAX_PAYLOAD_BYTES = int(os.environ.get("DX_MAX_PAYLOAD_BYTES", str(90 * 1024 * 1024)))

# Pending Arrow bytes waiting to be attached to the next IOPub message
# that references them. Keyed by content hash (hex SHA-256) so lookups
# match the ref MIME's ``hash`` field. Thread-local: each execution
# context owns its own pending slot.
_pending = threading.local()


def _pending_buffers() -> dict[str, bytes]:
    if not hasattr(_pending, "buffers"):
        _pending.buffers = {}
    return _pending.buffers


def _get_ipython_for_format() -> Any | None:
    """Extracted for test monkeypatching."""
    try:
        from IPython import get_ipython as _gi
    except ImportError:
        return None
    return _gi()


def _display_pub() -> Any | None:
    """Return the kernel's ``ZMQDisplayPublisher`` instance if we're in a
    kernel, else ``None``. The publisher has ``register_hook`` and
    ``session`` / ``pub_socket`` / ``topic`` attributes we need."""
    ip = _get_ipython_for_format()
    if ip is None:
        return None
    pub = getattr(ip, "display_pub", None)
    if pub is None:
        return None
    # The in-process (plain IPython) DisplayPublisher doesn't have
    # ``register_hook`` or ``session`` / ``pub_socket`` — only the kernel
    # subclass does. Probe for the kernel-specific surface.
    if not all(hasattr(pub, attr) for attr in ("register_hook", "session", "pub_socket")):
        return None
    return pub


def install_formatters() -> None:
    global _INSTALLED
    if _INSTALLED:
        return

    if detect_environment() != Environment.IPYKERNEL:
        log.debug("dx: not running under ipykernel — formatters fall back to default chain.")

    ip = _get_ipython_for_format()
    if ip is None:
        _INSTALLED = True
        return

    # IPython's InteractiveShell exposes DisplayFormatter as an attribute,
    # not a method — do not call it.
    mimebundle = ip.display_formatter.mimebundle_formatter
    ipython_display = ip.display_formatter.ipython_display_formatter

    try:
        import pandas as pd

        mimebundle.for_type(pd.DataFrame, _arrow_stream_mimebundle)
        ipython_display.for_type(pd.DataFrame, _arrow_stream_ipython_display)
    except ImportError:
        pass

    try:
        import polars as pl

        mimebundle.for_type(pl.DataFrame, _arrow_stream_mimebundle)
        ipython_display.for_type(pl.DataFrame, _arrow_stream_ipython_display)
    except ImportError:
        pass

    try:
        import narwhals as nw

        mimebundle.for_type(nw.DataFrame, _arrow_stream_mimebundle)
        ipython_display.for_type(nw.DataFrame, _arrow_stream_ipython_display)
    except ImportError:
        pass

    try:
        import pyarrow as pa

        for cls in (pa.Table, pa.RecordBatch, pa.RecordBatchReader):
            mimebundle.for_type(cls, _arrow_stream_mimebundle)
            ipython_display.for_type(cls, _arrow_stream_ipython_display)
    except ImportError:
        pass

    try:
        import datasets  # noqa: PLC0415

        mimebundle.for_type(datasets.Dataset, _dataset_mimebundle)
        ipython_display.for_type(datasets.Dataset, _dataset_ipython_display)
    except ImportError:
        log.debug("dx: datasets not installed, skipping handler")

    _install_display_pub_hook()
    _enable_third_party_nteract_renderers()

    _INSTALLED = True


def _install_display_pub_hook() -> None:
    """Install ``_dx_display_pub_hook`` on the kernel's display publisher.

    The hook fires for every ``display_data`` and ``update_display_data``
    message right before ``session.send`` is called — it's a documented
    public extension point on ``ipykernel.zmqshell.ZMQDisplayPublisher``.

    Idempotent: the hook function is tagged with ``_dx_installed`` so
    repeat ``install()`` calls don't stack duplicates.
    """
    pub = _display_pub()
    if pub is None:
        return
    for existing in getattr(pub, "_hooks", []):
        if getattr(existing, "_dx_installed", False):
            return
    pub.register_hook(_dx_display_pub_hook)


def _dx_display_pub_hook(msg: dict) -> dict | None:
    """Attach buffers to ``display_data`` / ``update_display_data`` messages
    whose data bundle carries our blob-ref MIME.

    Returns:
        - ``msg`` unchanged if the message isn't one of ours (pass-through).
        - ``None`` if we sent the message ourselves with buffers (tells
          ``ZMQDisplayPublisher.publish`` to skip the default send).
    """
    try:
        msg_type = msg.get("header", {}).get("msg_type", "")
        if msg_type not in ("display_data", "update_display_data"):
            return msg
        data = msg.get("content", {}).get("data") or {}
        ref_raw = data.get(BLOB_REF_MIME)
        if ref_raw is None:
            return msg

        # `data` values are JSON-cleaned at this point; the ref MIME
        # is a dict.
        if isinstance(ref_raw, dict):
            ref = ref_raw
        else:
            import json

            ref = json.loads(ref_raw) if isinstance(ref_raw, str) else None
        if not isinstance(ref, dict):
            return msg
        entries = _ref_entries(ref)
        if not entries:
            return msg

        hashes = [entry.get("hash") for entry in entries]
        if not all(isinstance(h, str) for h in hashes):
            return msg

        pending = _pending_buffers()
        if not all(h in pending for h in hashes):
            # No stashed payload for this hash — maybe re-publish of a
            # historical message, or a ref emitted by something other
            # than our formatter. Pass through unchanged; the agent can
            # still resolve via BlobStore::exists on the hash.
            return msg
        buffers = [pending.pop(h) for h in hashes if isinstance(h, str)]
        for index, entry in enumerate(entries):
            entry["buffer_index"] = index

        pub = _display_pub()
        if pub is None:
            return msg
        pub.session.send(
            pub.pub_socket,
            msg,
            ident=pub.topic,
            buffers=buffers,
        )
        return None
    except Exception as exc:
        log.debug("dx: display_pub hook error: %s — letting default send run", exc)
        return msg


_dx_display_pub_hook._dx_installed = True  # ty: ignore[unresolved-attribute]


def _ref_entries(ref: dict) -> list[dict]:
    refs = ref.get("refs")
    if isinstance(refs, list):
        return [entry for entry in refs if isinstance(entry, dict)]
    if isinstance(ref.get("hash"), str):
        return [ref]
    return []


def _arrow_stream_mimebundle(df: Any, include=None, exclude=None) -> dict | None:
    total_rows = _total_rows(df)
    return _emit_dataframe(df, total_rows=total_rows)


def _arrow_stream_ipython_display(df: Any) -> None:
    """`ipython_display_formatter` handler for Arrow stream objects.

    IPython's `DisplayFormatter.format()` checks `ipython_display_formatter`
    before walking mimebundle/per-MIME formatters. If our handler matches,
    `format()` returns `({}, {})` and the displayhook's send is suppressed.
    We publish our own `display_data` message via `publish_display_data`,
    which flows through `ZMQDisplayPublisher.publish` → the existing
    `_dx_display_pub_hook`, which attaches Arrow buffers.

    Net effect for a last-expression `df`: one `display_data` message goes
    on the wire (with buffers). No `execute_result` is emitted — the saved
    `.ipynb` records the output as `display_data`, which is valid nbformat.
    `_`, `__`, `___` and `ExecutionResult` bookkeeping still update because
    they run at steps 4–5 of `DisplayHook.__call__`, independently of the
    message send.
    """
    _publish_via_ipython_display(df)


def _total_rows(obj: Any) -> int | None:
    for attr in ("num_rows", "height"):
        value = getattr(obj, attr, None)
        if isinstance(value, int):
            return value

    shape = getattr(obj, "shape", None)
    if isinstance(shape, tuple) and shape and isinstance(shape[0], int):
        return shape[0]

    try:
        return len(obj)
    except TypeError:
        return None


def _summary_source(source: Any) -> Any:
    to_native = getattr(source, "to_native", None)
    if callable(to_native):
        try:
            native = to_native()
            if native is not source:
                return native
        except Exception as exc:
            log.debug("dx: to_native summary unwrap failed: %s", exc)
    return source


def _publish_via_ipython_display(df: Any) -> None:
    """Shared body for Arrow stream `ipython_display` handlers."""
    # Lazy import so dx.install() doesn't hard-depend on IPython being
    # importable from the install site (it already is under ipykernel,
    # but stay symmetrical with _emit_dataframe).
    try:
        from IPython.display import publish_display_data
    except ImportError:
        return

    try:
        bundle = _arrow_stream_mimebundle(df)
    except Exception as exc:
        log.debug("dx: _emit_dataframe failed: %s — falling back to repr", exc)
        bundle = None

    if bundle:
        publish_display_data(data=bundle, metadata={})
    else:
        # Fallback so a failed formatter doesn't silently eat the output.
        print(repr(df))


def _emit_dataframe(df: Any, *, total_rows: int | None) -> dict | None:
    """Serialize df → Arrow IPC, stash bytes in the pending buffer map, and
    return a mimebundle containing the ref MIME + text/llm+plain.

    IPython's default formatter chain fills in text/html / text/plain
    as a fallback bundle for hosts that don't understand the ref MIME;
    nteract frontends pick the Arrow renderer via the ref MIME.

    Returns ``None`` only when both Arrow serialization and summary
    generation fail. When Arrow serialization fails but the summary succeeds
    (e.g. pyarrow missing), returns a summary-only bundle.
    """
    if not has_arrow_stream_protocol(df):
        return None

    try:
        chunks = list(
            iter_arrow_stream_chunks(
                df,
                max_chunk_bytes=min(DEFAULT_ARROW_CHUNK_BYTES, _MAX_PAYLOAD_BYTES),
            )
        )
    except Exception as exc:
        log.debug("dx: serialize failed: %s — emitting summary-only bundle", exc)
        if total_rows is None:
            return None
        # Arrow serialization failed (e.g. pyarrow missing), but the
        # summary is pure Python — still emit text/llm+plain so the agent
        # gets column stats instead of a raw repr.
        try:
            llm = summarize_dataframe(
                df, total_rows=total_rows, included_rows=total_rows, sampled=False
            )
            return {"text/llm+plain": llm}
        except Exception:
            return None

    included = sum(chunk.row_count for chunk in chunks)
    if total_rows is None:
        total_rows = included
    sampled = included != total_rows
    summary_hints = {
        "total_rows": total_rows,
        "included_rows": included,
        "sampled": sampled,
        "sample_strategy": "head" if sampled else "none",
    }

    summary_source = _summary_source(df)
    try:
        llm = summarize_dataframe(
            summary_source,
            total_rows=total_rows,
            included_rows=included,
            sampled=sampled,
        )
    except Exception as exc:
        log.debug("dx: summary build failed: %s", exc)
        llm = f"Arrow stream table: {included} rows"

    pending = _pending_buffers()
    for chunk in chunks:
        pending[chunk.content_hash] = chunk.data

    if len(chunks) == 1:
        chunk = chunks[0]
        ref_bundle = build_ref_bundle(
            BlobRef(hash=chunk.content_hash, size=chunk.size),
            content_type=ARROW_STREAM_MIME,
            summary=summary_hints,
        )
        ref_bundle["buffer_index"] = 0
    else:
        ref_bundle = build_multi_ref_bundle(
            [BlobRef(hash=chunk.content_hash, size=chunk.size) for chunk in chunks],
            content_type=ARROW_STREAM_MIME,
            summary=summary_hints,
        )

    bundle = {BLOB_REF_MIME: ref_bundle, "text/llm+plain": llm}
    try:
        bundle[ARROW_STREAM_MANIFEST_MIME] = build_arrow_stream_manifest_from_chunks(
            chunks,
            complete=True,
            summary=summary_hints,
        )
    except Exception as exc:
        log.debug("dx: arrow manifest build failed: %s", exc)

    return bundle


def _enable_third_party_nteract_renderers() -> None:
    """Flip visualization libraries that ship an 'nteract' renderer to it.

    Each library is guarded by ImportError so install stays a no-op when
    the library isn't present. Logs (debug) which switches fired so a
    curious user can see what dx changed.
    """
    try:
        import altair as alt  # ty: ignore[unresolved-import]

        alt.renderers.enable("nteract")
        log.debug("dx: enabled altair 'nteract' renderer")
    except ImportError:
        pass
    except Exception as exc:  # pragma: no cover — defensive
        log.debug("dx: failed to enable altair 'nteract' renderer: %s", exc)

    try:
        import plotly.io as pio

        pio.renderers.default = "nteract"
        log.debug("dx: set plotly default renderer to 'nteract'")
    except ImportError:
        pass
    except Exception as exc:  # pragma: no cover — defensive
        log.debug("dx: failed to set plotly 'nteract' renderer: %s", exc)


def _dataset_mimebundle(ds: Any, include=None, exclude=None) -> dict | None:
    """`mimebundle_formatter` handler for `datasets.Dataset`.

    Returns a bundle with only `text/llm+plain` — no Arrow ref. Keeps the
    dataset lazy and lets IPython fill in `text/plain` from the dataset's
    own repr.
    """
    try:
        summary = summarize_dataset(ds)
        return {"text/llm+plain": summary}
    except Exception as exc:
        log.debug("dx: dataset mimebundle failed: %s", exc)
        return None


def _dataset_ipython_display(ds: Any) -> None:
    """`ipython_display_formatter` handler for `datasets.Dataset`.

    Publishes a `display_data` message with `text/llm+plain`, consistent
    with the DataFrame path.
    """
    try:
        from IPython.display import publish_display_data
    except ImportError:
        return

    try:
        bundle = _dataset_mimebundle(ds)
    except Exception as exc:
        log.debug("dx: dataset display failed: %s — falling back to repr", exc)
        bundle = None

    if bundle:
        publish_display_data(data=bundle, metadata={})
    else:
        print(repr(ds))


def dx_display(obj: Any) -> None:
    """Upgraded display; hands off to IPython for non-DataFrame types."""
    from IPython.display import display

    display(obj)
