# Agendoc Document Lineage

**Status:** Exploration
**Created:** 2026-06-14
**Audience:** Product, engineering, research, and AI collaborators
**Promotes to:** ADRs for document model, lineage storage, compaction
transforms, harness runtime boundaries, and hosted storage/API decisions

This memo sketches a first-class document model for agent sessions. The working
name is **Agendoc**. Naming is deliberately open: `AgentDoc` may be the document
type, `AgentMerge` may be the broader system, and the right name should become
clearer as the model proves itself.

The core idea is that the log is the agent. A chat transcript is one projection
over a richer local-first document that records messages, tool activity, task
state, artifacts, and lineage. Normal agent work mutates the live document.
Compaction, import, and fork operations create new documents with explicit
lineage back to the source document heads.

## Scope

This is not a proposal to make agent sessions into hidden notebooks or to reuse
`NotebookDoc` as the storage model. The notebook source tree is useful because it
already has strong patterns for Automerge documents, projections, hosted
snapshots, comments, presence, and sidecar state. Agendoc should borrow those
patterns without inheriting notebook-specific cell semantics.

The target document is closer to a harness-native agent session:

- a current chat projection with user, assistant, system, harness, and tool
  messages
- structured tool call and tool result representations
- a built-in task list that can be updated as first-class document state
- artifact references for files, diffs, screenshots, notebook outputs, external
  docs, eval traces, and other tool-specific payloads
- lineage from one document to another for compaction, import, fork, replay, and
  evaluation
- projections that let phones, desktops, agents, evaluators, and harnesses work
  with the same source document through different views

## Current Source Facts

### First-Class Documents Beat Hidden Notebook Shapes

`docs/memos/markdown-plan-documents.md:18` frames Markdown plans as an optimized
collaborative Markdown document type rather than executable notebook content.
That memo explicitly keeps document source, projection, comments, artifacts, and
hosted routes as first-class concerns; its proposed `MarkdownDoc` stores
authoring body, artifact refs, output artifacts, component artifacts, comments
doc identity, and metadata (`docs/memos/markdown-plan-documents.md:261`).

Agendoc should make the same move. The document may project to a chat UI, a task
panel, a replay timeline, an evaluator trace, or a notebook-like artifact view,
but those projections should not define the storage model.

### Cloud Hosting Already Has A Durable Revision Pattern

The hosted notebook cloud guide says R2 snapshot bundles and D1 catalog,
ACL, and revision rows are the durable hosted source of truth; Durable Object
storage is live-room recovery or hibernation cache, not the portability boundary
(`apps/notebook-cloud/AGENTS.md:19`). Latest live pages consume materialized
live room documents, while pinned revisions read persisted snapshot sets
directly (`apps/notebook-cloud/AGENTS.md:23`).

The current storage schema records revision rows with notebook heads, runtime
heads, optional comms heads, snapshot keys, and actor labels
(`apps/notebook-cloud/src/storage.ts:19`). The hosted artifacts ADR says durable
published artifacts are snapshot bundles plus blob objects and a catalog row,
and that revision rows record the heads, snapshot keys, runtime-state document
identity, optional comms coordinates, and actor label
(`docs/adr/hosted-notebook-artifacts.md:35`). Snapshot keys are already
document-oriented for runtime and comms sidecars:

```text
docs/{documentId}/snapshots/{headsHash}.am
```

Publishing validates that the notebook snapshot, runtime snapshot, optional
comms snapshot, referenced blobs, and expected runtime document identity agree
before recording a durable revision (`apps/notebook-cloud/src/index.ts:2326`,
`apps/notebook-cloud/src/index.ts:3388`). For Agendoc, the analogous durable
unit is not a notebook revision. It is a lineage point:

```text
Agendoc revision
  doc_id
  heads_hash
  snapshot_key
  sidecar_doc_ids + sidecar_heads_hashes
  blob inventory
  actor label
  created_at
  derived_from lineage refs
```

