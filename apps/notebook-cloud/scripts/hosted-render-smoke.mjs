import { mkdir } from "node:fs/promises";
import path from "node:path";

import { chromium } from "@playwright/test";

import { catalogExpectationFailures, summarizeCatalog } from "./hosted-render-smoke-catalog.mjs";
import {
  consoleMessageLevel,
  isolatedDiagnosticFailure,
  isFatalIsolatedDiagnostic,
  matchesSiftLoadMilestone,
  parseIsolatedDiagnosticText,
  siftLoadMilestoneTimingName,
} from "./hosted-render-smoke-diagnostics.mjs";
import {
  DEFAULT_PRIMARY_VIEWER_CSS_MAX_BYTES,
  checkViewerCssSplit,
  parsePositiveInteger,
} from "./hosted-render-smoke-assets.mjs";
import { hasPreflightFailures } from "./hosted-render-smoke-preflight.mjs";
import {
  applyResourceTimingSizes,
  classifyPerformanceResource,
  performanceBudgetFailures,
  refinePerformanceResourceKind,
  summarizePerformanceResources,
  summarizeViewerMilestones,
  withTiming,
} from "./hosted-render-smoke-performance.mjs";
import { checkRuntimeWasmHints } from "./hosted-render-smoke-runtime-wasm.mjs";
import { catalogApiUrlForViewer, isRenderCacheApiUrl } from "./hosted-render-smoke-routes.mjs";

const DEFAULT_URL = "https://preview.runt.run/n/topic-viz/topic-viz";
const DEFAULT_RENDERER_ASSET_ORIGIN = "https://nteract-notebook-cloud-assets.rgbkrk.workers.dev";
const DEFAULT_OUTPUT_DOCUMENT_ORIGIN = "https://preview.runtusercontent.com";
const DEFAULT_CATALOG_OWNER_PRINCIPAL = "user:anaconda:fe0f6c3a-f7c7-4c04-9b8d-77e596da1375";
const DEFAULT_LATEST_REVISION_ACTOR_LABEL =
  "user:anaconda:fdb3dc7d-c369-4a39-bf7d-e35b77a0bdd0/agent:runt-publish";

const targetUrl = process.argv[2] ?? process.env.NOTEBOOK_CLOUD_HOSTED_URL ?? DEFAULT_URL;
const expectedRendererAssetOrigin =
  process.env.NOTEBOOK_CLOUD_EXPECTED_RENDERER_ASSET_ORIGIN ?? DEFAULT_RENDERER_ASSET_ORIGIN;
const expectedOutputDocumentOrigin =
  process.env.NOTEBOOK_CLOUD_EXPECTED_OUTPUT_DOCUMENT_ORIGIN ?? DEFAULT_OUTPUT_DOCUMENT_ORIGIN;
const expectedSourceText =
  process.env.NOTEBOOK_CLOUD_EXPECTED_SOURCE_TEXT ?? "from datasets import load_dataset";
const expectedExecutionCount = process.env.NOTEBOOK_CLOUD_EXPECTED_EXECUTION_COUNT ?? null;
const requireRenderedCellMarker = process.env.NOTEBOOK_CLOUD_REQUIRE_RENDERED_CELL_MARKER !== "0";
const expectedPresenceText = process.env.NOTEBOOK_CLOUD_EXPECTED_PRESENCE_TEXT ?? "here now";
const expectedPageTexts = parseExpectedTexts("NOTEBOOK_CLOUD_EXPECTED_PAGE_TEXTS", []);
const expectedFrameTexts = parseExpectedTexts("NOTEBOOK_CLOUD_EXPECTED_FRAME_TEXTS", [
  "MathNet topic visualization",
  "Loading the slice",
  "Schema at a glance",
  "PROBLEM_MARKDOWN",
]);
const expectedCatalogOwnerPrincipal =
  process.env.NOTEBOOK_CLOUD_EXPECTED_CATALOG_OWNER_PRINCIPAL ?? DEFAULT_CATALOG_OWNER_PRINCIPAL;
const expectedLatestRevisionActorLabel =
  process.env.NOTEBOOK_CLOUD_EXPECTED_LATEST_REVISION_ACTOR_LABEL ??
  DEFAULT_LATEST_REVISION_ACTOR_LABEL;
const expectedLatestRevisionNotebookHeadsHash =
  process.env.NOTEBOOK_CLOUD_EXPECTED_LATEST_REVISION_NOTEBOOK_HEADS_HASH ?? "";
const expectedLatestRevisionRuntimeHeadsHash =
  process.env.NOTEBOOK_CLOUD_EXPECTED_LATEST_REVISION_RUNTIME_HEADS_HASH ?? "";
const expectedLatestRevisionRuntimeStateDocId =
  process.env.NOTEBOOK_CLOUD_EXPECTED_LATEST_REVISION_RUNTIME_STATE_DOC_ID ?? "";
const requireLatestRevisionRuntimeStateDocId =
  process.env.NOTEBOOK_CLOUD_REQUIRE_LATEST_REVISION_RUNTIME_STATE_DOC_ID !== "0";
