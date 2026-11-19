// The whole reads a module view's parent serves, by exposed file. Each file
// has two shares, one per whole-read kind:
// - "bytes": the whole file, whose size counts toward the view's limit;
// - "columns": the file's ColumnSet, which counts toward no limit.
// A share is none (absent), "reading" or "delivered". The parent serves one
// whole read of each kind per file at a time and delivers each at most once,
// so the sizes of the "bytes" shares bound the bytes the frame holds whole
// for its live files. Each exposed file has its own id, so a late answer for
// a replaced file never touches its successor.
//
// State: a frozen object of file id → {bytes?: {phase, size}, columns?:
// {phase}}. Events:
// - {type: "reserve", file, kind, size, limit}: a whole read asks to start.
//   Refused while that share is reading or delivered, and for "bytes" when
//   the view's shares would pass `limit`; otherwise the share is reading.
// - {type: "delivered", file, kind}: a reading share is delivered.
// - {type: "failed", file, kind}: the read failed or was cancelled, queued or
//   in flight; a reading share goes back to none, so a retry may start.
// - {type: "replaced", file}: the file's name has a new file; both shares go.
// An event for a share in any other phase, or for an unknown file, changes
// nothing. Returns the next state and, for "reserve", null or why it is
// refused.

export const NO_WHOLE_FILES = Object.freeze({});
export const WHOLE_READ_KINDS = Object.freeze(["bytes", "columns"]);

const MIB = 1024 * 1024;

function refusal(state, { file, kind, size, limit }) {
  const share = state[file]?.[kind];
  const what = kind === "bytes" ? "This file is" : "This file's table is";
  if (share?.phase === "reading") return `${what} already being read.`;
  if (share?.phase === "delivered")
    return kind === "bytes"
      ? "This file was already read whole; its file object keeps it."
      : "This file's table was already read; its file object keeps it.";
  if (kind !== "bytes") return null;
  let total = size;
  for (const shares of Object.values(state)) total += shares.bytes?.size ?? 0;
  return total > limit ? `This view's files exceed ${limit / MIB} MiB read whole.` : null;
}

function withShare(state, file, kind, share) {
  const shares = { ...state[file] };
  if (share) shares[kind] = Object.freeze(share);
  else delete shares[kind];
  const next = { ...state };
  if (Object.keys(shares).length) next[file] = Object.freeze(shares);
  else delete next[file];
  return Object.freeze(next);
}

export function wholeFileTransition(state, event) {
  const unchanged = { state, refused: null };
  if (event.type === "replaced") {
    if (!state[event.file]) return unchanged;
    const next = { ...state };
    delete next[event.file];
    return { state: Object.freeze(next), refused: null };
  }
  if (!WHOLE_READ_KINDS.includes(event.kind)) return unchanged;
  const share = state[event.file]?.[event.kind];
  switch (event.type) {
    case "reserve": {
      const refused = refusal(state, event);
      if (refused) return { state, refused };
      const size = event.kind === "bytes" ? event.size : 0;
      return {
        state: withShare(state, event.file, event.kind, { phase: "reading", size }),
        refused: null,
      };
    }
    case "delivered":
      if (share?.phase !== "reading") return unchanged;
      return {
        state: withShare(state, event.file, event.kind, { ...share, phase: "delivered" }),
        refused: null,
      };
    case "failed":
      if (share?.phase !== "reading") return unchanged;
      return { state: withShare(state, event.file, event.kind, null), refused: null };
    default:
      return unchanged;
  }
}

/** The shares of one view's files (effects at the edge of
 * wholeFileTransition): `file(id, size)` gives the {reserve, delivered,
 * failed} callbacks for one exposed file, each taking a kind; `replaced(id)`
 * drops its shares. */
export function createWholeFiles(limit) {
  let state = NO_WHOLE_FILES;
  const apply = (event) => {
    const result = wholeFileTransition(state, event);
    state = result.state;
    return result.refused;
  };
  return {
    get state() {
      return state;
    },
    file: (file, size) => ({
      reserve: (kind) => apply({ type: "reserve", file, kind, size, limit }),
      delivered: (kind) => void apply({ type: "delivered", file, kind }),
      failed: (kind) => void apply({ type: "failed", file, kind }),
    }),
    replaced: (file) => void apply({ type: "replaced", file }),
  };
}
