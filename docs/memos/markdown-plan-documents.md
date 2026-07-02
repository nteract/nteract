# Markdown Plan Documents

**Status:** Exploration
**Created:** 2026-06-12
**Audience:** Product, design, engineering, research, and AI collaborators
**Promotes to:** ADRs for document model, projection artifacts, comments, and
hosted storage/API decisions

This memo grounds a possible Markdown/MDX document surface in the current
nteract source tree and current editor/CRDT ecosystem. It is intentionally not an
ADR yet. The goal is to identify the smallest credible product and architecture
path for a calm Markdown Plan editor that can pair well with LLM authors, render
richly, support presence/comments, publish to Cloud with ACLs, and eventually
host constrained MDX-style components.

## Prototype Lessons, June 2026

A hosted `/m` prototype proved the document type is promising, but also showed
that a standalone Markdown app route is too easy to let drift away from the
notebook product shell. The useful pieces should be harvested first, while the
route, storage, and dashboard decisions stay in memo/RFC territory:

- Document title chrome should be shared with notebooks, including the
  local-first title editing affordance and its no-layout-jump behavior.
- View/edit mode controls, source/rendered/split controls, and outline panels
  should use shared document controls with document-specific labels rather than
  one-off Markdown route chrome.
- Hosted catalog/auth state should be a pure projection over browser auth plus
  the first-party app-session cookie. Notebook and future document catalogs
  should use the same session-keyed cache pattern so `/n`, `/m`, or a future
  dashboard do not rediscover auth behavior independently.
- The first screen after creating a Markdown document must optimize time to
  first written thought: create should land in edit/source-capable mode without
  making the author click through view mode first.
- The rendered Markdown and source editor should share document alignment and
  width rules. Switching rendered/source/split should feel like a mode change,
  not a page reflow.
- Frontmatter can remain body content for now, but local files need a future
  association story for cloud document id, revision id, and published URL.
- Do not add durable D1 tables, Durable Object classes, or public `/m` product
  commitments until the dashboard/home route, sharing vocabulary, and document
  catalog model are designed alongside notebooks.

Concrete follow-through from this prototype should be small PRs before a new
document route lands: shared title chrome, parameterized document controls,
session-keyed hosted catalog cache, and this memo update. Those are generally
useful even if the Markdown route is delayed or redesigned.

## Scope

The target is not executable Markdown. It is closer to an optimized collaborative
Markdown document type:

- desktop can synchronize to a local `.md` file
- Cloud can host, publish, and ACL a live Markdown document
- humans and agents share document attribution and presence through the same
  room identity model
- rendered reading mode stays "zen" and does not expose notebook cell
  demarcations
- code blocks may have attached output snapshots through explicit Markdown
  metadata comments
- MDX-like component regions are preserved and rendered only through an approved
  component registry or isolated sandbox
- comments attach to projected document anchors, source ranges, output artifacts,
  and component artifacts

## Current Source Facts

### Markdown Projection Already Exists

The projection layer already has the key property a rich Markdown editor needs:
it records source spans for projected blocks and inline runs.

- `src/lib/markdown-projection.ts:18` defines `MarkdownProjectionBlock`, including
  `blockId`, `kind`, `element`, `sourceSpanByte`, `sourceSpanUtf16`,
  `syntaxSpans`, code language/meta, and measurement.
- `src/lib/markdown-projection.ts:44` defines `MarkdownProjectionRun`, including
  image/link/list/table metadata plus `sourceSpanByte`, `sourceSpanUtf16`, and
  `renderedTextUtf16`.
- `src/lib/markdown-projection.ts:69` defines `MarkdownProjectionPlan`, including
  exact `source`, `anchors`, `blocks`, `runs`, and measurement.
- `src/lib/markdown-projection.ts:108` caches projections by exact source.
- `src/lib/markdown-projection.ts:159` resolves attached projections against
  current source and reprojects when the attached plan is stale.
- `src/lib/markdown-projection.ts:235` maps a source position to the projected
  block/run. That is the seed for translating CodeMirror cursors to rendered
  presence highlights.

