import { mkdir } from "node:fs/promises";
import path from "node:path";

import { chromium } from "@playwright/test";

import { catalogExpectationFailures, summarizeCatalog } from "./hosted-render-smoke-catalog.mjs";
import {
  consoleMessageLevel,
  isolatedDiagnosticFailure,
  isFatalIsolatedDiagnostic,
  parseIsolatedDiagnosticText,
} from "./hosted-render-smoke-diagnostics.mjs";
import { catalogApiUrlForViewer, renderApiUrlForViewer } from "./hosted-render-smoke-routes.mjs";

const DEFAULT_URL =
  "https://nteract-notebook-cloud.rgbkrk.workers.dev/n/nteract-cloud-live-mathnet";
const DEFAULT_RENDERER_ASSET_ORIGIN = "https://nteract-notebook-cloud-assets.rgbkrk.workers.dev";
const DEFAULT_CATALOG_OWNER_PRINCIPAL = "user:dev:live-publish";
const DEFAULT_LATEST_REVISION_ACTOR_LABEL = "user:dev:live-publish/agent:publish-live";

const targetUrl = process.argv[2] ?? process.env.NOTEBOOK_CLOUD_HOSTED_URL ?? DEFAULT_URL;
const expectedRendererAssetOrigin =
  process.env.NOTEBOOK_CLOUD_EXPECTED_RENDERER_ASSET_ORIGIN ?? DEFAULT_RENDERER_ASSET_ORIGIN;
const expectedSourceText = process.env.NOTEBOOK_CLOUD_EXPECTED_SOURCE_TEXT ?? "import polars as pl";
const expectedExecutionCount = process.env.NOTEBOOK_CLOUD_EXPECTED_EXECUTION_COUNT ?? null;
const expectedFrameTexts = parseExpectedTexts(process.env.NOTEBOOK_CLOUD_EXPECTED_FRAME_TEXTS, [
  "Loaded 25 rows",
  "PROBLEM_MARKDOWN",
]);
const expectedRenderSource = process.env.NOTEBOOK_CLOUD_EXPECTED_RENDER_SOURCE ?? "snapshot-pair";
const expectedCatalogOwnerPrincipal =
  process.env.NOTEBOOK_CLOUD_EXPECTED_CATALOG_OWNER_PRINCIPAL ?? DEFAULT_CATALOG_OWNER_PRINCIPAL;
const expectedLatestRevisionActorLabel =
  process.env.NOTEBOOK_CLOUD_EXPECTED_LATEST_REVISION_ACTOR_LABEL ??
  DEFAULT_LATEST_REVISION_ACTOR_LABEL;
const expectedLatestRevisionNotebookHeadsHash =
  process.env.NOTEBOOK_CLOUD_EXPECTED_LATEST_REVISION_NOTEBOOK_HEADS_HASH ?? "";
const expectedLatestRevisionRuntimeHeadsHash =
  process.env.NOTEBOOK_CLOUD_EXPECTED_LATEST_REVISION_RUNTIME_HEADS_HASH ?? "";
const requireSiftWasm = process.env.NOTEBOOK_CLOUD_REQUIRE_SIFT_WASM !== "0";
const screenshotPath = process.env.NOTEBOOK_CLOUD_SMOKE_SCREENSHOT;
const timeoutMs = Number(process.env.NOTEBOOK_CLOUD_SMOKE_TIMEOUT_MS ?? 60_000);
const targetOrigin = new URL(targetUrl).origin;
const rendererAssetOrigin = expectedRendererAssetOrigin
  ? new URL(expectedRendererAssetOrigin).origin
  : null;

