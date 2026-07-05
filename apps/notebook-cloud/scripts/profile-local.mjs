import { pathToFileURL } from "node:url";

import { chromium } from "@playwright/test";

import { notebookCloudBaseUrl } from "./local-dev.mjs";

// Local-wrangler profiling harness for the cloud viewer. Given NTERACT_CLOUD_URL
// (falling back to the per-worktree wrangler port), it visits /n and
// /workstations cold and records, per route: cloud viewer performance marks,
// navigation timing, a long-task total (TBT proxy) across load + a settle
// window, event-timing for one scripted interaction (INP proxy), JS transfer
// bytes from network events, opened WebSockets, and React commit counts from
// the ?profile=1 render hook. It then runs a reconnect-stability check on a
// freshly created notebook room (loopback dev auth), or on /n when a room
// cannot be created. One JSON report goes to stdout; a human table to stderr.
//
// Auth is loopback dev-token only. The worker trusts these localStorage keys and
// the matching x-notebook-cloud-dev-token header on loopback hosts when started
// with NOTEBOOK_CLOUD_TRUST_LOOPBACK_HEADERS:true (scripts/dev.mjs sets it). The
// three storage keys mirror src/dev-auth-storage.ts and the header mirrors
// src/auth-shared.ts DEV_AUTH_TOKEN_HEADER; those files are the source of truth.
const DEV_TOKEN = "local-loopback-dev-token";
const DEV_USER = "browser-editor";
const DEV_SCOPE = "owner";
const DEV_TOKEN_STORAGE_KEY = "nteract:notebook-cloud:dev-token";
const DEV_USER_STORAGE_KEY = "nteract:notebook-cloud:user";
const DEV_SCOPE_STORAGE_KEY = "nteract:notebook-cloud:scope";
const DEV_TOKEN_HEADER = "x-notebook-cloud-dev-token";

const SETTLE_MS = parsePositiveInteger(process.env.NOTEBOOK_CLOUD_PROFILE_SETTLE_MS, 10_000);
const NOTEBOOK_SETTLE_MS = parsePositiveInteger(
  process.env.NOTEBOOK_CLOUD_PROFILE_NOTEBOOK_SETTLE_MS,
  4_000,
);
const NAV_TIMEOUT_MS = parsePositiveInteger(process.env.NOTEBOOK_CLOUD_PROFILE_TIMEOUT_MS, 45_000);
const READY_TIMEOUT_MS = 15_000;

if (isMainModule()) {
  main().catch((error) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 1;
  });
}

