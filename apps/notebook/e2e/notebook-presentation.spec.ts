import { expect, test, type Frame, type Page } from "@playwright/test";
import type { NotebookPresentationConfig } from "@nteract/notebook-host";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const fixturePath = path.join(repoRoot, "apps/notebook/e2e/fixtures/outline-headings.ipynb");
let fixtureDirectory: string;

test.beforeEach(() => {
  fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "nteract-presentation-"));
  fs.copyFileSync(fixturePath, path.join(fixtureDirectory, "outline.ipynb"));
});

test.afterEach(() => fs.rmSync(fixtureDirectory, { recursive: true, force: true }));

async function openEmbeddedNotebook(page: Page, presentation?: NotebookPresentationConfig) {
  // The parent uses the dev relay only as a runtime adapter. The notebook boots
  // through the production Electron origin check and transferred MessagePort.
  await page.route("**/__presentation_parent?*", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><head><style>
        html,body{margin:0;width:100%;height:100%;overflow:hidden}
        iframe{display:block;border:0;width:100%;height:100%}
      </style></head><body><script type="module">
        import { createBrowserHost } from '/@fs/${repoRoot}/packages/notebook-host/src/browser/index.ts';
        import { connectElectronNotebookFrame, onElectronNotebookFrameReady }
          from '/@fs/${repoRoot}/packages/notebook-host/src/electron/protocol.ts';
        const host = await createBrowserHost();
        const iframe = document.createElement('iframe');
        iframe.title = 'Embedded notebook';
        const channel = new MessageChannel();
        const port = channel.port1;
        window.sendRailCommand = (id, payload) => port.postMessage({
          type: 'nteract:host-event', event: 'command', payload: {id, payload}
        });
        host.transport.onFrame(frame => port.postMessage({type:'nteract:frame', frame}));
        for (const [method, event] of [
          ['onReady','daemon.ready'], ['onProgress','daemon.progress'],
          ['onDisconnected','daemon.disconnected'], ['onUnavailable','daemon.unavailable']
        ]) host.daemonEvents[method](payload => port.postMessage({type:'nteract:host-event',event,payload}));
        port.onmessage = async ({data}) => {
          if (data.type === 'nteract:frame') {
            const frame = new Uint8Array(data.frame);
            await host.transport.sendFrame(frame[0], frame.slice(1));
          } else if (data.type === 'nteract:host-request') {
            try {
              const [namespace, method] = data.method.split('.');
              let value;
              if (data.method === 'relay.prepareSync') value = undefined;
              else if (data.method === 'blobs.getPort') value = await host.blobs.port();
              else if (data.method === 'updater.check') value = await host.updater.check();
              else value = await host[namespace][method](data.params);
              port.postMessage({type:'nteract:host-response',id:data.id,ok:true,value});
            } catch (error) {
              port.postMessage({type:'nteract:host-response',id:data.id,ok:false,error:String(error)});
            }
          }
        };
        const url = new URL('/', location.href);
        url.searchParams.set('nteract-host','electron');
        url.searchParams.set('nteract-parent-origin',location.origin);
        document.body.append(iframe);
        onElectronNotebookFrameReady({
          iframeWindow: iframe.contentWindow, iframeOrigin: location.origin,
          onReady(message) {
            window.presentationReady = message;
            connectElectronNotebookFrame(iframe.contentWindow, location.origin, {
              port: channel.port2,
              bootstrap: {
                protocolVersion: 1, outputDocumentUrl: new URL('/isolated-renderer.html',location.href).href,
                presentation: ${JSON.stringify(presentation) ?? "undefined"}
              }
            });
          }
        });
        iframe.src = url.href;
      </script></body></html>`,
    }),
  );
  const params = new URLSearchParams({
    path: path.join(fixtureDirectory, "outline.ipynb"),
    environment_mode: "notebook",
  });
  await page.goto(`/__presentation_parent?${params}`);
  await expect
    .poll(() => page.frames().find((frame) => frame.url().includes("nteract-host=electron")))
    .toBeTruthy();
  const notebook = page.frames().find((frame) => frame.url().includes("nteract-host=electron"))!;
  await expect(notebook.getByTestId("notebook-toolbar")).toBeAttached({ timeout: 30_000 });
  await expect(notebook.locator("[data-notebook-synced]")).toHaveAttribute(
    "data-notebook-synced",
    "true",
    { timeout: 30_000 },
  );
  await expect(notebook.locator("[data-cell-type]")).toHaveCount(3, { timeout: 30_000 });
  expect(await page.evaluate(() => Reflect.get(window, "presentationReady"))).toEqual({
    type: "nteract:electron-host-ready",
    protocolVersion: 1,
    capabilities: ["presentation.rail"],
  });
  return notebook;
}

async function command(page: Page, panelId?: "outline" | "packages") {
  await page.evaluate((panelId) => {
    Reflect.get(window, "sendRailCommand")(
      panelId ? "notebook.rail.open" : "notebook.rail.close",
      panelId ? { panelId } : undefined,
    );
  }, panelId);
}

async function expectRightGeometry(notebook: Frame, width: number) {
  const strip = await notebook.getByTestId("notebook-rail").boundingBox();
  const panel = await notebook.locator('[data-slot="notebook-rail-panel"]').boundingBox();
  expect(strip).not.toBeNull();
  expect(panel).not.toBeNull();
  expect(strip!.x + strip!.width).toBeCloseTo(width, 0);
  expect(panel!.x + panel!.width).toBeCloseTo(strip!.x, 0);
  expect(panel!.width).toBeGreaterThan(200);
  if (width < 600) expect(panel!.x).toBeCloseTo(0, 0);
  else {
    const content = await notebook
      .locator('[data-slot="notebook-document-stage-content"]')
      .boundingBox();
    expect(content!.x + content!.width).toBeCloseTo(panel!.x, 0);
  }
}

test.describe("embedded notebook presentation", () => {
  test("defaults to the left collapsed rail without presentation", async ({ page }) => {
    const notebook = await openEmbeddedNotebook(page);
    await expect(notebook.getByTestId("notebook-rail")).toHaveAttribute("data-rail-side", "left");
    await expect(notebook.getByTestId("notebook-rail")).toHaveAttribute("data-collapsed", "true");
  });

  for (const viewport of [
    { width: 1280, height: 900 },
    { width: 390, height: 844 },
  ]) {
    test(`boots the right rail and restores hidden panels at ${viewport.width}px`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize(viewport);
      const notebook = await openEmbeddedNotebook(page, {
        rail: { side: "right", visible: false, initialCollapsed: false, initialPanel: "packages" },
      });
      const rail = notebook.getByTestId("notebook-rail");
      const toolbar = notebook.getByTestId("notebook-toolbar");
      await expect(rail).toHaveAttribute("data-rail-side", "right");
      await expect(rail).toBeHidden();
      await expect(toolbar).toBeVisible();
      await expect(notebook.locator('[data-slot="notebook-rail-panel"]')).toHaveCount(0);
      await expect(notebook.locator('[data-slot="notebook-document-rail-panel-host"]')).toBeEmpty();
      const cell = notebook.locator('[data-cell-type="code"]').first();
      const cellHandle = await cell.elementHandle();
      const toolbarHandle = await toolbar.elementHandle();
      const panelHostHandle = await notebook
        .locator('[data-slot="notebook-document-rail-panel-host"]')
        .elementHandle();

      for (const panelId of ["packages", "outline"] as const) {
        await notebook.getByTestId("add-code-cell-button").focus();
        await command(page, panelId);
        await expect(rail).toBeVisible();
        await expect(rail).toHaveAttribute("data-collapsed", "false");
        await expect(
          notebook.getByRole("heading", {
            name: panelId === "packages" ? "Packages" : "Outline",
            exact: true,
          }),
        ).toBeVisible();
        await expectRightGeometry(notebook, viewport.width);
        if (viewport.width < 600) {
          await expect(toolbar).toBeHidden();
          await expect(
            notebook.getByRole("button", {
              name: panelId === "packages" ? "Packages" : "Outline",
              exact: true,
            }),
          ).toBeFocused();
        } else await expect(toolbar).toBeVisible();
        await page.screenshot({
          path: testInfo.outputPath(`right-${viewport.width}-${panelId}.png`),
        });
        await command(page);
        await expect(rail).toBeVisible();
        await expect(rail).toHaveAttribute("data-collapsed", "true");
        await expect(notebook.locator('[data-slot="notebook-rail-panel"]')).toHaveCount(0);
        await expect(toolbar).toBeVisible();
        expect(
          await notebook.evaluate(() => {
            const active = document.activeElement;
            return (
              active instanceof HTMLElement && active !== document.body && active.checkVisibility()
            );
          }),
        ).toBe(true);
      }

      expect(await cell.evaluate((node, original) => node === original, cellHandle)).toBe(true);
      expect(await toolbar.evaluate((node, original) => node === original, toolbarHandle)).toBe(
        true,
      );
      expect(
        await notebook
          .locator('[data-slot="notebook-document-rail-panel-host"]')
          .evaluate((node, original) => node === original, panelHostHandle),
      ).toBe(true);
      const indicator = notebook.getByTestId("runtime-environment-indicator");
      await expect(indicator).toBeVisible();
      await expect(indicator).not.toHaveAttribute("tabindex");
      await expect(indicator).not.toHaveAttribute("role", "button");
      await indicator.click();
      await expect(rail).toHaveAttribute("data-collapsed", "true");
      await expect(toolbar).toBeVisible();
      await expect(notebook.getByRole("button", { name: "Comments", exact: true })).toHaveCount(0);
    });
  }

  test("honors initially expanded right packages without resetting user interaction", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const notebook = await openEmbeddedNotebook(page, {
      rail: { side: "right", initialPanel: "packages", initialCollapsed: false },
    });
    await expect(notebook.getByRole("heading", { name: "Packages", exact: true })).toBeVisible();
    await expectRightGeometry(notebook, 1280);
    await notebook.getByRole("button", { name: "Packages", exact: true }).click();
    await expect(notebook.getByTestId("notebook-rail")).toHaveAttribute("data-collapsed", "true");
    await command(page, "outline");
    await expect(notebook.getByRole("heading", { name: "Outline", exact: true })).toBeVisible();
    await expect(
      notebook
        .getByTestId("notebook-outline-panel")
        .getByRole("link", { name: "Notebook rail fixture", exact: true }),
    ).toBeVisible();
  });
});
