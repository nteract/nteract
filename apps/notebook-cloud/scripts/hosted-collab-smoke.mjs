import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

import {
  assertHostedCollabSmokeEnv,
  browserDevTokenForSmoke,
  storageStateForDevIdentity,
  viewerUrlForRoom,
} from "./hosted-collab-smoke-env.mjs";

const DEFAULT_BASE_URL = "http://127.0.0.1:8787";
const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requestedBaseUrl = process.env.NOTEBOOK_CLOUD_URL ?? DEFAULT_BASE_URL;
const devAuthToken = process.env.NOTEBOOK_CLOUD_DEV_TOKEN;
const providedViewerUrl = process.argv[2] ?? process.env.NOTEBOOK_CLOUD_COLLAB_VIEWER_URL;
const timeoutMs = Number(process.env.NOTEBOOK_CLOUD_SMOKE_TIMEOUT_MS ?? 60_000);
const screenshotPath = process.env.NOTEBOOK_CLOUD_SMOKE_SCREENSHOT;
const timingsMs = {};

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
      }),
    );
    contexts.push(alice.context, bob.context, anonymous.context);

    await timed("alice_connected", () => waitForPresence(alice.page, "editing"));
    await timed("bob_connected", () => waitForPresence(bob.page, "editing"));
    await timed("anonymous_connected", () => waitForPresence(anonymous.page, "viewing"));
    checks.push("browser_alice_connected", "browser_bob_connected", "anonymous_viewer_connected");

    await waitForEditableMarkdown(alice.page);
    await waitForEditableMarkdown(bob.page);
    checks.push("alice_markdown_editor_available", "bob_markdown_editor_available");

    const aliceMarker = `Alice propagated ${Date.now()}`;
    const aliceText = `# Browser collaboration smoke

${aliceMarker}
`;
    await timed("alice_edit", () => replaceMarkdown(alice.page, aliceText, aliceMarker));
    await timed("alice_to_bob", () => waitForPageText(bob.page, aliceMarker, "Bob"));
    await timed("alice_to_anonymous", () =>
      waitForPageText(anonymous.page, aliceMarker, "anonymous viewer"),
    );
    checks.push("alice_edit_reached_bob", "alice_edit_reached_anonymous");

    const bobMarker = `Bob propagated ${Date.now()}`;
    const bobText = `# Browser collaboration smoke

${aliceMarker}

${bobMarker}
`;
    await timed("bob_edit", () => replaceMarkdown(bob.page, bobText, bobMarker));
    await timed("bob_to_alice", () => waitForPageText(alice.page, bobMarker, "Alice"));
    await timed("bob_to_anonymous", () =>
      waitForPageText(anonymous.page, bobMarker, "anonymous viewer"),
    );
    checks.push("bob_edit_reached_alice", "bob_edit_reached_anonymous");

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
        allowSyncFailure: true,
      }),
    );
    contexts.push(charlie.context);
    await timed("charlie_denied", () => waitForPresence(charlie.page, "Offline"));
    await assertNoEditableMarkdown(charlie.page);
    checks.push("ungranted_editor_denied");

    assertTokenAbsentFromUrls(visitedUrls, token);
    checks.push("token_absent_from_urls");

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
          timings_ms: {
            ...timingsMs,
            total: elapsedMs(startedAt),
          },
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
  allowSyncFailure = false,
}) {
  const context = await browser.newContext({
    storageState,
    viewport: { width: 1240, height: 900 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  instrumentPage({ page, name, failures, visitedUrls, allowSyncFailure });
  await page.goto(viewerUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
  await page.waitForLoadState("networkidle", { timeout: timeoutMs }).catch(() => {});
  return { context, page };
}

function instrumentPage({ page, name, failures, visitedUrls, allowSyncFailure }) {
  page.on("request", (request) => {
    visitedUrls.add(request.url());
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
    if (message.type() === "error" && !isBenignConsoleError(text)) {
      failures.push({ page: name, kind: "console-error", text });
    }
  });
}

async function replaceMarkdown(page, source, localEvidenceText) {
  const editor = page
    .locator("[data-slot='cloud-editable-markdown-cell'] .cm-content[contenteditable='true']")
    .first();
  await editor.waitFor({ state: "visible", timeout: timeoutMs });
  await editor.click();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
  await page.keyboard.insertText(source);
  await waitForPageText(page, localEvidenceText, "editing page");
}

async function waitForEditableMarkdown(page) {
  await page
    .locator("[data-slot='cloud-editable-markdown-cell'] .cm-content[contenteditable='true']")
    .first()
    .waitFor({ state: "visible", timeout: timeoutMs });
}

async function assertNoEditableMarkdown(page) {
  const count = await page
    .locator("[data-slot='cloud-editable-markdown-cell'] .cm-content[contenteditable='true']")
    .count();
  if (count !== 0) {
    throw new Error("ungranted editor unexpectedly received an editable markdown surface");
  }
}

async function waitForPresence(page, expectedText) {
  await page.waitForFunction(
    (expected) => document.querySelector(".cloud-presence")?.textContent?.includes(expected),
    expectedText,
    { timeout: timeoutMs },
  );
}

async function waitForPageText(page, expectedText, label) {
  await page
    .waitForFunction((text) => document.body.innerText.includes(text), expectedText, {
      timeout: timeoutMs,
    })
    .catch((error) => {
      throw new Error(`${label} did not receive expected markdown text: ${error.message}`);
    });
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

function parseJson(stdout, label) {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`${label} did not print JSON: ${error.message}\n${stdout}`);
  }
}

function roomFromViewerUrl(viewerUrl) {
  const parsed = new URL(viewerUrl);
  const [, prefix, encodedRoomId] = parsed.pathname.split("/");
  if (prefix !== "n" || !encodedRoomId) {
    throw new Error(`NOTEBOOK_CLOUD_COLLAB_VIEWER_URL must point at /n/:id, got ${viewerUrl}`);
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

function isBenignConsoleError(text) {
  return (
    text.includes("A listener indicated an asynchronous response") ||
    text.includes("Failed to execute 'observe' on 'MutationObserver'")
  );
}
