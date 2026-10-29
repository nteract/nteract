import { expect, test, type Page } from "@playwright/test";
import { openNotebookRoom, waitForKernelStatus, waitForNotebookSessionReady } from "./helpers";
import { McpPeer } from "./mcp-peer";

// Panel version under test; override to run the suite against another release.
const PANEL_DEPENDENCIES = (
  process.env.NTERACT_E2E_PANEL_DEPENDENCIES ?? "panel==1.9.4,bokeh==3.9.1"
)
  .split(",")
  .map((dependency) => dependency.trim())
  .filter(Boolean);

function outputArea(page: Page, cellId: string) {
  return page.locator(`[data-cell-id="${cellId}"] [data-slot="output-area"]`);
}

async function runCell(mcp: McpPeer, cellId: string, source: string) {
  const result = await mcp.setCell(cellId, source, true);
  expect(result, "MCP must report a successful completed execution").toEqual(
    expect.stringMatching(/✓ done/),
  );
}

test("Bokeh callbacks survive viewer reload and stop after output retirement", async ({
  context,
  page,
}) => {
  test.setTimeout(240_000);
  let mcp: McpPeer | undefined;
  let peerPage: Page | undefined;
  let checkId: string | undefined;
  try {
    const notebookId = crypto.randomUUID();
    await openNotebookRoom(page, notebookId);
    await waitForKernelStatus(page, "idle", 120_000);
    mcp = await McpPeer.start();
    await mcp.connectNotebook(notebookId);
    await mcp.manageDependencies(PANEL_DEPENDENCIES);
    const displayCode = [
      "import panel as pn",
      "from IPython.display import display",
      "pn.extension()",
      "display(pn.Column(pn.widgets.IntSlider(name='retirement slider')))",
    ].join("\n");
    const displayId = await mcp.createCell(displayCode);
    await runCell(mcp, displayId, displayCode);
    const slider = (viewer: Page) =>
      viewer
        .locator(`[data-cell-id="${displayId}"]`)
        .frameLocator('[data-slot="isolated-frame"]')
        .getByText("retirement slider:");
    await expect(slider(page)).toBeVisible({ timeout: 60_000 });

    const startCode = [
      "import asyncio, json",
      "from nteract_kernel_launcher._bokeh_session import session_registry",
      "old_session = list(session_registry._sessions.values())[-1]",
      "ticks = []",
      "periodic = old_session.document.add_periodic_callback(lambda: ticks.append(1), 20)",
      "await asyncio.sleep(.15)",
      "assert len(ticks) > 0",
      "print('PERIODIC_STARTED')",
    ].join("\n");
    checkId = await mcp.createCell(startCode);
    await runCell(mcp, checkId, startCode);
    await expect(outputArea(page, checkId)).toHaveText("PERIODIC_STARTED");

    peerPage = await context.newPage();
    await openNotebookRoom(peerPage, notebookId);
    await expect(slider(peerPage)).toBeVisible({ timeout: 60_000 });
    await peerPage.close();
    peerPage = undefined;
    await page.reload();
    await waitForNotebookSessionReady(page);
    await expect(slider(page)).toBeVisible({ timeout: 60_000 });
    await runCell(
      mcp,
      checkId,
      [
        "assert session_registry.get(old_session.session_id) is old_session",
        "assert not old_session._closed",
        "assert len(old_session._session_callbacks) == 1",
        "before = len(ticks)",
        "await asyncio.sleep(.15)",
        "assert len(ticks) > before",
        "print('VIEWER_RELOAD_OK')",
      ].join("\n"),
    );
    await expect(outputArea(page, checkId)).toHaveText("VIEWER_RELOAD_OK");

    await runCell(mcp, displayId, "print('OUTPUT_REPLACED')");
    await expect(outputArea(page, displayId)).toHaveText("OUTPUT_REPLACED");
    const inspector = mcp;
    const inspectionCell = checkId;
    // Poll between short executions: a long in-kernel wait would itself
    // occupy the shell that must process the daemon's close request.
    await expect
      .poll(
        async () => {
          await runCell(
            inspector,
            inspectionCell,
            "print('RETIREMENT_STATE', json.dumps(dict(closed=old_session._closed, registered=session_registry.get(old_session.session_id) is not None, callbacks=len(old_session._session_callbacks))))",
          );
          const output = outputArea(page, inspectionCell);
          await expect(output).toContainText("RETIREMENT_STATE");
          const text = await output.innerText();
          return JSON.parse(text.split("RETIREMENT_STATE")[1].trim());
        },
        { timeout: 30_000, intervals: [100, 250, 500] },
      )
      .toEqual({ closed: true, registered: false, callbacks: 0 });

    await runCell(
      mcp,
      checkId,
      [
        "before = len(ticks)",
        "await asyncio.sleep(.2)",
        "assert len(ticks) == before",
        "print('PERIODIC_STOPPED')",
      ].join("\n"),
    );
    await expect(outputArea(page, checkId)).toHaveText("PERIODIC_STOPPED");
  } finally {
    // Keep a failing regression from leaving its periodic callback running.
    if (mcp && checkId) {
      await mcp
        .setCell(checkId, "if 'old_session' in globals(): old_session.close()", true)
        .catch(() => undefined);
    }
    await peerPage?.close();
    await mcp?.close();
  }
});
