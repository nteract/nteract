import { isExecutableView } from "../shared/anywidget-view.mjs";
import { viewDependencies } from "../shared/view-dependencies.mjs";
import * as A from "@automerge/automerge/slim";
import { boundedWriter } from "./author.mjs";
import { readSource, validSourceId } from "./sources-doc.mjs";
import {
  bindingOf,
  fail,
  isMap,
  readView,
  validRevision,
  validTitle,
  validTime,
} from "./view-record.mjs";
import { SOURCE_ID_PATTERN } from "../shared/sources.mjs";
import {
  checkViewSpec,
  quotedDataName,
  quotedDataNames,
  viewDataProblem,
} from "../shared/view-spec.mjs";
import {
  MAX_VIEW_DATA,
  MAX_VIEW_TITLE,
  RESERVED_DATA_NAMES,
  RESERVED_VIEW_IDS,
  VIEW_DATA_NAME_PATTERN,
  VIEW_ID_PATTERN,
  VIEW_MEDIA_TYPES,
  VIEW_FORMATS,
  validDataName,
  validViewId,
} from "../shared/views.mjs";

/** A view is one configured renderer in its own Automerge document, the `pages.view`
 * type, which only the Page's host writes. One document per view; its id
 * derives from the Page id and the view id (shared/document-ids.mjs). Its
 * shape:
 *
 * ```
 * {
 *   title: string,               // 1 to MAX_VIEW_TITLE characters
 *   media_type: string,          // one of VIEW_MEDIA_TYPES
 *   spec: Text,                  // the spec as JSON, replaced with updateText
 *   catalog_revision?: string,  // the host's library catalog at the executable view's last save
 *   data: {                      // chart dataset bindings; empty for anywidget
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
 * view was written. Anywidget references live in spec; charts bind them in data.
 * `spec` is collaborative text so an editor can change it
 * in place later without a format change. `data` and `producer` are each
 * replaced as one map value per write. The genesis holds an empty `spec` and
 * `data` and no revision: a document with no `revision` holds no view yet
 * (a write stored the document and stopped before its change applied).
 */

const FIELDS = ["op", "view_id", "title", "media_type", "spec", "data", "view_revision"];

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

export { readView };

/** One view as read_page `views: true` lists it: no spec, no producer. */
export function viewSummary(doc, viewId) {
  const view = readView(doc, viewId);
  if (!view) return undefined;
  const { view_id, title, media_type, revision, data } = view;
  const summary = {
    view_id,
    title,
    media_type,
    revision,
    ...(view.catalog_revision && { catalog_revision: view.catalog_revision }),
  };
  if (!isExecutableView(media_type)) return { ...summary, data };
  try {
    return {
      ...summary,
      dependencies: viewDependencies(view).map(({ source, role, location }) => ({
        source,
        role,
        location,
      })),
    };
  } catch {
    // Retain the identity/revision needed to inspect and repair this view.
    // An unreadable dependency inventory must not break the containing Page.
    return { ...summary, dependencies_unavailable: true };
  }
}

// A title a write may set holds no control characters; a stored title is
// read by its length and trimmed text alone (model/view-record.mjs), as a
// source name is (model/sources-doc.mjs).
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/** Refuse a set_view operation with an unknown or malformed field. Returns
 * the data map, checked as bindings. */
