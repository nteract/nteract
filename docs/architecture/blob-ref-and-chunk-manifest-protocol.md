# Blob Ref and Chunk Manifest Output Protocol

**Status:** Draft, 2026-05-24.

## Context

Notebook outputs need to carry large binary payloads without making every
runtime document, `.ipynb` save, and sync frame contain the bytes inline.
Jupyter already lets IOPub messages attach binary buffers, but the JSON MIME
bundle still needs a durable, host-neutral way to say what those buffers are
and how to resolve them after the original message has passed.

nteract currently uses `application/vnd.nteract.blob-ref+json` for this
envelope. Arrow/Sift table outputs add a second shape:
`application/vnd.nteract.arrow-stream-manifest+json`, where one selected output
names many content-addressed Arrow stream chunks.

This ADR separates the protocol contract from the current desktop daemon
implementation so the same shape can be discussed with IPython, ipykernel, and
Jupyter clients.

Neighbors:

- `docs/architecture/blob-storage-and-content-addressing.md` - daemon-side blob
  store, hash validation, HTTP serving, and multipart upload.
- `docs/architecture/hosted-notebook-artifacts.md` - hosted snapshot and blob
  artifact materialization.
- `docs/superpowers/specs/2026-05-11-arrow-manifest-durable-storage-design.md`
  - save/load durability details for nested Arrow manifest refs.
- `python/nteract-kernel-launcher/docs/arrow-native-outputs.md` - Python
  producer behavior.

## Decision 1: Output bundles carry host-neutral blob refs, not URLs

A blob ref is a JSON value whose identity is the content hash of the bytes:

```json
{
  "hash": "<sha256-hex>",
  "content_type": "application/vnd.apache.arrow.stream",
  "size": 12345,
  "summary": {
    "total_rows": 1000,
    "included_rows": 1000,
    "sampled": false,
    "sample_strategy": "none"
  },
  "query": null
}
```

The current desktop implementation uses lowercase SHA-256 hex without an
algorithm prefix. The ref does not include a localhost URL, cloud URL, file
path, or room id. The host owns resolution:

- Desktop maps the hash to the local daemon blob server.
- Hosted viewers map the hash to notebook artifact storage.
- Headless tools can resolve the hash through a blob store API or leave it as
  a ref.

`buffer_index` is a transport hint for the current IOPub message only. It says
which attached binary buffer carries the bytes. Producers do not need to put it
in single-ref bundles; the buffer hook stamps it before the message is sent.
It is explicit in the transmitted JSON because Jupyter buffers are positional
and consumers may inspect a ref after envelope normalization without replaying
the hook's JSON traversal. It is not part of durable identity and can be
recomputed when a message is republished.

## Decision 2: Multiple chunks use one multi-ref envelope

When one logical output needs multiple binary payloads, the same MIME carries a
multi-ref value:

```json
{
  "content_type": "application/vnd.apache.arrow.stream",
  "size": 24690,
  "refs": [
    {
      "hash": "<sha256-hex>",
      "content_type": "application/vnd.apache.arrow.stream",
      "size": 12345,
      "buffer_index": 0
    },
    {
      "hash": "<sha256-hex>",
      "content_type": "application/vnd.apache.arrow.stream",
      "size": 12345,
      "buffer_index": 1
    }
  ],
  "summary": {
    "total_rows": 1000,
    "included_rows": 1000,
    "sampled": false,
    "sample_strategy": "none"
  },
  "query": null
}
```

The buffer hook treats single-ref and multi-ref envelopes the same way: look up
pending bytes by hash, attach buffers in ref order, stamp `buffer_index`, and
let the daemon verify hash and size before committing bytes to the blob store.

If no pending bytes exist for a hash, the message passes through unchanged.
That permits replay of historical outputs whose bytes are already in a blob
store.

## Decision 3: Chunk manifests describe the logical stream

The blob-ref MIME answers "where are the bytes?" The chunk manifest answers
"how do these bytes form one renderable value?"

For Arrow stream tables, the selected MIME is:

```text
application/vnd.nteract.arrow-stream-manifest+json
```

The manifest has this core shape:

```json
{
  "version": 1,
  "content_type": "application/vnd.apache.arrow.stream",
  "schema": {
    "hash": "<schema-fingerprint>",
    "content_type": "application/vnd.apache.arrow.schema",
    "fields": 2,
    "columns": [
      { "name": "a", "type": "int64", "nullable": true },
      { "name": "b", "type": "large_string", "nullable": true }
    ],
    "metadata": {
      "pandas": true,
      "huggingface": false
    }
  },
  "chunks": [
    {
      "index": 0,
      "hash": "<sha256-hex>",
      "size": 12345,
      "row_count": 4096,
      "record_batch_count": 4,
      "encoding": "arrow-ipc-stream"
    }
  ],
  "complete": true,
  "summary": {
    "total_rows": 4096,
    "included_rows": 4096,
    "sampled": false,
    "sample_strategy": "none"
  }
}
```

Each `chunks[]` entry names a blob ref by hash. Each chunk is independently
decodable as an Arrow IPC stream mini-stream. Consumers concatenate logical
rows in ascending `index` order, not by reassembling raw bytes.

The manifest may later grow `coalesced` entries for derived artifacts. Unknown
fields must be preserved at save/load boundaries.

## Decision 4: Durable save rewrites nested refs to ContentRef shape

Live runtime/render state keeps chunk entries as `hash` strings because that is
what renderers consume. Saved `.ipynb` JSON should make nested manifest-owned
blobs explicit:

```json
{
  "blob": "<sha256-hex>",
  "size": 12345,
  "content_type": "application/vnd.apache.arrow.stream"
}
```

The transform applies only to known blob-bearing manifest slots such as
`chunks[].hash`, `coalesced.hash`, and `coalesced.segments[].hash`. A schema
fingerprint like `schema.hash` remains a string until schema bytes are stored
as an actual blob.

Save must fail rather than writing a complete-looking manifest when a chunk
blob is missing. Load may drop the manifest MIME and preserve fallback siblings
when a referenced blob is absent locally.

## Decision 5: Vendor MIME is the incubation boundary

The current MIME names are nteract vendor names on purpose. They let the
launcher, daemon, frontend, MCP tools, and hosted viewer converge before asking
IPython or Jupyter to standardize anything.

The upstreamable part is not the nteract name. It is the split:

1. A MIME-bundle JSON envelope describes content-addressed binary refs.
2. IOPub buffers opportunistically carry bytes for those refs.
3. A manifest MIME describes logical multi-blob values.
4. Hosts resolve hashes to URLs or bytes without rewriting notebook outputs.

## Consequences

- Outputs survive daemon port changes because refs contain hashes, not URLs.
- Replay and saved notebooks can refer to blobs without reattaching bytes.
- Renderers can reason about multi-chunk tables without daemon-specific APIs.
- GC, save, and publish code must understand nested manifest refs, not only
  top-level blob refs.

## Open Questions

1. Whether an upstream Jupyter form should use a vendor-neutral MIME, a
   top-level `attachments`-like message field, or metadata alongside existing
   MIME entries.
2. Whether hashes should be represented as bare SHA-256 hex, `sha256:<hex>`,
   or an algorithm-tagged JSON object before standardization.
3. How much of `summary` and `query` belongs in the generic blob-ref protocol
   versus MIME-specific metadata.
