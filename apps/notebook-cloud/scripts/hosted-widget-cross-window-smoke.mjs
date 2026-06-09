import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { chromium, expect } from "@playwright/test";

import {
  saveSmokeScreenshot,
  smokeJsonReportPath,
  smokeOutputPath,
  writeSmokeJsonReport,
} from "./smoke-paths.mjs";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimePeerScript = path.join(appDir, "scripts", "hosted-runtime-peer-smoke.mjs");
const tokenPath =
  process.env.NTERACT_PREVIEW_OIDC_TOKEN_PATH ??
  process.env.NOTEBOOK_CLOUD_OIDC_TOKEN_PATH ??
  path.join(os.homedir(), "token.preview.json");
const timeoutMs = parsePositiveInteger(
  process.env.NOTEBOOK_CLOUD_WIDGET_CROSS_WINDOW_TIMEOUT_MS,
  "NOTEBOOK_CLOUD_WIDGET_CROSS_WINDOW_TIMEOUT_MS",
  75_000,
);
const settleMs = parsePositiveInteger(
  process.env.NOTEBOOK_CLOUD_WIDGET_CROSS_WINDOW_SETTLE_MS,
  "NOTEBOOK_CLOUD_WIDGET_CROSS_WINDOW_SETTLE_MS",
  800,
);
const screenshotPath = smokeOutputPath(process.env.NOTEBOOK_CLOUD_WIDGET_CROSS_WINDOW_SCREENSHOT);
const reportPath = smokeJsonReportPath("hosted-widget-cross-window-smoke");
const source = [
  "from IPython.display import display",
  "import ipywidgets as widgets",
  "",
  'slider = widgets.IntSlider(value=7, description="probe")',
  "display(slider)",
].join("\n");

if (isMainModule()) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

async function main() {
  const tokenStorageJson = await readOidcTokenStorageJson(tokenPath);
  const token = JSON.parse(tokenStorageJson);
  const tokenSecondsRemaining = Number(token.expiresAt) - Math.floor(Date.now() / 1000);
  if (!Number.isFinite(tokenSecondsRemaining) || tokenSecondsRemaining <= 60) {
    throw new Error(
      `${tokenPath} is expired or near expiry; refresh it before running the widget smoke`,
    );
  }

  let runtimePeerPid = null;
  const browser = await chromium.launch({
    headless: process.env.NOTEBOOK_CLOUD_HEADED !== "1",
    timeout: timeoutMs,
  });
  try {
    const runtime = await runJsonScript("runtime-peer", runtimePeerScript, [], {
      ...process.env,
      NOTEBOOK_CLOUD_KEEP_RUNTIME_PEER: "1",
      NOTEBOOK_CLOUD_RUNTIME_PEER_PYTHON:
        process.env.NOTEBOOK_CLOUD_RUNTIME_PEER_PYTHON ?? path.join(os.homedir(), "k/bin/python"),
      NOTEBOOK_CLOUD_RUNTIME_PEER_SMOKE_CODE: source,
      NOTEBOOK_CLOUD_RUNTIME_PEER_SMOKE_SECONDS:
        process.env.NOTEBOOK_CLOUD_RUNTIME_PEER_SMOKE_SECONDS ?? "45",
      NOTEBOOK_CLOUD_RUNTIME_PEER_SMOKE_VANITY:
        process.env.NOTEBOOK_CLOUD_WIDGET_CROSS_WINDOW_VANITY ?? "widget-cross-window-smoke",
    });
    runtimePeerPid = runtime.runtimePeer?.pid ?? null;
    if (!runtime.ok || typeof runtime.viewerUrl !== "string" || !runtime.viewerUrl) {
      throw new Error(`runtime-peer smoke returned an invalid result:\n${stringify(runtime)}`);
    }
    if (!Number.isInteger(runtimePeerPid)) {
      throw new Error(
        `runtime-peer smoke did not keep a runtime peer alive:\n${stringify(runtime)}`,
      );
    }

    const browserRun = await runBrowserSmoke({
      browser,
      tokenStorageJson,
      viewerUrl: runtime.viewerUrl,
    });
    await stopProcess(runtimePeerPid);
    runtimePeerPid = null;

    const report = {
      ok: true,
      viewerUrl: runtime.viewerUrl,
      notebookId: runtime.notebookId,
      source,
      token: {
        path: tokenPath,
        secondsRemaining: tokenSecondsRemaining,
      },
      runtimePeer: {
        logPath: runtime.runtimePeer?.logPath ?? null,
        stopped: true,
      },
      checks: [
        "runtime_peer_widget_cell_executed",
        "primary_window_widget_rendered",
        "peer_window_widget_rendered",
        "widget_initial_value_synced",
        "widget_drag_changed_primary_value",
        "widget_drag_synced_to_peer_window",
        "widget_loading_message_absent",
      ],
      browser: browserRun,
    };
    await writeSmokeJsonReport(report, reportPath);
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await browser.close().catch(() => {});
    if (Number.isInteger(runtimePeerPid)) {
      await stopProcess(runtimePeerPid).catch(() => {});
    }
  }
}

