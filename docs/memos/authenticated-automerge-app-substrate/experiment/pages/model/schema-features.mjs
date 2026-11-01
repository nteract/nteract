// Schema features: which non-baseline marks and block types a Page uses.
//
// The stamp lives at the Page document root as `schema: { features: [...] }`,
// a sorted list of feature ids. A document without it uses only the baseline,
// which is every mark and block type that has no feature in the registry.
//
// Writers add an id in the same Automerge change that first writes content
// needing it, and never remove one: a stale id only makes older builds open
// the Page read-only. Readers compare the stamp with this build's features
// (`unsupportedFeatures`); any id they don't know makes the Page read-only in
// the viewer and refuses host writes. Everything a reader must understand to
// edit safely is a feature id; other keys under `schema` are ignored.
//
// Concurrent writers can each append the same id, or append out of order, so
// readers treat the list as a set: deduplicated and sorted. Two writers can
// also each create `schema` (or its `features` list) on an unstamped Page.
// Automerge keeps both as a conflict and shows one, so readers take the union
// of every conflicting value, and the next writer copies the union into the
// visible list.
import * as A from "@automerge/automerge/slim";
import featureFile from "./features.json" with { type: "json" };
import { MARK_REGISTRY } from "./marks.mjs";

export const FEATURE_ID = /^[a-z][a-z0-9-]{0,63}$/;
/** Reported for a stamp entry that is not a string, or a stamp that is not
 * `{ features: [...] }`. It can't match a registered id, so the Page stays
 * read-only. */
export const MALFORMED_FEATURE = "!malformed";

const isMap = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** The feature registry from features.json and marks.json. Throws when the
 * files disagree: a malformed or repeated id, a mark naming an unlisted
 * feature, or a block type listed under two features. */
export function featureRegistry(features = featureFile, marks = MARK_REGISTRY) {
  if (!isMap(features) || !Array.isArray(features.features))
    throw Error("features.json needs a features list");
  const ids = new Set(),
    blocks = new Map(),
    markFeatures = new Map();
  for (const feature of features.features) {
    if (!isMap(feature) || typeof feature.id !== "string" || !FEATURE_ID.test(feature.id))
      throw Error(`Invalid schema feature id: ${feature?.id}`);
    if (ids.has(feature.id)) throw Error(`Schema feature ${feature.id} is listed twice`);
    if (typeof feature.description !== "string" || !feature.description)
      throw Error(`Schema feature ${feature.id} needs a description`);
    ids.add(feature.id);
    for (const block of feature.blocks ?? []) {
      if (typeof block !== "string" || !block)
        throw Error(`Schema feature ${feature.id} lists an invalid block type`);
      if (blocks.has(block)) throw Error(`Block type ${block} belongs to two schema features`);
      blocks.set(block, feature.id);
    }
  }
  for (const mark of marks.marks) {
    if (mark.feature === undefined) continue;
    if (!ids.has(mark.feature))
      throw Error(`Mark ${mark.name} names unknown schema feature ${mark.feature}`);
    markFeatures.set(mark.name, mark.feature);
  }
  return Object.freeze({
    ids: Object.freeze([...ids].sort()),
    marks: markFeatures,
    blocks,
  });
}

export const FEATURE_REGISTRY = featureRegistry();
/** Every feature this build can read and write. */
export const BUILD_FEATURES = FEATURE_REGISTRY.ids;

let active = FEATURE_REGISTRY;
/** Test seam: writers stamp from `registry` until the returned function runs.
 * Production code never calls this. */
export function installFeatureRegistryForTests(registry) {
  const previous = active;
  active = registry;
  return () => {
    active = previous;
  };
}

// Every concurrent value of `object[key]`: one when there is no conflict.
function values(object, key) {
  let conflicts;
  try {
    conflicts = A.getConflicts(object, key);
  } catch {
    // Not an Automerge object: a plain projection has no conflicts.
  }
  if (conflicts) return Object.values(conflicts);
  return object[key] === undefined ? [] : [object[key]];
}

