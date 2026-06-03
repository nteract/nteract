import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

import { notebookCloudBaseUrl } from "./local-dev.mjs";
import {
  assertHostedCollabSmokeEnv,
  browserDevTokenForSmoke,
  storageStateForDevIdentity,
  viewerUrlForRoom,
} from "./hosted-collab-smoke-env.mjs";
import { summarizeCollabPerformanceTimings } from "./hosted-collab-smoke-performance.mjs";
import { performanceBudgetFailures } from "./hosted-render-smoke-performance.mjs";
import { isRenderCacheApiUrl } from "./hosted-render-smoke-routes.mjs";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requestedBaseUrl = notebookCloudBaseUrl();
const devAuthToken = process.env.NOTEBOOK_CLOUD_DEV_TOKEN;
const providedViewerUrl = process.argv[2] ?? process.env.NOTEBOOK_CLOUD_COLLAB_VIEWER_URL;
const timeoutMs = Number(process.env.NOTEBOOK_CLOUD_SMOKE_TIMEOUT_MS ?? 60_000);
const convergenceRounds = Number(process.env.NOTEBOOK_CLOUD_COLLAB_ROUNDS ?? 4);
const screenshotPath = process.env.NOTEBOOK_CLOUD_SMOKE_SCREENSHOT;
const forbidRenderCacheRequests = process.env.NOTEBOOK_CLOUD_FORBID_RENDER_CACHE_REQUESTS !== "0";
const timingsMs = {};
const editableMarkdownCellSelector = '[data-slot="cell-container"][data-cell-type="markdown"]';
const editableMarkdownEditorSelector = `${editableMarkdownCellSelector} .cm-content[contenteditable='true']`;
const performanceBudgets = {
  collab_connected_ms: parseOptionalBudget(process.env.NOTEBOOK_CLOUD_MAX_COLLAB_CONNECTED_MS),
  collab_editor_update_max_ms: parseOptionalBudget(
    process.env.NOTEBOOK_CLOUD_MAX_COLLAB_EDITOR_UPDATE_MS,
  ),
  collab_anonymous_update_max_ms: parseOptionalBudget(
    process.env.NOTEBOOK_CLOUD_MAX_COLLAB_ANONYMOUS_UPDATE_MS,
  ),
  collab_editor_convergence_max_ms: parseOptionalBudget(
    process.env.NOTEBOOK_CLOUD_MAX_COLLAB_EDITOR_CONVERGENCE_MS,
  ),
  collab_total_ms: parseOptionalBudget(process.env.NOTEBOOK_CLOUD_MAX_COLLAB_TOTAL_MS),
};

