import { defineMachine, reject } from "../shared/machine.mjs";

/**
 * Writing a Page's card (model/page-card.mjs) to the Page assets bucket.
 *
 * Only a content-activity flush (content-activity.mjs) asks for a write. It
 * runs at most once a minute per Page, from a live request, after the
 * content changed, so the host is booted and its document loaded. A Page
 * that hasn't changed since cards shipped has no card until its next edit;
 * the grid shows its placeholder until then.
 *
 * A write builds the card from the loaded document and compares its hash
 * with the stored one; only a changed card is put. The stored hash is
 * written after the object lands, so a crash in between writes the same
 * card again next time. A failed write is logged and left: the next flush
 * tries again. It never fails the
 * flush or the edit that caused it.
 *
 * States:
 * - unread: the stored hash hasn't been read yet.
 * - idle: `stored` is the hash last written (null: none).
 * - queued: a write waits for a live request to start it.
 * - writing: a write is running; `again` asks for another once it ends.
 * - stopped: the Page is being deleted. Terminal, so a late outcome can't
 *   put a card back after the host deleted it.
 *
 * Events: `restored` (the stored hash), `requested`, `start` (a live request), `written` (the hash now
 * stored), `failed`, `stop`.
 *
 * Effects: `write` with the hash it may skip.
 *
 * Where effects run. As for content activity, celld drops I/O started in a
 * request that has already responded. `requested` and `restored` start
 * nothing; only `start`, from a live request's `pump()`, does.
 */
export const PAGE_CARD_KEY = "host/card";

const hash = (value, label) => {
  if (value !== null && (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)))
    throw Error(`${label} must be a card hash or null`);
};
const stored = (state) => hash(state.stored, "stored");

export const pageCardWriterMachine = defineMachine({
  name: "page-card-writer",
  states: ["unread", "idle", "queued", "writing", "stopped"],
  events: ["restored", "requested", "start", "written", "failed", "stop"],
  initial: { name: "unread" },
  unreachable: [
    ["unread", "written", "only a running write reports an outcome"],
    ["unread", "failed", "only a running write reports an outcome"],
    ["idle", "written", "only a running write reports an outcome"],
    ["idle", "failed", "only a running write reports an outcome"],
    ["queued", "written", "only a running write reports an outcome"],
    ["queued", "failed", "only a running write reports an outcome"],
  ],
  cases: {
    "writing/written": ["done", "again"],
    "writing/failed": ["done", "again"],
  },
  validate: {
    states: {
      unread: () => {},
      idle: stored,
      queued: stored,
      writing: (state) => {
        stored(state);
        if (typeof state.again !== "boolean") throw Error("again must be a boolean");
      },
      stopped: () => {},
    },
    events: {
      restored: (event) => hash(event.stored, "stored"),
      requested: () => {},
      start: () => {},
      written: (event) => hash(event.hash, "hash"),
      failed: () => {},
      stop: () => {},
    },
    effects: { write: (effect) => hash(effect.stored, "stored") },
  },
  transition(state, event) {
    if (state.name === "stopped") return reject(state, "the Page host stopped");
    const queue = (value) => ({ state: { name: "queued", stored: value }, effects: [] });
    switch (event.type) {
      case "restored":
        if (state.name !== "unread") return reject(state, "the stored hash was already read");
        return { state: { name: "idle", stored: event.stored }, effects: [] };
      case "requested":
        // Before the read, the stored hash is unknown: write whatever builds.
        if (state.name === "unread") return queue(null);
        if (state.name === "idle") return queue(state.stored);
        if (state.name === "writing")
          return state.again
            ? reject(state, "another write is already asked for")
            : { state: { ...state, again: true }, effects: [] };
        return reject(state, "a write is already queued");
      case "start":
        if (state.name !== "queued") return reject(state, "no write is queued");
        return {
          state: { name: "writing", stored: state.stored, again: false },
          effects: [{ type: "write", stored: state.stored }],
        };
      case "written":
      case "failed": {
        // writing only (see unreachable).
        const next = event.type === "written" ? event.hash : state.stored;
        if (state.again) return queue(next);
        return { state: { name: "idle", stored: next }, effects: [] };
      }
      case "stop":
        return { state: { name: "stopped" }, effects: [] };
    }
  },
});

/**
 * Runs the machine for one Page host.
 *
 * - `build()` returns the card bundle for the loaded document, or null when
 *   there is nothing to write (no document, a Page that isn't active).
 * - `store.put(bundle)` and `store.delete()` write and remove the object.
 * - `storage` is the host's Durable Object storage, for `PAGE_CARD_KEY`.
 * - `hold(work)` keeps the calling request running until `work` settles.
 */
export class PageCardWriter {
  #state = pageCardWriterMachine.initial;
  #restored;
  constructor({ build, store, storage, hold = () => {}, onError = () => {} }) {
    this.build = build;
    this.store = store;
    this.storage = storage;
    this.hold = hold;
    this.onError = onError;
  }

  get state() {
    return this.#state;
  }

  /** Read the stored hash once. */
  restore() {
    this.#restored ??= (async () => {
      const record = await this.storage.get(PAGE_CARD_KEY);
      const value = typeof record?.card_hash === "string" ? record.card_hash : null;
      if (this.#state.name === "unread")
        this.#step({ type: "restored", stored: validHash(value) ? value : null });
    })();
    return this.#restored;
  }

  /** Ask for a write. Safe from any context: it waits for `pump()`. */
  request() {
    this.#step({ type: "requested" });
  }

  /** From a live request: start a queued write. Cheap when nothing waits. */
  pump() {
    if (this.#state.name === "queued") this.#step({ type: "start" });
  }

  /** Terminal. A write already running finishes, and removes its object if
   * it landed after the stop. */
  stop() {
    this.#step({ type: "stop" });
  }

  #step(event) {
    const result = pageCardWriterMachine.step(this.#state, event);
    this.#state = result.state;
    for (const effect of result.effects)
      if (effect.type === "write") this.hold(this.#write(effect.stored));
  }

  async #write(previous) {
    let outcome;
    try {
      const bundle = await this.build();
      if (!bundle || this.#state.name === "stopped") outcome = { type: "failed" };
      else if (bundle.card_hash === previous) outcome = { type: "written", hash: previous };
      else {
        await this.store.put(bundle);
        if (this.#state.name === "stopped") {
          // The host deleted the Page while this put ran.
          await this.store.delete();
          return;
        }
        await this.storage.put(PAGE_CARD_KEY, { card_hash: bundle.card_hash });
        outcome = { type: "written", hash: bundle.card_hash };
      }
    } catch (error) {
      if (this.#state.name === "stopped") return;
      this.onError(error);
      outcome = { type: "failed" };
    }
    if (this.#state.name === "stopped") return;
    this.#step(outcome);
    // A request that arrived during the write runs in this same request.
    this.pump();
  }
}

const validHash = (value) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
