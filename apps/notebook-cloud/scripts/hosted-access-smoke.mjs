import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { FrameType } from "runtimed";

import {
  assertAccessHealthConfigured,
  accessAuthHeaders,
  accessPrincipalFromJwt,
  assertHostedAccessSmokeEnv,
} from "./hosted-access-smoke-env.mjs";
import {
  clientForSocket,
  closeClient,
  fingerprintPrincipal,
  openWebSocket,
  safeWebSocketUrl,
  sendBinaryFrame,
} from "./hosted-access-smoke-ws.mjs";

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
const accessHealth = await timed("access_health", () => assertAccessHealthReady());
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
      access_health: accessHealth,
      roomId,
      viewerUrl: new URL(`/n/${encodeURIComponent(roomId)}`, baseUrl).href,
      principal_fingerprints: {
        owner: fingerprintPrincipal(ownerPrincipal),
        editor: fingerprintPrincipal(editorPrincipal),
        viewer: fingerprintPrincipal(viewerPrincipal),
      },
      checks: [
        "cloudflare_access_worker_configured",
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

async function assertAccessHealthReady() {
  const response = await fetch(new URL("/api/health", baseUrl), {
    headers: accessAuthHeaders(ownerToken),
  });
  const text = await response.text();
  assert(response.ok, `Access health preflight failed: ${response.status} ${previewText(text)}`);

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`Access health preflight did not return JSON: ${previewText(text)}`);
  }

  return assertAccessHealthConfigured(payload, { baseUrl });
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function previewText(text, maxLength = 300) {
  const value = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