const startedAt = performance.now();

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main() {
  const authBaseUrl = providedViewerUrl ? new URL(providedViewerUrl).origin : requestedBaseUrl;
  assertHostedCollabSmokeEnv({ baseUrl: authBaseUrl, devAuthToken });
  const token = browserDevTokenForSmoke({ baseUrl: authBaseUrl, devAuthToken });
  const room = providedViewerUrl
    ? roomFromViewerUrl(providedViewerUrl)
    : await timed("protocol_seed", seedThrowawayRoom);
  const viewerUrl = room.viewerUrl;
  const origin = new URL(viewerUrl).origin;
  const checks = [providedViewerUrl ? "reused_existing_room" : "protocol_seeded_throwaway_room"];
  const browser = await chromium.launch({
    headless: process.env.NOTEBOOK_CLOUD_HEADED !== "1",
    timeout: timeoutMs,
  });
  const failures = [];
  const visitedUrls = new Set();
  const renderCacheRequests = [];
  const contexts = [];

  try {
    const alice = await timed("alice_open", () =>
      openNotebookContext({
        browser,
        name: "alice",
        viewerUrl,
        storageState: storageStateForDevIdentity({
          origin,
          token,
          user: "alice",
          scope: "owner",
        }),
        failures,
        visitedUrls,
        renderCacheRequests,
      }),
    );
    const bob = await timed("bob_open", () =>
      openNotebookContext({
        browser,
        name: "bob",
        viewerUrl,
        storageState: storageStateForDevIdentity({
          origin,
          token,
          user: "bob",
          scope: "editor",
        }),
        failures,
        visitedUrls,
        renderCacheRequests,
      }),
    );
    const anonymous = await timed("anonymous_open", () =>
      openNotebookContext({
        browser,
        name: "anonymous",
        viewerUrl,
        storageState: undefined,
        failures,
        visitedUrls,
        renderCacheRequests,
      }),
    );
    contexts.push(alice.context, bob.context, anonymous.context);

    await timed("alice_connected", () => waitForPresence(alice.page, "editing"));
    await timed("bob_connected", () => waitForPresence(bob.page, "editing"));
    await timed("anonymous_connected", () => waitForPresence(anonymous.page, "here now"));
    checks.push("browser_alice_connected", "browser_bob_connected", "anonymous_viewer_connected");

    await waitForEditableMarkdown(alice.page);
    await waitForEditableMarkdown(bob.page);
    checks.push("alice_markdown_editor_available", "bob_markdown_editor_available");

    await focusEditableMarkdown(bob.page);
    const aliceMarker = `Alice propagated ${Date.now()}`;
    const aliceText = `# Browser collaboration smoke

${aliceMarker}
`;
    await timed("alice_edit", () => replaceMarkdown(alice.page, aliceText, aliceMarker));
    await timed("alice_to_bob", () => waitForPageText(bob.page, aliceMarker, "Bob"));
    await timed("alice_to_bob_editor", () => waitForEditableMarkdownText(bob.page, aliceMarker));
    await timed("alice_to_anonymous", () =>
      waitForPageText(anonymous.page, aliceMarker, "anonymous viewer"),
    );
    checks.push(
      "alice_edit_reached_bob",
      "alice_edit_reached_bob_editor",
      "alice_edit_reached_anonymous",
    );

    await focusEditableMarkdown(alice.page);
    const bobMarker = `Bob propagated ${Date.now()}`;
    const bobText = `# Browser collaboration smoke

${aliceMarker}

${bobMarker}
`;
    await timed("bob_edit", () => replaceMarkdown(bob.page, bobText, bobMarker));
    await timed("bob_to_alice", () => waitForPageText(alice.page, bobMarker, "Alice"));
    await timed("bob_to_alice_editor", () => waitForEditableMarkdownText(alice.page, bobMarker));
    await timed("bob_to_anonymous", () =>
      waitForPageText(anonymous.page, bobMarker, "anonymous viewer"),
    );
    await timed("bob_to_alice_exact", () => waitForEditableMarkdownExactText(alice.page, bobText));
    await timed("bob_to_bob_exact", () => waitForEditableMarkdownExactText(bob.page, bobText));
    checks.push(
      "bob_edit_reached_alice",
      "bob_edit_reached_alice_editor",
      "bob_edit_reached_anonymous",
      "initial_editors_exactly_converged",
    );

    let expectedText = bobText;
    for (let round = 1; round <= convergenceRounds; round += 1) {
      const writerName = round % 2 === 1 ? "alice" : "bob";
      const writer = writerName === "alice" ? alice : bob;
      const marker = `${capitalize(writerName)} ping ${round} ${Date.now()}`;
      expectedText = `${expectedText.trimEnd()}\n\n${marker}\n`;
      await timed(`${writerName}_ping_${round}_edit`, () =>
        replaceMarkdown(writer.page, expectedText, marker),
      );
      await timed(`${writerName}_ping_${round}_alice_exact`, () =>
        waitForEditableMarkdownExactText(alice.page, expectedText),
      );
      await timed(`${writerName}_ping_${round}_bob_exact`, () =>
        waitForEditableMarkdownExactText(bob.page, expectedText),
      );
      await timed(`${writerName}_ping_${round}_anonymous`, () =>
        waitForPageText(anonymous.page, marker, "anonymous viewer"),
      );
    }
    checks.push(`ping_pong_editors_exactly_converged_${convergenceRounds}_rounds`);

    const overlapAliceMarker = `Alice overlap ${Date.now()}`;
    const overlapBobMarker = `Bob overlap ${Date.now()}`;
    const overlapBase = expectedText.trimEnd();
    await timed("overlap_dual_edit", () =>
      Promise.all([
        replaceMarkdown(
          alice.page,
          `${overlapBase}\n\n${overlapAliceMarker}\n`,
          overlapAliceMarker,
        ),
        replaceMarkdown(bob.page, `${overlapBase}\n\n${overlapBobMarker}\n`, overlapBobMarker),
      ]),
    );
    await timed("overlap_editors_converged", () =>
      waitForEditorsEqualContaining([alice.page, bob.page], [overlapAliceMarker, overlapBobMarker]),
    );
    await timed("overlap_anonymous", async () => {
      await waitForPageText(anonymous.page, overlapAliceMarker, "anonymous viewer");
      await waitForPageText(anonymous.page, overlapBobMarker, "anonymous viewer");
    });
    checks.push("overlap_editors_converged");

    const charlie = await timed("charlie_open", () =>
      openNotebookContext({
        browser,
        name: "charlie",
        viewerUrl,
        storageState: storageStateForDevIdentity({
          origin,
          token,
          user: "charlie",
          scope: "editor",
        }),
        failures,
        visitedUrls,
      }),
    );
    contexts.push(charlie.context);
    await timed("charlie_downgraded", () => waitForPresence(charlie.page, "here now"));
    await assertNoEditableMarkdown(charlie.page);
    checks.push("ungranted_editor_downgraded_to_viewer");

    assertTokenAbsentFromUrls(visitedUrls, token);
    checks.push("token_absent_from_urls");
    if (renderCacheRequests.length === 0) {
      checks.push("render_cache_not_requested");
    }

    const timingSummary = {
      ...timingsMs,
      total: elapsedMs(startedAt),
    };
    const performanceDiagnostics = summarizeCollabPerformanceTimings(timingSummary);
    failures.push(...performanceBudgetFailures(performanceDiagnostics, performanceBudgets));

    if (screenshotPath) {
      await alice.page.screenshot({ path: screenshotPath, fullPage: true });
      checks.push("screenshot_saved");
    }

    if (failures.length > 0) {
      throw new Error(
        `browser collaboration smoke failures:\n${JSON.stringify(failures, null, 2)}`,
      );
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          viewerUrl,
          roomId: room.roomId,
          checks,
          timings_ms: timingSummary,
          performance: performanceDiagnostics,
          performanceBudgets,
          forbidRenderCacheRequests,
          renderCacheRequests,
          screenshot: screenshotPath ?? null,
        },
        null,
        2,
      ),
    );
  } finally {
    await Promise.all(contexts.map((context) => context.close().catch(() => {})));
    await browser.close().catch(() => {});
  }
}

