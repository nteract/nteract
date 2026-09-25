import { PackageOperationError } from "./package-resolver.js";
import { PACKAGE_MAX_WAITING, PACKAGE_QUEUE_WAIT_MS } from "./package-limits.js";

const MAX_COOLDOWN_OWNERS = 32;

// Acquisition has 120s and installation has a separate 30s wall deadline.
// Keep FIFO positions through preceding turns and their cleanup allowance,
// instead of expiring every 20s and making
// restores race new adds during their retry backoff. No artifact buffers are
// acquired while waiting; abort removes a queued entry immediately.

/** One acquisition/install buffer set for this provider, shared by adds and
 * restores. One outstanding request per owner and FIFO admission prevent an
 * owner with multiple notebooks from occupying every waiting slot.
 */
export class PackageAdmission {
  #active = null;
  #queue = [];
  #owners = new Set();
  #lastFinished = new Map();
  #clock;
  constructor({ clock = Date.now } = {}) {
    this.#clock = clock;
  }

  get status() {
    return { active: !!this.#active, waiting: this.#queue.length };
  }

  run(owner, signal, operation, { cooldown = true } = {}) {
    signal.throwIfAborted();
    const now = this.#clock();
    for (const [principal, finished] of this.#lastFinished)
      if (now - finished >= 5_000) this.#lastFinished.delete(principal);
    if (this.#owners.has(owner) || this.#queue.length >= PACKAGE_MAX_WAITING) {
      throw new PackageOperationError("planner_busy");
    }
    if (cooldown && this.#lastFinished.has(owner)) {
      throw new PackageOperationError("add_cooldown");
    }
    if (cooldown && this.#lastFinished.size + this.#owners.size >= MAX_COOLDOWN_OWNERS)
      throw new PackageOperationError("planner_busy");
    this.#owners.add(owner);
    return new Promise((resolve, reject) => {
      const entry = {
        owner,
        signal,
        operation,
        cooldown,
        resolve,
        reject,
        timer: undefined,
        abort: undefined,
      };
      const remove = (error) => {
        const index = this.#queue.indexOf(entry);
        if (index < 0) return; // Active work is cancelled by its session signal.
        this.#queue.splice(index, 1);
        this.#owners.delete(owner);
        clearTimeout(entry.timer);
        signal.removeEventListener("abort", entry.abort);
        reject(error);
      };
      entry.abort = () => remove(signal.reason);
      signal.addEventListener("abort", entry.abort, { once: true });
      entry.timer = setTimeout(
        () => remove(new PackageOperationError("planner_busy")),
        PACKAGE_QUEUE_WAIT_MS,
      );
      this.#queue.push(entry);
      this.#pump();
    });
  }

  #pump() {
    if (this.#active) return;
    const entry = this.#queue.shift();
    if (!entry) return;
    this.#active = entry;
    clearTimeout(entry.timer);
    entry.signal.removeEventListener("abort", entry.abort);
    Promise.resolve()
      .then(() => {
        entry.signal.throwIfAborted();
        return entry.operation();
      })
      .then(entry.resolve, entry.reject)
      .finally(() => {
        if (entry.cooldown) {
          this.#lastFinished.set(entry.owner, this.#clock());
        }
        this.#owners.delete(entry.owner);
        this.#active = null;
        this.#pump();
      });
  }
}