The important precedent is the boundary: save Automerge snapshots and blob
artifacts as durable evidence, and let D1 catalog rows name the revision, access
policy, and lineage relation.

### Automerge Heads Are The Right Coordinates

Automerge already gives the coordinate system Agendoc needs. A document identity
plus a set of heads names a causal point in that document's history. nteract
already treats document identity separately from heads: the runtime-state
identity ADR says the pointer is document identity, while heads remain version
coordinates owned by checkpoint, publish, and storage metadata
(`docs/adr/runtime-state-document-identity.md:62`).

Lineage should use the same coordinate system:

```text
source_doc_id + source_heads
  -> transform
  -> derived_doc_id + derived_heads
```

The transform may be a compaction, fork, import, replay, manual edit, eval
rewrite, or migration. It should record enough provenance to reproduce or audit
the transition: transform kind, actor label, model/tool versions, source
projection, policy prompt, selected source ranges, artifact refs, and evaluation
notes when available.

### Lists And Sequences Are Already Tractable

nteract has two useful ordering precedents:

- user-manipulated lists can use stable IDs plus fractional positions
- coordinator-owned process order can use monotonic `seq`

Notebook cells are stored in a map keyed by cell id with a `position`
fractional-index string, and reads sort by `position` with cell id as a
deterministic tie-breaker (`crates/notebook-doc/src/lib.rs:23`,
`crates/notebook-doc/src/lib.rs:1467`). Runtime executions carry a coordinator
owned queue `seq`, and the runtime sorts queued entries by that sequence
(`crates/runtime-doc/src/doc.rs:237`). The hosted room derives the next sequence
from the document so hibernation or reload cannot reset ordering
(`crates/runtimed-wasm/src/lib.rs:1184`).

Agendoc likely needs both. Messages, tasks, and projected blocks may need stable
IDs and fractional positions so humans or agents can reorder or splice them
without rewriting the whole list. Tool events and append-only harness events can
use monotonic sequence numbers when a coordinator owns ordering.

The distinction matters. A task list is a collaborative object. A tool event log
is usually a coordinator-authored record. They should not be forced into the
same list primitive.

## Proposed Direction

### 1. Treat Transcript As A Projection

The current chat log is still essential. It should be the default projection,
but not the only source of truth.

```text
Chat projection
  system and harness context
  user messages
  assistant messages
  visible tool calls and results
  compacted summaries
  resume context
```

The projection can hide tool payload details, collapse old turns, show compacted
summaries, or render task state inline. That is UI and context-shaping policy.
The Agendoc underneath keeps the structured objects needed to produce those
views again.

This lets a harness answer questions like:

- What did the assistant see at this point?
- Which tool outputs were visible, summarized, redacted, or omitted?
- Which task state was current when the next assistant message was generated?
- Which compaction policy produced this resumed context?

### 2. Make Tasks Built In

The live task list should be first-class Agendoc state, not merely text inferred
from the transcript. Tasks are part of the agent's working memory and control
surface. If they only exist inside prose, every compaction has to rediscover
them and may preserve them inconsistently.

Suggested shape:

```text
tasks/
  {task_id}/
    title
    status
    position
    current_summary
    created_from ref
    updated_from refs[]
    owner actor label?
    artifact_refs[]
```

Task changes are ordinary live document mutations. A compaction can carry tasks
forward unchanged, rewrite them, split one task into several, mark tasks
obsolete, or attach a summary explaining why the task state changed.

This is especially useful for harnesses because the task list becomes a stable
evaluation target: did the agent preserve the right pending work after
compaction? Did it retire completed work? Did it fork with the correct active
goal?

### 3. Represent Tool Activity As Events Plus Artifacts

Each tool has its own natural representation. A shell command result is not a
browser screenshot, a code review finding, a Drive document fetch, or a notebook
cell execution. Agendoc should not flatten them all into message text.

Instead, record tool activity as structured events with artifact references:

```text
tool_events/
  {event_id}/
    seq
    call_id
    tool_name
    status
    requested_from message/task/ref
    input_ref
    output_ref
    started_at
    completed_at
    redaction_policy
    projection_hint

artifacts/
  {artifact_id}/
    kind
    content_type
    blob_ref?
    nested_doc_ref?
    summary?
    provenance refs[]
```

The chat projection can render a compact tool card, a transcript line, a
human-readable summary, or nothing at all. Other projections can inspect the raw
tool payload, show a screenshot, replay a browser session, or compare file
patches.

### 4. Make Compaction And Forking Lineage Transforms

Ordinary session activity mutates the current Agendoc. Compaction and forking
are different: they produce new document shapes.

A compaction should not be modeled as deleting old messages from the same log.
It should create a derived Agendoc from a specific source document at specific
heads:

```text
Agendoc A @ heads h1
  -> Agendoc B @ heads h2
       transform: compact
       policy: "task-focused resume"
  -> Agendoc C @ heads h3
       transform: compact
       policy: "reasoning-preserving resume"
  -> Agendoc D @ heads h4
       transform: fork
       policy: "try alternate implementation"
```

That makes compaction testable. Different compaction policies can be tried from
the same source heads and then evaluated by resuming the agent. The harness can
ask which derived document produced better behavior, better task preservation,
better tool-use continuity, or better user experience.

Forking uses the same mechanism. A fork is not just a branch of chat messages.
It is a new Agendoc with explicit ancestry, inherited task state, selected
artifacts, and a different future.

### 5. Keep Lineage In The Document And In The Catalog

Lineage has two audiences:

- local peers and agents need lineage inside the document so it syncs,
  projects, and survives offline work
- hosted catalog/query paths need lineage rows so Cloud can list versions,
  forks, compacted variants, and eval outcomes without materializing every
  document

The document-level shape could be:

```text
lineage/
  parents/
    {lineage_ref_id}/
      source_doc_id
      source_heads_hash
      source_snapshot_key?
      relation: compacted_from | forked_from | imported_from | migrated_from
      transform_event_id

transforms/
  {transform_event_id}/
    kind
    actor_label
    model_ref?
    tool_refs[]
    policy_ref?
    source_projection_ref?
    notes
```

The hosted catalog can index the same relationships with normalized rows:

```text
document_revisions
document_lineage_edges
document_blobs
document_acl
```

This keeps Agendoc portable while still making cloud listing, sharing, and
evaluation practical.

### 6. Design For Projections From The Start

Agendoc is useful only if many clients can project the same document differently.
Likely projections:

- **Chat**: the familiar transcript and compose box
- **Task board**: current tasks, blocked work, completed work, ownership, source
  refs
- **Tool trace**: chronological tool calls, results, retries, redactions, and
  artifacts
- **Lineage graph**: forks, compactions, imports, migrations, and eval results
- **Resume context**: exactly what a model would receive at a given point
- **Notebook-like artifact view**: selected code, outputs, files, and rich
  rendered payloads
- **Evaluator view**: source heads, transform policy, resumed behavior,
  qualitative notes, metrics, and regressions

The chat UI can remain calm and direct, while the harness can inspect the richer
document.

## Sketch: Agendoc Shape

This is intentionally a sketch, not a schema commitment.

```text
Agendoc
  schema_version
  doc_id
  title
  metadata

  messages/
    {message_id}/
      role
      position or seq
      content_ref
      parent_message_id?
      created_by actor label
      created_at
      visible_in_chat_projection
      tool_call_id?
      artifact_refs[]
      task_refs[]
      source_refs[]

  tool_events/
    {event_id}/
      seq
      call_id
      tool_name
      status
      input_ref
      output_ref
      requested_from ref
      projection_hint

  tasks/
    {task_id}/
      title
      status
      position
      current_summary
      created_from ref
      updated_from refs[]
      artifact_refs[]

  artifacts/
    {artifact_id}/
      kind
      content_type
      blob_ref?
      nested_doc_ref?
      summary?
      provenance refs[]

  lineage/
    parents/
    transforms/

  projections/
    chat/
    resume_context/
    task_board/
    lineage_graph/
```

