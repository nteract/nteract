import { randomUUID } from "node:crypto";
import { FrameType } from "runtimed";
import { notebookCloudBaseUrl } from "./local-dev.mjs";
import {
  clientForSocket,
  closeClient,
  openWebSocket,
  safeWebSocketUrl,
  sendBinaryFrame,
} from "./raw-websocket-client.mjs";
import { assertWasmRoundtripAuthEnv, credentialedSmokeOrigin } from "./wasm-roundtrip-env.mjs";
import {
  assertRuntimedWasmBuildExists,
  initializeRuntimedWasmSyncForNode,
} from "./runtimed-wasm-artifact.mjs";

const baseUrl = notebookCloudBaseUrl();
const devAuthToken = process.env.NOTEBOOK_CLOUD_DEV_TOKEN;
const roomId = `wasm-${Date.now()}`;
const runtimeStateDocId = `runtime-state:${randomUUID()}`;
const timingsMs = {};

if (typeof WebSocket === "undefined") {
  throw new Error("This smoke script requires Node.js with a global WebSocket implementation");
}

const startedAt = performance.now();
assertWasmRoundtripAuthEnv({ baseUrl, devAuthToken });
await assertRuntimedWasmBuildExists();

const { NotebookHandle } = await timed("runtimed_wasm_init", () =>
  initializeRuntimedWasmSyncForNode(),
);

await timed("owner_seed", () => seedNotebookOwner(roomId));
await timed("acl_grants", async () => {
  await grantAcl(roomId, {
    subject_kind: "principal",
    subject: "user:dev:bob",
    scope: "editor",
  });
  await grantAcl(roomId, {
    subject_kind: "public",
    subject: "anonymous",
    scope: "viewer",
  });
});
await timed("ungranted_editor_downgrade", () => assertEditorDowngraded(roomId, "charlie"));

const { alice, bob, anonymous } = await timed("connect_peers", async () => ({
  alice: await connect(roomId, "alice", "desktop:wasm", "owner"),
  bob: await connect(roomId, "bob", "desktop:wasm", "editor"),
  anonymous: await connectAnonymous(roomId, "anon-wasm"),
}));

const aliceHandle = NotebookHandle.create_bootstrap(alice.ready.actor_label);
const bobHandle = NotebookHandle.create_bootstrap(bob.ready.actor_label);
const anonymousHandle = NotebookHandle.create_bootstrap(anonymous.ready.actor_label);
const participants = [
  { name: "alice", client: alice, handle: aliceHandle },
  { name: "bob", client: bob, handle: bobHandle },
  { name: "anonymous", client: anonymous, handle: anonymousHandle },
];

aliceHandle.add_cell_after("cell-wasm-1", "markdown", null);
aliceHandle.update_source("cell-wasm-1", "Alice live markdown\n");
sendHandleChanges(alice, aliceHandle);

let processedFrames = await timed("alice_to_bob_anonymous_convergence", () =>
  driveSyncUntil(
    participants,
    () =>
      cellSource(bobHandle, "cell-wasm-1") === "Alice live markdown\n" &&
      cellSource(anonymousHandle, "cell-wasm-1") === "Alice live markdown\n",
    "Alice markdown did not converge to Bob and anonymous viewer",
  ),
);

bobHandle.update_source("cell-wasm-1", "Bob edited live markdown\n");
sendHandleChanges(bob, bobHandle);
processedFrames += await timed("bob_to_alice_anonymous_convergence", () =>
  driveSyncUntil(
    participants,
    () =>
      cellSource(aliceHandle, "cell-wasm-1") === "Bob edited live markdown\n" &&
      cellSource(anonymousHandle, "cell-wasm-1") === "Bob edited live markdown\n",
    "Bob markdown edit did not converge to Alice and anonymous viewer",
  ),
);

assert(
  bobHandle.contributing_actors().includes(alice.ready.actor_label),
  `Bob handle did not record Alice actor: ${bobHandle.contributing_actors().join(", ")}`,
);
assert(
  aliceHandle.contributing_actors().includes(bob.ready.actor_label),
  `Alice handle did not record Bob actor: ${aliceHandle.contributing_actors().join(", ")}`,
);

console.log(
  JSON.stringify(
    {
      ok: true,
      baseUrl,
      roomId,
      runtimeStateDocId,
      checks: [
        "runtimed_wasm_init",
        "owner_seeded_acl_room",
        "editor_acl_grant",
        "anonymous_viewer_acl_grant",
        "ungranted_editor_downgraded_to_viewer",
        "real_automerge_sync_payload",
        "durable_object_materialized_room_sync",
        "editor_editor_convergence",
        "anonymous_viewer_live_convergence",
        "actor_attribution_preserved",
      ],
      timings_ms: {
        ...timingsMs,
        total: elapsedMs(startedAt),
      },
      processedFrames,
      bob: {
        cell_count: bobHandle.cell_count(),
        source: bobHandle.get_cell_source("cell-wasm-1"),
        actors: bobHandle.contributing_actors(),
      },
      anonymous: {
        cell_count: anonymousHandle.cell_count(),
        source: anonymousHandle.get_cell_source("cell-wasm-1"),
      },
    },
    null,
    2,
  ),
);

await Promise.all([alice, bob, anonymous].map(closeClient));
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

async function seedNotebookOwner(notebookId) {
  const response = await fetch(
    new URL(
      `/api/n/${encodeURIComponent(notebookId)}/runtime-snapshots/bootstrap-runtime`,
      baseUrl,
    ),
    {
      method: "PUT",
      headers: requestHeaders("alice", "desktop:wasm", "owner", "application/octet-stream"),
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
    headers: requestHeaders("alice", "desktop:wasm", "owner", "application/json"),
    body: JSON.stringify(body),
  });
  assert(response.status === 201, `ACL grant failed: ${response.status} ${await response.text()}`);
}

async function assertEditorDowngraded(notebookId, user) {
  const client = await connect(notebookId, user, "desktop:wasm", "editor");
  try {
    assert(
      client.ready.connection_scope === "viewer",
      `ungranted editor ${user} connected with scope ${client.ready.connection_scope}`,
    );
  } finally {
    await closeClient(client);
  }
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

async function connect(notebookId, user, operator, scope) {
  const url = new URL(`/n/${encodeURIComponent(notebookId)}/sync`, baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("user", user);
  url.searchParams.set("operator", operator);
  url.searchParams.set("scope", scope);
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
  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  const client = await clientForSocket(socket, safeWebSocketUrl(url));
  const ready = await client.nextFrame(
    (frame) => frame.type === FrameType.SESSION_CONTROL && frame.json.type === "cloud_room_ready",
  );
  return { ...client, ready: ready.json };
}

function requestHeaders(user, operator, scope, contentType) {
  const headers = {
    "Content-Type": contentType,
    "X-User": user,
    "X-Operator": operator,
    "X-Scope": scope,
    "X-Runtime-State-Doc-Id": runtimeStateDocId,
  };
  if (devAuthToken) {
    headers["X-Notebook-Cloud-Dev-Token"] = devAuthToken;
  }
  return headers;
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