async function main() {
  const baseUrl = notebookCloudBaseUrl();
  const origin = new URL(baseUrl).origin;
  logStderr(`Profiling cloud viewer at ${baseUrl}`);

  await waitForWorkerReady(baseUrl);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(profileInitScript, {
    devTokenKey: DEV_TOKEN_STORAGE_KEY,
    devToken: DEV_TOKEN,
    userKey: DEV_USER_STORAGE_KEY,
    user: DEV_USER,
    scopeKey: DEV_SCOPE_STORAGE_KEY,
    scope: DEV_SCOPE,
  });

  const limitations = [];
  let created = null;
  try {
    created = await createLoopbackNotebook(context, baseUrl, origin);
    logStderr(`Created probe notebook ${created.notebookId}`);
  } catch (error) {
    limitations.push(
      `loopback notebook creation failed (${errorText(error)}); reconnect check ran on /n instead`,
    );
    logStderr(`Notebook creation failed: ${errorText(error)}`);
  }

  const routes = {};
  try {
    routes["/n"] = await profileRoute(context, {
      baseUrl,
      routePath: "/n",
      label: "notebook-list",
      settleMs: SETTLE_MS,
      readySelector: 'main.nb-app, [data-kind="error"]',
      interactionCandidates: [
        { label: "refresh-notebooks", selector: 'button[aria-label="Refresh notebooks"]' },
        { label: "new-notebook", selector: 'button:has-text("New notebook")' },
      ],
    });
    routes["/workstations"] = await profileRoute(context, {
      baseUrl,
      routePath: "/workstations",
      label: "workstations",
      settleMs: SETTLE_MS,
      readySelector: 'main.nb-app, [data-kind="error"]',
      interactionCandidates: [
        { label: "workstation-row", selector: "[data-workstation-id]" },
        { label: "refresh-workstations", selector: 'button[aria-label="Refresh workstations"]' },
      ],
    });

    const notebook = created
      ? await profileNotebookReconnect(context, { origin, created })
      : await profileListReconnect(context, { baseUrl });

    // A ?profile=1 load creates window.__nteractRenderCounts eagerly, so an
    // empty object across every surface means the Profiler mounted but onRender
    // never fired: the standard production react-dom build makes Profiler timing
    // inert. Rebuild with NOTEBOOK_CLOUD_PROFILE_REACT=1 to record real counts.
    const sawRenderCounts = [
      ...Object.values(routes).map((route) => route.renderCounts),
      notebook.renderCounts,
    ].some((counts) => counts && Object.keys(counts).length > 0);
    if (!sawRenderCounts) {
      limitations.push(
        "render counts empty: React <Profiler> onRender is inert in the default production build; rebuild with NOTEBOOK_CLOUD_PROFILE_REACT=1 pnpm build:viewer for real counts",
      );
    }

    const report = {
      ok: true,
      baseUrl,
      settleMs: SETTLE_MS,
      generatedAt: new Date().toISOString(),
      createdNotebookId: created?.notebookId ?? null,
      routes,
      notebook,
      limitations,
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    writeHumanTable(report);
  } finally {
    await browser.close().catch(() => {});
  }
}

// Runs before the viewer bundle on every document load: seeds loopback dev auth
// so cold navigations are authenticated, then installs buffered observers whose
// results the metric reader drains after settle. A full reload creates a fresh
// window, so these collectors reset per document by design.
function profileInitScript(seed) {
  try {
    localStorage.setItem(seed.devTokenKey, seed.devToken);
    localStorage.setItem(seed.userKey, seed.user);
    localStorage.setItem(seed.scopeKey, seed.scope);
  } catch {
    // Storage may be unavailable on error pages; auth simply stays unset.
  }
  const store = (window.__nteractProfile = window.__nteractProfile || {
    longTasks: [],
    events: [],
  });
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        store.longTasks.push({ startTime: entry.startTime, duration: entry.duration });
      }
    }).observe({ type: "longtask", buffered: true });
  } catch {
    // longtask timing is Chromium-only; absence degrades to an empty TBT proxy.
  }
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        store.events.push({
          name: entry.name,
          startTime: entry.startTime,
          duration: entry.duration,
          interactionId: entry.interactionId ?? 0,
        });
      }
    }).observe({ type: "event", buffered: true, durationThreshold: 16 });
  } catch {
    // event timing is Chromium-only; absence degrades to a null INP proxy.
  }
}

async function profileRoute(
  context,
  { baseUrl, routePath, label, settleMs, readySelector, interactionCandidates },
) {
  const page = await context.newPage();
  const network = attachNetworkCollectors(page);
  const url = new URL(routePath, baseUrl);
  url.searchParams.set("profile", "1");

  const startedAt = Date.now();
  await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
  await page
    .waitForSelector(readySelector, { timeout: READY_TIMEOUT_MS })
    .catch(() =>
      logStderr(`${label}: ready selector ${readySelector} not seen; collecting anyway`),
    );
  await page.waitForTimeout(settleMs);

  const interaction = await runInteractionProbe(page, interactionCandidates);
  await page.waitForTimeout(1_000);

  const metrics = await page.evaluate(collectPageMetrics, interaction.clickStart);
  const renderCounts = await page.evaluate(() => window.__nteractRenderCounts ?? null);
  await network.settle();
  await page.close();

  return {
    route: routePath,
    label,
    wallClockMs: Date.now() - startedAt,
    marks: metrics.marks,
    navigationTiming: metrics.navigationTiming,
    paint: metrics.paint,
    longTasks: metrics.longTasks,
    interaction: {
      target: interaction.target,
      inpProxyMs: metrics.interaction.maxDurationMs,
      eventCount: metrics.interaction.count,
      sampleEvents: metrics.interaction.sample,
    },
    jsTransferBytes: {
      networkBodyBytes: network.jsBodyBytes(),
      networkContentLengthBytes: network.jsContentLengthBytes(),
      resourceTimingEncodedBytes: metrics.jsResourceTimingBytes,
      jsResponseCount: network.jsResponseCount(),
    },
    webSockets: network.webSockets(),
    renderCounts,
  };
}

