import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  entryLabel,
  parseLiveRoomMatrixEntries,
  safeScreenshotName,
  smokeEnvForMatrixEntry,
} from "./hosted-live-room-matrix.mjs";
import { smokeJsonReportPath, writeSmokeJsonReport } from "./smoke-paths.mjs";

const DEFAULT_BASE_URL = "https://preview.runt.run";
const scriptPath = fileURLToPath(new URL("./hosted-live-room-smoke.mjs", import.meta.url));
const appDir = path.dirname(path.dirname(scriptPath));
const baseUrl =
  process.env.NOTEBOOK_CLOUD_LIVE_ROOM_MATRIX_BASE_URL ??
  process.env.NTERACT_CLOUD_URL ??
  process.env.NOTEBOOK_CLOUD_URL ??
  DEFAULT_BASE_URL;
const explicitMatrix = process.env.NOTEBOOK_CLOUD_LIVE_ROOM_MATRIX_URLS;
const limit = parsePositiveInteger(
  process.env.NOTEBOOK_CLOUD_LIVE_ROOM_MATRIX_LIMIT,
  "NOTEBOOK_CLOUD_LIVE_ROOM_MATRIX_LIMIT",
  5,
);
const concurrency = parsePositiveInteger(
  process.env.NOTEBOOK_CLOUD_LIVE_ROOM_MATRIX_CONCURRENCY,
  "NOTEBOOK_CLOUD_LIVE_ROOM_MATRIX_CONCURRENCY",
  2,
);
const tokenPath =
  process.env.NTERACT_PREVIEW_OIDC_TOKEN_PATH ??
  process.env.NOTEBOOK_CLOUD_OIDC_TOKEN_PATH ??
  `${os.homedir()}/token.preview.json`;
const screenshotDir = process.env.NOTEBOOK_CLOUD_LIVE_ROOM_MATRIX_SCREENSHOT_DIR;
const reportPath = smokeJsonReportPath("hosted-live-room-matrix-smoke");

if (isMainModule()) {
  main().catch(async (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    if (!smokeReportAlreadyWritten(error)) {
      await writeSmokeJsonReport(buildMatrixFailureReport(error), reportPath).catch(
        (writeError) => {
          console.error(
            `[notebook-cloud-smoke] failed to write JSON failure report: ${
              writeError instanceof Error ? writeError.message : String(writeError)
            }`,
          );
        },
      );
    }
    process.exitCode = 1;
  });
}

async function main() {
  const entries =
    explicitMatrix === undefined
      ? await listNotebookEntries({ baseUrl, tokenPath, limit })
      : parseLiveRoomMatrixEntries(explicitMatrix).slice(0, limit);

  if (entries.length === 0) {
    throw new Error("hosted live room matrix smoke found no notebooks to check");
  }
  if (screenshotDir) {
    await mkdir(screenshotDir, { recursive: true });
  }

  const startedAt = Date.now();
  const results = await runWithConcurrency(entries, concurrency, runEntry);
  const failures = results.filter((result) => !result.ok);
  const summary = {
    ok: failures.length === 0,
    baseUrl,
    source: explicitMatrix === undefined ? "catalog" : "env",
    limit,
    concurrency,
    checked: results.length,
    failed: failures.length,
    durationMs: Date.now() - startedAt,
    results,
  };

  await writeSmokeJsonReport(summary, reportPath);
  if (failures.length > 0) {
    const error = new Error(
      `hosted live room matrix smoke failed:\n${JSON.stringify(summary, null, 2)}`,
    );
    error.smokeReportAlreadyWritten = true;
    throw error;
  }
  console.log(JSON.stringify(summary, null, 2));
}

