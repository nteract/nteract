import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { collectArrowStreamManifestBlobRefs, collectBlobRefs } from "../src/blob-refs.ts";
import { createLiveNotebookFixture } from "./live-notebook-fixture.mjs";
import {
  canonicalViewerUrl,
  notebookIdFromEnvOrGenerated,
  vanityNameFromEnvOrNotebookName,
} from "./publish-notebook-id.mjs";
import { notebookCloudBaseUrl } from "./local-dev.mjs";
import { publishIdentityHeaders } from "./publish-auth.mjs";
import { loadRuntimedNode } from "./runtimed-node-loader.mjs";
import { summarizeCatalog } from "./hosted-render-smoke-catalog.mjs";

const rt = loadRuntimedNode();

const baseUrl = notebookCloudBaseUrl();
const sourceNotebookId = process.env.NOTEBOOK_CLOUD_SOURCE_NOTEBOOK_ID;
const preset = process.env.NOTEBOOK_CLOUD_LIVE_PRESET ?? "mathnet";
const notebookId = notebookIdFromEnvOrGenerated();
const vanityName = vanityNameFromEnvOrNotebookName(
  defaultLiveNotebookName({ preset, sourceNotebookId }),
);
const wasmJsUrl = new URL(
  "../../notebook/src/wasm/runtimed-wasm/runtimed_wasm.js",
  import.meta.url,
);
const wasmBytesUrl = new URL(
  "../../notebook/src/wasm/runtimed-wasm/runtimed_wasm_bg.wasm",
  import.meta.url,
);

await assertWasmBuildExists();

const session = sourceNotebookId
  ? await rt.openNotebook(sourceNotebookId, {
      description: "notebook-cloud live publish",
    })
  : await createLiveNotebookFixture(rt, { preset });

try {
  const snapshot = await session.exportSnapshotPair();
  const { cells, runtimeState, commsState, runtimeStateDocId } = await snapshotPairMetadata(
    snapshot.notebookBytes,
    snapshot.runtimeStateBytes,
    snapshot.commsDocBytes,
  );
  const blobRefs = collectBlobRefs({ cells, runtimeState, commsState });
  await expandArrowManifestBlobRefs(blobRefs, snapshot);
  const headsHash = headsDigest(snapshot.notebookHeads);
  const runtimeHeadsHash = headsDigest(snapshot.runtimeStateHeads);
  const commsHeadsHash = headsDigest(snapshot.commsDocHeads);

  for (const ref of Object.values(blobRefs)) {
    await uploadLiveBlob(ref, snapshot);
  }

  await putBytes(
    `/api/n/${encodeURIComponent(notebookId)}/runtime-snapshots/${encodeURIComponent(runtimeHeadsHash)}`,
    snapshot.runtimeStateBytes,
    "application/octet-stream",
    {
      "X-Runtime-State-Doc-Id": runtimeStateDocId,
    },
  );
  await putBytes(
    `/api/n/${encodeURIComponent(notebookId)}/comms-snapshots/${encodeURIComponent(commsHeadsHash)}`,
    snapshot.commsDocBytes,
    "application/octet-stream",
    {
      "X-Runtime-State-Doc-Id": runtimeStateDocId,
    },
  );
  await putBytes(
    `/api/n/${encodeURIComponent(notebookId)}/snapshots/${encodeURIComponent(headsHash)}`,
    snapshot.notebookBytes,
    "application/octet-stream",
    {
      "X-Runtime-Heads-Hash": runtimeHeadsHash,
      "X-Comms-Heads-Hash": commsHeadsHash,
      "X-Runtime-State-Doc-Id": runtimeStateDocId,
    },
  );

  const catalog = await fetchJson(`/api/n/${encodeURIComponent(notebookId)}`);
  const catalogSummary = summarizeCatalog(catalog);
  const latestRevision = catalog.revisions?.find(
    (revision) => revision.id === catalogSummary.latestRevisionId,
  );
  assert(
    latestRevision?.notebook_heads_hash === headsHash &&
      latestRevision?.runtime_heads_hash === runtimeHeadsHash &&
      latestRevision?.comms_heads_hash === commsHeadsHash,
    "published catalog did not include the snapshot triplet",
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        baseUrl,
        sourceMode: sourceNotebookId ? "existing-notebook-room" : "generated-live-preset",
        preset: sourceNotebookId ? "source-notebook" : preset,
        sourceNotebookId: sourceNotebookId ?? session.notebookId,
        notebookId,
        vanityName,
        viewerUrl: canonicalViewerUrl(baseUrl, notebookId, vanityName),
        runtimeStateDocId,
        headsHash,
        runtimeHeadsHash,
        commsHeadsHash,
        ownerPrincipal: catalogSummary.ownerPrincipal,
        latestRevisionActorLabel: catalogSummary.latestRevisionActorLabel,
        cells: Array.isArray(cells) ? cells.length : null,
        blobs: Object.keys(blobRefs).length,
        checks: [
          "live_session_snapshot_pair",
          "runtime_state_output_manifests",
          "comms_doc_widget_state",
          "local_blob_uploads",
          "published_snapshot_catalog",
        ],
      },
      null,
      2,
    ),
  );
} finally {
  if (!sourceNotebookId) {
    await session.shutdownNotebook().catch(() => {});
  }
  await session.close().catch(() => {});
}

