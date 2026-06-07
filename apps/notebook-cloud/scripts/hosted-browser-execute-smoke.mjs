import { readFile } from "node:fs/promises";
import os from "node:os";

import { chromium } from "@playwright/test";
import { firstPositionalArg } from "./cli-args.mjs";
import { saveSmokeScreenshot, smokeOutputPath } from "./smoke-paths.mjs";

const viewerUrl =
  firstPositionalArg() ??
  process.env.NOTEBOOK_CLOUD_BROWSER_EXECUTE_VIEWER_URL ??
  process.env.NOTEBOOK_CLOUD_HOSTED_URL;
const tokenPath =
  process.env.NTERACT_PREVIEW_OIDC_TOKEN_PATH ??
  process.env.NOTEBOOK_CLOUD_OIDC_TOKEN_PATH ??
  `${os.homedir()}/token.preview.json`;
const requestedScope = process.env.NOTEBOOK_CLOUD_BROWSER_EXECUTE_SCOPE ?? "owner";
const executeButtonIndex = parseNonNegativeInteger(
  process.env.NOTEBOOK_CLOUD_BROWSER_EXECUTE_BUTTON_INDEX,
  "NOTEBOOK_CLOUD_BROWSER_EXECUTE_BUTTON_INDEX",
  0,
);
const timeoutMs = parsePositiveInteger(
  process.env.NOTEBOOK_CLOUD_BROWSER_EXECUTE_TIMEOUT_MS,
  "NOTEBOOK_CLOUD_BROWSER_EXECUTE_TIMEOUT_MS",
  45_000,
);
const settleMs = parsePositiveInteger(
  process.env.NOTEBOOK_CLOUD_BROWSER_EXECUTE_SETTLE_MS,
  "NOTEBOOK_CLOUD_BROWSER_EXECUTE_SETTLE_MS",
  6_000,
);
const preClickSettleMs = parseNonNegativeInteger(
  process.env.NOTEBOOK_CLOUD_BROWSER_EXECUTE_PRE_CLICK_SETTLE_MS,
  "NOTEBOOK_CLOUD_BROWSER_EXECUTE_PRE_CLICK_SETTLE_MS",
  2_000,
);
const expectedText = process.env.NOTEBOOK_CLOUD_BROWSER_EXECUTE_EXPECTED_TEXT;
const requireBlobImage = process.env.NOTEBOOK_CLOUD_BROWSER_EXECUTE_REQUIRE_BLOB_IMAGE === "1";
const allowFailedRequests =
  process.env.NOTEBOOK_CLOUD_BROWSER_EXECUTE_ALLOW_FAILED_REQUESTS === "1";
