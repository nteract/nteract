import { randomUUID } from "node:crypto";
import { FrameType } from "runtimed";

import {
  clientForSocket,
  closeClient,
  openWebSocket,
  safeWebSocketUrl,
  sendBinaryFrame,
} from "./raw-websocket-client.mjs";
import { credentialedSmokeOrigin } from "./wasm-roundtrip-env.mjs";
import {
  assertRuntimedWasmBuildExists,
  initializeRuntimedWasmSyncForNode,
} from "./runtimed-wasm-artifact.mjs";

const primaryUrl = requiredUrl("NTERACT_CLOUD_URL");
const failoverUrl = requiredUrl("NOTEBOOK_CLOUD_FAILOVER_URL");
const devAuthToken = process.env.NOTEBOOK_CLOUD_DEV_TOKEN;
const roomId = `failover-${Date.now()}`;
const runtimeStateDocId = `runtime-state:${randomUUID()}`;
const cellId = "cell-failover-1";
const acknowledgedSource = "Acknowledged before node loss\n";
const recoveredSource = "Edited after failover\n";
const startedAt = performance.now();

if (typeof WebSocket === "undefined") {
  throw new Error("This probe requires Node.js with a global WebSocket implementation");
}

await assertRuntimedWasmBuildExists();
const { NotebookHandle } = await initializeRuntimedWasmSyncForNode();

await seedNotebookOwner(primaryUrl, roomId);
await grantEditor(primaryUrl, roomId);

const alice = await connect(primaryUrl, roomId, "alice", "owner");
const bob = await connect(primaryUrl, roomId, "bob", "editor");
const aliceHandle = NotebookHandle.create_bootstrap(alice.ready.actor_label);
const bobHandle = NotebookHandle.create_bootstrap(bob.ready.actor_label);
const primaryParticipants = [
  { client: alice, handle: aliceHandle },
  { client: bob, handle: bobHandle },
];

aliceHandle.add_cell_after(cellId, "markdown", null);
aliceHandle.update_source(cellId, acknowledgedSource);
sendHandleChanges(alice, aliceHandle);
await awaitDurableAcceptance(alice);
await driveSyncUntil(
  primaryParticipants,
  () => cellSource(bobHandle, cellId) === acknowledgedSource,
  "the acknowledged edit did not converge before node loss",
);

const primaryClosed = Promise.race([
  socketClosed(alice.socket),
  socketClosed(bob.socket),
  timeoutReject(30_000, "primary node did not disconnect an active editor within 30 seconds"),
]);
console.log(
  JSON.stringify({
    event: "failover_ready",
    room_id: roomId,
    primary_url: redactUrl(primaryUrl),
    failover_url: redactUrl(failoverUrl),
    acknowledged_source: acknowledgedSource,
  }),
);

const disconnectedAt = performance.now();
await primaryClosed;
const aliceRecovered = await reconnectUntil(failoverUrl, roomId, "alice", "owner", 10_000);
const bobRecovered = await reconnectUntil(failoverUrl, roomId, "bob", "editor", 10_000);
const aliceRecoveredHandle = NotebookHandle.create_bootstrap(aliceRecovered.ready.actor_label);
const bobRecoveredHandle = NotebookHandle.create_bootstrap(bobRecovered.ready.actor_label);
const recoveredParticipants = [
  { client: aliceRecovered, handle: aliceRecoveredHandle },
  { client: bobRecovered, handle: bobRecoveredHandle },
];

await driveSyncUntil(
  recoveredParticipants,
  () =>
    cellSource(aliceRecoveredHandle, cellId) === acknowledgedSource &&
    cellSource(bobRecoveredHandle, cellId) === acknowledgedSource,
  "the failover node did not recover the acknowledged edit",
);
const reconnectMs = elapsedMs(disconnectedAt);

bobRecoveredHandle.update_source(cellId, recoveredSource);
sendHandleChanges(bobRecovered, bobRecoveredHandle);
await awaitDurableAcceptance(bobRecovered);
await driveSyncUntil(
  recoveredParticipants,
  () => cellSource(aliceRecoveredHandle, cellId) === recoveredSource,
  "the post-failover edit did not converge",
);

console.log(
  JSON.stringify(
    {
      ok: true,
      roomId,
      checks: [
        "active_two_editor_session",
        "pre_failure_frame_durably_acknowledged",
        "active_connection_interrupted",
        "bounded_reconnect_to_second_node",
        "acknowledged_state_recovered",
        "post_failover_edit_durably_acknowledged",
        "post_failover_convergence",
      ],
      timings_ms: {
        reconnect_after_disconnect: reconnectMs,
        total: elapsedMs(startedAt),
      },
      source: cellSource(aliceRecoveredHandle, cellId),
    },
    null,
    2,
  ),
);

