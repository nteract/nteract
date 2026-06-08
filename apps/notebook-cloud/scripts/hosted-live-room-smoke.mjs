import { readFile } from "node:fs/promises";
import os from "node:os";

import { chromium } from "@playwright/test";
import { firstPositionalArg } from "./cli-args.mjs";
import { saveSmokeScreenshot, smokeOutputPath } from "./smoke-paths.mjs";

const DEFAULT_URL = "https://preview.runt.run/n/topic-viz/topic-viz";
const viewerUrl =
  firstPositionalArg() ??
  process.env.NOTEBOOK_CLOUD_LIVE_ROOM_VIEWER_URL ??
  process.env.NOTEBOOK_CLOUD_HOSTED_URL ??
  DEFAULT_URL;
const tokenPath =
  process.env.NTERACT_PREVIEW_OIDC_TOKEN_PATH ??
  process.env.NOTEBOOK_CLOUD_OIDC_TOKEN_PATH ??
  `${os.homedir()}/token.preview.json`;
const authMode =
  process.env.NOTEBOOK_CLOUD_LIVE_ROOM_AUTH ??
  (process.env.NOTEBOOK_CLOUD_LIVE_ROOM_ANONYMOUS === "1" ? "anonymous" : "oidc");
const requestedScope =
  process.env.NOTEBOOK_CLOUD_LIVE_ROOM_SCOPE ?? (authMode === "anonymous" ? "viewer" : "editor");
const timeoutMs = parsePositiveInteger(
  process.env.NOTEBOOK_CLOUD_LIVE_ROOM_TIMEOUT_MS,
  "NOTEBOOK_CLOUD_LIVE_ROOM_TIMEOUT_MS",
  60_000,
);
const settleMs = parsePositiveInteger(
  process.env.NOTEBOOK_CLOUD_LIVE_ROOM_SETTLE_MS,
  "NOTEBOOK_CLOUD_LIVE_ROOM_SETTLE_MS",
  2_000,
);
const minCells = parseNonNegativeInteger(
  process.env.NOTEBOOK_CLOUD_LIVE_ROOM_MIN_CELLS,
  "NOTEBOOK_CLOUD_LIVE_ROOM_MIN_CELLS",
  1,
);
const expectedText =
  process.env.NOTEBOOK_CLOUD_LIVE_ROOM_EXPECTED_TEXT ?? "import plotly.graph_objects as go";