The Rust engine is already doing CommonMark/GFM-style parsing with safety lanes:

- `crates/nteract-markdown-engine/src/lib.rs:11` defines
  `MarkdownProjectOptions`; defaults isolate MDX and raw HTML
  (`MdxMode::Isolate`, `RawHtmlMode::Isolate`) at
  `crates/nteract-markdown-engine/src/lib.rs:20`.
- `crates/nteract-markdown-engine/src/lib.rs:40` defines `MarkdownPlan`, with
  `root`, `blocks`, `anchors`, `isolated_regions`, `text_fallback`, and
  measurement.
- `crates/nteract-markdown-engine/src/lib.rs:64` includes node kinds for code,
  math, HTML, table, image, MDX, and frontmatter.
- `crates/nteract-markdown-engine/src/lib.rs:231` projects markdown with options
  after parsing via the `markdown` crate.
- `crates/nteract-markdown-engine/src/lib.rs:282` enables GFM constructs, HTML,
  and math parsing.
- `crates/nteract-markdown-engine/src/lib.rs:497` treats MDX as `NodeKind::Mdx`
  and routes it to the isolated safety lane.
- `crates/nteract-markdown-engine/src/lib.rs:594` classifies active HTML tags and
  uppercase tags as isolated regions.

The WASM bridge is useful but currently flattens the engine plan into the
TypeScript projection shape:

- `crates/nteract-markdown-wasm/src/lib.rs:63` serializes the projection to JSON.
- `crates/nteract-markdown-wasm/src/lib.rs:82` iterates `plan.blocks` and
  flattens runs.
- `crates/nteract-markdown-wasm/src/lib.rs:88` serializes anchors.
- `crates/nteract-markdown-wasm/src/lib.rs:252` and `:784` carry byte/UTF-16
  spans into the flattened JSON.
- The TypeScript plan does not currently expose `isolated_regions`, the root
  tree, diagnostics, output artifact references, or component artifact
  references.

### The Rendered Markdown View Is Already Host-Rendered

The host renderer is already distinct from the isolated iframe fallback:

- `src/components/markdown/ProjectedMarkdownView.tsx:48` accepts a projection
  plan and optional `activeSourcePosition`.
- `src/components/markdown/ProjectedMarkdownView.tsx:80` resolves the active
  source position through `findMarkdownProjectionAtSourcePosition`.
- `src/components/markdown/ProjectedMarkdownView.tsx:87` renders all projected
  content inside shared `markdownDocumentClassName`.
- `src/components/markdown/ProjectedMarkdownView.tsx:220` omits isolated blocks
  from host rendering.
- `src/components/markdown/markdown-typography.ts:3` defines a calm document
  typography surface with document font, generous leading, source selection, and
  heading rhythm.

Notebook Markdown cells already use this path:

- `apps/notebook/src/components/MarkdownCell.tsx:247` derives
  `markdownProjection` from the draft source or resolved cell projection.
- `apps/notebook/src/components/MarkdownCell.tsx:343` sends heading anchors and
  the projection through renderer metadata.
- `apps/notebook/src/components/MarkdownCell.tsx:859` renders
  `ProjectedMarkdownView` when safe, and falls back to `IsolatedFrame` when not.

Markdown outputs also use the same projected host renderer:

- `src/components/outputs/media-router.tsx:242` derives a projection for
  `application/vnd.nteract.markdown-projection+json` or `text/markdown`.
- `src/components/outputs/media-router.tsx:248` renders `ProjectedMarkdownView`
  when the projection is host-safe.

### Outline Rail And Presence Already Point In The Right Direction

The left rail can stay as a document rail rather than a notebook-only affordance:

- `src/components/notebook/NotebookDocumentRail.tsx:6` takes a view model with
  `outlineItems` and packages.
- `src/components/notebook/NotebookDocumentRail.tsx:43` passes outline items into
  the rail and exposes selection/navigation callbacks.

Presence already has an interaction target for rendered Markdown anchors:

- `src/components/editor/presence-state.ts:21` defines interaction targets for
  `cell`, `editor`, `markdown_anchor`, and `output`.
