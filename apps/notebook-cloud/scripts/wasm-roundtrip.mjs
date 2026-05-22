import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const FrameType = {
  AUTOMERGE_SYNC: 0x00,
  SESSION_CONTROL: 0x07,
};

const baseUrl = process.env.NOTEBOOK_CLOUD_URL ?? "http://127.0.0.1:8787";
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

const aliceActor = "user:dev:alice/desktop:wasm";
const bobActor = "user:dev:bob/desktop:wasm";
const aliceHandle = NotebookHandle.create_bootstrap(aliceActor);
const bobHandle = NotebookHandle.create_bootstrap(bobActor);
const alice = await connect(roomId, "alice", "desktop:wasm", "owner");
const bob = await connect(roomId, "bob", "desktop:wasm", "editor");

aliceHandle.add_cell_after("cell-wasm-1", "code", null);
aliceHandle.update_source("cell-wasm-1", "print('cloud wasm')");

let nextPayload = aliceHandle.flush_local_changes();
let sender = alice;
let receiver = bob;
let receiverHandle = bobHandle;
let hops = 0;

while (nextPayload && hops < 10) {
  sendBinaryFrame(sender.socket, FrameType.AUTOMERGE_SYNC, nextPayload);

  const received = await receiver.nextFrame((frame) => frame.type === FrameType.AUTOMERGE_SYNC);
  const events = receiverHandle.receive_frame(received.bytes);
  const reply = events.find((event) => Array.isArray(event.reply))?.reply;

  nextPayload = reply ? new Uint8Array(reply) : undefined;
  [sender, receiver] = [receiver, sender];
  receiverHandle = receiverHandle === bobHandle ? aliceHandle : bobHandle;
  hops += 1;
}

assert(
  bobHandle.cell_count() === 1,
  `expected Bob handle to receive one cell, got ${bobHandle.cell_count()}`,
);
assert(
  bobHandle.get_cell_source("cell-wasm-1") === "print('cloud wasm')",
  `unexpected Bob cell source: ${bobHandle.get_cell_source("cell-wasm-1")}`,
);
assert(
  bobHandle.contributing_actors().includes(aliceActor),
  `Bob handle did not record Alice actor: ${bobHandle.contributing_actors().join(", ")}`,
);

console.log(
  JSON.stringify(
    {
      ok: true,
      baseUrl,
      roomId,
      checks: [
        "runtimed_wasm_init",
        "real_automerge_sync_payload",
        "durable_object_typed_frame_relay",
        "wasm_handle_convergence",
        "actor_attribution_preserved",
      ],
      hops,
      bob: {
        cell_count: bobHandle.cell_count(),
        source: bobHandle.get_cell_source("cell-wasm-1"),
        actors: bobHandle.contributing_actors(),
      },
    },
    null,
    2,
  ),
);

await Promise.all([alice, bob].map(closeClient));
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
  await client.nextFrame(
    (frame) => frame.type === FrameType.SESSION_CONTROL && frame.json.type === "cloud_room_ready",
  );
  return client;
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

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