const requireSiftWasm = process.env.NOTEBOOK_CLOUD_REQUIRE_SIFT_WASM !== "0";
const expectedSiftLoadMilestones = parseExpectedTexts(
  "NOTEBOOK_CLOUD_EXPECTED_SIFT_LOAD_MILESTONES",
  requireSiftWasm ? ["first-chunk-fetched", "engine-mounted", "streaming-complete"] : [],
);
const requireRuntimedWasm = process.env.NOTEBOOK_CLOUD_REQUIRE_RUNTIMED_WASM !== "0";
const requireViewerCssSplit = process.env.NOTEBOOK_CLOUD_REQUIRE_VIEWER_CSS_SPLIT !== "0";
const forbidRenderCacheRequests = process.env.NOTEBOOK_CLOUD_FORBID_RENDER_CACHE_REQUESTS !== "0";
const maxPrimaryViewerCssBytes = parsePositiveInteger(
  process.env.NOTEBOOK_CLOUD_MAX_PRIMARY_VIEWER_CSS_BYTES,
  DEFAULT_PRIMARY_VIEWER_CSS_MAX_BYTES,
  "NOTEBOOK_CLOUD_MAX_PRIMARY_VIEWER_CSS_BYTES",
);
const minSupplementalViewerCssCount = parsePositiveInteger(
  process.env.NOTEBOOK_CLOUD_MIN_SUPPLEMENTAL_VIEWER_CSS_COUNT,
  1,
  "NOTEBOOK_CLOUD_MIN_SUPPLEMENTAL_VIEWER_CSS_COUNT",
);
const performanceBudgets = {
  first_useful_render_ms: parseOptionalBudget("NOTEBOOK_CLOUD_MAX_FIRST_USEFUL_RENDER_MS"),
  live_sync_websocket_ms: parseOptionalBudget("NOTEBOOK_CLOUD_MAX_LIVE_SYNC_WEBSOCKET_MS"),
  source_text_ms: parseOptionalBudget("NOTEBOOK_CLOUD_MAX_SOURCE_TEXT_MS"),
  rendered_cell_marker_ms: parseOptionalBudget("NOTEBOOK_CLOUD_MAX_RENDERED_CELL_MARKER_MS"),
  first_output_iframe_ms: parseOptionalBudget("NOTEBOOK_CLOUD_MAX_FIRST_OUTPUT_IFRAME_MS"),
  frame_texts_ms: parseOptionalBudget("NOTEBOOK_CLOUD_MAX_FRAME_TEXTS_MS"),
  viewer_shell_complete_ms: parseOptionalBudget("NOTEBOOK_CLOUD_MAX_VIEWER_SHELL_COMPLETE_MS"),
  runtimed_wasm_complete_ms: parseOptionalBudget("NOTEBOOK_CLOUD_MAX_RUNTIMED_WASM_COMPLETE_MS"),
  isolated_renderer_complete_ms: parseOptionalBudget(
    "NOTEBOOK_CLOUD_MAX_ISOLATED_RENDERER_COMPLETE_MS",
  ),
  output_document_complete_ms: parseOptionalBudget(
    "NOTEBOOK_CLOUD_MAX_OUTPUT_DOCUMENT_COMPLETE_MS",
  ),
  sift_wasm_complete_ms: parseOptionalBudget("NOTEBOOK_CLOUD_MAX_SIFT_WASM_COMPLETE_MS"),
  arrow_data_complete_ms: parseOptionalBudget("NOTEBOOK_CLOUD_MAX_ARROW_DATA_COMPLETE_MS"),
  snapshot_pair_bytes: parseOptionalBudget("NOTEBOOK_CLOUD_MAX_SNAPSHOT_PAIR_BYTES"),
  viewer_shell_bytes: parseOptionalBudget("NOTEBOOK_CLOUD_MAX_VIEWER_SHELL_BYTES"),
  runtimed_wasm_bytes: parseOptionalBudget("NOTEBOOK_CLOUD_MAX_RUNTIMED_WASM_BYTES"),
  isolated_renderer_bytes: parseOptionalBudget("NOTEBOOK_CLOUD_MAX_ISOLATED_RENDERER_BYTES"),
  output_document_bytes: parseOptionalBudget("NOTEBOOK_CLOUD_MAX_OUTPUT_DOCUMENT_BYTES"),
  sift_wasm_bytes: parseOptionalBudget("NOTEBOOK_CLOUD_MAX_SIFT_WASM_BYTES"),
  arrow_data_bytes: parseOptionalBudget("NOTEBOOK_CLOUD_MAX_ARROW_DATA_BYTES"),
};
const expectedThemeModes = parseExpectedTexts("NOTEBOOK_CLOUD_SMOKE_THEME_MODES", [
  "light",
  "dark",
  "system-dark",
]);
const screenshotPath = process.env.NOTEBOOK_CLOUD_SMOKE_SCREENSHOT;
const timeoutMs = Number(process.env.NOTEBOOK_CLOUD_SMOKE_TIMEOUT_MS ?? 60_000);
const targetOrigin = new URL(targetUrl).origin;
const rendererAssetOrigin = expectedRendererAssetOrigin
  ? new URL(expectedRendererAssetOrigin).origin
  : null;
