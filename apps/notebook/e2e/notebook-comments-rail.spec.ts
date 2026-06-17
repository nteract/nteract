import { expect, test, type Locator } from "@playwright/test";
import {
  ensureCodeCell,
  ensureMarkdownCell,
  openNotebookRoom,
  selectCellSourceRange,
  setCellSource,
  waitForCellSourceContaining,
} from "./helpers";
import { McpPeer } from "./mcp-peer";

interface CommentMessage {
  body?: string;
  mutation_state?: string;
}

interface CommentThread {
  id?: string;
  status?: string;
  mutation_state?: string;
  messages?: CommentMessage[];
  anchor?: {
    kind?: string;
    cell_id?: string;
    start_line?: number;
    start_column?: number;
    end_line?: number;
    end_column?: number;
    exact_quote?: string | null;
  };
}

interface CommentsListResult {
  threads?: CommentThread[];
}

interface CommentThreadResourceResult {
  thread?: CommentThread;
}

function hasAcceptedComment(result: unknown, body: string): boolean {
  return Boolean(acceptedThreadWithMessage(result, body));
}

function acceptedThreadWithMessage(result: unknown, body: string): CommentThread | null {
  const threads = (result as CommentsListResult | null)?.threads ?? [];
  return (
    threads.find(
      (thread) =>
        thread.mutation_state === "accepted" &&
        (thread.messages ?? []).some(
          (message) => message.body === body && message.mutation_state === "accepted",
        ),
    ) ?? null
  );
}

function acceptedThreadStatus(result: unknown, threadId: string): string | null {
  const threads = (result as CommentsListResult | null)?.threads ?? [];
  const thread = threads.find(
    (thread) =>
      thread.id === threadId &&
      thread.mutation_state === "accepted" &&
      (thread.messages ?? []).some((message) => message.mutation_state === "accepted"),
  );
  return thread?.status ?? null;
}

function acceptedSourceThreadWithMessage(
  result: unknown,
  body: string,
  exactQuote: string,
): CommentThread | null {
  const threads = (result as CommentsListResult | null)?.threads ?? [];
  return (
    threads.find(
      (thread) =>
        thread.mutation_state === "accepted" &&
        thread.anchor?.kind === "source_range" &&
        thread.anchor.exact_quote === exactQuote &&
        (thread.messages ?? []).some(
          (message) => message.body === body && message.mutation_state === "accepted",
        ),
    ) ?? null
  );
}

async function selectRenderedMarkdownText(cell: Locator, text: string) {
  await cell.getByLabel("Markdown cell content").evaluate((root, selectedText) => {
    function findTextNode(node: Node): Text | null {
      if (node.nodeType === Node.TEXT_NODE && node.textContent?.includes(selectedText)) {
        return node as Text;
      }
      for (const child of node.childNodes) {
        const found = findTextNode(child);
        if (found) return found;
      }
      return null;
    }

    const textNode = findTextNode(root);
    if (!textNode || !textNode.textContent) {
      throw new Error(`Could not find rendered markdown text: ${selectedText}`);
    }
    const start = textNode.textContent.indexOf(selectedText);
    const range = document.createRange();
    range.setStart(textNode, start);
    range.setEnd(textNode, start + selectedText.length);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    (root as HTMLElement).focus();
    root.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
  }, text);
}

function commentMessage(panel: Locator, body: string): Locator {
  return panel.locator("article").filter({ hasText: body });
}

