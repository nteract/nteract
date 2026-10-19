import { expect, test, type FrameLocator, type Page } from "@playwright/test";
import { openNotebookRoom, waitForKernelStatus, waitForNotebookSessionReady } from "./helpers";
import { McpPeer } from "./mcp-peer";

// Panel version under test; override to run the suite against another release.
const PANEL_DEPENDENCIES = (
  process.env.NTERACT_E2E_PANEL_DEPENDENCIES ?? "panel==1.9.4,bokeh==3.9.1"
)
  .split(",")
  .map((dependency) => dependency.trim())
  .filter(Boolean);

interface RecordedMessage {
  at?: number;
  method: string;
  epoch?: number;
  kind?: string;
  status?: string;
  canSwitch?: boolean;
  detail?: string;
}

interface BokehE2EWindow extends Window {
  bokehE2E: { messages: RecordedMessage[] };
}

/** Record Bokeh session RPC traffic in every frame: requests reach the host
 * window, notifications reach the output frame. */
async function recordBokehMessages(page: Page) {
  if (process.env.NTERACT_E2E_DEBUG) {
    page.on("console", (message) => {
      const text = message.text();
      if (/bokeh/i.test(text) || ["warning", "error"].includes(message.type())) {
        console.log(`[page:${message.type()}] ${text}`);
      }
    });
  }
  await page.addInitScript(() => {
    const state: BokehE2EWindow["bokehE2E"] = { messages: [] };
    (window as unknown as BokehE2EWindow).bokehE2E = state;
    window.addEventListener(
      "message",
      (event: MessageEvent) => {
        const message = event.data as {
          jsonrpc?: string;
          method?: string;
          params?: {
            epoch?: number;
            status?: string;
            update?: { kind?: string; epoch?: number; canSwitch?: boolean };
          };
        };
        if (message?.jsonrpc !== "2.0") return;
        const result = (message as { result?: { status?: string; epoch?: number } }).result;
        if (!message.method && result && typeof result.status === "string") {
          state.messages.push({ method: "result", status: result.status, epoch: result.epoch });
          return;
        }
        if (!message.method?.startsWith("nteract/bokeh")) return;
        const update = message.params?.update;
        state.messages.push({
          at: Date.now(),
          method: message.method,
          epoch: update?.epoch ?? message.params?.epoch,
          kind: update?.kind,
          status: message.params?.status,
          canSwitch: update?.canSwitch,
          detail: (update?.kind === "full"
            ? (
                JSON.stringify((update as { models?: unknown }).models).match(
                  /"value(_input)?":("[^"]*"|[^,}]*)/g,
                ) ?? []
              ).join(" ")
            : JSON.stringify(update ? (update as { props?: unknown }).props : message.params)
          )?.slice(0, 300),
        });
      },
      true,
    );
  });
}

function outputFrame(page: Page, cellId: string): FrameLocator {
  return page.locator(`[data-cell-id="${cellId}"]`).frameLocator('[data-slot="isolated-frame"]');
}

/** Bokeh frames ignore pointer events until a first click engages them, so
 * scrolling the notebook cannot pan or zoom them. */
async function engageFrame(page: Page, cellId: string) {
  const wrapper = page
    .locator(`[data-cell-id="${cellId}"] [data-slot="isolated-frame"]`)
    .locator('xpath=ancestor::div[@tabindex="-1"][1]');
  await wrapper.click({ position: { x: 2, y: 2 } });
  await expect(wrapper).toHaveAttribute("data-frame-interaction-active", "true");
}

/** All of a cell's outputs; a session output followed by stdout renders as two output areas. */
function outputArea(page: Page, cellId: string) {
  return page.locator(`[data-cell-id="${cellId}"] [data-slot="cell-output-content"]`);
}

async function frameMessages(frame: FrameLocator): Promise<RecordedMessage[]> {
  return frame
    .locator("body")
    .evaluate(() => (window as unknown as BokehE2EWindow).bokehE2E?.messages ?? []);
}

