import { readFile } from "node:fs/promises";
import os from "node:os";

import { chromium } from "@playwright/test";

import { firstPositionalArg } from "./cli-args.mjs";
import {
  notebookCloudBaseUrl,
  notebookCloudLocalAuthUrl,
  notebookCloudLoopbackUrl,
} from "./local-dev.mjs";
import {
  saveSmokeScreenshot,
  smokeJsonReportPath,
  smokeOutputPath,
  writeSmokeJsonReport,
} from "./smoke-paths.mjs";

const baseUrl = normalizeBaseUrl(firstPositionalArg() ?? notebookCloudBaseUrl());
const timeoutMs = parsePositiveInteger(
  process.env.NOTEBOOK_CLOUD_MARKDOWN_SMOKE_TIMEOUT_MS,
  60_000,
);
const headed = process.env.NOTEBOOK_CLOUD_HEADED === "1";
const localUser = process.env.NOTEBOOK_CLOUD_MARKDOWN_SMOKE_LOCAL_USER ?? "markdown-browser";
const sharePrincipal =
  process.env.NOTEBOOK_CLOUD_MARKDOWN_SMOKE_SHARE_PRINCIPAL ??
  `user:dev:markdown-smoke-${Date.now()}`;
const screenshotPath = smokeOutputPath(process.env.NOTEBOOK_CLOUD_MARKDOWN_SMOKE_SCREENSHOT);
const reportPath = smokeJsonReportPath("hosted-markdown-document-smoke");
const tokenPath =
  process.env.NTERACT_PREVIEW_OIDC_TOKEN_PATH ??
  process.env.NOTEBOOK_CLOUD_OIDC_TOKEN_PATH ??
  `${os.homedir()}/token.preview.json`;

