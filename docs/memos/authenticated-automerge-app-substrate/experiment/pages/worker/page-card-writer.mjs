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
 * tries again. It never fails the flush or the edit that caused it.
 *
 * Ordering across hosts. Every put is conditional on the object's etag as
 * this host last saw it (`onlyIf`; none yet: no object may exist). A
 * retiring host's put that lands late carries an etag the next host's own
 * write has replaced, so the bucket refuses it. A host's first write after
 * boot reads the object's metadata first (`head()`): it learns the etag,
 * and compares the built hash with the object's own, not `host/card`, so a
 * stale card that landed before this host booted is rewritten.
 *
 * A put refused by its condition reads the object again and retries once,
 * unless the host stopped during that read, or the object's
 * `content_updated_at` is later than the built card's: then a newer host
 * wrote it, and this write puts nothing. A first write skips its put the
 * same way. Such a write ends as `failed` without logging, and the next one
 * reads the object again. Equal times with different hashes still put: the
 * same content built by two builder versions, where the later put wins. A
 * time either side lacks never skips.
 *
 * What remains: a late put that lands after the new host's first write
 * skipped an unchanged card. Its card is one this Page held moments before,
 * and the next change to the first screen replaces it.
 *
 * States:
 * - unread: the stored hash hasn't been read yet.
 * - idle: `stored` is the hash last written (null: none).
 * - queued: a write waits for a live request to start it.
 * - writing: a write is running; `again` asks for another once it ends.
 * - stopped: the host is going away: the Page is being deleted
 *   (`deleting`), or this object is retiring (an abandoned boot, a closed
 *   policy, a storage migration). Terminal, so a late outcome changes
 *   nothing; only a deletion can follow a retirement.
 *
 * Events: `restored` (the stored hash), `requested`, `start` (a live
 * request), `written` (the hash now stored), `failed` (nothing of this
 * host's landed), `stop` (with `deleting`).
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
    "stopped/stop": ["deleting", "again"],
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
      stopped: (state) => {
        if (typeof state.deleting !== "boolean") throw Error("deleting must be a boolean");
      },
    },
    events: {
      restored: (event) => hash(event.stored, "stored"),
      requested: () => {},
      start: () => {},
      written: (event) => hash(event.hash, "hash"),
      failed: () => {},
      stop: (event) => {
        if (typeof event.deleting !== "boolean") throw Error("deleting must be a boolean");
      },
    },
    effects: { write: (effect) => hash(effect.stored, "stored") },
  },
  transition(state, event) {
    if (state.name === "stopped") {
      // A retired host's Page can still be deleted: its late put must go.
      if (event.type === "stop" && event.deleting && !state.deleting)
        return { state: { name: "stopped", deleting: true }, effects: [] };
      return reject(state, "the Page host stopped");
    }
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
        return { state: { name: "stopped", deleting: event.deleting }, effects: [] };
    }
  },
});

/**
 * Runs the machine for one Page host.
 *
 * - `build()` returns the card bundle for the loaded document, or null when
 *   there is nothing to write (no document, a Page that isn't active).
 * - `store.head()` returns `{ etag, card_hash, content_updated_at }` for
 *   the stored object, or null. `store.put(bundle, { etag })` writes it
 *   only while the object's etag is `etag` (null: only while there is none)
 *   and returns `{ etag }`, or null when the condition failed.
 *   `store.delete()` removes it.
 * - `storage` is the host's Durable Object storage, for `PAGE_CARD_KEY`.
 * - `hold(work)` keeps the calling request running until `work` settles.
 */
export class PageCardWriter {
  #state = pageCardWriterMachine.initial;
  #restored;
  /** The object's etag as this host last saw it: undefined until read,
   * null for no object. It lives beside the machine, not in it: a write
   * reads and replaces it partway through, between its head and its puts,
   * and the transition never branches on it. Folding it in would split
   * `writing` into a state per bucket call. */
  #etag = undefined;
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

