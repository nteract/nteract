export const TITLE_STORE_RETRY_MS = 30_000;

/** One observation owns two independent lanes: local persistence and Catalog
 * delivery. Either can finish first. Only both succeeding permits a clear.
 * Tokens identify attempts, not titles: A -> B -> A has three owners.
 * Effects carry those tokens through the host's serialized storage queue.
 * D1 reports and domain-reader discovery do not participate in this lifecycle.
 *
 * Lifecycle: empty -> pending -> clearing -> settled.
 * Storage: marking -> storing -> stored, or retry until a request is due.
 * Delivery: needed -> sending -> delivered, or needed after failure.
 * Events: restore, observe (index only), project, and each effect's Finished.
 */
export function titleProjection(state = { name: "empty" }, event) {
  const effects = [];
  const unchanged = () => ({ state, effects });
  if (event.type === "restore") {
    if (state.name !== "empty" || !event.record) return unchanged();
    return {
      state: {
        name: "pending",
        record: event.record,
        storage: { name: "stored" },
        delivery: { name: "needed" },
      },
      effects,
    };
  }
  if (event.type === "observe" || event.type === "project") {
    if (state.name === "empty" || event.observe || state.record.title !== event.title) {
      state = {
        name: "pending",
        record: {
          title: event.title,
          observed_at: new Date(event.now).toISOString(),
          keep: !event.observe,
        },
        storage: { name: "retry", attemptedAt: -Infinity },
        delivery: { name: "needed" },
      };
    }
    if (
      state.storage.name === "retry" &&
      event.now - state.storage.attemptedAt >= TITLE_STORE_RETRY_MS
    ) {
      const token = {};
      state = { ...state, storage: { name: "marking", token, attemptedAt: event.now } };
      effects.push({ type: "mark", token });
    }
    if (event.type === "project" && state.delivery.name === "needed") {
      const token = {};
      state = { ...state, delivery: { name: "sending", token } };
      effects.push({ type: "deliver", token });
    }
  } else if (event.type === "markFinished" || event.type === "storeFinished") {
    const expected = event.type === "markFinished" ? "marking" : "storing";
    if (state.storage?.name !== expected || state.storage.token !== event.token) return unchanged();
    const storage = event.ok
      ? expected === "marking"
        ? { ...state.storage, name: "storing" }
        : { name: "stored" }
      : { name: "retry", attemptedAt: state.storage.attemptedAt };
    state = { ...state, storage };
    if (storage.name === "storing")
      effects.push({ type: "store", token: storage.token, record: state.record });
  } else if (event.type === "deliverFinished") {
    if (state.delivery?.name !== "sending" || state.delivery.token !== event.token)
      return unchanged();
    state = { ...state, delivery: { name: event.ok ? "delivered" : "needed" } };
  } else if (event.type === "clearFinished") {
    if (state.name !== "clearing" || state.token !== event.token) return unchanged();
    const { token: _token, ...rest } = state;
    return { state: { ...rest, name: event.ok ? "settled" : "pending" }, effects };
  } else return unchanged();

  if (
    state.name === "pending" &&
    state.storage.name === "stored" &&
    state.delivery.name === "delivered"
  ) {
    const token = {};
    state = { ...state, name: "clearing", token };
    effects.push({ type: "clear", token });
  }
  return { state, effects };
}
