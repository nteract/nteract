import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { chromium } from "@playwright/test";

import {
  buildWorkstationAuthHeaders,
  DEFAULT_WORKSTATION_AUTH_KIND,
  normalizeWorkstationAuthKind,
  parseHttpResponseBody,
} from "./hosted-workstation-agent-core.mjs";
import {
  saveSmokeScreenshot,
  smokeJsonReportPath,
  smokeOutputPath,
  writeSmokeJsonReport,
} from "./smoke-paths.mjs";

const smokePhaseTimings = [];

if (isMainModule()) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

async function main() {
  await loadOptionalEnvFile();

  const baseUrl = process.env.NTERACT_CLOUD_URL ?? "https://preview.runt.run";
  const authKind = normalizeWorkstationAuthKind(
    process.env.NOTEBOOK_CLOUD_WORKSTATION_TOOLBAR_SMOKE_AUTH_KIND ??
      process.env.NOTEBOOK_CLOUD_WORKSTATION_AUTH_KIND ??
      process.env.NTERACT_CLOUD_AUTH_KIND ??
      DEFAULT_WORKSTATION_AUTH_KIND,
  );
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
  const runOutputProbes = parseBoolean(
    process.env.NOTEBOOK_CLOUD_WORKSTATION_TOOLBAR_SMOKE_OUTPUT_PROBES,
    false,
  );
  const title =
    process.env.NOTEBOOK_CLOUD_WORKSTATION_TOOLBAR_SMOKE_TITLE ??
    `Toolbar attach smoke ${new Date().toISOString()}`;
  const vanityName =
    process.env.NOTEBOOK_CLOUD_WORKSTATION_TOOLBAR_SMOKE_VANITY ?? "toolbar-attach-smoke";
  const screenshotPath = smokeOutputPath(
    process.env.NOTEBOOK_CLOUD_WORKSTATION_TOOLBAR_SMOKE_SCREENSHOT,
  );
  const reportPath = smokeJsonReportPath("hosted-workstation-toolbar-smoke");

  const tokenStorageJson = await readOidcTokenStorageJson(tokenPath);
  const token = JSON.parse(tokenStorageJson);
  const cloudCredential =
    authKind === "oidc"
      ? token.accessToken
      : (process.env.NTERACT_API_KEY ?? process.env.NOTEBOOK_CLOUD_PUBLISH_BEARER_TOKEN);
  if (!cloudCredential) {
    throw new Error(
      "NTERACT_API_KEY or NOTEBOOK_CLOUD_PUBLISH_BEARER_TOKEN is required for hosted workstation toolbar smoke",
    );
  }
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
    authKind,
    credential: cloudCredential,
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

  const workstationWasDefault = workstationList.default_workstation_id === workstationId;
  if (!workstationWasDefault) {
    await fetchJson({
      baseUrl,
      body: { workstation_id: workstationId },
      label: "set default workstation",
      method: "PATCH",
      pathname: "/api/workstations/default",
      authKind,
      credential: cloudCredential,
    });
  }
  const created = await fetchJson({
    baseUrl,
    body: { title, vanity_name: vanityName },
    expectedStatuses: [201],
    label: "create notebook",
    method: "POST",
    pathname: "/api/n",
    authKind,
    credential: cloudCredential,
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
    workstationDisplayName: scalarString(workstation.display_name) ?? workstationId,
    workstationId,
    runOutputProbes,
  });
  const report = {
    ok: true,
    baseUrl,
    authKind,
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
      wasDefaultBeforeSmoke: workstationWasDefault,
      status: scalarString(workstation.status),
    },
    phaseTimings: smokePhaseTimings,
    checks: [
      "workstation_registered_online",
      workstationWasDefault
        ? "default_workstation_already_selected"
        : "default_workstation_selected",
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
  workstationDisplayName,
  workstationId,
  runOutputProbes,
}) {
  const url = new URL(viewerUrl);
  const browser = await chromium.launch({ headless: true });
  try {
    const blockedRuns = await assertOwnerBlockedWorkstationStates({
      browser,
      timeoutMs,
      tokenStorageJson,
      url,
      workstationId,
    });

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
        workstationDisplayName,
        runOutputProbes,
      });
    } finally {
      await ownerContext.close().catch(() => {});
    }

    const viewModeControlCheck = await assertViewModeDoesNotExposeExecutionControls({
      browser,
      runMarker,
      timeoutMs,
      tokenStorageJson,
      url,
    });

    return {
      ...ownerRun,
      checks: [
        "oidc_token_seeded_in_browser_storage",
        "toolbar_start_compute_rendered",
        "toolbar_start_compute_clicked",
        "execute_button_rendered_after_compute_start",
        "cell_output_observed_after_execute",
        ...(runOutputProbes
          ? ["error_output_probe_observed", "display_update_output_probe_observed"]
          : []),
        "restart_button_clicked",
        "cell_output_observed_after_restart",
        "restart_run_all_button_clicked",
        "all_cell_outputs_observed_after_restart_run_all",
        "page_reload_preserved_output",
        "cell_output_observed_after_reload_execute",
        "owner_no_workstations_shows_setup_action",
        "owner_offline_default_workstation_shows_review_action",
        "owner_missing_working_directory_explains_blocked_launch",
        "owner_missing_environment_explains_blocked_launch",
        "view_mode_hides_execution_controls",
        "view_mode_hides_workstation_setup_action",
      ],
      blockedRuns,
      scopedControlChecks: [viewModeControlCheck],
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
  workstationDisplayName,
  runOutputProbes,
}) {
  const page = await context.newPage();
  const events = collectBrowserDiagnostics(page);
  await openNotebookShell(page, url.href, timeoutMs);
  await enterEditMode(page, timeoutMs);
  const cell = await ensureCodeCell(page, timeoutMs);
  await setCellSource(cell, source);

  await waitForToolbarAction(page, "Start compute", timeoutMs);
  const action = await readToolbarWorkstationAction(page);
  assertToolbarWorkstationAction(action, {
    context: "owner attach",
    label: "Start compute",
    titleIncludes: [workstationDisplayName],
  });
  await page.getByTestId("workstation-setup-button").click({ timeout: timeoutMs });

  await executeAndWaitForMarker(page, cell, runMarker, timeoutMs);
  const afterFirstRunKernelStatus = await readKernelStatus(page);
  assertKernelStatusNotInitializing(afterFirstRunKernelStatus, "after first execution");
  const afterFirstRunAria = await cell.getByTestId("execute-button").getAttribute("aria-label");

  const restartMarker = `${runMarker} after restart`;
  await restartComputeAndWait(page, timeoutMs);
  await setCellSource(cell, `print(${JSON.stringify(restartMarker)})`);
  await executeAndWaitForMarker(page, cell, restartMarker, timeoutMs, {
    requireOrdinalAdvance: false,
  });
  const afterRestartKernelStatus = await readKernelStatus(page);
  assertKernelStatusNotInitializing(afterRestartKernelStatus, "after restart execution");

  const restartRunAllMarkers = [`${runMarker} restart run all 1`, `${runMarker} restart run all 2`];
  const secondCell = await ensureCodeCellCount(page, 2, timeoutMs).then((cells) => cells.nth(1));
  await setCellSource(cell, `print(${JSON.stringify(restartRunAllMarkers[0])})`);
  await setCellSource(secondCell, `print(${JSON.stringify(restartRunAllMarkers[1])})`);
  await restartAndRunAllAndWait(page, restartRunAllMarkers, timeoutMs);
  const afterRestartRunAllKernelStatus = await readKernelStatus(page);
  assertKernelStatusNotInitializing(
    afterRestartRunAllKernelStatus,
    "after restart-and-run-all execution",
  );

  await page.reload({ waitUntil: "domcontentloaded", timeout: timeoutMs });
  await waitForNotebookReady(page, timeoutMs);
  await waitForText(page, restartRunAllMarkers[1], timeoutMs);
  await enterEditMode(page, timeoutMs);
  const reloadedCell = page.locator('[data-cell-type="code"]').first();
  await reloadedCell.waitFor({ state: "visible", timeout: timeoutMs });
  const beforeReloadRunAria = await readExecuteButtonAria(
    reloadedCell,
    "read reloaded execute button state",
    timeoutMs,
  );
  await executeAndWaitForMarker(page, reloadedCell, runMarker, timeoutMs);
  const afterReloadRunAria = await readExecuteButtonAria(
    reloadedCell,
    "read post-reload execute button state",
    timeoutMs,
  );
  const afterReloadKernelStatus = await readKernelStatus(page);
  assertKernelStatusNotInitializing(afterReloadKernelStatus, "after reload execution");
  const outputProbes = runOutputProbes
    ? await runOutputTimingProbes(page, runMarker, timeoutMs)
    : null;

  if (screenshotPath) {
    await saveSmokeScreenshot(page, screenshotPath);
  }
  assertCleanBrowserDiagnostics(events);
  return {
    action,
    afterFirstRunKernelStatus,
    afterFirstRunAria,
    afterRestartKernelStatus,
    afterRestartRunAllKernelStatus,
    afterReloadKernelStatus,
    afterReloadRunAria,
    beforeReloadRunAria,
    events,
    outputProbes,
    restartMarker,
    restartRunAllMarkers,
    screenshotPath: screenshotPath ?? null,
  };
}