const expectedPageTexts = parseExpectedTexts(
  "NOTEBOOK_CLOUD_LIVE_ROOM_EXPECTED_PAGE_TEXTS",
  expectedText ? [expectedText] : [],
);
const expectedFrameTexts = parseExpectedTexts("NOTEBOOK_CLOUD_LIVE_ROOM_EXPECTED_FRAME_TEXTS", []);
const minVisibleIframes = parseNonNegativeInteger(
  process.env.NOTEBOOK_CLOUD_LIVE_ROOM_MIN_VISIBLE_IFRAMES,
  "NOTEBOOK_CLOUD_LIVE_ROOM_MIN_VISIBLE_IFRAMES",
  0,
);
const minImages = parseNonNegativeInteger(
  process.env.NOTEBOOK_CLOUD_LIVE_ROOM_MIN_IMAGES,
  "NOTEBOOK_CLOUD_LIVE_ROOM_MIN_IMAGES",
  0,
);
const requireResolved = process.env.NOTEBOOK_CLOUD_LIVE_ROOM_REQUIRE_RESOLVED !== "0";
const requireOpenSocket = process.env.NOTEBOOK_CLOUD_LIVE_ROOM_REQUIRE_OPEN_SOCKET !== "0";
const requireBlobFetch = process.env.NOTEBOOK_CLOUD_LIVE_ROOM_REQUIRE_BLOB_FETCH === "1";
const requireImagesLoaded = process.env.NOTEBOOK_CLOUD_LIVE_ROOM_REQUIRE_IMAGES_LOADED === "1";
const checkHistoryShortcut = process.env.NOTEBOOK_CLOUD_LIVE_ROOM_CHECK_HISTORY === "1";
const checkCompletionShortcut = process.env.NOTEBOOK_CLOUD_LIVE_ROOM_CHECK_COMPLETION === "1";
const screenshotPath = smokeOutputPath(process.env.NOTEBOOK_CLOUD_LIVE_ROOM_SCREENSHOT);

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main() {
  assertAuthMode(authMode);
  assertScope(requestedScope);
  if (authMode === "anonymous" && requestedScope !== "viewer") {
    throw new Error(
      "NOTEBOOK_CLOUD_LIVE_ROOM_SCOPE must be viewer when NOTEBOOK_CLOUD_LIVE_ROOM_AUTH=anonymous",
    );
  }
  const url = new URL(viewerUrl);
  const tokenInfo = authMode === "oidc" ? await readOidcTokenInfo(tokenPath) : null;

  const browser = await chromium.launch({
    headless: process.env.NOTEBOOK_CLOUD_HEADED !== "1",
    timeout: timeoutMs,
  });

  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
    if (tokenInfo) {
      await context.addInitScript(
        ({ origin, scope, tokenJson }) => {
          try {
            if (globalThis.location?.origin !== origin) return;
            globalThis.localStorage?.setItem("nteract:notebook-cloud:oidc-token", tokenJson);
            globalThis.localStorage?.setItem("nteract:notebook-cloud:scope", scope);
          } catch {
            // Sandboxed output frames must deny localStorage. Only the first-party
            // notebook shell needs the seeded browser token.
          }
        },
        { origin: url.origin, scope: requestedScope, tokenJson: tokenInfo.storageJson },
      );
    }

    const page = await context.newPage();
    const events = {
      pageErrors: [],
      benignPageErrors: [],
      badConsole: [],
      failedRequests: [],
      socketCloseWarnings: [],
      blobResponses: [],
      websockets: [],
    };

    page.on("pageerror", (error) => {
      const text = String(error.message ?? error);
      if (isBenignPageError(text)) {
        events.benignPageErrors.push(text);
        return;
      }
      events.pageErrors.push(text);
    });
    page.on("console", (message) => {
      const text = message.text();
      if (isRecoverableSocketCloseConsoleMessage(text)) {
        events.socketCloseWarnings.push(`${message.type()}: ${text}`);
        return;
      }
      if (isFatalConsoleMessage(text)) {
        events.badConsole.push(`${message.type()}: ${text}`);
      }
    });
    page.on("requestfailed", (request) => {
      if (!isRelevantRequestUrl(request.url())) {
        return;
      }
      events.failedRequests.push({
        url: safeDiagnosticUrl(request.url()),
        failure: request.failure()?.errorText ?? null,
      });
    });
    page.on("response", (response) => {
      const responseUrl = response.url();
      if (/\/api\/n\/[^/]+\/blobs\//.test(responseUrl)) {
        events.blobResponses.push({
          url: safeDiagnosticUrl(responseUrl),
          status: response.status(),
          contentType: response.headers()["content-type"] ?? null,
        });
      }
    });
    page.on("websocket", (ws) => {
      if (!isRoomSyncWebSocket(ws.url())) {
        return;
      }
      const entry = {
        url: safeDiagnosticUrl(ws.url()),
        sent: 0,
        received: 0,
        closed: false,
        errors: [],
      };
      events.websockets.push(entry);
      ws.on("framesent", () => {
        entry.sent += 1;
      });
      ws.on("framereceived", () => {
        entry.received += 1;
      });
      ws.on("socketerror", (error) => {
        entry.errors.push(String(error));
      });
      ws.on("close", () => {
        entry.closed = true;
      });
    });

    await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    if (expectedPageTexts.length > 0) {
      await waitForPageTexts(page, expectedPageTexts);
    }
    if (minCells > 0) {
      await page.waitForFunction(
        (expected) => document.querySelectorAll("[data-cell-id]").length >= expected,
        minCells,
        { timeout: timeoutMs },
      );
    }
    if (requireResolved) {
      await page.waitForFunction(
        () => !/Loading notebook|resolving output payloads/i.test(document.body.textContent ?? ""),
        undefined,
        { timeout: timeoutMs },
      );
    }
    const frameTextMatches =
      expectedFrameTexts.length > 0 ? await waitForFrameTexts(page, expectedFrameTexts) : {};
    await page.waitForTimeout(settleMs);
    const historyShortcut = checkHistoryShortcut
      ? await exerciseHistoryShortcut(page, timeoutMs)
      : null;
    const completionShortcut = checkCompletionShortcut
      ? await exerciseCompletionShortcut(page, timeoutMs)
      : null;

    const diagnostics = await pageDiagnostics(page);
    if (screenshotPath) {
      await saveSmokeScreenshot(page, screenshotPath);
    }

    const failures = [];
    const failedBlobResponses = events.blobResponses.filter((response) => response.status >= 400);
    const activeSockets = events.websockets.filter((socket) => !socket.closed);
    const erroredSockets = events.websockets.filter((socket) => socket.errors.length > 0);
    if (events.pageErrors.length > 0) {
      failures.push({ kind: "page-errors", errors: events.pageErrors });
    }
    if (events.badConsole.length > 0) {
      failures.push({ kind: "console-errors", errors: events.badConsole });
    }
    if (events.failedRequests.length > 0) {
      failures.push({ kind: "request-failures", requests: events.failedRequests });
    }
    if (failedBlobResponses.length > 0) {
      failures.push({ kind: "blob-failures", responses: failedBlobResponses });
    }
    if (erroredSockets.length > 0) {
      failures.push({ kind: "websocket-errors", websockets: erroredSockets });
    }
    if (events.websockets.length === 0) {
      failures.push({ kind: "websocket-missing", text: "no room sync WebSocket was observed" });
    }
    if (requireOpenSocket && activeSockets.length === 0) {
      failures.push({
        kind: "websocket-closed",
        text: "no room sync WebSocket remained open after notebook materialization",
        websockets: events.websockets,
      });
    }
    if (requireBlobFetch && events.blobResponses.length === 0) {
      failures.push({ kind: "blob-missing", text: "no notebook blob responses were observed" });
    }
    if (diagnostics.cellCount < minCells) {
      failures.push({
        kind: "cell-count",
        expected: minCells,
        actual: diagnostics.cellCount,
      });
    }
    if (diagnostics.visibleIframeCount < minVisibleIframes) {
      failures.push({
        kind: "visible-iframe-count",
        expected: minVisibleIframes,
        actual: diagnostics.visibleIframeCount,
        iframes: diagnostics.iframes,
      });
    }
    if (diagnostics.imageCount < minImages) {
      failures.push({
        kind: "image-count",
        expected: minImages,
        actual: diagnostics.imageCount,
        images: diagnostics.images,
      });
    }
    if (requireImagesLoaded && diagnostics.unloadedImages.length > 0) {
      failures.push({
        kind: "image-load",
        text: "one or more rendered images did not finish loading",
        images: diagnostics.unloadedImages,
      });
    }
    if (requireResolved && diagnostics.loading) {
      failures.push({
        kind: "loading-state",
        text: "notebook was still loading or resolving output payloads after the timeout",
      });
    }

    const result = {
      ok: failures.length === 0,
      viewerUrl: url.href,
      auth: {
        mode: authMode,
        requestedScope,
      },
      token: {
        path: tokenInfo?.path ?? null,
        secondsRemaining: tokenInfo?.secondsRemaining ?? null,
      },
      checks: {
        requestedScope,
        expectedPageTexts,
        expectedFrameTexts,
        minCells,
        minVisibleIframes,
        minImages,
        requireResolved,
        requireOpenSocket,
        requireBlobFetch,
        requireImagesLoaded,
        checkHistoryShortcut,
        checkCompletionShortcut,
        screenshotPath: screenshotPath ?? null,
      },
      diagnostics,
      frameTextMatches,
      historyShortcut,
      completionShortcut,
      events,
      failures,
    };

    if (failures.length > 0) {
      throw new Error(`hosted live room smoke failed:\n${JSON.stringify(result, null, 2)}`);
    }
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await browser.close().catch(() => {});
  }
}