const screenshotPath = smokeOutputPath(process.env.NOTEBOOK_CLOUD_BROWSER_EXECUTE_SCREENSHOT);

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main() {
  if (!viewerUrl) {
    throw new Error(
      "Pass a viewer URL or set NOTEBOOK_CLOUD_BROWSER_EXECUTE_VIEWER_URL / NOTEBOOK_CLOUD_HOSTED_URL",
    );
  }
  assertScope(requestedScope);

  const url = new URL(viewerUrl);
  const tokenStorageJson = await readOidcTokenStorageJson(tokenPath);
  const token = JSON.parse(tokenStorageJson);
  const tokenSecondsRemaining = Number(token.expiresAt) - Math.floor(Date.now() / 1000);
  if (!Number.isFinite(tokenSecondsRemaining) || tokenSecondsRemaining <= 60) {
    throw new Error(
      `${tokenPath} is expired or near expiry; refresh it before running the browser execute smoke`,
    );
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addInitScript(
      ({ origin, scope, tokenJson }) => {
        try {
          if (globalThis.location?.origin !== origin) return;
          globalThis.localStorage?.setItem("nteract:notebook-cloud:oidc-token", tokenJson);
          globalThis.localStorage?.setItem("nteract:notebook-cloud:scope", scope);
        } catch {
          // Sandboxed output frames do not always have localStorage. Ignore them:
          // only the first-party notebook shell needs the token cache.
        }
      },
      { origin: url.origin, scope: requestedScope, tokenJson: tokenStorageJson },
    );

    const page = await context.newPage();
    const events = {
      pageErrors: [],
      benignPageErrors: [],
      badConsole: [],
      failedRequests: [],
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
      if (
        /OutputResolutionError|Failed to fetch blob|flush_comms_doc_sync|cloud sync socket is closed|cannot execute|execute cell request|WebSocket/i.test(
          text,
        )
      ) {
        events.badConsole.push(`${message.type()}: ${text}`);
      }
    });
    page.on("requestfailed", (request) => {
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
      const entry = {
        url: safeDiagnosticUrl(ws.url()),
        closed: false,
        errors: [],
      };
      events.websockets.push(entry);
      ws.on("socketerror", (error) => {
        entry.errors.push(String(error));
      });
      ws.on("close", () => {
        entry.closed = true;
      });
    });

    await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.waitForLoadState("networkidle", { timeout: timeoutMs }).catch(() => {});
    await waitForExecuteButtons(page, executeButtonIndex, timeoutMs);
    if (preClickSettleMs > 0) {
      await page.waitForTimeout(preClickSettleMs);
    }

    const before = await pageDiagnostics(page);
    const button = page.locator('[data-testid="execute-button"]').nth(executeButtonIndex);
    await button.scrollIntoViewIfNeeded();
    const clickedAria = await button.getAttribute("aria-label");
    const beforeExecutionOrdinal = maxExecutionOrdinal(
      executionOrdinal(clickedAria),
      before.maxExecutionOrdinal,
    );
    await button.click({ timeout: timeoutMs });
    await waitForExecutionOrdinalAdvance(
      page,
      executeButtonIndex,
      beforeExecutionOrdinal,
      timeoutMs,
    );

    if (expectedText) {
      await page.waitForFunction(
        (text) => (document.body.textContent ?? "").includes(text),
        expectedText,
        { timeout: timeoutMs },
      );
    } else {
      await page.waitForTimeout(settleMs);
    }
    await page.waitForTimeout(settleMs);

    const after = await pageDiagnostics(page);
    if (screenshotPath) {
      await saveSmokeScreenshot(page, screenshotPath);
    }

    const failedBlobResponses = events.blobResponses.filter((response) => response.status >= 400);
    const failedBlobImages = after.images.filter(
      (image) => isBlobBackedImageSource(image.src) && !isLoadedImage(image),
    );
    const loadedBlobBackedImages = after.images.filter(
      (image) => isBlobBackedImageSource(image.src) && isLoadedImage(image),
    );
    const afterExecutionOrdinal = maxExecutionOrdinal(
      executionOrdinal(after.executeButtons[executeButtonIndex]?.aria),
      after.maxExecutionOrdinal,
    );
    if (events.pageErrors.length > 0) {
      throw new Error(`browser page errors:\n${events.pageErrors.join("\n")}`);
    }
    if (events.badConsole.length > 0) {
      throw new Error(`browser console errors:\n${events.badConsole.join("\n")}`);
    }
    if (!allowFailedRequests && events.failedRequests.length > 0) {
      throw new Error(
        `browser request failures:\n${JSON.stringify(events.failedRequests, null, 2)}`,
      );
    }
    if (!executionOrdinalAdvanced(beforeExecutionOrdinal, afterExecutionOrdinal)) {
      throw new Error(
        `execute button did not advance from ${clickedAria ?? "null"} to ${
          after.executeButtons[executeButtonIndex]?.aria ?? "null"
        }`,
      );
    }
    if (failedBlobResponses.length > 0) {
      throw new Error(`blob fetch failures:\n${JSON.stringify(failedBlobResponses, null, 2)}`);
    }
    if (requireBlobImage && events.blobResponses.length === 0) {
      throw new Error("expected at least one authenticated blob fetch");
    }
    if (requireBlobImage && loadedBlobBackedImages.length === 0) {
      throw new Error("expected at least one rendered notebook blob image");
    }
    if (failedBlobImages.length > 0) {
      throw new Error(`blob image render failures:\n${JSON.stringify(failedBlobImages, null, 2)}`);
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          viewerUrl: url.href,
          token: {
            path: tokenPath,
            secondsRemaining: tokenSecondsRemaining,
            subject: token.claims?.email ?? token.claims?.sub ?? null,
          },
          click: {
            executeButtonIndex,
            clickedAria,
            afterAria: after.executeButtons[executeButtonIndex]?.aria ?? null,
            beforeExecutionOrdinal,
            afterExecutionOrdinal,
            preClickSettleMs,
          },
          checks: [
            "oidc_token_seeded_in_browser_storage",
            "execute_button_rendered",
            "execute_button_clicked",
            "execution_count_advanced_after_click",
            ...(expectedText ? ["expected_text_observed_after_click"] : []),
            ...(loadedBlobBackedImages.length > 0 ? ["blob_backed_image_loaded_from_img_src"] : []),
            ...(events.blobResponses.length > 0 ? ["blob_fetches_returned_ok"] : []),
          ],
          before,
          after,
          events,
        },
        null,
        2,
      ),
    );
  } finally {
    await browser.close().catch(() => {});
  }
}