async function runOutputTimingProbes(page, runMarker, timeoutMs) {
  const probeBase = `${runMarker} output probe`;
  const errorMarker = `${probeBase} error complete`;
  const displayMarker = `${probeBase} display update complete`;
  const cells = await ensureCodeCellCount(page, 4, timeoutMs);
  const errorCell = cells.nth(2);
  const displayCell = cells.nth(3);

  await setCellSource(
    errorCell,
    [
      "raise RuntimeError(",
      `  ${JSON.stringify(errorMarker.slice(0, Math.ceil(errorMarker.length / 2)))} +`,
      `  ${JSON.stringify(errorMarker.slice(Math.ceil(errorMarker.length / 2)))}`,
      ")",
    ].join("\n"),
  );
  await executeAndWaitForMarker(page, errorCell, errorMarker, timeoutMs);
  const afterErrorKernelStatus = await readKernelStatus(page);
  assertKernelStatusNotInitializing(afterErrorKernelStatus, "after error output probe");

  await setCellSource(
    displayCell,
    [
      "from IPython.display import display, update_display",
      "display('display probe starting', display_id='nteract_latency_probe')",
      "for index in range(4):",
      "    update_display(f'display probe update {index}', display_id='nteract_latency_probe')",
      `update_display(${JSON.stringify(
        displayMarker.slice(0, Math.ceil(displayMarker.length / 2)),
      )} + ${JSON.stringify(
        displayMarker.slice(Math.ceil(displayMarker.length / 2)),
      )}, display_id='nteract_latency_probe')`,
    ].join("\n"),
  );
  await executeAndWaitForMarkerEverywhere(page, displayCell, displayMarker, timeoutMs);
  const afterDisplayKernelStatus = await readKernelStatus(page);
  assertKernelStatusNotInitializing(afterDisplayKernelStatus, "after display-update output probe");

  return {
    afterDisplayKernelStatus,
    afterErrorKernelStatus,
    displayMarker,
    errorMarker,
  };
}

