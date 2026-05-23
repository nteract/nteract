import { mkdir } from "node:fs/promises";
import path from "node:path";

import { chromium } from "@playwright/test";

const DEFAULT_URL =
  "https://nteract-notebook-cloud.rgbkrk.workers.dev/n/nteract-cloud-live-mathnet";
const DEFAULT_RENDERER_ASSET_ORIGIN = "https://nteract-notebook-cloud-assets.rgbkrk.workers.dev";

const targetUrl = process.argv[2] ?? process.env.NOTEBOOK_CLOUD_HOSTED_URL ?? DEFAULT_URL;
const expectedRendererAssetOrigin =
  process.env.NOTEBOOK_CLOUD_EXPECTED_RENDERER_ASSET_ORIGIN ?? DEFAULT_RENDERER_ASSET_ORIGIN;
const expectedSourceText = process.env.NOTEBOOK_CLOUD_EXPECTED_SOURCE_TEXT ?? "import polars as pl";
const expectedExecutionCount = process.env.NOTEBOOK_CLOUD_EXPECTED_EXECUTION_COUNT ?? null;
const expectedFrameTexts = (
  process.env.NOTEBOOK_CLOUD_EXPECTED_FRAME_TEXTS ?? "Loaded 25 rows|PROBLEM_MARKDOWN"
)
  .split("|")
  .map((text) => text.trim())
  .filter(Boolean);
const screenshotPath = process.env.NOTEBOOK_CLOUD_SMOKE_SCREENSHOT;
const timeoutMs = Number(process.env.NOTEBOOK_CLOUD_SMOKE_TIMEOUT_MS ?? 60_000);
const targetOrigin = new URL(targetUrl).origin;
const rendererAssetOrigin = expectedRendererAssetOrigin
  ? new URL(expectedRendererAssetOrigin).origin
  : null;

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

  const failures = [];
  const warnings = [];
  const siftWasmRequests = [];
  const rendererCompletions = [];
  let screenshotSaved = false;

  page.on("console", (message) => {
    const text = message.text();
    if (message.type() === "error" && !isBenignConsoleError(text)) {
      warnings.push(`console-error: ${text}`);
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
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.waitForLoadState("networkidle", { timeout: timeoutMs }).catch(() => {});

    await page.waitForFunction(
      (text) => document.body.innerText.includes(text),
      expectedSourceText,
      {
        timeout: timeoutMs,
      },
    );
    await page.waitForFunction(
      (expected) => {
        const counts = Array.from(document.querySelectorAll("[data-slot='execution-count']")).map(
          (node) => node.textContent?.trim() ?? "",
        );
        if (expected) {
          return counts.includes(expected);
        }
        return counts.some((count) => /^\[\d+\]:$/.test(count));
      },
      expectedExecutionCount,
      { timeout: timeoutMs },
    );
    await page.waitForFunction(
      () =>
        Array.from(document.querySelectorAll("iframe[sandbox]")).some(
          (iframe) => iframe.clientHeight >= 240,
        ),
      undefined,
      { timeout: timeoutMs },
    );
    const frameTextMatches = await waitForFrameText(page, expectedFrameTexts);

    // Give async iframe plugin fetches a beat to surface late CORS or WASM failures.
    await page.waitForTimeout(750);

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

    if (siftWasmRequests.length === 0) {
      failures.push({ kind: "sift-wasm", text: "Sift WASM was not requested" });
    }
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
      screenshotSaved = true;
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
          executionCounts,
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
    if (screenshotPath && !screenshotSaved) {
      await saveScreenshot(page).catch(() => {});
    }
    throw error;
  } finally {
    await browser.close();
  }
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

async function waitForFrameText(page, expectedTexts) {
  const deadline = Date.now() + timeoutMs;
  const matches = new Map(expectedTexts.map((text) => [text, false]));

  while (Date.now() < deadline) {
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
