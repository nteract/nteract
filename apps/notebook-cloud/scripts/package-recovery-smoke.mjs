/** Reproduce the planner-wedge user report against the local celld fleet:
 * typo add (not found) -> correct add (queued cooldown, then success) ->
 * another add after that also succeeds. The smoke attaches the managed Python
 * workstation, then uses the package request/response path directly. */
import { FrameType } from "runtimed";
import { clientForSocket, sendBinaryFrame } from "./raw-websocket-client.mjs";

const baseUrl = new URL(process.env.NOTEBOOK_CLOUD_PACKAGE_ORIGIN ?? "http://127.0.0.1:9876");
if (!["127.0.0.1", "localhost", "[::1]"].includes(baseUrl.hostname))
  throw new Error("This smoke must target loopback");
const user = `package-recovery-${Date.now()}`;
const timeoutMs = Number(process.env.NOTEBOOK_CLOUD_PACKAGE_TIMEOUT_MS ?? 180_000);

const created = await fetch(
  new URL(`/api/n?user=${user}&scope=owner&operator=node:smoke`, baseUrl),
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Package recovery smoke" }),
    signal: AbortSignal.timeout(30_000),
  },
);
if (!created.ok) throw new Error(`create notebook: ${created.status} ${await created.text()}`);
const { notebook_id: notebookId } = await created.json();
console.log(`notebook ${notebookId}`);

async function connect() {
  const url = new URL(`/n/${notebookId}/sync`, baseUrl);
  url.protocol = "ws:";
  url.searchParams.set("user", user);
  url.searchParams.set("operator", "node:smoke");
  url.searchParams.set("scope", "owner");
  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  const client = await clientForSocket(socket, url.toString());
  const ready = await client.nextFrame(
    (frame) => frame.type === FrameType.SESSION_CONTROL && frame.json.type === "cloud_room_ready",
  );
  return { ...client, ready: ready.json };
}

async function request(client, action, extra, label, timeout = timeoutMs) {
  const id = `smoke-${label}`;
  sendBinaryFrame(
    client.socket,
    FrameType.REQUEST,
    new TextEncoder().encode(JSON.stringify({ id, action, ...extra })),
  );
  const deadline = Date.now() + timeout;
  for (;;) {
    if (Date.now() > deadline) throw new Error(`${label}: timed out waiting for response`);
    const frame = await client
      .nextFrame(
        (candidate) =>
          candidate.type === FrameType.SESSION_CONTROL || candidate.type === FrameType.RESPONSE,
        Math.max(1_000, deadline - Date.now()),
      )
      .catch(() => undefined);
    if (!frame) continue;
    if (frame.type === FrameType.SESSION_CONTROL) {
      if (frame.json.type === "cloud_frame_rejected")
        console.log("rejected:", JSON.stringify(frame.json));
      if (frame.json.type === "cloud_frame_accepted")
        console.log("accepted:", frame.json.action ?? frame.json.frame_type);
      const inner = frame.json.frame;
      if (inner?.type === FrameType.RESPONSE) {
        const payload = JSON.parse(new TextDecoder().decode(inner.payload));
        if (payload.id === id) return payload;
      }
      continue;
    }
    const payload = JSON.parse(new TextDecoder().decode(frame.payload));
    if (payload.id === id) return payload;
  }
}

console.log("attaching managed Python");
const attached = await fetch(
  new URL(
    `/api/n/${notebookId}/workstation-attachments?user=${user}&scope=owner&operator=node:smoke`,
    baseUrl,
  ),
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workstation_id: "celld-preview-python" }),
    signal: AbortSignal.timeout(30_000),
  },
);
if (!attached.ok) throw new Error(`attach python: ${attached.status} ${await attached.text()}`);
const attachmentResult = await attached.json();
const attachJobId = attachmentResult.job?.job_id;
if (!attachJobId) throw new Error("attach response omitted job_id");
console.log("attach:", attachmentResult.job.status, attachJobId);

// Package changes wait for the managed entry's readiness internally; do not
// add a fixed delay here, which would hide slow or stuck startup.

const client = await connect();

async function add(requirement, label) {
  const response = await request(
    client,
    "cloud_package_change",
    { operation: "add", requirement },
    label,
  );
  console.log(`${label}:`, response.result, response.error ?? "");
  if (/recover|wait a few|try again later/i.test(response.error ?? ""))
    throw new Error(`${label} exposed backend cleanup to the user: ${response.error}`);
  return response;
}

console.log("installing requests, then an invalid name, then requests again");
const initial = await add("requests", "requests-first");
if (initial.result !== "sync_environment_complete")
  throw new Error(`initial requests install failed: ${initial.error}`);
const typo = await add("request", "request-typo");
if (typo.result !== "sync_environment_failed" || !/not found/i.test(typo.error ?? ""))
  throw new Error(`typo should report package-not-found: ${typo.error}`);
const fixed = await add("requests", "requests-after-not-found");
if (fixed.result !== "sync_environment_complete")
  throw new Error(`requests after package-not-found failed: ${fixed.error}`);

console.log("installing a second package 'six'");
const second = await add("six", "six");
if (second.result !== "sync_environment_complete")
  throw new Error(`second add should succeed immediately: ${second.error}`);

client.socket.close();
console.log("package recovery smoke passed");
process.exit(0);