async function readOidcTokenInfo(path) {
  const raw = await readFile(path, "utf8");
  const token = JSON.parse(raw);
  if (typeof token.accessToken !== "string" || token.accessToken.length === 0) {
    throw new Error(`${path} is missing accessToken`);
  }
  if (!token.claims || typeof token.claims.sub !== "string" || token.claims.sub.length === 0) {
    throw new Error(`${path} is missing claims.sub`);
  }
  const secondsRemaining = Number(token.expiresAt) - Math.floor(Date.now() / 1000);
  if (!Number.isFinite(secondsRemaining) || secondsRemaining <= 60) {
    throw new Error(`${path} is expired or near expiry; refresh it before running the smoke`);
  }
  return {
    path,
    secondsRemaining,
    storageJson: JSON.stringify(token),
  };
}

async function pageDiagnostics(page) {
  return page.evaluate(() => {
    const compactUrl = (value) => {
      if (!value) return value;
      if (value.startsWith("data:")) {
        const mediaType = value.slice(0, value.indexOf(","));
        return `${mediaType},<${value.length} chars>`;
      }
      return value.length > 240 ? `${value.slice(0, 240)}...` : value;
    };
    const text = (document.body.textContent ?? "").replace(/\s+/g, " ");
    const cellCount = document.querySelectorAll("[data-cell-id]").length;
    const iframes = Array.from(document.querySelectorAll("iframe[sandbox]"))
      .map((iframe) => ({
        src: compactUrl(iframe.getAttribute("src")),
        width: iframe.clientWidth,
        height: iframe.clientHeight,
      }))
      .slice(0, 30);
    const allImages = Array.from(document.querySelectorAll("img")).map((image) => ({
      src: compactUrl(image.currentSrc || image.src),
      complete: image.complete,
      naturalWidth: image.naturalWidth,
      naturalHeight: image.naturalHeight,
    }));
    const emptyImageCount = allImages.filter((image) => !image.src).length;
    const images = allImages
      .filter((image) => image.src)
      .map((image) => ({
        ...image,
      }))
      .slice(0, 30);
    const visibleIframeCount = iframes.filter(
      (iframe) => iframe.width > 0 && iframe.height > 0,
    ).length;
    const unloadedImages = images.filter(
      (image) => !image.complete || image.naturalWidth <= 0 || image.naturalHeight <= 0,
    );
    return {
      cellCount,
      iframeCount: iframes.length,
      visibleIframeCount,
      zeroSizedIframeCount: iframes.length - visibleIframeCount,
      imageCount: images.length,
      emptyImageCount,
      unloadedImages,
      loading: /Loading notebook|resolving output payloads/i.test(text),
      textSample: text.slice(0, 2_000),
      iframes,
      images,
    };
  });
}