const outputDocumentOrigin = expectedOutputDocumentOrigin
  ? new URL(expectedOutputDocumentOrigin).origin
  : null;

const failures = [];
const warnings = [];
const siftWasmRequests = [];
const runtimedWasmRequests = [];
const rendererCompletions = [];
const fatalIsolatedDiagnostics = [];
const siftDiagnostics = [];
const diagnosticTasks = [];
const performanceResources = [];
const performanceRequests = new Map();
const renderCacheRequests = [];
let catalogApiCheck = null;
let viewerCssCheck = null;
let runtimeWasmHintCheck = null;
let screenshotSaved = false;
let pageTextMatches = {};
let viewerMilestones = {};
let themeModeChecks = [];
const siftLoadMilestoneMatches = {};
const smokeStartedAt = performance.now();
const timingsMs = {};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main() {
  const browser = await chromium.launch({
    headless: process.env.NOTEBOOK_CLOUD_HEADED !== "1",
    timeout: timeoutMs,
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1200 },
    deviceScaleFactor: 1,
  });

  page.on("console", (message) => {
    const text = message.text();
    const parsedDiagnostic = parseIsolatedDiagnosticText(text);
    if (parsedDiagnostic) {
      captureIsolatedDiagnostic(message, parsedDiagnostic);
      if (message.type() === "error") {
        return;
      }
    }
    if (message.type() === "error" && !isBenignConsoleError(text)) {
      failures.push({ kind: "console-error", text });
      return;
    }
    if (message.type() === "warning") {
      warnings.push(text);
    }
    if (text.includes("render-complete") || text.includes("rendered-after-paint")) {
      rendererCompletions.push(text);
    }
  });

  page.on("pageerror", (error) => {
    failures.push({ kind: "page-error", text: error.message });
  });

  page.on("requestfailed", (request) => {
    finishPerformanceRequest(request, {
      failure: request.failure()?.errorText ?? "unknown",
    });
    if (!isRelevantRequestUrl(request.url())) {
      return;
    }
    failures.push({
      kind: "request-failed",
      url: request.url(),
      error: request.failure()?.errorText ?? "unknown",
    });
  });

  page.on("request", (request) => {
    if (forbidRenderCacheRequests && isRenderCacheApiUrl(request.url())) {
      renderCacheRequests.push({
        method: request.method(),
        url: request.url(),
      });
    }
    const kind = classifyPerformanceResource(request.url(), {
      targetOrigin,
      rendererAssetOrigin,
      outputDocumentOrigin,
    });
    if (!kind) {
      return;
    }
    performanceRequests.set(request, {
      kind,
      url: request.url(),
      start_ms: elapsedMs(),
      end_ms: null,
      status: null,
      contentType: null,
      contentLength: null,
      failure: null,
    });
  });

  page.on("response", (response) => {
    const url = response.url();
    finishPerformanceRequest(response.request(), {
      status: response.status(),
      contentType: response.headers()["content-type"] ?? null,
      contentLength: parseContentLength(response.headers()["content-length"]),
    });
    if (url.includes("sift_wasm.wasm")) {
      siftWasmRequests.push({
        url,
        status: response.status(),
        cors: response.headers()["access-control-allow-origin"] ?? null,
        contentType: response.headers()["content-type"] ?? null,
      });
    }
    if (url.includes("runtimed_wasm")) {
      runtimedWasmRequests.push({
        url,
        status: response.status(),
        cors: response.headers()["access-control-allow-origin"] ?? null,
        contentType: response.headers()["content-type"] ?? null,
      });
    }
  });

  page.on("websocket", (socket) => {
    if (socket.url().includes("/sync?")) {
      markTiming("live_sync_websocket");
    }
  });

  try {
    if (
      expectedCatalogOwnerPrincipal ||
      expectedLatestRevisionActorLabel ||
      expectedLatestRevisionNotebookHeadsHash ||
      expectedLatestRevisionRuntimeHeadsHash ||
      expectedLatestRevisionRuntimeStateDocId ||
      requireLatestRevisionRuntimeStateDocId
    ) {
      const started = elapsedMs();
      catalogApiCheck = await checkHostedCatalogApi(targetUrl, {
        expectedCatalogOwnerPrincipal,
        expectedLatestRevisionActorLabel,
        expectedLatestRevisionNotebookHeadsHash,
        expectedLatestRevisionRuntimeHeadsHash,
        expectedLatestRevisionRuntimeStateDocId,
        requireLatestRevisionRuntimeStateDocId,
      });
      catalogApiCheck = withTiming(catalogApiCheck, started, elapsedMs());
    }
    if (requireViewerCssSplit) {
      const started = elapsedMs();
      viewerCssCheck = await checkViewerCssSplit(targetUrl, {
        maxPrimaryBytes: maxPrimaryViewerCssBytes,
        minSupplementalCount: minSupplementalViewerCssCount,
      });
      viewerCssCheck = withTiming(viewerCssCheck, started, elapsedMs());
      failures.push(...viewerCssCheck.failures);
    }
    markTiming("preflight");
    if (hasPreflightFailures(failures)) {
      throw new SmokeFailure(failures);
    }

    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    markTiming("domcontentloaded");
    runtimeWasmHintCheck = checkRuntimeWasmHints(await collectRuntimeWasmHints(page), {
      expectedRendererAssetOrigin,
      requireHints: requireRuntimedWasm,
    });
    failures.push(...runtimeWasmHintCheck.failures);
    markTiming("runtime_wasm_hints");
    const networkIdleTask = page
      .waitForLoadState("networkidle", { timeout: timeoutMs })
      .then(() => markTiming("networkidle"))
      .catch(() => markTiming("networkidle_timeout"));

    if (expectedSourceText) {
      await page.waitForFunction(
        (text) => document.body.innerText.includes(text),
        expectedSourceText,
        {
          timeout: timeoutMs,
        },
      );
      markTiming("source_text");
    }
    if (expectedPageTexts.length > 0) {
      pageTextMatches = await waitForPageText(page, expectedPageTexts);
      markTiming("page_texts");
    }
    if (requireRenderedCellMarker || expectedExecutionCount) {
      await page.waitForFunction(
        (expected) => {
          const sharedCellCount = document.querySelectorAll(
            "[data-slot='cell-container'], [data-cell-id]",
          ).length;
          const counts = Array.from(document.querySelectorAll("[data-slot='execution-count']")).map(
            (node) => node.getAttribute("data-execution-count") ?? node.textContent?.trim() ?? "",
          );
          if (expected) {
            return counts.includes(expected);
          }
          return sharedCellCount > 0 || counts.some((count) => /^\d+$/.test(count));
        },
        expectedExecutionCount,
        { timeout: timeoutMs },
      );
      markTiming("rendered_cell_marker");
    }
    if (expectedPresenceText) {
      await page.waitForFunction(
        (expected) =>
          document
            .querySelector("[data-slot='notebook-presence-status']")
            ?.textContent?.includes(expected),
        expectedPresenceText,
        { timeout: timeoutMs },
      );
      markTiming("presence");
    }
    if (expectedFrameTexts.length > 0) {
      await page.waitForFunction(
        () =>
          Array.from(document.querySelectorAll("iframe[sandbox]")).some(
            (iframe) => iframe.clientWidth > 0 && iframe.clientHeight > 0,
          ),
        undefined,
        { timeout: timeoutMs },
      );
      markTiming("first_output_iframe");
    }
    const siftLoadMilestoneTask = Promise.all(
      expectedSiftLoadMilestones.map((milestone) =>
        waitForSiftLoadMilestone(page, milestone).then((diagnostic) => {
          siftLoadMilestoneMatches[milestone] = {
            observed_ms: diagnostic.observedAtMs,
            renderer_elapsed_ms:
              typeof diagnostic.details?.elapsedMs === "number"
                ? diagnostic.details.elapsedMs
                : null,
            row_count:
              typeof diagnostic.details?.rowCount === "number" ? diagnostic.details.rowCount : null,
            chunk_count:
              typeof diagnostic.details?.chunkCount === "number"
                ? diagnostic.details.chunkCount
                : null,
          };
          markTimingAt(siftLoadMilestoneTimingName(milestone), diagnostic.observedAtMs);
          return diagnostic;
        }),
      ),
    ).catch((error) => ({ error }));
    const frameTextMatches =
      expectedFrameTexts.length > 0 ? await waitForFrameText(page, expectedFrameTexts) : {};
    if (expectedFrameTexts.length > 0) {
      markTiming("frame_texts");
    }
    const siftLoadMilestoneResult = await siftLoadMilestoneTask;
    if ("error" in siftLoadMilestoneResult) {
      throw siftLoadMilestoneResult.error;
    }

    // Give async iframe plugin fetches a beat to surface late CORS or WASM failures.
    await page.waitForTimeout(750);
    await flushDiagnosticTasks();
    await Promise.race([networkIdleTask, Promise.resolve()]);
    markTiming("diagnostics_flushed");
    const browserResourceTimings = await collectBrowserResourceTimings(page);
    applyResourceTimingSizes(performanceResources, browserResourceTimings);

    const executionCounts = await page
      .locator("[data-slot='execution-count']")
      .evaluateAll((nodes) => nodes.map((node) => node.textContent?.trim() ?? ""));
    const iframeMetrics = await page.evaluate(() =>
      Array.from(document.querySelectorAll("iframe[sandbox]")).map((iframe) => ({
        width: iframe.clientWidth,
        height: iframe.clientHeight,
        sandbox: iframe.getAttribute("sandbox"),
        allow: iframe.getAttribute("allow"),
        src: iframe.getAttribute("src"),
        srcdoc: iframe.hasAttribute("srcdoc"),
        origin: iframe.getAttribute("src")
          ? new URL(iframe.getAttribute("src"), location.href).origin
          : null,
      })),
    );
    const renderedCellCount = await page
      .locator("[data-slot='cell-container'], [data-cell-id]")
      .count();
    const presenceText = await page
      .locator("[data-slot='notebook-presence-status']")
      .textContent({ timeout: 1_000 })
      .catch(() => null);
    viewerMilestones = summarizeViewerMilestones(await collectViewerLoadMarks(page));

    if (requireSiftWasm && siftWasmRequests.length === 0) {
      failures.push({ kind: "sift-wasm", text: "Sift WASM was not requested" });
    }
    if (requireRuntimedWasm && runtimedWasmRequests.length === 0) {
      failures.push({ kind: "runtimed-wasm", text: "runtimed WASM was not requested" });
    }
    failures.push(...fatalIsolatedDiagnostics.map(isolatedDiagnosticFailure));
    for (const request of siftWasmRequests) {
      if (request.status >= 400) {
        failures.push({ kind: "sift-wasm", text: `Sift WASM returned ${request.status}` });
      }
      if (request.cors !== "*") {
        failures.push({ kind: "sift-wasm", text: "Sift WASM response did not include CORS *" });
      }
      if (!request.contentType?.includes("application/wasm")) {
        failures.push({
          kind: "sift-wasm",
          text: `Sift WASM content type was ${request.contentType ?? "missing"}`,
        });
      }
    }
    for (const request of runtimedWasmRequests) {
      if (request.status >= 400) {
        failures.push({
          kind: "runtimed-wasm",
          text: `runtimed WASM asset returned ${request.status}`,
        });
      }
      if (request.cors !== "*") {
        failures.push({
          kind: "runtimed-wasm",
          text: "runtimed WASM asset response did not include CORS *",
        });
      }
      if (
        request.url.includes("runtimed_wasm_bg.wasm") &&
        !request.contentType?.includes("application/wasm")
      ) {
        failures.push({
          kind: "runtimed-wasm",
          text: `runtimed WASM content type was ${request.contentType ?? "missing"}`,
        });
      }
    }
    if (
      expectedRendererAssetOrigin &&
      (requireSiftWasm || siftWasmRequests.length > 0) &&
      !siftWasmRequests.some((request) => request.url.startsWith(expectedRendererAssetOrigin))
    ) {
      failures.push({
        kind: "sift-wasm-origin",
        text: `Sift WASM did not load from ${expectedRendererAssetOrigin}`,
        requests: siftWasmRequests.map((request) => request.url),
      });
    }
    if (
      expectedRendererAssetOrigin &&
      (requireRuntimedWasm || runtimedWasmRequests.length > 0) &&
      !runtimedWasmRequests.some((request) => request.url.startsWith(expectedRendererAssetOrigin))
    ) {
      failures.push({
        kind: "runtimed-wasm-origin",
        text: `runtimed WASM did not load from ${expectedRendererAssetOrigin}`,
        requests: runtimedWasmRequests.map((request) => request.url),
      });
    }
    if (expectedOutputDocumentOrigin && expectedFrameTexts.length > 0) {
      const matchingFrames = iframeMetrics.filter(
        (iframe) => iframe.origin === outputDocumentOrigin,
      );
      if (matchingFrames.length === 0) {
        failures.push({
          kind: "output-document-origin",
          text: `No output iframe loaded from ${expectedOutputDocumentOrigin}`,
          frames: iframeMetrics,
        });
      }
      if (matchingFrames.some((iframe) => iframe.srcdoc)) {
        failures.push({
          kind: "output-document-srcdoc",
          text: "Output iframe used srcdoc despite an expected output-document origin",
          frames: matchingFrames,
        });
      }
      if (matchingFrames.some((iframe) => /\ballow-same-origin\b/.test(iframe.sandbox ?? ""))) {
        failures.push({
          kind: "output-document-sandbox",
          text: "Output iframe sandbox included allow-same-origin",
          frames: matchingFrames,
        });
      }
    }
    if (forbidRenderCacheRequests && renderCacheRequests.length > 0) {
      failures.push({
        kind: "render-cache-request",
        text: "Hosted viewer requested stale render-cache endpoints instead of live sync materialization",
        requests: renderCacheRequests,
      });
    }
    const performanceDiagnostics = summarizePerformanceResources(performanceResources, timingsMs);
    failures.push(...performanceBudgetFailures(performanceDiagnostics, performanceBudgets));
    if (screenshotPath) {
      await saveScreenshot(page);
    }
    if (expectedThemeModes.length > 0) {
      themeModeChecks = await checkHostedThemeModes(browser, expectedThemeModes);
      markTiming("theme_modes");
    }

    if (failures.length > 0) {
      throw new SmokeFailure(failures);
    }
    markTiming("total");

    console.log(
      JSON.stringify(
        {
          ok: true,
          targetUrl,
          expectedSourceText,
          expectedPageTexts,
          expectedExecutionCount,
          requireRenderedCellMarker,
          expectedPresenceText,
          expectedFrameTexts,
          expectedOutputDocumentOrigin,
          expectedCatalogOwnerPrincipal,
          expectedLatestRevisionActorLabel,
          expectedLatestRevisionNotebookHeadsHash,
          expectedLatestRevisionRuntimeHeadsHash,
          expectedLatestRevisionRuntimeStateDocId,
          requireLatestRevisionRuntimeStateDocId,
          timings_ms: timingsMs,
          viewer_milestones_ms: viewerMilestones,
          performanceDiagnostics,
          performanceBudgets,
          browserResourceTimingCount: browserResourceTimings.length,
          catalogApiCheck,
          viewerCssCheck,
          runtimeWasmHintCheck,
          forbidRenderCacheRequests,
          renderCacheRequests,
          executionCounts,
          renderedCellCount,
          presenceText,
          siftLoadMilestoneMatches,
          frameTextMatches,
          pageTextMatches,
          themeModeChecks,
          iframeMetrics,
          siftWasmRequests,
          runtimedWasmRequests,
          rendererCompletions: rendererCompletions.length,
          siftDiagnostics,
          warnings,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    await flushDiagnosticTasks();
    if (screenshotPath && !screenshotSaved) {
      await saveScreenshot(page).catch(() => {});
    }
    if (!(error instanceof SmokeFailure) && fatalIsolatedDiagnostics.length > 0) {
      throw new SmokeFailure([
        ...fatalIsolatedDiagnostics.map(isolatedDiagnosticFailure),
        { kind: "smoke-error", text: error instanceof Error ? error.message : String(error) },
      ]);
    }
    throw error;
  } finally {
    await browser.close();
  }
}

function parseExpectedTexts(envName, fallback) {
  const value = process.env[envName];
  if (value === undefined) {
    return fallback;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return [];
  }
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
      throw new Error(`${envName} JSON must be an array of strings`);
    }
    return parsed;
  }
  return trimmed
    .split("|")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseOptionalBudget(envName) {
  return parsePositiveInteger(process.env[envName], null, envName);
}

function parseContentLength(value) {
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function markTiming(name) {
  markTimingAt(name, elapsedMs());
}

function markTimingAt(name, value) {
  timingsMs[name] ??= Math.round(value);
}

function elapsedMs() {
  return Math.round(performance.now() - smokeStartedAt);
}

function finishPerformanceRequest(request, updates) {
  const record = performanceRequests.get(request);
  if (!record) {
    return;
  }
  performanceRequests.delete(request);
  performanceResources.push(
    refinePerformanceResourceKind({
      ...record,
      ...updates,
      end_ms: elapsedMs(),
    }),
  );
}

async function collectBrowserResourceTimings(page) {
  return page.evaluate(() =>
    performance.getEntriesByType("resource").map((entry) => ({
      name: entry.name,
      transferSize: entry.transferSize,
      encodedBodySize: entry.encodedBodySize,
      decodedBodySize: entry.decodedBodySize,
    })),
  );
}

function themeModeSpec(value) {
  switch (value) {
    case "light":
      return { mode: value, storedTheme: "light", mediaColorScheme: null, expectedTheme: "light" };
    case "dark":
      return { mode: value, storedTheme: "dark", mediaColorScheme: null, expectedTheme: "dark" };
    case "system":
      return { mode: value, storedTheme: "system", mediaColorScheme: null, expectedTheme: null };
    case "system-light":
      return {
        mode: value,
        storedTheme: "system",
        mediaColorScheme: "light",
        expectedTheme: "light",
      };
    case "system-dark":
      return {
        mode: value,
        storedTheme: "system",
        mediaColorScheme: "dark",
        expectedTheme: "dark",
      };
    default:
      throw new Error(
        `NOTEBOOK_CLOUD_SMOKE_THEME_MODES contains unsupported mode ${JSON.stringify(value)}`,
      );
  }
}

async function checkHostedThemeModes(browser, modes) {
  const checks = [];

  for (const mode of modes) {
    const spec = themeModeSpec(mode);
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
      deviceScaleFactor: 1,
    });
    const localFailures = [];
    const localWarnings = [];

    page.on("console", (message) => {
      const text = message.text();
      if (message.type() === "error" && !isBenignConsoleError(text)) {
        localFailures.push({ kind: "theme-console-error", mode, text });
      }
      if (message.type() === "warning") {
        localWarnings.push(text);
      }
    });
    page.on("pageerror", (error) => {
      localFailures.push({ kind: "theme-page-error", mode, text: error.message });
    });
    page.on("requestfailed", (request) => {
      if (!isRelevantRequestUrl(request.url())) {
        return;
      }
      if (isThemeOutputFrameCloseAbort(request)) {
        return;
      }
      localFailures.push({
        kind: "theme-request-failed",
        mode,
        url: request.url(),
        error: request.failure()?.errorText ?? "unknown",
      });
    });

    try {
      if (spec.mediaColorScheme) {
        await page.emulateMedia({ colorScheme: spec.mediaColorScheme });
      }
      await page.addInitScript(
        ({ storedTheme }) => {
          try {
            if (window.top === window) {
              window.localStorage.setItem("nteract.cloud.viewer.theme", storedTheme);
            }
          } catch {
            // Sandboxed output documents correctly cannot read localStorage.
          }
        },
        { storedTheme: spec.storedTheme },
      );
      await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });

      if (expectedSourceText) {
        await page.waitForFunction(
          (text) => document.body.innerText.includes(text),
          expectedSourceText,
          { timeout: timeoutMs },
        );
      }
      await page.waitForFunction(
        () =>
          Array.from(document.querySelectorAll("iframe[sandbox]")).some(
            (iframe) => iframe.clientWidth > 0 && iframe.clientHeight > 0,
          ),
        undefined,
        { timeout: timeoutMs },
      );

      const observed = await page.evaluate(() => ({
        className: document.documentElement.className,
        datasetTheme: document.documentElement.dataset.theme ?? null,
        colorScheme: getComputedStyle(document.documentElement).colorScheme,
        outputFrames: Array.from(document.querySelectorAll("iframe[sandbox]")).map((iframe) => ({
          src: iframe.getAttribute("src"),
          srcdoc: iframe.hasAttribute("srcdoc"),
          sandbox: iframe.getAttribute("sandbox"),
          origin: iframe.getAttribute("src")
            ? new URL(iframe.getAttribute("src"), location.href).origin
            : null,
        })),
      }));
      const resolvedTheme = observed.datasetTheme;
      const expectedTheme = spec.expectedTheme ?? resolvedTheme;
      const outputFrames = observed.outputFrames.filter(
        (frame) => frame.origin === outputDocumentOrigin,
      );

      if (expectedTheme !== "light" && expectedTheme !== "dark") {
        localFailures.push({
          kind: "theme-resolution",
          mode,
          text: `expected a light or dark resolved theme, got ${expectedTheme ?? "missing"}`,
          observed,
        });
      } else if (resolvedTheme !== expectedTheme) {
        localFailures.push({
          kind: "theme-resolution",
          mode,
          text: `expected ${expectedTheme}, got ${resolvedTheme ?? "missing"}`,
          observed,
        });
      }
      if (!observed.className.split(/\s+/).includes(expectedTheme)) {
        localFailures.push({
          kind: "theme-class",
          mode,
          text: `documentElement class did not include ${expectedTheme}`,
          observed,
        });
      }
      if (!observed.colorScheme.includes(expectedTheme)) {
        localFailures.push({
          kind: "theme-color-scheme",
          mode,
          text: `color-scheme did not include ${expectedTheme}`,
          observed,
        });
      }
      if (expectedOutputDocumentOrigin && outputFrames.length === 0) {
        localFailures.push({
          kind: "theme-output-document-origin",
          mode,
          text: `No output iframe loaded from ${expectedOutputDocumentOrigin}`,
          observed,
        });
      }
      for (const frame of outputFrames) {
        const frameUrl = new URL(frame.src, targetUrl);
        const frameTheme = frameUrl.searchParams.get("nteract_theme");
        if (frameTheme !== expectedTheme) {
          localFailures.push({
            kind: "theme-output-document-url",
            mode,
            text: `output frame theme was ${frameTheme ?? "missing"}, expected ${expectedTheme}`,
            frame,
          });
        }
        if (/\ballow-same-origin\b/.test(frame.sandbox ?? "")) {
          localFailures.push({
            kind: "theme-output-document-sandbox",
            mode,
            text: "Output iframe sandbox included allow-same-origin",
            frame,
          });
        }
      }

      failures.push(...localFailures);
      checks.push({
        mode,
        storedTheme: spec.storedTheme,
        mediaColorScheme: spec.mediaColorScheme,
        expectedTheme,
        resolvedTheme,
        outputFrameCount: outputFrames.length,
        warnings: localWarnings,
        failures: localFailures,
      });
    } finally {
      await page.close();
    }
  }

  return checks;
}