const editableMarkdownEditorSelector = ".cloud-markdown-editor .cm-content[contenteditable='true']";
const smokeTitle = `Markdown smoke ${new Date().toISOString()}`;
const smokeMarker = `markdown-smoke-marker-${Date.now()}`;
const smokeBody = `# Markdown smoke

${smokeMarker}

## Outline from source

This document is backed by one Automerge text source.

### Nested detail

No compute involved.
`;

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main() {
  const browser = await chromium.launch({ headless: !headed, timeout: timeoutMs });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const failures = [];
  const visitedUrls = new Set();
  const checks = [];
  const timingsMs = {};
  const startedAt = performance.now();
  let snapshotUrl = null;

  instrumentPage({ page, failures, visitedUrls });

  try {
    await timed(timingsMs, "authenticate", () => authenticateMarkdownSmokePage(page));
    checks.push(isLoopbackOrigin(baseUrl) ? "local_dev_auth_established" : "oidc_token_seeded");

    await timed(timingsMs, "dashboard_ready", async () => {
      await page.getByRole("heading", { name: "Documents" }).waitFor({ timeout: timeoutMs });
      await page.getByRole("button", { name: "New Markdown" }).waitFor({ timeout: timeoutMs });
    });
    checks.push("markdown_dashboard_ready");

    await timed(timingsMs, "create_document", async () => {
      await page.getByRole("button", { name: "New Markdown" }).click({ timeout: timeoutMs });
      await page.getByLabel("Title").fill(smokeTitle, { timeout: timeoutMs });
      const [response] = await Promise.all([
        page.waitForResponse(
          (candidate) =>
            candidate.request().method() === "POST" &&
            new URL(candidate.url()).pathname === "/api/m",
          { timeout: timeoutMs },
        ),
        page.getByRole("button", { name: "Create" }).click({ timeout: timeoutMs }),
      ]);
      if (response.status() !== 201) {
        throw new Error(
          `Markdown create returned HTTP ${response.status()}: ${await response.text()}`,
        );
      }
      await page.waitForURL(/\/m\/[^/]+(?:\/.*)?$/, {
        waitUntil: "domcontentloaded",
        timeout: timeoutMs,
      });
    });
    const documentUrl = page.url();
    checks.push("markdown_document_created");

    await timed(timingsMs, "source_editor_ready", async () => {
      await page.getByRole("button", { name: "Source" }).waitFor({ timeout: timeoutMs });
      await page.locator(editableMarkdownEditorSelector).first().waitFor({
        state: "visible",
        timeout: timeoutMs,
      });
    });
    checks.push("source_editor_ready");

    await timed(timingsMs, "edit_source", () => replaceMarkdownSource(page, smokeBody));
    await timed(timingsMs, "outline_updated", async () => {
      const outline = page.getByRole("navigation", { name: "Document outline" });
      await outline.getByRole("link", { name: "Markdown smoke" }).waitFor({ timeout: timeoutMs });
      await outline
        .getByRole("link", { name: "Outline from source" })
        .waitFor({ timeout: timeoutMs });
      await outline.getByRole("link", { name: "Nested detail" }).waitFor({ timeout: timeoutMs });
    });
    checks.push("source_edit_reflected_in_outline");

    await timed(timingsMs, "outline_source_navigation", async () => {
      const outline = page.getByRole("navigation", { name: "Document outline" });
      await outline.getByRole("link", { name: "Nested detail" }).click({ timeout: timeoutMs });
      await page.waitForFunction(() => window.location.hash === "#nested-detail", {
        timeout: timeoutMs,
      });
      await waitForSourceSelection(page, "### Nested detail");
    });
    checks.push("outline_navigates_mono_source_editor");

    await timed(timingsMs, "read_mode_rendered", async () => {
      await page.getByRole("button", { name: "Read" }).click({ timeout: timeoutMs });
      const preview = page.locator(".cloud-markdown-preview").first();
      await preview
        .getByRole("heading", { name: "Markdown smoke" })
        .waitFor({ timeout: timeoutMs });
      await waitForPageText(page, smokeMarker, "read mode");
    });
    checks.push("read_mode_rendered_from_markdown_projection");

    await timed(timingsMs, "responsive_layout", () => assertResponsiveMarkdownRoute(page));
    checks.push("responsive_layout_no_document_overflow");

    await timed(timingsMs, "share_document", async () => {
      await page.getByTitle("Share Markdown document").click({ timeout: timeoutMs });
      await page.getByRole("heading", { name: "Share document" }).waitFor({
        timeout: timeoutMs,
      });
      await page.locator("#cloud-markdown-share-principal").fill(sharePrincipal, {
        timeout: timeoutMs,
      });
      await page.locator("#cloud-markdown-share-scope").selectOption("editor", {
        timeout: timeoutMs,
      });
      await page.getByRole("button", { name: "Grant" }).click({ timeout: timeoutMs });
      await waitForPageText(page, `Access granted to ${sharePrincipal}.`, "share panel");
      await waitForPageText(page, sharePrincipal, "share panel");
    });
    checks.push("principal_access_granted_from_share_panel");

    await timed(timingsMs, "publish_document", async () => {
      const [response] = await Promise.all([
        page.waitForResponse(
          (candidate) =>
            candidate.request().method() === "PUT" &&
            /\/api\/m\/[^/]+\/snapshots\/heads-/.test(new URL(candidate.url()).pathname),
          { timeout: timeoutMs },
        ),
        page.getByRole("button", { name: /^Publish$/ }).click({ timeout: timeoutMs }),
      ]);
      snapshotUrl = response.url();
      if (response.status() !== 201) {
        throw new Error(`Markdown publish returned HTTP ${response.status()}`);
      }
      await waitForPageText(page, "Public link updated.", "publish notice");
      await page.getByRole("button", { name: "Publish update" }).waitFor({
        timeout: timeoutMs,
      });
    });
    checks.push("markdown_document_published");

    const snapshotCheck = await timed(timingsMs, "anonymous_snapshot_read", () =>
      readPublishedSnapshot(snapshotUrl),
    );
    checks.push("published_snapshot_read_without_browser_credentials");

    if (screenshotPath) {
      await saveSmokeScreenshot(page, screenshotPath);
      checks.push("screenshot_saved");
    }

    await page.goto(new URL("/m", baseUrl).href, {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    });
    checks.push("returned_to_markdown_dashboard_to_close_live_socket");

    if (failures.length > 0) {
      throw new Error(`Markdown document smoke failures:\n${JSON.stringify(failures, null, 2)}`);
    }

    const report = {
      ok: true,
      baseUrl,
      documentUrl,
      snapshotUrl,
      title: smokeTitle,
      sharePrincipal,
      checks,
      snapshot: snapshotCheck,
      timings_ms: {
        ...timingsMs,
        total: elapsedMs(startedAt),
      },
      screenshot: screenshotPath ?? null,
    };
    await writeSmokeJsonReport(report, reportPath);
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

async function authenticateMarkdownSmokePage(page) {
  if (isLoopbackOrigin(baseUrl)) {
    const loopbackUrl = notebookCloudLoopbackUrl();
    if (new URL(baseUrl).origin !== new URL(loopbackUrl).origin) {
      throw new Error(
        `Loopback smoke base ${baseUrl} does not match local dev auth origin ${loopbackUrl}`,
      );
    }
    await page.goto(
      notebookCloudLocalAuthUrl({
        user: localUser,
        scope: "owner",
        next: "/m",
      }),
      { waitUntil: "domcontentloaded", timeout: timeoutMs },
    );
    return;
  }

  const tokenJson = await readOidcTokenStorageJson(tokenPath);
  const token = JSON.parse(tokenJson);
  const tokenSecondsRemaining = Number(token.expiresAt) - Math.floor(Date.now() / 1000);
  if (!Number.isFinite(tokenSecondsRemaining) || tokenSecondsRemaining <= 60) {
    throw new Error(
      `${tokenPath} is expired or near expiry; refresh it before running the Markdown smoke`,
    );
  }
  await page.addInitScript(
    ({ origin, tokenStorageJson }) => {
      if (globalThis.location?.origin !== origin) return;
      globalThis.localStorage?.setItem("nteract:notebook-cloud:oidc-token", tokenStorageJson);
      globalThis.localStorage?.setItem("nteract:notebook-cloud:scope", "owner");
    },
    { origin: new URL(baseUrl).origin, tokenStorageJson: tokenJson },
  );
  await page.goto(new URL("/m", baseUrl).href, {
    waitUntil: "domcontentloaded",
    timeout: timeoutMs,
  });
}

async function replaceMarkdownSource(page, source) {
  const editor = page.locator(editableMarkdownEditorSelector).first();
  await editor.waitFor({ state: "visible", timeout: timeoutMs });
  await editor.click({ timeout: timeoutMs });
  await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
  await page.keyboard.insertText(source);
  await waitForEditorText(page, smokeMarker);
}

async function waitForEditorText(page, expectedText) {
  await page.waitForFunction(
    ([selector, expected]) => document.querySelector(selector)?.textContent?.includes(expected),
    [editableMarkdownEditorSelector, expectedText],
    { timeout: timeoutMs },
  );
}

async function waitForSourceSelection(page, expectedText) {
  await page.waitForFunction(
    ([selector, expected]) => {
      const editor = document.querySelector(selector);
      const activeElement = document.activeElement;
      const editorIsFocused =
        editor instanceof HTMLElement &&
        activeElement instanceof HTMLElement &&
        (editor === activeElement || editor.contains(activeElement));
      return editorIsFocused && document.getSelection()?.toString().includes(expected);
    },
    [editableMarkdownEditorSelector, expectedText],
    { timeout: timeoutMs },
  );
}

async function waitForPageText(page, expectedText, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pageContainsText(page, expectedText)) {
      return;
    }
    await page.waitForTimeout(200);
  }
  throw new Error(`${label} did not show expected text: ${expectedText}`);
}

