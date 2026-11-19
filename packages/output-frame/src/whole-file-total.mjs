// The whole-file bytes a module view's frame holds, by bound file. A file's
// whole-file read takes its size as that file's share; a read that would
// take the view past `limit` is refused. A share is kept once delivered and
// given back when its read fails without one, or when the file's data name
// gets a new file. Each bound file has its own id, so a late answer for a
// replaced file never touches its successor's share.
//
// State: a frozen object of file id → {size, delivered}. Events:
// - {type: "reserve", file, size, limit}: a whole-file read starts. A file
//   that holds a share keeps it and is accepted.
// - {type: "delivered", file}: its read succeeded.
// - {type: "failed", file}: its read failed; an undelivered share goes back.
// - {type: "replaced", file}: its name has a new file; its share goes back.
// Returns the next state and, for "reserve", null or why it is refused.

export const NO_WHOLE_FILES = Object.freeze({});

export function wholeFileTransition(state, event) {
  const held = state[event.file];
  switch (event.type) {
    case "reserve": {
      if (held) return { state, refused: null };
      let total = event.size;
      for (const share of Object.values(state)) total += share.size;
      if (total > event.limit)
        return {
          state,
          refused: `This view's files exceed ${event.limit / (1024 * 1024)} MiB read whole.`,
        };
      return {
        state: Object.freeze({
          ...state,
          [event.file]: Object.freeze({ size: event.size, delivered: false }),
        }),
        refused: null,
      };
    }
    case "delivered":
      if (!held || held.delivered) return { state, refused: null };
      return {
        state: Object.freeze({
          ...state,
          [event.file]: Object.freeze({ ...held, delivered: true }),
        }),
        refused: null,
      };
    case "failed":
      if (!held || held.delivered) return { state, refused: null };
      return { state: without(state, event.file), refused: null };
    case "replaced":
      return { state: held ? without(state, event.file) : state, refused: null };
    default:
      return { state, refused: null };
  }
}

function without(state, file) {
  const next = { ...state };
  delete next[file];
  return Object.freeze(next);
}
