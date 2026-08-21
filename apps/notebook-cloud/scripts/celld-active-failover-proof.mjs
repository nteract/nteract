import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = resolve(appDir, "../..");
const args = parseArgs(process.argv.slice(2));
const celldBin = resolve(required(args, "celld-bin"));
const bucket = required(args, "bucket");
const endpoint = required(args, "endpoint");
const region = args.region || process.env.AWS_REGION || "us-east-1";
const outputPath = resolve(workspaceRoot, required(args, "output"));
const configPath = args.config ? resolve(workspaceRoot, args.config) : undefined;
const publicHost = args.host || "127.0.0.1";
const primaryPort = numeric(args["primary-port"] || "18080", "primary-port");
const primaryInternalPort = numeric(
  args["primary-internal-port"] || "18081",
  "primary-internal-port",
);
const failoverPort = numeric(args["failover-port"] || "18082", "failover-port");
const failoverInternalPort = numeric(
  args["failover-internal-port"] || "18083",
  "failover-internal-port",
);

if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
  throw new Error("CellD fleet credentials must be supplied through the standard AWS environment");
}

const startedAt = new Date();
const logs = { primary: "", failover: "", probe: "" };
const primary = await startNode("primary", primaryPort, primaryInternalPort);
const failover = await startNode("failover", failoverPort, failoverInternalPort);
let probe;

try {
  await Promise.all([
    waitForHealth(`http://${publicHost}:${primaryPort}/api/health`, 20_000),
    waitForHealth(`http://${publicHost}:${failoverPort}/api/health`, 20_000),
  ]);

  const probeResult = await runProbe();
  const completedAt = new Date();
  const bundle = {
    schema_version: 1,
    candidate: {
      name: "celld",
      version: args["candidate-version"] || null,
      commit: args["candidate-commit"] || null,
    },
    nteract: {
      commit: await gitHead(),
    },
    configuration: {
      path: configPath ? relativeToWorkspace(configPath) : null,
      sha256: configPath ? sha256(await readFile(configPath)) : null,
      fleet_bucket: bucket,
      public_ports: [primaryPort, failoverPort],
      internal_ports: [primaryInternalPort, failoverInternalPort],
    },
    run: {
      started_at: startedAt.toISOString(),
      completed_at: completedAt.toISOString(),
      elapsed_ms: completedAt.getTime() - startedAt.getTime(),
      failure_signal: "SIGKILL",
      killed_pid: primary.pid,
    },
    result: probeResult,
    logs,
    summary: {
      ok: probeResult.ok === true,
      acknowledged_state_recovered: probeResult.checks?.includes("acknowledged_state_recovered"),
      bounded_reconnect_ms: probeResult.timings_ms?.reconnect_after_disconnect ?? null,
    },
  };
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(bundle, null, 2)}\n`, { mode: 0o600 });
  console.log(
    JSON.stringify({ ok: bundle.summary.ok, output: outputPath, summary: bundle.summary }),
  );
} finally {
  probe?.kill("SIGKILL");
  primary.kill("SIGKILL");
  failover.kill("SIGKILL");
}

async function startNode(name, publicPort, internalPort) {
  const watchDir = await mkdtemp(resolve(tmpdir(), `nteract-celld-${name}-`));
  const child = spawn(
    celldBin,
    [
      "--bucket",
      bucket,
      "--endpoint",
      endpoint,
      "--region",
      region,
      "--listen",
      `${publicHost}:${publicPort}`,
      "--internal-listen",
      `${publicHost}:${internalPort}`,
      "--advertise",
      `${publicHost}:${internalPort}`,
    ],
    {
      cwd: appDir,
      env: { ...process.env, CELLD_WATCH: watchDir, CELLD_V8_HEAP_LIMIT_MB: "768" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  appendOutput(child.stdout, name);
  appendOutput(child.stderr, name);
  return child;
}

function appendOutput(stream, name) {
  stream.on("data", (chunk) => {
    logs[name] = bounded(`${logs[name]}${chunk.toString("utf8")}`, 128 * 1024);
  });
}

async function runProbe() {
  return new Promise((resolvePromise, rejectPromise) => {
    probe = spawn(process.execPath, ["--import", "tsx", "scripts/wasm-active-failover.mjs"], {
      cwd: appDir,
      env: {
        ...process.env,
        NTERACT_CLOUD_URL: `http://${publicHost}:${primaryPort}`,
        NOTEBOOK_CLOUD_FAILOVER_URL: `http://${publicHost}:${failoverPort}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let killed = false;
    let lineBuffer = "";
    probe.stdout.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stdout += text;
      logs.probe = bounded(`${logs.probe}${text}`, 128 * 1024);
      lineBuffer += text;
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() || "";
      for (const line of lines) {
        const event = parseJson(line);
        if (!killed && event?.event === "failover_ready") {
          killed = true;
          primary.kill("SIGKILL");
        }
      }
    });
    probe.stderr.on("data", (chunk) => {
      logs.probe = bounded(`${logs.probe}${chunk.toString("utf8")}`, 128 * 1024);
    });
    probe.on("error", rejectPromise);
    probe.on("exit", (code, signal) => {
      if (code !== 0) {
        rejectPromise(new Error(`active failover probe failed (${code ?? signal}): ${logs.probe}`));
        return;
      }
      const result = parseTrailingJson(stdout);
      if (!killed || result?.ok !== true) {
        rejectPromise(
          new Error("active failover probe did not reach its failure and recovery gates"),
        );
        return;
      }
      resolvePromise(result);
    });
  });
}

async function waitForHealth(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`${url} returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`CellD node did not become healthy: ${lastError?.message ?? url}`);
}

async function gitHead() {
  const child = spawn("git", ["rev-parse", "HEAD"], {
    cwd: workspaceRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const code = await new Promise((resolvePromise) => child.on("exit", resolvePromise));
  if (code !== 0) throw new Error(`git rev-parse failed: ${stderr}`);
  return stdout.trim();
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") continue;
    if (!token.startsWith("--")) throw new Error(`unexpected argument ${token}`);
    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`--${key} requires a value`);
    parsed[key] = value;
    index += 1;
  }
  return parsed;
}

function required(values, key) {
  const value = values[key];
  if (!value) throw new Error(`--${key} is required`);
  return value;
}

function numeric(value, key) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`--${key} must be a TCP port`);
  }
  return parsed;
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function parseTrailingJson(stdout) {
  const text = stdout.trim();
  for (
    let start = text.lastIndexOf("\n{");
    start >= -1;
    start = text.lastIndexOf("\n{", start - 1)
  ) {
    const parsed = parseJson(text.slice(start + 1));
    if (parsed) return parsed;
    if (start === -1) break;
  }
  throw new Error(`probe produced no trailing JSON result: ${text.slice(-500)}`);
}

function bounded(value, maxLength) {
  return value.length <= maxLength ? value : value.slice(value.length - maxLength);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function relativeToWorkspace(path) {
  return path.startsWith(`${workspaceRoot}/`) ? path.slice(workspaceRoot.length + 1) : path;
}
