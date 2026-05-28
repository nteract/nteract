import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const baseUrl = process.env.NOTEBOOK_CLOUD_URL ?? "http://127.0.0.1:8787";
const devAuthToken = process.env.NOTEBOOK_CLOUD_DEV_TOKEN;
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

const handle = NotebookHandle.create_bootstrap(actorLabel);
handle.add_cell_after("intro", "markdown", null);
handle.update_source(
  "intro",
  [
    "# nteract cloud notebook",
    "",
    "This public viewer is backed by the live notebook room.",
    "",
    "- The NotebookDoc and RuntimeStateDoc .am snapshots are stored in R2.",
    "- Pinned revisions can still be materialized by runtimed-wasm from those snapshots.",
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
const cells = JSON.parse(handle.get_cells_json());

await putBytes(
  `/api/n/${encodeURIComponent(notebookId)}/runtime-snapshots/${encodeURIComponent(runtimeHeadsHash)}`,
  runtimeSnapshotBytes,
  "application/octet-stream",
);
await putBytes(
  `/api/n/${encodeURIComponent(notebookId)}/snapshots/${encodeURIComponent(headsHash)}`,
  snapshotBytes,
  "application/octet-stream",
  {
    "X-Runtime-Heads-Hash": runtimeHeadsHash,
  },
);

const rendered = await fetchJson(
  `/api/n/${encodeURIComponent(notebookId)}/renders/${encodeURIComponent(headsHash)}`,
);
assert(rendered.source === "snapshot-pair", "pinned render was not materialized from snapshots");
assert(
  rendered.cells.some((cell) => cell.id === "hello" && cell.source.includes("nteract cloud")),
  "pinned snapshot render did not include the demo code cell",
);

console.log(
  JSON.stringify(
    {
      ok: true,
      baseUrl,
      notebookId,
      viewerUrl: new URL(`/n/${encodeURIComponent(notebookId)}`, baseUrl).href,
      headsHash,
      runtimeHeadsHash,
      cells: cells.length,
      checks: [
        "runtimed_wasm_snapshot_pair",
        "r2_runtime_snapshot_publish",
        "r2_snapshot_publish",
        "pinned_snapshot_materialization",
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
    "X-User": "demo",
    "X-Operator": "agent:publish-demo",
    "X-Scope": "owner",
    ...devAuthHeaders(),
    ...extraHeaders,
  };
}

function devAuthHeaders() {
  return devAuthToken ? { "X-Notebook-Cloud-Dev-Token": devAuthToken } : {};
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
