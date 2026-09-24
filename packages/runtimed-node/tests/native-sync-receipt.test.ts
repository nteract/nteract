// @vitest-environment node
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../../..", import.meta.url));
const nativeEnabled = process.env.RUNTIMED_NODE_NATIVE_INTEGRATION === "1";

describe.skipIf(!nativeEnabled)("native NotebookDoc sync receipts", () => {
  let rt: typeof import("../src/index");
  let directory: string;
  let socketPath: string;
  let daemon: ChildProcess;
  let exited: Promise<unknown>;

  beforeAll(async () => {
    rt = require("../src/index.cjs");
    const relay: typeof import("../src/relay") = require("../src/relay.cjs");
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "runt-receipt-"));
    socketPath = path.join(directory, "daemon.sock");
    const binary = path.resolve(
      root,
      process.env.CARGO_TARGET_DIR ?? "target",
      "debug",
      process.platform === "win32" ? "runtimed.exe" : "runtimed",
    );
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
    let logs = "";
    daemon.stdout?.on("data", (chunk: Buffer) => {
      logs = (logs + chunk).slice(-8000);
    });
    daemon.stderr?.on("data", (chunk: Buffer) => {
      logs = (logs + chunk).slice(-8000);
    });
    await vi.waitFor(
      async () => {
        if (daemon.exitCode !== null) throw new Error(`Daemon exited: ${logs}`);
        expect(await relay.queryDaemonInfo({ socketPath })).toBeTruthy();
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

  it("confirms an edit that an independent peer can read", async () => {
    const owner = await rt.createNotebook({ socketPath, workingDir: directory, dependencies: [] });
    const peer = await rt.openNotebook(owner.notebookId, { socketPath });
    try {
      const id = await owner.createCell("accepted = 42");
      const heads: string[] = await owner.confirmNotebookSync();
      expect(heads.length).toBeGreaterThan(0);
      for (const head of heads) expect(head).toMatch(/^[0-9a-f]{64}$/);
      await expect.poll(async () => (await peer.getCell(id))?.source).toBe("accepted = 42");
    } finally {
      await peer.close();
      await owner.shutdownNotebook();
      await owner.close();
    }
  });

  it("rejects unsupported receipts without closing and cancels withheld receipts on close", async () => {
    const owner = await rt.createNotebook({ socketPath, workingDir: directory, dependencies: [] });
    const proxyPath = path.join(directory, "proxy.sock");
    const sockets = new Set<net.Socket>();
    let withhold = true;
    let receiptSeen = false;
    let advertisedReceipt: boolean | undefined;
    const proxy = net.createServer((client) => {
      const upstream = net.createConnection(socketPath);
      sockets.add(client);
      sockets.add(upstream);
      client.on("error", () => upstream.destroy());
      upstream.on("error", () => client.destroy());
      client.on("close", () => {
        sockets.delete(client);
        upstream.destroy();
      });
      upstream.on("close", () => {
        sockets.delete(upstream);
        client.destroy();
      });
      client.pipe(upstream);
      let pending = Buffer.alloc(0);
      upstream.on("data", (chunk: Buffer) => {
        pending = Buffer.concat([pending, chunk]);
        while (pending.length >= 4 && pending.length >= 4 + pending.readUInt32BE(0)) {
          const frame = pending.subarray(0, 4 + pending.readUInt32BE(0));
          pending = pending.subarray(frame.length);
          if (advertisedReceipt !== true && frame[4] === 7) {
            const bootstrap: { notebook_sync_receipt?: boolean } = JSON.parse(
              frame.subarray(5).toString(),
            );
            bootstrap.notebook_sync_receipt = advertisedReceipt;
            const payload = Buffer.from(JSON.stringify(bootstrap));
            const header = Buffer.alloc(5);
            header.writeUInt32BE(payload.length + 1);
            header[4] = 7;
            client.write(Buffer.concat([header, payload]));
            continue;
          }
          if (frame[4] === 2) {
            const response: { result?: string } = JSON.parse(frame.subarray(5).toString());
            if (withhold && response.result === "notebook_sync_acknowledged") {
              receiptSeen = true;
              continue;
            }
          }
          client.write(frame);
        }
      });
    });
    proxy.listen(proxyPath);
    await once(proxy, "listening");
    let legacy: import("../src/index").Session | undefined;
    let old: import("../src/index").Session | undefined;
    let replacement: import("../src/index").Session | undefined;
    try {
      for (const supported of [undefined, false]) {
        advertisedReceipt = supported;
        legacy = await rt.openNotebook(owner.notebookId, { socketPath: proxyPath });
        await expect(legacy.confirmNotebookSync()).rejects.toThrow(/does not support/i);
        expect(receiptSeen).toBe(false);
        const id = await legacy.createCell("session_still_works = True");
        await expect
          .poll(async () => (await owner.getCell(id))?.source)
          .toBe("session_still_works = True");
        await legacy.close();
      }
      advertisedReceipt = true;
      old = await rt.openNotebook(owner.notebookId, { socketPath: proxyPath });
      await old.createCell("ack_is_withheld = True");
      let settled = false;
      const receipt = old.confirmNotebookSync();
      const rejection = expect(receipt).rejects.toThrow(/closed/i);
      void receipt.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await vi.waitFor(() => expect(receiptSeen).toBe(true));
      expect(settled).toBe(false);
      await old.close();
      await rejection;
      withhold = false;
      replacement = await rt.openNotebook(owner.notebookId, { socketPath: proxyPath });
      expect((await replacement.confirmNotebookSync()).length).toBeGreaterThan(0);
    } finally {
      await legacy?.close();
      await old?.close();
      await replacement?.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
      await owner.shutdownNotebook();
      await owner.close();
    }
  });
});