- `packages/runtimed/src/notebook-interaction.ts:10` mirrors the wire shape with
  `markdown_anchor`.
- `crates/notebook-doc/src/presence.rs:1261` tests markdown-anchor round-trip.
- `apps/notebook/src/lib/presence-sender.ts` sends editor cursor/selection
  changes from CodeMirror.

That means v0 can project editor cursor positions into rendered Markdown blocks
without inventing a separate rendered-presence channel. The main limitation is
that the current target model is notebook/cell shaped. A first-class Markdown
document should not fake cell IDs just to reuse the schema.

### Comments ADR Is The Closest Existing Design

`docs/adr/notebook-comments-document.md` has the right document-sidecar model:

- comments live in a per-notebook `CommentsDoc`;
- `COMMENTS_DOC_SYNC` is its own typed-frame stream;
- local comment mutations land directly in Automerge;
- author/resolver attribution is projected from admitted change actors, not
  finalized from stored authority fields;
- comments do not render as extra notebook cell rows because of stable DOM
  order;
- publish excludes comments by default unless an explicit policy opts in; and
- projections compute display indexes and badges from document heads rather than
  storing a derived anchor index.

For Markdown Plan documents, the ADR needs either an amendment or a sibling ADR
that generalizes "notebook comments" into "document comments".

### Cloud Hosting Boundaries Are Already Compatible

Hosted notebook ADRs and subsystem guides already define the durable/public
boundary that Markdown documents should reuse:

- `apps/notebook-cloud/AGENTS.md:19` says R2 snapshot bundles and D1 catalog/ACL
  rows are the durable hosted source of truth, while Durable Object storage is
  live-room recovery/cache.
- `apps/notebook-cloud/AGENTS.md:66` requires explicit public viewer state via a
  D1 public ACL row.
- `docs/adr/hosted-notebook-artifacts.md:35` defines durable published artifacts
  as snapshot bundles.
- `docs/adr/hosted-notebook-artifacts.md:169` keeps the cloud viewer a static
  bundle, not a forked notebook UI.
- `docs/adr/document-split.md:308` says cross-document head correlation belongs
  at the publish boundary, not in live docs.
- `docs/adr/hosted-room-authorization.md:97` defines explicit public read ACLs.
- `docs/adr/hosted-room-authorization.md:230` keeps anonymous public presence a
  product policy layered over ACLs.
- `docs/adr/identity-and-trust.md:431` states that publish/import boundaries
  cannot trust historical local Automerge attribution; hosted rooms record the
  publisher/importer identity they can vouch for.

## External Check, 2026-06-12

Package versions checked with `npm view` and `cargo search` from this workspace:

| Package | Repo state | Latest observed | Note |
|---|---:|---:|---|
| `@codemirror/view` | lockfile `6.40.0` | `6.43.1` | Current enough for decorations/widgets; patch update available. |
| `@codemirror/lang-markdown` | lockfile `6.5.0` | `6.5.0` | Current. |
| `@mdx-js/mdx` | transitive `3.1.1` | `3.1.1` | Current MDX compiler. |
| `react-markdown` | lockfile `10.1.0` | `10.1.0` | Current. |
| `remark` | transitive `15.0.1` | `15.0.1` | Current. |
| `rehype-raw` | lockfile `7.0.0` | `7.0.0` | Current. |
| `@lexical/markdown` | not installed | `0.45.0` | Ecosystem reference, not the recommended document model. |
| `@milkdown/kit` | not installed | `7.21.2` | ProseMirror-based reference, not the recommended document model. |
| `@markdoc/markdoc` | not installed | `0.5.7` | Safer component-tag alternative to full MDX. |
| `@automerge/automerge` | Rust fork in repo | `3.2.6` | JS ecosystem has rich text/text APIs, but repo is pinned to nteract fork. |
| `automerge-repo` | not installed | `0.1.0` | Interesting sync reference, not a direct replacement. |
| Rust `markdown` crate | `markdown = "1"` | `1.0.0` | Current per `cargo search markdown`. |

