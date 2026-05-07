import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import type { Plugin, ViteDevServer } from "vite-plus";

const CONFIG_PATH = "/__nteract_dev_relay/config";
const WS_PATH = "/__nteract_dev_relay/ws";
const MAGIC = [0xc0, 0xde, 0x01, 0xac] as const;
const PROTOCOL_VERSION = 4;
const MAX_FRAME_SIZE = 100 * 1024 * 1024;

interface DaemonInfoJson {
  version?: string;
  socket_path?: string;
  is_dev_mode?: boolean;
  blob_port?: number;
}

interface RelayOptions {
  repoRoot: string;
}

class LengthPrefixedFrames {
  private buffer = Buffer.alloc(0);
  private waiters: Array<{
    resolve: (frame: Buffer) => void;
    reject: (err: Error) => void;
  }> = [];
  private liveHandler: ((frame: Buffer) => void) | null = null;

  push(chunk: Buffer): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    this.drain();
  }

  readFrame(): Promise<Buffer> {
    const frame = this.shiftFrame();
    if (frame) return Promise.resolve(frame);
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  pipeTo(handler: (frame: Buffer) => void): void {
    this.liveHandler = handler;
    this.drain();
  }

  fail(err: Error): void {
    for (const waiter of this.waiters) waiter.reject(err);
    this.waiters = [];
  }

  private drain(): void {
    let frame: Buffer | null;
    while ((frame = this.shiftFrame())) {
      const waiter = this.waiters.shift();
      if (waiter) waiter.resolve(frame);
      else this.liveHandler?.(frame);
    }
  }

  private shiftFrame(): Buffer | null {
    if (this.buffer.length < 4) return null;
    const length = this.buffer.readUInt32BE(0);
    if (length > MAX_FRAME_SIZE) {
      throw new Error(`daemon frame too large: ${length} bytes`);
    }
    if (this.buffer.length < 4 + length) return null;
    const frame = this.buffer.subarray(4, 4 + length);
    this.buffer = this.buffer.subarray(4 + length);
    return frame;
  }
}

function cacheDir(): string {
  if (process.env.XDG_CACHE_HOME) return process.env.XDG_CACHE_HOME;
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Caches");
  if (process.platform === "win32") {
    return process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
  }
  return path.join(os.homedir(), ".cache");
}

function worktreeHash(repoRoot: string): string {
  return crypto.createHash("sha256").update(repoRoot).digest("hex").slice(0, 12);
}

function resolveSocketPath(repoRoot: string): string {
  if (process.env.RUNTIMED_SOCKET_PATH) return process.env.RUNTIMED_SOCKET_PATH;
  const namespace = process.env.RUNTIMED_CACHE_NAMESPACE ?? "runt-nightly";
  return path.join(cacheDir(), namespace, "worktrees", worktreeHash(repoRoot), "runtimed.sock");
}

function readDaemonInfo(socketPath: string): DaemonInfoJson | null {
  try {
    const daemonJson = path.join(path.dirname(socketPath), "daemon.json");
    return JSON.parse(fs.readFileSync(daemonJson, "utf8")) as DaemonInfoJson;
  } catch {
    return null;
  }
}

function writeFrame(socket: net.Socket, frame: Buffer | string): void {
  const payload = Buffer.isBuffer(frame) ? frame : Buffer.from(frame);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length, 0);
  socket.write(header);
  socket.write(payload);
}

function writePreamble(socket: net.Socket): void {
  socket.write(Buffer.from([...MAGIC, PROTOCOL_VERSION]));
}

function connectSocket(socketPath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Length", Buffer.byteLength(body));
  res.end(body);
}

function requestUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
}

function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function relayHandshake(url: URL, repoRoot: string): Record<string, unknown> {
  const notebookPath = url.searchParams.get("path");
  if (notebookPath) {
    return { channel: "open_notebook", path: notebookPath };
  }

  const notebookId = url.searchParams.get("notebook_id");
  const runtime = url.searchParams.get("runtime") ?? "python";
  const workingDir = url.searchParams.get("working_dir") ?? repoRoot;
  return {
    channel: "create_notebook",
    runtime,
    working_dir: workingDir,
    ...(notebookId ? { notebook_id: notebookId } : {}),
    ephemeral: true,
  };
}

function control(ws: WebSocket, value: unknown): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(value));
}

function binaryFromRaw(data: RawData): Buffer | null {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.concat(data);
  return null;
}

