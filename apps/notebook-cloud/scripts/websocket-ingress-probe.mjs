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

const baseUrl = notebookCloudBaseUrl();
const notebookId = `ws-ingress-${Date.now()}`;
const runtimeStateDocId = `runtime-state:${randomUUID()}`;

const seed = await fetch(
  new URL(`/api/n/${encodeURIComponent(notebookId)}/runtime-snapshots/bootstrap-runtime`, baseUrl),
  {
    method: "PUT",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-User": "alice",
      "X-Operator": "desktop:ws-ingress",
      "X-Scope": "owner",
      "X-Runtime-State-Doc-Id": runtimeStateDocId,
    },
    body: new Uint8Array([0]),
  },
);
assert(seed.status === 201, `owner seed failed: ${seed.status} ${await seed.text()}`);

const url = new URL(`/n/${encodeURIComponent(notebookId)}/sync`, baseUrl);
url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
url.searchParams.set("user", "alice");
url.searchParams.set("operator", "desktop:ws-ingress");
url.searchParams.set("scope", "owner");

const socket = await openWebSocket(url);
const client = await clientForSocket(socket, safeWebSocketUrl(url));
const ready = await client.nextFrame(
  (frame) => frame.type === FrameType.SESSION_CONTROL && frame.json?.type === "cloud_room_ready",
);

const startedAt = performance.now();
sendBinaryFrame(socket, 255, new Uint8Array([1, 2, 3]));
const rejected = await client.nextFrame(
  (frame) =>
    frame.type === FrameType.SESSION_CONTROL && frame.json?.type === "cloud_frame_rejected",
  15_000,
);

const materializerStartedAt = performance.now();
sendBinaryFrame(socket, FrameType.AUTOMERGE_SYNC, new Uint8Array([1, 2, 3]));
const materializerRejected = await client.nextFrame(
  (frame) =>
    frame.type === FrameType.SESSION_CONTROL &&
    frame.json?.type === "cloud_frame_rejected" &&
    frame.json?.frame_type === FrameType.AUTOMERGE_SYNC,
  15_000,
);

console.log(
  JSON.stringify(
    {
      ok: true,
      baseUrl,
      notebookId,
      actorLabel: ready.json.actor_label,
      rejectedFrameType: rejected.json.frame_type,
      reason: rejected.json.reason,
      roundTripMs: Math.round((performance.now() - startedAt) * 100) / 100,
      materializerReason: materializerRejected.json.reason,
      materializerRoundTripMs: Math.round((performance.now() - materializerStartedAt) * 100) / 100,
    },
    null,
    2,
  ),
);

await closeClient(client);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
