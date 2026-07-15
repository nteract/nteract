---
name: record-ui
description: Record a browser e2e video of any UI flow in the notebook app, then open it at 2x speed. Use when asked to record, demo, or visually verify a UI change across worktrees.
---

# Record UI Flow

Use this skill to write a throwaway Playwright spec that records a UI flow,
run it, and immediately view the result. The spec doesn't need to be committed
unless it covers something worth keeping as a regression guard.

## Quick reference

```bash
# Run a specific spec (handles daemon + Vite lifecycle per worktree)
cd apps/notebook
node e2e/run-browser-e2e.mjs <spec-file>

# Open the most recent video at 2x speed (lossless re-encode)
node e2e/show-video.mjs [pattern]   # pattern = substring of spec/dir name
```

## Spec template

```ts
import { expect, test } from "@playwright/test";
import { openNotebookRoom, waitForKernelStatus } from "./helpers";

test.use({
  viewport: { width: 1440, height: 900 },
  video: { mode: "on", size: { width: 1440, height: 900 } },
});

test.describe("<feature>", () => {
  test("<what happens>", async ({ page }) => {
    test.setTimeout(180_000);

    const notebookId = crypto.randomUUID();
    await openNotebookRoom(page, notebookId);
    await waitForKernelStatus(page, "idle", 120_000);

    // ... drive the UI ...

    await page.waitForTimeout(1_500); // let the recording settle
  });
});
```

**Critical placement:** `test.use(...)` must be at the top level of the file,
not inside `describe`. Playwright ignores it inside a describe block.

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
| `openNotebookRoom(page, id)` | Navigate to a fresh ephemeral notebook room |
| `openNotebookPath(page, path)` | Open a notebook by file path |
| `waitForKernelStatus(page, status)` | Wait for kernel to reach a status (e.g. `"idle"`) |
| `ensureCodeCell(page)` | Get or create the first code cell |
| `ensureMarkdownCell(page)` | Get or create the first markdown cell |
| `setCellSource(cell, text)` | Set cell content via CodeMirror API |
| `executeCell(cell)` | Click the execute button on a cell |
| `waitForOutputContaining(cell, text)` | Wait for output stream to contain text |

## Workflow

1. Write spec to `apps/notebook/e2e/<name>.spec.ts`
2. Run: `node e2e/run-browser-e2e.mjs <name>.spec.ts`
3. Open video: `node e2e/show-video.mjs <name>`
4. Discard or commit the spec depending on whether it's worth keeping
