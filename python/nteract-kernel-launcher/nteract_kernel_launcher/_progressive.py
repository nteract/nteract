"""Progressive Arrow stream display helpers."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from nteract_kernel_launcher._buffer_hook import pending_buffers
from nteract_kernel_launcher._format import (
    ARROW_STREAM_MANIFEST_MIME,
    ARROW_STREAM_MIME,
    DEFAULT_ARROW_CHUNK_BYTES,
    ArrowStreamChunk,
    build_arrow_stream_manifest_from_chunks,
    iter_arrow_stream_chunks,
)
from nteract_kernel_launcher._refs import BLOB_REF_MIME, BlobRef, build_ref_bundle


def _summary_hints(
    *,
    total_rows: int | None,
    included_rows: int,
    complete: bool,
) -> dict[str, Any]:
    sampled = total_rows is not None and included_rows != total_rows
    return {
        "total_rows": total_rows if total_rows is not None else included_rows,
        "included_rows": included_rows,
        "sampled": sampled or not complete,
        "sample_strategy": "none" if complete and not sampled else "head",
    }


def _summary_text(summary: dict[str, Any], *, complete: bool) -> str:
    included_rows = summary["included_rows"]
    total_rows = summary["total_rows"]
    if complete:
        return f"Arrow stream table: {included_rows} rows"
    return f"Arrow stream table: {included_rows} of {total_rows} rows loaded"


def _bundle_for_progressive_chunk(
    *,
    current_chunk: ArrowStreamChunk,
    chunks: list[ArrowStreamChunk],
    complete: bool,
    total_rows: int | None,
) -> dict[str, Any]:
    included_rows = sum(chunk.row_count for chunk in chunks)
    summary = _summary_hints(
        total_rows=total_rows,
        included_rows=included_rows,
        complete=complete,
    )

    ref = BlobRef(hash=current_chunk.content_hash, size=current_chunk.size)
    ref_bundle = build_ref_bundle(ref, content_type=ARROW_STREAM_MIME, summary=summary)
    ref_bundle["buffer_index"] = 0

    pending_buffers()[current_chunk.content_hash] = current_chunk.data
    return {
        BLOB_REF_MIME: ref_bundle,
        ARROW_STREAM_MANIFEST_MIME: build_arrow_stream_manifest_from_chunks(
            chunks,
            complete=complete,
            summary=summary,
        ),
        "text/llm+plain": _summary_text(summary, complete=complete),
    }


def display_arrow_stream(
    source: Any,
    *,
    display_id: bool | str = True,
    max_chunk_bytes: int = DEFAULT_ARROW_CHUNK_BYTES,
    total_rows: int | None = None,
    display_fn: Callable[..., Any] | None = None,
) -> Any:
    """Display ``source`` progressively as Arrow IPC stream manifest chunks.

    This explicit helper owns the Jupyter ``display_id`` / ``update_display_data``
    path. Automatic dataframe reprs still use the one-shot formatter because
    IPython MIME formatters cannot create their own transient display ids.
    """
    if display_fn is None:
        from IPython.display import display as display_fn

    chunks: list[ArrowStreamChunk] = []
    handle = None
    for chunk in iter_arrow_stream_chunks(source, max_chunk_bytes=max_chunk_bytes):
        chunks.append(chunk)
        bundle = _bundle_for_progressive_chunk(
            current_chunk=chunk,
            chunks=chunks,
            complete=False,
            total_rows=total_rows,
        )
        if handle is None:
            handle = display_fn(bundle, raw=True, display_id=display_id)
        else:
            handle.update(bundle, raw=True)

    if chunks and handle is not None:
        final_bundle = _bundle_for_progressive_chunk(
            current_chunk=chunks[-1],
            chunks=chunks,
            complete=True,
            total_rows=total_rows,
        )
        handle.update(final_bundle, raw=True)

    return handle
