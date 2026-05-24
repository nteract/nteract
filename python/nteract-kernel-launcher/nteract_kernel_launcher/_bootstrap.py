"""IPython extension — the launcher-hosted bootstrap.

Loaded automatically via ``NteractKernelApp.default_extensions`` before any
user code runs. Four things happen on ``load_ipython_extension``:

1. A ``text/llm+plain`` formatter is registered for objects that expose
   ``_repr_llm_``. This mirrors the original ``repr_llm`` convention while
   keeping the launcher self-contained.

2. Generic Arrow stream MIME formatters look for ``__arrow_c_stream__`` on
   every object. pandas, polars, pyarrow, narwhals, and other producers that
   implement the PyCapsule protocol all flow through the same path. The only
   dotted type registrations left are for HuggingFace datasets, where nteract
   adds dataset-specific summary semantics.

3. :func:`_buffer_hook.install` registers the single buffer-attachment
   hook on *both* ``ip.display_pub`` and ``ip.displayhook``. With the
   hook chain in place on both seats, ``execute_result`` (bare ``df``
   on last line) and ``display_data`` / ``update_display_data`` all
   pick up table buffers from the same pending-bytes stash.

4. Third-party visualization libraries (altair, plotly) are flipped to
   their ``"nteract"`` renderer if they happen to be importable. Each
   is guarded so the bootstrap stays a no-op in minimal envs.

No ``ipython_display_formatter`` handlers. The dx wheel needed one to
divert bare-``df``-on-last-line from the bufferless displayhook path
to ``publish_display_data`` (where the publisher hook could attach
buffers). With the ``NteractShellDisplayHook`` hook chain, the default
displayhook path carries buffers natively — the short-circuit becomes
unnecessary.
"""

from __future__ import annotations

import hashlib
import logging
import os
import threading
from collections.abc import Callable
from typing import Any

from IPython.core.formatters import BaseFormatter
from traitlets import ObjectName, Unicode

from nteract_kernel_launcher import _buffer_hook, _traceback
from nteract_kernel_launcher._buffer_hook import pending_buffers
from nteract_kernel_launcher._format import (
    ARROW_STREAM_MANIFEST_MIME,
    ARROW_STREAM_MIME,
    DEFAULT_ARROW_CHUNK_BYTES,
    arrow_stream_row_count,
    build_arrow_stream_manifest,
    build_arrow_stream_manifest_from_chunks,
    has_arrow_stream_protocol,
    iter_arrow_stream_chunks,
)
from nteract_kernel_launcher._refs import (
    BLOB_REF_MIME,
    BlobRef,
    build_multi_ref_bundle,
    build_ref_bundle,
)
from nteract_kernel_launcher._summary import summarize_dataframe, summarize_dataset

log = logging.getLogger("nteract_kernel_launcher")

# Server-side blob ceiling is ~100 MiB; leave ~10 MiB for overhead.
_MAX_PAYLOAD_BYTES = int(os.environ.get("DX_MAX_PAYLOAD_BYTES", str(90 * 1024 * 1024)))


class LLMFormatter(BaseFormatter):
    """Formatter for plaintext LLM representations.

    Objects can opt in by defining ``_repr_llm_``. Callers may also use the
    inherited ``for_type`` / ``for_type_by_name`` registration APIs.
    """

    format_type = Unicode("text/llm+plain")
    print_method = ObjectName("_repr_llm_")

    def __init__(self, *args, arrow_state: _ArrowFormatterState | None = None, **kwargs):
        super().__init__(*args, **kwargs)
        self._arrow_state = arrow_state

    def __call__(self, obj: Any) -> Any:
        data = super().__call__(obj)
        if data is not None or self._arrow_state is None:
            return data
        return self._arrow_state.value_for(obj, "text/llm+plain")


class ArrowBlobRefFormatter(BaseFormatter):
    """Per-MIME formatter that emits nteract blob refs for Arrow streams."""

    format_type = Unicode(BLOB_REF_MIME)

    def __init__(self, *args, arrow_state: _ArrowFormatterState, **kwargs):
        super().__init__(*args, **kwargs)
        self._arrow_state = arrow_state

    def __call__(self, obj: Any) -> Any:
        if not self.enabled:
            return None
        try:
            printer = self.lookup(obj)
        except KeyError:
            return self._arrow_state.value_for(obj, BLOB_REF_MIME)
        return printer(obj)


