---
name: record-ui
description: Record a browser e2e video of any UI flow in the notebook app, then open it at 2x speed. Use when asked to record, demo, or visually verify a UI change across worktrees.
---

# Record UI Flow

Use this skill to write a throwaway Playwright spec that drives a UI flow. One
run produces **two artifacts** from the same execution:

- **`video.webm`** — the whole flow, for humans and PR attachments.
- **`frame-<label>.png`** — labeled screenshots at points you mark with
  `screenshot(page, "label")`. These are what an **agent** can actually Read to
  verify its own work (I can view PNGs, not video).

Both land in the gitignored, per-worktree `apps/notebook/test-results/<test>/`
dir, so nothing commits and parallel worktrees never collide.

The spec doesn't need to be committed unless it covers something worth keeping
as a regression guard.

## Agent self-check loop

1. Write a spec that drives the change; drop `await screenshot(page, "NN-label")`
   at each state worth inspecting.
2. Run it (below). Get the PNG paths with `show-frames.mjs`.
3. **Read the PNGs** to confirm the change looks right. Iterate on the code (and,
   if needed, move/add `screenshot()` calls) and re-run until correct.
4. The `.webm` from the final run is the artifact to attach to the PR.

## Quick reference

```bash
cd apps/notebook

# Run a spec (handles daemon + Vite lifecycle per worktree)
node e2e/run-browser-e2e.mjs <spec-file>

# List the labeled screenshot PNGs from the last run (for the agent to Read)
node e2e/show-frames.mjs [pattern]   # pattern = substring of spec/dir name

# Open the most recent video at 2x speed (lossless re-encode; for humans)
node e2e/show-video.mjs [pattern]
```

## Spec template

```ts
import { expect, test } from "@playwright/test";
import { markKernelReady, openNotebookRoom, screenshot } from "./helpers";

test.use({
  viewport: { width: 1440, height: 900 },
  video: { mode: "on", size: { width: 1440, height: 900 } },
});

test.describe("<feature>", () => {
  test("<what happens>", async ({ page }) => {
    test.setTimeout(180_000);

    const notebookId = crypto.randomUUID();
    await openNotebookRoom(page, notebookId);

    // Trim the load prefix. Pick the mark matching the surface you're demoing —
    // markKernelReady here because this flow runs a cell. See "Trimming" below.
    await markKernelReady(page);

    // ... drive the UI, snapshotting states the agent should inspect ...
    await doSomething();
    await screenshot(page, "01-after-something");

    await doNextThing();
    await screenshot(page, "02-after-next-thing");

    await page.waitForTimeout(1_500); // let the recording settle
  });
});
```

**Critical placement:** `test.use(...)` must be at the top level of the file,
not inside `describe`. Playwright ignores it inside a describe block.

## Trimming the load prefix

Playwright records the whole context lifetime and has no pause/resume, so every
video opens with notebook load + kernel startup. Mark where the interesting
footage begins; `show-video.mjs` seeks past that prefix (`ffmpeg -ss`) before the
2x speed-up. Skip the mark entirely and the full video is used unchanged.

**"Ready" is per-surface, not one global flag.** Different surfaces settle at
different times, so call the mark that matches the feature your video demos.
Each named mark *waits for its own readiness signal, then* stamps the trim point,
so the meaning is verified rather than implied by whatever you awaited above it:

| Mark | Clip starts when… | Use for |
|------|-------------------|---------|
| `markCellsReady(page)` | doc synced + session ready (cells render, kernel may still be launching) | document edits: add/reorder/delete cells, markdown |
| `markKernelReady(page)` | kernel is idle | flows that execute cells |
| `markCommentsReady(page)` | Discussions panel mounted + composer visible (opens the rail if needed) | comment / @ana flows (needs `enable_comments`) |
| `markClipStart()` | *right now*, asserts nothing | raw primitive — a surface with no named mark yet |

Marking is idempotent and last-wins: if a flow crosses surfaces, call each mark
in order and the clip starts at the latest one. Add a new `mark*Ready` helper in
`helpers.ts` when you record a surface that doesn't have one — prefer that over
sprinkling bare `markClipStart()` calls, so the readiness gate stays explicit.

## Screenshots for agent inspection

`screenshot(page, "label")` captures a crisp, full-res PNG at the current
moment — the artifact an agent can Read (unlike the `.webm`). Prefer inline
`screenshot()` calls over extracting frames from the video: `ffmpeg -ss` seeks
by timestamp (brittle — shifts when the flow's timing changes, and the 2x
re-encode renumbers frames), and video frames are scaled/mushy for small UI
text. Screenshots are labeled, deterministic, and full-resolution.

```ts
await page.getByRole("button", { name: "Save" }).click();
await screenshot(page, "01-after-save");   // → frame-01-after-save.png
```

- Label with a numeric prefix (`01-`, `02-`) so the files sort in flow order.
- Files land next to `video.webm` in `test-results/<test>/`; the label is
  sanitized to `frame-<label>.png`. Omit the label for an auto-index.
- Each screenshot is also attached to the Playwright HTML report / trace.

After the run, list them for reading:

```bash
node e2e/show-frames.mjs <pattern>   # prints one absolute PNG path per line
```

Then Read those paths to verify the UI, iterate, and re-run.

## Videos persist for before/after comparison

Playwright **wipes each test's output dir on every run**, so the source
`video.webm` (and anything written beside it) does NOT survive a re-run. To keep
before/after clips, `show-video.mjs` archives every encoded 2x video into a
persistent, gitignored `e2e/recordings/` dir under a unique timestamped name:

```
apps/notebook/e2e/recordings/<spec-dir>-<YYYYMMDD-HHMMSS>-2x.webm
```

Re-running a spec and re-encoding never clobbers a prior recording — record the
baseline, make the change, record again, and diff the two clips side by side in
the browser. Prune `e2e/recordings/` by hand when you're done comparing.

## Typing text visibly

Use `pressSequentially` (not `fill`) so the recording shows keystrokes:

```ts
await input.pressSequentially("text here", { delay: 40 });
```

## Waiting for async UI

```ts
// Wait for an element to appear
await expect(page.getByTestId("some-element")).toBeVisible({ timeout: 30_000 });

// Wait for a count change (e.g. a reply arriving)
await expect(page.locator('[data-testid="comment-message"]')).toHaveCount(2, { timeout: 60_000 });
```

## Per-worktree isolation

`run-browser-e2e.mjs` derives the Vite port from the repo root hash, so
each worktree gets its own port automatically. No configuration needed.

The runner reuses an already-healthy relay (to save startup time), so after
editing the relay plugin or browser-host, kill the stale Vite first:

```bash
lsof -i :<port> | awk 'NR>1{print $2}' | xargs kill
# port = RUNTIMED_VITE_PORT env or the hash-derived one (see worktreeVitePort in playwright.config.ts)
```

## Feature flags (enable_comments, etc.)

The Vite relay now reads `settings.json` and includes it in the `ready`
message, so feature flags reach the browser app automatically. If a feature
panel isn't showing up, check that the flag is `true` in:

- Nightly: `~/Library/Application Support/nteract-nightly/settings.json`
- Stable:  `~/Library/Application Support/nteract/settings.json`

## Comments panel

```ts
// Open via the rail (requires enable_comments: true in settings.json)
await expect(page.getByRole("button", { name: "Discussions" })).toBeVisible({ timeout: 30_000 });
await page.getByRole("button", { name: "Discussions" }).click();

// Submit a comment
const panel = page.getByTestId("notebook-comments-panel");
const composer = panel.getByRole("textbox", { name: /add a comment/i });
await composer.pressSequentially("your text here", { delay: 40 });
await panel.getByRole("button", { name: /add comment/i }).click();

// Assert on messages (data-testid="comment-message", data-agent="true" for agent replies)
const messages = panel.locator('[data-testid="comment-message"]');
await expect(messages).toHaveCount(2, { timeout: 60_000 });
await expect(messages.nth(1)).toHaveAttribute("data-agent", "true");
```

## Available helpers (e2e/helpers.ts)

| Helper | Purpose |
|--------|---------|
| `markCellsReady(page)` | Start the clip once cells render (doc synced + session ready) |
| `markKernelReady(page)` | Start the clip once the kernel is idle (for exec flows) |
| `markCommentsReady(page)` | Start the clip once the comments composer is ready |
| `markClipStart()` | Raw primitive: start the clip now, asserting nothing |
| `screenshot(page, label)` | Capture a labeled `frame-<label>.png` for agent inspection |
| `openNotebookRoom(page, id)` | Navigate to a fresh ephemeral notebook room |
| `openNotebookPath(page, path)` | Open a notebook by file path |
| `waitForKernelStatus(page, status)` | Wait for kernel to reach a status (e.g. `"idle"`) |
| `ensureCodeCell(page)` | Get or create the first code cell |
| `ensureMarkdownCell(page)` | Get or create the first markdown cell |
| `setCellSource(cell, text)` | Set cell content via CodeMirror API |
| `executeCell(cell)` | Click the execute button on a cell |
| `waitForOutputContaining(cell, text)` | Wait for output stream to contain text |

## First run in a fresh worktree (build time)

The runner needs `target/debug/runt`, and the dev daemon needs
`target/debug/runtimed` (the expensive pyo3/napi build). A fresh worktree has an
empty `target/`, so the first run does a full **cold** `cargo build` — minutes.
Worse, `cargo xtask dev-daemon` and the `nteract-dev` `up` tool run `cargo build`
*every* time, so linking just the output binaries doesn't help: the build still
recompiles from scratch against the empty fingerprint DB.

**Fix: share the whole `target/` with the root repo** (against a warm target,
`cargo build` is a ~0.5s no-op, and the frontend hot-reloads via Vite):

```bash
cd apps/notebook
node e2e/link-build.mjs           # symlink target/ -> root repo's target/
node e2e/link-build.mjs --status  # check current linkage
node e2e/link-build.mjs --unlink  # restore an independent target/
```

**Only link a UI-only worktree.** cargo file-locks the target dir, so concurrent
builds serialize safely — the real hazard is fingerprint churn: if this
worktree's *Rust* differs from the root's, building here recompiles those crates
in the shared target and forces the backend dev to rebuild on their next
`cargo build`. So keep this worktree's Rust in sync with main (pure TypeScript/UI
work). For a branch that touches Rust, keep an independent target and pay the
one-time cold build. Verify before linking:

```bash
git diff --name-only origin/main...HEAD | grep -E '\.rs$|Cargo\.(toml|lock)$'
# empty output → safe to link
```

## Workflow

1. Write spec to `apps/notebook/e2e/<name>.spec.ts` with `screenshot()` calls at
   states worth inspecting.
2. Run: `node e2e/run-browser-e2e.mjs <name>.spec.ts`
3. Read the frames: `node e2e/show-frames.mjs <name>` → Read each PNG path.
4. Iterate on the code/spec and re-run until the UI is right.
5. Human review / PR: `node e2e/show-video.mjs <name>` (2x), attach the `.webm`.
6. Discard or commit the spec depending on whether it's worth keeping.
