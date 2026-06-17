import { expect, test } from "@playwright/test";
import {
  ensureCodeCell,
  ensureMarkdownCell,
  openNotebookRoom,
  selectCellSourceRange,
  setCellSource,
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

    await expect(panel.getByText(body)).toBeVisible({ timeout: 30_000 });
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
    await expect(panel.getByText(replyBody)).toBeVisible({ timeout: 30_000 });
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
    await page.getByRole("button", { name: "Comment on selected source" }).click();

    const panel = page.getByTestId("notebook-comments-panel");
    await expect(panel.getByTestId("comment-draft-target")).toContainText(exactQuote);

    const body = `Selected source comment ${crypto.randomUUID()}`;
    await panel.getByLabel("New source comment").fill(body);
    await panel.getByRole("button", { name: "Add comment" }).click();

    await expect(panel.getByText(body)).toBeVisible({ timeout: 30_000 });
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

    await expect(panel.getByText(markdownBody)).toBeVisible({ timeout: 30_000 });
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
  });
});
