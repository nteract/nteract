import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimePeerScript = path.join(appDir, "scripts", "hosted-runtime-peer-smoke.mjs");
const browserExecuteScript = path.join(appDir, "scripts", "hosted-browser-execute-smoke.mjs");
const source =
  process.env.NOTEBOOK_CLOUD_RUNTIME_BROWSER_EXECUTE_CODE ??
  `print('preview runtime browser execute smoke ${new Date()
    .toISOString()
    .replace(/[-:.]/g, "")
    .slice(0, 15)}')`;
const scopes = parseScopes(process.env.NOTEBOOK_CLOUD_RUNTIME_BROWSER_EXECUTE_SCOPES);

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main() {
  const runs = [];
  for (const scope of scopes) {
    runs.push(await runScope(scope));
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        source,
        scopes,
        checks: [
          "runtime_peer_browser_execute_passed_for_requested_scopes",
          "runtime_peers_stopped_after_browser_smokes",
        ],
        runs,
      },
      null,
      2,
    ),
  );
}

async function runScope(scope) {
  let runtimePeerPid = null;

  try {
    const runtime = await runJsonScript("runtime-peer", runtimePeerScript, [], {
      ...process.env,
      NOTEBOOK_CLOUD_KEEP_RUNTIME_PEER: "1",
      NOTEBOOK_CLOUD_RUNTIME_PEER_SMOKE_CODE: source,
    });
    runtimePeerPid = runtime.runtimePeer?.pid ?? null;

    if (!runtime.ok || typeof runtime.viewerUrl !== "string" || !runtime.viewerUrl) {
      throw new Error(`runtime-peer smoke returned an invalid result:\n${stringify(runtime)}`);
    }
    if (!Number.isInteger(runtimePeerPid)) {
      throw new Error(
        `runtime-peer smoke did not return a kept-alive peer pid:\n${stringify(runtime)}`,
      );
    }

    const browser = await runJsonScript(
      "browser-execute",
      browserExecuteScript,
      [runtime.viewerUrl],
      {
        ...process.env,
        NOTEBOOK_CLOUD_BROWSER_EXECUTE_EXPECTED_TEXT: source,
        NOTEBOOK_CLOUD_BROWSER_EXECUTE_SCOPE: scope,
      },
    );
    const browserSummary = browserRunSummary(browser, scope);
    assertBrowserRunAdvanced(browserSummary);

    await stopProcess(runtimePeerPid);
    const runtimePeerStopped = true;
    runtimePeerPid = null;

    return {
      scope,
      viewerUrl: runtime.viewerUrl,
      checks: [
        "runtime_peer_smoke_passed",
        "runtime_peer_kept_alive_for_browser",
        "browser_execute_smoke_passed",
        ...(runtimePeerStopped ? ["runtime_peer_stopped_after_browser_smoke"] : []),
      ],
      runtimePeer: {
        notebookId: runtime.notebookId,
        vanityName: runtime.vanityName,
        pid: runtime.runtimePeer?.pid ?? null,
        stopped: runtimePeerStopped,
        logPath: runtime.runtimePeer?.logPath ?? null,
        timings_ms: runtime.timings_ms ?? null,
      },
      browserRun: browserSummary,
    };
  } finally {
    if (Number.isInteger(runtimePeerPid)) {
      await stopProcess(runtimePeerPid);
    }
  }
}

function browserRunSummary(run, scope) {
  return {
    scope,
    clickedAria: run.click?.clickedAria ?? null,
    afterAria: run.click?.afterAria ?? null,
    beforeExecutionOrdinal: run.click?.beforeExecutionOrdinal ?? null,
    afterExecutionOrdinal: run.click?.afterExecutionOrdinal ?? null,
    checks: run.checks ?? [],
  };
}

function assertBrowserRunAdvanced(run) {
  if (!Number.isInteger(run.afterExecutionOrdinal) || run.afterExecutionOrdinal < 2) {
    throw new Error(
      `browser execute smoke for ${run.scope} did not advance past the runtime-peer seed execution: ${stringify(
        run,
      )}`,
    );
  }
}

async function runJsonScript(label, script, args, env) {
  const result = await runProcess(process.execPath, [script, ...args], { cwd: appDir, env });
  if (result.exitCode !== 0) {
    throw new Error(
      `${label} smoke failed with exit code ${result.exitCode}\nSTDERR:\n${result.stderr}\nSTDOUT:\n${result.stdout}`,
    );
  }
  return parseJsonOutput(result.stdout, label);
}

function runProcess(command, args, options) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      ...options,
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
    child.on("error", (error) => {
      stderr += `${error.stack ?? error.message}\n`;
      resolve({ exitCode: 1, stdout, stderr });
    });
    child.on("close", (code) => {
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

function parseJsonOutput(stdout, label) {
  const trimmed = stdout.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        // Fall through to the clearer diagnostic below.
      }
    }
  }
  throw new Error(`${label} smoke did not emit parseable JSON:\n${trimmed}`);
}

async function stopProcess(pid) {
  if (!(await processExists(pid))) {
    return;
  }
  signalProcess(pid, "SIGTERM");
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!(await processExists(pid))) {
      return;
    }
    await sleep(100);
  }
  if (await processExists(pid)) {
    signalProcess(pid, "SIGKILL");
  }
}

async function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function parseScopes(value) {
  const raw = value ?? "owner,editor";
  const parsed = raw
    .split(/,|\s+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
  const scopes = parsed.length > 0 ? parsed : ["owner", "editor"];
  for (const scope of scopes) {
    if (!["owner", "editor"].includes(scope)) {
      throw new Error("NOTEBOOK_CLOUD_RUNTIME_BROWSER_EXECUTE_SCOPES must contain owner or editor");
    }
  }
  return scopes;
}

function signalProcess(pid, signal) {
  try {
    process.kill(pid, signal);
  } catch {
    // The peer may exit between existence checks and signal delivery.
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stringify(value) {
  return JSON.stringify(value, null, 2);
}
