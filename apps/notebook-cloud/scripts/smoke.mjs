import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { FrameType } from "runtimed";
import { openWebSocket } from "./hosted-access-smoke-ws.mjs";
import { credentialedSmokeOrigin } from "./wasm-roundtrip-env.mjs";

const wasmJsPath = new URL(
  "../../notebook/src/wasm/runtimed-wasm/runtimed_wasm.js",
  import.meta.url,
);
const wasmBinPath = new URL(
  "../../notebook/src/wasm/runtimed-wasm/runtimed_wasm_bg.wasm",
  import.meta.url,
);
const wasm = await import(wasmJsPath.href);
await wasm.default({ module_or_path: await readFile(wasmBinPath) });

const baseUrl = process.env.NOTEBOOK_CLOUD_URL ?? "http://127.0.0.1:8787";
const devAuthToken = process.env.NOTEBOOK_CLOUD_DEV_TOKEN;
const roomId = `smoke-${Date.now()}`;
const otherRoomId = `${roomId}-other`;
const [fixtureNotebookBytes, fixtureRuntimeBytes] = await Promise.all([
  readFile(
    new URL("../../../packages/runtimed/tests/fixtures/output_streaming/doc.bin", import.meta.url),
  ),
  readFile(
    new URL(
      "../../../packages/runtimed/tests/fixtures/output_streaming/state_doc.bin",
      import.meta.url,
    ),
  ),
]);
if (typeof WebSocket === "undefined") {
  throw new Error("This smoke script requires Node.js with a global WebSocket implementation");
}

const health = await fetch(new URL("/api/health", baseUrl));
assert(health.ok, `health check failed: ${health.status}`);

await seedNotebook(roomId, "alice", [
  { subject: "user:dev:bob", scope: "editor" },
  { subject: "user:dev:viewer", scope: "viewer" },
]);
await seedNotebook(otherRoomId, "other");

const alice = await connect(roomId, "alice", "desktop:alice", "owner");
const bob = await connect(roomId, "bob", "desktop:bob", "editor");
const other = await connect(otherRoomId, "other", "desktop:other", "owner");
const viewer = await connect(roomId, "viewer", "desktop:viewer", "viewer");
const anonymous = await connectAnonymous(roomId, "anon-smoke");

assert(
  alice.ready.actor_label === "user:dev:alice/desktop:alice",
  "alice actor label was not stamped",
);
assert(bob.ready.actor_label === "user:dev:bob/desktop:bob", "bob actor label was not stamped");
assert(other.ready.notebook_id === otherRoomId, "other room routed to the wrong notebook id");
assert(
  anonymous.ready.actor_label === "anonymous:anon-smoke/browser:anon-smoke",
  `anonymous viewer actor label was not explicit: ${anonymous.ready.actor_label}`,
);
assert(anonymous.ready.connection_scope === "viewer", "anonymous viewer was not viewer-scoped");

sendPresenceFrame(alice.socket, {
  type: "update",
  peer_id: "client-forged-peer",
  peer_label: "Alice",
  actor_label: "user:dev:mallory/desktop:alice",
  channel: "cursor",
  data: { cell_id: "cell-1", line: 0, column: 0 },
});

const rewrittenPresence = await bob.nextFrame((frame) => frame.type === FrameType.PRESENCE);
assert(
  rewrittenPresence.json.actor_label === "user:dev:alice/desktop:alice",
  `presence principal was not rewritten: ${JSON.stringify(rewrittenPresence.json)}`,
);
assert(
  rewrittenPresence.json.peer_id === alice.ready.peer_id,
  `presence peer id was not rewritten: ${JSON.stringify(rewrittenPresence.json)}`,
);

sendBinaryFrame(
  alice.socket,
  FrameType.PRESENCE,
  new TextEncoder().encode(JSON.stringify({ actor_label: "browser:json" })),
);
const rejectedMalformedPresence = await alice.nextFrame(
  (frame) =>
    frame.type === FrameType.SESSION_CONTROL &&
    frame.json.type === "cloud_frame_rejected" &&
    frame.json.frame_type === FrameType.PRESENCE,
);
assert(
  rejectedMalformedPresence.json.reason.includes("CBOR decode error"),
  `malformed presence was not rejected explicitly: ${JSON.stringify(rejectedMalformedPresence.json)}`,
);
const leakedMalformedPresence = await bob
  .nextFrame((frame) => frame.type === FrameType.PRESENCE, 250)
  .catch(() => undefined);
