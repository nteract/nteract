import { expect, test } from "@playwright/test";
import { openNotebookRoom, waitForKernelStatus } from "./helpers";

// Records a video of @ana responding to a comment through the daemon's
// `/assistant/chat` proxy (Anaconda-hosted Claude gateway; not mocked).
// The agent reply is buffered and written once the full stream completes.
test.use({
  viewport: { width: 1440, height: 900 },
  video: { mode: "on", size: { width: 1440, height: 900 } },
});

test.describe("@ana in-comment assistant", () => {
  test("replies to a comment mentioning @ana with an agent-authored message", async ({ page }) => {
    test.setTimeout(180_000);

    const notebookId = crypto.randomUUID();
    await openNotebookRoom(page, notebookId);
    await waitForKernelStatus(page, "idle", 120_000);

    // Open the comments panel via the rail (button is labeled "Discussions").
    // Settings sync from the daemon happens async after page load, so the button
    // may not appear immediately — wait generously.
    await expect(page.getByRole("button", { name: "Discussions" })).toBeVisible({
      timeout: 30_000,
    });
    await page.getByRole("button", { name: "Discussions" }).click();

    const panel = page.getByTestId("notebook-comments-panel");
    await expect(panel).toBeVisible({ timeout: 10_000 });

    // Submit a new comment that mentions @ana.
    const composer = panel.getByRole("textbox", { name: /add a comment/i });
    await expect(composer).toBeVisible({ timeout: 10_000 });
    await composer.click();
    await composer.pressSequentially("@ana say hello in one short sentence", { delay: 40 });
    await panel.getByRole("button", { name: /add comment/i }).click();

    // The user's message lands immediately (1 message in thread).
    const messages = panel.locator('[data-testid="comment-message"]');
    await expect(messages).toHaveCount(1, { timeout: 10_000 });

    // Wait for the buffered agent reply to land (thread grows to 2 messages).
    // 60 s is generous for a real LLM round-trip.
    await expect(messages).toHaveCount(2, { timeout: 60_000 });

    // The second message must be agent-authored.
    const agentReply = messages.nth(1);
    await expect(agentReply).toHaveAttribute("data-agent", "true");

    const replyText = (await agentReply.innerText()).trim();
    console.log(`[@ana] agent reply: ${JSON.stringify(replyText)}`);

    // Must not be an error bubble or empty.
    expect(replyText).not.toContain("⚠️ Sorry, I couldn't answer that");
    expect(replyText.length).toBeGreaterThan(3);

    // Give the recording a beat to capture the final state.
    await page.waitForTimeout(1_500);
  });
});
