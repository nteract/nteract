import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { FrameType } from "runtimed/src/wire-constants.ts";
import { notebookCloudBaseUrl } from "./local-dev.mjs";

// Only creates disposable LOCAL notebooks. Never accepts an existing notebook id.
// Start the built viewer with `pnpm dev` first. Results are JSON on stdout.
// Cold = new browser context (no HTTP/IDB cache); warm = same page/context.
// Catalog creation uses the real API, followed by a document navigation, as the
// New notebook action does. No notebook code is executed.
const baseUrl = notebookCloudBaseUrl();
const origin = new URL(baseUrl).origin;
assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(baseUrl).hostname));
const runs = Number(process.env.NOTEBOOK_CLOUD_STARTUP_RUNS ?? 5);
assert.ok(Number.isInteger(runs) && runs > 0 && runs <= 30);
const syncDelayMs = Number(process.env.NOTEBOOK_CLOUD_STARTUP_SYNC_DELAY_MS ?? 0);
assert.ok(Number.isInteger(syncDelayMs) && syncDelayMs >= 0 && syncDelayMs <= 10_000);
const browser = await chromium.launch({ headless: true });
const results = [];
const editorSelector = '[data-cell-type="code"] .cm-content[contenteditable="true"]';
try {
  for (let run = 0; run < runs; run++) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    if (syncDelayMs > 0) {
      await context.routeWebSocket(
        (url) => url.pathname.endsWith("/sync"),
        (socket) => {
          const server = socket.connectToServer();
          const pending = [];
          let waiting = true;
          const timer = setTimeout(() => {
            waiting = false;
            for (const message of pending.splice(0)) socket.send(message);
          }, syncDelayMs);
          // Deliver session control immediately, but hold binary document sync
          // frames in order to reproduce a slow room hydration after acceptance.
          server.onMessage((message) => {
            if (waiting && typeof message !== "string" && message[0] !== FrameType.SESSION_CONTROL)
              pending.push(message);
            else socket.send(message);
          });
          socket.onClose(() => {
            clearTimeout(timer);
            server.close();
          });
        },
      );
    }
    await context.addInitScript(() => {
      if (window !== window.top) return;
      localStorage.setItem("nteract:notebook-cloud:dev-token", "local-loopback-dev-token");
      localStorage.setItem("nteract:notebook-cloud:user", "startup-profile");
      localStorage.setItem("nteract:notebook-cloud:scope", "owner");
      const profile = (window.__startupProfile = { transitions: [], longTasks: [] });
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          profile.longTasks.push({ start: entry.startTime, duration: entry.duration });
        }
      }).observe({ type: "longtask", buffered: true });
      let previous = "";
      function sample() {
        const state = {
          editable: Boolean(
            document.querySelector('[data-cell-type="code"] .cm-content[contenteditable="true"]'),
          ),
          addEnabled: Boolean(
            document.querySelector('[data-testid="add-code-cell-button"]:not(:disabled)'),
          ),
          startup: document.querySelector(".cloud-startup-status")?.textContent?.trim() ?? null,
          notices: document.querySelector(".cloud-notebook-notices")?.textContent?.trim() ?? null,
        };
        const key = JSON.stringify(state);
        if (key !== previous) profile.transitions.push({ ms: performance.now(), ...state });
        previous = key;
      }
      new MutationObserver(sample).observe(document, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
      sample();
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const create = async () => {
      const start = performance.now();
      const response = await context.request.post(new URL("/api/n", baseUrl).href, {
        headers: {
          "X-Notebook-Cloud-Dev-Token": "local-loopback-dev-token",
          "X-User": "startup-profile",
          "X-Scope": "owner",
          Origin: origin,
        },
        data: { title: `${new Date().toISOString()} startup profile ${run}` },
      });
      assert.equal(response.status(), 201, await response.text());
      return { ...(await response.json()), catalogCreateMs: performance.now() - start };
    };
    const profile = async (mode, created, typeSource) => {
      errors.length = 0;
      const viewerUrl = new URL(created.viewer_url, origin);
      // Reverse-proxy defaults can advertise the deployed origin even locally.
      // Keep probes on the requested loopback Worker in every case.
      const url = new URL(viewerUrl.pathname, origin);
      url.searchParams.set("mode", "edit");
      const start = performance.now();
      await page.goto(url.href, { waitUntil: "domcontentloaded" });
      try {
        await page.locator(editorSelector).first().waitFor({ state: "visible", timeout: 30_000 });
      } catch (error) {
        console.error(
          JSON.stringify({ url: page.url(), errors, body: await page.locator("body").innerText() }),
        );
        throw error;
      }
      if (typeSource) {
        await page.locator(editorSelector).first().fill("# startup profiling probe");
      }
      // Observe the post-ready window: a transient editable node alone must not
      // count as stable readiness. Keep the complete enabled/disabled trace.
      await page.waitForTimeout(1_000);
      assert.equal(
        await page.locator(editorSelector).first().innerText(),
        "# startup profiling probe",
      );
      const timing = await page.evaluate(() => ({
        ...window.__startupProfile,
        marks: performance
          .getEntriesByType("mark")
          .filter((e) => e.name.startsWith("nteract:notebook-cloud:"))
          .map((e) => ({ name: e.name.split(":").at(-1), ms: e.startTime })),
        navigation: performance.getEntriesByType("navigation").map((e) => e.toJSON()),
        resources: performance.getEntriesByType("resource").map((e) => ({
          name: new URL(e.name).pathname,
          start: e.startTime,
          end: e.responseEnd,
          duration: e.duration,
          transferSize: e.transferSize,
          encodedBodySize: e.encodedBodySize,
        })),
      }));
      const firstEditable = timing.transitions.find((t) => t.editable)?.ms ?? null;
      const lastDisabled = timing.transitions.findLast((t) => !t.editable);
      const stableEditable =
        timing.transitions.find((t) => t.editable && t.ms > (lastDisabled?.ms ?? -1))?.ms ?? null;
      const result = {
        run,
        mode,
        notebookId: created.notebook_id,
        catalogCreateMs: mode === "warm-reopen" ? null : created.catalogCreateMs,
        firstEditableMs: firstEditable,
        stableEditableMs: stableEditable,
        createToStableEditableMs:
          mode === "warm-reopen" || stableEditable === null
            ? null
            : created.catalogCreateMs + stableEditable,
        editabilityRegressions: timing.transitions.filter(
          (t, i, all) => i > 0 && !t.editable && all[i - 1].editable,
        ).length,
        toolbarRegressions: timing.transitions.filter(
          (t, i, all) => i > 0 && !t.addEnabled && all[i - 1].addEnabled,
        ).length,
        observedMs: performance.now() - start,
        errors: [...errors],
        ...timing,
      };
      results.push(result);
      console.error(
        `${run + 1} ${mode}: create=${result.catalogCreateMs?.toFixed(0) ?? "n/a"}ms editable=${firstEditable?.toFixed(0)}ms stable=${stableEditable?.toFixed(0)}ms regressions=${result.editabilityRegressions}`,
      );
      if (process.env.NOTEBOOK_CLOUD_STARTUP_ASSERT === "1") {
        assert.deepEqual(result.errors, []);
        assert.equal(result.editabilityRegressions, 0, "the first editor must stay editable");
        assert.equal(
          result.toolbarRegressions,
          0,
          "the toolbar must not enable then disable during startup",
        );
        assert.ok(result.transitions.some((t) => t.startup === "Opening notebook"));
        assert.ok(
          result.transitions.every((t) => !t.notices),
          "ordinary startup must not cycle through notices",
        );
      }
    };
    try {
      const cold = await create();
      await profile("cold-create", cold, true);
      await profile("warm-reopen", cold, false);
      const warm = await create();
      await profile("warm-create", warm, true);
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
  process.stdout.write(
    `${JSON.stringify({ baseUrl, syncDelayMs, generatedAt: new Date().toISOString(), results, limitations: ["Loopback Worker and dev-token auth; no hosted network, OIDC or deployed cold-start claim.", "Cold browser contexts do not restart the Worker, OS file cache, or browser process.", "Create-to-editable sums measured API duration and navigation timing; excludes dashboard pointer and scheduling time.", "MutationObserver samples DOM transitions, not guaranteed painted frames."] }, null, 2)}\n`,
  );
}
