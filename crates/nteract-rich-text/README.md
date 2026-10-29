# Rich-text interchange codec

An additive, unpublished Rust codec for the Pages rich-text span contract. It
imports Markdown to text, marks, and block markers, and exports representable
rich content to Markdown. It builds natively and as a standalone WASM module.
Pages does not use this crate in production yet.

The rich document is authoritative. Wordgard edits native text, marks, and block
structure; Markdown is an interchange format for import, export, paste, and
agent input. This codec does not own documents, sync, transactions, revisions,
selection, comments, undo, assets, or access control. It does not run on every
keystroke. Its Markdown subset must not limit what a rich editor can express.

## Interfaces

```rust
use nteract_rich_text::{markdown_to_spans, spans_to_markdown, ImportOptions};

let spans = markdown_to_spans("- [ ] Read **together**", &ImportOptions::default())?;
let markdown = spans_to_markdown(&spans)?;
# Ok::<(), nteract_rich_text::CodecError>(())
```

`Span` is the JSON-friendly projection of Automerge spans. `Text` carries a
string and marks; `Block` carries its type, parent path, attributes and embed
flag. With the optional `automerge` feature, `native::to_automerge` and
`native::from_automerge` convert to the workspace's pinned Automerge types.
They do not apply changes. A caller can use Automerge's `update_spans` within
its own guarded transaction, preserving the existing text object. Direct rich
editing should continue using granular text/mark operations where available.
JS callers must convert block types, parent names, and string attributes to
`Automerge.ImmutableString` before reconciliation, as the existing Pages
adapter does.

`process_json` accepts a bounded request and returns an explicit success or
error object. The native example reads one request per line. The WASM build
exposes the same function through `codec_alloc`, `codec_run`,
`codec_result_ptr`, `codec_result_len`, and `codec_free`. The host fills the
allocated input buffer and copies the result before its next call. These
buffers are per-instance and calls must be serialized; create another WASM
instance for an independent concurrent caller. Invalid buffers return errors.
No wasm-bindgen runtime is needed for this boundary.

```json
{"op":"import","markdown":"A **shared** paragraph","import_id":"","kind":"markdown"}
```

```json
{"op":"export","spans":[{"type":"text","value":"shared","marks":{"strong":true}}]}
```

The `pages-markdown-v1` compatibility profile uses the same `markdown` Rust
parser crate as `nteract-markdown-engine`. The renderer's GFM profile and this
interchange profile serve different contracts: bare URLs stay prose, tables
and bullet tasks become native structure, and unsupported syntax is preserved
as an opaque block with its original source and import provenance. Existing
Pages immutable source provenance remains the caller's responsibility; exports
are canonical projections, not a byte-for-byte reconstruction of Markdown.

Markdown cannot represent all rich states, including arbitrary whitespace
marks or independent alignment per table cell. Export reports unsupported
content instead of silently stripping it; a semantic reimport check verifies
representability at this explicit export boundary. Callers must retain the
native document and surface that limitation. Re-import is not an editor migration.
Ordered-list starts currently normalize to one because the existing span
contract does not carry them. Ragged tables export with padding to retain every
cell. The codec's per-call 256 KiB bound follows the existing Pages rich-block
ingress limit; it is not a document-history or storage limit.

## Qualification and adoption

See [the compatibility corpus](fixtures/README.md) for exact native/WASM and
legacy-codec checks, including explicitly recorded parser differences. Run:

```sh
cargo test -p nteract-rich-text --features automerge
cargo build -p nteract-rich-text --example codec
cargo build -p nteract-rich-text --target wasm32-unknown-unknown
node crates/nteract-rich-text/scripts/generate-fixtures.mjs --check
node crates/nteract-rich-text/scripts/check-parity.mjs
```

The JavaScript oracle requires the existing Pages experiment dependencies
(`npm run setup` in its experiment directory). It is test-only. The Rust
crate has no JavaScript, ProseMirror, DOM, server, or network dependency.

Production adoption is a separate change: compare imported and existing rich
documents, preserve identity and immutable provenance, qualify undo and
comment anchors, then switch the import/export callers. Range mapping and
structural read helpers remain in their current implementation until that
follow-up replaces them. This extraction does not remove Pages' remaining
ProseMirror codec dependency or change a deployment.