class ArrowStreamManifestFormatter(BaseFormatter):
    """Per-MIME formatter that emits Arrow stream manifests."""

    format_type = Unicode(ARROW_STREAM_MANIFEST_MIME)

    def __init__(self, *args, arrow_state: _ArrowFormatterState, **kwargs):
        super().__init__(*args, **kwargs)
        self._arrow_state = arrow_state

    def __call__(self, obj: Any) -> Any:
        if not self.enabled:
            return None
        try:
            printer = self.lookup(obj)
        except KeyError:
            return self._arrow_state.value_for(obj, ARROW_STREAM_MANIFEST_MIME)
        return printer(obj)


class _ArrowFormatterState:
    """Share one serialized Arrow bundle across per-MIME formatter calls."""

    def __init__(self) -> None:
        self._tls = threading.local()

    def _cached_bundle(self, obj: Any) -> dict[str, Any] | None:
        cache = getattr(self._tls, "cache", None)
        if isinstance(cache, dict) and cache.get("obj") is obj:
            bundle = cache.get("bundle")
            return bundle if isinstance(bundle, dict) else None
        return None

    def _set_cache(self, obj: Any, bundle: dict[str, Any]) -> None:
        self._tls.cache = {
            "obj": obj,
            "bundle": bundle,
            "remaining": {
                mime
                for mime in (BLOB_REF_MIME, ARROW_STREAM_MANIFEST_MIME, "text/llm+plain")
                if mime in bundle
            },
        }

    def _mark_used(self, obj: Any, mime: str) -> None:
        cache = getattr(self._tls, "cache", None)
        if not isinstance(cache, dict) or cache.get("obj") is not obj:
            return
        remaining = cache.get("remaining")
        if isinstance(remaining, set):
            remaining.discard(mime)
            if not remaining:
                self._tls.cache = None

    def value_for(self, obj: Any, mime: str) -> Any | None:
        bundle = self._cached_bundle(obj)
        if bundle is None:
            bundle = _arrow_stream_mimebundle(obj)
            if not bundle:
                return None
            self._set_cache(obj, bundle)
        value = bundle.get(mime)
        self._mark_used(obj, mime)
        return value


def _arrow_state_for(ip: Any) -> _ArrowFormatterState:
    display_formatter = ip.display_formatter
    state = getattr(display_formatter, "_nteract_arrow_state", None)
    if not isinstance(state, _ArrowFormatterState):
        state = _ArrowFormatterState()
        display_formatter._nteract_arrow_state = state
    return state


# ─── formatters ──────────────────────────────────────────────────────────


def _arrow_stream_mimebundle(source: Any, include=None, exclude=None) -> dict | None:
    return _emit_arrow_stream(source)


def _dataset_mimebundle(ds: Any, include=None, exclude=None) -> dict | None:
    """Emit Arrow IPC bytes + HF features summary for a ``datasets.Dataset``.

    The underlying ``ds.data.table`` carries the ``huggingface`` schema KV
    metadata that Sift uses to detect rich types (Image, ClassLabel,
    Translation, …). Going through the arrow table preserves that metadata
    end-to-end. When no underlying table is available (IterableDataset,
    streaming, …), fall back to the legacy summary-only bundle so the
    formatter stays best-effort.
    """
    table = getattr(getattr(ds, "data", None), "table", None)
    summary = lambda: summarize_dataset(ds)  # noqa: E731

    if table is None:
        try:
            return {"text/llm+plain": summary()}
        except Exception as exc:  # noqa: BLE001
            log.debug("dataset mimebundle failed: %s", exc)
            return None

    total_rows = getattr(ds, "num_rows", table.num_rows)
    if not isinstance(total_rows, int):
        total_rows = table.num_rows
    return _emit_arrow_table(table, total_rows=total_rows, summary_fn=summary)


