# Arrow-Native Notebook Outputs

Issue: https://github.com/nteract/desktop/issues/1816

This note captures the current Python/Rust output path and the next steps for
making table outputs Arrow-native while preserving ordinary notebook fallback
behavior.

## Current Path

The launcher registers lazy IPython `mimebundle_formatter` handlers in
`nteract_kernel_launcher/_bootstrap.py` for pandas, polars, narwhals,
`pyarrow.Table`, `pyarrow.RecordBatch`, and Hugging Face datasets.

Today those rich table paths serialize bytes as parquet, stash the bytes in the
kernel-side pending buffer map, and return a bundle shaped like:

```json
{
  "application/vnd.nteract.blob-ref+json": {
    "hash": "sha256...",
    "content_type": "application/vnd.apache.parquet",
    "size": 12345,
    "summary": {
      "total_rows": 1000,
      "included_rows": 1000,
      "sampled": false,
      "sample_strategy": "none"
    },
    "buffer_index": 0
  },
  "text/llm+plain": "..."
}
```

The default IPython formatter chain can still add `text/plain` or `text/html`
fallbacks. That is the compatibility contract: a vanilla notebook should render
the fallback MIME, while nteract consumes the content-addressed binary payload.

The `pyarrow.Table` and dataset paths are already the most metadata-correct
paths because `serialize_arrow_table` writes the Arrow table directly to
parquet, preserving schema key/value metadata such as Hugging Face `features`.
The dataframe paths are less faithful because conversion through pandas/polars
does not preserve arbitrary Arrow schema metadata.

## Near-Term Rust Contract

The blob-ref MIME is a transport envelope, not the durable output MIME. When
`runtimed` promotes the ref to its wrapped `content_type`, it should also lift
the Python-provided `summary` and `query` into `OutputManifest.metadata` under
the wrapped MIME:

```json
{
  "metadata": {
    "application/vnd.apache.parquet": {
      "nteract": {
        "summary": {
          "total_rows": 1000,
          "included_rows": 1000,
          "sampled": false,
          "sample_strategy": "none"
        }
      }
    }
  }
}
```

This keeps the manifest canonical: renderers, MCP, `repr_llm`, and saved
notebooks can inspect output-level metadata without knowing about the
transport-only blob-ref MIME. The data bundle still points at the
content-addressed binary bytes. Non-null `query` hints should live next to
`summary` in the same `nteract` object. Null hint values are not promoted.

## Arrow IPC As A First-Class MIME

The next incremental step is to add `application/vnd.apache.arrow.stream` as a
first-class table output MIME alongside parquet.

Python should prefer Arrow IPC stream bytes when the object is already Arrow:

- `pyarrow.Table`
- `pyarrow.RecordBatch`
- Hugging Face datasets with an underlying Arrow table
- narwhals backends that expose Arrow natively without forcing pandas

Parquet should remain available for persistence-oriented paths and as a
fallback when Arrow IPC support is missing.

Runtime and frontend work needed for the first-class MIME:

- Add `application/vnd.apache.arrow.stream` to the ref-MIME save whitelist so
  saved `.ipynb` files keep the binary payload externalized as a blob ref
  instead of base64-inlining it.
- Add the MIME to runtime/MCP MIME priority so Sift is selected before generic
  text fallbacks.
- Teach plugin loading and binary renderer gates that Arrow IPC is a Sift table
  MIME, just like parquet.
- Add Rust-side Arrow IPC summary support in the predicate layer, then expose it
  to `repr_llm` and Sift/WASM. This should live beside the parquet predicate
  logic so both `repr_llm` and Sift share the same schema/type interpretation.

This gives us an Arrow-native notebook at rest, but it is still not the full
streaming design from issue #1816 because the blob is complete before renderers
can consume it.

## True Streaming With Content-Addressed Storage

True streaming needs a manifest rather than one monolithic blob. The durable
shape should describe an Arrow stream in content-addressed chunks:

```json
{
  "mime": "application/vnd.nteract.arrow-stream-manifest+json",
  "schema_hash": "sha256...",
  "chunks": [
    {
      "hash": "sha256...",
      "content_type": "application/vnd.apache.arrow.stream",
      "record_batch_count": 4,
      "row_count": 4096,
      "byte_length": 98304
    }
  ],
  "complete": true,
  "summary": {
    "total_rows": 1000000,
    "included_rows": 4096,
    "sampled": true,
    "sample_strategy": "head"
  }
}
```

Each chunk should align to Arrow IPC message or record-batch boundaries so Rust,
WASM, and browser readers can validate and append data without reparsing an
arbitrary byte splice. The CAS key remains the hash of the raw chunk bytes. A
separate schema hash lets renderers reject incompatible chunk sequences early.

The Python layer should be able to publish the schema and first chunk before the
full dataframe is materialized when the source supports streaming. That matters
for long `to_pandas()` calls, remote fetches, and large datasets where the user
only inspects the first page.

## Compatibility Rules

- Always emit `text/plain` and/or `text/html` fallback data for notebook
  interoperability.
- Keep binary table payloads behind nteract-specific ref metadata on save.
- Do not rely on TypeScript to parse parquet or Arrow metadata when Rust can do
  it once in `nteract-predicate` and share the result with WASM and `repr_llm`.
- Treat parquet and Arrow IPC as complementary. Parquet is still better for
  compressed persistence and footer-driven random access; Arrow IPC is better
  for in-memory schema fidelity and progressive rendering.
- Avoid a TypeScript-only metadata model. Python should emit known source facts,
  Rust should normalize and validate them, and WASM/renderers should consume the
  canonical predicate summaries.
