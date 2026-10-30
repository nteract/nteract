import { defineAlphabet } from "../shared/machine.mjs";

/**
 * The Page host's lifecycle: creation, Trash, restore and permanent deletion.
 *
 * States describe the installed record and the memory-only commit phase:
 *
 * - missing: no record and no creation intent.
 * - creating: a creation intent (`host/creation`) and no installed record.
 * - active, trashed: a settled record at `revision` (`lifecycleRevision`).
 * - trashing, restoring, purging: a transition whose commit sequence started
 *   and has not finished. `revision` is the target record's. The phase lives
 *   only in memory (`pendingLifecycle`), so a restart forgets it and boots from
 *   whatever record is durable.
 * - deleting: a durable deleted record whose deletion barriers have not run in
 *   this process. A purge request runs them.
 * - deleted: the barriers finished in this process, or the record predates
 *   deletion receipts.
 *
 * `placement` summarizes a placed record: `nested` when it has a parent, its
 * `placement_epoch`, and `home` for a Space's home Page. `intent` marks a
 * creation intent left beside an installed record.
 *
 * Events are requests (trash, restore, purgePreview, purgeConfirm), the
 * owner Catalog's tombstone, and `boot` (a cold start over durable storage).
 * `commitOk` requests another settlement attempt; `commitFailed` reports its
 * failure. Request events carry what the host observed: who asked (`actor`), whether the
 * idempotency key has a receipt (`key`, with its summary in `recorded`),
 * whether `base_heads` match, the Catalog's `expected` revision and
 * `replayOnly` flag, the preview token's check, and the restore position the
 * Catalog chose. `children` is the owner Catalog's leaf check, which runs
 * before it forwards a trash.
 */
export const PAGE_LIFECYCLE_STATES = Object.freeze([
  "missing",
  "creating",
  "active",
  "trashing",
  "trashed",
  "restoring",
  "purging",
  "deleting",
  "deleted",
]);
export const PAGE_LIFECYCLE_EVENTS = Object.freeze([
  "trash",
  "restore",
  "purgePreview",
  "purgeConfirm",
  "commitOk",
  "commitFailed",
  "tombstone",
  "boot",
]);

const PENDING = ["trashing", "restoring", "purging"];
const SETTLED = ["missing", "creating", "active", "trashed", "deleting", "deleted"];
const REQUESTS = ["trash", "restore", "purgePreview", "purgeConfirm"];

const unreachable = [
  ...SETTLED.flatMap((state) =>
    ["commitOk", "commitFailed"].map((event) => [
      state,
      event,
      "only a pending commit settles; deleting finishes through a purge request",
    ]),
  ),
  ...PENDING.flatMap((state) =>
    REQUESTS.map((event) => [
      state,
      event,
      "the host settles a pending commit before it handles a request: commitOk, then the request",
    ]),
  ),
];

const cases = {
  "active/trash": [
    "owner",
    "non-owner",
    "heads-mismatch",
    "stale-revision",
    "has-children",
    "home",
    "recorded",
    "key-conflict",
  ],
  "active/restore": ["noop", "non-owner", "stale-revision", "recorded"],
  "active/purgePreview": ["owner", "non-owner"],
  "active/boot": ["record", "leftover-intent"],
  "trashed/trash": ["owner", "non-owner", "stranger", "recorded", "stale-revision"],
  "trashed/restore": [
    "keep-place",
    "top-level",
    "non-owner",
    "stale-revision",
    "replay-only",
    "recorded",
  ],
  "trashed/purgePreview": ["owner", "non-owner"],
  "trashed/purgeConfirm": [
    "preview-valid",
    "preview-changed",
    "preview-expired",
    "non-owner",
    "stale-revision",
  ],
  "trashing/boot": ["unwritten", "written"],
  "restoring/boot": ["unwritten", "written"],
  "purging/boot": ["unwritten", "written"],
  "deleting/purgeConfirm": ["fresh", "recorded"],
};

function fields(value, allowed, label) {
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) throw new Error(`${label} has unknown field ${key}`);
}
const oneOf = (value, options, label) => {
  if (!options.includes(value)) throw new Error(`${label} must be one of ${options.join(", ")}`);
};
const count = (value, label) => {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`${label} must be a non-negative integer`);
};
const flag = (value, label) => {
  if (value !== undefined && value !== true) throw new Error(`${label} is true or absent`);
};

function placement(value) {
  if (value === undefined) return;
  fields(value, ["nested", "epoch", "home"], "placement");
  if (typeof value.nested !== "boolean") throw new Error("placement.nested must be a boolean");
  count(value.epoch, "placement.epoch");
  flag(value.home, "placement.home");
}