async function readKernelStatus(page) {
  return page.evaluate(() => {
    const status = document.querySelector('[data-testid="kernel-status"]');
    if (!status) return null;
    return {
      ariaLabel: status.getAttribute("aria-label"),
      label: status.textContent?.trim() ?? "",
      state: status.getAttribute("data-kernel-status"),
      title: status.getAttribute("title"),
    };
  });
}

function assertKernelStatusNotInitializing(status, context) {
  if (!status) {
    throw new Error(`${context} expected a visible kernel status after hosted execution`);
  }
  if (status.state === "not_started" || /initializing/i.test(status.label)) {
    throw new Error(
      `${context} left hosted kernel status initializing after execution: ${JSON.stringify(
        status,
      )}`,
    );
  }
}

async function assertOwnerBlockedWorkstationStates({
  browser,
  timeoutMs,
  tokenStorageJson,
  url,
  workstationId,
}) {
  const noWorkstations = await assertOwnerToolbarActionWithMockedWorkstations({
    browser,
    expectedLabel: "Set up compute",
    expectedPanelText: "No workstation registered",
    expectedTitleIncludes: ["Open workstations panel"],
    registry: {
      default_workstation_id: null,
      workstations: [],
    },
    scenario: "no_registered_workstations",
    timeoutMs,
    tokenStorageJson,
    url,
  });
  const offlineDefault = await assertOwnerToolbarActionWithMockedWorkstations({
    browser,
    expectedLabel: "Review compute",
    expectedPanelText: "No heartbeat from this workstation recently.",
    expectedTitleIncludes: ["Open workstations panel"],
    registry: {
      default_workstation_id: workstationId,
      workstations: [
        {
          workstation_id: workstationId,
          display_name: "Offline workstation",
          provider: "runtime_peer",
          status: "offline",
          status_message: "No heartbeat from this workstation recently.",
          default_environment_label: "Current Python",
          environment_policy: "current_python",
          working_directory: "/home/ubuntu/project",
        },
      ],
    },
    scenario: "offline_default_workstation",
    timeoutMs,
    tokenStorageJson,
    url,
  });
  const missingWorkingDirectory = await assertOwnerToolbarActionWithMockedWorkstations({
    browser,
    expectedLabel: "Review compute",
    expectedPanelText:
      "This workstation does not have a working directory configured for notebook execution.",
    expectedTitleIncludes: ["Open workstations panel"],
    registry: {
      default_workstation_id: workstationId,
      workstations: [
        {
          workstation_id: workstationId,
          display_name: "Workstation without cwd",
          provider: "runtime_peer",
          status: "online",
          default_environment_label: "Current Python",
          environment_policy: "current_python",
        },
      ],
    },
    scenario: "missing_working_directory",
    timeoutMs,
    tokenStorageJson,
    url,
  });
  const missingEnvironment = await assertOwnerToolbarActionWithMockedWorkstations({
    browser,
    expectedLabel: "Review compute",
    expectedPanelText: "This workstation does not have a runnable default environment configured.",
    expectedTitleIncludes: ["Open workstations panel"],
    registry: {
      default_workstation_id: workstationId,
      workstations: [
        {
          workstation_id: workstationId,
          display_name: "Workstation without environment",
          provider: "runtime_peer",
          status: "online",
          working_directory: "/home/ubuntu/project",
        },
      ],
    },
    scenario: "missing_environment",
    timeoutMs,
    tokenStorageJson,
    url,
  });
  return [noWorkstations, offlineDefault, missingWorkingDirectory, missingEnvironment];
}