async function collectRuntimeWasmHints(page) {
  return page.evaluate(() =>
    Array.from(document.head.querySelectorAll("link[href*='runtimed_wasm']")).map((link) => ({
      rel: link.getAttribute("rel") ?? "",
      href: link.href,
      as: link.getAttribute("as") ?? "",
      type: link.getAttribute("type") ?? "",
      crossorigin: link.getAttribute("crossorigin"),
      crossOrigin: link.crossOrigin,
    })),
  );
}

async function collectViewerLoadMarks(page) {
  return page.evaluate(() =>
    performance.getEntriesByType("mark").map((entry) => ({
      name: entry.name,
      startTime: entry.startTime,
    })),
  );
}

async function waitForPageText(page, expectedTexts) {
  const deadline = Date.now() + timeoutMs;
  const matches = new Map(expectedTexts.map((text) => [text, false]));

  while (Date.now() < deadline) {
    const text = await page
      .locator("body")
      .innerText({ timeout: 1_000 })
      .catch(() => "");
    for (const expectedText of expectedTexts) {
      if (text.includes(expectedText)) {
        matches.set(expectedText, true);
      }
    }

    if (Array.from(matches.values()).every(Boolean)) {
      return Object.fromEntries(matches);
    }
    await page.waitForTimeout(250);
  }

  const missing = Array.from(matches.entries())
    .filter(([, found]) => !found)
    .map(([text]) => text);
  throw new Error(`Timed out waiting for hosted page text: ${missing.join(", ")}`);
}

