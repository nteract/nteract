import { createHash, randomBytes } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import net from "node:net";
import tls from "node:tls";
import { fileURLToPath } from "node:url";

import { FrameType } from "runtimed";

import {
  accessAuthHeaders,
  accessAuthProtocols,
  accessEmailFromJwt,
  accessPrincipalFromJwt,
  assertHostedAccessSmokeEnv,
} from "./hosted-access-smoke-env.mjs";

const DEFAULT_BASE_URL = "https://nteract-notebook-cloud.rgbkrk.workers.dev";
const baseUrl = process.env.NOTEBOOK_CLOUD_URL ?? DEFAULT_BASE_URL;
const smokeOrigin = process.env.NOTEBOOK_CLOUD_ACCESS_ORIGIN ?? new URL(baseUrl).origin;
const ownerToken = process.env.NOTEBOOK_CLOUD_ACCESS_JWT;
const editorToken = process.env.NOTEBOOK_CLOUD_ACCESS_EDITOR_JWT ?? ownerToken;
const viewerToken = process.env.NOTEBOOK_CLOUD_ACCESS_VIEWER_JWT ?? editorToken;
const roomId = process.env.NOTEBOOK_CLOUD_ACCESS_NOTEBOOK_ID ?? `access-${Date.now()}`;
const includePublicViewer = process.env.NOTEBOOK_CLOUD_ACCESS_PUBLIC_SMOKE === "1";
const timingsMs = {};
const wasmJsUrl = new URL(
  "../../notebook/src/wasm/runtimed-wasm/runtimed_wasm.js",
  import.meta.url,
);
const wasmBytesUrl = new URL(
  "../../notebook/src/wasm/runtimed-wasm/runtimed_wasm_bg.wasm",
  import.meta.url,
);

const startedAt = performance.now();
assertHostedAccessSmokeEnv({ ownerToken });
await assertWasmBuildExists();

const ownerPrincipal = accessPrincipalFromJwt(ownerToken);
const editorPrincipal = accessPrincipalFromJwt(editorToken);
const viewerPrincipal = accessPrincipalFromJwt(viewerToken);

const { initSync, NotebookHandle } = await import(wasmJsUrl.href);
const wasmBytes = await readFile(wasmBytesUrl);
await timed("runtimed_wasm_init", () => initSync({ module: wasmBytes }));

await timed("owner_seed", () => seedNotebookOwner(roomId));
await timed("acl_grants", async () => {
  await grantAcl(roomId, {
    subject_kind: "principal",
    subject: editorPrincipal,
    scope: "editor",
  });
  await grantAcl(roomId, {
    subject_kind: "principal",
    subject: viewerPrincipal,
    scope: "viewer",
  });
  if (includePublicViewer) {
    await grantAcl(roomId, {
      subject_kind: "public",
      subject: "anonymous",
      scope: "viewer",
    });
  }
});

const { owner, editor, viewer, anonymous } = await timed("connect_peers", async () => {
  const peers = {
    owner: await connectAccess(roomId, ownerToken, "smoke:owner", "owner"),
    editor: await connectAccess(roomId, editorToken, "smoke:editor", "editor"),
    viewer: await connectAccess(roomId, viewerToken, "smoke:viewer", "viewer"),
    anonymous: null,
  };
  if (includePublicViewer) {
    peers.anonymous = await connectAnonymous(roomId, "access-smoke-anonymous");
  }
  return peers;
});

const ownerHandle = NotebookHandle.create_bootstrap(owner.ready.actor_label);
const editorHandle = NotebookHandle.create_bootstrap(editor.ready.actor_label);
const viewerHandle = NotebookHandle.create_bootstrap(viewer.ready.actor_label);
const anonymousHandle = anonymous
  ? NotebookHandle.create_bootstrap(anonymous.ready.actor_label)
  : null;
const participants = [
  { name: "owner", client: owner, handle: ownerHandle },
  { name: "editor", client: editor, handle: editorHandle },
  { name: "viewer", client: viewer, handle: viewerHandle },
];
if (anonymous && anonymousHandle) {
  participants.push({ name: "anonymous", client: anonymous, handle: anonymousHandle });
}

