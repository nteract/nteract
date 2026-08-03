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

**Two apps, one rig.** The mechanics live in `packages/e2e-record` and are shared
by `apps/notebook` (desktop) and `apps/notebook-cloud` (hosted). This page uses
the desktop paths; for cloud flows the commands live under `e2e/browser/` and the
runner is `run-cloud-e2e.mjs` — see the [cloud section](#recording-a-cloud-flow).

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

Each app's `playwright.config.ts` declares the **effective CSS framing** it wants:

```ts
use: { ...videoRecordingUse({ width: 600, height: 400 }) }   // apps/notebook
use: { ...videoRecordingUse({ width: 1200, height: 800 }) }  // apps/notebook-cloud
```

`videoRecordingUse()` multiplies that by `VIDEO_ZOOM` (2) to get the capture
viewport, and `applyVideoZoom()` CSS-zooms the page by the same constant — so the
clip shows exactly the requested framing at full retina density. Both read one
constant, so they can't drift out of sync. This dance is necessary because
Playwright's recorder captures the viewport at CSS-pixel size and **ignores
`deviceScaleFactor`**: there is no "record at 2x" option, and a 600px viewport
yields a blurry 600px video.

Change the framing in the app's config, never per spec. Cloud records wider
because the list/dashboard chrome clips at the desktop's compact size.

`show-video.mjs` opens the result through the shared `video-viewer.html`, which
scales the video down by `devicePixelRatio` so it displays at the intended size
instead of QuickTime's oversized raw pixels (capped to the window, so an
oversized clip still fits).

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

## Recording a cloud flow

Same rig, cloud paths. Run from `apps/notebook-cloud`:

```bash
NTERACT_E2E_RECORD=1 node e2e/browser/run-cloud-e2e.mjs <spec-file>
node e2e/browser/show-frames.mjs [pattern]
node e2e/browser/show-video.mjs [pattern]
```

Cloud specs import from `e2e/browser/helpers.ts` and start with
`openHomePage(page)` (which marks the clip start itself, since the home-page
render *is* the start of the footage), then `signInWithLocalAuth(page)`. See
`apps/notebook-cloud/e2e/browser/home-to-notebook.spec.ts`.

## Recording helpers (e2e/helpers.ts)

Each app re-exports the shared helpers from `@nteract/e2e-record` through its own
`helpers.ts`, so specs always import from `./helpers`:

| Helper | Purpose |
|--------|---------|
| `screenshot(page, label)` | Capture `frame-NN-<label>.png` for agent inspection |
| `pauseForVideo(page, ms)` | Sleep only while recording, to pace the video |
| `markClipStart()` | Raw primitive: start the clip now, asserting nothing |
| `markKernelReady(page)` | *(desktop)* Start the clip once the kernel is idle |

The rest of `helpers.ts` (`openNotebookRoom`, `executeCell`,
`waitForOutputContaining`, …) is the normal e2e surface — read the file.

## Where the rig lives

`packages/e2e-record` holds everything mechanical, shared by both apps:

| Path | Purpose |
|------|---------|
| `src/recording.ts` | `screenshot`, `pauseForVideo`, `markClipStart`, zoom + `VIDEO_ZOOM` |
| `src/config.ts` | `videoRecordingUse()` for each app's `playwright.config.ts` |
| `src/show-video.mjs` | archive + ffmpeg encode + open the viewer |
| `src/show-frames.mjs` | list a run's PNGs |
| `src/video-viewer.html` | retina-correct playback page |

Each app keeps only a thin `e2e/show-video.mjs` / `show-frames.mjs` shim plus a
`recording-paths.mjs` naming its own `test-results/`, `recordings/`, and record
command. Fix recording behavior in the package, not in an app.
