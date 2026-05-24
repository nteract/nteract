import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { FrameType } from "runtimed";

const baseUrl = process.env.NOTEBOOK_CLOUD_URL ?? "http://127.0.0.1:8787";
const devAuthToken = process.env.NOTEBOOK_CLOUD_DEV_TOKEN;
const roomId = `wasm-${Date.now()}`;
const wasmJsUrl = new URL(
  "../../notebook/src/wasm/runtimed-wasm/runtimed_wasm.js",
  import.meta.url,
);
const wasmBytesUrl = new URL(
  "../../notebook/src/wasm/runtimed-wasm/runtimed_wasm_bg.wasm",
  import.meta.url,
);

if (typeof WebSocket === "undefined") {
  throw new Error("This smoke script requires Node.js with a global WebSocket implementation");
}

await assertWasmBuildExists();

const { initSync, NotebookHandle } = await import(wasmJsUrl.href);
const wasmBytes = await readFile(wasmBytesUrl);
initSync({ module: wasmBytes });

await seedNotebookOwner(roomId);
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
await assertEditorDenied(roomId, "charlie");

const alice = await connect(roomId, "alice", "desktop:wasm", "owner");
const bob = await connect(roomId, "bob", "desktop:wasm", "editor");
const anonymous = await connectAnonymous(roomId, "anon-wasm");

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

let processedFrames = await driveSyncUntil(
  participants,
  () =>
    cellSource(bobHandle, "cell-wasm-1") === "Alice live markdown\n" &&
    cellSource(anonymousHandle, "cell-wasm-1") === "Alice live markdown\n",
  "Alice markdown did not converge to Bob and anonymous viewer",
);

bobHandle.update_source("cell-wasm-1", "Bob edited live markdown\n");
sendHandleChanges(bob, bobHandle);
processedFrames += await driveSyncUntil(
  participants,
  () =>
    cellSource(aliceHandle, "cell-wasm-1") === "Bob edited live markdown\n" &&
    cellSource(anonymousHandle, "cell-wasm-1") === "Bob edited live markdown\n",
  "Bob markdown edit did not converge to Alice and anonymous viewer",
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
      checks: [
        "runtimed_wasm_init",
        "owner_seeded_acl_room",
        "editor_acl_grant",
        "anonymous_viewer_acl_grant",
        "ungranted_editor_denied",
        "real_automerge_sync_payload",
        "durable_object_materialized_room_sync",
        "editor_editor_convergence",
        "anonymous_viewer_live_convergence",
        "actor_attribution_preserved",
      ],
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

async function assertEditorDenied(notebookId, user) {
  try {
    const client = await connect(notebookId, user, "desktop:wasm", "editor");
    await closeClient(client);
  } catch {
    return;
  }
  throw new Error(`ungranted editor ${user} unexpectedly connected`);
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
  const safeUrl = url.href;
  const protocols = devAuthProtocols();

  const socket = protocols ? new WebSocket(url, protocols) : new WebSocket(url);
  socket.binaryType = "arraybuffer";
  const client = await clientForSocket(socket, safeUrl);
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

  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error(`failed to connect ${safeUrl}`)), {
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
          reject(new Error(`timed out waiting for frame from ${safeUrl}`));
        }, timeoutMs);
        waiters.push({ predicate, resolve, timer });
      });
    },
  };
  return client;
}

function requestHeaders(user, operator, scope, contentType) {
  const headers = {
    "Content-Type": contentType,
    "X-User": user,
    "X-Operator": operator,
    "X-Scope": scope,
  };
  if (devAuthToken) {
    headers["X-Notebook-Cloud-Dev-Token"] = devAuthToken;
  }
  return headers;
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function devAuthProtocols() {
  return devAuthToken ? [`nteract-dev-token.${base64Url(devAuthToken)}`] : undefined;
}

function base64Url(value) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
