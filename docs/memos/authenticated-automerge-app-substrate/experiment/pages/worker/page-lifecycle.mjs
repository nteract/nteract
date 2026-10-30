import { defineMachine, reject } from "../shared/machine.mjs";
import { pageState } from "./access.mjs";

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
 * - deleting: a deleted record whose deletion barriers have not run in this
 *   process. A purge request runs them; a tombstone repeats its own write.
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
 * failure. Request events carry what the host observed: who asked
 * (`actor`), whether the idempotency key has a receipt (`key`, with its
 * summary in `recorded`), whether `base_heads` match, the Catalog's
 * `expected` revision and `replayOnly` flag, the preview token's check, the
 * restore position the Catalog chose, and a deleted record's `deletion`
 * receipt. `children` is the owner Catalog's leaf check, which runs before it
 * forwards a trash.
 *
 * The transition decides; the Page host interprets. Each effect names one
 * step the host performs in order. A commit sequence starts with `begin` and
 * ends with `end`; if a step between them fails, the phase stays and the
 * host repeats the sequence (commitOk) before it handles anything else.
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
    [...REQUESTS, "tombstone"].map((event) => [
      state,
      event,
      "the host settles a pending commit before it handles a request or a tombstone: commitOk, then the event",
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
    fields(event, ["type", "actor", ...allowed], event.type);
    oneOf(event.actor, ACTORS, "actor");
    // A request the host refuses before reading its body has no key or heads.
    if ("key" in event) oneOf(event.key, ["fresh", "recorded", "conflict"], "key");
    if ((event.key === "recorded") !== "recorded" in event)
      throw new Error("recorded is present exactly when key is recorded");
    if ("recorded" in event) receiptSummary(event.recorded, "recorded");
    if ("expected" in event) count(event.expected, "expected");
    flag(event.replayOnly, "replayOnly");
    if ("heads" in event) oneOf(event.heads, ["match", "mismatch", "invalid"], "heads");
    flag(event.children, "children");
    if ("position" in event) oneOf(event.position, ["top-level"], "position");
    // The host checks a preview token only where the transition reads it.
    if ("preview" in event)
      oneOf(event.preview, ["valid", "changed", "expired", "invalid"], "preview");
    if ("deletion" in event) receiptSummary(event.deletion, "deletion");
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
      purgeConfirm: request(["key", "recorded", "expected", "replayOnly", "preview", "deletion"]),
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

// ---------------------------------------------------------------------------
// Transition

const NOT_FOUND = { status: 404, error: "Page not found" };
/** A refusal before the record changes. The Catalog may release its slot. */
const refused = (status, error, code) => ({
  status,
  error,
  ...(code && { code }),
  beforeChange: true,
});
const NOT_OWNER = refused(403, "Document access denied");
const KEY_CONFLICT = refused(409, "idempotency_key was used for a different request");
const HOME_PAGE = refused(
  409,
  "A Space's home Page stays with its Space; it can't move to Trash on its own",
  "home_page_protected",
);
const HEADS_INVALID = refused(400, "base_heads from read_page are required");
const HEADS_CHANGED = refused(409, "Page changed; read_page again before editing");
const NOT_IN_TRASH = refused(
  409,
  "Move this Page to Trash with delete_page before deleting it permanently",
  "page_not_in_trash",
);
const PREVIEW_REFUSED = {
  invalid: refused(
    409,
    "Invalid preview_token; preview the permanent deletion again",
    "purge_preview_invalid",
  ),
  expired: refused(
    409,
    "preview_token expired; preview the permanent deletion again",
    "purge_preview_invalid",
  ),
  changed: refused(
    409,
    "The Page changed after its preview; preview the permanent deletion again",
    "purge_preview_invalid",
  ),
};
// The owner's Catalog answers this before it forwards a trash.
const HAS_CHILDREN = {
  status: 409,
  error: "This Page has sub-pages. Trash its sub-pages first; subtree Trash is not available yet.",
  code: "page_has_children",
};
const SETTLING = { status: 503, error: "Page lifecycle is settling" };

const effectOf = (type, fields = {}) => ({ type, ...fields });
const put = (receipt, record) => effectOf("putRecord", { receipt, record });

/** Trash: restrict listings, commit record and receipt, then refresh access. */
const TRASH_COMMIT = [
  effectOf("restrictIndex"),
  put(true, true),
  effectOf("sync"),
  effectOf("refreshAccess"),
  effectOf("retireIndex"),
  effectOf("end"),
];
/** Restore: nothing is granted until the record is durable and installed. */
const RESTORE_COMMIT = [
  put(true, true),
  effectOf("sync"),
  effectOf("install"),
  effectOf("refreshAccess"),
  effectOf("projectTitle"),
  effectOf("end"),
];
/** Permanent deletion barriers. A purge commits its receipt with the record;
 * a retry after restart rewrites only the record. The deleted record is
 * durable before document storage goes, so a lost write never leaves a
 * trashed record without its document. */
const deletionBarriers = (receipt) => [
  effectOf("restrictIndex"),
  put(receipt, true),
  effectOf("sync"),
  effectOf("closePolicy"),
  effectOf("deleteDocument"),
  effectOf("flush"),
  effectOf("sync"),
  effectOf("retireIndex"),
  effectOf("finishDeletion"),
];
const PURGE_COMMIT = [...deletionBarriers(true), effectOf("end")];
/** Record an earlier build's deletion and make it durable. A record whose
 * barrier may not have finished repeats the write on the next tombstone. */
const TOMBSTONE_BARRIER = [put(false, true), effectOf("sync"), effectOf("retireIndex")];
const TOMBSTONE = [
  effectOf("withdrawAccess", { record: "deleted" }),
  effectOf("dropDocument"),
  ...TOMBSTONE_BARRIER,
];
/** Install a recorded creation: import its bytes, then persist its record. */
export const CREATION_COMMIT = Object.freeze([
  effectOf("importDocument"),
  effectOf("install"),
  put(false, true),
  effectOf("flush"),
  effectOf("sync"),
  effectOf("deleteCreation"),
  effectOf("sync"),
]);
/** A creation intent left beside an installed record. The record wins: later
 * Trash, restores and ACL changes stay. The recorded bytes are imported again
 * in case the first flush failed, the installed record is rewritten in case
 * its put did, and the intent is dropped. */
export const CREATION_REPLAY = Object.freeze([
  effectOf("importDocument"),
  put(false, true),
  effectOf("flush"),
  effectOf("sync"),
  effectOf("deleteCreation"),
  effectOf("sync"),
]);

const DELETED = new Set(["deleting", "deleted"]);
const PUBLIC_STATE = {
  active: "active",
  trashed: "trashed",
  trashing: "trashed",
  restoring: "active",
  purging: "deleted",
  deleting: "deleted",
  deleted: "deleted",
};
/** Carry the creation-intent marker; only boot clears it. */
const keep = (state, next) => (state.intent ? { ...next, intent: true } : next);
const withPlacement = (placement) => (placement ? { placement } : {});
const current = (state) => ({ state: PUBLIC_STATE[state.name], revision: state.revision });
const receiptReply = (reply, receipt, state) => ({
  status: 200,
  reply,
  receipt,
  current: current(state),
});
const supersededReply = (state) =>
  receiptReply("superseded", { superseded: true, state: PUBLIC_STATE[state.name] }, state);

/** The Catalog reserved the request at another revision, or could not hold
 * its slot on resume. The Page reports its current state instead. */
export const isSuperseded = (state, event) =>
  event.replayOnly === true || (event.expected !== undefined && event.expected !== state.revision);

/** Who may act on a record at all, before the request's own guards. */
function admit(state, event) {
  if (state.name === "missing" || state.name === "creating")
    return reject(state, "page_not_found", { response: NOT_FOUND });
  // Only the owner and current members learn that a trashed Page exists.
  if (state.name === "trashed" && event.actor === "stranger")
    return reject(state, "page_not_found", { response: NOT_FOUND });
  if (event.actor !== "owner") return reject(state, "not_owner", { response: NOT_OWNER });
  if (event.key === "conflict")
    return reject(state, "idempotency_conflict", { response: KEY_CONFLICT });
  return undefined;
}

/** Shared head of trash and restore: replay, deletion, the revision fence. */
function settledRequest(state, event) {
  const refusal = admit(state, event);
  if (refusal) return refusal;
  if (event.key === "recorded")
    return reject(state, "replayed", { response: receiptReply("recorded", event.recorded, state) });
  if (DELETED.has(state.name)) return reject(state, "page_not_found", { response: NOT_FOUND });
  if (isSuperseded(state, event))
    return reject(state, "superseded", { response: supersededReply(state) });
  return undefined;
}

function trash(state, event) {
  if (event.children) return reject(state, "page_has_children", { response: HAS_CHILDREN });
  const refusal = settledRequest(state, event);
  if (refusal) return refusal;
  const trashed = { state: "trashed" };
  // A new key on a trashed Page records a receipt for the original trash,
  // as a new key on an active Page does for restore.
  if (state.name === "trashed")
    return {
      state,
      effects: [put(true, false), effectOf("sync")],
      response: receiptReply("receipt", trashed, state),
    };
  if (state.placement?.home) return reject(state, "home_page_protected", { response: HOME_PAGE });
  if (event.heads === "mismatch")
    return reject(state, "heads_mismatch", { response: HEADS_CHANGED });
  if (event.heads !== "match") return reject(state, "heads_invalid", { response: HEADS_INVALID });
  const next = keep(state, {
    name: "trashed",
    revision: state.revision + 1,
    ...withPlacement(state.placement),
  });
  return {
    state: next,
    effects: [
      effectOf("withdrawAccess", { record: "trashed" }),
      effectOf("begin", { phase: "trashing", revision: next.revision }),
      ...TRASH_COMMIT,
    ],
    response: receiptReply("receipt", trashed, next),
  };
}

function restore(state, event) {
  const refusal = settledRequest(state, event);
  if (refusal) return refusal;
  if (state.name === "active")
    return {
      state,
      effects: [put(true, false), effectOf("sync")],
      response: receiptReply("receipt", { state: "active", restored: false }, state),
    };
  // The Catalog supplies a position when the parent is gone: the Page returns
  // to the top level of its Space under a new placement epoch.
  const placement =
    state.placement && event.position === "top-level"
      ? { ...state.placement, nested: false, epoch: state.placement.epoch + 1 }
      : state.placement;
  const next = keep(state, {
    name: "active",
    revision: state.revision + 1,
    ...withPlacement(placement),
  });
  return {
    state: next,
    effects: [
      effectOf("begin", { phase: "restoring", revision: next.revision }),
      ...RESTORE_COMMIT,
    ],
    response: receiptReply("receipt", { state: "active", restored: true }, next),
  };
}

function purgePreview(state, event) {
  const refusal = admit(state, event);
  if (refusal) return refusal;
  if (DELETED.has(state.name)) return reject(state, "page_not_found", { response: NOT_FOUND });
  if (state.name !== "trashed")
    return reject(state, "page_not_in_trash", { response: NOT_IN_TRASH });
  return { state, effects: [], response: { status: 200, reply: "preview" } };
}

function purgeConfirm(state, event) {
  const refusal = admit(state, event);
  if (refusal) return refusal;
  const recorded = event.key === "recorded";
  // Barriers finished in this process: any key replays the deletion receipt.
  if (state.name === "deleted" && event.deletion)
    return reject(state, "replayed", {
      response: recorded
        ? receiptReply("recorded", event.recorded, state)
        : receiptReply("deletion", event.deletion, state),
    });
  if (state.name === "deleting" && (recorded || event.deletion)) {
    // After a restart a durable purge may still own document storage.
    const next = keep(state, { name: "deleted", revision: state.revision });
    return {
      state: next,
      effects: deletionBarriers(false),
      response: recorded
        ? receiptReply("recorded", event.recorded, next)
        : receiptReply("deletion", event.deletion, next),
    };
  }
  if (recorded)
    return reject(state, "replayed", { response: receiptReply("recorded", event.recorded, state) });
  if (DELETED.has(state.name)) return reject(state, "page_not_found", { response: NOT_FOUND });
  if (state.name !== "trashed")
    return reject(state, "page_not_in_trash", { response: NOT_IN_TRASH });
  if (isSuperseded(state, event))
    return reject(state, "superseded", { response: supersededReply(state) });
  if (!event.preview) throw new Error("purgeConfirm reached the preview check without a result");
  if (event.preview !== "valid")
    return reject(state, "purge_preview_invalid", { response: PREVIEW_REFUSED[event.preview] });
  const next = keep(state, { name: "deleted", revision: state.revision + 1 });
  return {
    state: next,
    effects: [
      effectOf("withdrawAccess", { record: "deleted" }),
      effectOf("begin", { phase: "purging", revision: next.revision }),
      ...PURGE_COMMIT,
    ],
    response: receiptReply("receipt", { deleted: true, purged: true }, next),
  };
}

/** The owner's Catalog holds a permanent-deletion tombstone: a build without
 * Trash deleted the document but left a trashed record. */
function tombstone(state) {
  const answer = (name) => ({ status: 200, reply: "state", state: name });
  switch (state.name) {
    case "missing":
    case "creating":
      return reject(state, "not_trashed", { response: answer("missing") });
    case "active":
      return reject(state, "not_trashed", { response: answer("active") });
    case "trashed":
      return {
        state: keep(state, { name: "deleting", revision: state.revision + 1 }),
        effects: TOMBSTONE,
        response: answer("deleted"),
      };
    // The deleted record may be in memory only: an earlier tombstone's write
    // or sync can have failed. Repeat it, then answer.
    case "deleting":
      return { state, effects: TOMBSTONE_BARRIER, response: answer("deleted") };
    default:
      return reject(state, "not_trashed", { response: answer("deleted") });
  }
}

/** A cold start. The commit phase lived only in memory, so the durable record
 * and any creation intent decide the state. */
function boot(_state, event) {
  const { record, creation } = event;
  if (creation && !record)
    return {
      state: { name: "active", revision: creation.revision, ...withPlacement(creation.placement) },
      effects: [...CREATION_COMMIT],
    };
  if (creation && record.state === "active")
    return {
      state: { name: "active", revision: record.revision, ...withPlacement(record.placement) },
      effects: [...CREATION_REPLAY, effectOf("loadDocument")],
    };
  if (!record) return { state: { name: "missing" }, effects: [] };
  // A completed deletion or Trash keeps an earlier interrupted creation's
  // intent, and never imports it.
  const intent = creation ? { intent: true } : {};
  if (record.state === "deleted")
    return {
      state: {
        name: record.deletion ? "deleting" : "deleted",
        revision: record.revision,
        ...intent,
      },
      effects: [],
    };
  // Trashed Pages keep their document for owner preview and restore.
  return {
    state: {
      name: record.state,
      revision: record.revision,
      ...withPlacement(record.placement),
      ...intent,
    },
    effects: [effectOf("loadDocument")],
  };
}

const SETTLES_TO = {
  trashing: (state) => ({ name: "trashed", effects: TRASH_COMMIT, placement: state.placement }),
  restoring: (state) => ({ name: "active", effects: RESTORE_COMMIT, placement: state.placement }),
  purging: () => ({ name: "deleted", effects: PURGE_COMMIT }),
};

/** Repeat the pending commit sequence from its first step. */
function commitOk(state) {
  const { name, effects, placement } = SETTLES_TO[state.name](state);
  const next = keep(state, { name, revision: state.revision, ...withPlacement(placement) });
  return {
    state: next,
    effects,
    response: { status: 200, reply: "current", current: current(next) },
  };
}

/** The repeated sequence failed; the phase stays for the next request. */
const commitFailed = (state) => ({ state, effects: [], response: SETTLING });

const transitions = {
  trash,
  restore,
  purgePreview,
  purgeConfirm,
  tombstone,
  boot,
  commitOk,
  commitFailed,
};

export const pageLifecycle = defineMachine({
  ...pageLifecycleSpec,
  initial: { name: "missing" },
  transition: (state, event) => transitions[event.type](state, event),
});

// ---------------------------------------------------------------------------
// Reading a host

/** The commit phase each `pendingLifecycle.operation` records. */
export const LIFECYCLE_PHASES = Object.freeze({
  trash_page: "trashing",
  restore_page: "restoring",
  purge_page: "purging",
});

/** A record's placement as lifecycle states summarize it. */
export function placementOf(metadata) {
  const placement = metadata?.placement;
  if (!placement) return {};
  return {
    placement: {
      nested: placement.parent_id !== null && placement.parent_id !== undefined,
      epoch: placement.placement_epoch ?? 0,
      ...(placement.home && { home: true }),
    },
  };
}

/** A durable record as `boot` reads it. */
export function recordOf(metadata) {
  if (!metadata) return null;
  const state = pageState(metadata);
  return {
    state,
    revision: metadata.lifecycleRevision ?? 0,
    ...placementOf(metadata),
    ...(state === "deleted" && metadata.deletion && { deletion: true }),
  };
}

/** A host's lifecycle state from its installed record, its memory-only
 * `pendingLifecycle` and its `deletionFinished` flag. Without a record, a
 * creation intent changes nothing a request or tombstone sees; only boot
 * reads `host/creation`, so this reports missing. */
export function hostState({ metadata, pending, deletionFinished }) {
  if (!metadata) return { name: "missing" };
  if (pending) {
    const name = LIFECYCLE_PHASES[pending.operation];
    return {
      name,
      revision: pending.record.revision,
      ...(name !== "purging" && placementOf(pending.metadata ?? metadata)),
    };
  }
  const state = pageState(metadata);
  const revision = metadata.lifecycleRevision ?? 0;
  if (state === "deleted")
    return { name: deletionFinished || !metadata.deletion ? "deleted" : "deleting", revision };
  return { name: state, revision, ...placementOf(metadata) };
}

const INTENT_FIELDS = [
  "lifecycleRevision",
  "acl",
  "deleted",
  "trash",
  "purged",
  "deletion",
  "placement",
];
const canonical = (value) => {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
    .join(",")}}`;
};

/** The revision, ACL and lifecycle fields where a creation intent disagrees
 * with the installed record. Names only, never values. */
export function creationIntentConflict(intent, installed) {
  return INTENT_FIELDS.filter((field) => {
    const value = (record) =>
      field === "lifecycleRevision" ? (record?.[field] ?? 0) : record?.[field];
    return canonical(value(intent)) !== canonical(value(installed));
  });
}

/** A receipt as page-lifecycle events and responses summarize it. */
export function summarizeReceipt(receipt) {
  if (receipt.superseded) return { superseded: true, state: receipt.state };
  if (receipt.deleted) return { deleted: true, ...(receipt.purged && { purged: true }) };
  if (receipt.state === "trashed") return { state: "trashed" };
  return { state: receipt.state, restored: receipt.restored === true };
}