async function assertOwnerToolbarActionWithMockedWorkstations({
  browser,
  expectedLabel,
  expectedPanelText = null,
  expectedTitleIncludes,
  registry,
  scenario,
  timeoutMs,
  tokenStorageJson,
  url,
}) {
  const context = await authenticatedContext(browser, {
    origin: url.origin,
    scope: "owner",
    tokenStorageJson,
  });
  await context.route("**/api/workstations", (route) =>
    route.fulfill({
      body: JSON.stringify(registry),
      contentType: "application/json",
      status: 200,
    }),
  );
  try {
    const page = await context.newPage();
    const events = collectBrowserDiagnostics(page);
    await openNotebookShell(page, url.href, timeoutMs);
    await enterEditMode(page, timeoutMs);
    await waitForToolbarAction(page, expectedLabel, timeoutMs);
    const action = await readToolbarWorkstationAction(page);
    assertToolbarWorkstationAction(action, {
      context: scenario,
      label: expectedLabel,
      titleIncludes: expectedTitleIncludes,
    });
    const controls = await visibleControlSummary(page);
    assertNoExecutionControls(controls, scenario);
    if (controls.workstationSetupButtonCount !== 1) {
      throw new Error(
        `${scenario} expected one workstation setup/review action, saw ${controls.workstationSetupButtonCount}`,
      );
    }
    if (expectedPanelText) {
      await page.getByTestId("workstation-setup-button").click({ timeout: timeoutMs });
      await waitForText(page, expectedPanelText, timeoutMs);
    }
    assertCleanBrowserDiagnostics(events);
    return {
      action,
      controls,
      scenario,
    };
  } finally {
    await context.close().catch(() => {});
  }
}

async function assertViewModeDoesNotExposeExecutionControls({
  browser,
  runMarker,
  timeoutMs,
  tokenStorageJson,
  url,
}) {
  const context = await authenticatedContext(browser, {
    origin: url.origin,
    scope: "owner",
    tokenStorageJson,
  });
  try {
    const page = await context.newPage();
    const events = collectBrowserDiagnostics(page);
    await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await waitForNotebookSessionReady(page, timeoutMs);
    await waitForText(page, runMarker, timeoutMs);
    const controls = await visibleControlSummary(page);
    assertNoExecutionControls(controls, "view mode");
    if (controls.workstationSetupButtonCount > 0) {
      throw new Error("view mode unexpectedly exposed workstation setup controls");
    }
    assertCleanBrowserDiagnostics(events);
    return {
      controls,
      mode: "view",
    };
  } finally {
    await context.close().catch(() => {});
  }
}