const failures = [];
const warnings = [];
const siftWasmRequests = [];
const rendererCompletions = [];
const fatalIsolatedDiagnostics = [];
const diagnosticTasks = [];
let renderApiCheck = null;
let catalogApiCheck = null;
let screenshotSaved = false;

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
    if (!isRelevantRequestUrl(request.url())) {
      return;
    }
    failures.push({
      kind: "request-failed",
      url: request.url(),
      error: request.failure()?.errorText ?? "unknown",
    });
  });

  page.on("response", (response) => {
    const url = response.url();
    if (url.includes("sift_wasm.wasm")) {
      siftWasmRequests.push({
        url,
        status: response.status(),
        cors: response.headers()["access-control-allow-origin"] ?? null,
        contentType: response.headers()["content-type"] ?? null,
      });
    }
  });

  try {
    if (expectedRenderSource) {
      renderApiCheck = await checkHostedRenderApi(targetUrl, expectedRenderSource);
    }
    if (
      expectedCatalogOwnerPrincipal ||
      expectedLatestRevisionActorLabel ||
      expectedLatestRevisionNotebookHeadsHash ||
      expectedLatestRevisionRuntimeHeadsHash
    ) {
      catalogApiCheck = await checkHostedCatalogApi(targetUrl, {
        expectedCatalogOwnerPrincipal,
        expectedLatestRevisionActorLabel,
        expectedLatestRevisionNotebookHeadsHash,
        expectedLatestRevisionRuntimeHeadsHash,
      });
    }

    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.waitForLoadState("networkidle", { timeout: timeoutMs }).catch(() => {});

    if (expectedSourceText) {
      await page.waitForFunction(
        (text) => document.body.innerText.includes(text),
        expectedSourceText,
        {
          timeout: timeoutMs,
        },
      );
    }
    await page.waitForFunction(
      (expected) => {
        const reportCellCount = document.querySelectorAll(
          "[data-slot='read-only-report-cell']",
        ).length;
        const counts = Array.from(document.querySelectorAll("[data-slot='execution-count']")).map(
          (node) => node.textContent?.trim() ?? "",
        );
        if (expected) {
          return counts.includes(expected);
        }
        return reportCellCount > 0 || counts.some((count) => /^\[\d+\]:$/.test(count));
      },
      expectedExecutionCount,
      { timeout: timeoutMs },
    );
    if (expectedFrameTexts.length > 0) {
      await page.waitForFunction(
        () =>
          Array.from(document.querySelectorAll("iframe[sandbox]")).some(
            (iframe) => iframe.clientHeight >= 240,
          ),
        undefined,
        { timeout: timeoutMs },
      );
    }
    const frameTextMatches =
      expectedFrameTexts.length > 0 ? await waitForFrameText(page, expectedFrameTexts) : {};

    // Give async iframe plugin fetches a beat to surface late CORS or WASM failures.
    await page.waitForTimeout(750);
    await flushDiagnosticTasks();

    const executionCounts = await page
      .locator("[data-slot='execution-count']")
      .evaluateAll((nodes) => nodes.map((node) => node.textContent?.trim() ?? ""));
    const iframeMetrics = await page.evaluate(() =>
      Array.from(document.querySelectorAll("iframe[sandbox]")).map((iframe) => ({
        width: iframe.clientWidth,
        height: iframe.clientHeight,
        sandbox: iframe.getAttribute("sandbox"),
        allow: iframe.getAttribute("allow"),
      })),
    );
    const reportCellCount = await page.locator("[data-slot='read-only-report-cell']").count();

    if (requireSiftWasm && siftWasmRequests.length === 0) {
      failures.push({ kind: "sift-wasm", text: "Sift WASM was not requested" });
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
    if (screenshotPath) {
      await saveScreenshot(page);
    }

    if (failures.length > 0) {
      throw new SmokeFailure(failures);
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          targetUrl,
          expectedSourceText,
          expectedExecutionCount,
          expectedFrameTexts,
          expectedRenderSource,
          expectedCatalogOwnerPrincipal,
          expectedLatestRevisionActorLabel,
          expectedLatestRevisionNotebookHeadsHash,
          expectedLatestRevisionRuntimeHeadsHash,
          renderApiCheck,
          catalogApiCheck,
          executionCounts,
          reportCellCount,
          frameTextMatches,
          iframeMetrics,
          siftWasmRequests,
          rendererCompletions: rendererCompletions.length,
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

function parseExpectedTexts(value, fallback) {
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
      throw new Error("NOTEBOOK_CLOUD_EXPECTED_FRAME_TEXTS JSON must be an array of strings");
    }
    return parsed;
  }
  return trimmed
    .split("|")
    .map((entry) => entry.trim())
    .filter(Boolean);
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
    return url.origin === targetOrigin || url.origin === rendererAssetOrigin;
  } catch {
    return false;
  }
}

async function checkHostedRenderApi(viewerUrl, expectedSource) {
  const renderUrl = renderApiUrlForViewer(viewerUrl);
  if (!renderUrl) {
    failures.push({
      kind: "render-api",
      text: `Could not derive /api/n/:id/render URL from ${viewerUrl}`,
    });
    return null;
  }

  const response = await fetch(renderUrl);
  if (!response.ok) {
    failures.push({
      kind: "render-api",
      text: `${renderUrl} returned ${response.status}`,
    });
    return { url: renderUrl, status: response.status };
  }

  const json = await response.json();
  const source = typeof json.source === "string" ? json.source : null;
  const cellCount = Array.isArray(json.cells) ? json.cells.length : null;
  if (source !== expectedSource) {
    failures.push({
      kind: "render-api",
      text: `expected render source ${expectedSource}, got ${source ?? "missing"}`,
      url: renderUrl,
    });
  }
  return {
    url: renderUrl,
    status: response.status,
    source,
    cellCount,
  };
}

async function checkHostedCatalogApi(
  viewerUrl,
  {
    expectedCatalogOwnerPrincipal,
    expectedLatestRevisionActorLabel,
    expectedLatestRevisionNotebookHeadsHash,
    expectedLatestRevisionRuntimeHeadsHash,
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
    level: consoleMessageLevel(message.type()),
    text: message.text(),
    details: null,
  };
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