function isBenignConsoleError(text) {
  return (
    text.includes("A listener indicated an asynchronous response by returning true") ||
    text.includes("message channel closed before a response was received")
  );
}

function isRelevantRequestUrl(value) {
  try {
    const url = new URL(value);
    return (
      url.origin === targetOrigin ||
      url.origin === rendererAssetOrigin ||
      url.origin === outputDocumentOrigin
    );
  } catch {
    return false;
  }
}

function isThemeOutputFrameCloseAbort(request) {
  if (request.failure()?.errorText !== "net::ERR_ABORTED" || !outputDocumentOrigin) {
    return false;
  }
  return new URL(request.url()).origin === outputDocumentOrigin;
}

async function checkHostedCatalogApi(
  viewerUrl,
  {
    expectedCatalogOwnerPrincipal,
    expectedLatestRevisionActorLabel,
    expectedLatestRevisionNotebookHeadsHash,
    expectedLatestRevisionRuntimeHeadsHash,
    expectedLatestRevisionRuntimeStateDocId,
    requireLatestRevisionRuntimeStateDocId,
  },
) {
  const catalogUrl = catalogApiUrlForViewer(viewerUrl);
  if (!catalogUrl) {
    failures.push({
      kind: "catalog-api",
      text: `Could not derive /api/n/:id URL from ${viewerUrl}`,
    });
    return null;
  }

  const response = await fetch(catalogUrl);
  if (!response.ok) {
    failures.push({
      kind: "catalog-api",
      text: `${catalogUrl} returned ${response.status}`,
    });
    return { url: catalogUrl, status: response.status };
  }

  const json = await response.json();
  const summary = summarizeCatalog(json);
  for (const failure of catalogExpectationFailures(summary, {
    expectedCatalogOwnerPrincipal,
    expectedLatestRevisionActorLabel,
    expectedLatestRevisionNotebookHeadsHash,
    expectedLatestRevisionRuntimeHeadsHash,
    expectedLatestRevisionRuntimeStateDocId,
    requireLatestRevisionRuntimeStateDocId,
  })) {
    failures.push({
      ...failure,
      kind: "catalog-api",
      url: catalogUrl,
    });
  }

  return {
    url: catalogUrl,
    status: response.status,
    ...summary,
  };
}

