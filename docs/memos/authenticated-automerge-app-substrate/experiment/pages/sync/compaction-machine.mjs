// Per-document compaction on the Page host, which runs after a frame's ack in
// the document's queue. A failed compaction leaves the stored chunks as they
// were, so it can wait: each failure doubles the number of writes that skip
// it, up to MAX_COMPACTION_SKIP, and only an attempt re-runs A.save and
// reports. A persistent failure reports O(log n) times over n writes, then
// once per MAX_COMPACTION_SKIP writes.
//
//   ready       compact on the next write that wants it
//   compacting  an attempt is running
//   backoff     the last attempt failed; `skip` more writes pass it by
//
// Events: "due" (a write wants compaction), "succeeded", "failed".
// `compactionStep` is the only transition; its effect is "compact" (run an
// attempt), "report" (report the failure) or null.

export const MAX_COMPACTION_SKIP = 256;
export const COMPACTION_READY = Object.freeze({ phase: "ready", failures: 0 });

export function compactionStep(state, event) {
  switch (state.phase) {
    case "ready":
      if (event.type === "due")
        return { state: { phase: "compacting", failures: state.failures }, effect: "compact" };
      break;
    case "compacting":
      if (event.type === "due") return { state, effect: null };
      if (event.type === "succeeded") return { state: COMPACTION_READY, effect: null };
      if (event.type === "failed") {
        const failures = state.failures + 1;
        return {
          state: {
            phase: "backoff",
            failures,
            skip: Math.min(2 ** (failures - 1), MAX_COMPACTION_SKIP),
          },
          effect: "report",
        };
      }
      break;
    case "backoff":
      if (event.type === "due")
        return state.skip > 0
          ? { state: { ...state, skip: state.skip - 1 }, effect: null }
          : { state: { phase: "compacting", failures: state.failures }, effect: "compact" };
      break;
  }
  throw new TypeError(`No compaction transition for ${event.type} in ${state.phase}`);
}