async function pageContainsText(page, expectedText) {
  const text = await page
    .locator("body")
    .innerText({ timeout: 1_000 })
    .catch(() => "");
  return text.includes(expectedText);
}

async function assertResponsiveMarkdownRoute(page) {
  const viewports = [
    { name: "desktop", width: 1440, height: 1000 },
    { name: "constrained", width: 720, height: 900 },
    { name: "mobile", width: 390, height: 860 },
  ];
  const failures = [];
  for (const viewport of viewports) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.waitForTimeout(100);
    const metrics = await page.evaluate(() => {
      const root = document.documentElement;
      const body = document.body;
      return {
        rootClientWidth: root.clientWidth,
        rootScrollWidth: root.scrollWidth,
        bodyClientWidth: body.clientWidth,
        bodyScrollWidth: body.scrollWidth,
      };
    });
    const overflow = Math.max(
      metrics.rootScrollWidth - metrics.rootClientWidth,
      metrics.bodyScrollWidth - metrics.bodyClientWidth,
    );
    if (overflow > 2) {
      failures.push({ viewport: viewport.name, overflow, metrics });
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  if (failures.length > 0) {
    throw new Error(
      `Markdown route has horizontal overflow:\n${JSON.stringify(failures, null, 2)}`,
    );
  }
}

async function readPublishedSnapshot(url) {
  if (!url) {
    throw new Error("Markdown publish did not record a snapshot URL");
  }
  const response = await fetch(url, { headers: { Accept: "application/octet-stream" } });
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (response.status !== 200) {
    throw new Error(`anonymous Markdown snapshot GET returned HTTP ${response.status}`);
  }
  if (bytes.byteLength === 0) {
    throw new Error("published Markdown snapshot was empty");
  }
  const cacheControl = response.headers.get("cache-control") ?? "";
  if (!cacheControl.includes("immutable")) {
    throw new Error(`published Markdown snapshot was not immutable: ${cacheControl}`);
  }
  return {
    status: response.status,
    byteLength: bytes.byteLength,
    cacheControl,
  };
}

function instrumentPage({ page, failures, visitedUrls }) {
  page.on("request", (request) => {
    visitedUrls.add(request.url());
  });
  page.on("response", (response) => {
    visitedUrls.add(response.url());
  });
  page.on("requestfailed", (request) => {
    const url = request.url();
    visitedUrls.add(url);
    if (!isRelevantRequestUrl(url) || isBenignRequestFailureUrl(url)) {
      return;
    }
    failures.push({
      kind: "request-failed",
      url: safeDiagnosticUrl(url),
      error: request.failure()?.errorText ?? "unknown",
    });
  });
  page.on("pageerror", (error) => {
    failures.push({ kind: "page-error", text: error.message });
  });
  page.on("console", (message) => {
    const text = message.text();
    if (message.type() === "error" && !isBenignConsoleError(text)) {
      failures.push({ kind: "console-error", text });
    }
  });
}

function normalizeBaseUrl(value) {
  const url = new URL(value);
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.href.replace(/\/$/, "");
}

async function readOidcTokenStorageJson(path) {
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw);
  if (typeof parsed === "string") {
    JSON.parse(parsed);
    return parsed;
  }
  if (parsed && typeof parsed === "object") {
    if (
      typeof parsed.accessToken === "string" &&
      parsed.accessToken.length > 0 &&
      typeof parsed.expiresAt === "number"
    ) {
      return JSON.stringify(parsed);
    }
    if (typeof parsed.token === "string" && typeof parsed.expiresAt === "number") {
      return JSON.stringify(parsed);
    }
    if (typeof parsed.value === "string") {
      JSON.parse(parsed.value);
      return parsed.value;
    }
  }
  throw new Error(`${path} did not contain an OIDC localStorage token JSON string`);
}

async function timed(timings, name, fn) {
  const started = performance.now();
  try {
    return await fn();
  } finally {
    timings[name] = elapsedMs(started);
  }
}

function elapsedMs(started) {
  return Math.max(0, Math.round((performance.now() - started) * 100) / 100);
}

function parsePositiveInteger(value, fallback) {
  if (value === undefined || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected positive integer, got ${JSON.stringify(value)}`);
  }
  return parsed;
}

function isLoopbackOrigin(value) {
  const hostname = new URL(value).hostname;
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function isRelevantRequestUrl(url) {
  const parsed = new URL(url);
  const target = new URL(baseUrl);
  return parsed.origin === target.origin;
}

function isBenignRequestFailureUrl(url) {
  return new URL(url).pathname === "/cdn-cgi/rum";
}

function safeDiagnosticUrl(url) {
  const parsed = new URL(url);
  for (const key of parsed.searchParams.keys()) {
    if (/token|code|state/i.test(key)) {
      parsed.searchParams.set(key, "<redacted>");
    }
  }
  return parsed.toString();
}

function isBenignConsoleError(text) {
  return /ResizeObserver loop completed|message channel closed before a response|runtime\.lastError/i.test(
    text,
  );
}
