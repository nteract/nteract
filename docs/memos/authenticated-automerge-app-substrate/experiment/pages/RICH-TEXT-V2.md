# Pages rich text v2

**Direction, November 8, 2026:** build and try a streamlined, ProseMirror-free
Pages service separately. Leave `pages.runtimed.run` unchanged. This document
describes the replacement, not behavior already shipped. Current behavior is
in [REFERENCE.md](REFERENCE.md).

## Goal and boundary

Humans and agents collaborate on the same rich content. Wordgard supplies the
in-memory tree; Automerge owns shared content. Markdown is an import/export
convenience, not the source of truth. Remove ProseMirror rather than extending
its schema, adapters, or validators.

Agents can make reversible engineering choices, implement them, and deploy
isolated experiments without waiting for approval of every schema detail.
Record the chosen behavior and test it. Removing a dependency is not approval
to discard user content, weaken access controls, or remove rich features.

| Target | Boundary |
| --- | --- |
| `pages` (`pages.runtimed.run`) | Leave the running service, state, configuration, and routes alone. No automatic promotion, migration, or reset |
| `pages2` (`page2.runtimed.run`) | Candidate isolated service on lab2. Verify actual ownership, data, and deployment isolation before use; a profile comment does not prove emptiness |
| `page10` | Staging; resetting is permitted. Verify the reset's scope and preservation needs before executing it |

Neither staging target has a required place in a multi-release migration.
Use [DEPLOYMENT.md](DEPLOYMENT.md) to establish isolation. Do not reset or
rewrite the stable service to make the replacement easier to deploy.

## Three layers

The replacement keeps the distinction between stored identity and a rendered
tree. The examples below are simplified projections, not an Automerge save
format or a settled v2 schema.

### Page membership and order

```text
Page
  blocks: map keyed by stable block ID
    block-a: { position: RawString("a0"), richText: Automerge text }
    block-b: { position: RawString("a1"), richText: Automerge text }
```

Blocks stay in a map ordered by fractional `position`, with stable ID as the
tiebreak. Change the position to move a block without replacing its text.
Do not use delete/copy/reinsert operations on an Automerge list for movable
block membership. They can duplicate concurrent moves and disconnect edits
from the copied object.

Current allocation lives in `model/order.mjs`. Ties and key growth need an
explicit policy with concurrent-move tests. Rewriting neighbors to open a gap
can overwrite a concurrent move; do not assume it is safe because the group
is small. A visible scalar conflict winner is deterministic, not a wall-clock
last-writer guarantee.

### Text, marks, and markers

`A.spans` returns a JavaScript projection of a block's Automerge text:

```json
[
  { "type": "text", "value": "Hello " },
  { "type": "text", "value": "team", "marks": { "strong": true } },
  { "type": "block", "value": {
    "type": "heading", "parents": [], "attrs": { "level": 2 },
    "isEmbed": false
  } },
  { "type": "text", "value": "Next" }
]
```

The returned array is not stored block membership. Collaborative text needs
sequence semantics. Marker attributes and parent paths need deliberate merge
semantics too; avoiding block-order lists does not settle those choices.

### Wordgard projection

```json
{
  "type": "Doc",
  "content": [
    { "type": "Paragraph", "content": [
      { "type": "Text", "param": "Hello " },
      { "type": "Text", "param": "team", "marks": { "Strong": null } }
    ] },
    { "type": "Heading", "param": 2, "content": [
      { "type": "Text", "param": "Next" }
    ] }
  ]
}
```

The local tree's `content` arrays are not nested Automerge lists. The codec
maps between this tree and shared text offsets. Reuse the correct native
schema and codec work in `model/wordgard-doc.mjs`.

## Build a coherent native path

Replace the Markdown parser, remaining PM tree consumers, validation, and
structural writers together on the experiment branch. Inline Markdown already
has a native path in `model/markdown-inline.mjs`. Block parsing and other
remaining PM consumers need source-backed inventory, not another permanent
adapter layer.

Preserve text objects, marker identity, comments, assets, and untargeted peer
edits. Prefer splices and in-place attribute/mark changes. `A.updateSpans`
diffs a projection; its use is not proof of wholesale replacement, but broad
diffs still need identity and concurrent-edit tests. `A.updateBlock` replaces
a marker and is not an identity-preserving attribute edit.

Canonical encoder output does not imply every concurrent merge has that
shape. Choose deterministic, content-preserving rendering for merge outcomes
and validate it against real edits. Keep authorization and resource bounds
independent of structural presentation; a permissive decoder is not admission.

Historical adapter-byte parity is not a requirement for the fresh experiment.
Retire obsolete adapter-specific fixtures with their implementation. Keep
behavioral regressions and concurrency, authorization, and preservation tests.
A mass test-deletion PR is not a prerequisite.

## Experimental choices

These are design areas to resolve while building and testing, not a queue of
questions the maintainer must answer before work starts.

| Area | Evaluate |
| --- | --- |
| Markers and paths | Explicit opening markers, atomic parent paths, stable addressing after retype and deletion |
| Block granularity | Coarse text blocks versus smaller movable nodes; split/join and cross-block editing costs |
| Rich semantics | Line breaks, links and titles, images, tables, dataframes, comments, and unknown content |
| Agent operations | Typed reads/writes, safe Markdown projection, stable selectors, and minimal patches |
| Admission | Host checks across browser and agent writes, valid concurrent merges, and bounded cost |
| Format ownership | Where the format descriptor lives and how incompatible clients are refused safely |

Do not remove link titles, hard breaks, or existing content types merely to
make the encoder simpler. Prefer retaining useful semantics unless a measured
experiment establishes a better alternative.

## Demonstrate readiness

Build one useful vertical path: create rich content, edit it simultaneously
from a browser and an agent, reconnect, restart the isolated service, and read
the same content back. Then exercise comments, assets, permissions, and errors.

| Evidence | What it establishes |
| --- | --- |
| Codec and merge properties | Deterministic projections; valid concurrent edits stay readable without dropping content |
| Identity and anchor regressions | Targeted edits keep unrelated text, nodes, and comments attached |
| Human-agent browser tests | Both clients operate on the same live content, including undo and reconnect |
| Host tests | Access, size limits, idempotent receipts, and persistence behavior remain enforced |
| Isolated restart/recovery test | Acknowledged edits survive; unsaved work is visible and recoverable |
| Dependency and bundle checks | No production ProseMirror imports or packages remain |
| Maintainability review | One documented model, fewer conversion paths, readable ownership, and understandable failures |

Use ordinary reviewable commits on the experiment branch. Deploy a tested
candidate through the existing isolated target workflow; record source, build,
namespace, checks, and known limits. Final production hostname and promotion
remain separate decisions.

## Documentation and retained service

[README.md](README.md) is the entry point. [REFERENCE.md](REFERENCE.md)
documents the current implementation. [archive/](archive/) holds superseded
plans and migration records, not active instructions. An archived failure
report can still supply a useful regression test.

Open PRs and previous candidates need explicit disposition against the new
work. This document does not close them or erase existing rollout protections.
Mixed-version protections can be omitted from a truly isolated new-format
deployment only after confirming no old receiver can own its state.
