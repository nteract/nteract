/**
 * Offline evidence auditor, NOT a fleet inventory extractor or migration driver.
 * Usage: node scripts/migration-inventory.mjs --offline-evidence FILE.json
 * Only supply already-exported offline copies. This cannot tell whether an
 * arbitrary local pathname names live data. No discovery, network, databases,
 * embedded file references or writes. Exit 1: global coverage incomplete;
 * exit 2: invalid input/blocked evidence. Never exit 0 or authorize removal.
 *
 * NEW interchange, not an established backup format:
 * {schema: "pages-migration-evidence-v1",
 *  source: {kind: "offline-extract", target, capture_id, source_sha},
 *  catalogs: [{account, entries: [[key, decodedValue], ...]}],
 *  hosts: [{page_id, record, creation, pending_keys, plain, known_heads}]}
 * source_sha is 40 lowercase hex characters. These labels are supplied
 * provenance, not authenticated proof. The report hashes the input itself.
 *
 * Catalog entries: owner page/, trash/, space/, host/deleted/ keys, including
 * pending placeholders, parent IDs, Project home IDs and deletion tombstones
 * (worker/catalog.mjs). Exclude unrelated keys and shared-title caches. D1
 * pages_catalog_* rows are projections, not authoritative enumeration.
 * Host record: decoded host/document or explicit null. creation: null or
 * {metadata} from host/creation, including native registration intents. Do NOT
 * export creation bytes, credentials or retry secrets. pending_keys: explicit
 * array of pending Page/comment operation and preserved-conversion keys.
 * plain: [key, canonicalBase64] pairs for original plain/sync/ byte values,
 * including CBOR manifests/descriptors and object parts (sync/doc-store.mjs).
 * known_heads: {page: [hashes], comments: [hashes]} from separate saved evidence;
 * Missing or empty heads leave document/row verification incomplete; malformed
 * heads block it. Both documents require nonempty independent expected heads.
 *
 * Every observed account/Page is retained, including home/nested/trash/pending/
 * deleted/host-only entries. Inactive/API-only Pages have no special persisted
 * category: an exporter must not filter on activity or API visibility. Results
 * verify m2 (preferred) or legacy m, ranges, part sizes, A.load, dependencies,
 * manifest/prior heads, root shape and supported stamps, not all content nodes.
 * Classification: unknown/unmigrated/plain_verified/pending/errored/deleted;
 * deleted cleanup: required if plain bytes remain, otherwise unknown.
 * state: ready/incomplete/blocked for supplied evidence ONLY. global_state is
 * always incomplete, removal_ready always false, even with a coverage claim.
 *
 * DEPLOYMENT.md's versions.json is [{Key,VersionId,Size}], not a Page snapshot:
 * no decoded records, payloads, delete markers or consistent cross-object cut.
 * It, health and single-account lists are refused as input, not global proof.
 * Missing wiring: authoritative all-account Catalog/host enumeration; capture
 * fencing/version binding; native creation/registration closure and drain;
 * actor claims/comment blocks; deleted/buffered PageRecords cleanup; policy for
 * offline drafts/edits that never reconnect. Nothing here migrates or approves.
 *
 * LIMITS bound input, stored bytes and iteration. Documents load sequentially
 * and are freed. Automerge decompressed WASM heap/CPU are NOT bounded here:
 * process untrusted binary evidence under external resource limits.
 * Synthetic empty example (incomplete):
 * {"schema":"pages-migration-evidence-v1","catalogs":[],"hosts":[]}
 * Tests generate synthetic real DocStore snapshots and increments.
 */
import * as A from "@automerge/automerge";
import { cbor, documentIdToBinary } from "@automerge/automerge-repo";
import { sedimentreeId } from "@automerge/automerge-repo/sedimentree";
import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, openSync, readSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { commentsDocUuid, commentsDocumentId } from "../worker/comments-store.mjs";
import { pageState } from "../worker/authz.mjs";
import { logicalId } from "../worker/policy.mjs";
import { BUILD_FEATURES, documentFeatures, missingFeatures } from "../model/schema-features.mjs";

