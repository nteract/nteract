import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = resolve(appDir, "../..");
const args = parseArgs(process.argv.slice(2));
const baseUrl = required(args, "base-url");
const candidate = required(args, "candidate");
const outputPath = resolve(workspaceRoot, required(args, "output"));
const manifestPath = resolve(appDir, args.manifest || "dist-portable/manifest.json");
const configPath = args.config ? resolve(workspaceRoot, args.config) : undefined;
const requestedScenarios = arrayValue(args.scenario);

if (requestedScenarios.length === 0) {
  throw new Error("At least one --scenario is required");
}

const knownScenarios = new Set(["roundtrip", "ingress", "reopen"]);
for (const scenario of requestedScenarios) {
  if (!knownScenarios.has(scenario)) {
    throw new Error(`Unknown scenario ${scenario}; expected roundtrip, ingress, or reopen`);
  }
}

const sourceCommit = commandOutput("git", ["rev-parse", "HEAD"], workspaceRoot);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const startedAt = new Date();
const scenarios = [];
let roundtripResult;

for (const name of requestedScenarios) {
  const scenarioStarted = performance.now();
  const env = {
    ...process.env,
    NTERACT_CLOUD_URL: baseUrl,
  };
  let script;

  if (name === "roundtrip") {
    script = "wasm-roundtrip.mjs";
  } else if (name === "ingress") {
    script = "websocket-ingress-probe.mjs";
  } else {
    script = "wasm-reopen.mjs";
    const roomId = args["reopen-room-id"] || roundtripResult?.roomId;
    if (!roomId) {
      throw new Error("reopen requires --reopen-room-id or an earlier roundtrip scenario");
    }
    env.NOTEBOOK_CLOUD_REOPEN_ROOM_ID = roomId;
    if (args["reopen-cell-id"]) {
      env.NOTEBOOK_CLOUD_REOPEN_CELL_ID = args["reopen-cell-id"];
    }
    if (args["reopen-source"]) {
      env.NOTEBOOK_CLOUD_REOPEN_SOURCE = args["reopen-source"];
    }
  }

  const run = spawnSync(process.execPath, ["--import", "tsx", resolve(appDir, "scripts", script)], {
    cwd: appDir,
    env,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  const elapsedMs = roundedMs(performance.now() - scenarioStarted);
  const log = {
    stdout: run.stdout || "",
    stderr: run.stderr || "",
    exitCode: run.status,
    signal: run.signal,
  };
  const parsed = run.status === 0 ? parseTrailingJson(run.stdout) : undefined;
  const result = {
    name,
    ok: run.status === 0 && parsed?.ok === true,
    elapsed_ms: elapsedMs,
    result: parsed,
    log,
  };
  scenarios.push(result);
  if (name === "roundtrip") {
    roundtripResult = parsed;
  }
  if (!result.ok && !args["continue-on-failure"]) {
    break;
  }
}

const completedAt = new Date();
const bundle = {
  schema_version: 1,
  candidate: {
    name: candidate,
    version: args["candidate-version"] || null,
    commit: args["candidate-commit"] || null,
  },
  nteract: {
    commit: sourceCommit,
    artifact_manifest_path: relativeToWorkspace(manifestPath),
    artifact_manifest_sha256: sha256(readFileSync(manifestPath)),
    artifact: manifest,
  },
  configuration: {
    path: configPath ? relativeToWorkspace(configPath) : null,
    sha256: configPath ? sha256(readFileSync(configPath)) : null,
  },
  target: {
    base_url: redactUrl(baseUrl),
  },
  run: {
    started_at: startedAt.toISOString(),
    completed_at: completedAt.toISOString(),
    elapsed_ms: completedAt.getTime() - startedAt.getTime(),
    host_platform: process.platform,
    host_arch: process.arch,
    node_version: process.version,
  },
  scenarios,
  summary: {
    ok:
      scenarios.length === requestedScenarios.length && scenarios.every((scenario) => scenario.ok),
    requested: requestedScenarios,
    completed: scenarios.map((scenario) => scenario.name),
    passed: scenarios.filter((scenario) => scenario.ok).map((scenario) => scenario.name),
    failed: scenarios.filter((scenario) => !scenario.ok).map((scenario) => scenario.name),
  },
};

await mkdir(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(bundle, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ ok: bundle.summary.ok, output: outputPath, summary: bundle.summary }));
process.exitCode = bundle.summary.ok ? 0 : 1;

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") {
      continue;
    }
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected argument ${token}`);
    }
    const name = token.slice(2);
    const next = argv[index + 1];
    const value = next && !next.startsWith("--") ? argv[++index] : true;
    if (result[name] === undefined) {
      result[name] = value;
    } else if (Array.isArray(result[name])) {
      result[name].push(value);
    } else {
      result[name] = [result[name], value];
    }
  }
  return result;
}

function required(values, name) {
  const value = values[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`--${name} is required`);
  }
  return value;
}

function arrayValue(value) {
  if (value === undefined) return [];
  return Array.isArray(value) ? value.map(String) : [String(value)];
}

function parseTrailingJson(stdout) {
  const text = String(stdout || "").trim();
  for (
    let start = text.lastIndexOf("\n{");
    start >= -1;
    start = text.lastIndexOf("\n{", start - 1)
  ) {
    const candidate = text.slice(start + 1);
    try {
      return JSON.parse(candidate);
    } catch {
      if (start === -1) break;
    }
  }
  throw new Error(`Scenario completed without a trailing JSON result: ${text.slice(-500)}`);
}

function commandOutput(command, commandArgs, cwd) {
  const run = spawnSync(command, commandArgs, { cwd, encoding: "utf8" });
  if (run.status !== 0) {
    throw new Error(`${command} ${commandArgs.join(" ")} failed: ${run.stderr}`);
  }
  return run.stdout.trim();
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function roundedMs(value) {
  return Math.round(value * 100) / 100;
}

function relativeToWorkspace(path) {
  return path.startsWith(`${workspaceRoot}/`) ? path.slice(workspaceRoot.length + 1) : path;
}

function redactUrl(value) {
  const url = new URL(value);
  url.username = "";
  url.password = "";
  return url.toString();
}
