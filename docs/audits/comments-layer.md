# Commenting Layer Audit

**Date:** 2026-06-21
**Audience:** Engineering, design
**Method:** Four read-only auditors over distinct facets (anchors + CommentsDoc sync/authority; selection + projection/highlight; UI flows + feature flag; consistency + a11y + identity), plus hands-on QA. Findings below cite `path:line` and carry a confidence note. Severity is P1 (data-loss / broken core action / wrong anchor), P2 (edge bug / gap), P3 (minor).

This audit followed the rendered-comment projection work in PR #3791. Several findings are the deferred items named in `docs/memos/projection-source-rendered-correspondence.md`; they are marked **deferred (memo)** rather than counted as new.

## Status legend

- **slice** — addressed in the comments design slice that accompanies this audit (composer restyle, rendered-highlight activation, rail restructure).
- **follow-up** — real, not yet fixed; needs its own change.
- **deferred (memo)** — already named as deferred in the projection memo; waits on the projector fidelity marker.
- **known** — intentional current state / planned but unbuilt.

## P1

### F-1 Ambiguous source quote can silently re-anchor to the wrong occurrence — follow-up
`apps/notebook/src/lib/comment-source-anchor.ts:194`, `:203`; `apps/notebook/src/App.tsx:234`, `:780`.
`resolveSourceRangeAnchor` returns a match whenever the quote exists anywhere in the cell source, picking the best-scoring occurrence even when prefix/suffix do not confidently disambiguate or scores tie. `sourceRangeAnchorMatchesCurrentCell` treats any non-null resolution as valid. Edit or move one of several identical snippets and a comment can rebind to the wrong one instead of going stale. Fix: tri-state resolution (`resolved` / `ambiguous` / `unresolved`); require a unique occurrence or strong prefix/suffix confirmation, otherwise refuse and surface stale/ambiguous. Confidence: verified in source; wrong-anchor manifestation needs a runtime test.

### COMMENT-003 Rendered highlights look clickable but cannot activate a thread — slice
`src/styles/comment-highlight.css:6`; `src/components/markdown/ProjectedMarkdownView.tsx:48`; `apps/notebook/src/components/MarkdownCell.tsx:1103`.
`.comment-highlight` sets `cursor: pointer`, but rendered highlights carry no thread id and no click/keyboard/role; CodeMirror highlights do activate. Confirmed by hands-on QA (clicking a rendered highlight does nothing; the editor works). Fixed in the slice by carrying `threadId` into rendered highlights and wiring click + Enter/Space activation through `onActivateCommentThread`.

### COMMENT-005 Output comment affordance is removed from tab order — follow-up
`apps/notebook/src/components/CodeCell.tsx:672`, `:902`.
The "Comment on outputs" button has `tabIndex={-1}`, so creating an output comment is mouse-only. No keyboard path found. Fix: make it keyboard-reachable when output gutter actions are available, or provide a command/context-menu path with visible focus.

### CMT-UI-01 The comments UI feature flag is entirely unbuilt — known
`src/hooks/useSyncedSettings.ts:98`; `apps/notebook/src/App.tsx:634`; `apps/notebook-cloud/viewer/notebook-viewer.tsx:1210`.
`FEATURE_FLAG_METADATA` has only `disable_nteract_launcher`; there is no `comments_enabled`. Every entry point (rail, right-click, `Mod-Alt-m`, inline popover, output affordance) is always live in writable sessions. This matches the plan to gate all comment UI behind one switch before stable, but that switch does not exist yet. Fix: add a `comments_enabled` synced setting and gate panel construction, creation handlers, context-menu actions, the CodeMirror keymap/tooltip extensions, the rendered affordance, the inline composer, and the cloud equivalents. Daemon sync stays wired.

## P2