async function authenticatedContext(browser, { origin, scope, tokenStorageJson }) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const token = JSON.parse(tokenStorageJson);
  const accessToken = typeof token.accessToken === "string" ? token.accessToken : null;
  if (!accessToken) {
    throw new Error("authenticated browser context requires an OIDC accessToken");
  }
  const sessionResponse = await context.request.post(new URL("/api/auth/session", origin).href, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
  });
  if (!sessionResponse.ok()) {
    throw new Error(
      `establish browser app session failed: ${sessionResponse.status()} ${await sessionResponse.text()}`,
    );
  }
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

async function enterEditMode(page, timeoutMs) {
  await smokePhase("enter edit mode", async () => {
    const modeGroup = page.getByRole("group", { name: "Notebook interaction mode" });
    await modeGroup.waitFor({ state: "visible", timeout: timeoutMs });
    const editButton = modeGroup.getByRole("button").nth(1);
    await editButton.click({ timeout: timeoutMs });
    await page.waitForFunction(
      () => {
        const group = document.querySelector('[data-slot="notebook-edit-mode-button"]');
        const buttons = group?.querySelectorAll("button") ?? [];
        return buttons[1]?.getAttribute("aria-pressed") === "true";
      },
      null,
      { timeout: timeoutMs },
    );
  });
}

