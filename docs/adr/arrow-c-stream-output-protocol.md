# Arrow C Stream Output Protocol

**Status:** Draft, 2026-05-24.

## Context

DataFrame display used to require producer-specific formatter registrations:
pandas here, polars there, pyarrow elsewhere, narwhals as another wrapper, and
Hugging Face datasets as a special case. That makes startup slower, imports
optional libraries before user code asks for them, and leaves every new
Arrow-compatible producer needing a new formatter hook.

Modern dataframe libraries are converging on the Arrow PyCapsule interface:
objects expose `__arrow_c_stream__()` and consumers import that as an Arrow C
stream. The C stream is an in-process pointer protocol, not a notebook wire
format, but it is the right producer-neutral way to obtain record batches.

This ADR records the protocol boundary we want to upstream: kernels should
look for the Arrow C stream producer contract first, then serialize that stream
into ordinary notebook MIME outputs.

Neighbors:

- `docs/adr/blob-ref-and-chunk-manifest-protocol.md` - how serialized
  Arrow bytes are referenced and chunked.
- `python/nteract-kernel-launcher/docs/arrow-native-outputs.md` - current
  launcher implementation plan and merged behavior.
- `docs/adr/blob-storage-and-content-addressing.md` - where the
  resulting bytes live after the daemon receives them.

## Decision 1: `__arrow_c_stream__` is the primary table producer contract

The launcher should consider any object with callable `__arrow_c_stream__` to
be a table-like rich output candidate.

The preferred public pyarrow path is:

```python
reader = pyarrow.RecordBatchReader.from_stream(obj)
```

or, on pyarrow versions without that public helper, the narrow PyCapsule import
fallback. Both paths are part of the v1 launcher behavior; the fallback is an
implementation compatibility bridge, not a separate producer contract. pandas,
polars, pyarrow tables/readers, narwhals wrappers, DuckDB, DataFusion, cuDF,
and future producers can then share one formatter path.

Producer-specific type registrations are not the default table path. They are
allowed only when the output needs domain semantics beyond generic Arrow, such
as Hugging Face dataset feature summaries.

## Decision 2: The imported stream is single-pass

Consumers must assume an Arrow C stream can be consumed once. Formatting cannot
probe the stream once for metadata and then consume it again for bytes unless a
specific producer documents replay support.

The launcher therefore drains one imported `RecordBatchReader` and derives all
transport facts from that drain:

- schema and schema metadata;
- row counts and record batch counts;
- chunk hashes and byte sizes;
- the final LLM/plain summary hints.

If a total row count is available cheaply from `num_rows`, `height`, `shape`,
or `len`, it may be reported. Otherwise the included row count is the truthful
count.

## Decision 3: Notebook transport is Arrow IPC stream bytes

The Arrow C stream pointer is never written into a notebook output. The
transport/storage bytes are Arrow IPC stream format:

```text
application/vnd.apache.arrow.stream
```

Small outputs can be one IPC stream blob. Large or progressive outputs use an
Arrow stream manifest whose chunks are each self-contained IPC stream
mini-streams. Chunk boundaries prefer record batch boundaries; if one batch is
too large, it may be sliced into smaller Arrow batches before IPC encoding.

Schema metadata must survive this conversion. pandas index metadata,
Hugging Face feature metadata, and future schema key/value hints belong in the
Arrow schema rather than in TypeScript-specific side channels.

## Decision 4: Startup must not import optional dataframe libraries

The bootstrap installs generic per-MIME formatters and import hooks. It should
not import pandas, polars, pyarrow, narwhals, altair, plotly, or datasets on the
kernel startup path just to decide whether they are present.

The cost of importing pyarrow is paid only when an Arrow-capable object is
actually formatted. The cost of third-party renderer activation is paid when
the user imports the renderer package.

This is important for upstreaming because IPython and ipykernel cannot assume a
notebook kernel wants every dataframe or visualization package imported before
the first prompt.

## Decision 5: Summaries are advisory siblings, not the table payload

The structured table payload is the Arrow IPC stream plus manifest/ref
metadata. Text summaries are sibling MIME values such as `text/llm+plain` or
plain fallbacks. They help LLM tools and non-table renderers, but they are not
the source of truth for schema, rows, or bytes.

Summary hints in manifests should be cheap and explicit:

```json
{
  "total_rows": 1000,
  "included_rows": 1000,
  "sampled": false,
  "sample_strategy": "none"
}
```

If a future first-paint path emits only a head sample, the manifest must say
that honestly rather than pretending the table is complete.

## Decision 6: Vendor MIME is the incubation boundary

The upstreamable part of this ADR is the producer contract and transport split:

1. Producers expose `__arrow_c_stream__`.
2. The kernel imports that stream once.
3. Notebook transport stores Arrow IPC stream bytes plus manifest/ref metadata.
4. Text summaries remain advisory sibling MIME values.

The current nteract MIME names and manifest fields are an incubation vehicle.
The manifest itself is versioned by the blob-ref/chunk-manifest protocol; the
Arrow producer contract should evolve additively unless an upstream proposal
chooses a new transport shape.

## Consequences

- New Arrow-capable libraries can display rich tables without launcher changes.
- The startup path gets smaller because optional library imports move to first
  actual use.
- The protocol cleanly separates producer interchange (`__arrow_c_stream__`)
  from notebook transport (`application/vnd.apache.arrow.stream`).
- Any formatter bug must fail soft and let normal IPython representation keep
  working.

## Open Questions

1. Whether IPython should expose a first-class display formatter helper for
   `__arrow_c_stream__` producers.
2. How a standardized Jupyter form should advertise partial/progressive table
   state without requiring a nteract-specific manifest MIME.
3. Whether producer libraries should expose cheap total-row metadata as part
   of the Arrow PyCapsule protocol or leave it as library-specific attributes.