def _emit_arrow_stream(
    source: Any,
    *,
    total_rows: int | None = None,
    summary_fn: Callable[..., str] | None = None,
) -> dict | None:
    """Serialize any Arrow stream producer into a nteract output bundle."""
    if not has_arrow_stream_protocol(source):
        return None

    try:
        chunks = list(
            iter_arrow_stream_chunks(
                source,
                max_chunk_bytes=min(DEFAULT_ARROW_CHUNK_BYTES, _MAX_PAYLOAD_BYTES),
            )
        )
    except Exception as exc:  # noqa: BLE001
        log.debug("arrow stream emit failed: %s", exc)
        return None

    included_rows = sum(chunk.row_count for chunk in chunks)
    if total_rows is None:
        total_rows = arrow_stream_row_count(source)
    if total_rows is None:
        total_rows = included_rows

    def _summary(included: int, sampled: bool) -> str:
        if summary_fn is not None:
            try:
                return summary_fn(included, sampled)
            except TypeError:
                return summary_fn()
        return _summarize_arrow_source(
            source,
            total_rows=total_rows,
            included_rows=included,
            sampled=sampled,
        )

    if len(chunks) == 1:
        chunk = chunks[0]
        return _emit_table_bytes(
            chunk.data,
            content_type=ARROW_STREAM_MIME,
            total_rows=total_rows,
            included_rows=included_rows,
            record_batch_count=chunk.record_batch_count,
            summary_fn=_summary,
        )

    return _emit_arrow_stream_chunks(
        chunks,
        total_rows=total_rows,
        summary_fn=_summary,
    )


def _emit_arrow_stream_chunks(
    chunks: list[Any],
    *,
    total_rows: int,
    summary_fn: Callable[[int, bool], str],
) -> dict:
    """Emit a complete multi-chunk Arrow stream manifest."""
    if not chunks:
        raise ValueError("at least one Arrow stream chunk is required")
    included_rows = sum(chunk.row_count for chunk in chunks)
    sampled = included_rows != total_rows
    llm_text: str | None = None
    try:
        llm_text = summary_fn(included_rows, sampled)
    except Exception as exc:  # noqa: BLE001
        log.debug("summary build failed: %s", exc)

    summary_hints = {
        "total_rows": total_rows,
        "included_rows": included_rows,
        "sampled": sampled,
        "sample_strategy": "head" if sampled else "none",
    }
    refs = [BlobRef(hash=chunk.content_hash, size=chunk.size) for chunk in chunks]
    bundle: dict[str, Any] = {
        BLOB_REF_MIME: build_multi_ref_bundle(
            refs,
            content_type=ARROW_STREAM_MIME,
            summary=summary_hints,
        ),
        ARROW_STREAM_MANIFEST_MIME: build_arrow_stream_manifest_from_chunks(
            chunks,
            complete=True,
            summary=summary_hints,
        ),
    }
    if llm_text is not None:
        bundle["text/llm+plain"] = llm_text

    pending = pending_buffers()
    for chunk in chunks:
        pending[chunk.content_hash] = chunk.data
    return bundle


def _emit_arrow_table(
    table: Any,
    *,
    total_rows: int,
    summary_fn: Callable[[], str] | None = None,
) -> dict | None:
    """Compatibility wrapper for dataset-backed Arrow tables."""
    return _emit_arrow_stream(table, total_rows=total_rows, summary_fn=summary_fn)


def _summary_source(source: Any) -> Any:
    to_native = getattr(source, "to_native", None)
    if callable(to_native):
        try:
            native = to_native()
            if native is not source:
                return native
        except Exception as exc:  # noqa: BLE001
            log.debug("to_native summary unwrap failed: %s", exc)
    return source


