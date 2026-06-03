#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const smokeProjectPrefix = "/tmp/runt-ssh-runtime-agent-smoke-";
const smokePyproject = `[project]
name = "runt-ssh-runtime-agent-smoke"
version = "0.0.0"
requires-python = ">=3.11"
dependencies = ["ipykernel"]
`;

function parseArgs(argv) {
  const options = {
    sshHost: process.env.RUNTIMED_SSH_RUNTIME_HOST ?? "lab2",
    remoteCommand:
      process.env.RUNTIMED_SSH_RUNTIME_COMMAND ?? "/usr/local/bin/runtimed-nightly",
    runtimedBin:
      process.env.RUNTIMED_SMOKE_RUNTIMED_BIN ?? path.join(repoRoot, "target/debug/runtimed"),
    runtimeAgentExe:
      process.env.RUNTIMED_SMOKE_RUNTIME_AGENT_EXE ??
      path.join(repoRoot, "scripts/ssh-runtime-agent"),
    workingDir:
      process.env.RUNTIMED_SSH_RUNTIME_WORKING_DIR ??
      `${smokeProjectPrefix}${process.pid}`,
    timeoutMs: Number(process.env.RUNTIMED_SSH_RUNTIME_SMOKE_TIMEOUT_MS ?? 120000),
    keepTemp: process.env.RUNTIMED_SSH_RUNTIME_SMOKE_KEEP_TEMP === "1",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const readValue = () => {
      const value = argv[index + 1];
      if (!value) {
        throw new Error(`${arg} requires a value`);
      }
      index += 1;
      return value;
    };

    if (arg === "--") {
      continue;
    } else if (arg === "--ssh-host") {
      options.sshHost = readValue();
    } else if (arg === "--remote-command") {
      options.remoteCommand = readValue();
    } else if (arg === "--runtimed-bin") {
      options.runtimedBin = path.resolve(readValue());
    } else if (arg === "--runtime-agent-exe") {
      options.runtimeAgentExe = path.resolve(readValue());
    } else if (arg === "--working-dir") {
      options.workingDir = readValue();
    } else if (arg === "--timeout-ms") {
      options.timeoutMs = Number(readValue());
    } else if (arg === "--keep-temp") {
      options.keepTemp = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: smoke-ssh-runtime-agent.mjs [options]

Options:
  --ssh-host <host>             SSH host to run the runtime agent on (default: lab2)
  --remote-command <path>       Remote runtimed binary (default: /usr/local/bin/runtimed-nightly)
  --runtimed-bin <path>         Local runtimed binary (default: target/debug/runtimed)
  --runtime-agent-exe <path>    Local SSH runtime-agent wrapper
  --working-dir <path>          Notebook working dir visible locally and remotely
                                (default: /tmp/runt-ssh-runtime-agent-smoke-<pid>)
  --timeout-ms <ms>             Execution timeout (default: 120000)
  --keep-temp                   Keep temporary smoke state after success
`);
      process.exit(0);
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }

  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error("--timeout-ms must be a positive number");
  }

  return options;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDaemon(rt, socketPath, daemon, deadlineMs) {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    if (daemon.exitCode !== null) {
      throw new Error(`runtimed exited before becoming ready (code ${daemon.exitCode})`);
    }
    try {
      await rt.listActiveNotebooks({ socketPath });
      return;
    } catch {
      await sleep(200);
    }
  }
  throw new Error(`timed out waiting for runtimed socket ${socketPath}`);
}

function collectOutputText(result) {
  return result.outputs
    .map((output) => {
      if (typeof output.text === "string") {
        return output.text;
      }
      if (typeof output.dataJson === "string") {
        return output.dataJson;
      }
      return "";
    })
    .join("");
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function prepareSharedProject(options) {
  fs.mkdirSync(options.workingDir, { recursive: true });
  fs.writeFileSync(path.join(options.workingDir, "pyproject.toml"), smokePyproject);

  const remotePyproject = path.posix.join(options.workingDir, "pyproject.toml");
  const remoteCommand = `mkdir -p ${shellQuote(options.workingDir)} && cat > ${shellQuote(
    remotePyproject,
  )}`;
  const remote = spawnSync(
    "ssh",
    [
      "-o",
      "BatchMode=yes",
      options.sshHost,
      remoteCommand,
    ],
    {
      input: smokePyproject,
      encoding: "utf8",
    },
  );
  if (remote.status !== 0) {
    throw new Error(
      `failed to prepare remote working dir ${options.workingDir}: ${
        remote.stderr || remote.stdout
      }`,
    );
  }
}

function cleanupSharedProject(options) {
  if (!options.workingDir.startsWith(smokeProjectPrefix)) {
    return;
  }
  fs.rmSync(options.workingDir, { recursive: true, force: true });
  spawnSync(
    "ssh",
    [
      "-o",
      "BatchMode=yes",
      options.sshHost,
      "rm",
      "-rf",
      "--",
      options.workingDir,
    ],
    { stdio: "ignore" },
  );
}

async function stopDaemon(daemon) {
  if (!daemon || daemon.exitCode !== null) {
    return;
  }
  daemon.kill("SIGTERM");
  const exited = once(daemon, "exit");
  const timedOut = sleep(5000).then(() => {
    if (daemon.exitCode === null) {
      daemon.kill("SIGKILL");
    }
  });
  await Promise.race([exited, timedOut]);
}

function tail(filePath, maxBytes = 16000) {
  if (!fs.existsSync(filePath)) {
    return "";
  }
  const stat = fs.statSync(filePath);
  const start = Math.max(0, stat.size - maxBytes);
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    return buffer.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(options.runtimedBin)) {
    throw new Error(`local runtimed binary not found: ${options.runtimedBin}`);
  }
  if (!fs.existsSync(options.runtimeAgentExe)) {
    throw new Error(`runtime-agent wrapper not found: ${options.runtimeAgentExe}`);
  }

  const rt = require(path.join(repoRoot, "packages/runtimed-node/src/index.cjs"));
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "runt-ssh-runtime-agent-"));
  const workspaceDir = path.join(tempDir, "workspace");
  const socketPath = path.join(tempDir, "runtimed.sock");
  const logPath = path.join(tempDir, "runtimed-child.log");
  fs.mkdirSync(workspaceDir, { recursive: true });

  const logFd = fs.openSync(logPath, "a");
  let daemon = null;
  let session = null;

  try {
    prepareSharedProject(options);

    daemon = spawn(
      options.runtimedBin,
      [
        "--dev",
        "run",
        "--socket",
        socketPath,
        "--cache-dir",
        path.join(tempDir, "cache"),
        "--blob-store-dir",
        path.join(tempDir, "blobs"),
        "--settings-json",
        path.join(tempDir, "settings.json"),
        "--runtime-agent-exe",
        options.runtimeAgentExe,
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          RUNTIMED_DEV: "1",
          RUNTIMED_WORKSPACE_PATH: workspaceDir,
          RUNTIMED_SSH_RUNTIME_HOST: options.sshHost,
          RUNTIMED_SSH_RUNTIME_COMMAND: options.remoteCommand,
          RUST_LOG: process.env.RUST_LOG ?? "info",
        },
        stdio: ["ignore", logFd, logFd],
      },
    );

    await waitForDaemon(rt, socketPath, daemon, Math.min(options.timeoutMs, 30000));

    session = await rt.createNotebook({
      socketPath,
      runtime: "python",
      workingDir: options.workingDir,
      environmentMode: "project",
      description: "ssh runtime-agent smoke",
    });

    const result = await session.runCell(
      `import socket, platform
print(socket.gethostname())
print(platform.platform())
`,
      { timeoutMs: options.timeoutMs },
    );
    const text = collectOutputText(result);

    if (result.status !== "done" || !result.success) {
      throw new Error(`execution did not complete successfully: ${JSON.stringify(result)}`);
    }
    if (!text.includes(options.sshHost)) {
      throw new Error(`execution output did not include ${options.sshHost}: ${text}`);
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          socketPath,
          notebookId: session.notebookId,
          sshHost: options.sshHost,
          remoteCommand: options.remoteCommand,
          workingDir: options.workingDir,
          output: text.trim(),
          tempDir: options.keepTemp ? tempDir : undefined,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(error);
    console.error(`\nSmoke temp dir: ${tempDir}`);
    console.error(`\nDaemon log tail:\n${tail(logPath)}`);
    process.exitCode = 1;
  } finally {
    if (session) {
      try {
        await session.shutdownNotebook();
      } catch {
        // The daemon may already be shutting down.
      }
      try {
        await session.close();
      } catch {
        // Best-effort cleanup only.
      }
    }
    await stopDaemon(daemon);
    fs.closeSync(logFd);
    if (!options.keepTemp && process.exitCode !== 1) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      cleanupSharedProject(options);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