async function hostMessages(page: Page): Promise<RecordedMessage[]> {
  return page.evaluate(() => (window as unknown as BokehE2EWindow).bokehE2E?.messages ?? []);
}

/** Tag the mounted Bokeh root view so a remount (which replaces it) is detectable. */
async function markMountedRoot(frame: FrameLocator) {
  await frame
    .locator('[data-slot="bokeh-session-output"] > div > *')
    .first()
    .evaluate((element) => element.setAttribute("data-e2e-mounted", "true"));
}

async function expectSameMountedRoot(frame: FrameLocator) {
  await expect(frame.locator('[data-e2e-mounted="true"]')).toHaveCount(1);
}

/** Length and last `x` of a ColumnDataSource in the frame's mounted BokehJS document. */
async function columnTail(frame: FrameLocator, sourceId: string) {
  return frame
    .locator("body")
    .evaluate((_, id) => {
      const bokeh = (
        window as unknown as {
          Bokeh?: { documents?: Array<{ get_model_by_id(id: string): { data?: unknown } | null }> };
        }
      ).Bokeh;
      for (const document of [...(bokeh?.documents ?? [])].reverse()) {
        const data = document.get_model_by_id(id)?.data;
        if (data == null) continue;
        const x = (data instanceof Map ? data.get("x") : (data as Record<string, unknown>).x) as
          | ArrayLike<number>
          | undefined;
        if (!x) return null;
        return { length: x.length, last: x[x.length - 1] };
      }
      return null;
    }, sourceId)
    .catch(() => null);
}

async function runCell(mcp: McpPeer, cellId: string, source: string) {
  const result = await mcp.setCell(cellId, source, true);
  expect(result, "MCP must report a successful completed execution").toEqual(
    expect.stringMatching(/✓ done/),
  );
}

/** Assert Python state from a scratch cell; the cell prints `marker` when every assertion holds. */
async function expectPython(
  page: Page,
  mcp: McpPeer,
  cellId: string,
  assertions: string[],
  marker: string,
) {
  await runCell(mcp, cellId, [...assertions, `print(${JSON.stringify(marker)})`].join("\n"));
  await expect(outputArea(page, cellId)).toHaveText(marker);
}

async function openPanelNotebook(page: Page) {
  const notebookId = crypto.randomUUID();
  await openNotebookRoom(page, notebookId);
  await waitForKernelStatus(page, "idle", 120_000);
  const mcp = await McpPeer.start();
  await mcp.connectNotebook(notebookId);
  await mcp.manageDependencies(PANEL_DEPENDENCIES);
  return { notebookId, mcp };
}

async function displayPanel(mcp: McpPeer, lines: string[]) {
  const source = [
    "import panel as pn",
    "from IPython.display import display",
    "pn.extension()",
    ...lines,
  ].join("\n");
  const cellId = await mcp.createCell(source);
  await runCell(mcp, cellId, source);
  return cellId;
}