async function snapshotPairMetadata(notebookBytes, runtimeStateBytes, commsBytes) {
  const { initSync, NotebookHandle } = await import(wasmJsUrl.href);
  const wasmBytes = await readFile(wasmBytesUrl);
  initSync({ module: wasmBytes });
  const handle = NotebookHandle.load_snapshot(notebookBytes, runtimeStateBytes);
  if (commsBytes) {
    handle.load_comms_doc(commsBytes);
  }
  try {
    return {
      cells: JSON.parse(handle.get_cells_json()),
      runtimeState: handle.get_runtime_state(),
      commsState: handle.get_comms_state(),
      runtimeStateDocId: requiredRuntimeStateDocId(handle),
    };
  } finally {
    handle.free();
  }
}

function requiredRuntimeStateDocId(handle) {
  const runtimeStateDocId = handle.get_runtime_state_doc_id();
  assert(
    typeof runtimeStateDocId === "string" && runtimeStateDocId.length > 0,
    "NotebookDoc live snapshot is missing runtime_state_doc_id",
  );
  return runtimeStateDocId;
}

function defaultLiveNotebookName({ preset, sourceNotebookId }) {
  if (sourceNotebookId) {
    return "notebook";
  }
  if (preset === "mathnet") {
    return "topic-viz.ipynb";
  }
  return preset;
}

async function uploadLiveBlob(ref, snapshot) {
  const bytes = await readLocalBlob(ref.blob, snapshot);
  await putBytes(
    `/api/n/${encodeURIComponent(notebookId)}/blobs/${encodeURIComponent(ref.blob)}`,
    bytes,
    ref.media_type ?? "application/octet-stream",
  );
}

async function expandArrowManifestBlobRefs(blobRefs, snapshot) {
  for (const ref of Object.values(blobRefs)) {
    if (ref.media_type !== "application/vnd.nteract.arrow-stream-manifest+json") {
      continue;
    }
    const bytes = await readLocalBlob(ref.blob, snapshot);
    const manifest = new TextDecoder().decode(bytes);
    const childRefs = collectArrowStreamManifestBlobRefs(manifest);
    for (const childRef of Object.values(childRefs)) {
      blobRefs[childRef.blob] = {
        blob: childRef.blob,
        size: blobRefs[childRef.blob]?.size ?? childRef.size,
        media_type: blobRefs[childRef.blob]?.media_type ?? childRef.media_type,
      };
    }
  }
}

async function readLocalBlob(hash, snapshot) {
  if (snapshot.blobStorePath) {
    for (const candidate of localBlobPathCandidates(snapshot.blobStorePath, hash)) {
      try {
        return await readFile(candidate);
      } catch {
        // Try the next candidate or fall through to the daemon blob URL.
      }
    }
  }

  if (snapshot.blobBaseUrl) {
    const response = await fetch(`${snapshot.blobBaseUrl.replace(/\/$/, "")}/blob/${hash}`);
    if (response.ok) {
      return new Uint8Array(await response.arrayBuffer());
    }
  }

  throw new Error(`Unable to resolve local blob ${hash}`);
}

function localBlobPathCandidates(root, hash) {
  const hashes = [hash];
  if (hash.startsWith("sha256:")) {
    hashes.push(hash.slice("sha256:".length));
  }
  return hashes
    .filter((candidate) => candidate.length >= 2)
    .map((candidate) => path.join(root, candidate.slice(0, 2), candidate.slice(2)));
}

function headsDigest(heads) {
  const input = heads.length > 0 ? heads.slice().sort().join("\n") : "empty";
  return `heads-${createHash("sha256").update(input).digest("hex").slice(0, 24)}`;
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
      user: "live-publish",
      operator: "agent:publish-live",
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

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