  /** A newer host wrote the object: put nothing, and read it again next
   * time. */
  #superseded() {
    this.#etag = undefined;
    return { type: "failed" };
  }

  /** Ask for a write. Safe from any context: it waits for `pump()`. */
  request() {
    this.#step({ type: "requested" });
  }

  /** From a live request: start a queued write. Cheap when nothing waits. */
  pump() {
    if (this.#state.name === "queued") this.#step({ type: "start" });
  }

  /** Terminal. A write already running finishes without storing its hash.
   * With `deleting` (the Page is being deleted), a put that lands after the
   * stop removes its own object, so it can't outlive the host's delete. A
   * retiring object leaves its object: it is a card of the Page as it is,
   * and the next host's first flush compares against the stored hash. */
  stop({ deleting = false } = {}) {
    this.#step({ type: "stop", deleting });
  }

  #step(event) {
    const result = pageCardWriterMachine.step(this.#state, event);
    this.#state = result.state;
    for (const effect of result.effects)
      if (effect.type === "write") this.hold(this.#write(effect.stored));
  }

  /** Read the object's etag; returns its hash and content time. */
  async #head() {
    const head = await this.store.head();
    this.#etag = head?.etag ?? null;
    return { hash: head?.card_hash ?? null, contentUpdatedAt: head?.content_updated_at ?? null };
  }

  get #stopped() {
    return this.#state.name === "stopped";
  }

  async #write(previous) {
    let outcome;
    try {
      const bundle = await this.build();
      // A host's first write compares with the object itself.
      const object = bundle && this.#etag === undefined ? await this.#head() : null;
      const known = object ? object.hash : previous;
      if (!bundle || this.#stopped) outcome = { type: "failed" };
      else if (bundle.card_hash === known) {
        if (known !== previous) await this.storage.put(PAGE_CARD_KEY, { card_hash: known });
        outcome = { type: "written", hash: known };
      } else if (object && later(object.contentUpdatedAt, bundle.content_updated_at)) {
        outcome = this.#superseded();
      } else {
        let landed = await this.store.put(bundle, { etag: this.#etag });
        let newer = false;
        if (!landed && !this.#stopped) {
          // Another writer moved the object since this host saw it. A stop
          // during this read ends the write below, before any put.
          const moved = await this.#head();
          newer = later(moved.contentUpdatedAt, bundle.content_updated_at);
          if (!newer && !this.#stopped) landed = await this.store.put(bundle, { etag: this.#etag });
        }
        if (this.#stopped) {
          // The host deleted the Page while this put ran.
          if (this.#state.deleting && landed) await this.store.delete();
          return;
        }
        if (newer) outcome = this.#superseded();
        else {
          if (!landed) throw Error("Page card write lost its condition twice");
          this.#etag = landed.etag;
          await this.storage.put(PAGE_CARD_KEY, { card_hash: bundle.card_hash });
          outcome = { type: "written", hash: bundle.card_hash };
        }
      }
    } catch (error) {
      // A put that failed may still land: read the object again next time.
      this.#etag = undefined;
      if (this.#stopped) {
        // A put that timed out may land after the host deleted the Page.
        // Delete again; a miss leaves an object page_cards never serves.
        if (this.#state.deleting) await this.store.delete().catch(() => {});
        return;
      }
      this.onError(error);
      outcome = { type: "failed" };
    }
    if (this.#stopped) return;
    this.#step(outcome);
    // A request that arrived during the write runs in this same request.
    this.pump();
  }
}

const validHash = (value) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);

/** Whether content time `a` is after `b`. A missing or unreadable time is
 * after nothing, and nothing is after it. */
function later(a, b) {
  const [left, right] = [Date.parse(a ?? ""), Date.parse(b ?? "")];
  return Number.isFinite(left) && Number.isFinite(right) && left > right;
}