ownerHandle.add_cell_after("cell-access-smoke-1", "markdown", null);
ownerHandle.update_source("cell-access-smoke-1", "Access owner seeded markdown\n");
sendHandleChanges(owner, ownerHandle);

let processedFrames = await timed("owner_to_editor_viewers_convergence", () =>
  driveSyncUntil(
    participants,
    () =>
      cellSource(editorHandle, "cell-access-smoke-1") === "Access owner seeded markdown\n" &&
      cellSource(viewerHandle, "cell-access-smoke-1") === "Access owner seeded markdown\n" &&
      (!anonymousHandle ||
        cellSource(anonymousHandle, "cell-access-smoke-1") === "Access owner seeded markdown\n"),
    "Access owner markdown did not converge to editor and viewers",
  ),
);

editorHandle.update_source("cell-access-smoke-1", "Access editor updated markdown\n");
sendHandleChanges(editor, editorHandle);
processedFrames += await timed("editor_to_owner_viewers_convergence", () =>
  driveSyncUntil(
    participants,
    () =>
      cellSource(ownerHandle, "cell-access-smoke-1") === "Access editor updated markdown\n" &&
      cellSource(viewerHandle, "cell-access-smoke-1") === "Access editor updated markdown\n" &&
      (!anonymousHandle ||
        cellSource(anonymousHandle, "cell-access-smoke-1") === "Access editor updated markdown\n"),
    "Access editor markdown edit did not converge to owner and viewers",
  ),
);

assert(
  owner.ready.actor_label.startsWith(`${ownerPrincipal}/`),
  `owner actor ${owner.ready.actor_label} did not use principal ${ownerPrincipal}`,
);
assert(
  editor.ready.actor_label.startsWith(`${editorPrincipal}/`),
  `editor actor ${editor.ready.actor_label} did not use principal ${editorPrincipal}`,
);
assert(
  viewer.ready.actor_label.startsWith(`${viewerPrincipal}/`),
  `viewer actor ${viewer.ready.actor_label} did not use principal ${viewerPrincipal}`,
);

console.log(
  JSON.stringify(
    {
      ok: true,
      auth_mode: "cloudflare_access",
      baseUrl,
      origin: smokeOrigin,
      roomId,
      viewerUrl: new URL(`/n/${encodeURIComponent(roomId)}`, baseUrl).href,
      principals: {
        owner: ownerPrincipal,
        editor: editorPrincipal,
        viewer: viewerPrincipal,
      },
      emails: {
        owner: accessEmailFromJwt(ownerToken),
        editor: accessEmailFromJwt(editorToken),
        viewer: accessEmailFromJwt(viewerToken),
      },
      checks: [
        "cloudflare_access_jwt_validated_by_worker",
        "owner_acl_room_seeded",
        "editor_principal_acl_granted",
        "viewer_principal_acl_granted",
        "real_automerge_sync_payload",
        "access_owner_seeded_markdown",
        "access_editor_edited_markdown",
        "access_viewer_live_convergence",
        "actor_principals_match_access_subjects",
        ...(includePublicViewer
          ? ["public_viewer_acl_granted", "anonymous_public_viewer_live_convergence"]
          : []),
      ],
      timings_ms: {
        ...timingsMs,
        total: elapsedMs(startedAt),
      },
      processedFrames,
      finalSource: ownerHandle.get_cell_source("cell-access-smoke-1"),
    },
    null,
    2,
  ),
);

await Promise.all([owner, editor, viewer, anonymous].filter(Boolean).map(closeClient));
process.exit(0);

async function timed(name, fn) {
  const started = performance.now();
  try {
    return await fn();
  } finally {
    timingsMs[name] = elapsedMs(started);
  }
}

function elapsedMs(started) {
  return Math.max(0, Math.round((performance.now() - started) * 100) / 100);
}

async function assertWasmBuildExists() {
  try {
    await access(fileURLToPath(wasmJsUrl));
    await access(fileURLToPath(wasmBytesUrl));
  } catch {
    throw new Error(
      "Missing apps/notebook/src/wasm/runtimed-wasm output. Run `cargo xtask wasm runtimed --skip-renderer-plugins` first.",
    );
  }
}

