import { expect, test } from "@playwright/test";
import { openNotebookRoom, waitForKernelStatus } from "./helpers";

// Records a video of the assistant side panel making a REAL LLM call through
// the daemon's `/assistant/chat` proxy (Anaconda-hosted Claude gateway). The
// response is not mocked — the daemon resolves an API key via the `anaconda`
// CLI and streams the upstream SSE back to the panel.
//
// Video is written to `test-results/` (see `video: "on"` below).
test.use({ video: "on" });

test.describe("assistant side panel", () => {
  test("opens the panel, says hello, and streams a real LLM response", async ({ page }) => {
    const notebookId = crypto.randomUUID();
    await openNotebookRoom(page, notebookId);
    // Wait for the session to settle so the blob port (which the assistant
    // client POSTs to) is resolved.
    await waitForKernelStatus(page, "idle", 120_000);

    // Panel starts closed.
    await expect(page.getByTestId("assistant-panel")).toHaveCount(0);

    // Open it from the toolbar.
    await page.getByTestId("assistant-toggle").click();
    const panel = page.getByTestId("assistant-panel");
    await expect(panel).toBeVisible();

    // Type a greeting and send.
    const input = panel.getByTestId("assistant-input");
    await input.click();
    await input.fill("Hello! Please reply with a short friendly greeting.");
    await panel.getByTestId("assistant-send").click();

    // The user's message renders immediately.
    await expect(panel.getByTestId("assistant-message-user")).toContainText("Hello!");

    // While the request is in flight the composer shows a Stop button; when the
    // stream completes it flips back to Send. Wait for that transition so we
    // assert on the FINISHED response, not the streaming "…" placeholder.
    await expect(panel.getByTestId("assistant-stop")).toBeVisible({ timeout: 10_000 });
    await expect(panel.getByTestId("assistant-send")).toBeVisible({ timeout: 60_000 });

    // The finished assistant message must contain real streamed text — not the
    // placeholder, an empty bubble, a "(stopped)" marker, or an error.
    const assistantMessage = panel.getByTestId("assistant-message-assistant");
    await expect(assistantMessage).toBeVisible();
    const finalText = (await assistantMessage.innerText()).trim();
    // eslint-disable-next-line no-console
    console.log(`[assistant-panel] LLM response: ${JSON.stringify(finalText)}`);

    await expect(assistantMessage).not.toHaveAttribute("data-role", "error");
    expect(finalText.toLowerCase()).not.toContain("error:");
    expect(finalText).not.toBe("(stopped)");
    expect(finalText).not.toBe("…");
    // A genuine greeting is more than a couple of characters.
    expect(finalText.length).toBeGreaterThan(3);

    // Give the recording a beat to capture the finished state.
    await page.waitForTimeout(1_000);
  });
});
