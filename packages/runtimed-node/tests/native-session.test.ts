// @vitest-environment node
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import type { ExecutionViewChangeset, SessionStatus } from "../src/index";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../../..", import.meta.url));
const nativeEnabled = process.env.RUNTIMED_NODE_NATIVE_INTEGRATION === "1";
const executionEnabled = process.env.RUNTIMED_NODE_EXECUTION_INTEGRATION === "1";

describe.skipIf(!nativeEnabled)("@runtimed/node daemon-backed events", () => {
  let rt: typeof import("../src/index");
  let binding: typeof import("../src/binding");
  let directory: string;
  let socketPath: string;
  let daemon: ChildProcess | undefined;
  let exited: Promise<unknown> | undefined;
  let logs = "";

  beforeAll(async () => {
    rt = require("../src/index.cjs");
    binding = require("../src/binding.cjs");
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "runt-node-"));
    socketPath = path.join(directory, "daemon.sock");
    const target = path.resolve(root, process.env.CARGO_TARGET_DIR ?? "target");
    const binary = path.join(
      target,
      "debug",
      process.platform === "win32" ? "runtimed.exe" : "runtimed",
    );
    if (!fs.existsSync(binary))
      throw new Error("Run cargo build -p runtimed before native session tests.");
    daemon = spawn(
      binary,
      [
        "--dev",
        "run",
        "--socket",
        socketPath,
        "--cache-dir",
        path.join(directory, "envs"),
        "--blob-store-dir",
        path.join(directory, "blobs"),
        "--settings-json",
        path.join(directory, "settings.json"),
        "--uv-pool-size",
        "0",
        "--conda-pool-size",
        "0",
        "--pixi-pool-size",
        "0",
      ],
      {
        cwd: directory,
        env: { ...process.env, RUNTIMED_DEV: "1", RUNTIMED_WORKSPACE_PATH: directory },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    exited = once(daemon, "exit");
    const record = (chunk: Buffer) => {
      logs = (logs + chunk.toString()).slice(-16000);
    };
    daemon.stdout?.on("data", record);
    daemon.stderr?.on("data", record);
    await vi.waitFor(
      async () => {
        if (daemon?.exitCode !== null) throw new Error(`Daemon exited before readiness: ${logs}`);
        expect(await binding.queryDaemonInfo({ socketPath })).toBeTruthy();
      },
      { timeout: 15000 },
    );
  }, 20000);

  afterAll(async () => {
    if (daemon && exited) {
      daemon.kill("SIGINT");
      await Promise.race([exited, delay(5000, undefined, { ref: false })]);
      if (daemon.exitCode === null && daemon.signalCode === null) {
        daemon.kill("SIGKILL");
        await exited;
      }
    }
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
  });

  it("delivers JSON strings through the actual N-API callbacks", async () => {
    const session = await binding.createNotebook({
      socketPath,
      dependencies: [],
      workingDir: directory,
    });
    const events: Record<string, unknown> = {};
    const subscriptions = [
      session.onRuntimeState((json) => {
        events.runtime = json;
      }),
      session.onExecutionViewChange((json) => {
        events.execution = json;
      }),
      session.onCellChange((json) => {
        events.cell = json;
      }),
      session.onSessionStatus((json) => {
        events.status = json;
      }),
    ];
    try {
      await session.createCell("value = 42");
      await expect
        .poll(() => Object.keys(events).sort())
        .toEqual(["cell", "execution", "runtime", "status"]);
      for (const value of Object.values(events)) expect(typeof value).toBe("string");
      expect(JSON.parse(events.cell as string)).toBeNull();
      expect(JSON.parse(events.execution as string)).toHaveProperty("queue");
      expect(JSON.parse(events.runtime as string)).toBeTypeOf("object");
      await expect
        .poll(() => JSON.parse(events.status as string))
        .toMatchObject({
          connection: "Connected",
          notebook_doc: "Interactive",
          runtime_state: "Ready",
          initial_load: "NotNeeded",
        } satisfies SessionStatus);
    } finally {
      for (const subscription of subscriptions) subscription.dispose();
      try {
        await session.shutdownNotebook();
      } finally {
        await session.close();
      }
    }
  });

  it("populates the shared store from native events before publishing them", async () => {
    const native = await binding.createNotebook({
      socketPath,
      dependencies: [],
      workingDir: directory,
    });
    const { Session } = require("../src/session.cjs") as {
      Session: new (native: import("../src/binding").Session) => import("../src/index").Session;
    };
    // Subscribe in the same JS turn as construction, before native callbacks run.
    const session = new Session(native);
    const observations: [unknown, unknown][] = [];
    const subscription = session.executionViewChanges$.subscribe((changeset) => {
      if (changeset.queue) observations.push([changeset.queue, session.getExecutionView().queue]);
    });
    try {
      await expect.poll(() => session.getExecutionView().queue).not.toBeNull();
      expect(session.getExecutionView().queue).toMatchObject({ queued_execution_ids: [] });
      await expect.poll(() => observations.length).toBeGreaterThan(0);
      for (const [event, snapshot] of observations) expect(snapshot).toEqual(event);
    } finally {
      subscription.unsubscribe();
      try {
        await session.shutdownNotebook();
      } finally {
        await session.close();
      }
    }
  });

  it.skipIf(!executionEnabled)(
    "tracks real reruns, progress and retained snapshots",
    async () => {
      const session = await rt.createNotebook({
        socketPath,
        dependencies: ["ipykernel"],
        workingDir: directory,
        packageManager: "uv",
        environmentMode: "notebook",
      });
      const changesets: ExecutionViewChangeset[] = [];
      const mismatches: string[] = [];
      const subscription = session.executionViewChanges$.subscribe((changeset) => {
        changesets.push(changeset);
        for (const [id, snapshot] of changeset.execution_upserts ?? []) {
          if (session.executions.getExecutionById(id)?.status !== snapshot.status)
            mismatches.push(id);
        }
      });
      try {
        const cell = await session.createCell("value = 40\nprint(value + 2)");
        const first = await session.executeCell(cell, { timeoutMs: 60000 });
        expect(first.success).toBe(true);
        await expect
          .poll(() => session.executions.getCellExecutionId(cell))
          .toBe(first.executionId);
        await expect
          .poll(() => session.executions.getExecutionById(first.executionId)?.status)
          .toBe("done");
        const retained = session.getExecutionView();
        expect(Object.isFrozen(retained.executions[first.executionId].output_ids)).toBe(true);
        await session.setCell(cell, { source: "print(value + 3)" });
        const second = await session.executeCell(cell, { timeoutMs: 60000 });
        expect(second.success).toBe(true);
        await expect
          .poll(() => session.executions.getCellExecutionId(cell))
          .toBe(second.executionId);
        expect(retained.cell_execution_ids[cell]).toBe(first.executionId);
        const progress: unknown[] = [];
        const streamed = await session.runCell(
          "import time\nprint('start', flush=True)\ntime.sleep(0.2)\nprint(value)",
          {
            timeoutMs: 60000,
            onUpdate: (value) => progress.push(value),
          },
        );
        expect(streamed.success).toBe(true);
        expect(progress.length).toBeGreaterThan(0);
        for (const update of progress) {
          expect(update).toMatchObject({
            cellId: streamed.cellId,
            executionId: streamed.executionId,
            status: expect.any(String),
          });
        }
        expect(changesets.some((change) => change.execution_upserts?.length)).toBe(true);
        expect(mismatches).toEqual([]);
      } finally {
        subscription.unsubscribe();
        try {
          await session.shutdownNotebook();
        } finally {
          await session.close();
        }
      }
    },
    120000,
  );
});

