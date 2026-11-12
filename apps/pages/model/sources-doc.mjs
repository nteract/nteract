import * as A from "@automerge/automerge/slim";
import { validAssetId } from "../shared/image-assets.mjs";
import {
  MAX_SOURCE_NAME,
  MAX_SOURCES,
  SOURCE_ID_PATTERN,
  SOURCE_REVISION_PATTERN,
} from "../shared/sources.mjs";

export { MAX_SOURCE_NAME, MAX_SOURCES };

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
 *       producer: { kind: "upload", principal: string },
 *     }
 *   }
 * }
 * ```
 *
 * A source is a stable id, an editable name and the immutable Page asset it
 * currently names. `current` and `producer` are each replaced as one map
 * value, so a reader never pairs one write's asset with another's media type.
 * Every write is the host's, serialized in the Page's queue, so `revision`
 * moves once per accepted write.
 */

const SOURCE_ID = new RegExp(SOURCE_ID_PATTERN);
const RESERVED = new Set(["constructor", "prototype", "__proto__"]);
const REVISION = new RegExp(SOURCE_REVISION_PATTERN);
const FIELDS = ["op", "source_id", "name", "asset_id", "source_revision"];

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
    typeof producer.principal !== "string"
  )
    fail("invalid_source", "Malformed source record");
  return {
    source_id: id,
    name: entry.name,
    source_revision: entry.revision,
    asset_id: current.asset_id,
    media_type: current.media_type,
    producer: { kind: producer.kind, principal: producer.principal },
  };
}

/** One source, with its producer. A malformed id is invalid_source and an
 * unknown one source_not_found. `doc` may be undefined: a Page with no
 * sources document holds no source. */
export function readSource(doc, sourceId) {
  if (!validSourceId(sourceId)) fail("invalid_source", "Invalid source ID");
  const sources = sourceMap(doc);
  if (!Object.hasOwn(sources, sourceId))
    fail("source_not_found", "No source with this ID on this Page");
  return project(sourceId, sources[sourceId]);
}

/** Every source, ordered by id, without producers. Empty for a Page with no
 * sources document. */
export function listSources(doc) {
  const sources = sourceMap(doc);
  return Object.keys(sources)
    .sort()
    .map((id) => {
      const { producer: _producer, ...source } = project(id, sources[id]);
      return source;
    });
}

/** Refuse a set_source operation with an unknown or malformed field. */
export function validateSourceOperation(op) {
  if (!isMap(op) || op.op !== "set_source") fail("invalid_source", "Not a set_source operation");
  const unknown = Object.keys(op).find((field) => !FIELDS.includes(field));
  if (unknown) fail("invalid_source", `set_source does not take ${String(unknown).slice(0, 64)}`);
  if (!validSourceId(op.source_id))
    fail("invalid_source", `source_id must match ${SOURCE_ID_PATTERN} and not be a reserved name`);
  if (!validName(op.name))
    fail("invalid_source", `name must be 1 to ${MAX_SOURCE_NAME} characters, not only spaces`);
  if (!validAssetId(op.asset_id))
    fail("invalid_source", "asset_id must be a dataset asset uploaded to this Page");
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
    if (ids.has(op.source_id)) fail("invalid_source", "A batch cannot set the same source twice");
    ids.add(op.source_id);
  }
  return [...new Set(operations.map((op) => op.asset_id))];
}

/**
 * Apply a validated batch of set_source operations inside one host change.
 * `mediaTypes` maps each named asset id to the media type its stored record
 * holds; `principal` is the writer. Each operation checks the revision its
 * caller saw (null creates), then mints the next revision. Returns the
 * receipt's per-operation edits.
 */
export function setSources(doc, operations, { mediaTypes, principal }) {
  const previousOf = checkSources(doc, operations);
  if (!isMap(doc.sources)) doc.sources = {};
  const sources = doc.sources;
  return operations.map((op, index) => {
    const id = op.source_id;
    const previous = previousOf[index];
    const mediaType = mediaTypes.get(op.asset_id);
    if (typeof mediaType !== "string") throw Error("A source's asset has no checked media type");
    const revision = String(previous ? Number(previous.source_revision) + 1 : 1);
    const name = op.name.trim();
    const current = { media_type: mediaType, asset_id: op.asset_id };
    const producer = { kind: "upload", principal };
    if (!previous) sources[id] = { name, revision, current, producer };
    else {
      const entry = sources[id];
      if (entry.name !== name) entry.name = name;
      entry.revision = revision;
      if (previous.asset_id !== current.asset_id || previous.media_type !== current.media_type)
        entry.current = current;
      if (
        previous.producer.kind !== producer.kind ||
        previous.producer.principal !== producer.principal
      )
        entry.producer = producer;
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
  const created = operations.filter((op) => !Object.hasOwn(sources, op.source_id)).length;
  if (created && Object.keys(sources).length + created > MAX_SOURCES)
    fail("invalid_source", `A Page holds up to ${MAX_SOURCES} sources`);
  return operations.map((op) => {
    const id = op.source_id;
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