async function runBrowserSmoke({ browser, tokenStorageJson, viewerUrl }) {
  const url = new URL(viewerUrl);
  const diagnostics = {
    console: [],
    pageErrors: [],
    requestFailures: [],
    websockets: [],
  };
  const primaryContext = await authenticatedContext(browser, {
    origin: url.origin,
    scope: "owner",
    tokenStorageJson,
  });
  const peerContext = await authenticatedContext(browser, {
    origin: url.origin,
    scope: "owner",
    tokenStorageJson,
  });
  try {
    const primary = await primaryContext.newPage();
    const peer = await peerContext.newPage();
    collectDiagnostics(primary, "primary", diagnostics);
    collectDiagnostics(peer, "peer", diagnostics);

    await Promise.all([
      openNotebookShell(primary, url.href, timeoutMs),
      openNotebookShell(peer, url.href, timeoutMs),
    ]);

    const primarySlider = await waitForWidgetSlider(primary, timeoutMs);
    const peerSlider = await waitForWidgetSlider(peer, timeoutMs);
    await expectSliderValue(primarySlider, "7", timeoutMs);
    await expectSliderValue(peerSlider, "7", timeoutMs);
    await expectNoWidgetLoading(primary, timeoutMs);
    await expectNoWidgetLoading(peer, timeoutMs);

    await dragSliderToValue(primarySlider, 18);
    await expectSliderValue(primarySlider, "18", timeoutMs);
    await expectSliderValue(peerSlider, "18", timeoutMs);
    await expectNoWidgetLoading(primary, timeoutMs);
    await expectNoWidgetLoading(peer, timeoutMs);

    if (screenshotPath) {
      await saveSmokeScreenshot(primary, screenshotPath);
    }
    assertCleanDiagnostics(diagnostics);
    return {
      primary: await widgetPageSnapshot(primary),
      peer: await widgetPageSnapshot(peer),
      diagnostics,
      screenshotPath: screenshotPath ?? null,
    };
  } finally {
    await primaryContext.close().catch(() => {});
    await peerContext.close().catch(() => {});
  }
}

async function authenticatedContext(browser, { origin, scope, tokenStorageJson }) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(
    ({ expectedOrigin, requestedScope, tokenJson }) => {
      try {
        if (globalThis.location?.origin !== expectedOrigin) return;
        globalThis.localStorage?.setItem("nteract:notebook-cloud:oidc-token", tokenJson);
        globalThis.localStorage?.setItem("nteract:notebook-cloud:scope", requestedScope);
      } catch {
        // Output frames intentionally cannot read first-party localStorage.
      }
    },
    { expectedOrigin: origin, requestedScope: scope, tokenJson: tokenStorageJson },
  );
  return context;
}

async function openNotebookShell(page, href, timeout) {
  await page.goto(href, { waitUntil: "domcontentloaded", timeout });
  await page.waitForFunction(
    () =>
      document.querySelector("[data-notebook-synced]")?.getAttribute("data-notebook-synced") ===
        "true" &&
      document.querySelector("[data-session-ready]")?.getAttribute("data-session-ready") === "true",
    null,
    { timeout },
  );
}

async function waitForWidgetSlider(page, timeout) {
  const cell = page.locator('[data-cell-type="code"]').first();
  await cell.waitFor({ state: "visible", timeout });
  const slider = cell
    .frameLocator('[data-slot="isolated-frame"]')
    .locator('[data-widget-type="IntSlider"]')
    .getByRole("slider")
    .first();
  await slider.waitFor({ state: "visible", timeout });
  return slider;
}

async function expectSliderValue(slider, value, timeout) {
  await expect(slider).toHaveAttribute("aria-valuenow", value, { timeout });
}

async function expectNoWidgetLoading(page, timeout) {
  const frameBodies = page.frameLocator('[data-slot="isolated-frame"]').locator("body");
  await expect
    .poll(async () => (await frameBodies.allInnerTexts()).join("\n"), { timeout })
    .not.toMatch(/waiting for widget|loading widget/i);
}

async function dragSliderToValue(slider, targetValue) {
  const [min, max] = await Promise.all([
    slider.getAttribute("aria-valuemin").then((value) => Number(value ?? 0)),
    slider.getAttribute("aria-valuemax").then((value) => Number(value ?? 100)),
  ]);
  const sliderRoot = slider.locator(
    "xpath=ancestor::*[@data-orientation='horizontal' and contains(@class, 'touch-none')][1]",
  );
  const rootBox = await sliderRoot.boundingBox();
  if (!rootBox) {
    throw new Error("IntSlider did not expose the expected drag geometry");
  }
  const clamped = Math.min(max, Math.max(min, targetValue));
  const ratio = max === min ? 0 : (clamped - min) / (max - min);
  await slider.dragTo(sliderRoot, {
    force: true,
    targetPosition: {
      x: rootBox.width * ratio,
      y: rootBox.height / 2,
    },
  });
  await slider.page().waitForTimeout(settleMs);
}