test.describe("Bokeh session documents", () => {
  test.describe.configure({ timeout: 300_000 });

  test.afterEach(async ({ page }, testInfo) => {
    if (!process.env.NTERACT_E2E_DEBUG || testInfo.status === testInfo.expectedStatus) return;
    for (const frame of page.frames()) {
      const messages = await frame
        .evaluate(() => (window as unknown as BokehE2EWindow).bokehE2E?.messages ?? [])
        .catch(() => []);
      if (messages.length > 0) console.log(`[messages ${frame.url()}]`, JSON.stringify(messages));
    }
  });

  test("a browser edit a Python callback rejects converges to the kernel value", async ({
    page,
  }) => {
    await recordBokehMessages(page);
    const { mcp } = await openPanelNotebook(page);
    try {
      const displayId = await displayPanel(mcp, [
        "text = pn.widgets.TextInput(value='initial')",
        "seen = []",
        "def guard(event):",
        "    seen.append(event.new)",
        "    print(f'guard saw {event.new}')",
        "    if event.new not in ('allowed', 'initial'):",
        "        text.value = 'initial'",
        "text.param.watch(guard, 'value')",
        "display(pn.Column(text))",
      ]);
      const frame = outputFrame(page, displayId);
      const input = frame.getByRole("textbox");
      await expect(input).toHaveValue("initial", { timeout: 60_000 });
      await markMountedRoot(frame);

      // Panel suppresses the echo of a value it is applying from the client,
      // so only the launcher's correction rule can restore the browser.
      await input.fill("browser edit");
      await input.press("Enter");
      await expect(input).toHaveValue("initial", { timeout: 15_000 });
      // Callback output lands in the cell without remounting the session output.
      await expect(outputArea(page, displayId)).toContainText("guard saw browser edit");
      await expectSameMountedRoot(frame);

      const checkId = await mcp.createCell("pass");
      await expectPython(
        page,
        mcp,
        checkId,
        ["assert 'browser edit' in seen, seen", "assert text.value == 'initial', text.value"],
        "REJECTED_EDIT_CONVERGED",
      );

      await input.fill("allowed");
      await input.press("Enter");
      await expect
        .poll(async () => {
          await runCell(mcp, checkId, "print(text.value)");
          return (await outputArea(page, checkId).innerText()).trim();
        })
        .toBe("allowed");
      await expect(input).toHaveValue("allowed");
      await expectSameMountedRoot(frame);
    } finally {
      await mcp.close();
    }
  });

  test("a periodic callback across document replacements keeps the output mounted", async ({
    page,
  }) => {
    test.skip(
      !process.env.NTERACT_TEST_BOKEH_REPLACEMENT,
      "needs a daemon started with NTERACT_TEST_BOKEH_REPLACEMENT to replace documents quickly",
    );
    await recordBokehMessages(page);
    const { mcp } = await openPanelNotebook(page);
    let displayId: string | undefined;
    try {
      displayId = await displayPanel(mcp, [
        "md = pn.pane.Markdown('tick 0')",
        "ticks = {'n': 0}",
        "def tick():",
        "    ticks['n'] += 1",
        "    md.object = f\"tick {ticks['n']}\"",
        "display(pn.Column(md))",
        "periodic = pn.state.add_periodic_callback(tick, period=50)",
      ]);
      const frame = outputFrame(page, displayId);
      await expect(frame.getByText(/^tick [1-9]\d*$/)).toBeVisible({ timeout: 60_000 });
      await markMountedRoot(frame);

      // Two replacements: the first may reconcile, later ones should switch.
      await expect
        .poll(
          async () =>
            Math.max(
              -1,
              ...(await frameMessages(frame))
                .filter((message) => message.method === "nteract/bokehSessionDoc")
                .map((message) => message.epoch ?? -1),
            ),
          { timeout: 90_000, intervals: [500] },
        )
        .toBeGreaterThanOrEqual(2);
      await expect(frame.getByText(/^tick \d+$/)).toBeVisible();

      const stopId = await mcp.createCell("pass");
      await runCell(mcp, stopId, "periodic.stop()\nprint('FINAL', ticks['n'])");
      const final = (await outputArea(page, stopId).innerText()).replace("FINAL", "").trim();
      await expect(frame.getByText(`tick ${final}`, { exact: true })).toBeVisible({
        timeout: 15_000,
      });
      await expectSameMountedRoot(frame);

      const fulls = (await frameMessages(frame)).filter(
        (message) => message.method === "nteract/bokehSessionDoc" && message.kind === "full",
      );
      expect(new Set(fulls.map((message) => message.epoch)).size).toBeGreaterThanOrEqual(3);
      if (process.env.NTERACT_E2E_DEBUG) {
        console.log("[replacement fulls]", JSON.stringify(fulls), "final tick", final);
      }
    } finally {
      if (displayId) {
        await mcp
          .setCell(displayId, "if 'periodic' in globals(): periodic.stop()", true)
          .catch(() => undefined);
      }
      await mcp.close();
    }
  });

  test("two pages showing the same output converge", async ({ context, page }) => {
    await recordBokehMessages(page);
    const { notebookId, mcp } = await openPanelNotebook(page);
    let peer: Page | undefined;
    try {
      const displayId = await displayPanel(mcp, [
        "text = pn.widgets.TextInput(value='initial')",
        "notice = pn.pane.Markdown('notice 0')",
        "display(pn.Column(text, notice))",
      ]);
      const first = outputFrame(page, displayId);
      await expect(first.getByRole("textbox")).toHaveValue("initial", { timeout: 60_000 });
      await markMountedRoot(first);

      peer = await context.newPage();
      await openNotebookRoom(peer, notebookId);
      const second = outputFrame(peer, displayId);
      await expect(second.getByRole("textbox")).toHaveValue("initial", { timeout: 60_000 });
      await markMountedRoot(second);

      await first.getByRole("textbox").fill("from first page");
      await first.getByRole("textbox").press("Enter");
      await expect(second.getByRole("textbox")).toHaveValue("from first page", {
        timeout: 15_000,
      });

      await second.getByRole("textbox").fill("from second page");
      await second.getByRole("textbox").press("Enter");
      await expect(first.getByRole("textbox")).toHaveValue("from second page", {
        timeout: 15_000,
      });

      const checkId = await mcp.createCell("pass");
      await runCell(mcp, checkId, "notice.object = 'notice from Python'");
      for (const frame of [first, second]) {
        await expect(frame.getByText("notice from Python", { exact: true })).toBeVisible();
      }
      await expectPython(
        page,
        mcp,
        checkId,
        ["assert text.value == 'from second page', text.value"],
        "PAGES_CONVERGED",
      );
      await expectSameMountedRoot(first);
      await expectSameMountedRoot(second);
    } finally {
      await peer?.close();
      await mcp.close();
    }
  });

  test("a running cell streams intermediate values", async ({ page }) => {
    await recordBokehMessages(page);
    const { mcp } = await openPanelNotebook(page);
    try {
      const displayId = await displayPanel(mcp, [
        "md = pn.pane.Markdown('waiting')",
        "display(pn.Column(md))",
      ]);
      const frame = outputFrame(page, displayId);
      await expect(frame.getByText("waiting", { exact: true })).toBeVisible({ timeout: 60_000 });
      await markMountedRoot(frame);

      // Each step is shown for only 0.5 s, shorter than Playwright's polling
      // backoff, so sample the mounted models in the frame instead.
      await frame.locator("body").evaluate(() => {
        const seen: Record<string, number> = {};
        const w = window as unknown as {
          stepsSeen: Record<string, number>;
          Bokeh?: { documents?: Array<{ all_models: Iterable<{ text?: unknown }> }> };
        };
        w.stepsSeen = seen;
        setInterval(() => {
          for (const document of w.Bokeh?.documents ?? []) {
            for (const model of document.all_models) {
              const step =
                typeof model.text === "string" ? model.text.match(/step \d+/)?.[0] : null;
              if (step && !(step in seen)) seen[step] = Date.now();
            }
          }
        }, 20);
      });

      const loopId = await mcp.createCell("pass");
      const result = await mcp.setCell(
        loopId,
        [
          "import time",
          "for i in range(8):",
          "    md.object = f'step {i}'",
          "    time.sleep(0.5)",
        ].join("\n"),
        true,
      );
      const finishedAt = Date.now();
      expect(result).toEqual(expect.stringMatching(/✓ done/));
      await expect(frame.getByText("step 7", { exact: true })).toBeVisible();
      const seen = await frame
        .locator("body")
        .evaluate(() => (window as unknown as { stepsSeen: Record<string, number> }).stepsSeen);
      for (const step of [1, 3, 5]) {
        expect(seen[`step ${step}`], `step ${step} must render`).toBeDefined();
        // Steps 6 and 7 still take 1 s after step 5; deltas held until the
        // run ends would all render after it.
        expect(
          finishedAt - seen[`step ${step}`],
          `step ${step} must arrive while the cell is running`,
        ).toBeGreaterThan(500);
      }
      await expectSameMountedRoot(frame);
    } finally {
      await mcp.close();
    }
  });

  test("a value written with set_bokeh_property reaches Python and the browser", async ({
    page,
  }) => {
    await recordBokehMessages(page);
    const { mcp } = await openPanelNotebook(page);
    try {
      const displayId = await displayPanel(mcp, [
        "slider = pn.widgets.IntSlider(name='Level', start=0, end=10, value=3)",
        "md = pn.pane.Markdown('level 3')",
        "slider.param.watch(lambda event: setattr(md, 'object', f'level {event.new}'), 'value')",
        "display(pn.Column(slider, md))",
      ]);
      const frame = outputFrame(page, displayId);
      await expect(frame.getByText("level 3", { exact: true })).toBeVisible({ timeout: 60_000 });
      await markMountedRoot(frame);

      const result = await mcp.setBokehProperty(displayId, "Level", "value", 7);
      expect(result).not.toMatch(/corrected/i);

      await expect(frame.getByText("level 7", { exact: true })).toBeVisible({ timeout: 15_000 });
      await expect(frame.getByText("Level: 7")).toBeVisible();
      const checkId = await mcp.createCell("pass");
      await expectPython(
        page,
        mcp,
        checkId,
        ["assert slider.value == 7, slider.value", "assert md.object == 'level 7', md.object"],
        "AGENT_WRITE_APPLIED",
      );
      await expectSameMountedRoot(frame);
    } finally {
      await mcp.close();
    }
  });

  test("streamed column data reaches connected pages and late joiners", async ({
    context,
    page,
  }) => {
    await recordBokehMessages(page);
    const { notebookId, mcp } = await openPanelNotebook(page);
    const pages: Page[] = [];
    try {
      const displayId = await displayPanel(mcp, [
        "from bokeh.models import ColumnDataSource",
        "from bokeh.plotting import figure",
        "source = ColumnDataSource(data=dict(x=[0], y=[0]))",
        "plot = figure(height=200, width=300)",
        "plot.line('x', 'y', source=source)",
        "display(pn.Column(pn.pane.Bokeh(plot)))",
        "print(source.id)",
      ]);
      const sourceId = (await outputArea(page, displayId).innerText()).trim().split(/\s+/).at(-1)!;
      const frame = outputFrame(page, displayId);
      await expect
        .poll(() => columnTail(frame, sourceId), { timeout: 60_000 })
        .toEqual({
          length: 1,
          last: 0,
        });
      await markMountedRoot(frame);

      const streamId = await mcp.createCell("pass");
      await runCell(
        mcp,
        streamId,
        "for i in range(1, 50):\n    source.stream(dict(x=[i], y=[i * i]), rollover=30)",
      );
      await expect.poll(() => columnTail(frame, sourceId)).toEqual({ length: 30, last: 49 });

      // A joiner before the fold loads the folded columns plus the retained tail.
      const early = await context.newPage();
      pages.push(early);
      await openNotebookRoom(early, notebookId);
      await expect
        .poll(() => columnTail(outputFrame(early, displayId), sourceId), { timeout: 60_000 })
        .toEqual({ length: 30, last: 49 });

      // After the quiet fold, a joiner reads the columns alone.
      await page.waitForTimeout(5_000);
      await runCell(mcp, streamId, "source.stream(dict(x=[50], y=[2500]), rollover=30)");
      await page.waitForTimeout(5_000);
      const late = await context.newPage();
      pages.push(late);
      await openNotebookRoom(late, notebookId);
      for (const viewer of [page, early, late]) {
        await expect
          .poll(() => columnTail(outputFrame(viewer, displayId), sourceId), { timeout: 60_000 })
          .toEqual({ length: 30, last: 50 });
      }
      await expectSameMountedRoot(frame);
    } finally {
      for (const viewer of pages) await viewer.close();
      await mcp.close();
    }
  });

  test("a Tabulator cell edit reaches Python as a data event", async ({ context, page }) => {
    await recordBokehMessages(page);
    const { notebookId, mcp } = await openPanelNotebook(page);
    let peer: Page | undefined;
    try {
      const displayId = await displayPanel(mcp, [
        "import pandas as pd",
        "table = pn.widgets.Tabulator(pd.DataFrame({'a': [1, 2, 3], 'b': ['x', 'y', 'z']}))",
        "display(pn.Column(table))",
      ]);
      const frame = outputFrame(page, displayId);
      const cell = frame.locator('.tabulator-row .tabulator-cell[tabulator-field="b"]').first();
      await expect(cell).toHaveText("x", { timeout: 60_000 });
      await markMountedRoot(frame);

      await engageFrame(page, displayId);
      await cell.click();
      const editor = cell.locator("input");
      await editor.fill("edited", { timeout: 15_000 });
      await editor.press("Enter");
      await expect(cell).toHaveText("edited");

      const checkId = await mcp.createCell("pass");
      await expect
        .poll(async () => {
          await runCell(mcp, checkId, "print(table.value.loc[0, 'b'])");
          return (await outputArea(page, checkId).innerText()).trim();
        })
        .toBe("edited");

      peer = await context.newPage();
      await recordBokehMessages(peer);
      await openNotebookRoom(peer, notebookId);
      await expect(
        outputFrame(peer, displayId)
          .locator('.tabulator-row .tabulator-cell[tabulator-field="b"]')
          .first(),
      ).toHaveText("edited", { timeout: 60_000 });
      await expectSameMountedRoot(frame);
    } finally {
      await peer?.close();
      await mcp.close();
    }
  });

  test("a disconnected session is read-only and shows the frozen state", async ({ page }) => {
    await recordBokehMessages(page);
    const { mcp } = await openPanelNotebook(page);
    try {
      const displayId = await displayPanel(mcp, [
        "text = pn.widgets.TextInput(value='initial')",
        "md = pn.pane.Markdown('display state')",
        "display(pn.Column(text, md))",
      ]);
      const frame = outputFrame(page, displayId);
      await expect(frame.getByText("display state", { exact: true })).toBeVisible({
        timeout: 60_000,
      });
      const checkId = await mcp.createCell("pass");
      await runCell(mcp, checkId, "md.object = 'last live state'\ntext.value = 'last value'");
      await expect(frame.getByText("last live state", { exact: true })).toBeVisible();
      await expect(frame.getByRole("textbox")).toHaveValue("last value");
      await markMountedRoot(frame);

      await mcp.restartKernel();
      await expect(frame.getByText("Disconnected", { exact: true })).toBeVisible({
        timeout: 60_000,
      });
      await expect(frame.getByText("last live state", { exact: true })).toBeVisible();
      await expect(frame.getByRole("textbox")).toHaveValue("last value");
      await expectSameMountedRoot(frame);

      // Edits stay local: nothing is written to the session document.
      const writesBefore = (await hostMessages(page)).filter(
        (message) => message.method === "nteract/bokehSetProps",
      ).length;
      await frame.getByRole("textbox").fill("edit after disconnect");
      await frame.getByRole("textbox").press("Enter");
      await page.waitForTimeout(1_000);
      const writesAfter = (await hostMessages(page)).filter(
        (message) => message.method === "nteract/bokehSetProps",
      ).length;
      expect(writesAfter).toBe(writesBefore);

      // A reload renders the frozen state saved with the output.
      await page.reload();
      await waitForNotebookSessionReady(page);
      const reloaded = outputFrame(page, displayId);
      await expect(reloaded.getByText("last live state", { exact: true })).toBeVisible({
        timeout: 60_000,
      });
      await expect(reloaded.getByRole("textbox")).toHaveValue("last value");
      await expect(reloaded.getByText("Disconnected", { exact: true })).toBeVisible();
    } finally {
      await mcp.close();
    }
  });
});