async function listNotebookEntries({ baseUrl, tokenPath, limit }) {
  const tokenStorageJson = await readFile(tokenPath, "utf8");
  const token = JSON.parse(tokenStorageJson);
  if (typeof token.accessToken !== "string" || token.accessToken.length === 0) {
    throw new Error(`${tokenPath} is missing accessToken`);
  }
  const tokenSecondsRemaining = Number(token.expiresAt) - Math.floor(Date.now() / 1000);
  if (!Number.isFinite(tokenSecondsRemaining) || tokenSecondsRemaining <= 60) {
    throw new Error(`${tokenPath} is expired or near expiry; refresh it before running the smoke`);
  }

  const url = new URL("/api/n", baseUrl);
  url.searchParams.set("limit", String(limit));
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token.accessToken}` },
  });
  if (!response.ok) {
    throw new Error(`/api/n returned ${response.status} while listing notebooks for matrix smoke`);
  }

  const body = await response.json();
  if (body?.ok !== true || !Array.isArray(body.notebooks)) {
    throw new Error("/api/n response shape was invalid for matrix smoke");
  }

  return body.notebooks
    .filter(
      (notebook) => typeof notebook?.viewer_url === "string" && notebook.viewer_url.length > 0,
    )
    .map((notebook) => ({
      url: notebook.viewer_url,
      notebookId: notebook.notebook_id,
      title: notebook.title,
      scope: notebook.scope,
      updatedAt: notebook.updated_at,
      latestRevisionId: notebook.latest_revision_id,
    }));
}

async function runEntry(entry, index) {
  const label = entryLabel(entry, index);
  const startedAt = Date.now();
  const env = smokeEnvForMatrixEntry(entry, process.env);
  if (screenshotDir) {
    env.NOTEBOOK_CLOUD_LIVE_ROOM_SCREENSHOT = path.join(
      screenshotDir,
      safeScreenshotName(label, index),
    );
  }

  const child = spawn(process.execPath, [scriptPath, entry.url], {
    cwd: appDir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const exitCode = await new Promise((resolve) => {
    child.on("error", (error) => {
      stderr += `${error.stack ?? error.message}\n`;
      resolve(1);
    });
    child.on("close", (code) => {
      resolve(code ?? 1);
    });
  });
  const durationMs = Date.now() - startedAt;

  if (exitCode !== 0) {
    return {
      ok: false,
      label,
      url: entry.url,
      durationMs,
      exitCode,
      stderr: stderr.trim(),
      stdout: trimLongText(stdout.trim()),
    };
  }

  let result;
  try {
    result = JSON.parse(stdout.trim());
  } catch (error) {
    return {
      ok: false,
      label,
      url: entry.url,
      durationMs,
      exitCode,
      stderr: stderr.trim(),
      stdout: trimLongText(stdout.trim()),
      error: `unable to parse hosted live room smoke JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  return {
    ok: true,
    label,
    url: entry.url,
    durationMs,
    cellCount: result.diagnostics?.cellCount ?? null,
    iframeCount: result.diagnostics?.iframeCount ?? null,
    visibleIframeCount: result.diagnostics?.visibleIframeCount ?? null,
    imageCount: result.diagnostics?.imageCount ?? null,
    blobResponseCount: result.events?.blobResponses?.length ?? null,
    websocketCount: result.events?.websockets?.length ?? null,
    activeWebsocketCount: Array.isArray(result.events?.websockets)
      ? result.events.websockets.filter((socket) => !socket.closed).length
      : null,
    failures: result.failures ?? [],
  };
}

async function runWithConcurrency(items, maxConcurrent, worker) {
  const results = Array.from({ length: items.length });
  let nextIndex = 0;

  async function runNext() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(maxConcurrent, items.length) }, () => runNext()));
  return results;
}

function parsePositiveInteger(value, name, fallback) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function trimLongText(value) {
  return value.length > 6_000 ? `${value.slice(0, 6_000)}...` : value;
}

export function buildMatrixFailureReport(error) {
  return {
    ok: false,
    baseUrl,
    source: explicitMatrix === undefined ? "catalog" : "env",
    limit,
    concurrency,
    checked: 0,
    failed: 1,
    results: [],
    error: {
      name: error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : null,
    },
  };
}

function smokeReportAlreadyWritten(error) {
  return Boolean(error && typeof error === "object" && error.smokeReportAlreadyWritten === true);
}

function isMainModule() {
  return process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
}
