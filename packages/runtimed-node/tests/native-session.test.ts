// @vitest-environment node
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import type { ExecutionViewChangeset } from "../src/index";

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
    ];
    try {
      await session.createCell("value = 42");
      await expect.poll(() => Object.keys(events).sort()).toEqual(["cell", "execution", "runtime"]);
      for (const value of Object.values(events)) expect(typeof value).toBe("string");
      expect(JSON.parse(events.cell as string)).toBeNull();
      expect(JSON.parse(events.execution as string)).toHaveProperty("queue");
      expect(JSON.parse(events.runtime as string)).toBeTypeOf("object");
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