const bare = (state) => fields(state, ["name"], state.name);
const placed = (state) => {
  fields(state, ["name", "revision", "placement", "intent"], state.name);
  count(state.revision, "revision");
  placement(state.placement);
  flag(state.intent, "intent");
};
const unplaced = (state) => {
  fields(state, ["name", "revision", "intent"], state.name);
  count(state.revision, "revision");
  flag(state.intent, "intent");
};

/** A durable record as `boot` reads it. */
function recordSummary(value, label) {
  if (value === null) return;
  if (!value || typeof value !== "object") throw new Error(`${label} must be an object or null`);
  fields(value, ["state", "revision", "placement", "deletion"], label);
  oneOf(value.state, ["active", "trashed", "deleted"], `${label}.state`);
  count(value.revision, `${label}.revision`);
  placement(value.placement);
  flag(value.deletion, `${label}.deletion`);
}

/** A receipt as a response or a `recorded` field shows it. */
function receiptSummary(value, label) {
  if (!value || typeof value !== "object") throw new Error(`${label} must be an object`);
  fields(value, ["state", "restored", "deleted", "purged", "superseded"], label);
}

const ACTORS = ["owner", "member", "stranger"];
function request(allowed) {
  return (event) => {
    fields(event, ["type", "actor", "readOnly", ...allowed], event.type);
    oneOf(event.actor, ACTORS, "actor");
    flag(event.readOnly, "readOnly");
    if (allowed.includes("key")) {
      oneOf(event.key, ["fresh", "recorded", "conflict"], "key");
      if ((event.key === "recorded") !== "recorded" in event)
        throw new Error("recorded is present exactly when key is recorded");
      if ("recorded" in event) receiptSummary(event.recorded, "recorded");
    }
    if ("expected" in event) count(event.expected, "expected");
    flag(event.replayOnly, "replayOnly");
    if (allowed.includes("heads")) oneOf(event.heads, ["match", "mismatch", "invalid"], "heads");
    flag(event.children, "children");
    if ("position" in event) oneOf(event.position, ["top-level"], "position");
    if (allowed.includes("preview"))
      oneOf(event.preview, ["valid", "changed", "expired", "invalid"], "preview");
  };
}
const nothing = (event) => fields(event, ["type"], event.type);
const effect =
  (allowed = []) =>
  (value) =>
    fields(value, ["type", ...allowed], value.type);

export const pageLifecycleSpec = {
  name: "page-lifecycle",
  states: [...PAGE_LIFECYCLE_STATES],
  events: [...PAGE_LIFECYCLE_EVENTS],
  unreachable,
  cases,
  validate: {
    states: {
      missing: bare,
      creating: bare,
      active: placed,
      trashed: placed,
      trashing: placed,
      restoring: placed,
      purging: unplaced,
      deleting: unplaced,
      deleted: unplaced,
    },
    events: {
      trash: request(["key", "recorded", "heads", "expected", "replayOnly", "children"]),
      restore: request(["key", "recorded", "expected", "replayOnly", "position"]),
      purgePreview: request([]),
      purgeConfirm: request(["key", "recorded", "expected", "replayOnly", "preview"]),
      commitOk: nothing,
      commitFailed: nothing,
      tombstone: nothing,
      boot: (event) => {
        fields(event, ["type", "record", "creation"], "boot");
        recordSummary(event.record, "record");
        recordSummary(event.creation, "creation");
      },
    },
    effects: {
      // Record a commit phase; settling repeats the sequence that follows.
      begin: (value) => {
        effect(["phase", "revision"])(value);
        oneOf(value.phase, PENDING, "phase");
        count(value.revision, "revision");
      },
      // Install a more restrictive record in memory before it is durable.
      withdrawAccess: (value) => {
        effect(["record"])(value);
        oneOf(value.record, ["trashed", "deleted"], "record");
      },
      // Pre-commit removal of non-owner catalog index rows.
      restrictIndex: effect(),
      // One multi-key write: this request's receipt and/or the record.
      putRecord: (value) => {
        effect(["receipt", "record"])(value);
        if (typeof value.receipt !== "boolean" || typeof value.record !== "boolean")
          throw new Error("putRecord names receipt and record");
      },
      sync: effect(),
      // Install the committed record in memory, after its barrier.
      install: effect(),
      refreshAccess: effect(),
      projectTitle: effect(),
      retireIndex: effect(),
      closePolicy: effect(),
      deleteDocument: effect(),
      flush: effect(),
      finishDeletion: effect(),
      dropDocument: effect(),
      loadDocument: effect(),
      importDocument: effect(),
      deleteCreation: effect(),
      end: effect(),
    },
  },
};

export const pageLifecycleAlphabet = defineAlphabet(pageLifecycleSpec);