def _summarize_arrow_source(
    source: Any, *, total_rows: int, included_rows: int, sampled: bool
) -> str:
    source = _summary_source(source)
    try:
        import pyarrow as pa

        if isinstance(source, pa.Table):
            return _summarize_arrow_table(
                source,
                total_rows=total_rows,
                included_rows=included_rows,
                sampled=sampled,
            )
        if isinstance(source, pa.RecordBatch):
            table = pa.Table.from_batches([source])
            return _summarize_arrow_table(
                table,
                total_rows=total_rows,
                included_rows=included_rows,
                sampled=sampled,
            )
    except Exception as exc:  # noqa: BLE001
        log.debug("pyarrow summary conversion failed: %s", exc)

    try:
        return summarize_dataframe(
            source,
            total_rows=total_rows,
            included_rows=included_rows,
            sampled=sampled,
        )
    except Exception as exc:  # noqa: BLE001
        log.debug("dataframe summary failed: %s", exc)
        return f"Arrow stream table: {included_rows} rows"


def _summarize_arrow_table(
    table: Any, *, total_rows: int, included_rows: int, sampled: bool
) -> str:
    """Summary for a ``pa.Table`` — convert head to pandas, reuse summarizer.

    Cheap for the typical display case (modest row counts). Heavy tables
    pay a one-time conversion of the head sample, which is bounded.
    """
    head_n = 50
    head = table.slice(0, head_n).to_pandas()
    return summarize_dataframe(
        head, total_rows=total_rows, included_rows=included_rows, sampled=sampled
    )


def _emit_table_bytes(
    data: bytes,
    *,
    content_type: str,
    total_rows: int,
    included_rows: int,
    record_batch_count: int | None = None,
    summary_fn: Callable[[int, bool], str],
) -> dict:
    """Stash bytes, build the ref bundle, attach a summary.

    ``summary_fn`` receives ``(included_rows, sampled)`` so per-domain
    summaries can name the sampling state honestly.
    """
    sampled = included_rows != total_rows
    llm_text: str | None = None
    try:
        llm_text = summary_fn(included_rows, sampled)
    except Exception as exc:  # noqa: BLE001
        log.debug("summary build failed: %s", exc)

    h = hashlib.sha256(data).hexdigest()
    ref = BlobRef(hash=h, size=len(data))
    summary_hints = {
        "total_rows": total_rows,
        "included_rows": included_rows,
        "sampled": sampled,
        "sample_strategy": "head" if sampled else "none",
    }
    ref_bundle = build_ref_bundle(ref, content_type=content_type, summary=summary_hints)
    ref_bundle["buffer_index"] = 0

    bundle: dict[str, Any] = {BLOB_REF_MIME: ref_bundle}
    if content_type == ARROW_STREAM_MIME:
        try:
            bundle[ARROW_STREAM_MANIFEST_MIME] = build_arrow_stream_manifest(
                data,
                content_hash=h,
                content_size=len(data),
                row_count=included_rows,
                record_batch_count=record_batch_count,
                summary=summary_hints,
            )
        except Exception as exc:  # noqa: BLE001
            log.debug("arrow manifest build failed: %s", exc)
    if llm_text is not None:
        bundle["text/llm+plain"] = llm_text

    pending_buffers()[h] = data
    return bundle


# ─── Install functions — called from load_ipython_extension ───────────────


def _install_llm_formatter(ip: Any) -> BaseFormatter | None:
    """Register ``text/llm+plain`` support for ``_repr_llm_`` objects."""
    display_formatter = getattr(ip, "display_formatter", None)
    formatters = getattr(display_formatter, "formatters", None)
    if not isinstance(formatters, dict):
        return None
    arrow_state = _arrow_state_for(ip)

    existing = formatters.get("text/llm+plain")
    if existing is not None:
        if isinstance(existing, LLMFormatter) and existing._arrow_state is None:
            existing._arrow_state = arrow_state
        return existing

    llm_formatter = LLMFormatter(parent=display_formatter, arrow_state=arrow_state)
    formatters["text/llm+plain"] = llm_formatter
    return llm_formatter