async function exerciseHistoryShortcut(page, timeout) {
  const editor = page.locator(editableCodeCellSelector()).first();
  await editor.waitFor({ state: "visible", timeout }).catch(async (error) => {
    const diagnostics = await pageDiagnostics(page).catch(() => null);
    throw new Error(
      `Ctrl-R history smoke requires an editable code cell in the chosen notebook: ${
        error instanceof Error ? error.message : String(error)
      }\n${JSON.stringify(diagnostics, null, 2)}`,
    );
  });
  await editor.click({ timeout });
  await page.keyboard.press("Control+R");

  const input = page.getByPlaceholder("Search history...");
  await input.waitFor({ state: "visible", timeout });
  await page.waitForFunction(
    () => !/Searching history\.\.\./i.test(document.body.textContent ?? ""),
    undefined,
    { timeout },
  );

  const summary = await page.evaluate(() => {
    const text = (document.body.textContent ?? "").replace(/\s+/g, " ");
    const input = document.querySelector('input[placeholder="Search history..."]');
    return {
      cellErrorVisible: /This cell encountered an error/i.test(text),
      dialogVisible: input !== null,
      searchingVisible: /Searching history\.\.\./i.test(text),
      notebookHostErrorVisible:
        /useNotebookHost\(\) must be called inside <NotebookHostProvider>/i.test(text),
      textSample: text.slice(0, 1_000),
    };
  });

  if (!summary.dialogVisible) {
    throw new Error("Ctrl-R did not open the hosted history dialog");
  }
  if (summary.cellErrorVisible || summary.notebookHostErrorVisible) {
    throw new Error(
      `Ctrl-R opened a hosted cell error instead of the history dialog: ${JSON.stringify(summary)}`,
    );
  }
  if (summary.searchingVisible) {
    throw new Error(`Ctrl-R history dialog stayed in loading state: ${JSON.stringify(summary)}`);
  }

  await page.keyboard.press("Escape");
  await input.waitFor({ state: "hidden", timeout }).catch(() => {});
  return summary;
}

