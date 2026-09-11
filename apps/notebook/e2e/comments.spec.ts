import { expect, test } from "@playwright/test";
import {
  openNotebookRoom,
  executeCell,
  waitForKernelStatus,
  waitForOutputContaining,
  waitForNotebookSessionReady,
} from "./helpers";
import { McpPeer } from "./mcp-peer";

test("comments are always available and synchronize human and MCP replies across reconnect", async ({
  page,
  context,
}) => {
  const notebookId = crypto.randomUUID();
  await openNotebookRoom(page, notebookId);
  await page.getByRole("button", { name: "Discussions", exact: true }).click();
  const panel = page.getByTestId("notebook-comments-panel");
  const composer = panel.getByRole("textbox", { name: "Add a comment on the document" });
  await expect(composer).toBeEnabled();
  await composer.fill("Human document discussion");
  await composer.press("ControlOrMeta+Enter");
  await expect(panel.getByText("Human document discussion", { exact: true })).toHaveCount(1);

  const peer = await McpPeer.start();
  try {
    await peer.connectNotebook(notebookId);
    const threadId = await peer.createComment("MCP discussion");
    await expect(panel.getByText("MCP discussion", { exact: true })).toBeVisible();
    const thread = panel.getByRole("listitem").filter({ hasText: "MCP discussion" });
    await thread.getByRole("button", { name: /Reply to/ }).click();
    const reply = thread.getByRole("textbox", { name: /Reply to/ });
    await expect(reply).toBeFocused();
    await reply.fill("Human reply first");
    await reply.press("ControlOrMeta+Enter");
    await expect(thread.getByText("Human reply first", { exact: true })).toBeVisible();
    // Local rendering is optimistic. Establish that the MCP replica has seen
    // the human reply before testing a causally ordered follow-up from that peer.
    await expect.poll(() => peer.readCommentBodies(threadId)).toContain("Human reply first");
    await peer.replyComment(threadId, "MCP reply second");
    await expect(thread.getByText("MCP reply second", { exact: true })).toBeVisible();
    await expect(thread.locator("[data-comment-reply]")).toContainText([
      "Human reply first",
      "MCP reply second",
    ]);

    const second = await context.newPage();
    await openNotebookRoom(second, notebookId);
    await second.getByRole("button", { name: "Discussions", exact: true }).click();
    await expect(second.getByText("Human reply first", { exact: true })).toBeVisible();
    await thread.getByRole("button", { name: /^Resolve / }).click();
    await expect(panel.getByRole("button", { name: "Show resolved (1)" })).toBeVisible();
    await panel.getByRole("button", { name: "Show resolved (1)" }).click();
    await thread.getByRole("button", { name: /^Reopen / }).click();
    await expect(thread.getByRole("button", { name: /^Resolve / })).toBeVisible();

    await second.close();
    await page.reload();
    await waitForNotebookSessionReady(page);
    await page.getByRole("button", { name: "Discussions", exact: true }).click();
    await expect(panel.getByText("MCP reply second", { exact: true })).toBeVisible();
    await expect(panel.getByText("Human document discussion", { exact: true })).toHaveCount(1);
    await expect(panel.getByText("Human reply first", { exact: true })).toHaveCount(1);
    await page.screenshot({ path: "test-results/comments-wide.png", fullPage: true });
    await page.setViewportSize({ width: 720, height: 900 });
    await page.screenshot({ path: "test-results/comments-constrained.png", fullPage: true });
  } finally {
    await peer.close();
  }
});

test("source comments remain available after edits, moves, and cell deletion", async ({ page }) => {
  const notebookId = crypto.randomUUID();
  await openNotebookRoom(page, notebookId);
  const peer = await McpPeer.start();
  try {
    await peer.connectNotebook(notebookId);
    const cellId = await peer.createCell("value = 42\nprint(value)");
    const cell = page.getByRole("group", { name: "Cell 2", exact: true });
    const editor = cell.getByRole("textbox");
    await editor.click();
    await editor.press("ControlOrMeta+Home");
    await editor.press("Shift+End");
    await editor.press("ControlOrMeta+Alt+m");
    const panel = page.getByTestId("notebook-comments-panel");
    const composer = panel.getByRole("textbox", { name: /New .* comment/ });
    await expect(composer).toBeFocused();
    await composer.fill("Review selected value");
    await composer.press("ControlOrMeta+Enter");
    await expect(panel.getByText("Review selected value", { exact: true })).toBeVisible();
    await peer.setCell(cellId, "# inserted before selection\nvalue = 42\nprint(value)");
    await expect(panel.getByTestId("comment-thread-source-quote")).toContainText("value = 42");
    await peer.moveCell(cellId, null);
    await expect(panel.getByText("Review selected value", { exact: true })).toHaveCount(1);
    await peer.deleteCell(cellId);
    await expect(panel.getByText("Review selected value", { exact: true })).toBeVisible();
    await page.reload();
    await waitForNotebookSessionReady(page);
    await page.getByRole("button", { name: "Discussions", exact: true }).click();
    await expect(panel.getByText("Review selected value", { exact: true })).toHaveCount(1);
  } finally {
    await peer.close();
  }
});

test("output comments remain in Discussions when a rerun replaces their output", async ({
  page,
}) => {
  const notebookId = crypto.randomUUID();
  await openNotebookRoom(page, notebookId);
  await waitForKernelStatus(page, "idle", 120_000);
  const peer = await McpPeer.start();
  try {
    await peer.connectNotebook(notebookId);
    const cellId = await peer.createCell("print('original output')");
    const cell = page.getByRole("group", { name: "Cell 2", exact: true });
    await executeCell(cell);
    await waitForOutputContaining(cell, "original output");
    await cell.getByRole("button", { name: "Comment on outputs", exact: true }).click();
    const panel = page.getByTestId("notebook-comments-panel");
    const composer = panel.getByRole("textbox", { name: /New .* comment/ });
    await composer.fill("Keep this output discussion");
    await composer.press("ControlOrMeta+Enter");
    await expect(panel.getByText("Keep this output discussion", { exact: true })).toBeVisible();
    await peer.setCell(cellId, "print('replacement output')");
    await executeCell(cell);
    await waitForOutputContaining(cell, "replacement output");
    await expect(panel.getByText("Keep this output discussion", { exact: true })).toHaveCount(1);
    await expect(
      panel.getByRole("button", { name: "Resolve Document comment 1", exact: true }),
    ).toBeVisible();
  } finally {
    await peer.close();
  }
});
