/**
 * Changing the record storage of a Page's local replica, as a state machine.
 * Two lifecycles share it, since both hold edits while they run and only one
 * can run at a time:
 *
 * - Moving an unregistered draft off plain Automerge storage. A host without
 *   `PAGES_RECORD_STORAGE=automerge` refuses a plain draft's registration
 *   with `409 record_storage_unsupported` and records nothing. The draft
 *   moves to a native replica under the same Page and document IDs and
 *   registers without `record_storage`. Every step that can be interrupted is
 *   its own state, and the plain replica stays on disk until the local record
 *   names the native one, so a crash or close at any point leaves a draft
 *   that reopens and repeats the move.
 * - Adopting the host's storage for any Page, registered or not, in either
 *   direction. Discovery names plain or native storage, and the open replica
 *   is in the other one. Its history can't switch live, so its checkpoint is
 *   recorded under the host's storage and the reload restores it there.
 *
 * States:
 * - idle: no switch is running. Edits follow the session's other pauses.
 * - stripping: the replica is already native (another tab wrote the plain
 *   registration back over this one's); the registration loses
 *   `record_storage` and its retry authority.
 * - checkpointing: edits are paused and the plain draft's checkpoint is
 *   being written, so it holds every edit made before the pause.
 * - moving: the plain replica is closed (its database kept) and the native
 *   one opens, imports the draft and flushes it to disk.
 * - recording: the local record is being rewritten to name native storage
 *   and the native registration. `database` is the plain replica's, deleted
 *   once the record lands.
 * - failed: opening or recording the native replica failed. Edits stay
 *   paused; a reload reopens the plain draft and moves it again.
 * - adopting: discovery named other storage than the open replica's (a
 *   stale tab wrote the wrong mode, or the host's answer changed). Edits are
 *   paused and the live checkpoint is being recorded under the host's
 *   storage.
 * - adopted: that checkpoint is recorded and final. Edits stay paused: the
 *   reload restores the checkpoint into a replica of the host's storage, and
 *   an edit after it would reach only this replica.
 * - closed: the session closed, or its local copy retired (deleted,
 *   revoked, or replaced by another grant) during a step. Late completions
 *   are ignored.
 *
 * Events:
 * - refused: the host refused the registration's storage. `storage` is the
 *   replica's current storage.
 * - mismatched: discovery named `storage`, which isn't the open replica's.
 * - stripped / checkpointed / moved / recorded / adopted: that step
 *   finished. `moved` names the plain replica's database.
 * - failed: the running step failed.
 * - retired: the running step found the local copy deleted, revoked or
 *   replaced; the session retires it, and edits stay held.
 * - close: the session closed.
 *
 * Effects:
 * - strip, checkpoint, move, record, adopt: run that step, then send its
 *   event. `adopt` records the checkpoint under `storage`.
 * - pause / resume: hold or release edits while the switch runs.
 * - deletePlain: delete the plain replica's database.
 * - reloadRequired: tell the person to reload to keep editing.
 */
import { defineMachine, reject } from "../shared/machine.mjs";

const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
const only = (value, keys) => {
  for (const key of Object.keys(value)) check(keys.includes(key), `unexpected field ${key}`);
};
const database = (value) =>
  check(typeof value.database === "string" && value.database !== "", "database is required");
const storage = (value) =>
  check(["automerge", "native"].includes(value.storage), "storage is automerge or native");
const shape =
  (head, keys, ...checks) =>
  (value) => {
    only(value, [head, ...keys]);
    for (const fn of checks) fn(value);
  };
const bare = (head) => shape(head, []);

export const STORAGE_SWITCH_STATES = Object.freeze([
  "idle",
  "stripping",
  "checkpointing",
  "moving",
  "recording",
  "failed",
  "adopting",
  "adopted",
  "closed",
]);