// This interchange is NOT a celld backup or an authoritative global inventory.
export const SCHEMA = "pages-migration-evidence-v1";
export const LIMITS = Object.freeze({
  inputBytes: 64 * 1024 * 1024,
  records: 10_000,
  entries: 20_000,
  documentBytes: 16 * 1024 * 1024,
  chunks: 1024,
  heads: 1024,
});
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const text = (v) => typeof v === "string" && v.length > 0 && v.length <= 1024;
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const integer = (v, max) => Number.isSafeInteger(v) && v >= 0 && v <= max;
function requireEvidence(ok, code) {
  if (!ok) throw new Error(code);
}
function array(v, max = LIMITS.entries) {
  requireEvidence(Array.isArray(v) && v.length <= max, "invalid_or_oversized_array");
  return v;
}
function pairs(v) {
  const result = new Map();
  for (const entry of array(v)) {
    requireEvidence(Array.isArray(entry) && entry.length === 2 && text(entry[0]), "invalid_entry");
    requireEvidence(!result.has(entry[0]), "duplicate_key");
    result.set(...entry);
  }
  return result;
}
function heads(v) {
  array(v, LIMITS.heads);
  requireEvidence(
    v.every((h) => typeof h === "string" && HASH.test(h)),
    "invalid_heads",
  );
  requireEvidence(new Set(v).size === v.length, "duplicate_heads");
  return v;
}
function base64(v) {
  requireEvidence(typeof v === "string" && v.length <= LIMITS.inputBytes, "invalid_base64");
  const bytes = Buffer.from(v, "base64");
  requireEvidence(bytes.toString("base64") === v, "invalid_base64");
  return bytes;
}

function parseEvidence(input) {
  const value = JSON.parse(input);
  // JSON.parse accepts repeated property names and silently loses evidence.
  const stack = [];
  for (const match of input.matchAll(/"(?:\\.|[^"\\])*"|[{}[\],:]|[^\s{}[\],:"]+/g)) {
    const token = match[0];
    const parent = stack.at(-1);
    if (token === "{") stack.push({ keys: new Set(), key: true });
    else if (token === "[") stack.push({});
    else if (token === "}" || token === "]") stack.pop();
    else if (token === "," && parent?.keys) parent.key = true;
    else if (token.startsWith('"') && parent?.key) {
      const key = JSON.parse(token);
      requireEvidence(!parent.keys.has(key), "duplicate_json_key");
      parent.keys.add(key);
      parent.key = false;
    }
  }
  return value;
}

/** Severity is monotone. A ready result describes supplied evidence only. */
export function resultState(state, event) {
  requireEvidence(["ready", "incomplete", "blocked"].includes(state), "invalid_state");
  requireEvidence(["verified", "missing", "invalid"].includes(event), "invalid_event");
  if (state === "blocked" || event === "invalid") return "blocked";
  if (state === "incomplete" || event === "missing") return "incomplete";
  return "ready";
}

