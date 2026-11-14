import * as A from "@automerge/automerge/slim";
import { WRITER_LIMITS, boundedWriter } from "./author.mjs";
import { validAssetId } from "../shared/image-assets.mjs";
import {
  MAX_SOURCE_NAME,
  MAX_SOURCES,
  MAX_SOURCE_IDS,
  SOURCE_ID_PATTERN,
  SOURCE_REVISION_PATTERN,
} from "../shared/sources.mjs";

export { MAX_SOURCE_NAME, MAX_SOURCES, MAX_SOURCE_IDS };

/** A Page's named sources live in their own Automerge document, the
 * `pages.sources` type, which only the Page's host writes. Its shape:
 *
 * ```
 * {
 *   sources: {
 *     [source_id]: {
 *       name: string,
 *       revision: string,          // decimal, minted by the host: "1", then +1 per write
 *       current: { media_type: string, asset_id: string },
 *       producer: {
 *         kind: "upload",
 *         at: string,              // ISO 8601, the host's clock when it wrote
 *         by: { principal, displayName, driver, agent?: { name?, model? } },
 *       },
 *       history: [                 // oldest first, at most SOURCE_HISTORY_LIMIT
 *         { revision, name, media_type, asset_id, at, by },
 *       ],
 *     } | {
 *       deleted: true,             // a tombstone: the source was deleted
 *       at?: string,               // ISO 8601, the host's clock when it deleted
 *       by?: { principal, displayName, driver, agent?: { name?, model? } },
 *     }
 *   }
 * }
 * ```
 *
 * A source is a stable id, an editable name and the immutable Page asset it
 * currently names. `producer` is the write that set the entry: `by` is the
 * writer in a comment author's shape (author.mjs), the account the host
 * authenticated and the labels and agent its client asserted. `current` and
 * `producer` are each replaced as one map value, so a reader never pairs one
 * write's asset with another's media type, or one write's time with
 * another's writer. Every write is the host's, serialized in the Page's
 * queue, so `revision` moves once per accepted write.
 *
 * `history` is the source's newest states. The write that creates or changes
 * a source appends its state in the same change and drops states from the
 * front past the cap, so the last state always equals the entry's present
 * name, revision, `current` and `producer`; a read refuses an entry where it
 * doesn't. Older states remain in the document's Automerge history, but no
 * read returns them.
 *
 * A tombstone replaces a deleted source's whole entry. Its id is retired: no
 * read returns it as a source, it still counts toward MAX_SOURCE_IDS, and a
 * write that names it is refused, so the id is never reused. `at` and `by`
 * record the delete the way `producer` records a write; a tombstone written
 * without them holds `deleted: true` alone, and deletedSource reads both
 * forms.
 */

const SOURCE_ID = new RegExp(SOURCE_ID_PATTERN);
const RESERVED = new Set(["constructor", "prototype", "__proto__"]);
const REVISION = new RegExp(SOURCE_REVISION_PATTERN);
const FIELDS = ["op", "source_id", "name", "asset_id", "source_revision"];
const DELETE_FIELDS = ["op", "source_id", "source_revision"];

const STATUS = { invalid_source: 400, source_not_found: 404, stale_source: 409 };
function fail(code, message, details) {
  throw Object.assign(Error(message), { status: STATUS[code], code, ...(details && { details }) });
}
const isMap = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const validRevision = (value) =>
  typeof value === "string" && REVISION.test(value) && Number.isSafeInteger(Number(value));
/** Whether `id` is a well-formed source id. */
export const validSourceId = (id) =>
  typeof id === "string" && SOURCE_ID.test(id) && !RESERVED.has(id);
const validName = (name) =>
  typeof name === "string" && !!name.trim() && name.trim().length <= MAX_SOURCE_NAME;
// A name a write may set. Stored names are read with validName alone, so an
// entry a host stored before this check still reads.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
// The reserved ids an agent could otherwise write: the rest fail the pattern.
const RESERVED_NAMED = [...RESERVED].filter((id) => SOURCE_ID.test(id)).join(" or ");

