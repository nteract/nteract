import { expect, test } from "@playwright/test";
import { openNotebookRoom } from "./helpers";
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
});