async function seedThrowawayRoom() {
  const childEnv = {
    ...process.env,
    NOTEBOOK_CLOUD_URL: requestedBaseUrl,
  };
  const result = await runNode(["--import", "tsx", "scripts/wasm-roundtrip.mjs"], childEnv);
  const output = parseJson(result.stdout, "wasm-roundtrip");
  if (!output.ok || !output.baseUrl || !output.roomId) {
    throw new Error(`wasm-roundtrip did not return a usable room:\n${result.stdout}`);
  }
  return {
    roomId: output.roomId,
    viewerUrl: viewerUrlForRoom(output.baseUrl, output.roomId),
    seed: output,
  };
}

async function openNotebookContext({
  browser,
  name,
  viewerUrl,
  storageState,
  failures,
  visitedUrls,
  renderCacheRequests,
  allowSyncFailure = false,
}) {
  const context = await browser.newContext({
    storageState,
    viewport: { width: 1240, height: 900 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  instrumentPage({ page, name, failures, visitedUrls, renderCacheRequests, allowSyncFailure });
  await page.goto(viewerUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
  await page.waitForLoadState("networkidle", { timeout: timeoutMs }).catch(() => {});
  return { context, page };
}

function instrumentPage({
  page,
  name,
  failures,
  visitedUrls,
  renderCacheRequests,
  allowSyncFailure,
}) {
  page.on("request", (request) => {
    const url = request.url();
    visitedUrls.add(url);
    if (forbidRenderCacheRequests && isRenderCacheApiUrl(url)) {
      const requestSummary = {
        page: name,
        method: request.method(),
        url,
      };
      renderCacheRequests.push(requestSummary);
      failures.push({
        kind: "render-cache-request",
        text: "Hosted collaboration smoke requested stale render-cache endpoints instead of live sync materialization",
        ...requestSummary,
      });
    }
  });
  page.on("response", (response) => {
    visitedUrls.add(response.url());
  });
  page.on("requestfailed", (request) => {
    const url = request.url();
    visitedUrls.add(url);
    if (allowSyncFailure && url.includes("/sync")) {
      return;
    }
    if (!isRelevantRequestUrl(url)) {
      return;
    }
    failures.push({
      page: name,
      kind: "request-failed",
      url,
      error: request.failure()?.errorText ?? "unknown",
    });
  });
  page.on("pageerror", (error) => {
    failures.push({ page: name, kind: "page-error", text: error.message });
  });
  page.on("console", (message) => {
    const text = message.text();
    if (message.type() === "error" && !isBenignConsoleError(text, { allowSyncFailure })) {
      failures.push({ page: name, kind: "console-error", text });
    }
  });
}

async function replaceMarkdown(page, source, localEvidenceText) {
  const editor = await ensureEditableMarkdown(page);
  await editor.click();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
  await page.keyboard.insertText(source);
  await waitForPageText(page, localEvidenceText, "editing page");
}

async function waitForEditableMarkdown(page) {
  await ensureEditableMarkdown(page);
}

async function focusEditableMarkdown(page) {
  const editor = await ensureEditableMarkdown(page);
  await editor.click();
}

async function waitForEditableMarkdownText(page, expectedText) {
  const editor = page.locator(editableMarkdownEditorSelector).first();
  await editor.waitFor({ state: "visible", timeout: timeoutMs });
  await page.waitForFunction(
    ([selector, expected]) => document.querySelector(selector)?.textContent?.includes(expected),
    [editableMarkdownEditorSelector, expectedText],
    { timeout: timeoutMs },
  );
}

async function waitForEditableMarkdownExactText(page, expectedText) {
  const editor = page.locator(editableMarkdownEditorSelector).first();
  await editor.waitFor({ state: "visible", timeout: timeoutMs });
  await page.waitForFunction(
    ([contentSelector, expected]) => {
      const content = document.querySelector(contentSelector);
      if (!content) return false;
      const text = Array.from(content.querySelectorAll(".cm-line"))
        .map((line) => line.textContent ?? "")
        .join("\n");
      return text.trimEnd() === expected.trimEnd();
    },
    [editableMarkdownEditorSelector, expectedText],
    { timeout: timeoutMs },
  );
}

async function waitForEditorsEqualContaining(pages, expectedMarkers) {
  const deadline = Date.now() + timeoutMs;
  let lastTexts = [];
  while (Date.now() < deadline) {
    lastTexts = await Promise.all(pages.map((page) => editableMarkdownText(page)));
    const [first, ...rest] = lastTexts.map((text) => text.trimEnd());
    if (
      first &&
      rest.every((text) => text === first) &&
      expectedMarkers.every((marker) => first.includes(marker))
    ) {
      return;
    }
    await pages[0].waitForTimeout(250);
  }
  throw new Error(
    `editors did not converge with expected markers:\n${JSON.stringify(lastTexts, null, 2)}`,
  );
}

async function editableMarkdownText(page) {
  await page.locator(editableMarkdownEditorSelector).first().waitFor({
    state: "visible",
    timeout: timeoutMs,
  });
  return page.evaluate((contentSelector) => {
    const content = document.querySelector(contentSelector);
    if (!content) return "";
    return Array.from(content.querySelectorAll(".cm-line"))
      .map((line) => line.textContent ?? "")
      .join("\n");
  }, editableMarkdownEditorSelector);
}

async function assertNoEditableMarkdown(page) {
  const count = await page.locator(editableMarkdownEditorSelector).count();
  if (count !== 0) {
    throw new Error("ungranted editor unexpectedly received an editable markdown surface");
  }
}

async function ensureEditableMarkdown(page) {
  const cell = page.locator(editableMarkdownCellSelector).first();
  await cell.waitFor({ state: "visible", timeout: timeoutMs });

  const editor = page.locator(editableMarkdownEditorSelector).first();
  if ((await editor.count()) > 0 && (await editor.isVisible().catch(() => false))) {
    return editor;
  }

  await cell.hover();
  const editButton = cell.locator('button[title="Edit"]').first();
  if ((await editButton.count()) > 0 && (await editButton.isVisible().catch(() => false))) {
    await editButton.click({ timeout: timeoutMs });
  } else {
    await cell.locator('[aria-label="Markdown cell content"]').first().dblclick({
      timeout: timeoutMs,
    });
  }
  await editor.waitFor({ state: "visible", timeout: timeoutMs });
  return editor;
}

async function waitForPresence(page, expectedText) {
  await page.waitForFunction(
    (expected) =>
      document
        .querySelector("[data-slot='notebook-presence-status']")
        ?.textContent?.includes(expected),
    expectedText,
    { timeout: timeoutMs },
  );
}

async function waitForPageText(page, expectedText, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pageContainsText(page, expectedText)) {
      return;
    }
    await page.waitForTimeout(250);
  }
  throw new Error(`${label} did not receive expected markdown text`);
}

async function pageContainsText(page, expectedText) {
  const parentText = await page
    .locator("body")
    .innerText({ timeout: 1_000 })
    .catch(() => "");
  if (parentText.includes(expectedText)) {
    return true;
  }

  for (const frame of page.frames().filter((candidate) => candidate !== page.mainFrame())) {
    const frameText = await frame
      .locator("body")
      .innerText({ timeout: 1_000 })
      .catch(() => "");
    if (frameText.includes(expectedText)) {
      return true;
    }
  }
  return false;
}

function runNode(args, env) {
  console.error(`$ node ${args.join(" ")}`);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: appDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      process.stderr.write(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(
        new Error(
          `node ${args.join(" ")} exited with ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
        ),
      );
    });
  });
}

async function timed(name, fn) {
  const started = performance.now();
  try {
    return await fn();
  } finally {
    timingsMs[name] = elapsedMs(started);
  }
}

function elapsedMs(started) {
  return Math.max(0, Math.round((performance.now() - started) * 100) / 100);
}

function parseOptionalBudget(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const budget = Number(value);
  if (!Number.isFinite(budget) || budget < 0) {
    throw new Error(`Invalid performance budget ${JSON.stringify(value)}`);
  }
  return budget;
}

function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function parseJson(stdout, label) {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`${label} did not print JSON: ${error.message}\n${stdout}`);
  }
}

function roomFromViewerUrl(viewerUrl) {
  const parsed = new URL(viewerUrl);
  const [, prefix, encodedRoomId, vanityName] = parsed.pathname.split("/");
  if (prefix !== "n" || !encodedRoomId || !vanityName) {
    throw new Error(
      `NOTEBOOK_CLOUD_COLLAB_VIEWER_URL must point at /n/:id/:vanityName, got ${viewerUrl}`,
    );
  }
  return {
    roomId: decodeURIComponent(encodedRoomId),
    viewerUrl: parsed.href,
  };
}

function assertTokenAbsentFromUrls(visitedUrls, token) {
  for (const url of visitedUrls) {
    if (url.includes(token)) {
      throw new Error(`dev token leaked into request URL: ${redactToken(url, token)}`);
    }
  }
}

function redactToken(value, token) {
  return value.replaceAll(token, "<redacted>");
}

function isRelevantRequestUrl(url) {
  const parsed = new URL(url);
  return (
    parsed.protocol === "ws:" ||
    parsed.protocol === "wss:" ||
    parsed.pathname.startsWith("/n/") ||
    parsed.pathname.startsWith("/api/n/") ||
    parsed.pathname.includes("runtimed_wasm")
  );
}

function isBenignConsoleError(text, { allowSyncFailure } = {}) {
  return (
    text.includes("A listener indicated an asynchronous response") ||
    text.includes("Failed to execute 'observe' on 'MutationObserver'") ||
    text.includes("Failed to load resource: the server responded with a status of 404") ||
    (allowSyncFailure &&
      text.includes("WebSocket connection") &&
      text.includes("/sync") &&
      text.includes("403"))
  );
}