// The real binding talks to a controlled pool endpoint so old/new daemon
// metadata goes through Rust deserialization and the shared compatibility policy.
describe.skipIf(!nativeEnabled)("@runtimed/node daemon compatibility probe", () => {
  const compatible = {
    type: "daemon_info",
    protocol_version: 4,
    daemon_api_version: 1,
    daemon_version: "0.0.0+different-build",
    pid: 123,
    started_at: "2026-01-01T00:00:00Z",
    blob_port: 12345,
  };

  async function probe(response: Record<string, unknown>) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rnp-"));
    const socketPath =
      process.platform === "win32"
        ? `\\\\.\\pipe\\rnp-${randomUUID()}`
        : path.join(directory, "probe.sock");
    const requests: unknown[] = [];
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      let bytes = Buffer.alloc(0);
      let preambleRead = false;
      socket.on("data", (chunk) => {
        bytes = Buffer.concat([bytes, chunk]);
        if (!preambleRead) {
          if (bytes.length < 5) return;
          bytes = bytes.subarray(5);
          preambleRead = true;
        }
        while (bytes.length >= 4) {
          const length = bytes.readUInt32BE();
          if (bytes.length < length + 4) return;
          requests.push(JSON.parse(bytes.subarray(4, length + 4).toString()));
          bytes = bytes.subarray(length + 4);
          if (requests.length === 2) {
            const payload = Buffer.from(JSON.stringify(response));
            const header = Buffer.alloc(4);
            header.writeUInt32BE(payload.length);
            socket.end(Buffer.concat([header, payload]));
          }
        }
      });
    });
    try {
      server.listen(socketPath);
      await once(server, "listening");
      const api: typeof import("../src/relay") = require("../src/relay.cjs");
      const result = await api.queryDaemonInfo({ socketPath });
      expect(requests).toEqual([{ channel: "pool" }, { type: "get_daemon_info" }]);
      return { result, socketPath };
    } finally {
      for (const socket of sockets) socket.destroy();
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }

  it("preserves reported versions and accepts a different artifact build", async () => {
    const { result, socketPath } = await probe(compatible);
    expect(result).toMatchObject({
      version: compatible.daemon_version,
      protocolVersion: 4,
      daemonApiVersion: 1,
      socketPath,
      isDevMode: false,
      blobPort: 12345,
    });
    expect(result?.compatibilityError).toBeUndefined();
  });

  it.each([
    ["older wire", { protocol_version: 0 }, /wire protocol 0/],
    ["newer wire", { protocol_version: 99 }, /wire protocol 99/],
    ["missing semantic API", { daemon_api_version: undefined }, /daemon API 0 is older/],
    ["newer semantic API", { daemon_api_version: 99 }, /daemon API 99 is newer/],
  ])("reports %s without hiding the responding daemon", async (_name, overrides, diagnostic) => {
    const { result } = await probe({ ...compatible, ...overrides });
    expect(result).not.toBeNull();
    expect(result?.compatibilityError).toMatch(diagnostic);
    expect(result?.daemonApiVersion).toBe(
      "daemon_api_version" in overrides
        ? (overrides.daemon_api_version ?? 0)
        : compatible.daemon_api_version,
    );
  });

  it("returns null for unavailable metadata", async () => {
    const { result, socketPath } = await probe({ type: "error", message: "Unknown request" });
    expect(result).toBeNull();
    const api: typeof import("../src/relay") = require("../src/relay.cjs");
    await expect(api.queryDaemonInfo({ socketPath })).resolves.toBeNull();
  });
});