function captureIsolatedDiagnostic(message, parsedDiagnostic) {
  const diagnostic = {
    ...parsedDiagnostic,
    observedAtMs: elapsedMs(),
    level: consoleMessageLevel(message.type()),
    text: message.text(),
    details: null,
  };
  if (diagnostic.phase === "sift-load-milestone") {
    siftDiagnostics.push(diagnostic);
  }
  if (isFatalIsolatedDiagnostic(diagnostic)) {
    fatalIsolatedDiagnostics.push(diagnostic);
  }

  diagnosticTasks.push(
    readConsoleMessageDetails(message).then((details) => {
      diagnostic.details = details;
    }),
  );
}

async function readConsoleMessageDetails(message) {
  const detailsArg = message.args()[1];
  if (!detailsArg) {
    return null;
  }
  try {
    const value = await detailsArg.jsonValue();
    if (isPlainRecord(value)) {
      return value;
    }
    return { value };
  } catch (error) {
    return { unavailable: error instanceof Error ? error.message : String(error) };
  }
}

async function flushDiagnosticTasks() {
  await Promise.allSettled(diagnosticTasks);
}

function isPlainRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function waitForFrameText(page, expectedTexts) {
  const deadline = Date.now() + timeoutMs;
  const matches = new Map(expectedTexts.map((text) => [text, false]));

  while (Date.now() < deadline) {
    if (fatalIsolatedDiagnostics.length > 0) {
      await flushDiagnosticTasks();
      throw new SmokeFailure(fatalIsolatedDiagnostics.map(isolatedDiagnosticFailure));
    }
    for (const frame of page.frames().filter((frame) => frame !== page.mainFrame())) {
      const text = await frame
        .locator("body")
        .innerText({ timeout: 1_000 })
        .catch(() => "");
      for (const expectedText of expectedTexts) {
        if (text.includes(expectedText)) {
          matches.set(expectedText, true);
        }
      }
    }

    if (Array.from(matches.values()).every(Boolean)) {
      return Object.fromEntries(matches);
    }
    await page.waitForTimeout(250);
  }

  const missing = Array.from(matches.entries())
    .filter(([, found]) => !found)
    .map(([text]) => text);
  throw new Error(`Timed out waiting for hosted renderer iframe text: ${missing.join(", ")}`);
}

async function waitForSiftLoadMilestone(page, milestone) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (fatalIsolatedDiagnostics.length > 0) {
      await flushDiagnosticTasks();
      throw new SmokeFailure(fatalIsolatedDiagnostics.map(isolatedDiagnosticFailure));
    }
    await flushDiagnosticTasks();
    const diagnostic = siftDiagnostics.find((entry) =>
      matchesSiftLoadMilestone(entry, { phase: milestone }),
    );
    if (diagnostic) {
      return diagnostic;
    }
    await page.waitForTimeout(100);
  }

  throw new Error(`Timed out waiting for Sift load milestone: ${milestone}`);
}

async function saveScreenshot(page) {
  await mkdir(path.dirname(screenshotPath), { recursive: true });
  await page.screenshot({ path: screenshotPath, fullPage: true });
  screenshotSaved = true;
}

class SmokeFailure extends Error {
  constructor(failures) {
    super(`Hosted render smoke failed:\n${JSON.stringify(failures, null, 2)}`);
    this.name = "SmokeFailure";
  }
}