async function handleRelayConnection(
  ws: WebSocket,
  req: IncomingMessage,
  repoRoot: string,
  logger: ViteDevServer["config"]["logger"],
): Promise<void> {
  const socketPath = resolveSocketPath(repoRoot);
  const url = requestUrl(req);
  let daemon: net.Socket | null = null;

  try {
    daemon = await connectSocket(socketPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    control(ws, {
      type: "unavailable",
      payload: {
        reason: "daemon_socket_unavailable",
        message,
        guidance: "Start the dev daemon with `cargo xtask dev-daemon`.",
      },
    });
    ws.close(1011, "daemon unavailable");
    return;
  }

  const frames = new LengthPrefixedFrames();
  daemon.on("data", (chunk) => {
    try {
      frames.push(chunk);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`[browser-relay] ${message}`);
      ws.close(1011, "daemon frame error");
      daemon?.destroy();
    }
  });
  daemon.on("error", (err) => {
    frames.fail(err);
    control(ws, {
      type: "unavailable",
      payload: {
        reason: "daemon_socket_error",
        message: err.message,
        guidance: "Restart the dev daemon with `cargo xtask dev-daemon`.",
      },
    });
    ws.close(1011, "daemon socket error");
  });
  daemon.on("close", () => {
    frames.fail(new Error("daemon socket closed"));
    control(ws, { type: "disconnected" });
    ws.close(1011, "daemon socket closed");
  });

  try {
    writePreamble(daemon);
    writeFrame(daemon, JSON.stringify(relayHandshake(url, repoRoot)));
    const infoFrame = await frames.readFrame();
    const info = JSON.parse(infoFrame.toString("utf8")) as {
      notebook_id?: string;
      cell_count?: number;
      needs_trust_approval?: boolean;
      error?: string;
      ephemeral?: boolean;
      notebook_path?: string | null;
      runtime?: string;
    };

    if (info.error) throw new Error(info.error);

    const daemonInfoJson = readDaemonInfo(socketPath);
    control(ws, {
      type: "ready",
      payload: {
        notebook_id: info.notebook_id,
        cell_count: info.cell_count,
        needs_trust_approval: info.needs_trust_approval,
        ephemeral: info.ephemeral ?? true,
        notebook_path: info.notebook_path ?? null,
        runtime: info.runtime,
      },
      blob_port: daemonInfoJson?.blob_port ?? null,
      daemon: daemonInfoJson
        ? {
            version: daemonInfoJson.version ?? "unknown",
            socket_path: daemonInfoJson.socket_path ?? socketPath,
            is_dev_mode: daemonInfoJson.is_dev_mode ?? true,
          }
        : null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    control(ws, {
      type: "unavailable",
      payload: {
        reason: "notebook_handshake_failed",
        message,
        guidance: "Check the dev daemon logs with `./target/debug/runt daemon logs -f`.",
      },
    });
    ws.close(1011, "notebook handshake failed");
    daemon.destroy();
    return;
  }

  frames.pipeTo((frame) => {
    if (ws.readyState === ws.OPEN) ws.send(frame);
  });

  ws.on("message", (data, isBinary) => {
    if (!isBinary || !daemon || daemon.destroyed) return;
    const frame = binaryFromRaw(data);
    if (!frame) return;
    writeFrame(daemon, frame);
  });
  ws.on("close", () => daemon?.destroy());
}

export function browserDevRelayPlugin(options: RelayOptions): Plugin {
  return {
    name: "browser-dev-relay",
    apply: "serve",
    configureServer(server) {
      const token = crypto.randomBytes(32).toString("base64url");
      const wss = new WebSocketServer({ noServer: true });

      server.middlewares.use((req, res, next) => {
        const url = requestUrl(req);
        if (url.pathname !== CONFIG_PATH) {
          next();
          return;
        }

        const socketPath = resolveSocketPath(options.repoRoot);
        const daemonInfo = readDaemonInfo(socketPath);
        const host = req.headers.host ?? "127.0.0.1";
        sendJson(res, 200, {
          websocket_url: `ws://${host}${WS_PATH}`,
          token,
          blob_port: daemonInfo?.blob_port ?? null,
          daemon: daemonInfo
            ? {
                version: daemonInfo.version ?? "unknown",
                socket_path: daemonInfo.socket_path ?? socketPath,
                is_dev_mode: daemonInfo.is_dev_mode ?? true,
              }
            : null,
        });
      });

      server.httpServer?.on("upgrade", (req, socket: Socket, head) => {
        const url = requestUrl(req);
        if (url.pathname !== WS_PATH) return;

        if (!sameOrigin(req) || url.searchParams.get("token") !== token) {
          socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
          socket.destroy();
          return;
        }

        wss.handleUpgrade(req, socket, head, (ws) => {
          wss.emit("connection", ws, req);
        });
      });

      wss.on("connection", (ws, req) => {
        void handleRelayConnection(ws, req, options.repoRoot, server.config.logger);
      });

      server.httpServer?.once("close", () => wss.close());
      server.config.logger.info("[browser-relay] dev WebSocket relay enabled");
    },
  };
}
