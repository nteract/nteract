import { FrameType } from "runtimed";

import { notebookCloudBaseUrl } from "./local-dev.mjs";
import {
  clientForSocket,
  closeClient,
  openWebSocket,
  safeWebSocketUrl,
  sendBinaryFrame,
} from "./raw-websocket-client.mjs";
import {
  assertRuntimedWasmBuildExists,
  initializeRuntimedWasmSyncForNode,
} from "./runtimed-wasm-artifact.mjs";

const baseUrl = notebookCloudBaseUrl();
const notebookId = requiredEnv("NOTEBOOK_CLOUD_REOPEN_ROOM_ID");
const expectedCellId = process.env.NOTEBOOK_CLOUD_REOPEN_CELL_ID || "cell-wasm-1";
const expectedSource = process.env.NOTEBOOK_CLOUD_REOPEN_SOURCE || "Bob edited live markdown\n";
const startedAt = performance.now();

await assertRuntimedWasmBuildExists();
const { NotebookHandle } = await initializeRuntimedWasmSyncForNode();

const url = new URL(`/n/${encodeURIComponent(notebookId)}/sync`, baseUrl);
url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
url.searchParams.set("user", "alice");
url.searchParams.set("operator", "desktop:reopen");
url.searchParams.set("scope", "owner");

const socket = await openWebSocket(url);
const client = await clientForSocket(socket, safeWebSocketUrl(url));
const ready = await client.nextFrame(
  (frame) => frame.type === FrameType.SESSION_CONTROL && frame.json?.type === "cloud_room_ready",
);
const handle = NotebookHandle.create_bootstrap(ready.json.actor_label);

let processedFrames = 0;
const deadline = Date.now() + 15_000;
while (Date.now() < deadline && cellSource(handle, expectedCellId) !== expectedSource) {
  const frame = await client
    .nextFrame((candidate) => candidate.type === FrameType.AUTOMERGE_SYNC, 250)
    .catch(() => undefined);
  if (!frame) {
    continue;
  }
  processedFrames += 1;
  for (const event of handle.receive_frame(frame.bytes)) {
    if (Array.isArray(event.reply)) {
      sendBinaryFrame(socket, FrameType.AUTOMERGE_SYNC, new Uint8Array(event.reply));
    }
  }
}

const source = cellSource(handle, expectedCellId);
assert(source === expectedSource, `reopened source mismatch: ${JSON.stringify(source)}`);

console.log(
  JSON.stringify(
    {
      ok: true,
      baseUrl,
      notebookId,
      cellId: expectedCellId,
      source,
      processedFrames,
      elapsedMs: Math.round((performance.now() - startedAt) * 100) / 100,
    },
    null,
    2,
  ),
);

await closeClient(client);

function cellSource(handle, cellId) {
  try {
    return handle.get_cell_source(cellId);
  } catch {
    return undefined;
  }
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
