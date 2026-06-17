import { expect, test } from "@playwright/test";
import { openNotebookRoom } from "./helpers";
import { McpPeer } from "./mcp-peer";

interface CommentMessage {
  body?: string;
  mutation_state?: string;
}

interface CommentThread {
  mutation_state?: string;
  messages?: CommentMessage[];
}

interface CommentsListResult {
  threads?: CommentThread[];
}

function hasAcceptedComment(result: unknown, body: string): boolean {
  const threads = (result as CommentsListResult | null)?.threads ?? [];
  return threads.some(
    (thread) =>
      thread.mutation_state === "accepted" &&
      (thread.messages ?? []).some(
        (message) => message.body === body && message.mutation_state === "accepted",
      ),
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
    await panel.getByRole("button", { name: "New" }).click();

    await expect(panel.getByText(body)).toBeVisible({ timeout: 30_000 });
    await expect(panel.getByText("Accepted").first()).toBeVisible({ timeout: 120_000 });
    await expect
      .poll(async () => hasAcceptedComment(await mcp!.listComments(), body), {
        timeout: 120_000,
      })
      .toBe(true);
  });
});
