// Run against this worktree's loopback-only Pages dev fixture. No public writes.
import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import * as A from "@automerge/automerge";
import { cbor } from "@automerge/automerge-repo";
import { resolveCommentDraft } from "../viewer/comment-draft.mjs";

const origin = process.env.PAGES_ORIGIN;
assert.equal(new URL(origin).hostname, "localhost");
const output = process.env.PAGES_SCREENSHOTS;
assert.ok(output);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  let refuse = false;
  await context.routeWebSocket("**/api/sync?*", (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((bytes) => {
      const frame = cbor.decode(bytes);
      if (refuse && frame.t === "sync") {
        socket.send(
          Buffer.from(
            cbor.encode({
              t: "refused",
              doc: frame.doc,
              r: frame.r,
              code: "invalid_page_content",
              message: "Fixture refusal",
              fatal: false,
            }),
          ),
        );
      } else server.send(bytes);
    });
  });
  const page = await context.newPage();
  const downloads = [];
  page.on("download", (download) => downloads.push(download));
  await page.goto(origin);
  await page.getByRole("link", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "New Page", exact: true }).click();
  await page.getByRole("textbox", { name: "Page title" }).fill("Recovery smoke");
  const editor = page.getByRole("textbox", { name: "Document text", exact: true });
  await editor.fill("Capture native history");
  await expect(page.getByRole("status").filter({ hasText: /^Saved$/ })).toBeVisible();
  refuse = true;
  await editor.fill("Rejected local history");
  await expect(page.getByText(/Sync returned invalid_page_content/)).toBeVisible();
  await editor.focus();
  await page.keyboard.press("Meta+a");
  await page.keyboard.press("Meta+Alt+m");
  const composer = page.getByRole("textbox", { name: "Comment on selection" });
  await composer.fill("Unsent rich draft");
  await page.keyboard.press("Meta+a");
  await page.keyboard.press("Meta+b");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Save recovery copy", exact: true }).click();
  await expect(
    page.getByText(/Recovery copy saved in this browser, not to the host/),
  ).toBeVisible();
  assert.equal(downloads.length, 0, "Save never downloads");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download recovery copy", exact: true }).click();
  const copy = JSON.parse(await readFile(await (await download).path(), "utf8"));
  assert.equal(copy.refusal_evidence.code, "invalid_page_content");
  assert.equal(copy.refusal_evidence.correlated, true);
  assert.ok(copy.document_id && copy.comments_document_id);
  const doc = A.load(Buffer.from(copy.snapshot, "base64"));
  const comments = A.load(Buffer.from(copy.comments_snapshot, "base64"));
  assert.deepEqual(A.getHeads(doc), copy.heads);
  assert.deepEqual(A.getHeads(comments), copy.comment_heads);
  assert.equal(copy.comment_drafts.length, 1);
  assert.equal(copy.comment_drafts[0].body, "Unsent rich draft");
  assert.ok(copy.comment_drafts[0].spans.some((span) => span.marks?.strong));
  assert.equal(
    resolveCommentDraft(doc, copy.comment_drafts[0].anchor).selected_text,
    "Rejected local history",
  );
  await expect(editor).toHaveText("Rejected local history");
  await page.screenshot({ path: `${output}/recovery-wide.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("button", { name: "Download recovery copy", exact: true }),
  ).toBeVisible();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: `${output}/recovery-narrow.png` });
  await page.setViewportSize({ width: 1280, height: 900 });
  page.on("dialog", (dialog) => dialog.accept());
  await page.reload();
  await expect(editor).toBeVisible();
  await page.locator('summary[aria-label="Document actions"]').click();
  const [restored] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download recovery copies", exact: true }).click(),
  ]);
  const bundle = JSON.parse(await readFile(await restored.path(), "utf8"));
  const archived = bundle.copies.find((item) => item.capture_id === copy.capture_id);
  assert.equal(archived.snapshot, copy.snapshot);
  assert.equal(archived.comments_snapshot, copy.comments_snapshot);
  assert.deepEqual(archived.comment_drafts, copy.comment_drafts);
  A.free(doc);
  A.free(comments);
  console.log(
    "PASS explicit recovery action, correlated refusal, native pair, rich anchored draft, no automatic download, narrow layout and archive after reload",
  );
} finally {
  await browser.close();
}