Relevant upstream docs:

- Automerge text docs:
  https://automerge.org/docs/reference/documents/text/
- Automerge rich text docs:
  https://automerge.org/docs/reference/documents/rich-text/
- MDX docs:
  https://mdxjs.com/
- `@mdx-js/mdx` package:
  https://www.npmjs.com/package/@mdx-js/mdx
- CodeMirror reference:
  https://codemirror.net/docs/ref/
- CodeMirror decorations example:
  https://codemirror.net/examples/decoration/
- ProseMirror reference:
  https://prosemirror.net/docs/ref/
- Lexical Markdown:
  https://lexical.dev/docs/packages/lexical-markdown
- Milkdown collaborative editing:
  https://milkdown.dev/docs/guide/collaborative-editing
- Markdoc tags/schema:
  https://markdoc.dev/docs/tags

The main ecosystem read: CodeMirror plus nteract's projection engine is the path.
It matches current editor/presence code, and the markdown engine already gives us
block knowledge. ProseMirror/Milkdown/Lexical are useful references, but adopting
their document model would fight the source/projection architecture we already
have. Full MDX should be treated as a component syntax to preserve and
selectively render, not as arbitrary host-executed JavaScript.

## Proposed Direction

### 1. Make Markdown Documents First-Class

Do not model a Markdown Plan as a hidden notebook with one giant Markdown cell.
That would inherit cell chrome, notebook execution assumptions, and cell-shaped
presence/comment locators that the product explicitly does not want.

Introduce a first-class document type:

```text
MarkdownDoc
  body: Automerge text/string
  artifact_refs: map<artifact_id, ArtifactRef>
  output_artifacts: map<artifact_id, OutputArtifact>
  component_artifacts: map<artifact_id, ComponentArtifact>
  comments_doc_id: string?
  metadata: map
```

`body` is the authoring source of truth. Frontmatter lives in the body when the
author writes frontmatter, and projection derives the current frontmatter view
from the current body. Output and component declarations also live in the body;
the sidecar maps resolve the durable artifacts those declarations reference.
If the body removes or renames a declaration, the artifact can remain stored but
is no longer rendered until a body declaration references it again.

The local desktop projection can sync `body` to a `.md` file. The hosted room can
replicate `MarkdownDoc`, `CommentsDoc`, and any runtime/output/component sidecar
state through the same room/snapshot/ACL patterns as notebooks.

Automerge text gives natural collaborative source editing. Long LLM-authored
Markdown files mean we should evolve document versioning and compaction sooner:
record a durable version, copy the visible Automerge state into a fresh document
when history gets too heavy, and keep old snapshots as version history.

### 2. Keep The Viewer Zen And Projection-Driven

The rendered view should use `ProjectedMarkdownView`-style host rendering with
left rail outline preserved. It should not show notebook cell demarcations.

Recommended first shell:

- left rail with outline as the primary control
- optional rail tabs for comments, components, assets, and versions
- main pane with rendered Markdown
- source editor as a focusable/editable mode or side-by-side panel
- rendered presence translated from source offsets to projected blocks/runs
- comments as gutter markers/inline highlights/side panel, not extra rows

This matches existing source:

- source spans are already carried in projection blocks/runs
- `activeSourcePosition` already maps editor position to rendered block/run
- outline projection is already driven by Markdown anchors
- presence already has a `markdown_anchor` target

### 3. Treat Code Outputs As Attached Snapshots, Not Execution

For non-executable Markdown, a code block may reference an output artifact
through a structured comment immediately after the block:

````markdown
```python
df.head()
```
<!-- nteract:output {"artifact_id":"out_01","execution_id":"exec_abc","source_hash":"sha256:..."} -->
````

Rules:

- The comment is metadata, not an execution instruction.
- `source_hash` lets the UI mark an output as attached-to-current-source or
  stale-after-edit.
- `artifact_id` is the durable attachment key in `output_artifacts`;
  `execution_id` is provenance for the captured output.
- The projection engine should parse this into output artifact references, not
  surface it as visible document text.
