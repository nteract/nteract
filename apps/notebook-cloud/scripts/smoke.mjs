const FrameType = {
  AUTOMERGE_SYNC: 0x00,
  PRESENCE: 0x04,
  POOL_STATE_SYNC: 0x06,
  SESSION_CONTROL: 0x07,
  PUT_BLOB: 0x08,
};

const baseUrl = process.env.NOTEBOOK_CLOUD_URL ?? "http://127.0.0.1:8787";
const roomId = `smoke-${Date.now()}`;
const otherRoomId = `${roomId}-other`;

if (typeof WebSocket === "undefined") {
  throw new Error("This smoke script requires Node.js with a global WebSocket implementation");
}

const health = await fetch(new URL("/api/health", baseUrl));
assert(health.ok, `health check failed: ${health.status}`);

const alice = await connect(roomId, "alice", "desktop:alice", "owner");
const bob = await connect(roomId, "bob", "desktop:bob", "editor");
const other = await connect(otherRoomId, "other", "desktop:other", "owner");
const viewer = await connect(roomId, "viewer", "desktop:viewer", "viewer");

assert(
  alice.ready.actor_label === "user:dev:alice/desktop:alice",
  "alice actor label was not stamped",
);
assert(bob.ready.actor_label === "user:dev:bob/desktop:bob", "bob actor label was not stamped");
assert(other.ready.notebook_id === otherRoomId, "other room routed to the wrong notebook id");

sendJsonFrame(alice.socket, FrameType.PRESENCE, {
  peer_label: "Alice",
  actor_label: "user:dev:mallory/desktop:alice",
});

const rewrittenPresence = await bob.nextFrame((frame) => frame.type === FrameType.PRESENCE);
assert(
  rewrittenPresence.json.actor_label === "user:dev:alice/desktop:alice",
  `presence principal was not rewritten: ${JSON.stringify(rewrittenPresence.json)}`,
);

sendBinaryFrame(alice.socket, FrameType.PRESENCE, new Uint8Array([0xa1, 0x01, 0x02]));
const fallbackPresence = await bob.nextFrame((frame) => frame.type === FrameType.PRESENCE);
assert(
  fallbackPresence.json.actor_label === "user:dev:alice/desktop:alice",
  `malformed presence was not stamped safely: ${JSON.stringify(fallbackPresence.json)}`,
);
assert(
  fallbackPresence.json.presence_format === "unparsed",
  `malformed presence did not carry fallback marker: ${JSON.stringify(fallbackPresence.json)}`,
);

sendJsonFrame(alice.socket, FrameType.PRESENCE, {
  peer_label: "Alice",
  actor_label: "/bad",
});
const invalidActorPresence = await bob.nextFrame((frame) => frame.type === FrameType.PRESENCE);
assert(
  invalidActorPresence.json.actor_label === "user:dev:alice/desktop:alice",
  `invalid actor presence was not stamped safely: ${JSON.stringify(invalidActorPresence.json)}`,
);

sendBinaryFrame(alice.socket, FrameType.AUTOMERGE_SYNC, new Uint8Array([1, 2, 3, 4]));
const relayedSync = await bob.nextFrame((frame) => frame.type === FrameType.AUTOMERGE_SYNC);
assert(relayedSync.payload.byteLength === 4, "same-room sync frame was not relayed");

const accepted = await alice.nextFrame(
  (frame) =>
    frame.type === FrameType.SESSION_CONTROL &&
    frame.json.type === "cloud_frame_accepted" &&
    frame.json.frame_type === FrameType.AUTOMERGE_SYNC,
);
assert(accepted.json.frame_type === FrameType.AUTOMERGE_SYNC, "owner sync frame was not accepted");

sendBinaryFrame(viewer.socket, FrameType.AUTOMERGE_SYNC, new Uint8Array([9]));
const rejected = await viewer.nextFrame(
  (frame) => frame.type === FrameType.SESSION_CONTROL && frame.json.type === "cloud_frame_rejected",
);
assert(rejected.json.reason.includes("viewer cannot write"), "viewer write was not rejected");

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

const events = await fetchJson(`/api/n/${encodeURIComponent(roomId)}/events?limit=20`);
assert(
  events.events.some((event) => event.frame_type === FrameType.AUTOMERGE_SYNC),
  "D1 event readback did not include the accepted sync frame",
);

const leaked = await other
  .nextFrame((frame) => frame.type === FrameType.AUTOMERGE_SYNC, 250)
  .catch(() => undefined);
assert(leaked === undefined, "frame leaked across Durable Object room ids");

console.log(
  JSON.stringify(
    {
      ok: true,
      baseUrl,
      roomId,
      checks: [
        "websocket_upgrade",
        "durable_object_room_routing",
        "identity_stamping",
        "presence_principal_rewrite",
        "malformed_presence_safe_fallback",
        "invalid_presence_actor_safe_fallback",
        "typed_frame_relay",
        "scope_rejection",
        "viewer_blob_rejection",
        "viewer_pool_rejection",
        "d1_room_event_readback",
      ],
    },
    null,
    2,
  ),
);

await Promise.all([alice, bob, other, viewer].map(closeClient));
process.exit(0);

async function connect(notebookId, user, operator, scope) {
  const url = new URL(`/n/${encodeURIComponent(notebookId)}/sync`, baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("user", user);
  url.searchParams.set("operator", operator);
  url.searchParams.set("scope", scope);

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

function sendJsonFrame(socket, type, payload) {
  sendBinaryFrame(socket, type, new TextEncoder().encode(JSON.stringify(payload)));
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
  if (type === FrameType.SESSION_CONTROL || type === FrameType.PRESENCE) {
    try {
      json = JSON.parse(new TextDecoder().decode(payload));
    } catch {
      json = undefined;
    }
  }
  return { type, payload, json };
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