async function exerciseCompletionShortcut(page, timeout) {
  const editor = page.locator(editableCodeCellSelector()).first();
  await editor.waitFor({ state: "visible", timeout }).catch(async (error) => {
    const diagnostics = await pageDiagnostics(page).catch(() => null);
    throw new Error(
      `Completion smoke requires an editable code cell in the chosen notebook: ${
        error instanceof Error ? error.message : String(error)
      }\n${JSON.stringify(diagnostics, null, 2)}`,
    );
  });
  await editor.click({ timeout });
  await page.keyboard.press("Control+Space");
  await page.waitForTimeout(800);

  const summary = await page.evaluate(() => {
    const text = (document.body.textContent ?? "").replace(/\s+/g, " ");
    return {
      cellErrorVisible: /This cell encountered an error/i.test(text),
      completionTooltipVisible: document.querySelector(".cm-tooltip-autocomplete") !== null,
      notebookHostErrorVisible:
        /useNotebookHost\(\) must be called inside <NotebookHostProvider>/i.test(text),
      textSample: text.slice(0, 1_000),
    };
  });

  if (summary.cellErrorVisible || summary.notebookHostErrorVisible) {
    throw new Error(`Completion shortcut opened a hosted cell error: ${JSON.stringify(summary)}`);
  }

  await page.keyboard.press("Escape");
  return summary;
}

function editableCodeCellSelector() {
  return '[data-cell-type="code"] .cm-content[contenteditable="true"]';
}

function isRoomSyncWebSocket(value) {
  try {
    const url = new URL(value);
    return url.pathname.endsWith("/sync");
  } catch {
    return false;
  }
}

function isRelevantRequestUrl(value) {
  try {
    const url = new URL(value);
    return (
      url.pathname.includes("/api/n/") ||
      url.pathname.includes("/assets/") ||
      url.pathname.includes("/renderer-assets/") ||
      url.hostname.includes("runtusercontent")
    );
  } catch {
    return false;
  }
}

function isFatalConsoleMessage(text) {
  return /OutputResolutionError|Unable to resolve output|Failed to fetch blob|flush_comms_doc_sync|cloud sync socket|room\.peer_sync|sync to relay failed|runtime state sync to relay failed|comms doc sync to relay failed/i.test(
    text,
  );
}

function isRecoverableSocketCloseConsoleMessage(text) {
  return /\[notebook-cloud\] live room connection closed Error: cloud sync socket closed \((1005|1006)\)/i.test(
    text,
  );
}

function isBenignPageError(text) {
  // Output iframes are intentionally sandboxed away from browser credentials.
  return /Failed to read the 'localStorage' property from 'Window': The document is sandboxed/i.test(
    text,
  );
}

function safeDiagnosticUrl(value) {
  try {
    const url = new URL(value);
    url.searchParams.delete("viewer_session");
    if (/\/api\/n\/[^/]+\/blobs\//.test(url.pathname)) {
      return `${url.origin}/api/n/<id>/blobs/<hash>`;
    }
    return url.href;
  } catch {
    return value.replace(/viewer_session=[^&\s]+/g, "viewer_session=<redacted>");
  }
}

function assertScope(scope) {
  if (!["viewer", "editor", "owner"].includes(scope)) {
    throw new Error("NOTEBOOK_CLOUD_LIVE_ROOM_SCOPE must be viewer, editor, or owner");
  }
}

function assertAuthMode(value) {
  if (!["oidc", "anonymous"].includes(value)) {
    throw new Error("NOTEBOOK_CLOUD_LIVE_ROOM_AUTH must be oidc or anonymous");
  }
}

function parsePositiveInteger(value, name, fallback) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseNonNegativeInteger(value, name, fallback) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
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

async function waitForPageTexts(page, expectedTexts) {
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
  throw new Error(`Timed out waiting for live room page text: ${missing.join(", ")}`);
}

async function waitForFrameTexts(page, expectedTexts) {
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
  throw new Error(`Timed out waiting for live room output frame text: ${missing.join(", ")}`);
}