/** Strict, bounded reader for DocStore's m2 and legacy m, never a DocStore writer. */
function verifyDocument(entries, tree, known, pageId) {
  const prior = known === undefined ? [] : heads(known);
  const prefix = `plain/sync/${tree}/`;
  const encoded = entries.get(`${prefix}m2`) ?? entries.get(`${prefix}m`);
  if (encoded === undefined) return { state: "incomplete", reason: "manifest_missing" };
  const manifest = cbor.decode(base64(encoded));
  requireEvidence(object(manifest), "invalid_manifest");
  requireEvidence(manifest.version === undefined || manifest.version === 2, "manifest_version");
  requireEvidence(!entries.has(`${prefix}m2`) || manifest.version === 2, "manifest_key_version");
  requireEvidence((manifest.format ?? "automerge") === "automerge", "manifest_format");
  requireEvidence(integer(manifest.seq, Number.MAX_SAFE_INTEGER), "manifest_seq");
  const expected = heads(manifest.heads);
  requireEvidence(expected.length > 0, "empty_manifest_heads");
  const descriptors = [];
  let previous = 0;
  if (manifest.snapshot != null) {
    requireEvidence(object(manifest.snapshot), "invalid_snapshot");
    previous = manifest.snapshot.seq;
    requireEvidence(integer(previous, manifest.seq) && previous > 0, "snapshot_seq");
    descriptors.push(manifest.snapshot);
  }
  requireEvidence(manifest.seq - previous <= LIMITS.chunks, "chunk_limit");
  if (manifest.version === 2) {
    requireEvidence(manifest.chunks === undefined, "v2_inline_chunks");
    for (let seq = previous + 1; seq <= manifest.seq; seq++) {
      const bytes = entries.get(`${prefix}c/${seq}`);
      if (bytes === undefined) return { state: "incomplete", reason: "descriptor_missing" };
      const descriptor = cbor.decode(base64(bytes));
      requireEvidence(descriptor?.seq === seq, "descriptor_seq");
      descriptors.push(descriptor);
    }
  } else {
    for (const descriptor of array(manifest.chunks ?? [], LIMITS.chunks)) {
      requireEvidence(descriptor?.seq === ++previous, "descriptor_seq");
      descriptors.push(descriptor);
    }
    requireEvidence(previous === manifest.seq, "legacy_chunk_range");
  }
  const parts = [];
  let total = 0;
  for (const descriptor of descriptors) {
    requireEvidence(
      integer(descriptor.bytes, LIMITS.documentBytes) && descriptor.bytes > 0,
      "object_bytes",
    );
    requireEvidence(
      descriptor.parts === Math.ceil(descriptor.bytes / (1024 * 1024)),
      "object_parts",
    );
    total += descriptor.bytes;
    requireEvidence(total <= LIMITS.documentBytes, "document_byte_limit");
    for (let part = 0; part < descriptor.parts; part++) {
      const value = entries.get(`${prefix}o/${descriptor.seq}/${part}`);
      if (value === undefined) return { state: "incomplete", reason: "object_missing" };
      const bytes = base64(value);
      requireEvidence(
        bytes.length === Math.min(1024 * 1024, descriptor.bytes - part * 1024 * 1024),
        "object_size",
      );
      parts.push(bytes);
    }
  }
  const doc = A.load(Buffer.concat(parts));
  try {
    requireEvidence(
      pageId ? doc.page_id === pageId && object(doc.blocks) : object(doc.threads),
      "document_identity_or_shape",
    );
    requireEvidence(
      missingFeatures(documentFeatures(doc), BUILD_FEATURES).length === 0,
      "document_schema_unsupported",
    );
    requireEvidence(A.getMissingDeps(doc, []).length === 0, "missing_dependencies");
    requireEvidence(
      JSON.stringify(A.getHeads(doc).sort()) === JSON.stringify([...expected].sort()),
      "manifest_heads_mismatch",
    );
    requireEvidence(A.hasHeads(doc, prior), "known_heads_missing");
    if (!prior.length) return { state: "incomplete", reason: "independent_known_heads_missing" };
    return { state: "ready", bytes: total, heads: expected.length };
  } finally {
    A.free(doc);
  }
}

