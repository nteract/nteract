// Lifecycle of the Wordgard binding's decoded block. The binding runs reads,
// writes and decoding at the edge and reports them here as events.
//
// - synced(heads, projection): `projection` describes the block's text at
//   `heads`; a write or change event from those heads may carry it forward.
// - unknown(projection): `projection` is the last one known, and the text may
//   have moved since. The next use reads the block.
// - writing(heads, pending, check, prior): a local write from `heads` is in
//   flight. Its change event adopts the `pending` projection once the binding
//   passes `check` (opaque here); if no event arrives, the write ends back at
//   `prior`.
//
// Events:
// - read(heads, projection): a whole-block read.
// - advance(before, after, projection?): a change event this binding didn't
//   write. Without a projection the text is unchanged (another path changed).
// - begin(heads, pending, check): a local write is about to commit.
// - commit(before, after, checked): the change event for a local write.
// - end: the local write returned or threw.
// - invalidate: the projection can no longer be trusted.

export const sameHeads = (a, b) =>
  !!a && !!b && a.length === b.length && a.every((hash) => b.includes(hash));

export const synced = (heads, projection) => ({ type: "synced", heads, projection });
export const unknown = (projection) => ({ type: "unknown", projection });
export const writing = (heads, pending, check, prior) => ({
  type: "writing",
  heads,
  pending,
  check,
  prior,
});

const settled = (state) => (state.type === "writing" ? state.prior : state);

export function projectionStep(state, event) {
  switch (event.type) {
    case "read":
      return synced(event.heads, event.projection);
    case "invalidate":
      return unknown(settled(state).projection);
    case "begin":
      return writing(event.heads, event.pending, event.check ?? null, settled(state));
    case "commit":
      return state.type === "writing" && event.checked && sameHeads(state.heads, event.before)
        ? synced(event.after, state.pending)
        : unknown(settled(state).projection);
    case "end":
      return settled(state);
    case "advance":
      if (state.type === "writing")
        return writing(state.heads, state.pending, state.check, projectionStep(state.prior, event));
      return state.type === "synced" && sameHeads(state.heads, event.before)
        ? synced(event.after, event.projection ?? state.projection)
        : unknown(state.projection);
    default:
      throw Error(`Unknown projection event ${event.type}`);
  }
}

/** The projection to build on at `heads`, or null when the block must be read. */
export const projectionAt = (state, heads) =>
  state.type === "synced" && sameHeads(state.heads, heads) ? state.projection : null;

/** The projection the binding publishes as `current`: the last accepted one. */
export const publishedProjection = (state) => settled(state).projection;
