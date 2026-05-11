"""Progressive Arrow stream display helpers."""

from __future__ import annotations

from collections.abc import Callable
from itertools import chain
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
    current_chunk: ArrowStreamChunk | None,
    chunks: list[ArrowStreamChunk],
    complete: bool,
    total_rows: int | None,
    schema: Any,
    include_blob_ref: bool,
) -> dict[str, Any]:
    included_rows = sum(chunk.row_count for chunk in chunks)
    summary = _summary_hints(
        total_rows=total_rows,
        included_rows=included_rows,
        complete=complete,
    )
    llm_text = _summary_text(summary, complete=complete)

    bundle: dict[str, Any] = {
        ARROW_STREAM_MANIFEST_MIME: build_arrow_stream_manifest_from_chunks(
            chunks,
            complete=complete,
            summary=summary,
            schema=schema,
        ),
        "text/llm+plain": llm_text,
    }
    if include_blob_ref:
        if current_chunk is None:
            raise ValueError("current_chunk is required when include_blob_ref=True")
        ref = BlobRef(hash=current_chunk.content_hash, size=current_chunk.size)
        ref_bundle = build_ref_bundle(ref, content_type=ARROW_STREAM_MIME, summary=summary)
        ref_bundle["buffer_index"] = 0
        pending_buffers()[current_chunk.content_hash] = current_chunk.data
        bundle[BLOB_REF_MIME] = ref_bundle
    return bundle


def _schema_for_chunk(chunk: ArrowStreamChunk) -> Any:
    import pyarrow as pa

    return pa.ipc.open_stream(pa.BufferReader(chunk.data)).schema


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

    iterator = iter(iter_arrow_stream_chunks(source, max_chunk_bytes=max_chunk_bytes))
    try:
        first_chunk = next(iterator)
    except StopIteration:
        return None

    schema = _schema_for_chunk(first_chunk)
    chunks: list[ArrowStreamChunk] = [first_chunk]

    try:
        second_chunk = next(iterator)
    except StopIteration:
        bundle = _bundle_for_progressive_chunk(
            current_chunk=first_chunk,
            chunks=chunks,
            complete=True,
            total_rows=total_rows,
            schema=schema,
            include_blob_ref=True,
        )
        return display_fn(bundle, raw=True, display_id=display_id)

    first_bundle = _bundle_for_progressive_chunk(
        current_chunk=first_chunk,
        chunks=chunks,
        complete=False,
        total_rows=total_rows,
        schema=schema,
        include_blob_ref=True,
    )
    handle = display_fn(first_bundle, raw=True, display_id=display_id)

    for chunk in chain([second_chunk], iterator):
        chunks.append(chunk)
        bundle = _bundle_for_progressive_chunk(
            current_chunk=chunk,
            chunks=chunks,
            complete=False,
            total_rows=total_rows,
            schema=schema,
            include_blob_ref=True,
        )
        handle.update(bundle, raw=True)

    final_bundle = _bundle_for_progressive_chunk(
        current_chunk=None,
        chunks=chunks,
        complete=True,
        total_rows=total_rows,
        schema=schema,
        include_blob_ref=False,
    )
    handle.update(final_bundle, raw=True)

    return handle