- The rendered view should place the output after the code block without showing
  cell boundaries.

Output payloads can be imported from notebooks, copied from runtime snapshots,
or attached through an MCP/cloud API. They should live in sidecar state or
attachments, not inline base64 in Markdown by default.

Open syntax check: ordinary Markdown should accept `<!-- nteract:output ... -->`.
MDX import may require `{/* nteract:output ... */}` instead. The projection
engine should test and support both forms if MDX import makes HTML comments
awkward.

### 4. Preserve MDX, Render Only Approved Components

The current engine already isolates MDX-like nodes. Keep that stance.

MDX in this product should mean "component-capable Markdown document", not "run
arbitrary JavaScript from the document in the host app".

Practical shape:

- Preserve MDX syntax in source.
- Parse component regions as isolated/component nodes.
- Allow rendering only when a component name is in a document/room registry.
- Treat component props as data. Do not evaluate arbitrary expressions in host.
- Render untrusted/custom components in an iframe/isolated renderer with the
  same output-origin discipline used for notebook outputs.

For v0, Markdoc-style declarative tags may be safer than full MDX compilation.
MDX import/export can come later once the registry and sandbox model are clear.

### 5. Generalize CommentsDoc To DocumentCommentsDoc

The comments ADR already has the right state model. The missing generalization is
the locator shape.

For Markdown documents, anchors should include:

```text
document
source_range { utf16_start, utf16_end, snippet_hash? }
projected_block { block_id, source_span? }
heading_anchor { slug, source_span? }
output_artifact { artifact_id }
component_artifact { artifact_id }
```

The projection layer should compute display indexes and badges from
`MarkdownDoc + CommentsDoc` heads. Do not store a derived anchor index in the
comments document.

Cloud/local trust semantics can reuse the ADR:

- local-first comment mutation lands in Automerge;
- sync ingress validates the connection actor and scope before admitting the
  change;
- public publish excludes comments by default; and
- if comments are published, publish a frozen read-only comments projection.

### 6. Extend Presence From Cell-First To Document-First

Current presence is notebook/cell oriented. For Markdown docs we need targets
that do not require fake cells. The room/document channel already scopes the
target, so the target payload only needs the thing being indicated:

```ts
type MarkdownDocumentInteractionTarget =
  | { kind: "markdown_document" }
  | { kind: "markdown_source"; source_range?: [number, number] }
  | { kind: "markdown_block"; block_id: string }
  | { kind: "markdown_anchor"; anchor_id: string }
  | { kind: "markdown_output"; artifact_id: string }
  | { kind: "markdown_component"; artifact_id: string };
```

Source editor presence can continue to originate in CodeMirror line/column and
offset positions. Rendered-view presence can be projected using source spans.
Hover/focus in rendered mode can publish block/anchor/output/component targets.

Public viewer presence should inherit the current hosted policy: authenticated
viewers can participate normally, anonymous public viewers remain local-only or
aggregate-only until the open hosted presence policy is settled.

### 7. Start As A Shared Document Surface, Package Later

The pragmatic product route is:

1. Add a tailored Markdown document surface that shares notebook app chrome,
   title editing, mode controls, rail/outline, projection, markdown typography,
   presence plumbing, comments projection, and cloud ACL/publish
   infrastructure.
2. Add MCP tools for Markdown document creation/update/commenting/publish.
3. Package as a separate app only after the route proves the document model and
   editing loop.

The first product question is whether documents belong under `/m`, under a
combined dashboard/home route, or under a kind-aware hosted catalog. The
prototype showed that a new route can work technically, but user navigation,
creation, sharing, recency, and naming should probably be solved with the
notebook home rather than beside it.

Suggested Cloud API shape:

```http
POST /api/markdown-documents      # create/import body
PATCH /api/markdown-documents/:id # edit body or artifact refs
POST /api/markdown-documents/:id/publish
```

Return a document id, edit URL, live URL, and publish URL. Store durable
snapshots in the same R2/D1 style as notebooks, with a document-kind field rather
than a parallel hosting system.

