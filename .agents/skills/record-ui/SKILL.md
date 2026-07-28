---
name: record-ui
description: Record a browser e2e video of any UI flow in the notebook app, then open it at 2x speed. Use when asked to record, demo, or visually verify a UI change across worktrees.
---

# Record UI Flow

Drive a UI flow with a Playwright spec and get **two artifacts** from one run:

- **`video.webm`** — the whole flow, for humans and PR attachments.
- **`frame-NN-<label>.png`** — screenshots at the points you mark with
  `screenshot(page, "label")`. These are what an **agent** can actually Read to
  verify its own work (I can view PNGs, not video).

Both land in the gitignored, per-worktree `apps/notebook/test-results/<test>/`,
so nothing commits and parallel worktrees never collide.

**Recording is opt-in.** `NTERACT_E2E_RECORD=1` turns on the video viewport,
pacing pauses, and screenshot capture. Without it a spec runs as a normal test:
no video, no PNGs, no pacing delay. So a spec with `screenshot()` calls is safe
to commit and run in CI.

## Agent self-check loop

1. Write a spec that drives the change; drop `await screenshot(page, "label")`
   at each state worth inspecting.
2. Record it (below), then get the PNG paths with `show-frames.mjs`.
3. **Read the PNGs** to confirm the change looks right. Iterate on the code and
   re-run until correct.
4. The `.webm` from the final run is the artifact to attach to the PR.

## Quick reference

```bash
cd apps/notebook

# Record a spec (daemon + Vite lifecycle handled per worktree)
NTERACT_E2E_RECORD=1 node e2e/run-browser-e2e.mjs <spec-file>

# List the screenshot PNGs from the last run (for the agent to Read)
node e2e/show-frames.mjs [pattern]   # pattern = substring of spec/dir name

# Open the most recent video at 2x speed (for humans)
node e2e/show-video.mjs [pattern]
```

## Spec template

A recorded spec is just a normal spec — no viewport or video config:

```ts
import { expect, test } from "@playwright/test";
import { markKernelReady, openNotebookRoom, pauseForVideo, screenshot } from "./helpers";

test.describe("<feature>", () => {
  test("<what happens>", async ({ page }) => {
    test.setTimeout(180_000);

    const notebookId = crypto.randomUUID();
    await openNotebookRoom(page, notebookId);

    // Trim the load prefix. Pick the mark matching the surface you're demoing.
    await markKernelReady(page);

    await doSomething();
    await screenshot(page, "after-something");

    await pauseForVideo(page);   // pace the video; no-op when not recording
    await doNextThing();
    await screenshot(page, "after-next-thing");

    await pauseForVideo(page, 1_500); // let the recording settle
  });
});
```

## Recording resolution

`playwright.config.ts` records at a 1200x800 viewport and `helpers.ts` CSS-zooms
the page 2x, so the video frames the content a compact 600x400 window would
show, at full retina density. This is deliberate: Playwright's recorder captures
the viewport at CSS-pixel size and **ignores `deviceScaleFactor`**, so there is
no "record at 2x" option — a 600px viewport yields a blurry 600px video. Change
the size in one place (`videoSize` in the config), never per spec.

`show-video.mjs` opens the result through `video-viewer.html`, which scales the
video down by `devicePixelRatio` so it displays at the intended compact size
instead of QuickTime's oversized raw pixels.

## Trimming the load prefix

Playwright records the whole context lifetime and has no pause/resume, so every
video opens with notebook load + kernel startup. Mark where the interesting
footage begins; `show-video.mjs` seeks past it (`ffmpeg -ss`) before the 2x
speed-up. Skip the mark and the full video is used unchanged.

**"Ready" is per-surface, not one global flag.** Call the mark that matches the
feature you're demoing. Each mark waits for its own readiness signal *then*
stamps the trim point, so the meaning is verified rather than implied by
whatever you awaited above it.

| Mark | Clip starts when… | Use for |
|------|-------------------|---------|
| `markKernelReady(page)` | kernel is idle | flows that execute cells |
| `markClipStart()` | *right now*, asserts nothing | a surface with no named mark yet |

Marking is idempotent and last-wins. Add a new `mark*Ready` helper in
`helpers.ts` when you record a surface that needs a different readiness gate —
prefer that over sprinkling bare `markClipStart()` calls.

## Screenshots for agent inspection

`screenshot(page, "label")` captures a full-res PNG at the current moment — the
artifact an agent can Read (unlike the `.webm`). Prefer inline `screenshot()`
calls over extracting frames from the video: `ffmpeg -ss` seeks by timestamp
(brittle — shifts when the flow's timing changes) and video frames are mushy for
small UI text.

Files are named `frame-<NN>-<label>.png`, numbered in call order, so they sort by
flow position. They're also attached to the Playwright HTML report / trace.

```bash
node e2e/show-frames.mjs <pattern>   # prints one absolute PNG path per line
```

Then Read those paths, iterate, and re-record.

## Videos persist for before/after comparison

Playwright **wipes each test's output dir on every run**, so `video.webm` does
not survive a re-run. `show-video.mjs` archives every encoded 2x video into a
persistent, gitignored dir, nested by spec and test name and timestamped:

```
apps/notebook/e2e/recordings/<spec>/<test-title>-<YYYYMMDD-HHMMSS>.webm
```

So a spec's clips group in one folder — `rm -rf recordings/<spec>` to prune it.
The path comes from Playwright's `titlePath` via the `video-meta.json` sidecar
that `markClipStart()` writes, so nested `describe` titles become nested dirs.

So: record the baseline, make the change, record again, diff the two clips side
by side. Prune `e2e/recordings/` by hand when you're done comparing.

## Typing text visibly

Use `pressSequentially` (not `fill`) so the recording shows keystrokes:

```ts
await input.pressSequentially("text here", { delay: 40 });
```

## Per-worktree isolation

`run-browser-e2e.mjs` derives the Vite port from the repo root hash, so each
worktree gets its own port automatically.

The runner reuses an already-healthy relay to save startup time, so after
editing the relay plugin or browser-host, kill the stale Vite first:

```bash
lsof -i :<port> | awk 'NR>1{print $2}' | xargs kill
# port = RUNTIMED_VITE_PORT env or the hash-derived one (worktreeVitePort in playwright.config.ts)
```

## Feature flags (enable_comments, etc.)

The Vite relay reads `settings.json` and includes it in the `ready` message, so
feature flags reach the browser app automatically. If a feature panel isn't
showing up, check the flag is `true` in:

- Nightly: `~/Library/Application Support/nteract-nightly/settings.json`
- Stable:  `~/Library/Application Support/nteract/settings.json`

## Recording helpers (e2e/helpers.ts)

| Helper | Purpose |
|--------|---------|
| `markKernelReady(page)` | Start the clip once the kernel is idle |
| `markClipStart()` | Raw primitive: start the clip now, asserting nothing |
| `screenshot(page, label)` | Capture `frame-NN-<label>.png` for agent inspection |
| `pauseForVideo(page, ms)` | Sleep only while recording, to pace the video |

The rest of `helpers.ts` (`openNotebookRoom`, `executeCell`,
`waitForOutputContaining`, …) is the normal e2e surface — read the file.