### Selection and projection edges
- **F1 Images have no rendered-plane anchor — follow-up.** `src/components/markdown/ProjectedMarkdownView.tsx:238`, `:900`; `apps/notebook/src/lib/rendered-markdown-source-comment.ts:75`. `imageOnlyRun` / `ProjectedFigure` bypass `renderRuns` and never emit `data-markdown-source-run` / source offsets, so an image (or its alt text) cannot be selected to comment. Fix: route figures through the source-run-aware wrapper.
- **F2 Fenced code blocks and display math have no rendered anchors or highlights — follow-up.** `ProjectedMarkdownView.tsx:176`, `:195`, `:701`. Block code and display math render directly, not via run-span wrappers, and `commentHighlights` is not applied. A comment on a code block shows no rendered highlight and the block cannot be selected to comment. Same architectural fix as F1.
- **F3 Inline KaTeX math can mis-map a selection — follow-up (memo-aligned).** `ProjectedMarkdownView.tsx:875`; `rendered-markdown-source-comment.ts:83`, `:117`. The selection mapper treats `math-source` as transparent on length match, but the DOM is KaTeX HTML, so offsets skew. The memo already classes math as opaque; the selection path needs the same treatment the highlight path got. Confidence: suspected; needs a browser test.
- **F4 Entities/escapes over-anchor and over-quote the whole run — deferred (memo).** The piecewise-run class. `A &amp; B` selecting the `&` grabs the whole node. Waits on the fidelity marker (segments).
- **F5 Multiple highlights in one run collapse to one — deferred (memo, OQ-3).** Disjoint comments inside one run show only the best. Fix is to segment the run across all overlaps.

### UI flows
- **CMT-UI-03 Stale-source inline submit silently drops the draft — follow-up.** `apps/notebook/src/App.tsx:780`; `apps/notebook/src/components/InlineCommentComposer.tsx:54`; cloud `notebook-viewer.tsx:1351`. On a stale source, `handleSubmitSourceComment` clears the request and sets an error without throwing; the composer reads "no exception" as success, unmounts, and the typed body is gone. The error only shows in the rail. Fix: keep the popover open with a local error, or signal failure so the composer holds state.
- **CMT-UI-02 Rail and reply composers have no cancel path — follow-up.** `src/components/notebook/NotebookCommentsPanel.tsx:623`. Only Cmd/Ctrl+Enter is handled; Escape does nothing and a non-empty draft persists with no discard control. Fix: Escape to clear/collapse + an accessible discard button.
- **CMT-UI-04 "Show cell" can render and no-op for dangling anchors — follow-up.** `NotebookCommentsPanel.tsx:346`, `:752`; `App.tsx:1010`; cloud `:1518`. The panel decides to show the locate button via one helper, but hosts only use `badge_cell_ids[0]`; a valid-anchor / empty-badge thread renders a button that scrolls nowhere. Fix: share the resolver or hide the button for dangling threads.
- **CMT-UI-05 `cell` / `cell_range` anchors render but no UI creates them — follow-up.** `src/components/notebook/comment-types.ts:10`; `NotebookCommentsPanel.tsx:712`; `App.tsx:720`. Daemon/agent-created cell threads display and resolve, but humans cannot create them. Fix: add affordances or document these as agent-only kinds.

### Sync and reconnect
- **F-2 Output comment creation treats unloaded runtime state as valid — follow-up.** `src/components/notebook/output-comment-demotion.ts:23`, `:47`; `App.tsx:739`, `:769`. `outputCommentAnchorMatchesRuntimeState` is `!shouldDemoteOutputCommentAnchor`, so "unknown because unloaded" reads as "valid" for creation during reconnect. The demotion guard for the empty-store window is correct; this is the narrower residual (creation should block on `unknown`, not just avoid demotion). Fix: split into `match` / `stale` / `unknown`; creation requires `match`.
- **F-3 Rejected CommentsDoc optimistic mutations do not roll back locally — follow-up.** `App.tsx:654`; `crates/runtimed/src/notebook_sync_server/peer_comments_sync.rs:43`, `:55`; cloud `live-sync.ts:635`. Local UI applies a CommentsDoc change, then flushes; daemon strips non-writable changes and Cloud rejects the frame, but client recovery is scoped to sync divergence, not permission/actor rejection. Shared state is safe, but the originating client can render a comment that never landed. Fix: on non-recoverable `COMMENTS_DOC_SYNC` rejection, rebuild the local CommentsDoc from authoritative state; have the daemon return an explicit rejection rather than silent strip.