async function seedNotebookOwner(notebookId) {
  const response = await fetch(
    new URL(
      `/api/n/${encodeURIComponent(notebookId)}/runtime-snapshots/bootstrap-runtime`,
      baseUrl,
    ),
    {
      method: "PUT",
      headers: accessAuthHeaders(ownerToken, {
        operator: "smoke:owner",
        scope: "owner",
        contentType: "application/octet-stream",
      }),
      body: new Uint8Array([0]),
    },
  );
  assert(
    response.status === 201,
    `owner bootstrap runtime snapshot failed: ${response.status} ${await response.text()}`,
  );
}

async function grantAcl(notebookId, body) {
  const response = await fetch(new URL(`/api/n/${encodeURIComponent(notebookId)}/acl`, baseUrl), {
    method: "POST",
    headers: accessAuthHeaders(ownerToken, {
      operator: "smoke:owner",
      scope: "owner",
      contentType: "application/json",
    }),
    body: JSON.stringify(body),
  });
  assert(response.status === 201, `ACL grant failed: ${response.status} ${await response.text()}`);
}

function sendHandleChanges(client, handle) {
  const payload = handle.flush_local_changes();
  assert(payload?.byteLength > 0, "expected handle to flush local Automerge changes");
  sendBinaryFrame(client.socket, FrameType.AUTOMERGE_SYNC, payload);
}

async function driveSyncUntil(participants, predicate, failureMessage) {
  const deadline = Date.now() + 5_000;
  let processedFrames = 0;

  while (Date.now() < deadline) {
    if (predicate()) {
      return processedFrames;
    }

    let progressed = false;
    for (const participant of participants) {
      const frame = await participant.client
        .nextFrame((candidate) => candidate.type === FrameType.AUTOMERGE_SYNC, 50)
        .catch(() => undefined);
      if (!frame) {
        continue;
      }

      progressed = true;
      processedFrames += 1;
      const events = participant.handle.receive_frame(frame.bytes);
      for (const event of events) {
        if (Array.isArray(event.reply)) {
          sendBinaryFrame(
            participant.client.socket,
            FrameType.AUTOMERGE_SYNC,
            new Uint8Array(event.reply),
          );
        }
      }
    }

    if (!progressed) {
      await sleep(25);
    }
  }

  throw new Error(failureMessage);
}

function cellSource(handle, cellId) {
  try {
    return handle.get_cell_source(cellId);
  } catch {
    return undefined;
  }
}

async function connectAccess(notebookId, token, operator, scope) {
  const url = new URL(`/n/${encodeURIComponent(notebookId)}/sync`, baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("operator", operator);
  url.searchParams.set("scope", scope);
  const socket = await openWebSocket(url, {
    accessToken: token,
    origin: smokeOrigin,
    protocols: accessAuthProtocols(token),
  });
  const client = await clientForSocket(socket, safeWebSocketUrl(url));
  const ready = await client.nextFrame(
    (frame) => frame.type === FrameType.SESSION_CONTROL && frame.json.type === "cloud_room_ready",
  );
  return { ...client, ready: ready.json };
}

async function connectAnonymous(notebookId, viewerSession) {
  const url = new URL(`/n/${encodeURIComponent(notebookId)}/sync`, baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("viewer_session", viewerSession);
  const socket = await openWebSocket(url, { origin: smokeOrigin });
  const client = await clientForSocket(socket, url.href);
  const ready = await client.nextFrame(
    (frame) => frame.type === FrameType.SESSION_CONTROL && frame.json.type === "cloud_room_ready",
  );
  return { ...client, ready: ready.json };
}

async function clientForSocket(socket, safeUrl) {
  const queue = [];
  const waiters = [];
  socket.addEventListener("message", async (event) => {
    const frame = await decodeFrame(event.data);
    const index = waiters.findIndex((waiter) => waiter.predicate(frame));
    if (index === -1) {
      queue.push(frame);
      return;
    }

    const [waiter] = waiters.splice(index, 1);
    clearTimeout(waiter.timer);
    waiter.resolve(frame);
  });

  if (socket.readyState !== RawWebSocketClient.OPEN) {
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", () => reject(new Error(`failed to connect ${safeUrl}`)), {
        once: true,
      });
    });
  }

  return {
    socket,
    nextFrame(predicate, timeoutMs = 5_000) {
      const queued = queue.findIndex(predicate);
      if (queued !== -1) {
        const [frame] = queue.splice(queued, 1);
        return Promise.resolve(frame);
      }

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = waiters.findIndex((waiter) => waiter.timer === timer);
          if (index !== -1) {
            waiters.splice(index, 1);
          }
          reject(new Error(`timed out waiting for frame from ${safeUrl}`));
        }, timeoutMs);
        waiters.push({ predicate, resolve, timer });
      });
    },
  };
}