export const storageSwitchSpec = Object.freeze({
  name: "storage-switch",
  states: [...STORAGE_SWITCH_STATES],
  events: [
    "refused",
    "mismatched",
    "stripped",
    "checkpointed",
    "moved",
    "recorded",
    "adopted",
    "failed",
    "retired",
    "close",
  ],
  cases: {
    "idle/refused": ["automerge", "native"],
  },
  validate: {
    states: {
      idle: bare("name"),
      stripping: bare("name"),
      checkpointing: bare("name"),
      moving: bare("name"),
      recording: shape("name", ["database"], database),
      failed: bare("name"),
      adopting: bare("name"),
      adopted: bare("name"),
      closed: bare("name"),
    },
    events: {
      refused: shape("type", ["storage"], storage),
      mismatched: shape("type", ["storage"], storage),
      stripped: bare("type"),
      checkpointed: bare("type"),
      moved: shape("type", ["database"], database),
      recorded: bare("type"),
      adopted: bare("type"),
      failed: bare("type"),
      retired: bare("type"),
      close: bare("type"),
    },
    effects: {
      strip: bare("type"),
      checkpoint: bare("type"),
      move: bare("type"),
      record: bare("type"),
      adopt: shape("type", ["storage"], storage),
      pause: bare("type"),
      resume: bare("type"),
      deletePlain: shape("type", ["database"], database),
      reloadRequired: bare("type"),
    },
  },
});

export const REJECT = Object.freeze({
  busy: "The replica is already switching storage",
  failed: "The move failed; reload to retry it",
  adopted: "The host's storage is recorded; reload to open it",
  closed: "The session closed",
  stale: "That step isn't running",
});

const ok = (state, effects = []) => ({ state, effects });
/** The step each working state runs, and the event that finishes it. */
const DONE = Object.freeze({
  stripping: "stripped",
  checkpointing: "checkpointed",
  moving: "moved",
  recording: "recorded",
  adopting: "adopted",
});

function transition(state, event) {
  if (state.name === "closed") return reject(state, REJECT.closed);
  switch (event.type) {
    case "refused":
    case "mismatched":
      if (state.name === "failed") return reject(state, REJECT.failed);
      if (state.name === "adopted") return reject(state, REJECT.adopted);
      if (state.name !== "idle") return reject(state, REJECT.busy);
      // Pause first: the checkpoint the reload restores is then final.
      if (event.type === "mismatched")
        return ok({ name: "adopting" }, [
          { type: "pause" },
          { type: "adopt", storage: event.storage },
        ]);
      if (event.storage === "native") return ok({ name: "stripping" }, [{ type: "strip" }]);
      // Pause first: the checkpoint then holds every edit there will be.
      return ok({ name: "checkpointing" }, [{ type: "pause" }, { type: "checkpoint" }]);
    case "stripped":
    case "checkpointed":
    case "moved":
    case "recorded":
    case "adopted":
      if (DONE[state.name] !== event.type) return reject(state, REJECT.stale);
      if (state.name === "stripping") return ok({ name: "idle" });
      if (state.name === "adopting") return ok({ name: "adopted" });
      if (state.name === "checkpointing") return ok({ name: "moving" }, [{ type: "move" }]);
      if (state.name === "moving")
        return ok({ name: "recording", database: event.database }, [{ type: "record" }]);
      // The record names native storage: the plain replica can go.
      return ok({ name: "idle" }, [
        { type: "resume" },
        { type: "deletePlain", database: state.database },
      ]);
    case "failed":
      if (!(state.name in DONE)) return reject(state, REJECT.stale);
      if (state.name === "stripping") return ok({ name: "idle" });
      // Nothing moved or was recorded: the replica is as it was.
      if (state.name === "checkpointing" || state.name === "adopting")
        return ok({ name: "idle" }, [{ type: "resume" }]);
      // The plain replica is closed, and the record may still name it.
      return ok({ name: "failed" }, [{ type: "reloadRequired" }]);
    case "retired":
      if (!(state.name in DONE)) return reject(state, REJECT.stale);
      return ok({ name: "closed" });
    case "close":
      return ok({ name: "closed" });
  }
  throw new Error(`unknown event ${event.type}`);
}

export const storageSwitchMachine = defineMachine({
  ...storageSwitchSpec,
  initial: { name: "idle" },
  transition,
});
