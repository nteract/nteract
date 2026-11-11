/**
 * Space creation, which the owner's Catalog drives across the Space and its
 * content document, as a pure transition function. Each state is persisted in the Catalog's journal
 * intent before the next effect runs, so a retry or restart resumes from the
 * last committed state. Effects are named here and run by the Catalog.
 *
 * Space creation:
 *
 *   reserved --space_recorded--> space_recorded --content_created-->
 *            content_created --committed--> ready
 *
 * Every effect is idempotent on the intent's Space ID and content document
 * ID, so a
 * lost response repeats the same effect from the same state.
 */
import { defineMachine } from "../shared/machine.mjs";

export const SPACE_CREATION_STATES = Object.freeze([
  "reserved",
  "space_recorded",
  "content_created",
  "ready",
]);
export const SPACE_CREATION_EVENTS = Object.freeze([
  "space_recorded",
  "content_created",
  "committed",
]);

const creation = Object.freeze({
  reserved: { space_recorded: "space_recorded" },
  space_recorded: { content_created: "content_created" },
  content_created: { committed: "ready" },
  ready: {},
});
const creationEffect = Object.freeze({
  reserved: "create_space_record",
  space_recorded: "create_content_document",
  content_created: "commit_catalog",
  ready: null,
});

/** The effect a creation in `state` runs next, or null when it is done. */
export function spaceCreationEffect(state) {
  if (!Object.hasOwn(creationEffect, state)) throw new Error(`Unknown creation state ${state}`);
  return creationEffect[state];
}

/** `(state, event) -> { state, effect }`. An event that does not apply to
 * the state is a programming error, never a silent no-op. */
export function spaceCreationTransition(state, event) {
  const next = creation[state]?.[event];
  if (!next) throw new Error(`Space creation cannot take ${event} in ${state}`);
  return { state: next, effect: creationEffect[next] };
}

/**
 * Space deletion (delete_project confirm), which the owner's Catalog drives
 * across the Space, its content document and its own entries. The state is
 * the `phase` of the Catalog's journal intent. Every step that moves past a
 * remote write persists the new phase before the next effect runs, so a
 * retry with the same key and payload resumes from the last committed phase,
 * and the receipt is recorded only after the Space record is gone.
 *
 *   reserved --closed--> space_closed --trashed--> content_trashed
 *            --purged--> content_deleted --forgotten--> catalog_forgotten
 *            --removed--> deleted
 *
 * - reserved: the intent is stored; the Space is open. `close_space` checks
 *   that the Catalog holds no Page in the Project, reads the content's
 *   current heads, and asks the Space to check the preview token against its
 *   live record and those heads. A valid token closes the Space in the same
 *   step: it records the deletion and answers like a missing Project from
 *   then on. The Space's record revision and ACL are the fence.
 * - space_closed: `trash_content` trashes the content document with the
 *   closed heads as base_heads, so the Page host compares them in the step
 *   that refuses further writes. A newer head means the content changed
 *   after the preview: the Space reopens and the request is refused.
 * - content_trashed: `purge_content` deletes the content and comments
 *   documents through the Page's permanent-deletion path, at the revision
 *   the trash reported.
 * - content_deleted: `forget_catalog` writes the content's deletion
 *   tombstone and removes the Project's Catalog entries.
 * - catalog_forgotten: `remove_space` removes members' discovery hints and
 *   invitation rows, then the Space record.
 * - deleted: the receipt is recorded. released: the request was refused
 *   before anything changed for good; its intent is gone.
 *
 * `resume` runs the effect of a persisted phase. Every other event is the
 * answer of the effect that phase ran.
 */
export const SPACE_DELETION_STATES = Object.freeze([
  "reserved",
  "space_closed",
  "reopening",
  "content_trashed",
  "content_deleted",
  "catalog_forgotten",
  "deleted",
  "released",
]);
export const SPACE_DELETION_EVENTS = Object.freeze([
  "resume",
  "closed",
  "trashed",
  "reopened",
  "purged",
  "forgotten",
  "removed",
]);

/** The effect each persisted phase runs when a request resumes it. */
const RESUME = Object.freeze({
  reserved: "close_space",
  space_closed: "trash_content",
  reopening: "reopen_space",
  content_trashed: "purge_content",
  content_deleted: "forget_catalog",
  catalog_forgotten: "remove_space",
});
/** The one phase that runs the effect each answer belongs to. */
const ANSWERS = Object.freeze({
  closed: "reserved",
  trashed: "space_closed",
  reopened: "reopening",
  purged: "content_trashed",
  forgotten: "content_deleted",
  removed: "catalog_forgotten",
});

