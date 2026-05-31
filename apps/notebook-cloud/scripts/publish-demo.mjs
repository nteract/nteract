import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { publishIdentityHeaders } from "./publish-auth.mjs";

const baseUrl = process.env.NOTEBOOK_CLOUD_URL ?? "http://127.0.0.1:8787";
const notebookId = process.env.NOTEBOOK_CLOUD_NOTEBOOK_ID ?? "nteract-cloud-demo";
const actorLabel = "user:dev:demo/agent:publish-demo";
const wasmJsUrl = new URL(
  "../../notebook/src/wasm/runtimed-wasm/runtimed_wasm.js",
  import.meta.url,
);
const wasmBytesUrl = new URL(
  "../../notebook/src/wasm/runtimed-wasm/runtimed_wasm_bg.wasm",
  import.meta.url,
);

await assertWasmBuildExists();

const { initSync, NotebookHandle } = await import(wasmJsUrl.href);
const wasmBytes = await readFile(wasmBytesUrl);
initSync({ module: wasmBytes });

const handle = new NotebookHandle(notebookId);
handle.set_actor(actorLabel);
handle.add_cell_after("intro", "markdown", null);
handle.update_source(
  "intro",
  [
    "# nteract cloud notebook",
    "",
    "This public viewer is backed by the live notebook room.",
    "",
    "- The NotebookDoc and RuntimeStateDoc .am snapshots are stored in R2.",
    "- Pinned revisions are loaded from Automerge snapshots and the live room uses sync.",
  ].join("\n"),
);
handle.add_cell_after("hello", "code", "intro");
handle.update_source("hello", 'print("hello from nteract cloud")');
handle.add_cell_after("next", "markdown", "hello");
handle.update_source(
  "next",
  "## Prototype status\n\nAnonymous visitors connect as viewer-scoped room peers, while the published notebook history stays intact.",
);

const snapshotBytes = new Uint8Array(handle.save());
const runtimeSnapshotBytes = new Uint8Array(handle.save_state_doc());
const heads = handle.get_heads_hex();
const runtimeHeads = handle.get_runtime_state_heads_hex();
const headsHash = headsDigest(heads);
const runtimeHeadsHash = headsDigest(runtimeHeads);
const runtimeStateDocId = requiredRuntimeStateDocId(handle);
const cells = JSON.parse(handle.get_cells_json());

await putBytes(
  `/api/n/${encodeURIComponent(notebookId)}/runtime-snapshots/${encodeURIComponent(runtimeHeadsHash)}`,
  runtimeSnapshotBytes,
  "application/octet-stream",
  {
    "X-Runtime-State-Doc-Id": runtimeStateDocId,
  },
);
await putBytes(
  `/api/n/${encodeURIComponent(notebookId)}/snapshots/${encodeURIComponent(headsHash)}`,
  snapshotBytes,
  "application/octet-stream",
  {
    "X-Runtime-Heads-Hash": runtimeHeadsHash,
    "X-Runtime-State-Doc-Id": runtimeStateDocId,
  },
);

const catalog = await fetchJson(`/api/n/${encodeURIComponent(notebookId)}`);
assert(
  catalog.revisions?.some(
    (revision) =>
      revision.notebook_heads_hash === headsHash &&
      revision.runtime_heads_hash === runtimeHeadsHash,
  ),
  "published catalog did not include the demo snapshot pair",
);

console.log(
  JSON.stringify(
    {
      ok: true,
      baseUrl,
      notebookId,
      viewerUrl: new URL(`/n/${encodeURIComponent(notebookId)}`, baseUrl).href,
      runtimeStateDocId,
      headsHash,
      runtimeHeadsHash,
      cells: cells.length,
      checks: [
        "runtimed_wasm_snapshot_pair",
        "r2_runtime_snapshot_publish",
        "r2_snapshot_publish",
        "published_snapshot_catalog",
      ],
    },
    null,
    2,
  ),
);

function headsDigest(heads) {
  const input = heads.length > 0 ? heads.slice().sort().join("\n") : "empty";
  return `heads-${createHash("sha256").update(input).digest("hex").slice(0, 24)}`;
}

function requiredRuntimeStateDocId(handle) {
  const runtimeStateDocId = handle.get_runtime_state_doc_id();
  assert(
    typeof runtimeStateDocId === "string" && runtimeStateDocId.length > 0,
    "NotebookDoc snapshot is missing runtime_state_doc_id",
  );
  return runtimeStateDocId;
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

async function putBytes(pathname, body, contentType, extraHeaders = {}) {
  const response = await fetch(new URL(pathname, baseUrl), {
    method: "PUT",
    headers: publishHeaders(contentType, extraHeaders),
    body,
  });
  await assertOk(response, pathname);
  return response.json();
}

function publishHeaders(contentType, extraHeaders) {
  return {
    "Content-Type": contentType,
    ...publishIdentityHeaders({
      user: "demo",
      operator: "agent:publish-demo",
      scope: "owner",
    }),
    ...extraHeaders,
  };
}

async function fetchJson(pathname) {
  const response = await fetch(new URL(pathname, baseUrl));
  await assertOk(response, pathname);
  return response.json();
}

async function assertOk(response, pathname) {
  if (response.ok) {
    return;
  }
  throw new Error(`${pathname} returned ${response.status}: ${await response.text()}`);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
