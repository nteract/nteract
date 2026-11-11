// The Page host owns source writes. It checks Page-local asset existence,
// observed heads and retry receipts before entering the Automerge change.
import * as A from "@automerge/automerge/slim";
import { validAssetId } from "../shared/image-assets.mjs";
import { stampFeatures } from "./schema-features.mjs";

export const PAGE_SOURCES_FEATURE = "page-sources";
export const MAX_PAGE_SOURCES = 64;

const SOURCE_ID = /^[a-z][a-z0-9_-]{0,63}$/;
const reserved = new Set(["constructor", "prototype", "__proto__"]);
const validRevision = (value) =>
  typeof value === "string" &&
  /^[1-9][0-9]{0,15}$/.test(value) &&
  Number.isSafeInteger(Number(value));
const validId = (id) => typeof id === "string" && SOURCE_ID.test(id) && !reserved.has(id);
const map = (value) => value && typeof value === "object" && !Array.isArray(value);
const fail = (code, message) => {
  throw Object.assign(Error(message), {
    code,
    status: code === "source_not_found" ? 404 : code === "stale_source" ? 409 : 400,
  });
};
const own = (object, key) => object && Object.hasOwn(object, key);

export function readPageSource(doc, sourceId) {
  if (!validId(sourceId)) fail("invalid_source", "Invalid source ID");
  if (!own(doc.sources, sourceId)) fail("source_not_found", "Source not found");
  const entry = doc.sources[sourceId];
  const current = entry?.current;
  if (
    !map(entry) ||
    typeof entry.name !== "string" ||
    !entry.name.trim() ||
    entry.name.length > 200 ||
    !map(current) ||
    !validAssetId(current.asset_id) ||
    !validRevision(current.revision)
  )
    fail("invalid_source", "Malformed source record");
  return {
    source_id: sourceId,
    name: entry.name,
    asset_id: current.asset_id,
    source_revision: current.revision,
  };
}

/** Focused projection: no rows, column statistics, specs or other Page content. */
export function listPageSources(doc) {
  return Object.keys(doc.sources ?? {})
    .sort()
    .map((id) => {
      const { source_id, name } = readPageSource(doc, id);
      return { source_id, name };
    });
}

export function validateSourceWrite(args) {
  if (
    !map(args) ||
    Object.keys(args).some(
      (key) => !["source_id", "name", "asset_id", "expected_revision"].includes(key),
    )
  )
    fail("invalid_source", "Unknown source fields");
  const { source_id, name, asset_id, expected_revision } = args;
  if (
    !validId(source_id) ||
    !validAssetId(asset_id) ||
    typeof name !== "string" ||
    !name.trim() ||
    name.length > 200 ||
    !(expected_revision === null || validRevision(expected_revision))
  )
    fail(
      "invalid_source",
      "A source needs an ID, name, immutable asset ID and observed revision (null to create)",
    );
  return args;
}

/** Peer writes cannot bypass asset checks or mint host revisions. Inspect op
 * paths, including losing conflicts, rather than comparing visible JSON. */
export function sourceChangeRefusal(after, fresh) {
  const backend = A.getBackend(after);
  for (const bytes of fresh) {
    const { hash, ops } = A.decodeChange(bytes);
    for (const { obj, key } of ops) {
      const path =
        obj === "_root"
          ? []
          : (backend.objInfo(obj).path ?? backend.objInfo(obj, [hash]).path ?? []);
      if ((obj === "_root" && key === "sources") || path[0] === "sources")
        return {
          code: "request_rejected",
          message: "Update Page sources through edit_page set_source",
        };
    }
  }
  return null;
}

/** The host supplies a fresh revision, never the agent. Replace the `current`
 * object as one Automerge map value so concurrent refreshes can't pair one
 * writer's asset with another writer's revision. Preserve the source's map
 * identity and name when refreshing. Exact-head admission remains required.
 */
export function setPageSource(doc, args) {
  validateSourceWrite(args);
  const { source_id, name, asset_id, expected_revision } = args;
  const previous = own(doc.sources, source_id) ? readPageSource(doc, source_id) : null;
  if (expected_revision !== (previous?.source_revision ?? null))
    fail("stale_source", "Source changed; read it again");
  const next = previous ? Number(previous.source_revision) + 1 : 1;
  if (!Number.isSafeInteger(next) || next < 1)
    fail("invalid_source", "Source revision is invalid or exhausted");
  const revision = String(next);
  if (!previous && Object.keys(doc.sources ?? {}).length >= MAX_PAGE_SOURCES)
    fail("invalid_source", `A Page supports up to ${MAX_PAGE_SOURCES} sources`);
  if (!doc.sources) doc.sources = {};
  if (!previous) doc.sources[source_id] = { name: name.trim() };
  else if (name.trim() !== previous.name) doc.sources[source_id].name = name.trim();
  doc.sources[source_id].current = { asset_id, revision };
  stampFeatures(doc, [PAGE_SOURCES_FEATURE]);
  return readPageSource(doc, source_id);
}

/** Bindings live beside a chart spec. Resolve against one immutable document
 * snapshot, then pass the result to createPageSourceResolver's readBinding.
 * Both named and pinned assets are fetched through the same Page ACL.
 */
export function resolvePageBinding(doc, binding) {
  if (!map(binding) || Object.keys(binding).length !== 1)
    fail("invalid_binding", "Bind one source ID or one pinned asset ID");
  if (own(binding, "source_id")) {
    const { name: _name, ...resolved } = readPageSource(doc, binding.source_id);
    return resolved;
  }
  if (own(binding, "asset_id") && validAssetId(binding.asset_id))
    return { asset_id: binding.asset_id };
  fail("invalid_binding", "Bind one source ID or one pinned asset ID");
}
