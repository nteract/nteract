import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  canonicalViewerUrl,
  notebookIdFromEnvOrGenerated,
  runtimeStateDocIdFromEnvOrDefault,
  vanityNameFromEnvOrNotebookName,
} from "./publish-notebook-id.mjs";
import { notebookCloudBaseUrl } from "./local-dev.mjs";
import { publishIdentityHeaders } from "./publish-auth.mjs";
import { initializeRuntimedWasmSyncForNode } from "./runtimed-wasm-artifact.mjs";

const baseUrl = notebookCloudBaseUrl();
const fixtureName = process.env.NOTEBOOK_CLOUD_FIXTURE ?? "output_streaming";
const notebookId = notebookIdFromEnvOrGenerated();
const vanityName = vanityNameFromEnvOrNotebookName(fixtureName);
const runtimeStateDocIdOverride = runtimeStateDocIdFromEnvOrDefault(notebookId);
const fixtureRoot = new URL(
  `../../../packages/runtimed/tests/fixtures/${fixtureName}/`,
  import.meta.url,
);

await assertExists(new URL("manifest.json", fixtureRoot));
await assertExists(new URL("doc.bin", fixtureRoot));
await assertExists(new URL("state_doc.bin", fixtureRoot));

const { NotebookHandle } = await initializeRuntimedWasmSyncForNode();

const [snapshotBytes, runtimeSnapshotBytes] = await Promise.all([
  readFile(new URL("doc.bin", fixtureRoot)),
  readFile(new URL("state_doc.bin", fixtureRoot)),
]);
const fixtureManifest = JSON.parse(await readFile(new URL("manifest.json", fixtureRoot), "utf8"));
const fixtureBlobs = Array.isArray(fixtureManifest.blobs) ? fixtureManifest.blobs : [];
const handle = NotebookHandle.load_snapshot(snapshotBytes, runtimeSnapshotBytes);
handle.set_runtime_state_doc_id(runtimeStateDocIdOverride);
const headsHash = headsDigest(handle.get_heads_hex());
const runtimeHeadsHash = headsDigest(handle.get_runtime_state_heads_hex());
const runtimeStateDocId = requiredRuntimeStateDocId(handle);
const cells = JSON.parse(handle.get_cells_json());
const publishedSnapshotBytes = handle.save();
const publishedRuntimeSnapshotBytes = handle.save_state_doc();
handle.free();

for (const blob of fixtureBlobs) {
  await uploadFixtureBlob(blob);
}

await putBytes(
  `/api/n/${encodeURIComponent(notebookId)}/runtime-snapshots/${encodeURIComponent(runtimeHeadsHash)}`,
  publishedRuntimeSnapshotBytes,
  "application/octet-stream",
  {
    "X-Runtime-State-Doc-Id": runtimeStateDocId,
  },
);
await putBytes(
  `/api/n/${encodeURIComponent(notebookId)}/snapshots/${encodeURIComponent(headsHash)}`,
  publishedSnapshotBytes,
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
  "published catalog did not include the fixture snapshot pair",
);

console.log(
  JSON.stringify(
    {
      ok: true,
      baseUrl,
      fixtureName,
      notebookId,
      vanityName,
      viewerUrl: canonicalViewerUrl(baseUrl, notebookId, vanityName),
      runtimeStateDocId,
      headsHash,
      runtimeHeadsHash,
      cells: cells.length,
      outputs: cells.reduce(
        (count, cell) => count + (Array.isArray(cell.outputs) ? cell.outputs.length : 0),
        0,
      ),
      blobs: fixtureBlobs.length,
      checks: [
        "fixture_snapshot_pair_publish",
        "runtime_state_output_manifests",
        "published_snapshot_catalog",
        ...(fixtureBlobs.length > 0 ? ["fixture_blob_uploads", "blob_resolver_urls"] : []),
      ],
    },
    null,
    2,
  ),
);

async function uploadFixtureBlob(blob) {
  assert(blob && typeof blob === "object", `Invalid fixture blob entry: ${JSON.stringify(blob)}`);
  assert(typeof blob.hash === "string" && blob.hash.length > 0, "Fixture blob is missing hash");
  assert(
    typeof blob.path === "string" && blob.path.length > 0,
    `Fixture blob ${blob.hash} is missing path`,
  );

  const blobUrl = new URL(blob.path, fixtureRoot);
  await assertExists(blobUrl);
  const bytes = await readFile(blobUrl);
  if (blob.hash.startsWith("sha256:")) {
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    assert(
      digest === blob.hash,
      `Fixture blob ${blob.path} hash mismatch: ${digest} !== ${blob.hash}`,
    );
  }

  await putBytes(
    `/api/n/${encodeURIComponent(notebookId)}/blobs/${encodeURIComponent(blob.hash)}`,
    bytes,
    typeof blob.content_type === "string" ? blob.content_type : "application/octet-stream",
  );
}

function headsDigest(heads) {
  const input = heads.length > 0 ? heads.slice().sort().join("\n") : "empty";
  return `heads-${createHash("sha256").update(input).digest("hex").slice(0, 24)}`;
}

function requiredRuntimeStateDocId(handle) {
  const runtimeStateDocId = handle.get_runtime_state_doc_id();
  assert(
    typeof runtimeStateDocId === "string" && runtimeStateDocId.length > 0,
    "NotebookDoc fixture is missing runtime_state_doc_id",
  );
  return runtimeStateDocId;
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
      user: "fixture",
      operator: "agent:publish-fixture",
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
  if (response.ok) return;
  throw new Error(`${pathname} returned ${response.status}: ${await response.text()}`);
}

async function assertExists(url) {
  try {
    await access(fileURLToPath(url));
  } catch {
    throw new Error(`Missing ${fileURLToPath(url)}`);
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
