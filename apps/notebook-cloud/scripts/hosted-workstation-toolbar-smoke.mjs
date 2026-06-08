import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { chromium } from "@playwright/test";

import {
  saveSmokeScreenshot,
  smokeJsonReportPath,
  smokeOutputPath,
  writeSmokeJsonReport,
} from "./smoke-paths.mjs";

if (isMainModule()) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

async function main() {
  await loadOptionalEnvFile();

  const baseUrl = process.env.NTERACT_CLOUD_URL ?? "https://preview.runt.run";
  const apiKey = process.env.NTERACT_API_KEY ?? process.env.NOTEBOOK_CLOUD_PUBLISH_BEARER_TOKEN;
  const workstationId =
    process.env.NOTEBOOK_CLOUD_WORKSTATION_TOOLBAR_SMOKE_WORKSTATION_ID ??
    process.env.NOTEBOOK_CLOUD_WORKSTATION_ID ??
    "lab2";
  const tokenPath =
    process.env.NTERACT_PREVIEW_OIDC_TOKEN_PATH ??
    process.env.NOTEBOOK_CLOUD_OIDC_TOKEN_PATH ??
    path.join(os.homedir(), "token.preview.json");
  const timeoutMs = parsePositiveInteger(
    process.env.NOTEBOOK_CLOUD_WORKSTATION_TOOLBAR_SMOKE_TIMEOUT_MS,
    "NOTEBOOK_CLOUD_WORKSTATION_TOOLBAR_SMOKE_TIMEOUT_MS",
    60_000,
  );
  const runMarker =
    process.env.NOTEBOOK_CLOUD_WORKSTATION_TOOLBAR_SMOKE_MARKER ??
    `toolbar attach smoke ${new Date()
      .toISOString()
      .replace(/[-:.TZ]/g, "")
      .slice(0, 14)}`;
  const source =
    process.env.NOTEBOOK_CLOUD_WORKSTATION_TOOLBAR_SMOKE_CODE ??
    `print(${JSON.stringify(runMarker)})`;
  const title =
    process.env.NOTEBOOK_CLOUD_WORKSTATION_TOOLBAR_SMOKE_TITLE ??
    `Toolbar attach smoke ${new Date().toISOString()}`;
  const vanityName =
    process.env.NOTEBOOK_CLOUD_WORKSTATION_TOOLBAR_SMOKE_VANITY ?? "toolbar-attach-smoke";
  const screenshotPath = smokeOutputPath(
    process.env.NOTEBOOK_CLOUD_WORKSTATION_TOOLBAR_SMOKE_SCREENSHOT,
  );
  const reportPath = smokeJsonReportPath("hosted-workstation-toolbar-smoke");

  if (!apiKey) {
    throw new Error(
      "NTERACT_API_KEY or NOTEBOOK_CLOUD_PUBLISH_BEARER_TOKEN is required for hosted workstation toolbar smoke",
    );
  }

  const tokenStorageJson = await readOidcTokenStorageJson(tokenPath);
  const token = JSON.parse(tokenStorageJson);
  const tokenSecondsRemaining = Number(token.expiresAt) - Math.floor(Date.now() / 1000);
  if (!Number.isFinite(tokenSecondsRemaining) || tokenSecondsRemaining <= 60) {
    throw new Error(
      `${tokenPath} is expired or near expiry; refresh it before running the workstation toolbar smoke`,
    );
  }

  const workstationList = await fetchJson({
    baseUrl,
    label: "list workstations",
    pathname: "/api/workstations",
    token: apiKey,
  });
  const workstation = Array.isArray(workstationList.workstations)
    ? workstationList.workstations.find((item) => item?.workstation_id === workstationId)
    : null;
  if (!workstation) {
    throw new Error(
      `workstation ${workstationId} is not registered for this user; start the workstation agent first`,
    );
  }
  if (workstation.status !== "online") {
    throw new Error(`workstation ${workstationId} is not online; status=${workstation.status}`);
  }

  await fetchJson({
    baseUrl,
    body: { workstation_id: workstationId },
    label: "set default workstation",
    method: "PATCH",
    pathname: "/api/workstations/default",
    token: apiKey,
  });
  const created = await fetchJson({
    baseUrl,
    body: { title, vanity_name: vanityName },
    expectedStatuses: [201],
    label: "create notebook",
    method: "POST",
    pathname: "/api/n",
    token: apiKey,
  });
  const viewerUrl = scalarString(created.viewer_url);
  if (!viewerUrl) {
    throw new Error("create notebook response did not include viewer_url");
  }

  const browserResult = await runBrowserSmoke({
    runMarker,
    screenshotPath,
    source,
    timeoutMs,
    tokenStorageJson,
    viewerUrl,
    workstationId,
  });
  const report = {
    ok: true,
    baseUrl,
    notebookId: created.notebook_id,
    source,
    title,
    token: {
      path: tokenPath,
      secondsRemaining: tokenSecondsRemaining,
    },
    viewerUrl,
    workstation: {
      id: workstationId,
      displayName: scalarString(workstation.display_name),
      status: scalarString(workstation.status),
    },
    checks: [
      "workstation_registered_online",
      "default_workstation_selected",
      "notebook_created",
      ...browserResult.checks,
    ],
    browser: browserResult,
  };
  await writeSmokeJsonReport(report, reportPath);
  console.log(JSON.stringify(report, null, 2));
}

