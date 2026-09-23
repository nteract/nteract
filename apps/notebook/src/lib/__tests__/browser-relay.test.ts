// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { createServer, type ViteDevServer } from "vite-plus";
import WebSocket from "ws";
import { browserDevRelayPlugin } from "../../../vite-plugin-browser-relay";

function framed(payload: Buffer | object) {
  const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(bytes.length);
  return Buffer.concat([header, bytes]);
}

describe("browser relay bootstrap ordering", () => {
  const cleanup: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    for (const dispose of cleanup.reverse()) await dispose();
    cleanup.length = 0;
    vi.unstubAllEnvs();
  });

  async function connect(closeAfterBootstrap: boolean, oversized = false) {
    const root = await mkdtemp(path.join(os.tmpdir(), "relay-test-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const socketPath = path.join(root, "daemon.sock");
    vi.stubEnv("RUNTIMED_SOCKET_PATH", socketPath);
    const terminal = Buffer.concat([
      Buffer.from([0x07]),
      Buffer.from(JSON.stringify({ type: "sync_status", notebook_doc: "pending", runtime_state: "pending", initial_load: { phase: "failed", reason: "Permission denied" } })),
    ]);
    const sockets = new Set<net.Socket>();
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const daemon = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      let buffered = Buffer.alloc(0);
      let preamble = true;
      socket.on("data", (chunk) => {
        buffered = Buffer.concat([buffered, chunk]);
        if (preamble) {
          if (buffered.length < 5) return;
          buffered = buffered.subarray(5);
          preamble = false;
        }
        while (buffered.length >= 4 && buffered.length >= 4 + buffered.readUInt32BE(0)) {
          const size = buffered.readUInt32BE(0);
          const request = JSON.parse(buffered.subarray(4, 4 + size).toString());
          buffered = buffered.subarray(4 + size);
          if (request.channel === "open_notebook") {
            // Send handshake + terminal status in one write, while the relay is
            // about to await a separate metadata query. No timing guess needed.
            const oversizedHeader = Buffer.alloc(4);
            oversizedHeader.writeUInt32BE(100 * 1024 * 1024 + 1);
            const response = Buffer.concat([
              framed({ notebook_id: "unreadable", ephemeral: false,
                capabilities: { actor_label: "local:test/browser", connection_scope: "viewer" } }),
              oversized ? oversizedHeader : framed(terminal),
            ]);
            if (closeAfterBootstrap) socket.end(response);
            else socket.write(response);
          } else if (request.type === "get_daemon_info") {
            const timer = setTimeout(() => {
              timers.delete(timer);
              socket.end(framed({ type: "daemon_info", daemon_version: "test" }));
            }, 50);
            timers.add(timer);
          }
        }
      });
    });
    daemon.listen(socketPath);
    await once(daemon, "listening");
    cleanup.push(async () => {
      for (const timer of timers) clearTimeout(timer);
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => daemon.close(() => resolve()));
    });
    const vite: ViteDevServer = await createServer({
      configFile: false, root, logLevel: "silent",
      plugins: [browserDevRelayPlugin({ repoRoot: root })],
      server: { host: "127.0.0.1", port: 0 },
    });
    await vite.listen();
    cleanup.push(() => vite.close());
    const address = vite.httpServer!.address() as net.AddressInfo;
    const origin = `http://127.0.0.1:${address.port}`;
    const config = await (await fetch(`${origin}/__nteract_dev_relay/config`)).json();
    const url = new URL(config.websocket_url);
    url.searchParams.set("token", config.token);
    url.searchParams.set("path", "/unreadable.ipynb");
    const ws = new WebSocket(url, { origin });
    cleanup.push(async () => { ws.terminate(); });
    const messages: Array<object | Buffer> = [];
    ws.on("message", (data, binary) => messages.push(binary ? Buffer.from(data as Buffer) : JSON.parse(data.toString())));
    await once(ws, "open");
    return { ws, messages, terminal };
  }

  it("retains post-handshake frames until forwarding is installed", async () => {
    const { messages, terminal } = await connect(false);
    await vi.waitFor(() => expect(messages).toHaveLength(2));
    expect(messages[0]).toMatchObject({ type: "ready", payload: { connection_scope: "viewer" } });
    expect(messages[1]).toEqual(terminal);
  });

  it("delivers viewer scope and terminal status before disconnect when the daemon closes during bootstrap", async () => {
    const { ws, messages, terminal } = await connect(true);
    await once(ws, "close");
    expect(messages).toHaveLength(3);
    expect(messages[0]).toMatchObject({ type: "ready", payload: { connection_scope: "viewer" } });
    expect(messages[1]).toEqual(terminal);
    expect(messages[2]).toEqual({ type: "disconnected" });
  });

  it("reports a buffered malformed frame and closes without an unhandled forwarding error", async () => {
    const { ws, messages } = await connect(false, true);
    await once(ws, "close");
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ type: "ready" });
    expect(messages[1]).toMatchObject({ type: "unavailable", payload: { reason: "daemon_frame_error", message: expect.stringContaining("daemon frame too large") } });
  });
});