/** The document's stamp as a sorted set of ids. Empty when unstamped. */
export function documentFeatures(doc) {
  if (!doc) return [];
  const ids = new Set();
  for (const schema of values(doc, "schema")) {
    if (!isMap(schema)) {
      ids.add(MALFORMED_FEATURE);
      continue;
    }
    for (const list of values(schema, "features")) {
      if (!Array.isArray(list)) ids.add(MALFORMED_FEATURE);
      else for (const id of list) ids.add(typeof id === "string" ? id : MALFORMED_FEATURE);
    }
  }
  return [...ids].sort();
}

/** The reader gate: the document's features this build doesn't have. A
 * non-empty result means read-only. */
export function unsupportedFeatures(doc, build = BUILD_FEATURES) {
  const known = new Set(build);
  return documentFeatures(doc).filter((id) => !known.has(id));
}

/** Features that native rich-text spans need: their marks, block types and
 * block parents. */
export function spanFeatures(spans, registry = active) {
  if (!registry.marks.size && !registry.blocks.size) return [];
  const needed = new Set();
  for (const span of spans) {
    if (span.type === "text") {
      for (const name of Object.keys(span.marks ?? {}))
        if (registry.marks.has(name)) needed.add(registry.marks.get(name));
    } else if (span.type === "block") {
      for (const type of [span.value?.type, ...(span.value?.parents ?? [])]) {
        const feature = registry.blocks.get(String(type));
        if (feature) needed.add(feature);
      }
    }
  }
  return [...needed].sort();
}

/** Features that writing these mark names needs. */
export function markFeatures(names, registry = active) {
  if (!registry.marks.size) return [];
  const needed = new Set();
  for (const name of names) if (registry.marks.has(name)) needed.add(registry.marks.get(name));
  return [...needed].sort();
}

/** Add ids to the stamp inside an Automerge change, keeping the list sorted.
 * Returns the ids it added. Never removes or rewrites an id. */
export function stampFeatures(doc, ids) {
  if (!ids.length) return [];
  const present = new Set(documentFeatures(doc));
  if (present.has(MALFORMED_FEATURE)) throw Error("This Page's schema stamp is malformed");
  const missing = [...new Set(ids)].filter((id) => !present.has(id)).sort();
  if (!missing.length) return [];
  if (doc.schema === undefined) doc.schema = {};
  if (doc.schema.features === undefined) doc.schema.features = [];
  const list = doc.schema.features;
  // Ids only a conflicting value holds join the visible list too.
  const visible = new Set(Array.from(list, String));
  for (const id of [...new Set([...present, ...missing])].sort()) {
    if (visible.has(id)) continue;
    let at = list.length;
    while (at > 0 && String(list[at - 1]) > id) at--;
    list.splice(at, 0, id);
  }
  return missing;
}

export const stampSpans = (doc, spans) => stampFeatures(doc, spanFeatures(spans));
export const stampMarks = (doc, names) => stampFeatures(doc, markFeatures(names));

/** The host's write gate. Throws a 409 `unsupported_schema_feature` refusal
 * when the document names a feature this build can't express, so a host write
 * never edits content it doesn't understand. */
export function requireSupportedSchema(doc, build = BUILD_FEATURES) {
  const features = unsupportedFeatures(doc, build);
  if (!features.length) return;
  throw Object.assign(
    Error(
      `This Page uses schema features this version of Pages doesn't support (${features.join(", ")}). It can be read, not edited, until Pages updates.`,
    ),
    { status: 409, code: "unsupported_schema_feature", details: { features } },
  );
}

const EDITABLE = Object.freeze({ editable: true, unsupported: Object.freeze([]) });
/** The viewer's schema gate: whether this build may edit the document, and
 * which stamped features it lacks. Pure; the session stores the result. */
export function schemaGate(doc, build = BUILD_FEATURES) {
  const unsupported = unsupportedFeatures(doc, build);
  return unsupported.length ? Object.freeze({ editable: false, unsupported }) : EDITABLE;
}
