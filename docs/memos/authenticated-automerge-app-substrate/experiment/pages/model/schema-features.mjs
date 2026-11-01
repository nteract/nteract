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

/** Stamped ids a build lacks. Pure; the reader and native gates share it. */
export function missingFeatures(stamp, build) {
  const known = new Set(build);
  return [...new Set(stamp)].filter((id) => !known.has(id)).sort();
}

/** The reader gate: the document's features this build doesn't have. A
 * non-empty result means read-only. */
export function unsupportedFeatures(doc, build = BUILD_FEATURES) {
  return missingFeatures(documentFeatures(doc), build);
}

const MAX_DECLARED = 64;
/** A client's declared build features, from a comma-separated query value.
 * Absent means a build from before the stamp: the baseline. Returns null for
 * a malformed value. */
export function parseDeclaredFeatures(value) {
  if (value === null || value === undefined || value === "") return [];
  const ids = String(value).split(",");
  if (ids.length > MAX_DECLARED || ids.some((id) => !FEATURE_ID.test(id))) return null;
  return [...new Set(ids)].sort();
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

/** Add ids to the stamp inside an Automerge change, keeping the visible list
 * sorted. Returns the ids it added. Never removes or rewrites an id.
 *
 * It also repairs concurrent first stamps: when the visible list lacks an id
 * that only a conflicting `schema` or `features` value holds, it copies the id
 * in. Every writer calls this in its own change, with no ids for baseline
 * content, so the list converges on the next write of any kind. */
export function stampFeatures(doc, ids = []) {
  const present = documentFeatures(doc);
  if (present.includes(MALFORMED_FEATURE)) {
    // Readers already hold a malformed stamp read-only; never guess at it.
    if (ids.length) throw Error("This Page's schema stamp is malformed");
    return [];
  }
  const missing = [...new Set(ids)].filter((id) => !present.includes(id)).sort();
  const wanted = [...new Set([...present, ...missing])].sort();
  if (!wanted.length) return [];
  const shown = isMap(doc.schema) && Array.isArray(doc.schema.features) ? doc.schema.features : [];
  const visible = new Set(Array.from(shown, String));
  if (wanted.every((id) => visible.has(id))) return missing;
  if (doc.schema === undefined) doc.schema = {};
  if (doc.schema.features === undefined) doc.schema.features = [];
  const list = doc.schema.features;
  for (const id of wanted) {
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

/**
 * The viewer's schema gate as a state machine.
 *
 * States: `editable` (`editable: true`) and read-only (`editable: false`).
 * `unsupported` lists the stamped ids this build lacks; `refused` says the
 * host refused this tab's edits for the same reason before the stamp reached
 * the replica.
 *
 * Events:
 * - `observe`: the replica opened or changed. The gate re-derives from its
 *   stamp. Stamps only grow, so read-only never reopens; ids accumulate.
 * - `refused`: the host answered a receipt with `schema_unsupported`.
 * - `edit`: a local edit was attempted. The state is unchanged; `allowed`
 *   says whether it may reach the document.
 * - `reload`: the tab reloads into another build. Its new session starts
 *   editable and re-derives on its first `observe`.
 *
 * Pure: the session stores the state and runs effects from `editable`.
 */
export const SCHEMA_GATE_INITIAL = Object.freeze({
  editable: true,
  unsupported: Object.freeze([]),
  refused: false,
});

const gateState = (unsupported, refused) =>
  !unsupported.length && !refused
    ? SCHEMA_GATE_INITIAL
    : Object.freeze({ editable: false, unsupported: Object.freeze(unsupported), refused });

export function schemaGateStep(gate, event, build = BUILD_FEATURES) {
  switch (event.type) {
    case "observe": {
      const unsupported = [
        ...new Set([...gate.unsupported, ...unsupportedFeatures(event.doc, build)]),
      ].sort();
      const next =
        unsupported.length === gate.unsupported.length
          ? gate
          : gateState(unsupported, gate.refused);
      return { gate: next, allowed: next.editable };
    }
    case "refused": {
      const next = gate.refused ? gate : gateState([...gate.unsupported], true);
      return { gate: next, allowed: false };
    }
    case "edit":
      return { gate, allowed: gate.editable };
    case "reload":
      return { gate: SCHEMA_GATE_INITIAL, allowed: true };
  }
  throw Error(`Unknown schema gate event ${event?.type}`);
}

/** The gate a fresh session derives from `doc`. */
export function schemaGate(doc, build = BUILD_FEATURES) {
  return schemaGateStep(SCHEMA_GATE_INITIAL, { type: "observe", doc }, build).gate;
}

/** The native and receipt refusal for a peer whose build lacks a stamped id.
 * Its message is the viewer's notice, so a build from before the stamp shows
 * it as a save problem. */
export function schemaUnsupported(features) {
  return Object.assign(
    Error("This Page uses features this version doesn't support. Reload to update."),
    { status: 409, code: "schema_unsupported", details: { features } },
  );
}