test.describe("notebook comments rail", () => {
  let mcp: McpPeer | null = null;

  test.afterEach(async () => {
    await mcp?.close();
    mcp = null;
  });

  test("creates document comments in Desktop and exposes them through MCP", async ({ page }) => {
    const notebookId = crypto.randomUUID();
    await openNotebookRoom(page, notebookId);

    mcp = await McpPeer.start();
    await mcp.connectNotebook(notebookId);

    await page.getByLabel("Comments").click();
    const panel = page.getByTestId("notebook-comments-panel");
    await expect(panel.getByLabel("New document comment")).toBeEnabled({ timeout: 30_000 });

    const body = `Desktop comments rail ${crypto.randomUUID()}`;
    await panel.getByLabel("New document comment").fill(body);
    await panel.getByRole("button", { name: "Add comment" }).click();

    await expect(commentMessage(panel, body)).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(async () => hasAcceptedComment(await mcp!.listComments(), body), {
        timeout: 120_000,
      })
      .toBe(true);

    let threadId: string | null = null;
    await expect
      .poll(
        async () => {
          threadId = acceptedThreadWithMessage(await mcp!.listComments(), body)?.id ?? null;
          return threadId;
        },
        {
          timeout: 120_000,
        },
      )
      .not.toBeNull();
    if (!threadId) throw new Error("Accepted comment thread id not found");

    const replyBody = `Desktop reply ${crypto.randomUUID()}`;
    await panel.getByRole("textbox", { name: "Reply to Document comment 1" }).fill(replyBody);
    await panel.getByRole("button", { name: "Submit reply to Document comment 1" }).click();
    await expect(commentMessage(panel, replyBody)).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(async () => hasAcceptedComment(await mcp!.listComments(), replyBody), {
        timeout: 120_000,
      })
      .toBe(true);

    await expect(panel.getByRole("button", { name: "Resolve Document comment 1" })).toBeEnabled({
      timeout: 30_000,
    });
    await panel.getByRole("button", { name: "Resolve Document comment 1" }).click();
    await expect(panel.getByRole("button", { name: "Reopen Document comment 1" })).toBeVisible({
      timeout: 120_000,
    });
    await expect
      .poll(
        async () =>
          acceptedThreadStatus(await mcp!.listComments({ includeResolved: true }), threadId),
        {
          timeout: 120_000,
        },
      )
      .toBe("resolved");

    await panel.getByRole("button", { name: "Reopen Document comment 1" }).click();
    await expect(panel.getByRole("button", { name: "Resolve Document comment 1" })).toBeVisible({
      timeout: 120_000,
    });
    await expect
      .poll(
        async () =>
          acceptedThreadStatus(await mcp!.listComments({ includeResolved: true }), threadId),
        {
          timeout: 120_000,
        },
      )
      .toBe("open");
  });

  test("creates and updates cell comments through MCP tools and resources", async ({ page }) => {
    const notebookId = crypto.randomUUID();
    await openNotebookRoom(page, notebookId);

    mcp = await McpPeer.start();
    await mcp.connectNotebook(notebookId);

    const cellId = await mcp.createCell("answer = 42");
    const body = `MCP cell comment ${crypto.randomUUID()}`;
    const created = (await mcp.createCommentThread(body, {
      kind: "cell",
      cell_id: cellId,
    })) as { thread_id?: string };
    const threadId = created.thread_id;
    if (!threadId) throw new Error("MCP create_comment_thread did not return a thread_id");

    await expect
      .poll(() => mcp!.listComments({ cellId }), {
        timeout: 120_000,
      })
      .toMatchObject({
        threads: expect.arrayContaining([
          expect.objectContaining({
            id: threadId,
            status: "open",
            mutation_state: "accepted",
            badge_cell_ids: expect.arrayContaining([cellId]),
            messages: expect.arrayContaining([
              expect.objectContaining({
                body,
                mutation_state: "accepted",
              }),
            ]),
          }),
        ]),
      });

    const commentsResource = (await mcp.readResourceJson(
      `nteract://notebooks/${notebookId}/comments`,
    )) as CommentsListResult;
    expect(acceptedThreadWithMessage(commentsResource, body)?.id).toBe(threadId);

    const cellCommentsResource = (await mcp.readResourceJson(
      `nteract://notebooks/${notebookId}/cells/${cellId}/comments`,
    )) as CommentsListResult;
    expect(acceptedThreadWithMessage(cellCommentsResource, body)?.id).toBe(threadId);

    const threadResource = (await mcp.readResourceJson(
      `nteract://notebooks/${notebookId}/comments/threads/${threadId}`,
    )) as CommentThreadResourceResult;
    expect(threadResource.thread).toMatchObject({
      id: threadId,
      status: "open",
      mutation_state: "accepted",
      messages: expect.arrayContaining([
        expect.objectContaining({
          body,
          mutation_state: "accepted",
        }),
      ]),
    });

    const replyBody = `MCP reply ${crypto.randomUUID()}`;
    await mcp.replyCommentThread(threadId, replyBody);
    await expect
      .poll(() => mcp!.listComments({ cellId }), {
        timeout: 120_000,
      })
      .toMatchObject({
        threads: expect.arrayContaining([
          expect.objectContaining({
            id: threadId,
            messages: expect.arrayContaining([
              expect.objectContaining({
                body: replyBody,
                mutation_state: "accepted",
              }),
            ]),
          }),
        ]),
      });

    await mcp.resolveCommentThread(threadId);
    await expect
      .poll(
        async () =>
          acceptedThreadStatus(await mcp!.listComments({ includeResolved: true }), threadId),
        {
          timeout: 120_000,
        },
      )
      .toBe("resolved");
    const resolvedThreadResource = (await mcp.readResourceJson(
      `nteract://notebooks/${notebookId}/comments/threads/${threadId}`,
    )) as CommentThreadResourceResult;
    expect(resolvedThreadResource.thread?.status).toBe("resolved");

    await mcp.reopenCommentThread(threadId);
    await expect
      .poll(
        async () =>
          acceptedThreadStatus(await mcp!.listComments({ includeResolved: true }), threadId),
        {
          timeout: 120_000,
        },
      )
      .toBe("open");
    const reopenedThreadResource = (await mcp.readResourceJson(
      `nteract://notebooks/${notebookId}/comments/threads/${threadId}`,
    )) as CommentThreadResourceResult;
    expect(reopenedThreadResource.thread).toMatchObject({
      id: threadId,
      status: "open",
      messages: expect.arrayContaining([
        expect.objectContaining({ body }),
        expect.objectContaining({ body: replyBody }),
      ]),
    });
  });

  test("creates rendered markdown prose comments in Desktop", async ({ page }) => {
    const notebookId = crypto.randomUUID();
    await openNotebookRoom(page, notebookId);

    mcp = await McpPeer.start();
    await mcp.connectNotebook(notebookId);

    const markdownSource =
      "## Review plan\n\nThis rendered prose should be commentable from preview.\n\n";
    const renderedQuote = "rendered prose";
    const markdownCell = await ensureMarkdownCell(page);
    await setCellSource(markdownCell, markdownSource);
    const markdownCellId = await markdownCell.getAttribute("data-cell-id");
    if (!markdownCellId) throw new Error("Markdown cell id not found");

    const renderButton = markdownCell.getByLabel("View rendered markdown");
    if (await renderButton.isVisible()) {
      await renderButton.click();
    }
    await expect(
      markdownCell.locator('[data-slot="projected-markdown-output"]').getByText(renderedQuote),
    ).toBeVisible({ timeout: 30_000 });

    await selectRenderedMarkdownText(markdownCell, renderedQuote);
    await expect(page.getByRole("button", { name: "Comment on selected markdown" })).toBeVisible();
    await page.keyboard.press("Control+Alt+M");

    const panel = page.getByTestId("notebook-comments-panel");
    await expect(panel.getByTestId("comment-draft-target")).toContainText(renderedQuote);
    await expect(panel.getByLabel("New source comment")).toBeFocused();

    const body = `Rendered markdown comment ${crypto.randomUUID()}`;
    await panel.getByLabel("New source comment").fill(body);
    await panel.getByRole("button", { name: "Add comment" }).click();

    await expect(commentMessage(panel, body)).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(() => mcp!.listComments({ cellId: markdownCellId }), {
        timeout: 120_000,
      })
      .toMatchObject({
        threads: expect.arrayContaining([
          expect.objectContaining({
            mutation_state: "accepted",
            anchor: expect.objectContaining({
              kind: "source_range",
              cell_id: markdownCellId,
              exact_quote: renderedQuote,
            }),
            messages: expect.arrayContaining([
              expect.objectContaining({
                body,
                mutation_state: "accepted",
              }),
            ]),
          }),
        ]),
      });

    expect(
      acceptedSourceThreadWithMessage(
        await mcp.listComments({ cellId: markdownCellId }),
        body,
        renderedQuote,
      ),
    ).not.toBeNull();
  });

  test("creates rendered markdown paragraph comments from keyboard in Desktop", async ({
    page,
  }) => {
    const notebookId = crypto.randomUUID();
    await openNotebookRoom(page, notebookId);

    mcp = await McpPeer.start();
    await mcp.connectNotebook(notebookId);

    const exactQuote = "This rendered prose should be keyboard commentable from preview.";
    const markdownSource = `## Review plan\n\n${exactQuote}\n\n`;
    const markdownCell = await ensureMarkdownCell(page);
    await setCellSource(markdownCell, markdownSource);
    const markdownCellId = await markdownCell.getAttribute("data-cell-id");
    if (!markdownCellId) throw new Error("Markdown cell id not found");

    const renderButton = markdownCell.getByLabel("View rendered markdown");
    if (await renderButton.isVisible()) {
      await renderButton.click();
    }
    await expect(
      markdownCell.locator('[data-slot="projected-markdown-output"]').getByText(exactQuote),
    ).toBeVisible({ timeout: 30_000 });

    const commentButton = markdownCell.getByRole("button", {
      name: "Comment on rendered paragraph",
    });
    await commentButton.focus();
    await page.keyboard.press("Enter");

    const panel = page.getByTestId("notebook-comments-panel");
    await expect(panel.getByTestId("comment-draft-target")).toContainText(exactQuote);
    await expect(panel.getByLabel("New source comment")).toBeFocused();

    const body = `Keyboard rendered markdown comment ${crypto.randomUUID()}`;
    await panel.getByLabel("New source comment").fill(body);
    await panel.getByRole("button", { name: "Add comment" }).click();

    await expect(commentMessage(panel, body)).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(() => mcp!.listComments({ cellId: markdownCellId }), {
        timeout: 120_000,
      })
      .toMatchObject({
        threads: expect.arrayContaining([
          expect.objectContaining({
            mutation_state: "accepted",
            anchor: expect.objectContaining({
              kind: "source_range",
              cell_id: markdownCellId,
              exact_quote: exactQuote,
            }),
            messages: expect.arrayContaining([
              expect.objectContaining({
                body,
                mutation_state: "accepted",
              }),
            ]),
          }),
        ]),
      });
  });

  test("creates selected source comments in Desktop and exposes source anchors through MCP", async ({
    page,
  }) => {
    const notebookId = crypto.randomUUID();
    await openNotebookRoom(page, notebookId);

    mcp = await McpPeer.start();
    await mcp.connectNotebook(notebookId);

    const source = "alpha = 1\nbeta = alpha + 1\nprint(beta)\n";
    const exactQuote = "beta = alpha + 1";
    const cell = await ensureCodeCell(page);
    await setCellSource(cell, source);
    const cellId = await cell.getAttribute("data-cell-id");
    if (!cellId) throw new Error("Code cell id not found");

    const from = source.indexOf(exactQuote);
    await selectCellSourceRange(cell, from, from + exactQuote.length);
    await page.keyboard.press("Control+Alt+M");

    const panel = page.getByTestId("notebook-comments-panel");
    await expect(panel.getByTestId("comment-draft-target")).toContainText(exactQuote);
    await expect(panel.getByLabel("New source comment")).toBeFocused();

    const body = `Selected source comment ${crypto.randomUUID()}`;
    await panel.getByLabel("New source comment").fill(body);
    await panel.getByRole("button", { name: "Add comment" }).click();

    await expect(commentMessage(panel, body)).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(() => mcp!.listComments({ cellId }), {
        timeout: 120_000,
      })
      .toMatchObject({
        threads: expect.arrayContaining([
          expect.objectContaining({
            mutation_state: "accepted",
            anchor: expect.objectContaining({
              kind: "source_range",
              cell_id: cellId,
              start_line: 1,
              start_column: 0,
              end_line: 1,
              end_column: exactQuote.length,
              exact_quote: exactQuote,
            }),
          }),
        ]),
      });

    expect(
      acceptedSourceThreadWithMessage(await mcp.listComments({ cellId }), body, exactQuote),
    ).not.toBeNull();

    await panel.getByRole("button", { name: "Show cell for Source comment 1" }).click();
    await expect(page.getByTestId("source-comment-button")).toHaveCount(0);

    const markdownSource = "## Plan\n\n- check source comments\n";
    const markdownQuote = "- check source comments";
    const markdownCell = await ensureMarkdownCell(page);
    await setCellSource(markdownCell, markdownSource);
    const markdownCellId = await markdownCell.getAttribute("data-cell-id");
    if (!markdownCellId) throw new Error("Markdown cell id not found");

    const markdownFrom = markdownSource.indexOf(markdownQuote);
    await selectCellSourceRange(markdownCell, markdownFrom, markdownFrom + markdownQuote.length);
    await page.getByRole("button", { name: "Comment on selected source" }).click();
    await expect(panel.getByTestId("comment-draft-target")).toContainText(markdownQuote);

    const markdownBody = `Selected markdown source comment ${crypto.randomUUID()}`;
    await panel.getByLabel("New source comment").fill(markdownBody);
    await panel.getByRole("button", { name: "Add comment" }).click();

    await expect(commentMessage(panel, markdownBody)).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(() => mcp!.listComments({ cellId: markdownCellId }), {
        timeout: 120_000,
      })
      .toMatchObject({
        threads: expect.arrayContaining([
          expect.objectContaining({
            mutation_state: "accepted",
            anchor: expect.objectContaining({
              kind: "source_range",
              cell_id: markdownCellId,
              start_line: 2,
              start_column: 0,
              end_line: 2,
              end_column: markdownQuote.length,
              exact_quote: markdownQuote,
            }),
          }),
        ]),
      });

    const rawSource = "metadata:\n  owner: local-agent\n  status: draft\n";
    const rawQuote = "  owner: local-agent";
    const rawCellId = await mcp.createCell(rawSource, "raw");
    const rawCell = page.locator(`[data-cell-id="${rawCellId}"][data-cell-type="raw"]`);
    await expect(rawCell).toBeVisible({ timeout: 30_000 });
    await waitForCellSourceContaining(rawCell, rawQuote);

    const rawFrom = rawSource.indexOf(rawQuote);
    await selectCellSourceRange(rawCell, rawFrom, rawFrom + rawQuote.length);
    await page.getByRole("button", { name: "Comment on selected source" }).click();
    await expect(panel.getByTestId("comment-draft-target")).toContainText(rawQuote);
    await expect(panel.getByLabel("New source comment")).toBeFocused();

    const rawBody = `Selected raw source comment ${crypto.randomUUID()}`;
    await panel.getByLabel("New source comment").fill(rawBody);
    await panel.getByRole("button", { name: "Add comment" }).click();

    await expect(commentMessage(panel, rawBody)).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(() => mcp!.listComments({ cellId: rawCellId }), {
        timeout: 120_000,
      })
      .toMatchObject({
        threads: expect.arrayContaining([
          expect.objectContaining({
            mutation_state: "accepted",
            anchor: expect.objectContaining({
              kind: "source_range",
              cell_id: rawCellId,
              start_line: 1,
              start_column: 0,
              end_line: 1,
              end_column: rawQuote.length,
              exact_quote: rawQuote,
            }),
          }),
        ]),
      });
  });
});