### Identity and a11y
- **COMMENT-001 Cloud viewer never sets `--comment-author-color` — follow-up.** `apps/notebook/src/App.tsx:815`; cloud `notebook-viewer.tsx:2066`. Desktop sets it from `colorForActorIdentity(localActor)`; cloud renders the same composer without it, so cloud create surfaces fall back to `--primary`. Fix: set/remove the variable in the cloud viewer the way desktop does.
- **COMMENT-002 White foreground fails contrast on several author colors — slice (partial).** `packages/runtimed/src/notebook-actor-color.ts`; `src/styles/comment-affordance.css:58`; `InlineCommentComposer.tsx:164`; `NotebookCommentsPanel.tsx:519`. `#d97706`, `#059669`, `#0891b2`, `#65a30d` behind white text run ~3.1 to 3.8:1, under 4.5. Fixed for the composer in the slice via a luminance-based `readableForegroundForColor`; the rail avatars and the affordance pill still need the same helper (follow-up).
- **COMMENT-004 CodeMirror highlights are mouse-only and screen-reader silent — follow-up.** `apps/notebook/src/lib/comment-highlight-extension.ts:63`, `:217`. Activation is `mousedown` only; no focus target, role, or label. Fix: keyboard activation + accessible annotation.
- **COMMENT-006 AI attribution is thin and inconsistent — follow-up.** `packages/runtimed/src/notebook-actor-display.ts:43`; `NotebookCommentsPanel.tsx:501`; `comment-highlight-extension.ts:165`. The resolver distinguishes agents (hover shows "AI for ..."), but the rail shows only the agent name plus "· for ..." with an `aria-hidden` bot cue, and rail vs hover disagree. Screen-reader users never hear that a comment is AI-authored. This is the "better notation of AI operating on behalf of the user" goal. Fix: a consistent visible or `sr-only` "AI agent" marker on the byline and resolution receipts.
- **COMMENT-007 Inline composer has no explicit focus restoration on close — follow-up.** `InlineCommentComposer.tsx:43`, `:101`. On Escape/outside-click the composer calls `onCancel` but does not return focus to the invoking element/selection. Fix: track the invoker and restore focus, or wire `onCloseAutoFocus`. Confidence: suspected; needs a keyboard session.

## P3

- **F6 Source-plane click activation off-by-one — follow-up.** `apps/notebook/src/lib/comment-highlight-extension.ts:69`, `:103`, `:217`. Uses `pos <= highlight.to`, so clicking the character right after a highlight opens that thread. Fix: `pos < highlight.to`, or drive activation from the decoration's `data-comment-thread-id`.
- **COMMENT-008 Elements doc teaches a stale trust/finalization model — follow-up.** `apps/elements/content/docs/comment-surfaces.mdx:53`. The catalog says the daemon "finalizes" a comment as "trusted," but the shipped model has no visible trusted/finalized state; trust comes from ingress actor binding. Fix: reword to the shipped model.

## Deferred to the projection memo

`docs/memos/projection-source-rendered-correspondence.md` already names these; they wait on the per-run fidelity marker (additive, payload `version: 1`):

- F4 piecewise runs (entities, escapes, soft breaks).
- F5 multiple highlights per run (OQ-3).
- F7 IsolatedFrame fallback has no comment affordance (OQ-4): `apps/notebook/src/components/MarkdownCell.tsx:1119`; `src/components/isolated/isolated-frame.tsx:137`. The iframe bridge forwards only mouse events and a `hasSelection` boolean, no source-range/keyup/context-menu/copy/highlight bridge.
- F3 inline math, opaque treatment in the selection path.

## What held up

- The highlight surface is genuinely centralized: one `.comment-highlight` class + `--cm-comment-color`, shared by CodeMirror (`comment-highlight-extension.ts:66`) and rendered markdown (`ProjectedMarkdownView.tsx:752`), imported by both desktop and Elements, with an Elements catalog entry.
- The reconnect empty-store window is guarded in the demotion path (the bug from #3762/#3764/#3765 did not recur); F-2 is the narrower creation-side residual.
- Persistence looks correct: accepted CommentsDoc changes save to sidecar storage, Cloud checkpoints include comments bytes, and public publish records no comments snapshot (off by default).
- The ADR's "daemon finalizes author/scope/resolve" language is not implemented; the shipped model (comments are authored Automerge changes, authority enforced at sync ingress) matches the ADR's current direction. COMMENT-008 is the stale doc.

## Recommended order

1. **F-1** (P1 wrong-anchor): tri-state anchor resolution. Highest correctness risk.
2. **COMMENT-003** (P1, in the slice): rendered-highlight activation.
3. **CMT-UI-03** (draft loss) and **F-3** (optimistic rollback): quiet data-loss / divergence.
4. **F1 / F2**: route images and code/display-math blocks through source-run wrappers so whole content categories become commentable (same shape as the shipped highlight work).
5. **COMMENT-001 / COMMENT-002 rail / COMMENT-006**: identity color in cloud, contrast everywhere, AI attribution.
6. **a11y batch**: COMMENT-004, COMMENT-005, COMMENT-007, CMT-UI-02, F6.
7. **CMT-UI-01**: the `comments_enabled` flag, before stable.
8. Projection-memo items when the fidelity marker lands.
