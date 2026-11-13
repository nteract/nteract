import * as A from "@automerge/automerge/slim";
import { boundedWriter } from "./author.mjs";
import { readSource, validSourceId } from "./sources-doc.mjs";
import { checkViewSpec } from "../shared/view-spec.mjs";
import {
  MAX_VIEW_TITLE,
  VIEW_ID_PATTERN,
  VIEW_MEDIA_TYPES,
  VIEW_REVISION_PATTERN,
  validViewId,
} from "../shared/views.mjs";

/** A view is one chart in its own Automerge document, the `pages.view`
 * type, which only the Page's host writes. One document per view; its id
 * derives from the Page id and the view id (shared/document-ids.mjs). Its
 * shape:
 *
 * ```
 * {
 *   title: string,               // 1 to MAX_VIEW_TITLE characters
 *   media_type: string,          // one of VIEW_MEDIA_TYPES
 *   spec: Text,                  // the spec as JSON, replaced with updateText
 *   data: {                      // exactly the data names the spec reads
 *     [data_name]: { source_id } | { source_id, revision },
 *   },
 *   revision: string,            // decimal, minted by the host: "1", then +1
 *   producer: {
 *     kind: "edit_page",
 *     at: string,                // ISO 8601, the host's clock when it wrote
 *     by: { principal, displayName, driver, agent?: { name?, model? } },
 *   },
 * }
 * ```
 *
 * `{ source_id }` follows the source's current revision; `{ source_id,
 * revision }` is pinned to a revision the source's history held when the
 * view was written. `spec` is collaborative text so an editor can change it
 * in place later without a format change. `data` and `producer` are each
 * replaced as one map value per write. The genesis holds an empty `spec` and
 * `data` and no revision: a document with no `revision` holds no view yet
 * (a write stored the document and stopped before its change applied).
 */

const STATUS = {
  invalid_view: 400,
  view_not_found: 404,
  stale_view: 409,
  unknown_source: 400,
  unknown_source_revision: 400,
};
const FIELDS = ["op", "view_id", "title", "media_type", "spec", "data", "view_revision"];
const RESERVED = new Set(["constructor", "prototype", "__proto__"]);
const REVISION = new RegExp(VIEW_REVISION_PATTERN);

function fail(code, message, details) {
  throw Object.assign(Error(message), { status: STATUS[code], code, ...(details && { details }) });
}
const isMap = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const validRevision = (value) =>
  typeof value === "string" && REVISION.test(value) && Number.isSafeInteger(Number(value));
const validTitle = (title) =>
  typeof title === "string" && !!title.trim() && title.trim().length <= MAX_VIEW_TITLE;
const validTime = (value) =>
  typeof value === "string" && value.length <= 64 && !Number.isNaN(Date.parse(value));

