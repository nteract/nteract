import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createLiveNotebookFixture } from "./live-notebook-fixture.mjs";
import { loadRuntimedNode } from "./runtimed-node-loader.mjs";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const preset = process.env.NOTEBOOK_CLOUD_LIVE_PRESET ?? "mathnet";
const childTimeoutMs = Number(process.env.NOTEBOOK_CLOUD_SOURCE_ROOM_SMOKE_TIMEOUT_MS ?? 900_000);
const rt = loadRuntimedNode();
const sourceSession = await createLiveNotebookFixture(rt, { preset });

try {
  const env = {
    ...process.env,
    NOTEBOOK_CLOUD_SOURCE_NOTEBOOK_ID: sourceSession.notebookId,
  };
  const live = await runNode(["scripts/hosted-live-smoke.mjs"], env, { timeoutMs: childTimeoutMs });
  const liveResult = parseJson(live.stdout, "hosted-live-smoke");

  assert(
    liveResult.publish?.sourceMode === "existing-notebook-room",
    "publish-live did not use the existing notebook room source path",
  );
  assert(
    liveResult.publish?.sourceNotebookId === sourceSession.notebookId,
    `publish-live exported ${liveResult.publish?.sourceNotebookId ?? "missing"}, expected ${sourceSession.notebookId}`,
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        preset,
        sourceNotebookId: sourceSession.notebookId,
        notebookId: liveResult.publish.notebookId,
        viewerUrl: liveResult.publish.viewerUrl,
        hostedLiveSmoke: liveResult,
      },
      null,
      2,
    ),
  );
} finally {
  await sourceSession.shutdownNotebook().catch(() => {});
  await sourceSession.close().catch(() => {});
}

function runNode(args, env, { timeoutMs }) {
  console.error(`$ node ${args.join(" ")}`);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: appDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      finish(() => {
        child.kill("SIGTERM");
        reject(new Error(`node ${args.join(" ")} timed out after ${timeoutMs}ms`));
      });
    }, timeoutMs);
    timeout.unref?.();

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      process.stderr.write(chunk);
    });
    child.on("error", (error) => {
      finish(() => reject(error));
    });
    child.on("close", (code) => {
      finish(() => {
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

    function finish(callback) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      callback();
    }
  });
}

function parseJson(stdout, label) {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`${label} did not print JSON: ${error.message}\n${stdout}`);
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