assert(leakedMalformedPresence === undefined, "malformed presence was rebroadcast");

sendPresenceFrame(alice.socket, {
  type: "update",
  peer_id: "client-peer",
  peer_label: "Alice",
  actor_label: "/bad",
  channel: "focus",
  data: { cell_id: "cell-1" },
});
const invalidActorPresence = await bob.nextFrame((frame) => frame.type === FrameType.PRESENCE);
assert(
  invalidActorPresence.json.actor_label === "user:dev:alice/desktop:alice",
  `invalid actor presence was not stamped safely: ${JSON.stringify(invalidActorPresence.json)}`,
);

const syncCellId = `cell-${roomId}`;
const syncCellSource = `Smoke sync ${roomId}\n`;
const aliceHandle = wasm.NotebookHandle.create_bootstrap(alice.ready.actor_label);
const bobHandle = wasm.NotebookHandle.create_bootstrap(bob.ready.actor_label);
await drainHandleSync([
  { client: alice, handle: aliceHandle },
  { client: bob, handle: bobHandle },
]);
aliceHandle.add_cell_after(syncCellId, "markdown", null);
aliceHandle.update_source(syncCellId, syncCellSource);
const syncPayload = aliceHandle.flush_local_changes();
assert(syncPayload?.byteLength > 0, "expected Alice handle to produce a sync payload");
sendBinaryFrame(alice.socket, FrameType.AUTOMERGE_SYNC, syncPayload);
await driveHandleSync(
  bob,
  bobHandle,
  () => cellSource(bobHandle, syncCellId) === syncCellSource,
  "same-room Automerge sync frame did not converge to Bob",
);

const accepted = await alice.nextFrame(
  (frame) =>
    frame.type === FrameType.SESSION_CONTROL &&
    frame.json.type === "cloud_frame_accepted" &&
    frame.json.frame_type === FrameType.AUTOMERGE_SYNC,
);
assert(accepted.json.frame_type === FrameType.AUTOMERGE_SYNC, "owner sync frame was not accepted");

sendBinaryFrame(viewer.socket, FrameType.PUT_BLOB, new Uint8Array([9]));
const rejectedBlob = await viewer.nextFrame(
  (frame) =>
    frame.type === FrameType.SESSION_CONTROL &&
    frame.json.type === "cloud_frame_rejected" &&
    frame.json.frame_type === FrameType.PUT_BLOB,
);
assert(
  rejectedBlob.json.reason.includes("viewer cannot write"),
  "viewer blob write was not rejected",
);

sendBinaryFrame(viewer.socket, FrameType.POOL_STATE_SYNC, new Uint8Array([9]));
const rejectedPool = await viewer.nextFrame(
  (frame) =>
    frame.type === FrameType.SESSION_CONTROL &&
    frame.json.type === "cloud_frame_rejected" &&
    frame.json.frame_type === FrameType.POOL_STATE_SYNC,
);
assert(
  rejectedPool.json.reason.includes("viewer cannot write"),
  "viewer pool write was not rejected",
);

sendJsonFrame(viewer.socket, FrameType.REQUEST, { id: "viewer-request", type: "noop" });
const rejectedRequest = await viewer.nextFrame(
  (frame) =>
    frame.type === FrameType.SESSION_CONTROL &&
    frame.json.type === "cloud_frame_rejected" &&
    frame.json.frame_type === FrameType.REQUEST,
);
assert(
  rejectedRequest.json.reason.includes("viewer cannot write"),
  "viewer request frame was not rejected",
);

sendPresenceFrame(anonymous.socket, {
  type: "update",
  peer_id: "anonymous-client",
  peer_label: "anonymous smoke",
  actor_label: "browser:anon-smoke",
  channel: "focus",
  data: { cell_id: "cell-1" },
});
const anonymousPresenceAccepted = await anonymous.nextFrame(
  (frame) =>
    frame.type === FrameType.SESSION_CONTROL &&
    frame.json.type === "cloud_frame_accepted" &&
    frame.json.frame_type === FrameType.PRESENCE,
);
assert(
  anonymousPresenceAccepted.json.frame_type === FrameType.PRESENCE,
  "anonymous presence was not locally accepted",
);
const leakedAnonymousPresence = await bob
  .nextFrame(
    (frame) =>
      frame.type === FrameType.PRESENCE &&
      typeof frame.json?.actor_label === "string" &&
      frame.json.actor_label.startsWith("anonymous:"),
    250,
  )
  .catch(() => undefined);