/** Hex of 16 bytes: the genesis actor for a view document. */
function genesisActor(uuid) {
  const hex = String(uuid).replaceAll("-", "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) throw Error("Invalid view document id");
  return hex;
}

/** A view document's first change: a pure function of the document's id,
 * so a host that stored it and crashed before recording it stores the same
 * change again. Nothing else writes with this actor. */
export function viewGenesis(uuid) {
  return A.change(
    A.init({ actor: genesisActor(uuid) }),
    { time: 0, message: "view document" },
    (doc) => {
      doc.spec = "";
      doc.data = {};
    },
  );
}

/** A binding as a plain object, or undefined for one no host write stores. */
function bindingOf(value) {
  if (!isMap(value) || !validSourceId(value.source_id)) return undefined;
  const keys = Object.keys(value);
  if (keys.some((key) => key !== "source_id" && key !== "revision")) return undefined;
  if (value.revision === undefined) return { source_id: value.source_id };
  return validRevision(value.revision)
    ? { source_id: value.source_id, revision: value.revision }
    : undefined;
}

/** A stored `data` map as plain bindings, or undefined when one is not a
 * binding a host write stores. */
function dataOf(data) {
  if (!isMap(data)) return undefined;
  const out = {};
  for (const [name, value] of Object.entries(data)) {
    const binding = bindingOf(value);
    if (!binding || RESERVED.has(name)) return undefined;
    out[name] = binding;
  }
  return out;
}

/** The view a document holds, as an agent reads it with its spec, or
 * undefined for a document with no view yet. A record no host write
 * produces is invalid_view. */
export function readView(doc, viewId) {
  if (!doc || doc.revision === undefined) return undefined;
  const producer = doc.producer;
  const data = dataOf(doc.data);
  let spec;
  try {
    spec = JSON.parse(String(doc.spec ?? ""));
  } catch {
    spec = undefined;
  }
  if (
    !validRevision(doc.revision) ||
    !validTitle(doc.title) ||
    typeof doc.media_type !== "string" ||
    !data ||
    !isMap(spec) ||
    !isMap(producer) ||
    typeof producer.kind !== "string" ||
    !validTime(producer.at) ||
    !isMap(producer.by)
  )
    fail("invalid_view", "Malformed view record");
  return {
    view_id: viewId,
    title: doc.title,
    media_type: doc.media_type,
    revision: doc.revision,
    data,
    spec,
    producer: {
      kind: producer.kind,
      at: producer.at,
      by: JSON.parse(JSON.stringify(producer.by)),
    },
  };
}

/** One view as read_page `views: true` lists it: no spec, no producer. */
export function viewSummary(doc, viewId) {
  const view = readView(doc, viewId);
  if (!view) return undefined;
  const { view_id, title, media_type, revision, data } = view;
  return { view_id, title, media_type, revision, data };
}

/** Refuse a set_view operation with an unknown or malformed field. Returns
 * the data map, checked as bindings. */
export function validateViewOperation(op) {
  if (!isMap(op) || op.op !== "set_view") fail("invalid_view", "Not a set_view operation");
  const unknown = Object.keys(op).find((field) => !FIELDS.includes(field));
  if (unknown) fail("invalid_view", `set_view does not take ${String(unknown).slice(0, 64)}`);
  if (!validViewId(op.view_id))
    fail("invalid_view", `view_id must match ${VIEW_ID_PATTERN} and not be a reserved name`);
  if (!validTitle(op.title))
    fail("invalid_view", `title must be 1 to ${MAX_VIEW_TITLE} characters, not only spaces`);
  if (!VIEW_MEDIA_TYPES.includes(op.media_type))
    fail("invalid_view", `media_type must be ${VIEW_MEDIA_TYPES.join(" or ")}`);
  if (!(op.view_revision === null || validRevision(op.view_revision)))
    fail(
      "invalid_view",
      "view_revision is the view's revision from read_page, or null to create the view",
    );
  if (!isMap(op.data) || !Object.keys(op.data).length)
    fail("invalid_view", "data must map each data name the spec reads to a source");
  for (const [name, binding] of Object.entries(op.data)) {
    if (RESERVED.has(name)) fail("invalid_view", `data can't name "${name}"`);
    if (!bindingOf(binding))
      fail(
        "invalid_view",
        `data.${name.slice(0, 64)} must be {source_id} or {source_id, revision}, revision a source revision from read_page`,
      );
  }
  const checked = checkViewSpec(op.spec, op.data);
  if (!checked.ok) fail("invalid_view", checked.error);
  return op;
}

/**
 * Every refusal setView can give `op`, checked against the view's document
 * `doc` (undefined, or a genesis, for a view that doesn't exist yet) and the
 * Page's sources document `sourcesDoc` without writing: the operation's
 * shape and spec, each binding's source, and `view_revision` against the
 * stored view. Returns the stored view, or undefined for one it creates.
 */
export function checkView(doc, op, { sourcesDoc } = {}) {
  validateViewOperation(op);
  for (const [name, binding] of Object.entries(op.data)) {
    let source;
    try {
      source = readSource(sourcesDoc, binding.source_id);
    } catch (error) {
      if (error.code !== "source_not_found") throw error;
      fail(
        "unknown_source",
        `data.${name} names source "${binding.source_id}", which isn't a source on this Page. Add it with set_source first.`,
        { source_id: binding.source_id },
      );
    }
    // A pinned revision must still be in the source's history, which keeps
    // the asset each state named. Older states are not readable, so a view
    // pinned to one could never draw.
    if (
      binding.revision !== undefined &&
      !source.history.some((state) => state.revision === binding.revision)
    )
      fail(
        "unknown_source_revision",
        `data.${name} pins source "${binding.source_id}" to revision ${binding.revision}, which its history doesn't hold. Read the source for the revisions it keeps.`,
        { source_id: binding.source_id, source_revision: source.source_revision },
      );
  }
  const previous = readView(doc, op.view_id);
  if (!previous && op.view_revision !== null)
    fail(
      "view_not_found",
      "No view with this ID on this Page; pass view_revision null to create it",
      {
        view_id: op.view_id,
        view_revision: null,
      },
    );
  if (previous && op.view_revision !== previous.revision)
    fail(
      "stale_view",
      op.view_revision === null
        ? "This view exists; pass its view_revision to change it"
        : "This view changed since it was read; read it again",
      { view_id: op.view_id, view_revision: previous.revision },
    );
  if (previous && !validRevision(String(Number(previous.revision) + 1)))
    fail("invalid_view", "This view's revisions are exhausted");
  return previous;
}

/**
 * Apply a checked set_view inside one host change. `by` is the writer
 * (author.mjs authorOf), stored within WRITER_LIMITS; `at` the host's time.
 * Mints the next revision. Returns the receipt's edit.
 */
export function setView(doc, op, { sourcesDoc, by, at = new Date().toISOString() }) {
  const previous = checkView(doc, op, { sourcesDoc });
  if (!validTime(at) || !isMap(by)) throw Error("A view write needs its writer and time");
  const revision = String(previous ? Number(previous.revision) + 1 : 1);
  const title = op.title.trim();
  if (doc.title !== title) doc.title = title;
  if (doc.media_type !== op.media_type) doc.media_type = op.media_type;
  const spec = JSON.stringify(op.spec);
  if (typeof doc.spec !== "string") doc.spec = spec;
  else if (doc.spec !== spec) A.updateText(doc, ["spec"], spec);
  doc.data = Object.fromEntries(Object.entries(op.data).map(([name, b]) => [name, bindingOf(b)]));
  doc.revision = revision;
  doc.producer = { kind: "edit_page", at, by: boundedWriter(by) };
  return { op: "set_view", view_id: op.view_id, view_revision: revision };
}