await Promise.all(
  [alice, bob, aliceRecovered, bobRecovered].map((client) => closeClient(client).catch(() => {})),
);

async function reconnectUntil(baseUrl, notebookId, user, scope, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await connect(baseUrl, notebookId, user, scope);
    } catch (error) {
      lastError = error;
      await sleep(100);
    }
  }
  throw new Error(`failed to reconnect ${user}: ${lastError?.message ?? "unknown error"}`);
}

async function seedNotebookOwner(baseUrl, notebookId) {
  const response = await fetch(
    new URL(
      `/api/n/${encodeURIComponent(notebookId)}/runtime-snapshots/bootstrap-runtime`,
      baseUrl,
    ),
    {
      method: "PUT",
      headers: requestHeaders("alice", "owner", "application/octet-stream"),
      body: new Uint8Array([0]),
    },
  );
  assert(
    response.status === 201,
    `owner bootstrap failed: ${response.status} ${await response.text()}`,
  );
}

async function grantEditor(baseUrl, notebookId) {
  const response = await fetch(new URL(`/api/n/${encodeURIComponent(notebookId)}/acl`, baseUrl), {
    method: "POST",
    headers: requestHeaders("alice", "owner", "application/json"),
    body: JSON.stringify({ subject_kind: "principal", subject: "user:dev:bob", scope: "editor" }),
  });
  assert(
    response.status === 201,
    `editor grant failed: ${response.status} ${await response.text()}`,
  );
}

function requestHeaders(user, scope, contentType) {
  const headers = {
    "Content-Type": contentType,
    "X-User": user,
    "X-Operator": "desktop:active-failover",
    "X-Scope": scope,
    "X-Runtime-State-Doc-Id": runtimeStateDocId,
  };
  if (devAuthToken) headers["X-Notebook-Cloud-Dev-Token"] = devAuthToken;
  return headers;
}

async function connect(baseUrl, notebookId, user, scope) {
  const url = new URL(`/n/${encodeURIComponent(notebookId)}/sync`, baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("user", user);
  url.searchParams.set("operator", "desktop:active-failover");
  url.searchParams.set("scope", scope);
  const protocols = devAuthToken
    ? [`nteract-dev-token.${Buffer.from(devAuthToken, "utf8").toString("base64url")}`, "nteract.v4"]
    : undefined;
  const socket = protocols
    ? await openWebSocket(url, {
        origin: credentialedSmokeOrigin({ baseUrl, protocols }),
        protocols,
      })
    : new WebSocket(url);
  if ("binaryType" in socket) socket.binaryType = "arraybuffer";
  const client = await clientForSocket(socket, safeWebSocketUrl(url));
  const ready = await client.nextFrame(
    (frame) => frame.type === FrameType.SESSION_CONTROL && frame.json?.type === "cloud_room_ready",
  );
  return { ...client, ready: ready.json };
}

function sendHandleChanges(client, handle) {
  const payload = handle.flush_local_changes();
  assert(payload?.byteLength > 0, "expected local Automerge changes");
  sendBinaryFrame(client.socket, FrameType.AUTOMERGE_SYNC, payload);
}

async function awaitDurableAcceptance(client) {
  return client.nextFrame(
    (frame) =>
      frame.type === FrameType.SESSION_CONTROL &&
      frame.json?.type === "cloud_frame_accepted" &&
      frame.json?.frame_type === FrameType.AUTOMERGE_SYNC,
    10_000,
  );
}

async function driveSyncUntil(participants, predicate, failureMessage) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    let progressed = false;
    for (const participant of participants) {
      const frame = await participant.client
        .nextFrame((candidate) => candidate.type === FrameType.AUTOMERGE_SYNC, 50)
        .catch(() => undefined);
      if (!frame) continue;
      progressed = true;
      for (const event of participant.handle.receive_frame(frame.bytes)) {
        if (Array.isArray(event.reply)) {
          sendBinaryFrame(
            participant.client.socket,
            FrameType.AUTOMERGE_SYNC,
            new Uint8Array(event.reply),
          );
        }
      }
    }
    if (!progressed) await sleep(25);
  }
  throw new Error(failureMessage);
}

function socketClosed(socket) {
  if (socket.readyState === 3) return Promise.resolve();
  return new Promise((resolve) => socket.addEventListener("close", resolve, { once: true }));
}

function timeoutReject(ms, message) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms));
}

function cellSource(handle, id) {
  try {
    return handle.get_cell_source(id);
  } catch {
    return undefined;
  }
}

function requiredUrl(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return new URL(value).toString();
}

function redactUrl(value) {
  const url = new URL(value);
  url.username = "";
  url.password = "";
  return url.toString();
}

function elapsedMs(started) {
  return Math.round((performance.now() - started) * 100) / 100;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
