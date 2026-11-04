// Bounded replay window and observation, copied from Automerge Repo 3
// (packages/automerge-repo/src/sedimentree/testing/ReplayLog.ts at the pinned
// revision, MIT). The package doesn't export it; AutomergeSyncBackend needs the
// same replay and rescan semantics as Repo's reference backend.

/** A bounded, process-local replay window. Stored values are privately owned. */
export class ReplayLog {
  maxEvents;
  maxBytes;
  sequence = 0;
  #entries = [];
  #bytes = 0;
  #listeners = new Set();
  constructor(maxEvents, maxBytes) {
    this.maxEvents = maxEvents;
    this.maxBytes = maxBytes;
  }
  append(make, bytes) {
    const sequence = ++this.sequence;
    this.#entries.push({ sequence, value: make(sequence), bytes });
    this.#bytes += bytes;
    while (this.#entries.length > this.maxEvents || this.#bytes > this.maxBytes) {
      this.#bytes -= this.#entries.shift().bytes;
    }
    for (const listener of this.#listeners) listener();
    return sequence;
  }
  readAfter(sequence) {
    if (sequence === this.sequence) return { type: "wait" };
    const next = this.#entries.find((entry) => entry.sequence > sequence);
    if (!next || next.sequence !== sequence + 1) return { type: "behind" };
    return { type: "entry", sequence: next.sequence, value: next.value };
  }
  clear() {
    this.#entries = [];
    this.#bytes = 0;
  }
  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}
/**
 * Unlike an async generator blocked in await, return() immediately wakes a
 * pending next(). Neither abandoning initial enumeration nor closing while idle
 * leaves a listener or pinned snapshot behind.
 */
export class Observation {
  log;
  copy;
  rescan;
  onEnd;
  #initial;
  #cursor;
  #done = false;
  #terminal;
  #pending;
  #unsubscribe;
  constructor(initial, log, copy, rescan, onEnd) {
    this.log = log;
    this.copy = copy;
    this.rescan = rescan;
    this.onEnd = onEnd;
    this.#initial = initial;
    this.#cursor = log.sequence;
    this.#unsubscribe = log.subscribe(() => this.#wake());
  }
  [Symbol.asyncIterator]() {
    return this;
  }
  next() {
    if (this.#pending)
      return Promise.reject(new Error("An observation permits only one outstanding next()"));
    const result = this.#read();
    if (result) return Promise.resolve(result);
    return new Promise((resolve) => {
      this.#pending = { resolve };
    });
  }
  return() {
    this.#terminal = undefined;
    this.end();
    return Promise.resolve({ done: true, value: undefined });
  }
  /** An invalidating event, such as deletion, supersedes queued old-generation data. */
  end(terminal) {
    if (this.#done) return;
    this.#done = true;
    this.#terminal = terminal;
    this.#initial?.return?.();
    this.#initial = undefined;
    this.#unsubscribe();
    const onEnd = this.onEnd;
    this.onEnd = undefined;
    onEnd?.();
    this.#wake();
  }
  #read() {
    if (this.#terminal !== undefined) {
      const value = this.#terminal;
      this.#terminal = undefined;
      return { done: false, value: this.copy(value) };
    }
    if (this.#done) return { done: true, value: undefined };
    if (this.#initial) {
      const next = this.#initial.next();
      if (!next.done) return { done: false, value: this.copy(next.value) };
      this.#initial = undefined;
    }
    const next = this.log.readAfter(this.#cursor);
    if (next.type === "wait") return undefined;
    if (next.type === "behind") {
      const value = this.rescan(this.log.sequence);
      this.end();
      return { done: false, value };
    }
    this.#cursor = next.sequence;
    return { done: false, value: this.copy(next.value) };
  }
  #wake() {
    if (!this.#pending) return;
    // Clear before #read, which can end this observation on overflow.
    const pending = this.#pending;
    this.#pending = undefined;
    const result = this.#read();
    if (result) pending.resolve(result);
    else this.#pending = pending;
  }
}
