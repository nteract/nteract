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
const HEALTH_PATH = "/__nteract_dev_relay/health";
const WS_PATH = "/__nteract_dev_relay/ws";
const MAGIC = [0xc0, 0xde, 0x01, 0xac] as const;
const PROTOCOL_VERSION = 4;
const FRAME_TYPE_SESSION_CONTROL = 0x07;
const MAX_FRAME_SIZE = 100 * 1024 * 1024;
const RELAY_AUTH_POLICY = {
  token_required: true,
  same_origin_required: true,
} as const;

interface DaemonInfoJson {
  version?: string;
  socket_path?: string;
  is_dev_mode?: boolean;
  blob_port?: number;
}

interface RelayOptions {
  repoRoot: string;
}

interface NotebookConnectionInfoJson {
  notebook_id?: string;
  cell_count?: number;
  needs_trust_approval?: boolean;
  error?: string;
  ephemeral?: boolean;
  notebook_path?: string | null;
  runtime?: string;
  actor_label?: string;
  connection_scope?: string;
  comments_doc_id?: string | null;
  comments_notebook_ref?: unknown;
  capabilities?: {
    actor_label?: string;
    connection_scope?: string;
    comments_doc_id?: string | null;
    comments_notebook_ref?: unknown;
  };
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

function socketExists(socketPath: string): boolean {
  try {
    return fs.statSync(socketPath).isSocket();
  } catch {
    return false;
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

function connectSocket(socketPath: string, timeoutMs?: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let timeout: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      socket.off("connect", onConnect);
      socket.off("error", onError);
    };
    const onConnect = () => {
      cleanup();
      resolve(socket);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    socket.once("connect", onConnect);
    socket.once("error", onError);

    if (timeoutMs != null) {
      timeout = setTimeout(() => {
        cleanup();
        socket.destroy();
        reject(new Error(`timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

async function queryDaemonInfo(socketPath: string): Promise<DaemonInfoJson | null> {
  let socket: net.Socket | null = null;
  try {
    socket = await connectSocket(socketPath, 500);
    const frames = new LengthPrefixedFrames();
    socket.on("data", (chunk) => {
      try {
        frames.push(chunk);
      } catch (error) {
        frames.fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.on("error", (error) => frames.fail(error));
    socket.on("close", () => frames.fail(new Error("daemon socket closed")));

    writePreamble(socket);
    writeFrame(socket, JSON.stringify({ channel: "pool" }));
    writeFrame(socket, JSON.stringify({ type: "get_daemon_info" }));

    const frame = await withTimeout(frames.readFrame(), 500);
    const response = JSON.parse(frame.toString("utf8")) as {
      type?: string;
      daemon_version?: string;
      blob_port?: number | null;
      worktree_path?: string | null;
    };
    if (response.type !== "daemon_info") return null;
    return {
      version: response.daemon_version,
      socket_path: socketPath,
      is_dev_mode: response.worktree_path != null,
      blob_port: response.blob_port ?? undefined,
    };
  } catch {
    return null;
  } finally {
    socket?.destroy();
  }
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

function relayAuthPolicy(token: string) {
  return {
    ...RELAY_AUTH_POLICY,
    token_configured: token.length > 0,
  };
}

function isAuthorizedRelayUpgrade(req: IncomingMessage, url: URL, token: string): boolean {
  const policy = relayAuthPolicy(token);
  return (
    (!policy.same_origin_required || sameOrigin(req)) &&
    (!policy.token_required || url.searchParams.get("token") === token)
  );
}

function relayHandshake(url: URL, repoRoot: string): Record<string, unknown> {
  const notebookPath = url.searchParams.get("path");
  if (notebookPath) {
    return { channel: "open_notebook", path: notebookPath, typed_bootstrap: true };
  }

  const notebookId = url.searchParams.get("notebook_id");
  const runtime = url.searchParams.get("runtime") ?? "python";
  const workingDir = url.searchParams.get("working_dir") ?? repoRoot;
  const environmentMode = url.searchParams.get("environment_mode");
  return {
    channel: "create_notebook",
    runtime,
    working_dir: workingDir,
    typed_bootstrap: true,
    ...(environmentMode ? { environment_mode: environmentMode } : {}),
    ...(notebookId ? { notebook_id: notebookId } : {}),
    ephemeral: true,
  };
}

function parseNotebookConnectionInfo(frame: Buffer): NotebookConnectionInfoJson {
  if (frame[0] !== FRAME_TYPE_SESSION_CONTROL) {
    return JSON.parse(frame.toString("utf8")) as NotebookConnectionInfoJson;
  }

  const bootstrap = JSON.parse(frame.subarray(1).toString("utf8")) as {
    type?: string;
  } & NotebookConnectionInfoJson;
  if (bootstrap.type !== "notebook_connection_info") {
    throw new Error(`unexpected typed bootstrap: ${bootstrap.type ?? "missing type"}`);
  }

  const { type: _type, ...info } = bootstrap;
  return info;
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
    const info = parseNotebookConnectionInfo(infoFrame);

    if (info.error) throw new Error(info.error);
    const actorLabel = info.actor_label ?? info.capabilities?.actor_label;
    const connectionScope = info.connection_scope ?? info.capabilities?.connection_scope;
    const commentsDocId = info.comments_doc_id ?? info.capabilities?.comments_doc_id ?? null;
    const commentsNotebookRef =
      info.comments_notebook_ref ?? info.capabilities?.comments_notebook_ref ?? null;

    const daemonInfoJson = await queryDaemonInfo(socketPath);
    control(ws, {
      type: "ready",
      payload: {
        notebook_id: info.notebook_id,
        cell_count: info.cell_count,
        needs_trust_approval: info.needs_trust_approval,
        ephemeral: info.ephemeral ?? true,
        notebook_path: info.notebook_path ?? null,
        runtime: info.runtime,
        actor_label: actorLabel,
        connection_scope: connectionScope,
        comments_doc_id: commentsDocId,
        comments_notebook_ref: commentsNotebookRef,
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
        if (url.pathname === HEALTH_PATH) {
          void (async () => {
            const socketPath = resolveSocketPath(options.repoRoot);
            const daemonInfo = await queryDaemonInfo(socketPath);
            sendJson(res, 200, {
              relay: "ok",
              paths: {
                config: CONFIG_PATH,
                websocket: WS_PATH,
              },
              auth: relayAuthPolicy(token),
              daemon: {
                socket_path: daemonInfo?.socket_path ?? socketPath,
                socket_exists: socketExists(socketPath),
                version: daemonInfo?.version ?? null,
                is_dev_mode: daemonInfo?.is_dev_mode ?? null,
              },
              blobs: {
                port: daemonInfo?.blob_port ?? null,
              },
            });
          })().catch((error) => {
            sendJson(res, 500, {
              error: error instanceof Error ? error.message : String(error),
            });
          });
          return;
        }

        if (url.pathname !== CONFIG_PATH) {
          next();
          return;
        }

        void (async () => {
          const socketPath = resolveSocketPath(options.repoRoot);
          const daemonInfo = await queryDaemonInfo(socketPath);
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
        })().catch((error) => {
          sendJson(res, 500, {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      });

      server.httpServer?.on("upgrade", (req, socket: Socket, head) => {
        const url = requestUrl(req);
        if (url.pathname !== WS_PATH) return;

        if (!isAuthorizedRelayUpgrade(req, url, token)) {
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