export function validateViewOperation(op) {
  if (!isMap(op) || op.op !== "set_view") fail("invalid_view", "Not a set_view operation");
  if (Object.hasOwn(op, "view_type")) {
    const { view_type, ...fields } = op;
    if (typeof view_type !== "string" || !Object.hasOwn(VIEW_FORMATS, view_type))
      fail("invalid_view", "Choose view_type module, anywidget or vega-lite.");
    if (Object.hasOwn(fields, "media_type")) fail("invalid_view", "Choose one view format.");
    if (view_type === "module") {
      if (Object.hasOwn(fields, "spec"))
        fail("invalid_view", "A module view takes module, data and imports.");
      const { module, data, imports, ...rest } = fields;
      op = {
        ...rest,
        media_type: VIEW_FORMATS.module,
        spec: {
          module,
          ...(data !== undefined && { files: data }),
          ...(imports !== undefined && { imports }),
        },
      };
    } else op = { ...fields, media_type: VIEW_FORMATS[view_type] };
  }
  const unknown = Object.keys(op).find((field) => !FIELDS.includes(field));
  if (unknown) fail("invalid_view", `set_view does not take ${String(unknown).slice(0, 64)}`);
  if (!validViewId(op.view_id))
    fail("invalid_view", `view_id must match ${VIEW_ID_PATTERN}, not ${RESERVED_VIEW_IDS}`);
  if (!validTitle(op.title))
    fail("invalid_view", `title must be 1 to ${MAX_VIEW_TITLE} characters, not only spaces`);
  if (CONTROL.test(op.title))
    fail("invalid_view", "title can't hold control characters such as a newline or NUL");
  if (!VIEW_MEDIA_TYPES.includes(op.media_type))
    fail(
      "invalid_view",
      Object.hasOwn(op, "media_type")
        ? "Unknown media_type. Choose view_type module, anywidget or vega-lite."
        : "Choose view_type module, anywidget or vega-lite.",
    );
  if (!(op.view_revision === null || validRevision(op.view_revision)))
    fail(
      "invalid_view",
      "view_revision is the view's revision from read_page, or null to create the view",
    );
  // Widgets validate their references in spec and reject data. Charts validate
  // their spec before checking the dataset names that data must bind.
  const checked = checkViewSpec(
    op.spec,
    isExecutableView(op.media_type) ? op.data : undefined,
    op.media_type,
  );
  if (!checked.ok) fail("invalid_view", checked.error);
  if (isExecutableView(op.media_type)) return op;
  if (!isMap(op.data) || !Object.keys(op.data).length)
    fail(
      "invalid_view",
      `data must map each data name the spec reads (${quotedDataNames(checked.names)}) to a source: {${quotedDataName(checked.names[0])}: {"source_id": "<source_id>"}}`,
    );
  if (Object.keys(op.data).length > MAX_VIEW_DATA)
    fail("invalid_view", `data can bind at most ${MAX_VIEW_DATA} data names`);
  for (const [name, binding] of Object.entries(op.data)) {
    if (!validDataName(name))
      fail(
        "invalid_view",
        `data can't name ${quotedDataName(name)}: a data name matches ${VIEW_DATA_NAME_PATTERN}, not ${RESERVED_DATA_NAMES}`,
      );
    if (isMap(binding) && binding.source_id === undefined)
      fail("invalid_view", `data.${name} needs a source_id: a source this Page holds`);
    if (isMap(binding) && !validSourceId(binding.source_id))
      fail(
        "invalid_view",
        typeof binding.source_id === "string"
          ? `data.${name}.source_id must match ${SOURCE_ID_PATTERN}, not "${binding.source_id.slice(0, 64)}"`
          : `data.${name}.source_id must be a string matching ${SOURCE_ID_PATTERN}`,
      );
    if (!bindingOf(binding))
      fail(
        "invalid_view",
        `data.${name} must be {source_id} or {source_id, revision}, revision a source revision from read_page`,
      );
  }
  const problem = viewDataProblem(checked.names, op.data);
  if (problem) fail("invalid_view", problem);
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
  return checkViewBindings(doc, validateViewOperation(op), sourcesDoc);
}

/** The state of `source` (a readSource record) that `binding` names: its
 * pinned revision, else the current one. Undefined when the source's history
 * no longer holds the pinned revision. */
export function boundVersion(source, binding) {
  return binding.revision === undefined
    ? source
    : source.history.find((state) => state.revision === binding.revision);
}

/** checkView for an operation validateViewOperation already returned. */
export function checkViewBindings(doc, op, sourcesDoc) {
  for (const { source: binding, location, mediaType } of viewDependencies(op)) {
    let source;
    try {
      source = readSource(sourcesDoc, binding.source_id);
    } catch (error) {
      if (error.code !== "source_not_found") throw error;
      fail(
        "unknown_source",
        `${location} names source "${binding.source_id}", which isn't a source on this Page. Add it with set_source first.`,
        { source_id: binding.source_id },
      );
    }
    // A pinned revision must still be in the source's history, which keeps
    // the asset each state named. Older states are not readable, so a view
    // pinned to one could never draw.
    const version = boundVersion(source, binding);
    if (!version)
      fail(
        "unknown_source_revision",
        `${location} pins source "${binding.source_id}" to revision ${binding.revision}, which its history doesn't hold. Read the source for the revisions it keeps.`,
        { source_id: binding.source_id, source_revision: source.source_revision },
      );
    if (mediaType && version.media_type !== mediaType)
      fail(
        "invalid_view",
        `${location} source "${binding.source_id}" must be ${mediaType}; received ${version.media_type}.`,
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
export function setView(
  doc,
  op,
  { sourcesDoc, by, catalogRevision, at = new Date().toISOString() },
) {
  op = validateViewOperation(op);
  const previous = checkViewBindings(doc, op, sourcesDoc);
  if (!validTime(at) || !isMap(by)) throw Error("A view write needs its writer and time");
  const revision = String(previous ? Number(previous.revision) + 1 : 1);
  const title = op.title.trim();
  if (doc.title !== title) doc.title = title;
  if (doc.media_type !== op.media_type) doc.media_type = op.media_type;
  // Every save of an executable view records the host's catalog: the catalog
  // the view was last saved against, which the viewer uses while the host
  // still serves it, and otherwise the host's current one
  // (viewer/library-catalog.mjs). A view that isn't executable holds none.
  if (!isExecutableView(op.media_type)) {
    if (doc.catalog_revision !== undefined) delete doc.catalog_revision;
  } else if (catalogRevision && doc.catalog_revision !== catalogRevision) {
    doc.catalog_revision = catalogRevision;
  }
  const spec = JSON.stringify(op.spec);
  if (typeof doc.spec !== "string") doc.spec = spec;
  else if (doc.spec !== spec) A.updateText(doc, ["spec"], spec);
  // Preserve the generic record shape; widget references live only in spec.
  doc.data = isExecutableView(op.media_type)
    ? {}
    : Object.fromEntries(Object.entries(op.data).map(([name, b]) => [name, bindingOf(b)]));
  doc.revision = revision;
  doc.producer = { kind: "edit_page", at, by: boundedWriter(by) };
  return {
    op: "set_view",
    view_id: op.view_id,
    view_revision: revision,
    ...(doc.catalog_revision && { catalog_revision: doc.catalog_revision }),
  };
}
