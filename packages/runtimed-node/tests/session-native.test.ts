import { createRequire } from "node:module";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

const require = createRequire(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const runNativeIntegration = process.env.RUNTIMED_NODE_NATIVE_INTEGRATION === "1";
const describeNative = runNativeIntegration ? describe : describe.skip;

type Output = {
  outputType: string;
  name?: string;
  text?: string;
  dataJson?: string;
  blobPathsJson?: string;
};

type Session = {
  sessionStatus$: {
    subscribe(observer: {
      next?: (status: { connection: "connected" | "disconnected" }) => void;
    }): { unsubscribe(): void };
  };
  createCell(
    source: string,
    options?: { cellId?: string; cellType?: "code" | "markdown" },
  ): Promise<string>;
  approveTrust(): Promise<void>;
  queueExistingCell(
    cellId: string,
    options?: { executionId?: string },
  ): Promise<{ cellId: string; executionId: string }>;
  waitForExecution(
    executionId: string,
    options?: { cellId?: string; timeoutMs?: number },
  ): Promise<unknown>;
  getCellOutputs(cellId: string): Promise<Output[] | null>;
  close(): Promise<void>;
  shutdownNotebook(): Promise<boolean>;
};

type RuntimedNode = {
  openNotebookPath(
    notebookPath: string,
    options: { socketPath: string; peerLabel: string },
  ): Promise<Session>;
};

let daemon: ChildProcess | undefined;
let root = "";
let socketPath = "";
let notebookPath = "";
const environmentCache =
  process.env.RUNTIMED_NODE_TEST_CACHE ?? path.join(os.tmpdir(), "runtimed-node-native-env-cache");
let api: RuntimedNode | undefined;
const sessions: Session[] = [];

function runtimeApi(): RuntimedNode {
  if (!api) throw new Error("native integration is not initialized");
  return api;
}

async function openSession(): Promise<Session> {
  const session = await runtimeApi().openNotebookPath(notebookPath, {
    socketPath,
    peerLabel: "runtimed-node-native-test",
  });
  sessions.push(session);
  await waitForConnectedStatus(session);
  return session;
}

async function waitForConnectedStatus(session: Session): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("timed out waiting for native connected session status")),
      10_000,
    );
    session.sessionStatus$.subscribe({
      next: (status) => {
        if (status.connection !== "connected") return;
        clearTimeout(timeout);
        resolve();
      },
    });
  });
}

async function waitForSocket(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(socketPath)) return;
    if (daemon?.exitCode !== null) {
      throw new Error(`runtimed exited before creating its socket (${daemon?.exitCode})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for runtimed socket at ${socketPath}`);
}

async function executeWhenReady(session: Session, cellId: string): Promise<string> {
  const deadline = Date.now() + 120_000;
  const executionId = randomUUID();
  while (true) {
    try {
      const queued = await session.queueExistingCell(cellId, { executionId });
      expect(queued.cellId).toBe(cellId);
      expect(queued.executionId).toBe(executionId);
      await expect(session.queueExistingCell(cellId, { executionId })).resolves.toEqual(queued);
      await session.waitForExecution(queued.executionId, { cellId, timeoutMs: 180_000 });
      await expect(session.queueExistingCell(cellId, { executionId })).resolves.toEqual(queued);
      return executionId;
    } catch (error) {
      if (!String(error).includes("pool empty") || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

describeNative("@runtimed/node native session outputs", () => {
  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "runtimed-node-session-"));
    socketPath = path.join(root, "runtimed.sock");
    notebookPath = path.join(root, "analysis.ipynb");
    fs.writeFileSync(
      notebookPath,
      JSON.stringify({
        cells: [],
        metadata: {
          kernelspec: { display_name: "Python 3", language: "python", name: "python3" },
        },
        nbformat: 4,
        nbformat_minor: 5,
      }),
    );
    const binary = path.join(repositoryRoot, "target/debug/runtimed");
    if (!fs.existsSync(binary)) {
      throw new Error("Build the daemon with `cargo build -p runtimed` before this test.");
    }
    daemon = spawn(
      binary,
      [
        "run",
        "--socket",
        socketPath,
        "--cache-dir",
        environmentCache,
        "--blob-store-dir",
        path.join(root, "blobs"),
        "--uv-pool-size",
        "1",
        "--conda-pool-size",
        "0",
        "--pixi-pool-size",
        "0",
        "--log-level",
        "warn",
      ],
      { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
    );
    await waitForSocket();
    api = require("../src/index.cjs") as RuntimedNode;
  }, 90_000);

  afterAll(async () => {
    for (const session of sessions.splice(0).reverse()) {
      await session.close().catch(() => undefined);
    }
    daemon?.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      if (!daemon || daemon.exitCode !== null) return resolve();
      const timeout = setTimeout(() => {
        daemon?.kill("SIGKILL");
        resolve();
      }, 5_000);
      daemon.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it("distinguishes missing and empty cells, then resolves durable outputs after reopen", async () => {
    const first = await openSession();
    await expect(first.getCellOutputs("missing-cell")).resolves.toBeNull();

    const retriedCellId = "cell-native-idempotent-create";
    await expect(
      first.createCell("# stable retry", {
        cellId: retriedCellId,
        cellType: "markdown",
      }),
    ).resolves.toBe(retriedCellId);
    await expect(
      first.createCell("# stable retry", {
        cellId: retriedCellId,
        cellType: "markdown",
      }),
    ).resolves.toBe(retriedCellId);
    await expect(
      first.createCell("# conflicting retry", {
        cellId: retriedCellId,
        cellType: "markdown",
      }),
    ).rejects.toThrow("already exists with different content");

    const emptyCell = await first.createCell("# no outputs", { cellType: "markdown" });
    await expect(first.getCellOutputs(emptyCell)).resolves.toEqual([]);

    const executedCell = await first.createCell(
      [
        "from IPython.display import display",
        "print(6 * 7)",
        'display({"text/plain": "durable-rich", "application/octet-stream": b"x" * 131072}, raw=True)',
      ].join("\n"),
      { cellType: "code" },
    );
    await first.approveTrust();
    const executionId = await executeWhenReady(first, executedCell);
    const anotherCell = await first.createCell("print('must not run')", { cellType: "code" });
    await expect(first.queueExistingCell(anotherCell, { executionId })).rejects.toThrow(
      /AlreadyExists/,
    );
    await first.close();
    sessions.splice(sessions.indexOf(first), 1);

    const reopened = await openSession();
    const outputs = await reopened.getCellOutputs(executedCell);
    expect(outputs).not.toBeNull();
    expect(outputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ outputType: "stream", name: "stdout", text: "42\n" }),
      ]),
    );
    const rich = outputs?.find((output) => output.outputType === "display_data");
    expect(rich?.dataJson).toContain("durable-rich");
    expect(rich?.dataJson).toContain("application/octet-stream");
    expect(rich?.blobPathsJson).toBeDefined();
  }, 240_000);
});