def _install_dataframe_formatters(ip: Any) -> None:
    """Install generic Arrow stream formatters and dataset summaries."""
    display_formatter = ip.display_formatter
    formatters = getattr(display_formatter, "formatters", None)
    if isinstance(formatters, dict):
        arrow_state = _arrow_state_for(ip)
        if not isinstance(formatters.get(BLOB_REF_MIME), ArrowBlobRefFormatter):
            formatters[BLOB_REF_MIME] = ArrowBlobRefFormatter(
                parent=display_formatter,
                arrow_state=arrow_state,
            )
        if not isinstance(
            formatters.get(ARROW_STREAM_MANIFEST_MIME),
            ArrowStreamManifestFormatter,
        ):
            formatters[ARROW_STREAM_MANIFEST_MIME] = ArrowStreamManifestFormatter(
                parent=display_formatter,
                arrow_state=arrow_state,
            )

    mimebundle = ip.display_formatter.mimebundle_formatter

    # Datasets remain type-registered because they add HuggingFace feature
    # summaries in addition to the generic Arrow stream payload.
    for module_path, type_name, fn in (
        ("datasets.arrow_dataset", "Dataset", _dataset_mimebundle),
        ("datasets.iterable_dataset", "IterableDataset", _dataset_mimebundle),
    ):
        try:
            mimebundle.for_type_by_name(module_path, type_name, fn)
        except Exception as exc:  # noqa: BLE001
            log.debug("for_type_by_name(%s.%s) failed: %s", module_path, type_name, exc)


def _install_buffer_hooks(ip: Any) -> None:
    """Delegate to :mod:`_buffer_hook` — registers on both seats."""
    _buffer_hook.install(ip)


def _enable_third_party_renderers() -> None:
    """Flip altair / plotly to their ``"nteract"`` renderer if present.

    ImportError-guarded; safe in a minimal env. Non-ImportError failures
    get logged at debug level — a missing renderer shouldn't crash the
    kernel startup.
    """
    try:
        import altair as alt  # ty: ignore[unresolved-import]

        alt.renderers.enable("nteract")
        log.debug("enabled altair 'nteract' renderer")
    except ImportError:
        pass
    except Exception as exc:  # noqa: BLE001
        log.debug("altair 'nteract' renderer enable failed: %s", exc)

    try:
        import plotly.io as pio

        pio.renderers.default = "nteract"
        log.debug("set plotly default renderer to 'nteract'")
    except ImportError:
        pass
    except Exception as exc:  # noqa: BLE001
        log.debug("plotly 'nteract' renderer set failed: %s", exc)


# ─── IPython extension contract ────────────────────────────────────────────


def load_ipython_extension(ip: Any) -> None:
    """Entry point invoked by ``ExtensionManager.load_extension``.

    Failures here are log-warned by IPython rather than raised, so a
    missing dependency never presents as a traceback to the user. We
    further guard each install step so a single failure doesn't abort
    the others.
    """
    try:
        _install_llm_formatter(ip)
    except Exception as exc:  # noqa: BLE001
        log.warning("LLM formatter install failed: %s", exc)

    try:
        _install_dataframe_formatters(ip)
    except Exception as exc:  # noqa: BLE001
        log.warning("dataframe formatter install failed: %s", exc)

    try:
        _install_buffer_hooks(ip)
    except Exception as exc:  # noqa: BLE001
        log.warning("buffer hook install failed: %s", exc)

    try:
        _enable_third_party_renderers()
    except Exception as exc:  # noqa: BLE001
        log.warning("third-party renderer enable failed: %s", exc)

    # Traceback install goes last so earlier failures can't prevent it.
    # The wrapper itself is bulletproof — see `_traceback.install`.
    try:
        _traceback.install(ip)
    except Exception as exc:  # noqa: BLE001
        log.warning("traceback install failed: %s", exc)


def unload_ipython_extension(ip: Any) -> None:
    """Best-effort symmetry with ``load``. Kernel teardown tears the
    process down, so precise reversal isn't load-bearing — but leaving
    this defined keeps ``%reload_ext nteract_kernel_launcher._bootstrap``
    well-behaved during dev iteration.
    """
    try:
        for pub in (ip.display_pub, ip.displayhook):
            hooks = list(getattr(pub, "_hooks", []))
            for h in hooks:
                if getattr(h, "_nteract_installed", False):
                    unregister = getattr(pub, "unregister_hook", None)
                    if unregister is not None:
                        unregister(h)
    except Exception as exc:  # noqa: BLE001
        log.debug("unload cleanup: %s", exc)