Suggested MCP surface: create/get/update/publish Markdown documents, attach
artifacts, and create/reply/resolve comments. Keep the first tool set small and
let range-edit or component-specific tools appear when the route proves the
workflow.

## Open Comments

OC-1: Document model

Use Automerge text/string for `body` initially. Treat compaction and versioning
as part of the product path, not as a blocker: record a version, copy visible
state into a fresh Automerge document when history gets heavy, and retain old
snapshots as version history. Benchmark LLM-heavy editing so we know when to
compact.

OC-2: Projection schema v2

The Rust engine has richer structure than the TypeScript plan exposes. Island
projection fields (`content_hash`, `island_tag`, `island_inline`) now serialize
in Rust JSON (`crates/nteract-markdown-engine/src/render_json.rs:210`) but are
missing from the TypeScript `MarkdownProjectionBlock` interface. Add
`isolatedRegions`, `root` or a stable tree summary, parse diagnostics,
`outputArtifacts`, and `componentArtifacts` to the WASM/TS schema before
building much UI on top of the flattened shape. Inline JSX islands are created
at `crates/nteract-markdown-engine/src/lib.rs:1204`.

OC-3: Editor choice

Stay with CodeMirror plus projection. We already have full block knowledge from
the markdown engine, and CodeMirror is the raw projection editor. Rich rendered
editing should lean into the projection/block model rather than introduce a
separate ProseMirror/Milkdown/Lexical document model.

OC-4: MDX trust and component registry

Define the component registry before enabling live MDX rendering. Open question:
is the registry per workspace, per Cloud room, per document, or per publisher?
Also decide whether component implementations are bundled app components,
uploaded artifacts, or MCP-created side files.

OC-5: Comments ADR scope

Either amend `notebook-comments-document.md` into a generic comments document
ADR, or create a sibling `document-comments.md` ADR that references the notebook
ADR and only changes locator types.

OC-6: Public presence

Hosted ADRs still leave public anonymous presence visibility open. Markdown
publish should keep anonymous presence local/aggregate only until that decision
is made.

OC-7: Output lifecycle

When a code block changes, the output artifact should not disappear silently. The
`source_hash` in the metadata comment should drive a visible stale state and an
API path for reattaching/replacing the output.

OC-8: Import/publish attribution

Cloud publish cannot trust local historical Automerge attribution. It should
record the publisher/importer identity it can verify. Imported comments, if ever
included, should carry imported authority fields rather than masquerading as
cloud-stamped authorship.

OC-9: Route versus app

Start as a shared document surface inside the hosted/desktop product shell.
Package a separate app once the document model, comments, and Cloud posting flow
are real. A new app or isolated route too early would duplicate
rail/viewer/editor/auth infrastructure before the boundaries are known.

OC-10: File sync conflict policy

Desktop syncing to a local `.md` file needs a conflict rule when both the
Automerge document and filesystem file change. Likely policy: import external
file edits as a new local actor/change when the file watcher sees a newer mtime,
but preserve Automerge as the live collaboration source while the app is open.

## Suggested Next Spike

1. Build an Elements fixture for a Markdown Plan shell that deliberately shares
   notebook-like app chrome: title editing, document mode controls, source /
   rendered / split controls, left rail outline, rendered Markdown, source
   editor mode, rendered presence overlays, output-artifact placeholders, and
   comments placeholders.
2. Extend the markdown projection engine to parse `<!-- nteract:output ... -->`
   comments after code blocks into output artifact references.
3. Refresh TypeScript `MarkdownProjectionBlock` interface to match Rust island
   fields (`content_hash`, `island_tag`, `island_inline`). Expose
   `isolated_regions`, `root` or stable tree summary, parse diagnostics,
   `outputArtifacts`, and `componentArtifacts` through the WASM/TypeScript
   projection schema.
4. Draft a comments ADR amendment for generic document locators.
5. Sketch the hosted catalog/dashboard shape before committing to `/m`-specific
   D1 tables or Durable Object classes.
6. Sketch the Cloud `POST /api/markdown-documents` and MCP tool schemas only
   after the catalog shape is clear.