async function widgetPageSnapshot(page) {
  const text = await page
    .locator("body")
    .innerText({ timeout: timeoutMs })
    .catch(() => "");
  const frameBodies = page.frameLocator('[data-slot="isolated-frame"]').locator("body");
  const sliderValues = await page
    .frameLocator('[data-slot="isolated-frame"]')
    .locator('[data-widget-type="IntSlider"] [role="slider"]')
    .evaluateAll((sliders) => sliders.map((slider) => slider.getAttribute("aria-valuenow")))
    .catch(() => []);
  return {
    text: text.replace(/\s+/g, " ").slice(0, 1000),
    widgetFrames: (await frameBodies.allInnerTexts()).map((bodyText, index) => ({
      bodyText: bodyText.replace(/\s+/g, " ").slice(0, 500),
      sliderValue: sliderValues[index] ?? null,
    })),
  };
}

function collectDiagnostics(page, label, diagnostics) {
  page.on("console", (message) => {
    const text = message.text();
    if (
      /waiting for widget|loading widget|WidgetView|widget|comm|OutputResolutionError|Failed to fetch blob|cloud sync socket|WebSocket/i.test(
        text,
      )
    ) {
      diagnostics.console.push(`[${label}:${message.type()}] ${text}`);
    }
  });
  page.on("pageerror", (error) => {
    const text = String(error.message ?? error);
    if (!isBenignPageError(text)) {
      diagnostics.pageErrors.push(`[${label}] ${text}`);
    }
  });
  page.on("requestfailed", (request) => {
    diagnostics.requestFailures.push({
      label,
      url: safeDiagnosticUrl(request.url()),
      failure: request.failure()?.errorText ?? null,
    });
  });
  page.on("websocket", (ws) => {
    const entry = {
      label,
      url: safeDiagnosticUrl(ws.url()),
      closed: false,
      errors: [],
    };
    diagnostics.websockets.push(entry);
    ws.on("socketerror", (error) => {
      entry.errors.push(String(error));
    });
    ws.on("close", () => {
      entry.closed = true;
    });
  });
}

function assertCleanDiagnostics(diagnostics) {
  const badConsole = diagnostics.console.filter((entry) =>
    /waiting for widget|loading widget|OutputResolutionError|Failed to fetch blob|flush_comms_doc_sync/i.test(
      entry,
    ),
  );
  if (diagnostics.pageErrors.length > 0) {
    throw new Error(`browser page errors:\n${diagnostics.pageErrors.join("\n")}`);
  }
  if (badConsole.length > 0) {
    throw new Error(`browser widget console errors:\n${badConsole.join("\n")}`);
  }
  if (diagnostics.requestFailures.length > 0) {
    throw new Error(
      `browser request failures:\n${JSON.stringify(diagnostics.requestFailures, null, 2)}`,
    );
  }
}

async function readOidcTokenStorageJson(filePath) {
  const raw = await readFile(filePath, "utf8");
  const token = JSON.parse(raw);
  if (typeof token.accessToken !== "string" || token.accessToken.length === 0) {
    throw new Error(`${filePath} is missing accessToken`);
  }
  if (!token.claims || typeof token.claims.sub !== "string" || token.claims.sub.length === 0) {
    throw new Error(`${filePath} is missing claims.sub`);
  }
  return JSON.stringify(token);
}

async function runJsonScript(label, script, args, env) {
  const result = await runProcess(process.execPath, [script, ...args], { cwd: appDir, env });
  if (result.exitCode !== 0) {
    throw new Error(
      `${label} smoke failed with exit code ${result.exitCode}\nSTDERR:\n${result.stderr}\nSTDOUT:\n${result.stdout}`,
    );
  }
  return parseJsonOutput(result.stdout, label);
}

function runProcess(command, args, options) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      stderr += `${error.stack ?? error.message}\n`;
      resolve({ exitCode: 1, stdout, stderr });
    });
    child.on("close", (code) => {
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

function parseJsonOutput(stdout, label) {
  const trimmed = stdout.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        // Fall through to the clearer diagnostic below.
      }
    }
  }
  throw new Error(`${label} smoke did not emit parseable JSON:\n${trimmed}`);
}

async function stopProcess(pid) {
  if (!(await processExists(pid))) {
    return;
  }
  signalProcess(pid, "SIGTERM");
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (!(await processExists(pid))) {
      return;
    }
    await sleep(100);
  }
  if (await processExists(pid)) {
    signalProcess(pid, "SIGKILL");
  }
}

async function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signalProcess(pid, signal) {
  try {
    process.kill(pid, signal);
  } catch {
    // The peer may exit between existence checks and signal delivery.
  }
}

function parsePositiveInteger(value, name, fallback) {
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function safeDiagnosticUrl(value) {
  try {
    const url = new URL(value);
    url.searchParams.delete("viewer_session");
    return url.href;
  } catch {
    return value;
  }
}

function isBenignPageError(text) {
  return /message channel closed before a response was received|Receiving end does not exist|runtime\.lastError/i.test(
    text,
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stringify(value) {
  return JSON.stringify(value, null, 2);
}

function isMainModule() {
  return process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
}