async function smokePhase(label, operation) {
  const startedAt = Date.now();
  try {
    const result = await operation();
    smokePhaseTimings.push({
      elapsed_ms: Date.now() - startedAt,
      label,
      ok: true,
    });
    return result;
  } catch (error) {
    smokePhaseTimings.push({
      elapsed_ms: Date.now() - startedAt,
      label,
      ok: false,
    });
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label}: ${message}`);
  }
}

async function waitForPagePredicate(page, label, predicate, argument, timeout) {
  await smokePhase(label, async () => await page.waitForFunction(predicate, argument, { timeout }));
}

function textSample(text) {
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

async function visibleControlSummary(page) {
  return page.evaluate(() => ({
    executeButtonCount: document.querySelectorAll('[data-testid="execute-button"]').length,
    interruptButtonCount: document.querySelectorAll('[data-testid="interrupt-kernel-button"]')
      .length,
    restartButtonCount: document.querySelectorAll('[data-testid="restart-kernel-button"]').length,
    restartRunAllButtonCount: document.querySelectorAll('[data-testid="restart-run-all-button"]')
      .length,
    runAllButtonCount: document.querySelectorAll('[data-testid="run-all-button"]').length,
    startButtonCount: document.querySelectorAll('[data-testid="start-kernel-button"]').length,
    workstationSetupButtonCount: document.querySelectorAll(
      '[data-testid="workstation-setup-button"]',
    ).length,
  }));
}

function assertNoExecutionControls(controls, context) {
  const count =
    controls.executeButtonCount +
    controls.interruptButtonCount +
    controls.restartButtonCount +
    controls.restartRunAllButtonCount +
    controls.runAllButtonCount +
    controls.startButtonCount;
  if (count > 0) {
    throw new Error(
      `${context} unexpectedly exposed execution controls: ${JSON.stringify(controls)}`,
    );
  }
}

async function readToolbarWorkstationAction(page) {
  const button = page.getByTestId("workstation-setup-button");
  if ((await button.count()) === 0) return null;
  return {
    label: await button.getAttribute("aria-label"),
    title: await button.getAttribute("title"),
  };
}

export function assertToolbarWorkstationAction(
  action,
  { context = "workstation toolbar", label, titleIncludes = [] },
) {
  if (!action) {
    throw new Error(`${context} expected workstation toolbar action ${label}`);
  }
  if (action.label !== label) {
    throw new Error(
      `${context} expected workstation toolbar action ${label}, saw ${action.label ?? "null"}`,
    );
  }
  for (const expected of titleIncludes) {
    if (!action.title?.includes(expected)) {
      throw new Error(
        `${context} expected workstation toolbar title to include ${expected}, saw ${
          action.title ?? "null"
        }`,
      );
    }
  }
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
  await smokePhase("open notebook shell", async () => {
    await page.goto(href, { waitUntil: "domcontentloaded", timeout });
  });
  await waitForNotebookReady(page, timeout);
}

async function waitForNotebookReady(page, timeout) {
  await smokePhase("wait for notebook toolbar", async () => {
    await page.waitForSelector('[data-testid="notebook-toolbar"]', { timeout });
  });
  await waitForNotebookSessionReady(page, timeout);
}

async function waitForNotebookSessionReady(page, timeout) {
  await waitForPagePredicate(
    page,
    "wait for notebook document sync",
    () =>
      document.querySelector("[data-notebook-synced]")?.getAttribute("data-notebook-synced") ===
      "true",
    null,
    timeout,
  );
  await waitForPagePredicate(
    page,
    "wait for live session ready",
    () =>
      document.querySelector("[data-session-ready]")?.getAttribute("data-session-ready") === "true",
    null,
    Math.max(timeout, 120_000),
  );
}

async function ensureCodeCell(page, timeout) {
  return smokePhase("ensure code cell", async () => {
    if ((await page.locator('[data-cell-type="code"]').count()) === 0) {
      await page.getByTestId("add-code-cell-button").click({ timeout });
    }
    const cell = page.locator('[data-cell-type="code"]').first();
    await cell.waitFor({ state: "visible", timeout });
    return cell;
  });
}

async function ensureCodeCellCount(page, count, timeout) {
  return smokePhase(`ensure ${count} code cells`, async () => {
    const cells = page.locator('[data-cell-type="code"]');
    while ((await cells.count()) < count) {
      await page.getByTestId("add-code-cell-button").click({ timeout });
      await page.waitForFunction(
        (expected) => document.querySelectorAll('[data-cell-type="code"]').length >= expected,
        count,
        { timeout },
      );
    }
    return cells;
  });
}

async function setCellSource(cell, source) {
  await smokePhase("set cell source", async () => {
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
  });
}

async function waitForToolbarAction(page, label, timeout) {
  await waitForPagePredicate(
    page,
    `wait for workstation toolbar action ${label}`,
    (expected) =>
      document
        .querySelector('[data-testid="workstation-setup-button"]')
        ?.getAttribute("aria-label") === expected,
    label,
    timeout,
  );
}

async function executeAndWaitForMarker(
  page,
  cell,
  marker,
  timeout,
  { requireOrdinalAdvance = true } = {},
) {
  await waitForCanExecute(page, timeout);
  const executeButton = await visibleExecuteButton(cell, timeout);
  const beforeAria = await readExecuteButtonAria(cell, "read pre-execution button state", timeout);
  const beforeOrdinal = executionOrdinal(beforeAria);
  await smokePhase("click cell execute button", async () => {
    await executeButton.click({ timeout });
  });
  if (requireOrdinalAdvance) {
    await waitForExecutionOrdinalAdvance(page, beforeOrdinal, timeout);
  }
  await waitForText(page, marker, timeout);
}

async function executeAndWaitForMarkerEverywhere(
  page,
  cell,
  marker,
  timeout,
  { requireOrdinalAdvance = true } = {},
) {
  await waitForCanExecute(page, timeout);
  const executeButton = await visibleExecuteButton(cell, timeout);
  const beforeAria = await readExecuteButtonAria(cell, "read pre-execution button state", timeout);
  const beforeOrdinal = executionOrdinal(beforeAria);
  await smokePhase("click cell execute button", async () => {
    await executeButton.click({ timeout });
  });
  if (requireOrdinalAdvance) {
    await waitForExecutionOrdinalAdvance(page, beforeOrdinal, timeout);
  }
  await waitForTextEverywhere(page, marker, timeout);
}

async function restartComputeAndWait(page, timeout) {
  const restartButton = page.getByTestId("restart-kernel-button");
  await smokePhase("wait for restart button", async () => {
    await restartButton.waitFor({ state: "visible", timeout });
  });
  await smokePhase("click restart button", async () => {
    await restartButton.click({ timeout });
  });
  await waitForPagePredicate(
    page,
    "wait for hosted restart to leave ready state",
    () => {
      const shell = document.querySelector('[data-slot="notebook-document-shell"]');
      const kernelStatus = document.querySelector('[data-testid="kernel-status"]');
      return (
        shell?.getAttribute("data-can-execute") !== "true" ||
        kernelStatus?.getAttribute("data-kernel-status") !== "idle"
      );
    },
    null,
    Math.min(timeout, 10_000),
  ).catch(() => {
    // Fast replacements can move from ready to ready between browser polls. The
    // marker execution below is the durable assertion that the new runtime can
    // accept work.
  });
  await waitForCanExecute(page, timeout);
}

async function restartAndRunAllAndWait(page, markers, timeout) {
  const restartRunAllButton = page.getByTestId("restart-run-all-button");
  await smokePhase("wait for restart-and-run-all button", async () => {
    await restartRunAllButton.waitFor({ state: "visible", timeout });
  });
  await smokePhase("click restart-and-run-all button", async () => {
    await restartRunAllButton.click({ timeout });
  });
  await waitForPagePredicate(
    page,
    "wait for hosted restart-and-run-all to leave ready state",
    () => {
      const shell = document.querySelector('[data-slot="notebook-document-shell"]');
      const kernelStatus = document.querySelector('[data-testid="kernel-status"]');
      return (
        shell?.getAttribute("data-can-execute") !== "true" ||
        kernelStatus?.getAttribute("data-kernel-status") !== "idle"
      );
    },
    null,
    Math.min(timeout, 10_000),
  ).catch(() => {
    // Fast replacements can move from ready to ready between browser polls.
    // The marker outputs below prove the queued run-all survived the gap.
  });
  for (const marker of markers) {
    await waitForText(page, marker, timeout);
  }
  await waitForCanExecute(page, timeout);
}

async function visibleExecuteButton(cell, timeout) {
  const executeButton = cell.getByTestId("execute-button");
  await smokePhase("wait for cell execute button", async () => {
    await executeButton.waitFor({ state: "visible", timeout });
  });
  return executeButton;
}

async function readExecuteButtonAria(cell, label, timeout) {
  const executeButton = await visibleExecuteButton(cell, timeout);
  return smokePhase(label, async () => await executeButton.getAttribute("aria-label", { timeout }));
}

async function waitForCanExecute(page, timeout) {
  await waitForPagePredicate(
    page,
    "wait for shell can-execute",
    () =>
      document
        .querySelector('[data-slot="notebook-document-shell"]')
        ?.getAttribute("data-can-execute") === "true",
    null,
    timeout,
  );
}

async function waitForText(page, text, timeout) {
  await waitForPagePredicate(
    page,
    `wait for text ${JSON.stringify(textSample(text))}`,
    (expected) => (document.body.textContent ?? "").includes(expected),
    text,
    timeout,
  );
}

async function waitForTextEverywhere(page, text, timeout) {
  await smokePhase(
    `wait for text ${JSON.stringify(textSample(text))} in page or frames`,
    async () => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (await pageOrFrameTextIncludes(page, text)) {
          return;
        }
        await page.waitForTimeout(100);
      }
      throw new Error(`text was not found in page or frames: ${text}`);
    },
  );
}

async function pageOrFrameTextIncludes(page, text) {
  const bodyIncludes = await page
    .evaluate((expected) => (document.body.textContent ?? "").includes(expected), text)
    .catch(() => false);
  if (bodyIncludes) {
    return true;
  }
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) {
      continue;
    }
    const frameIncludes = await frame
      .locator("body")
      .textContent({ timeout: 100 })
      .then((value) => (value ?? "").includes(text))
      .catch(() => false);
    if (frameIncludes) {
      return true;
    }
  }
  return false;
}

async function waitForExecutionOrdinalAdvance(page, beforeOrdinal, timeout) {
  await waitForPagePredicate(
    page,
    "wait for execution count advance",
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
    timeout,
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
  authKind,
  credential,
}) {
  const requestInit = {
    headers: {
      ...buildWorkstationAuthHeaders(authKind, credential),
      "Content-Type": "application/json",
      "X-Scope": "owner",
    },
    method,
  };
  if (body) {
    requestInit.body = JSON.stringify(body);
  }

  const response = await fetch(new URL(pathname, baseUrl), requestInit);
  const payload = await parseHttpResponseBody(response);
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
  if (url.endsWith("/api/workstations") && failure === "net::ERR_ABORTED") return true;
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

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  return /^(1|true|yes|on)$/i.test(value);
}

function isMainModule() {
  return process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
}