function sendBinaryFrame(socket, type, payload) {
  const frame = new Uint8Array(payload.byteLength + 1);
  frame[0] = type;
  frame.set(payload, 1);
  socket.send(frame);
}

async function decodeFrame(data) {
  let buffer;
  if (data instanceof ArrayBuffer) {
    buffer = data;
  } else if (ArrayBuffer.isView(data)) {
    buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  } else if (typeof Blob !== "undefined" && data instanceof Blob) {
    buffer = await data.arrayBuffer();
  } else {
    throw new Error(`unsupported WebSocket message ${Object.prototype.toString.call(data)}`);
  }

  const bytes = new Uint8Array(buffer);
  const type = bytes[0];
  const payload = bytes.slice(1);
  let json;
  if (type === FrameType.SESSION_CONTROL) {
    try {
      json = JSON.parse(new TextDecoder().decode(payload));
    } catch {
      json = undefined;
    }
  }
  return { type, payload, bytes, json };
}

async function closeClient(client) {
  if (client.socket.readyState === RawWebSocketClient.CLOSED) {
    return;
  }

  await new Promise((resolve) => {
    const timeout = setTimeout(resolve, 250);
    client.socket.addEventListener(
      "close",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
    client.socket.close();
  });
}

function safeWebSocketUrl(url) {
  const safe = new URL(url.href);
  for (const [key, value] of safe.searchParams) {
    if (key.toLowerCase().includes("token") || value.startsWith("eyJ")) {
      safe.searchParams.set(key, "<redacted>");
    }
  }
  return safe.href;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function openWebSocket(url, { accessToken, origin, protocols = [] } = {}) {
  const target = new URL(url);
  const key = randomBytes(16).toString("base64");
  const socket = await openTcpSocket(target);
  const requestHeaders = [
    `GET ${target.pathname}${target.search} HTTP/1.1`,
    `Host: ${target.host}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Key: ${key}`,
    "Sec-WebSocket-Version: 13",
    `Origin: ${origin}`,
  ];
  if (accessToken) {
    requestHeaders.push(`CF-Access-Token: ${accessToken}`);
    requestHeaders.push(`Authorization: Bearer ${accessToken}`);
  }
  if (protocols.length > 0) {
    requestHeaders.push(`Sec-WebSocket-Protocol: ${protocols.join(", ")}`);
  }
  socket.write(`${requestHeaders.join("\r\n")}\r\n\r\n`);

  const { headers, leftover } = await readUpgradeResponse(socket);
  const expectedAccept = createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  assert(
    headers.statusCode === 101,
    `WebSocket upgrade failed with HTTP ${headers.statusCode}: ${headers.bodyPreview}`,
  );
  assert(
    headers.fields.get("sec-websocket-accept") === expectedAccept,
    "WebSocket upgrade returned an invalid Sec-WebSocket-Accept header",
  );

  return new RawWebSocketClient(socket, leftover);
}

function openTcpSocket(url) {
  const isTls = url.protocol === "wss:";
  const port = Number(url.port || (isTls ? 443 : 80));
  const options = { host: url.hostname, port };
  return new Promise((resolve, reject) => {
    const socket = isTls
      ? tls.connect({ ...options, servername: url.hostname })
      : net.connect(options);
    socket.once(isTls ? "secureConnect" : "connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

function readUpgradeResponse(socket) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        return;
      }

      socket.off("data", onData);
      socket.off("error", reject);
      const rawHeader = buffer.slice(0, headerEnd).toString("latin1");
      const leftover = buffer.slice(headerEnd + 4);
      const lines = rawHeader.split("\r\n");
      const statusCode = Number(lines[0]?.match(/^HTTP\/\d(?:\.\d)?\s+(\d+)/)?.[1] ?? 0);
      const fields = new Map();
      for (const line of lines.slice(1)) {
        const delimiter = line.indexOf(":");
        if (delimiter === -1) {
          continue;
        }
        fields.set(line.slice(0, delimiter).trim().toLowerCase(), line.slice(delimiter + 1).trim());
      }
      resolve({
        headers: {
          statusCode,
          fields,
          bodyPreview: buffer.slice(headerEnd + 4, headerEnd + 260).toString("utf8"),
        },
        leftover,
      });
    };

    socket.on("data", onData);
    socket.once("error", reject);
  });
}

class RawWebSocketClient {
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(socket, initialBuffer) {
    this.socket = socket;
    this.readyState = RawWebSocketClient.OPEN;
    this.listeners = new Map();
    this.buffer = initialBuffer ?? Buffer.alloc(0);
    this.socket.on("data", (chunk) => this.receive(chunk));
    this.socket.on("close", () => {
      this.readyState = RawWebSocketClient.CLOSED;
      this.dispatch("close", {});
    });
    this.socket.on("error", (error) => this.dispatch("error", { error }));
    if (this.buffer.length > 0) {
      this.receive(Buffer.alloc(0));
    }
  }

  addEventListener(type, listener, options = {}) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push({ listener, once: Boolean(options.once) });
    this.listeners.set(type, listeners);
  }

  dispatch(type, event) {
    const listeners = this.listeners.get(type);
    if (!listeners) {
      return;
    }
    const remaining = [];
    for (const entry of listeners) {
      entry.listener(event);
      if (!entry.once) {
        remaining.push(entry);
      }
    }
    this.listeners.set(type, remaining);
  }

  send(data) {
    assert(this.readyState === RawWebSocketClient.OPEN, "cannot send on a closed WebSocket");
    this.socket.write(encodeClientFrame(0x2, Buffer.from(data)));
  }

  close() {
    if (this.readyState !== RawWebSocketClient.OPEN) {
      return;
    }
    this.readyState = RawWebSocketClient.CLOSING;
    this.socket.write(encodeClientFrame(0x8, Buffer.alloc(0)));
    this.socket.end();
  }

  receive(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const opcode = first & 0x0f;
      const masked = Boolean(second & 0x80);
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < offset + 2) {
          return;
        }
        length = this.buffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (this.buffer.length < offset + 8) {
          return;
        }
        const longLength = this.buffer.readBigUInt64BE(offset);
        assert(longLength <= BigInt(Number.MAX_SAFE_INTEGER), "WebSocket frame is too large");
        length = Number(longLength);
        offset += 8;
      }

      const maskOffset = offset;
      if (masked) {
        offset += 4;
      }
      if (this.buffer.length < offset + length) {
        return;
      }

      let payload = this.buffer.slice(offset, offset + length);
      if (masked) {
        const mask = this.buffer.slice(maskOffset, maskOffset + 4);
        payload = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
      }
      this.buffer = this.buffer.slice(offset + length);

      if (opcode === 0x8) {
        this.readyState = RawWebSocketClient.CLOSED;
        this.socket.end();
        this.dispatch("close", {});
      } else if (opcode === 0x9) {
        this.socket.write(encodeClientFrame(0x0a, payload));
      } else if (opcode === 0x2) {
        this.dispatch("message", { data: new Uint8Array(payload) });
      } else if (opcode === 0x1) {
        this.dispatch("message", { data: payload.toString("utf8") });
      }
    }
  }
}

function encodeClientFrame(opcode, payload) {
  const length = payload.length;
  let headerLength = 2;
  if (length >= 126 && length <= 0xffff) {
    headerLength += 2;
  } else if (length > 0xffff) {
    headerLength += 8;
  }

  const frame = Buffer.alloc(headerLength + 4 + length);
  frame[0] = 0x80 | opcode;
  if (length < 126) {
    frame[1] = 0x80 | length;
  } else if (length <= 0xffff) {
    frame[1] = 0x80 | 126;
    frame.writeUInt16BE(length, 2);
  } else {
    frame[1] = 0x80 | 127;
    frame.writeBigUInt64BE(BigInt(length), 2);
  }

  const mask = randomBytes(4);
  mask.copy(frame, headerLength);
  for (let index = 0; index < payload.length; index += 1) {
    frame[headerLength + 4 + index] = payload[index] ^ mask[index % 4];
  }
  return frame;
}