assert(leakedAnonymousPresence === undefined, "anonymous presence was broadcast to room peers");

const snapshotHeads = `heads-${roomId}`;
const runtimeHeads = `runtime-${roomId}`;
const runtimePath = `/api/n/${encodeURIComponent(roomId)}/runtime-snapshots/${encodeURIComponent(runtimeHeads)}`;
const snapshotPath = `/api/n/${encodeURIComponent(roomId)}/snapshots/${encodeURIComponent(snapshotHeads)}`;
const {
  notebookBytes: snapshotBytes,
  runtimeBytes,
  runtimeStateDocId,
} = snapshotPairForNotebook(roomId);
const invalidAuthResponse = await fetch(new URL(snapshotPath, baseUrl), {
  method: "PUT",
  headers: {
    "Content-Type": "application/octet-stream",
    "X-User": "alice",
    "X-Scope": "admin",
    ...devAuthHeaders(),
  },
  body: snapshotBytes,
});
assert(
  invalidAuthResponse.status === 400,
  `invalid auth should return 400, got ${invalidAuthResponse.status}`,
);
const runtimePut = await putBytes(runtimePath, runtimeBytes, "application/octet-stream", {
  "X-Runtime-State-Doc-Id": runtimeStateDocId,
});
assert(runtimePut.ok === true, `runtime snapshot PUT failed: ${JSON.stringify(runtimePut)}`);
assertBytesEqual(
  await fetchBytes(runtimePath, { "X-Runtime-State-Doc-Id": runtimeStateDocId }),
  runtimeBytes,
  "runtime snapshot GET did not round-trip",
);
const snapshotPut = await putBytes(snapshotPath, snapshotBytes, "application/octet-stream", {
  "X-Runtime-Heads-Hash": runtimeHeads,
  "X-Runtime-State-Doc-Id": runtimeStateDocId,
});
assert(snapshotPut.ok === true, `snapshot PUT failed: ${JSON.stringify(snapshotPut)}`);
assertBytesEqual(await fetchBytes(snapshotPath), snapshotBytes, "snapshot GET did not round-trip");

const blobBytes = new TextEncoder().encode(`blob:${roomId}`);
const blobHash = createHash("sha256").update(blobBytes).digest("hex");
const blobPath = `/api/n/${encodeURIComponent(roomId)}/blobs/${encodeURIComponent(blobHash)}`;
const blobPut = await putBytes(blobPath, blobBytes, "text/plain");
assert(blobPut.ok === true, `blob PUT failed: ${JSON.stringify(blobPut)}`);
const blobHead = await fetchHead(blobPath);
assert(
  blobHead.headers.get("content-length") === blobBytes.byteLength.toString(),
  "blob HEAD did not return the stored content length",
);
assertBytesEqual(await fetchBytes(blobPath), blobBytes, "blob GET did not round-trip");

const catalog = await fetchJson(`/api/n/${encodeURIComponent(roomId)}`);
assert(
  catalog.revisions.some(
    (revision) =>
      revision.notebook_heads_hash === snapshotHeads &&
      revision.runtime_heads_hash === runtimeHeads &&
      typeof revision.runtime_snapshot_key === "string",
  ),
  "D1 catalog did not include the stored snapshot revision",
);
assert(
  catalog.blobs.some((blob) => blob.hash === blobHash && blob.size === blobBytes.byteLength),
  "D1 catalog did not include the stored blob",
);

const otherHandle = wasm.NotebookHandle.create_bootstrap(other.ready.actor_label);
await drainHandleSync([{ client: other, handle: otherHandle }]);
assert(
  cellSource(otherHandle, syncCellId) === undefined,
  "cell from one Durable Object room materialized in another room",
);