async function readOidcTokenStorageJson(path) {
  const raw = await readFile(path, "utf8");
  const token = JSON.parse(raw);
  if (typeof token.accessToken !== "string" || token.accessToken.length === 0) {
    throw new Error(`${path} is missing accessToken`);
  }
  if (!token.claims || typeof token.claims.sub !== "string" || token.claims.sub.length === 0) {
    throw new Error(`${path} is missing claims.sub`);
  }
  return JSON.stringify(token);
}

async function waitForExecuteButtons(page, index, timeout) {
  await page.waitForFunction(
    (buttonIndex) =>
      document.querySelectorAll('[data-testid="execute-button"]').length > buttonIndex,
    index,
    { timeout },
  );
}

async function waitForExecutionOrdinalAdvance(page, index, beforeOrdinal, timeout) {
  await page.waitForFunction(
    ({ buttonIndex, previous }) => {
      const aria = document
        .querySelectorAll('[data-testid="execute-button"]')
        [buttonIndex]?.getAttribute("aria-label");
      const match = aria?.match(/last execution\s+(\d+)/i);
      if (!match) return false;
      const next = Number(match[1]);
      return Number.isInteger(next) && (previous === null || next > previous);
    },
    { buttonIndex: index, previous: beforeOrdinal },
    { timeout },
  );
}

async function pageDiagnostics(page) {
  return page.evaluate(() => {
    const text = (document.body.textContent ?? "").replace(/\s+/g, " ");
    const executeButtons = Array.from(
      document.querySelectorAll('[data-testid="execute-button"]'),
    ).map((button) => ({
      aria: button.getAttribute("aria-label"),
      disabled: button.disabled,
    }));
    const visibleButtons = Array.from(document.querySelectorAll("button"))
      .filter((button) =>
        Boolean(button.offsetWidth || button.offsetHeight || button.getClientRects().length),
      )
      .map((button) => ({
        testid: button.getAttribute("data-testid"),
        aria: button.getAttribute("aria-label"),
        title: button.getAttribute("title"),
        text: (button.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 80),
        disabled: button.disabled,
      }))
      .slice(0, 80);
    const maxExecutionOrdinal = maxOrdinal(
      [
        ...executeButtons.flatMap((button) => [button.aria]),
        ...visibleButtons.flatMap((button) => [button.aria, button.title, button.text]),
        text,
      ].flatMap(executionOrdinals),
    );
    const images = Array.from(document.querySelectorAll("img"))
      .map((image) => ({
        src: image.currentSrc || image.src,
        complete: image.complete,
        naturalWidth: image.naturalWidth,
        naturalHeight: image.naturalHeight,
      }))
      .slice(0, 25);
    return {
      textSample: text.slice(0, 2_000),
      executeButtons,
      visibleButtons,
      maxExecutionOrdinal,
      images,
    };

    function executionOrdinals(value) {
      if (!value) return [];
      return Array.from(value.matchAll(/last execution\s+(\d+)|last run\s+(\d+)/gi))
        .map((match) => Number(match[1] ?? match[2]))
        .filter(Number.isInteger);
    }

    function maxOrdinal(values) {
      return values.length > 0 ? Math.max(...values) : null;
    }
  });
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

function isBenignPageError(text) {
  // Output iframes are intentionally sandboxed away from browser credentials.
  return /Failed to read the 'localStorage' property from 'Window': The document is sandboxed/i.test(
    text,
  );
}

function executionOrdinal(value) {
  const match = value?.match(/last execution\s+(\d+)|last run\s+(\d+)/i);
  if (!match) return null;
  const parsed = Number(match[1] ?? match[2]);
  return Number.isInteger(parsed) ? parsed : null;
}

function maxExecutionOrdinal(...values) {
  const ordinals = values.filter(Number.isInteger);
  return ordinals.length > 0 ? Math.max(...ordinals) : null;
}

function executionOrdinalAdvanced(before, after) {
  return after !== null && (before === null || after > before);
}

function isNotebookBlobUrl(value) {
  return /\/api\/n\/[^/]+\/blobs\//.test(value);
}

function isBlobBackedImageSource(value) {
  return isNotebookBlobUrl(value) || /^blob:|^data:image\//i.test(value);
}

function isLoadedImage(image) {
  return image.complete && image.naturalWidth > 0 && image.naturalHeight > 0;
}

function assertScope(scope) {
  if (!["viewer", "editor", "owner"].includes(scope)) {
    throw new Error("NOTEBOOK_CLOUD_BROWSER_EXECUTE_SCOPE must be viewer, editor, or owner");
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