/** Hex of 16 bytes: the genesis actor for a sources document. */
function genesisActor(uuid) {
  const hex = String(uuid).replaceAll("-", "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) throw Error("Invalid sources document id");
  return hex;
}

/** The sources document's first change. A pure function of the document's
 * id, so writing it twice stores the same change: a host that stored the
 * document and crashed before recording it in the Page record imports the
 * identical genesis again. Nothing else writes with this actor. */
export function sourcesGenesis(uuid) {
  return A.change(
    A.init({ actor: genesisActor(uuid) }),
    { time: 0, message: "sources document" },
    (doc) => {
      doc.sources = {};
    },
  );
}

/** The source map of a sources document, or an empty object. */
const sourceMap = (doc) => (isMap(doc?.sources) ? doc.sources : {});

const AUTHOR_FIELDS = ["principal", "displayName", "driver", "agent"];
const AGENT_FIELDS = ["name", "model"];
const validTime = (value) =>
  typeof value === "string" && value.length <= 64 && !Number.isNaN(Date.parse(value));
// A writer's labels are stored within WRITER_LIMITS (model/author.mjs). Each
// of a source's 50 history states repeats its writer, so the limits keep a
// single-source read inside read_page's default byte budget.
export { WRITER_LIMITS };
const within = (value, max) => typeof value === "string" && value.length <= max;
/** Whether `by` is a writer author.mjs builds, within WRITER_LIMITS. */
const validWriter = (by) =>
  isMap(by) &&
  Object.keys(by).every((key) => AUTHOR_FIELDS.includes(key)) &&
  typeof by.principal === "string" &&
  within(by.displayName, WRITER_LIMITS.displayName) &&
  within(by.driver, WRITER_LIMITS.driver) &&
  (by.agent === undefined ||
    (isMap(by.agent) &&
      Object.keys(by.agent).every((key) => AGENT_FIELDS.includes(key)) &&
      (by.agent.name === undefined || within(by.agent.name, WRITER_LIMITS.agentName)) &&
      (by.agent.model === undefined || within(by.agent.model, WRITER_LIMITS.agentModel))));

/** A plain copy of a stored writer. */
const writerCopy = (by) => ({
  principal: by.principal,
  displayName: by.displayName,
  driver: by.driver,
  ...(by.agent && { agent: { ...by.agent } }),
});

/** How many states a source's `history` list holds: the newest. */
export const SOURCE_HISTORY_LIMIT = 50;

const STATE_FIELDS = ["revision", "name", "media_type", "asset_id", "at", "by"];
/** A history state as a plain object, or undefined for one no host write
 * stores. */
function stateOf(state) {
  if (
    !isMap(state) ||
    !Object.keys(state).every((key) => STATE_FIELDS.includes(key)) ||
    !validRevision(state.revision) ||
    !validName(state.name) ||
    typeof state.media_type !== "string" ||
    !validAssetId(state.asset_id) ||
    !validTime(state.at) ||
    !validWriter(state.by)
  )
    return undefined;
  return {
    revision: state.revision,
    name: state.name,
    media_type: state.media_type,
    asset_id: state.asset_id,
    at: state.at,
    by: writerCopy(state.by),
  };
}
/** Whether two states record the same write, field for field. */
const sameState = (a, b) =>
  a.revision === b.revision &&
  a.name === b.name &&
  a.media_type === b.media_type &&
  a.asset_id === b.asset_id &&
  a.at === b.at &&
  JSON.stringify(a.by) === JSON.stringify(b.by);

/**
 * A stored history list as its states, oldest first, or undefined for a list
 * no host write produces: revisions strictly rise along it, and its last
 * state equals `present`, the entry's own name, revision, `current` and
 * `producer`, as a whole. The host builds each source write in the Page's
 * queue, so no two writes share a base and one write's state is never split
 * across fields; an entry that doesn't hold this reads as invalid_source
 * rather than as a state no writer stored.
 */
function historyOf(list, present) {
  if (!Array.isArray(list) || !list.length) return undefined;
  const states = [];
  for (const stored of list) {
    const state = stateOf(stored);
    if (!state) return undefined;
    if (states.length && Number(state.revision) <= Number(states.at(-1).revision)) return undefined;
    states.push(state);
  }
  return sameState(states.at(-1), present) ? states : undefined;
}

/** One stored source as an agent reads it, or an invalid_source refusal for
 * a record no host write produces. */
function project(id, entry) {
  const current = entry?.current;
  const producer = entry?.producer;
  if (
    !isMap(entry) ||
    !validName(entry.name) ||
    !validRevision(entry.revision) ||
    !isMap(current) ||
    !validAssetId(current.asset_id) ||
    typeof current.media_type !== "string" ||
    !isMap(producer) ||
    typeof producer.kind !== "string" ||
    !validTime(producer.at) ||
    !validWriter(producer.by)
  )
    fail("invalid_source", "Malformed source record");
  const by = writerCopy(producer.by);
  const history = historyOf(entry.history, {
    revision: entry.revision,
    name: entry.name,
    media_type: current.media_type,
    asset_id: current.asset_id,
    at: producer.at,
    by,
  });
  if (!history) fail("invalid_source", "Malformed source history");
  return {
    source_id: id,
    name: entry.name,
    source_revision: entry.revision,
    asset_id: current.asset_id,
    media_type: current.media_type,
    producer: { kind: producer.kind, at: producer.at, by },
    history,
    // Each write raises the revision by one and appends one state, so a list
    // that kept every state holds exactly `revision` of them. Fewer means the
    // cap dropped older ones from the front.
    history_truncated: Number(entry.revision) > history.length,
  };
}

/** One source, with its producer and history. A malformed id is
 * invalid_source and an unknown one source_not_found. `doc` may be
 * undefined: a Page with no sources document holds no source. */
export function readSource(doc, sourceId) {
  if (!validSourceId(sourceId)) fail("invalid_source", "Invalid source ID");
  const sources = sourceMap(doc);
  if (!Object.hasOwn(sources, sourceId) || sources[sourceId]?.deleted === true)
    fail("source_not_found", "No source with this ID on this Page");
  return project(sourceId, sources[sourceId]);
}

/** A retired source id's tombstone: `{ source_id, at, by }`, with `at` and
 * `by` null for a tombstone that holds no valid time and writer. Null for an
 * id that names an active source or none. */
export function deletedSource(doc, sourceId) {
  const sources = sourceMap(doc);
  if (!validSourceId(sourceId) || !Object.hasOwn(sources, sourceId)) return null;
  const entry = sources[sourceId];
  if (entry?.deleted !== true) return null;
  return validTime(entry.at) && validWriter(entry.by)
    ? { source_id: sourceId, at: entry.at, by: writerCopy(entry.by) }
    : { source_id: sourceId, at: null, by: null };
}

/** Every source, ordered by id, without producers or history. Empty for a
 * Page with no sources document. */
export function listSources(doc) {
  const sources = sourceMap(doc);
  return Object.keys(sources)
    .filter((id) => sources[id]?.deleted !== true)
    .sort()
    .map((id) => {
      const {
        producer: _producer,
        history: _history,
        history_truncated: _truncated,
        ...source
      } = project(id, sources[id]);
      return source;
    });
}

/** Refuse a source operation with an unknown or malformed field. */
export function validateSourceOperation(op) {
  if (!isMap(op) || !["set_source", "delete_source"].includes(op.op))
    fail("invalid_source", "Not a source operation");
  const fields = op.op === "delete_source" ? DELETE_FIELDS : FIELDS;
  const unknown = Object.keys(op).find((field) => !fields.includes(field));
  if (unknown) fail("invalid_source", `${op.op} does not take ${String(unknown).slice(0, 64)}`);
  if (!validSourceId(op.source_id))
    fail("invalid_source", `source_id must match ${SOURCE_ID_PATTERN}, not ${RESERVED_NAMED}`);
  if (op.op === "delete_source") {
    if (!validRevision(op.source_revision))
      fail("invalid_source", "delete_source requires the source_revision you read");
    return op;
  }
  if (!validName(op.name))
    fail("invalid_source", `name must be 1 to ${MAX_SOURCE_NAME} characters, not only spaces`);
  if (CONTROL.test(op.name))
    fail("invalid_source", "name can't hold control characters such as a newline or NUL");
  if (!validAssetId(op.asset_id))
    fail(
      "invalid_source",
      "asset_id is 64 lowercase hex characters: the asset_id an upload returned",
    );
  if (!(op.source_revision === null || validRevision(op.source_revision)))
    fail(
      "invalid_source",
      "source_revision is the source's revision from read_page, or null to create the source",
    );
  return op;
}

/** Validate a batch of set_source operations: each well-formed, and no
 * source named twice. Returns the asset ids the batch names. */
export function validateSourceBatch(operations) {
  if (!Array.isArray(operations) || !operations.length)
    fail("invalid_source", "Provide at least one set_source operation");
  const ids = new Set();
  for (const op of operations) {
    validateSourceOperation(op);
    if (ids.has(op.source_id))
      fail("invalid_source", "A batch cannot change the same source twice");
    ids.add(op.source_id);
  }
  return [...new Set(operations.filter((op) => op.op === "set_source").map((op) => op.asset_id))];
}

/**
 * Apply a validated batch of set_source operations inside one host change.
 * `mediaTypes` maps each named asset id to the media type its stored record
 * holds; `by` is the writer (author.mjs authorOf), stored within
 * WRITER_LIMITS (boundedWriter), and `at` the host's time
 * for the batch, read once when the caller gives none. Each operation checks
 * the revision its caller saw (null creates), then mints the next revision
 * and appends the new state to the source's history. Returns the receipt's
 * per-operation edits.
 */
export function setSources(
  doc,
  operations,
  { mediaTypes, by: writer, at = new Date().toISOString() },
) {
  const by = boundedWriter(writer);
  if (!validWriter(by) || !validTime(at)) throw Error("A source write needs its writer and time");
  const previousOf = checkSources(doc, operations);
  if (!isMap(doc.sources)) doc.sources = {};
  const sources = doc.sources;
  return operations.map((op, index) => {
    const id = op.source_id;
    const previous = previousOf[index];
    if (op.op === "delete_source") {
      // Retire the ID rather than letting a later create reuse revision 1.
      sources[id] = { deleted: true, at, by: writerCopy(by) };
      return { op: "delete_source", source_id: id };
    }
    const mediaType = mediaTypes.get(op.asset_id);
    if (typeof mediaType !== "string") throw Error("A source's asset has no checked media type");
    const revision = String(previous ? Number(previous.source_revision) + 1 : 1);
    const name = op.name.trim();
    const current = { media_type: mediaType, asset_id: op.asset_id };
    const producer = { kind: "upload", at, by: writerCopy(by) };
    const state = { revision, name, ...current, at, by: writerCopy(by) };
    if (!previous) sources[id] = { name, revision, current, producer, history: [state] };
    else {
      const entry = sources[id];
      if (entry.name !== name) entry.name = name;
      entry.revision = revision;
      if (previous.asset_id !== current.asset_id || previous.media_type !== current.media_type)
        entry.current = current;
      entry.producer = producer;
      entry.history.push(state);
      const excess = entry.history.length - SOURCE_HISTORY_LIMIT;
      if (excess > 0) entry.history.splice(0, excess);
    }
    return { op: "set_source", source_id: id, source_revision: revision };
  });
}

/**
 * Every refusal setSources can give a batch, checked against `doc` without
 * writing: the batch's shape, the Page's source cap, and each operation's
 * source_revision against the source it names. `doc` may be a sources
 * document's genesis, for a Page that has none yet. Returns each operation's
 * current source, or null for one it creates.
 */
export function checkSources(doc, operations) {
  validateSourceBatch(operations);
  const sources = sourceMap(doc);
  const created = operations.filter(
    (op) => op.op === "set_source" && !Object.hasOwn(sources, op.source_id),
  ).length;
  const removed = operations.filter((op) => op.op === "delete_source").length;
  if (created && Object.keys(sources).length + created > MAX_SOURCE_IDS)
    fail(
      "invalid_source",
      `A Page holds up to ${MAX_SOURCE_IDS} source IDs, including deleted sources`,
    );
  if (
    created &&
    Object.values(sources).filter((entry) => entry?.deleted !== true).length + created - removed >
      MAX_SOURCES
  )
    fail("invalid_source", `A Page holds up to ${MAX_SOURCES} sources`);
  return operations.map((op) => {
    const id = op.source_id;
    if (sources[id]?.deleted === true)
      fail("source_not_found", "This source was deleted; create a source with a new ID", {
        source_id: id,
      });
    const previous = Object.hasOwn(sources, id) ? project(id, sources[id]) : null;
    if (!previous && op.source_revision !== null)
      fail(
        "source_not_found",
        "No source with this ID on this Page; pass source_revision null to create it",
        {
          source_id: id,
          source_revision: null,
        },
      );
    if (previous && op.source_revision !== previous.source_revision)
      fail(
        "stale_source",
        op.source_revision === null
          ? "This source exists; pass its source_revision to change it"
          : "This source changed since it was read; read it again",
        { source_id: id, source_revision: previous.source_revision },
      );
    if (previous && !validRevision(String(Number(previous.source_revision) + 1)))
      fail("invalid_source", "This source's revisions are exhausted");
    return previous;
  });
}