console.log(
  JSON.stringify(
    {
      ok: true,
      baseUrl,
      roomId,
      checks: [
        "websocket_upgrade",
        "acl_backed_room_bootstrap",
        "durable_object_room_routing",
        "identity_stamping",
        "presence_principal_rewrite",
        "malformed_presence_rejection",
        "invalid_presence_actor_safe_fallback",
        "typed_frame_relay",
        "viewer_blob_rejection",
        "viewer_pool_rejection",
        "viewer_request_rejection",
        "anonymous_viewer_identity",
        "anonymous_presence_local_only",
        "invalid_auth_structured_rejection",
        "r2_runtime_snapshot_roundtrip",
        "r2_snapshot_roundtrip",
        "r2_blob_roundtrip",
        "d1_catalog_readback",
      ],
    },
    null,
    2,
  ),
);

await Promise.all([alice, bob, other, viewer, anonymous].map(closeClient));
process.exit(0);

async function seedNotebook(notebookId, ownerUser, grants = []) {
  const runtimeHeads = `bootstrap-runtime-${notebookId}`;
  const snapshotHeads = `bootstrap-heads-${notebookId}`;
  const { notebookBytes, runtimeBytes, runtimeStateDocId } = snapshotPairForNotebook(notebookId);
  await putBytes(
    `/api/n/${encodeURIComponent(notebookId)}/runtime-snapshots/${encodeURIComponent(runtimeHeads)}`,
    runtimeBytes,
    "application/octet-stream",
    { "X-User": ownerUser, "X-Runtime-State-Doc-Id": runtimeStateDocId },
  );
  await putBytes(
    `/api/n/${encodeURIComponent(notebookId)}/snapshots/${encodeURIComponent(snapshotHeads)}`,
    notebookBytes,
    "application/octet-stream",
    {
      "X-User": ownerUser,
      "X-Runtime-Heads-Hash": runtimeHeads,
      "X-Runtime-State-Doc-Id": runtimeStateDocId,
    },
  );
  for (const grant of grants) {
    await grantAcl(notebookId, ownerUser, grant);
  }
}

async function grantAcl(notebookId, ownerUser, { subject, scope }) {
  const url = new URL(`/api/n/${encodeURIComponent(notebookId)}/acl`, baseUrl);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-User": ownerUser,
      "X-Operator": "desktop:smoke",
      "X-Scope": "owner",
      ...devAuthHeaders(),
    },
    body: JSON.stringify({
      subject_kind: "principal",
      subject,
      scope,
    }),
  });
  assert(response.ok, `${url.href} returned ${response.status}`);
  return response.json();
}

async function driveHandleSync(client, handle, predicate, failureMessage) {
  const deadline = Date.now() + 5_000;

  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }

    const frame = await client
      .nextFrame((candidate) => candidate.type === FrameType.AUTOMERGE_SYNC, 50)
      .catch(() => undefined);
    if (!frame) {
      await sleep(25);
      continue;
    }

    const events = handle.receive_frame(frame.bytes);
    for (const event of events) {
      if (Array.isArray(event.reply)) {
        sendBinaryFrame(client.socket, FrameType.AUTOMERGE_SYNC, new Uint8Array(event.reply));
      }
    }
  }

  throw new Error(failureMessage);
}

async function drainHandleSync(participants) {
  const deadline = Date.now() + 5_000;
  let lastProgressAt = Date.now();

  while (Date.now() < deadline) {
    let progressed = false;
    for (const participant of participants) {
      const frame = await participant.client
        .nextFrame((candidate) => candidate.type === FrameType.AUTOMERGE_SYNC, 50)
        .catch(() => undefined);
      if (!frame) {
        continue;
      }

      progressed = true;
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

    if (progressed) {
      lastProgressAt = Date.now();
    } else if (Date.now() - lastProgressAt > 250) {
      return;
    } else {
      await sleep(25);
    }
  }
}

function cellSource(handle, cellId) {
  try {
    return handle.get_cell_source(cellId);
  } catch {
    return undefined;
  }
}

async function connect(notebookId, user, operator, scope) {
  const url = new URL(`/n/${encodeURIComponent(notebookId)}/sync`, baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("user", user);
  url.searchParams.set("operator", operator);
  url.searchParams.set("scope", scope);
  const safeUrl = url.href;
  const protocols = devAuthProtocols();

  const socket = protocols
    ? await openWebSocket(url, {
        origin: credentialedSmokeOrigin({ baseUrl, protocols }),
        protocols,
      })
    : new WebSocket(url);
  if ("binaryType" in socket) {
    socket.binaryType = "arraybuffer";
  }
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

  if (!protocols) {
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", () => reject(new Error(`failed to connect ${safeUrl}`)), {
        once: true,
      });
    });
  }

  const client = {
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
  const ready = await client.nextFrame(
    (frame) => frame.type === FrameType.SESSION_CONTROL && frame.json.type === "cloud_room_ready",
  );
  return { ...client, ready: ready.json };
}