const deletionUnreachable = SPACE_DELETION_STATES.flatMap((state) =>
  SPACE_DELETION_EVENTS.flatMap((event) => {
    if (state === "released")
      return [[state, event, "a released intent is deleted, so nothing resumes or answers it"]];
    if (state === "deleted")
      return [[state, event, "a completed deletion replays its receipt before the machine runs"]];
    if (event === "resume" || ANSWERS[event] === state) return [];
    return [[state, event, `only ${ANSWERS[event]} runs the effect that ${event} answers`]];
  }),
);

export const SPACE_DELETION_STATUS = Object.freeze({
  project_not_empty: 409,
  purge_preview_invalid: 409,
});
const refusal = (code, error) => ({
  status: SPACE_DELETION_STATUS[code],
  body: { error, code },
});
export const PROJECT_NOT_EMPTY = refusal(
  "project_not_empty",
  "This Project still holds Pages. Move them out of the Project, or move them to Trash and delete them permanently, before deleting it.",
);
const CHANGED = refusal(
  "purge_preview_invalid",
  "The Project's content changed after its preview; preview the deletion again",
);

const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
const only = (value, keys) => {
  for (const key of Object.keys(value)) check(keys.includes(key), `unexpected field ${key}`);
};
const bare = (value) => only(value, ["type"]);
const named = (value) => only(value, ["name"]);

export const spaceDeletionSpec = Object.freeze({
  name: "space-deletion",
  states: [...SPACE_DELETION_STATES],
  events: [...SPACE_DELETION_EVENTS],
  unreachable: deletionUnreachable,
  cases: {
    "reserved/closed": ["closed", "not-empty", "refused"],
    "space_closed/trashed": ["trashed", "missing", "changed"],
  },
  validate: {
    states: Object.fromEntries(SPACE_DELETION_STATES.map((state) => [state, named])),
    events: {
      resume: bare,
      closed: (event) => {
        only(event, ["type", "ok", "refusal"]);
        check(typeof event.ok === "boolean", "ok says whether the Space closed");
        check(
          event.ok ? event.refusal === undefined : ["not_empty", "space"].includes(event.refusal),
          "a refused close names not_empty or space",
        );
      },
      trashed: (event) => {
        only(event, ["type", "outcome"]);
        check(
          ["trashed", "missing", "changed"].includes(event.outcome),
          "outcome is trashed, missing or changed",
        );
      },
      reopened: bare,
      purged: bare,
      forgotten: bare,
      removed: bare,
    },
    effects: {
      close_space: bare,
      hide_project: bare,
      persist: (effect) => {
        only(effect, ["type", "state"]);
        check(SPACE_DELETION_STATES.includes(effect.state), "persist names a state");
      },
      trash_content: bare,
      reopen_space: bare,
      show_project: bare,
      purge_content: bare,
      forget_catalog: bare,
      remove_space: bare,
      release: bare,
      sync: bare,
    },
  },
});

const effect = (type) => ({ type });
/** Move to `name`, persist it, then run what it runs. */
const advance = (name, ...before) => ({
  state: { name },
  effects: [...before.map(effect), { type: "persist", state: name }, effect(RESUME[name])],
});
const release = (response, ...before) => ({
  state: { name: "released" },
  effects: [...before.map(effect), effect("release")],
  response,
});

function deletionTransition(state, event) {
  switch (event.type) {
    case "resume":
      return { state, effects: [effect(RESUME[state.name])] };
    case "closed":
      if (event.ok) return advance("space_closed", "hide_project");
      // The Space or the content Page refused before anything changed; the
      // interpreter holds that answer.
      return release(event.refusal === "not_empty" ? PROJECT_NOT_EMPTY : { reply: "refusal" });
    case "trashed":
      if (event.outcome === "trashed") return advance("content_trashed");
      // A trash refused for its heads: someone wrote after the preview.
      if (event.outcome === "changed") return advance("reopening");
      // The content is already gone: a purge finished before its phase was
      // persisted.
      return advance("content_deleted");
    case "reopened":
      return release(CHANGED, "show_project");
    case "purged":
      return advance("content_deleted");
    case "forgotten":
      return advance("catalog_forgotten");
    case "removed":
      return {
        state: { name: "deleted" },
        effects: [{ type: "persist", state: "deleted" }, effect("sync")],
        response: { reply: "receipt" },
      };
  }
  throw new Error(`Space deletion cannot take ${event.type}`);
}

export const spaceDeletion = defineMachine({
  ...spaceDeletionSpec,
  initial: { name: "reserved" },
  transition: deletionTransition,
});
