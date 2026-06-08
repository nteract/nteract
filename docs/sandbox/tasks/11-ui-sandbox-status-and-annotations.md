# Task 11: Sandbox status badge and cell annotation overlays

## Framing

Make sandbox state visible during kernel runtime. Two surfaces:
1. A header badge showing whether the kernel is running with sandbox active, degraded, or off
2. Per-cell overlays that render `CellAnnotation`s next to the cell when sandbox events affect it

Depends on task 02 (annotations data model). Can run in parallel with tasks 09 and 10.

## Context to read

- `docs/sandbox/decisions.md` — especially **D-7 (annotations not in cell output)**
- `docs/sandbox/ux-credential-sandbox-design.md` — the UI mockups and copy for status indicators and overlays
- `docs/sandbox/error-routing-design.md` — the four error scenarios and their user-facing messages
- `apps/notebook/src/AGENTS.md` — frontend conventions
- `apps/notebook/src/components/CodeCell.tsx` — current cell rendering shape; understand where outputs render but **do not** modify the output region
- `apps/notebook/src/components/NotebookToolbar.tsx` — example of a notebook-level UI element

**Do not read** other task files in `docs/sandbox/tasks/`.

## Background

There are two distinct UI sources of truth:

- **Kernel-level sandbox state** (`SandboxState` from task 07): synced via Automerge, accessible from the runtime state document. Displayed in the notebook header.
- **Cell-level annotations** (`CellAnnotation` map from task 02): synced via Automerge, keyed by `execution_id`. Displayed inline with the cell that produced the matching execution.

Annotations are **never** mixed into cell output (per **D-7**). They are a separate visual layer overlaid on or adjacent to the cell. The exact placement is a design choice — recommended: a banner above the output region, visually distinct (warning color, sandbox icon).

## Technical steps

### 1. Sandbox status badge

Add a small badge to the notebook header (near the kernel status indicator). States:

| State | Label | Color | Tooltip |
|---|---|---|---|
| `Disabled` | Sandbox: Off | gray (or hidden if you prefer) | "This notebook has no sandbox profile." |
| `Active` | Sandbox: Active | green | "Network calls are routed through nono. Click for details." |
| `StartupFailed` | Sandbox: Failed | red | "Sandbox failed to start. Check the credentials referenced by this notebook." |
| `Degraded` | Sandbox: Degraded | yellow | "The sandbox proxy stopped. Restart the kernel to recover." |

Click target: opens the sandbox panel (delivered by task 10) for editing the profile, or a read-only equivalent if task 10 hasn't shipped yet.

Read the state from the runtime state document. The exact path will depend on how task 07 surfaces `SandboxState` — coordinate via the contract: the runtime state has a `sandbox` field with the typed enum.

### 2. Cell annotation overlays

For each cell, look up `RuntimeStateDoc.cell_annotations[execution_id]` for the cell's most recent execution. If present, render an annotation banner. Recommended placement: above the cell's output region, below the source code editor.

Banner anatomy:

- Icon (warning shield for blocks, key icon for credential issues, plug icon for proxy degraded)
- Title (the `kind`, mapped to a human label)
- Message (the `message` field, rendered verbatim — it is already user-facing copy from task 08)
- Optional details disclosure ("Show details") that expands to render `details` JSON in a `<pre>` block

Map of `kind` → label + icon:

| kind | label | icon |
|---|---|---|
| `sandbox_domain_blocked` | Domain blocked | shield-x |
| `sandbox_credential_missing` | Credential missing | key-x |
| `sandbox_credential_rejected` | Credential rejected by upstream | key-warning |
| `sandbox_proxy_degraded` | Sandbox proxy stopped | plug-off |
| `sandbox_startup_failed` | Sandbox failed to start | alert-octagon |

Unknown `kind` values render with a generic fallback icon and the `kind` as label. **Do not** crash on unknown kinds — task 08 may extend the taxonomy in future tasks.

### 3. Degraded-state toast

When `SandboxState` transitions to `Degraded` (proxy died mid-session), show a toast notification at the top of the notebook with the message:

> The sandbox proxy stopped. Subsequent network calls will fail. Restart the kernel to recover.

Action button: "Restart kernel."

The toast uses the existing notification system. Show only on the transition, not continuously.

### 4. State subscription

These are reactive components that subscribe to the runtime state document. Use whatever Automerge subscription pattern is already in place in the frontend (likely a hook that re-renders on state change for the relevant keys).

Be careful about cell rendering performance: per the AGENTS.md "Cell list uses stable DOM order" invariant, the cell list iterates `stableDomOrder` and uses CSS `order`. Annotation overlays must not break this — render them as descendants of each cell, not as separately-ordered siblings.

### 5. Tests

- Component tests for the badge in each state
- Component tests for the annotation banner with each `kind`
- A snapshot or interaction test for the degraded toast
- A test confirming an unknown `kind` renders with the fallback (no crash)
- An integration test (using a synthetic runtime state document) confirming the badge updates as state changes

## Interfaces produced

- `SandboxStatusBadge` component
- `CellAnnotationOverlay` component
- Toast integration for degraded state

Consumed by users only.

## Success criteria

- The badge correctly reflects every `SandboxState`
- Annotations render next to the cell whose execution produced them
- Cell list reordering during annotation arrival does not destroy iframes (the stable DOM order invariant holds)
- All UI text matches `ux-credential-sandbox-design.md`
- Frontend lint passes
- Tests pass

## In scope

- The sandbox status badge in the notebook header
- The annotation overlay component
- The degraded-state toast
- Wiring these into the notebook page
- Tests

## Out of scope

- Authoring or editing the profile — task 10
- The credential manager UI — task 10
- Modifying cell output rendering (annotations are a parallel surface, never an output)
- Live in-flight prompts (per **D-10**)
- Audit log viewer (deferred)
- Per-cell network call inspector showing real-time HTTP traffic (deferred)
- Notification settings/preferences (defer until users ask)
