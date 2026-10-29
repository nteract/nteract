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
Wordgard encoder does. Native integer attributes use the same signed scalar
representation as ordinary JavaScript numbers.

The native adapter rejects unsigned scalar attributes because JSON cannot
preserve their scalar kind; projecting a small Uint and reconciling it as Int
would otherwise emit new history for unchanged content. Signed integer
attributes authored by JavaScript retain their existing representation.

The native adapter rejects mutable Text objects inside block attributes.
Existing images authored by the legacy Markdown codec can have this shape for
alt text and titles, while Wordgard writes scalar attributes. Saved JavaScript
fixtures record this difference; adoption must handle it explicitly to avoid
replacing attribute objects or losing concurrent attribute edits.

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

Linked or emphasized images import as whole-source opaque content because
the native image marker cannot represent its enclosing link or marks. This
preserves source and provenance without silently discarding the wrapper.

Markdown cannot represent all rich states, including arbitrary whitespace
marks or independent alignment per table cell. Export reports unsupported
content instead of silently stripping it; a semantic reimport check verifies
representability at this explicit export boundary. Callers must retain the
native document and surface that limitation. Re-import is not an editor migration.
An isolated opaque block exports its original source. A mixture of opaque
blocks and rich prose currently returns an export error: the conservative
import profile would otherwise turn the whole result into one opaque block.
The original rich document remains intact in both cases.

Ordered-list starts currently normalize to one because the existing span
contract does not carry them. Ragged tables export with padding to retain every
cell. Markdown source and serialized spans each have a separate 256 KiB
admission limit, following the existing Pages rich-block ingress limit.
JSON escaping, block markers, marks, and opaque provenance count toward the
span limit, so some source below 256 KiB can still exceed it after conversion.
The caller receives an error and must retain the original input. These are
per-call interchange bounds, not document-history or storage limits.

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
