/**
 * Navigation for the comments panel. One pure transition function owns which
 * view shows: the thread list, or one thread drilled into from it. Effects
 * (scroll restoration, focus) run in the panel after the transition.
 *
 * States:
 *   { name: "list", scroll }               the grouped thread list
 *   { name: "thread", id, listScroll }     one thread; Back returns to the list
 *
 * Events:
 *   { type: "open", id, scroll }           drill into a thread from the list
 *   { type: "show", id }                   reveal a thread from outside (a passage click)
 *   { type: "back" }                       return to the list at its saved scroll
 *   { type: "step", by, ids }              move to the previous/next thread in `ids`
 *   { type: "sync", ids }                  the visible thread ids changed
 */

export const LIST = Object.freeze({ name: "list", scroll: 0 });

export function navigate(state, event) {
  switch (event.type) {
    case "open":
      if (!event.id) return state;
      return {
        name: "thread",
        id: event.id,
        listScroll: state.name === "list" ? (event.scroll ?? 0) : state.listScroll,
      };
    case "show":
      if (!event.id) return state;
      if (state.name === "thread" && state.id === event.id) return state;
      return {
        name: "thread",
        id: event.id,
        listScroll: state.name === "list" ? state.scroll : state.listScroll,
      };
    case "back":
      return state.name === "thread" ? { name: "list", scroll: state.listScroll } : state;
    case "step": {
      if (state.name !== "thread") return state;
      const ids = event.ids ?? [];
      const index = ids.indexOf(state.id);
      const next = index < 0 ? undefined : ids[index + event.by];
      return next ? { ...state, id: next } : state;
    }
    case "sync":
      // A thread deleted elsewhere can't stay on screen; fall back to the list.
      if (state.name === "thread" && !(event.ids ?? []).includes(state.id))
        return { name: "list", scroll: state.listScroll };
      return state;
    default:
      return state;
  }
}

/** Position of the current thread among `ids`, for an "n of m" label. */
export function position(state, ids) {
  if (state.name !== "thread") return null;
  const index = ids.indexOf(state.id);
  return index < 0 ? null : { index: index + 1, total: ids.length };
}

/**
 * Group threads under the nearest heading above their anchor, in document
 * order. `locate(thread)` returns `{ order, headings }` (see threadLocation).
 * Detached threads (no surviving block) collect in a final group.
 */
export function groupByHeading(threads, locate) {
  const located = threads.map((thread) => ({ thread, location: locate(thread) }));
  located.sort(
    (a, b) =>
      a.location.order[0] - b.location.order[0] || a.location.order[1] - b.location.order[1],
  );
  const groups = [];
  for (const { thread, location } of located) {
    const heading = location.blockSurvives === false ? null : (location.headings?.at(-1) ?? "");
    const key = heading === null ? "\u0000detached" : heading;
    const last = groups.at(-1);
    if (last && last.key === key) last.threads.push(thread);
    else groups.push({ key, heading, threads: [thread] });
  }
  return groups;
}
