"""IPython extension — the launcher-hosted bootstrap.

Loaded automatically via ``NteractKernelApp.default_extensions`` before any
user code runs. Four things happen on ``load_ipython_extension``:

1. A ``text/llm+plain`` formatter is registered for objects that expose
   ``_repr_llm_``. This mirrors the original ``repr_llm`` convention while
   keeping the launcher self-contained.

2. ``mimebundle_formatter`` entries for pandas / polars / narwhals /
   datasets are registered by **dotted type name** (no eager imports).
   IPython binds them lazily on first encounter — dx's historical
   ``import pandas as pd`` at install time becomes unnecessary.

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
from collections.abc import Callable
from typing import Any

from IPython.core.formatters import BaseFormatter
from traitlets import ObjectName, Unicode

from nteract_kernel_launcher import _buffer_hook, _traceback
from nteract_kernel_launcher._buffer_hook import pending_buffers
from nteract_kernel_launcher._format import serialize_arrow_table, serialize_dataframe
from nteract_kernel_launcher._refs import BLOB_REF_MIME, BlobRef, build_ref_bundle
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


# ─── mimebundle formatters (lazy-bound via for_type_by_name) ──────────────


def _pandas_mimebundle(df: Any, include=None, exclude=None) -> dict | None:
    return _emit_dataframe(df, total_rows=len(df))


def _polars_mimebundle(df: Any, include=None, exclude=None) -> dict | None:
    return _emit_dataframe(df, total_rows=df.height)


def _narwhals_mimebundle(df: Any, include=None, exclude=None) -> dict | None:
    native, total_rows = _unwrap_narwhals(df)
    if native is None:
        return None
    return _emit_dataframe(native, total_rows=total_rows)


def _pyarrow_table_mimebundle(table: Any, include=None, exclude=None) -> dict | None:
    return _emit_arrow_table(table, total_rows=table.num_rows)


def _pyarrow_record_batch_mimebundle(batch: Any, include=None, exclude=None) -> dict | None:
    import pyarrow as pa

    table = pa.Table.from_batches([batch])
    return _emit_arrow_table(table, total_rows=table.num_rows)


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


def _unwrap_narwhals(nw_df: Any) -> tuple[Any, int] | tuple[None, int]:
    """Return ``(native_df, row_count)`` for a ``narwhals.DataFrame``.

    Fast path: native is pandas or polars — pass through. Fallback:
    round-trip via ``.to_pandas()`` for any backend narwhals understands
    (pyarrow, modin, dask, cudf). ``LazyFrame`` isn't handled here —
    displaying a lazy query would force ``.collect()``, which has side
    effects.
    """
    try:
        native = nw_df.to_native()
    except Exception as exc:  # noqa: BLE001
        log.debug("narwhals to_native failed: %s", exc)
        return None, 0

    try:
        import pandas as pd

        if isinstance(native, pd.DataFrame):
            return native, len(native)
    except ImportError:
        pass
    try:
        import polars as pl

        if isinstance(native, pl.DataFrame):
            return native, native.height
    except ImportError:
        pass

    try:
        as_pandas = nw_df.to_pandas()
        return as_pandas, len(as_pandas)
    except Exception as exc:  # noqa: BLE001
        log.debug("narwhals to_pandas failed: %s", exc)
        return None, 0


def _emit_dataframe(df: Any, *, total_rows: int) -> dict | None:
    """Serialize → stash bytes keyed by sha256 → return ref-mime bundle.

    When Arrow IPC serialization fails (e.g. pyarrow missing), fall back to
    a summary-only ``text/llm+plain`` bundle so agents still get column
    stats instead of a raw repr. IPython's default formatter chain merges
    pandas' ``text/html`` / ``text/plain`` on top for host-side fallback.
    """
    try:
        data, content_type, included_rows = serialize_dataframe(df, max_bytes=_MAX_PAYLOAD_BYTES)
    except Exception as exc:  # noqa: BLE001
        log.debug("serialize failed: %s — emitting summary-only bundle", exc)
        try:
            llm = summarize_dataframe(
                df, total_rows=total_rows, included_rows=total_rows, sampled=False
            )
            return {"text/llm+plain": llm}
        except Exception:  # noqa: BLE001
            return None

    return _emit_table_bytes(
        data,
        content_type=content_type,
        total_rows=total_rows,
        included_rows=included_rows,
        summary_fn=lambda included, sampled: summarize_dataframe(
            df, total_rows=total_rows, included_rows=included, sampled=sampled
        ),
    )


def _emit_arrow_table(
    table: Any,
    *,
    total_rows: int,
    summary_fn: Callable[[], str] | None = None,
) -> dict | None:
    """Serialize a ``pa.Table`` to Arrow IPC, preserving schema KV metadata.

    Distinct from :func:`_emit_dataframe` because the dataframe path runs
    bytes through the Arrow PyCapsule stream protocol or a ``pa.Table`` fallback,
    so the ``huggingface`` key survives for Sift's rich-type detection.

    ``summary_fn`` lets callers (notably ``_dataset_mimebundle``) provide
    a richer per-domain summary (HF features) instead of the generic
    pandas-style preview.
    """
    try:
        data, content_type, included_rows = serialize_arrow_table(
            table, max_bytes=_MAX_PAYLOAD_BYTES
        )
    except Exception as exc:  # noqa: BLE001
        log.debug("arrow serialize failed: %s — emitting summary-only bundle", exc)
        if summary_fn is not None:
            try:
                return {"text/llm+plain": summary_fn()}
            except Exception:  # noqa: BLE001
                return None
        return None

    def _summary(included: int, sampled: bool) -> str:
        if summary_fn is not None:
            return summary_fn()
        return _summarize_arrow_table(
            table, total_rows=total_rows, included_rows=included, sampled=sampled
        )

    return _emit_table_bytes(
        data,
        content_type=content_type,
        total_rows=total_rows,
        included_rows=included_rows,
        summary_fn=_summary,
    )


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
    summary_fn: Callable[[int, bool], str],
) -> dict:
    """Stash bytes, build the ref bundle, attach a summary.

    ``summary_fn`` receives ``(included_rows, sampled)`` so per-domain
    summaries can name the sampling state honestly.
    """
    sampled = included_rows != total_rows

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
    try:
        bundle["text/llm+plain"] = summary_fn(included_rows, sampled)
    except Exception as exc:  # noqa: BLE001
        log.debug("summary build failed: %s", exc)

    pending_buffers()[h] = data
    return bundle


# ─── Install functions — called from load_ipython_extension ───────────────


def _install_llm_formatter(ip: Any) -> BaseFormatter | None:
    """Register ``text/llm+plain`` support for ``_repr_llm_`` objects."""
    display_formatter = getattr(ip, "display_formatter", None)
    formatters = getattr(display_formatter, "formatters", None)
    if not isinstance(formatters, dict):
        return None

    existing = formatters.get("text/llm+plain")
    if existing is not None:
        return existing

    llm_formatter = LLMFormatter(parent=display_formatter)
    formatters["text/llm+plain"] = llm_formatter
    return llm_formatter


def _install_dataframe_formatters(ip: Any) -> None:
    """Register mimebundle formatters lazily via ``for_type_by_name``.

    IPython's ``for_type_by_name`` keys on ``type.__module__`` + class
    name. Library-by-library that's:

    - pandas: ``pandas`` (pandas sets ``DataFrame.__module__ = "pandas"``)
    - polars: ``polars.dataframe.frame``
    - narwhals: ``narwhals.dataframe``
    - pyarrow: ``pyarrow.lib`` (Table / RecordBatch are C-extension types)
    - datasets: ``datasets.arrow_dataset`` / ``datasets.iterable_dataset``

    We register the definitive module each library stamps on the class,
    plus a short-name fallback for pandas/polars/narwhals/pyarrow. Short
    names cover both conservative stamping by the library and any future
    flattening. Registration is cheap and idempotent, so the spray
    costs nothing.
    """
    mimebundle = ip.display_formatter.mimebundle_formatter

    # (module_path, type_name, formatter). Keep definitive entries first so
    # a first-dispatch lookup short-circuits before the fallbacks matter.
    for module_path, type_name, fn in (
        # pandas — public DataFrame ships with __module__ == "pandas".
        ("pandas", "DataFrame", _pandas_mimebundle),
        ("pandas.core.frame", "DataFrame", _pandas_mimebundle),
        # polars — class module is the deep path; register both.
        ("polars.dataframe.frame", "DataFrame", _polars_mimebundle),
        ("polars", "DataFrame", _polars_mimebundle),
        # narwhals — class lives in narwhals.dataframe.
        ("narwhals.dataframe", "DataFrame", _narwhals_mimebundle),
        ("narwhals", "DataFrame", _narwhals_mimebundle),
        # pyarrow — Table / RecordBatch are stamped to pyarrow.lib by
        # the C extension. Preserves schema KV metadata end-to-end so
        # Sift's HF rich-type detection lights up for Arrow-native tables.
        ("pyarrow.lib", "Table", _pyarrow_table_mimebundle),
        ("pyarrow", "Table", _pyarrow_table_mimebundle),
        ("pyarrow.lib", "RecordBatch", _pyarrow_record_batch_mimebundle),
        ("pyarrow", "RecordBatch", _pyarrow_record_batch_mimebundle),
        # datasets — materialized datasets can emit parquet; iterable
        # datasets fall back to summary-only because they have no table.
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