One open design question is whether projections should be cached inside Agendoc
or derived outside it. The likely rule is: durable authoring state and transform
decisions belong in the document; cheap display indexes should be derived;
expensive or model-authored projections may be stored as artifacts with
provenance.

## Compaction Semantics

Compaction should be explicit enough to compare. A compacted Agendoc should
record:

- source document id and source heads
- compaction policy name and prompt/config
- model and tool versions
- source projection used as input
- messages, tasks, artifacts, and tool events carried forward
- messages, tasks, artifacts, and tool events summarized or dropped
- task rewrite decisions
- known risks or evaluator notes

The resulting document may have fewer messages, different task summaries, and a
new resume-context projection. It should still retain enough lineage to let a
human or evaluator trace claims back to source material.

This creates a useful harness loop:

1. Pick an Agendoc at source heads.
2. Produce multiple compacted Agendocs with different policies.
3. Resume an agent from each derived document.
4. Compare task preservation, behavior, tool continuity, cost, and subjective
   feel.
5. Keep the compaction variant that actually works.

## Open Comments

OC-1: Naming

Use `Agendoc` in this memo as the project/document working name. Keep
`AgentDoc`, `AgentMerge`, and related names open until the model has enough
shape to know whether we are naming a document type, a sync system, a harness
product, or all three.

OC-2: Event log versus materialized state

There is tension between an append-only event log and editable materialized
state. The likely answer is both: retain append/provenance events where they
matter, but store materialized tasks, messages, and artifacts as current
document state so local-first peers can collaborate naturally.

OC-3: Task history granularity

Automerge history already records changes, but task projections may need
explicit `updated_from` refs for human-readable provenance. Decide which task
changes deserve explicit refs and which can rely on document history.

OC-4: Artifact storage

Small structured payloads may fit in the document. Large outputs, screenshots,
file snapshots, logs, and binary data should use blob refs or nested document
refs. The hosted model should reuse the current snapshot/blob boundary rather
than invent inline payload storage.

OC-5: Sidecar documents

Some state may deserve sidecar documents: comments, large tool traces, rich
artifacts, eval results, or per-device UI state. The document split should follow
authority, durability, and fan-out boundaries, not rendering convenience.

OC-6: Projection storage

Cached projections are tempting, especially for resume context and eval views.
The rule should be explicit: if a projection is cheap and deterministic, derive
it; if it is model-authored, expensive, or part of a compaction decision, store
it as an artifact with provenance.

OC-7: Separate repo boundary

Agendoc may become a separate repo or package. The early memo belongs here
because nteract already contains the relevant Automerge, projection, cloud
hosting, and harness-adjacent patterns. Extraction should wait until the document
model and hosting contract are clearer.

OC-8: Authorship and imported history

Hosted systems cannot blindly trust historical local Automerge attribution at
publish/import boundaries. Catalog rows should record the actor label the host
can vouch for, while imported document history remains provenance, not hosted
identity proof.

OC-9: Evaluation metadata

If compaction variants are compared by feel, the qualitative evaluation should
be captured. The lineage model should leave room for evaluator notes, model
scores, user choices, and "chosen successor" markers without making eval fields
mandatory for every fork.

## Suggested Next Spike

1. Draft a small Agendoc JSON/Automerge schema fixture with messages, tool
   events, tasks, artifacts, and lineage transforms.
2. Build two projections over the same fixture: chat transcript and task board.
3. Implement a toy compaction transform that produces a derived Agendoc with
   explicit `compacted_from` lineage.
4. Compare two compaction variants from the same source heads and record a
   qualitative evaluator note.
5. Sketch generic hosted document catalog tables that can support Agendoc,
   MarkdownDoc, and notebook snapshot bundles without forcing them into the same
   document schema.
