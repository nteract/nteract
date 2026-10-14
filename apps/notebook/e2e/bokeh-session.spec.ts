import { expect, test } from "@playwright/test";
import { openNotebookRoom, waitForKernelStatus } from "./helpers";
import { McpPeer } from "./mcp-peer";

interface BokehMessage {
  jsonrpc?: string;
  id?: number;
  method?: string;
  params?: {
    baseRevision?: number;
    transactionId?: string;
    patch?: { events?: Array<{ attr?: string; new?: unknown }> };
    event?: { transactionId: string; baseRevision: number; revision: number };
  };
  result?: { status?: string; revision?: number };
}

interface BokehRaceWindow extends Window {
  bokehRace: {
    hold: boolean;
    held: MessageEvent<BokehMessage>[];
    messages: BokehMessage[];
    release: () => void;
  };
}

test("preserves a delayed browser edit after an independent Python update", async ({ page }) => {
  test.setTimeout(180_000);
  let mcp: McpPeer | null = null;

  // Delay delivery of the real iframe request without changing its payload,
  // source or origin. The kernel can advance before the daemon receives it.
  // The same listener in the iframe records canonical events and replies.
  await page.addInitScript(() => {
    const state: BokehRaceWindow["bokehRace"] = {
      hold: false,
      held: [],
      messages: [],
      release() {
        state.hold = false;
        for (const event of state.held.splice(0)) {
          window.dispatchEvent(
            new MessageEvent("message", {
              data: event.data,
              source: event.source,
              origin: event.origin,
            }),
          );
        }
      },
    };
    (window as BokehRaceWindow).bokehRace = state;
    window.addEventListener(
      "message",
      (event: MessageEvent<BokehMessage>) => {
        const message = event.data;
        if (message?.jsonrpc !== "2.0") return;
        if (message.method?.startsWith("nteract/bokeh") || message.result?.status) {
          state.messages.push(message);
        }
        if (
          state.hold &&
          message.method === "nteract/bokehApplyPatch" &&
          message.params?.patch?.events?.some(
            (change) => change.attr === "value" && change.new === "browser edit",
          )
        ) {
          event.stopImmediatePropagation();
          state.held.push(event);
        }
      },
      true,
    );
  });

  try {
    const notebookId = crypto.randomUUID();
    await openNotebookRoom(page, notebookId);
    await waitForKernelStatus(page, "idle", 120_000);
    mcp = await McpPeer.start();
    await mcp.connectNotebook(notebookId);
    await mcp.manageDependencies(["panel==1.9.4", "bokeh==3.9.1"]);
    const setup = [
      "import panel as pn",
      "from IPython.display import display",
      "pn.extension()",
      "text = pn.widgets.TextInput(value='initial')",
      "notice = pn.pane.Markdown('initial notice')",
      "display(pn.Column(text, notice))",
    ].join("\n");
    const cellId = await mcp.createCell(setup);
    await mcp.setCell(cellId, setup, true);
    const cell = page.locator(`[data-cell-id="${cellId}"]`);
    const frame = cell.frameLocator('[data-slot="isolated-frame"]');
    const input = frame.getByRole("textbox");
    await expect(input).toHaveValue("initial", { timeout: 60_000 });
    await cell
      .locator('[data-slot="isolated-frame"]')
      .locator("..")
      .click({ position: { x: 3, y: 3 } });

    await page.evaluate(() => {
      (window as BokehRaceWindow).bokehRace.hold = true;
    });
    await input.fill("browser edit");
    await input.press("Tab");
    await expect
      .poll(() => page.evaluate(() => (window as BokehRaceWindow).bokehRace.held.length))
      .toBe(1);
    const delayed = await page.evaluate(() => (window as BokehRaceWindow).bokehRace.held[0].data);
    const originalBase = delayed.params?.baseRevision;
    const transactionId = delayed.params?.transactionId;
    expect(originalBase).toEqual(expect.any(Number));
    expect(transactionId).toEqual(expect.any(String));

    const advance = "notice.object = 'Python advanced independently'";
    const checkId = await mcp.createCell(advance);
    await mcp.setCell(checkId, advance, true);
    await expect(frame.getByText("Python advanced independently", { exact: true })).toBeVisible();
    await page.evaluate(() => (window as BokehRaceWindow).bokehRace.release());

    const frameBody = frame.locator("body");
    await expect
      .poll(() =>
        frameBody.evaluate(
          (_, id) =>
            (window as BokehRaceWindow).bokehRace.messages.find(
              (message) => message.id === id && message.result,
            )?.result?.status,
          delayed.id,
        ),
      )
      .toBe("accepted");
    await expect
      .poll(() =>
        frameBody.evaluate(
          (_, id) =>
            (window as BokehRaceWindow).bokehRace.messages.find(
              (message) => message.params?.event?.transactionId === id,
            )?.params?.event?.baseRevision,
          transactionId,
        ),
      )
      .toBeGreaterThan(originalBase as number);
    await expect(input).toHaveValue("browser edit");
    await expect(frame.getByText("Python advanced independently", { exact: true })).toBeVisible();

    await mcp.setCell(
      checkId,
      [
        "assert text.value == 'browser edit', text.value",
        "assert notice.object == 'Python advanced independently', notice.object",
        "print('BOTH_CHANGES_PRESERVED')",
      ].join("\n"),
      true,
    );
    await expect(page.locator(`[data-cell-id="${checkId}"] [data-slot="output-area"]`)).toHaveText(
      "BOTH_CHANGES_PRESERVED",
    );
  } finally {
    await mcp?.close();
  }
});