async function connectAnonymous(notebookId, sessionId) {
  const url = new URL(`/n/${encodeURIComponent(notebookId)}/sync`, baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("viewer_session", sessionId);

  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
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

  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error(`failed to connect ${url.href}`)), {
      once: true,
    });
  });

  const client = {
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
          reject(new Error(`timed out waiting for frame from ${url.href}`));
        }, timeoutMs);
        waiters.push({ predicate, resolve, timer });
      });
    },
  };
  const ready = await client.nextFrame(
    (frame) => frame.type === FrameType.SESSION_CONTROL && frame.json.type === "cloud_room_ready",
  );
  return { ...client, ready: ready.json };
}

async function closeClient(client) {
  if (client.socket.readyState === WebSocket.CLOSED) {
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

async function fetchJson(pathname) {
  const url = new URL(pathname, baseUrl);
  const response = await fetch(url);
  assert(response.ok, `${url.href} returned ${response.status}`);
  return response.json();
}

async function putBytes(pathname, body, contentType, extraHeaders = {}) {
  const url = new URL(pathname, baseUrl);
  const response = await fetch(url, {
    method: "PUT",
    headers: {
      "Content-Type": contentType,
      "X-User": "alice",
      "X-Operator": "desktop:smoke",
      "X-Scope": "owner",
      ...devAuthHeaders(),
      ...extraHeaders,
    },
    body,
  });
  assert(response.ok, `${url.href} returned ${response.status}`);
  return response.json();
}

function snapshotPairForNotebook(notebookId) {
  const handle = wasm.NotebookHandle.load_snapshot(fixtureNotebookBytes, fixtureRuntimeBytes);
  try {
    handle.set_runtime_state_doc_id(`runtime:${notebookId}`);
    const savedNotebookBytes = handle.save();
    const savedRuntimeBytes = handle.save_state_doc();
    const runtimeStateDocId = handle.get_runtime_state_doc_id();
    assert(
      typeof runtimeStateDocId === "string" && runtimeStateDocId.length > 0,
      "NotebookDoc smoke fixture is missing runtime_state_doc_id",
    );
    return {
      notebookBytes: savedNotebookBytes,
      runtimeBytes: savedRuntimeBytes,
      runtimeStateDocId,
    };
  } finally {
    handle.free();
  }
}

async function fetchBytes(pathname, extraHeaders = {}) {
  const url = new URL(pathname, baseUrl);
  const response = await fetch(url, { headers: extraHeaders });
  assert(response.ok, `${url.href} returned ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

async function fetchHead(pathname) {
  const url = new URL(pathname, baseUrl);
  const response = await fetch(url, { method: "HEAD" });
  assert(response.ok, `${url.href} returned ${response.status}`);
  return response;
}

function assertBytesEqual(actual, expected, message) {
  assert(actual.byteLength === expected.byteLength, message);
  for (let index = 0; index < expected.byteLength; index += 1) {
    assert(actual[index] === expected[index], message);
  }
}

function sendJsonFrame(socket, type, payload) {
  sendBinaryFrame(socket, type, new TextEncoder().encode(JSON.stringify(payload)));
}

function sendPresenceFrame(socket, message) {
  sendBinaryFrame(socket, FrameType.PRESENCE, wasm.encode_presence_frame(message));
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
  } else if (type === FrameType.PRESENCE) {
    try {
      json = wasm.decode_presence_frame(payload);
    } catch {
      json = undefined;
    }
  }
  return { type, payload, bytes, json };
}

function devAuthHeaders() {
  return devAuthToken ? { "X-Notebook-Cloud-Dev-Token": devAuthToken } : {};
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function devAuthProtocols() {
  return devAuthToken ? [`nteract-dev-token.${base64Url(devAuthToken)}`, "nteract.v4"] : undefined;
}

function base64Url(value) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