async function profileNotebookReconnect(context, { origin, created }) {
  const page = await context.newPage();
  const network = attachNetworkCollectors(page);
  const viewerUrl = rebaseUrl(created.viewerUrl, origin);
  viewerUrl.searchParams.set("profile", "1");

  const startedAt = Date.now();
  await page.goto(viewerUrl.href, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
  await page
    .waitForSelector('[data-testid="notebook-toolbar"], main.nb-app', { timeout: READY_TIMEOUT_MS })
    .catch(() => logStderr("notebook: toolbar not seen; collecting anyway"));
  await page.waitForTimeout(NOTEBOOK_SETTLE_MS);

  const marks = await page.evaluate(collectMarks);
  const navigationTiming = await page.evaluate(collectNavigationTiming);
  const wsBefore = network.webSockets().length;
  const nonce = await page.evaluate(() => {
    const value = Math.random().toString(36).slice(2);
    window.__nteractReloadNonce = value;
    return value;
  });

  // Exercise the window focus / visibility path twice, ~2s apart, the way a
  // tab-switch would. onFocusChange in cloud-notebook-host.ts and the
  // browser-signals visibility subject listen for these; a stable session must
  // not dial a new WebSocket or reload the document in response.
  for (let cycle = 0; cycle < 2; cycle += 1) {
    await page.evaluate(() => {
      window.dispatchEvent(new Event("blur"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.waitForTimeout(500);
    await page.evaluate(() => {
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.waitForTimeout(2_000);
  }

  const wsAfter = network.webSockets().length;
  const nonceSurvived = await page.evaluate(
    (value) => window.__nteractReloadNonce === value,
    nonce,
  );
  const renderCounts = await page.evaluate(() => window.__nteractRenderCounts ?? null);
  await page.close();

  const reloaded = !nonceSurvived;
  const openedNewWebSocket = wsAfter > wsBefore;
  return {
    mode: "notebook-room",
    notebookId: created.notebookId,
    viewerUrl: viewerUrl.href,
    wallClockMs: Date.now() - startedAt,
    marks,
    navigationTiming,
    webSockets: network.webSockets(),
    reconnect: {
      webSocketsBefore: wsBefore,
      webSocketsAfter: wsAfter,
      openedNewWebSocket,
      reloaded,
      stable: !openedNewWebSocket && !reloaded,
    },
    renderCounts,
  };
}

async function profileListReconnect(context, { baseUrl }) {
  const page = await context.newPage();
  const network = attachNetworkCollectors(page);
  const url = new URL("/n", baseUrl);
  url.searchParams.set("profile", "1");

  await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
  await page.waitForSelector("main.nb-app", { timeout: READY_TIMEOUT_MS }).catch(() => {});
  await page.waitForTimeout(NOTEBOOK_SETTLE_MS);

  const wsBefore = network.webSockets().length;
  const nonce = await page.evaluate(() => {
    const value = Math.random().toString(36).slice(2);
    window.__nteractReloadNonce = value;
    return value;
  });
  for (let cycle = 0; cycle < 2; cycle += 1) {
    await page.evaluate(() => {
      window.dispatchEvent(new Event("blur"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.waitForTimeout(500);
    await page.evaluate(() => {
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.waitForTimeout(2_000);
  }
  const wsAfter = network.webSockets().length;
  const nonceSurvived = await page.evaluate(
    (value) => window.__nteractReloadNonce === value,
    nonce,
  );
  await page.close();

  const reloaded = !nonceSurvived;
  const openedNewWebSocket = wsAfter > wsBefore;
  return {
    mode: "notebook-list",
    wallClockMs: null,
    marks: [],
    navigationTiming: null,
    webSockets: network.webSockets(),
    reconnect: {
      webSocketsBefore: wsBefore,
      webSocketsAfter: wsAfter,
      openedNewWebSocket,
      reloaded,
      stable: !openedNewWebSocket && !reloaded,
    },
    renderCounts: null,
  };
}

async function runInteractionProbe(page, candidates) {
  for (const candidate of candidates) {
    const locator = page.locator(candidate.selector).first();
    const count = await locator.count().catch(() => 0);
    if (count === 0) {
      continue;
    }
    const visible = await locator.isVisible().catch(() => false);
    if (!visible) {
      continue;
    }
    const clickStart = await page.evaluate(() => performance.now());
    await locator.click({ timeout: 5_000 }).catch(() => {});
    return { target: candidate.label, selector: candidate.selector, clickStart };
  }
  return { target: null, selector: null, clickStart: 0 };
}

function attachNetworkCollectors(page) {
  const responses = [];
  const sockets = [];
  const bodyPromises = [];
  page.on("response", (response) => {
    const request = response.request();
    const type = request.resourceType();
    const entry = {
      url: response.url(),
      resourceType: type,
      status: response.status(),
      contentLength: Number(response.headers()["content-length"] ?? 0),
      bodyBytes: null,
    };
    responses.push(entry);
    // Wrangler dev serves assets chunked without content-length, so read the
    // decoded body length to get real transfer bytes from the network events.
    if (type === "script") {
      bodyPromises.push(
        response
          .body()
          .then((buffer) => {
            entry.bodyBytes = buffer.length;
          })
          .catch(() => {}),
      );
    }
  });
  page.on("websocket", (socket) => {
    sockets.push(socket.url());
  });
  const scripts = () => responses.filter((entry) => entry.resourceType === "script");
  return {
    settle: () => Promise.all(bodyPromises),
    jsBodyBytes: () => scripts().reduce((sum, entry) => sum + (entry.bodyBytes ?? 0), 0),
    jsContentLengthBytes: () =>
      scripts().reduce(
        (sum, entry) => sum + (Number.isFinite(entry.contentLength) ? entry.contentLength : 0),
        0,
      ),
    jsResponseCount: () => scripts().length,
    webSockets: () => [...sockets],
  };
}

// Evaluated in the page. `clickStart` scopes the event-timing entries to the one
// scripted interaction so the INP proxy is that interaction's worst event.
function collectPageMetrics(clickStart) {
  const store = window.__nteractProfile || { longTasks: [], events: [] };

  const marks = performance
    .getEntriesByType("mark")
    .filter((mark) => mark.name.startsWith("nteract:notebook-cloud:"))
    .map((mark) => ({
      name: mark.name.replace("nteract:notebook-cloud:", ""),
      startTimeMs: Math.round(mark.startTime),
    }));

  const nav = performance.getEntriesByType("navigation")[0];
  const navigationTiming = nav
    ? {
        responseEndMs: Math.round(nav.responseEnd),
        domContentLoadedMs: Math.round(nav.domContentLoadedEventEnd),
        domCompleteMs: Math.round(nav.domComplete),
        loadEventEndMs: Math.round(nav.loadEventEnd),
        transferSize: nav.transferSize,
      }
    : null;

  const paint = {};
  for (const entry of performance.getEntriesByType("paint")) {
    paint[entry.name] = Math.round(entry.startTime);
  }

  const longTasks = store.longTasks || [];
  const longTaskTotalMs = Math.round(longTasks.reduce((sum, task) => sum + task.duration, 0));
  const tbtProxyMs = Math.round(
    longTasks.reduce((sum, task) => sum + Math.max(0, task.duration - 50), 0),
  );

  const interactionEvents = (store.events || []).filter((entry) => entry.startTime >= clickStart);
  const maxDurationMs = interactionEvents.length
    ? Math.round(Math.max(...interactionEvents.map((entry) => entry.duration)))
    : null;

  const jsResourceTimingBytes = performance
    .getEntriesByType("resource")
    .filter((entry) => entry.initiatorType === "script" || /\.js(\?|$)/.test(entry.name))
    .reduce((sum, entry) => sum + (entry.encodedBodySize || 0), 0);

  return {
    marks,
    navigationTiming,
    paint,
    longTasks: { count: longTasks.length, totalMs: longTaskTotalMs, tbtProxyMs },
    interaction: {
      count: interactionEvents.length,
      maxDurationMs,
      sample: interactionEvents.slice(0, 8).map((entry) => ({
        name: entry.name,
        durationMs: Math.round(entry.duration),
      })),
    },
    jsResourceTimingBytes,
  };
}

function collectMarks() {
  return performance
    .getEntriesByType("mark")
    .filter((mark) => mark.name.startsWith("nteract:notebook-cloud:"))
    .map((mark) => ({
      name: mark.name.replace("nteract:notebook-cloud:", ""),
      startTimeMs: Math.round(mark.startTime),
    }));
}

function collectNavigationTiming() {
  const nav = performance.getEntriesByType("navigation")[0];
  if (!nav) {
    return null;
  }
  return {
    responseEndMs: Math.round(nav.responseEnd),
    domContentLoadedMs: Math.round(nav.domContentLoadedEventEnd),
    domCompleteMs: Math.round(nav.domComplete),
    loadEventEndMs: Math.round(nav.loadEventEnd),
    transferSize: nav.transferSize,
  };
}

async function createLoopbackNotebook(context, baseUrl, origin) {
  const response = await context.request.post(new URL("/api/n", baseUrl).href, {
    headers: {
      [DEV_TOKEN_HEADER]: DEV_TOKEN,
      "X-User": DEV_USER,
      "X-Scope": DEV_SCOPE,
      "Content-Type": "application/json",
      Origin: origin,
    },
    data: { title: "profile-local reconnect probe" },
  });
  if (response.status() !== 201) {
    throw new Error(`create notebook returned ${response.status()}: ${await response.text()}`);
  }
  const body = await response.json();
  if (!body.notebook_id || !body.viewer_url) {
    throw new Error("create notebook response missing notebook_id or viewer_url");
  }
  return { notebookId: body.notebook_id, viewerUrl: body.viewer_url };
}

async function waitForWorkerReady(baseUrl) {
  const healthUrl = new URL("/api/health", baseUrl).href;
  const deadline = Date.now() + 30_000;
  let lastError = "not attempted";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(healthUrl, { signal: AbortSignal.timeout(3_000) });
      if (response.ok) {
        return;
      }
      lastError = `status ${response.status}`;
    } catch (error) {
      lastError = errorText(error);
    }
    await sleep(500);
  }
  throw new Error(`worker at ${baseUrl} not ready within 30s (last: ${lastError})`);
}

function writeHumanTable(report) {
  const lines = [];
  lines.push("");
  lines.push(`cloud viewer profile  base=${report.baseUrl}  settle=${report.settleMs}ms`);
  lines.push("-".repeat(88));
  const header = [
    pad("route", 15),
    pad("marks", 7),
    pad("dclMs", 7),
    pad("tbtMs", 7),
    pad("inpMs", 7),
    pad("jsKB", 8),
    pad("ws", 4),
    pad("renders", 8),
  ].join(" ");
  lines.push(header);
  for (const [routePath, route] of Object.entries(report.routes)) {
    lines.push(
      [
        pad(routePath, 15),
        pad(String(route.marks.length), 7),
        pad(numOrDash(route.navigationTiming?.domContentLoadedMs), 7),
        pad(numOrDash(route.longTasks.tbtProxyMs), 7),
        pad(numOrDash(route.interaction.inpProxyMs), 7),
        pad(kb(bestJsBytes(route.jsTransferBytes)), 8),
        pad(String(route.webSockets.length), 4),
        pad(renderTotal(route.renderCounts), 8),
      ].join(" "),
    );
  }
  lines.push("-".repeat(88));
  const nb = report.notebook;
  if (nb) {
    lines.push(`reconnect (${nb.mode}) marks=${nb.marks.length}`);
    lines.push(
      `  ws ${nb.reconnect.webSocketsBefore} -> ${nb.reconnect.webSocketsAfter}` +
        `  newWs=${nb.reconnect.openedNewWebSocket}  reloaded=${nb.reconnect.reloaded}` +
        `  stable=${nb.reconnect.stable}`,
    );
    if (nb.marks.length) {
      lines.push(
        `  marks: ${nb.marks.map((mark) => `${mark.name}@${mark.startTimeMs}`).join(", ")}`,
      );
    }
  }
  if (report.limitations.length) {
    lines.push("limitations:");
    for (const note of report.limitations) {
      lines.push(`  - ${note}`);
    }
  }
  lines.push("");
  logStderr(lines.join("\n"));
}

function bestJsBytes(jsTransferBytes) {
  return (
    jsTransferBytes.networkBodyBytes ||
    jsTransferBytes.networkContentLengthBytes ||
    jsTransferBytes.resourceTimingEncodedBytes ||
    0
  );
}

function renderTotal(renderCounts) {
  if (!renderCounts) {
    return "-";
  }
  const total = Object.values(renderCounts).reduce((sum, value) => sum + Number(value || 0), 0);
  return String(total);
}

function rebaseUrl(value, origin) {
  const url = new URL(value, origin);
  const base = new URL(origin);
  url.protocol = base.protocol;
  url.host = base.host;
  return url;
}

function numOrDash(value) {
  return value === null || value === undefined ? "-" : String(value);
}

function kb(bytes) {
  if (!bytes) {
    return "0";
  }
  return (bytes / 1024).toFixed(1);
}

function pad(value, width) {
  const text = String(value);
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function parsePositiveInteger(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`expected a positive integer, received ${JSON.stringify(value)}`);
  }
  return parsed;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logStderr(message) {
  process.stderr.write(`${message}\n`);
}

function isMainModule() {
  return process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
}