/** Accepts JSON text, not paths or callbacks. Never discovers or contacts a host. */
export async function auditInventory(input) {
  const report = {
    schema: SCHEMA,
    state: "ready",
    global_state: "incomplete",
    removal_ready: false,
    gaps: [
      "No authoritative all-account Catalog and Page-host enumeration adapter is implemented.",
      "No consistent global cut, version binding, or native-registration closure gate is verified.",
      "Offline browser drafts and never-returned edits cannot be inventoried from host exports.",
      "Deleted-record cleanup, actor claims, comment blocks and buffered PageRecords require separate evidence.",
    ],
    issues: [],
    pages: [],
    counts: {},
  };
  const issue = (code, event = "missing") => {
    report.state = resultState(report.state, event);
    report.issues.push(code);
  };
  try {
    requireEvidence(
      typeof input === "string" && Buffer.byteLength(input) <= LIMITS.inputBytes,
      "input_byte_limit",
    );
    report.input_sha256 = createHash("sha256").update(input).digest("hex");
    const evidence = parseEvidence(input);
    requireEvidence(evidence?.schema === SCHEMA, "evidence_schema");
    const source = evidence.source;
    const validProvenance =
      object(source) &&
      source.kind === "offline-extract" &&
      text(source.target) &&
      text(source.capture_id) &&
      typeof source.source_sha === "string" &&
      /^[a-f0-9]{40}$/.test(source.source_sha);
    if (!validProvenance) issue("source_provenance_missing");
    else
      report.source = {
        kind: source.kind,
        target: source.target,
        capture_id: source.capture_id,
        source_sha: source.source_sha,
      };
    // Caller assertions are recorded, never promoted into verified coverage.
    if (evidence.coverage !== undefined) issue("coverage_claim_not_verified");
    const references = new Map();
    const reference = (id, owner, kind) => {
      requireEvidence(typeof id === "string" && UUID.test(id), "invalid_page_id");
      const old = references.get(id);
      requireEvidence(!old || old.owner === owner, "conflicting_catalog_owner");
      if (old) old.kinds.add(kind);
      else references.set(id, { owner, kinds: new Set([kind]) });
      requireEvidence(references.size <= LIMITS.records, "record_limit");
    };
    const accounts = new Set();
    let entryCount = 0;
    for (const catalog of array(evidence.catalogs, LIMITS.records)) {
      requireEvidence(
        text(catalog.account) && !accounts.has(catalog.account),
        "duplicate_or_invalid_account",
      );
      accounts.add(catalog.account);
      for (const [key, value] of pairs(catalog.entries)) {
        requireEvidence(++entryCount <= LIMITS.entries, "entry_limit");
        if (key.startsWith("space/")) {
          requireEvidence(object(value), "invalid_project");
          reference(value.home_page_id, catalog.account, "home");
        } else if (key.startsWith("host/deleted/")) {
          requireEvidence(value === true, "invalid_tombstone");
          reference(key.slice(13), catalog.account, "deleted");
        } else {
          requireEvidence(
            /^(page|trash)\//.test(key) &&
              key.split("/").length === 2 &&
              object(value) &&
              key.split("/")[1] === value.page_id,
            "invalid_catalog_entry",
          );
          reference(
            value.page_id,
            catalog.account,
            value.pending ? "pending" : key.startsWith("trash/") ? "trashed" : "active",
          );
          if (value.parent_id) reference(value.parent_id, catalog.account, "parent");
        }
      }
    }
    const hosts = new Map();
    const documents = new Set();
    for (const host of array(evidence.hosts, LIMITS.records)) {
      requireEvidence(
        typeof host.page_id === "string" && UUID.test(host.page_id) && !hosts.has(host.page_id),
        "duplicate_or_invalid_host",
      );
      hosts.set(host.page_id, host);
    }
    const ids = new Set([...references.keys(), ...hosts.keys()]);
    requireEvidence(ids.size <= LIMITS.records, "record_limit");
    if (!ids.size) issue("empty_evidence_not_global_inventory");
    for (const id of ids) {
      const host = hosts.get(id);
      const ref = references.get(id);
      const row = {
        page_id: id,
        classification: "unknown",
        state: "incomplete",
        catalog: [...(ref?.kinds ?? [])],
        cleanup: "unknown",
        issues: [],
      };
      report.pages.push(row);
      if (!validProvenance) row.issues.push("source_provenance_missing");
      if (!host) row.issues.push("host_record_missing");
      else {
        try {
          const record = host.record;
          requireEvidence(record === null || object(record), "invalid_host_record");
          requireEvidence(
            host.creation === null || object(host.creation?.metadata),
            "creation_evidence_missing",
          );
          const pending = array(host.pending_keys);
          requireEvidence(
            pending.every(text) && new Set(pending).size === pending.length,
            "invalid_pending_keys",
          );
          const entries = pairs(host.plain);
          entryCount += entries.size;
          requireEvidence(entryCount <= LIMITS.entries, "entry_limit");
          for (const [key, value] of entries) {
            requireEvidence(key.startsWith("plain/sync/"), "invalid_plain_key");
            base64(value);
          }
          if (!ref) row.issues.push("catalog_reference_missing");
          if (record) {
            requireEvidence(
              record.pageId === id && text(record.owner) && (!ref || ref.owner === record.owner),
              "selector_owner_conflict",
            );
            requireEvidence(typeof record.deleted === "boolean", "invalid_lifecycle");
            const tree = sedimentreeId(documentIdToBinary(record.documentId));
            requireEvidence(
              record.tree === logicalId(documentIdToBinary(record.documentId)),
              "selector_tree_conflict",
            );
            requireEvidence(!documents.has(tree), "duplicate_document_selector");
            documents.add(tree);
            const commentsId = commentsDocumentId(
              record.comments_doc ?? (await commentsDocUuid(id)),
            );
            const commentsTree = sedimentreeId(documentIdToBinary(commentsId));
            requireEvidence(
              commentsTree !== tree && !documents.has(commentsTree),
              "duplicate_document_selector",
            );
            documents.add(commentsTree);
            row.lifecycle = pageState(record);
            const recordStorage =
              record.recordStorage === undefined ? "local" : record.recordStorage;
            requireEvidence(
              ["local", "buffered", "automerge"].includes(recordStorage),
              "record_storage_schema",
            );
            row.record_storage = recordStorage;
            if (host.creation) {
              const creation = host.creation.metadata;
              requireEvidence(
                creation.pageId === id &&
                  creation.owner === record.owner &&
                  creation.documentId === record.documentId,
                "creation_selector_conflict",
              );
            }
            if (ref?.kinds.has("deleted") && row.lifecycle !== "deleted")
              throw Error("catalog_tombstone_conflict");
            if (ref?.kinds.has("active") && row.lifecycle !== "active")
              throw Error("catalog_lifecycle_conflict");
            if (ref?.kinds.has("trashed") && row.lifecycle !== "trashed")
              throw Error("catalog_lifecycle_conflict");
            if (row.lifecycle === "deleted") {
              row.classification = "deleted";
              row.cleanup = entries.size ? "required" : "unknown";
              row.issues.push("cleanup_not_verified");
            } else if (row.record_storage !== "automerge") row.classification = "unmigrated";
            else {
              requireEvidence(
                host.known_heads === undefined || object(host.known_heads),
                "invalid_known_heads",
              );
              row.documents = {
                page: verifyDocument(entries, tree, host.known_heads?.page, id),
                comments: verifyDocument(entries, commentsTree, host.known_heads?.comments),
              };
              if (
                validProvenance &&
                Object.values(row.documents).every((d) => d.state === "ready")
              ) {
                row.classification = "plain_verified";
                row.state = "ready";
              }
              if (!host.known_heads?.page?.length || !host.known_heads?.comments?.length)
                row.issues.push("independent_known_heads_missing");
            }
          } else {
            if (host.creation)
              requireEvidence(
                host.creation.metadata.pageId === id &&
                  text(host.creation.metadata.owner) &&
                  (!ref || ref.owner === host.creation.metadata.owner),
                "creation_selector_conflict",
              );
            row.issues.push("host_document_missing");
          }
          if (host.creation || pending.length || ref?.kinds.has("pending")) {
            row.classification = "pending";
            row.issues.push("pending_creation_registration_or_journal");
          }
          if (host.error !== undefined) {
            requireEvidence(text(host.error), "invalid_error_evidence");
            row.classification = "errored";
            row.state = "blocked";
            row.issues.push("exporter_reported_error");
          }
          if (row.issues.length) {
            row.state = resultState(row.state, "missing");
            if (row.classification === "plain_verified") row.classification = "unknown";
          }
        } catch (error) {
          row.classification = "errored";
          row.state = "blocked";
          // Decoder errors can include document data. Expose only fixed local codes.
          row.issues.push(
            /^[a-z_]+$/.test(error.message) ? error.message : "invalid_document_evidence",
          );
        }
      }
      report.state = resultState(
        report.state,
        row.state === "blocked" ? "invalid" : row.state === "incomplete" ? "missing" : "verified",
      );
      report.counts[row.classification] = (report.counts[row.classification] ?? 0) + 1;
    }
    report.accounts_observed = accounts.size;
  } catch (error) {
    issue(/^[a-z_]+$/.test(error.message) ? error.message : "malformed_evidence", "invalid");
  }
  return report;
}

export async function main(args) {
  if (args.length !== 2 || args[0] !== "--offline-evidence") {
    console.error("Usage: node scripts/migration-inventory.mjs --offline-evidence FILE.json");
    return 2;
  }
  let fd;
  try {
    // No directory traversal, embedded paths, symlink following, sockets or stdin.
    fd = openSync(args[1], constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    requireEvidence(stat.isFile() && stat.size <= LIMITS.inputBytes, "invalid_offline_file");
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const n = readSync(fd, bytes, length, bytes.length - length, null);
      if (!n) break;
      length += n;
    }
    requireEvidence(length === stat.size, "offline_file_changed");
    const input = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
    const report = await auditInventory(input);
    console.log(JSON.stringify(report, null, 2));
    return report.state === "blocked" ? 2 : 1;
  } catch {
    console.log(
      JSON.stringify({
        schema: SCHEMA,
        state: "blocked",
        global_state: "incomplete",
        removal_ready: false,
        issues: ["offline_evidence_unreadable"],
      }),
    );
    return 2;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await main(process.argv.slice(2));