async function runBrowserSmoke({
  runMarker,
  screenshotPath,
  source,
  timeoutMs,
  tokenStorageJson,
  viewerUrl,
  workstationId,
}) {
  const url = new URL(viewerUrl);
  const browser = await chromium.launch({ headless: true });
  try {
    const ownerContext = await authenticatedContext(browser, {
      origin: url.origin,
      scope: "owner",
      tokenStorageJson,
    });
    let ownerRun;
    try {
      ownerRun = await runOwnerAttachAndExecuteSmoke({
        context: ownerContext,
        runMarker,
        screenshotPath,
        source,
        timeoutMs,
        url,
        workstationId,
      });
    } finally {
      await ownerContext.close().catch(() => {});
    }

    const scopedControlChecks = [];
    for (const scope of ["viewer", "editor"]) {
      scopedControlChecks.push(
        await assertScopeDoesNotExposeExecutionControls({
          browser,
          runMarker,
          scope,
          timeoutMs,
          tokenStorageJson,
          url,
        }),
      );
    }

    return {
      ...ownerRun,
      checks: [
        "oidc_token_seeded_in_browser_storage",
        "toolbar_attach_compute_rendered",
        "toolbar_attach_compute_clicked",
        "execute_button_rendered_after_attach",
        "cell_output_observed_after_execute",
        "page_reload_preserved_output",
        "cell_output_observed_after_reload_execute",
        "viewer_scope_hides_execution_controls",
        "viewer_scope_hides_workstation_setup_action",
        "editor_scope_hides_execution_controls_until_execute_capability_exists",
      ],
      scopedControlChecks,
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

async function runOwnerAttachAndExecuteSmoke({
  context,
  runMarker,
  screenshotPath,
  source,
  timeoutMs,
  url,
  workstationId,
}) {
  const page = await context.newPage();
  const events = collectBrowserDiagnostics(page);
  await openNotebookShell(page, url.href, timeoutMs);
  const cell = await ensureCodeCell(page, timeoutMs);
  await setCellSource(cell, source);

  await waitForToolbarAction(page, "Attach compute", timeoutMs);
  const action = {
    label: await page.getByTestId("workstation-setup-button").getAttribute("aria-label"),
    title: await page.getByTestId("workstation-setup-button").getAttribute("title"),
  };
  if (!action.title?.includes(workstationId) && !action.title?.includes("workstation")) {
    throw new Error(`unexpected workstation action title: ${action.title ?? "null"}`);
  }
  await page.getByTestId("workstation-setup-button").click({ timeout: timeoutMs });

  await executeAndWaitForMarker(page, cell, runMarker, timeoutMs);
  const afterFirstRunAria = await cell.getByTestId("execute-button").getAttribute("aria-label");

  await page.reload({ waitUntil: "domcontentloaded", timeout: timeoutMs });
  await waitForNotebookReady(page, timeoutMs);
  await waitForText(page, runMarker, timeoutMs);
  const reloadedCell = page.locator('[data-cell-type="code"]').first();
  await reloadedCell.waitFor({ state: "visible", timeout: timeoutMs });
  const beforeReloadRunAria = await reloadedCell
    .getByTestId("execute-button")
    .getAttribute("aria-label");
  await executeAndWaitForMarker(page, reloadedCell, runMarker, timeoutMs);
  const afterReloadRunAria = await reloadedCell
    .getByTestId("execute-button")
    .getAttribute("aria-label");

  if (screenshotPath) {
    await saveSmokeScreenshot(page, screenshotPath);
  }
  assertCleanBrowserDiagnostics(events);
  return {
    action,
    afterFirstRunAria,
    afterReloadRunAria,
    beforeReloadRunAria,
    events,
    screenshotPath: screenshotPath ?? null,
  };
}

async function assertScopeDoesNotExposeExecutionControls({
  browser,
  runMarker,
  scope,
  timeoutMs,
  tokenStorageJson,
  url,
}) {
  const context = await authenticatedContext(browser, {
    origin: url.origin,
    scope,
    tokenStorageJson,
  });
  try {
    const page = await context.newPage();
    const events = collectBrowserDiagnostics(page);
    await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await waitForNotebookSessionReady(page, timeoutMs);
    await waitForText(page, runMarker, timeoutMs);
    const controls = await visibleControlSummary(page);
    if (controls.executeButtonCount > 0 || controls.runAllButtonCount > 0) {
      throw new Error(`${scope} scope unexpectedly exposed execution controls`);
    }
    if (scope === "viewer" && controls.workstationSetupButtonCount > 0) {
      throw new Error("viewer scope unexpectedly exposed workstation setup controls");
    }
    assertCleanBrowserDiagnostics(events);
    return {
      controls,
      scope,
    };
  } finally {
    await context.close().catch(() => {});
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

async function visibleControlSummary(page) {
  return page.evaluate(() => ({
    executeButtonCount: document.querySelectorAll('[data-testid="execute-button"]').length,
    runAllButtonCount: document.querySelectorAll('[data-testid="run-all-button"]').length,
    workstationSetupButtonCount: document.querySelectorAll(
      '[data-testid="workstation-setup-button"]',
    ).length,
  }));
}

function collectBrowserDiagnostics(page) {
  const events = {
    badConsole: [],
    failedRequests: [],
    pageErrors: [],
  };
  page.on("pageerror", (error) => {
    const text = String(error.message ?? error);
    if (!isBenignPageError(text)) {
      events.pageErrors.push(text);
    }
  });
  page.on("console", (message) => {
    const text = message.text();
    if (
      /OutputResolutionError|Failed to fetch blob|duplicate seq|Unable to load notebook|cloud sync socket is closed|flush_comms_doc_sync|cannot execute|request origin is not allowed/i.test(
        text,
      )
    ) {
      events.badConsole.push(`${message.type()}: ${text}`);
    }
  });
  page.on("requestfailed", (request) => {
    const url = request.url();
    const failure = request.failure()?.errorText ?? null;
    if (isIgnorableRequestFailure(url, failure)) return;
    events.failedRequests.push({ failure, url: redactDiagnosticUrl(url) });
  });
  return events;
}

function assertCleanBrowserDiagnostics(events) {
  if (events.pageErrors.length > 0) {
    throw new Error(`browser page errors:\n${events.pageErrors.join("\n")}`);
  }
  if (events.badConsole.length > 0) {
    throw new Error(`browser console errors:\n${events.badConsole.join("\n")}`);
  }
  if (events.failedRequests.length > 0) {
    throw new Error(`browser request failures:\n${JSON.stringify(events.failedRequests, null, 2)}`);
  }
}

async function openNotebookShell(page, href, timeout) {
  await page.goto(href, { waitUntil: "domcontentloaded", timeout });
  await waitForNotebookReady(page, timeout);
}

async function waitForNotebookReady(page, timeout) {
  await page.waitForSelector('[data-testid="notebook-toolbar"]', { timeout });
  await waitForNotebookSessionReady(page, timeout);
}

async function waitForNotebookSessionReady(page, timeout) {
  await page.waitForFunction(
    () =>
      document.querySelector("[data-notebook-synced]")?.getAttribute("data-notebook-synced") ===
      "true",
    null,
    { timeout },
  );
  await page.waitForFunction(
    () =>
      document.querySelector("[data-session-ready]")?.getAttribute("data-session-ready") === "true",
    null,
    { timeout: Math.max(timeout, 120_000) },
  );
}

async function ensureCodeCell(page, timeout) {
  if ((await page.locator('[data-cell-type="code"]').count()) === 0) {
    await page.getByTestId("add-code-cell-button").click({ timeout });
  }
  const cell = page.locator('[data-cell-type="code"]').first();
  await cell.waitFor({ state: "visible", timeout });
  return cell;
}

async function setCellSource(cell, source) {
  await cell.locator('.cm-content[contenteditable="true"]').evaluate((node, text) => {
    const editor = node.cmTile?.view;
    if (!editor) throw new Error("No CodeMirror view found");
    editor.dispatch({
      changes: {
        from: 0,
        insert: text,
        to: editor.state.doc.length,
      },
      selection: { anchor: text.length },
    });
    editor.focus();
  }, source);
}

async function waitForToolbarAction(page, label, timeout) {
  await page.waitForFunction(
    (expected) =>
      document
        .querySelector('[data-testid="workstation-setup-button"]')
        ?.getAttribute("aria-label") === expected,
    label,
    { timeout },
  );
}

async function executeAndWaitForMarker(page, cell, marker, timeout) {
  const executeButton = cell.getByTestId("execute-button");
  await executeButton.waitFor({ state: "visible", timeout });
  const beforeAria = await executeButton.getAttribute("aria-label");
  const beforeOrdinal = executionOrdinal(beforeAria);
  await executeButton.click({ timeout });
  await waitForExecutionOrdinalAdvance(page, beforeOrdinal, timeout);
  await waitForText(page, marker, timeout);
}

async function waitForText(page, text, timeout) {
  await page.waitForFunction(
    (expected) => (document.body.textContent ?? "").includes(expected),
    text,
    {
      timeout,
    },
  );
}

async function waitForExecutionOrdinalAdvance(page, beforeOrdinal, timeout) {
  await page.waitForFunction(
    (previous) => {
      const ordinals = [...document.querySelectorAll('[data-testid="execute-button"]')]
        .map((button) => {
          const text = button.getAttribute("aria-label");
          const match = text?.match(/last execution (\d+)/i);
          return match ? Number(match[1]) : null;
        })
        .filter((value) => Number.isFinite(value));
      if (ordinals.length === 0) return false;
      return Math.max(...ordinals) > previous;
    },
    beforeOrdinal,
    { timeout },
  );
}

function executionOrdinal(text) {
  return executionOrdinalFromText(text) ?? 0;
}

function executionOrdinalFromText(text) {
  if (!text) return null;
  const match = text.match(/last execution (\d+)/i);
  return match ? Number(match[1]) : null;
}

async function fetchJson({
  baseUrl,
  body = null,
  expectedStatuses = [200],
  label,
  method = "GET",
  pathname,
  token,
}) {
  const requestInit = {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-Notebook-Cloud-Auth-Provider": "anaconda-api-key",
      "X-Scope": "owner",
    },
    method,
  };
  if (body) {
    requestInit.body = JSON.stringify(body);
  }

  const response = await fetch(new URL(pathname, baseUrl), requestInit);
  const payload = await response.json().catch(async () => ({ error: await response.text() }));
  if (!expectedStatuses.includes(response.status)) {
    throw new Error(`${label} failed: ${response.status} ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function loadOptionalEnvFile() {
  const envFile =
    process.env.PREVIEW_RUNT_ENV ??
    process.env.NOTEBOOK_CLOUD_ENV_FILE ??
    path.join(os.homedir(), "preview.runt.run", ".env");
  try {
    const raw = await readFile(envFile, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const match = trimmed.replace(/^export\s+/, "").match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!match) continue;
      const [, key, rawValue] = match;
      if (process.env[key]) continue;
      process.env[key] = rawValue.replace(/^["']|["']$/g, "").trim();
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

async function readOidcTokenStorageJson(tokenPath) {
  const raw = await readFile(tokenPath, "utf8");
  const token = JSON.parse(raw);
  if (typeof token.accessToken !== "string" || token.accessToken.length === 0) {
    throw new Error(`${tokenPath} is missing accessToken`);
  }
  if (!token.claims || typeof token.claims.sub !== "string" || token.claims.sub.length === 0) {
    throw new Error(`${tokenPath} is missing claims.sub`);
  }
  return JSON.stringify(token);
}

function isBenignPageError(text) {
  return /A listener indicated an asynchronous response by returning true/i.test(text);
}

export function isIgnorableRequestFailure(url, failure) {
  if (/cdn-cgi\/rum|favicon/.test(url)) return true;
  return /preview\.runtusercontent\.com\/frame\//.test(url) && failure === "net::ERR_ABORTED";
}

export function redactDiagnosticUrl(url) {
  return url.replace(/([?&](?:token|access_token|authorization)=)[^&]+/gi, "$1[redacted]");
}

function scalarString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parsePositiveInteger(value, label, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function isMainModule() {
  return process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
}
