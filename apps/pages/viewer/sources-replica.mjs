// A Page's sources document on this replica, read-only: the interpreter for
// sources-open-machine.mjs. It finds the document the host's discovery
// names, retries a failed lookup on a timer, and publishes the open
// document's current value as `doc$`, the only thing it exposes. Nothing
// here writes the document; the host refuses any change a browser sends for
// it. On retirement the replica drops the document from memory; its synced
// bytes stay in the tab's replica database, the same as the Page's and
// comments' synced bytes.
import { BehaviorSubject, asyncScheduler, timer } from "rxjs";
import { parseDocumentDescriptor } from "../model/document-types.mjs";
import { Store } from "./store.mjs";
import { discoveryEvent, sourcesOpenMachine } from "./sources-open-machine.mjs";

/** How long one lookup may take before it counts as failed. */
export const SOURCES_LOOKUP_TIMEOUT_MS = 15_000;

/** Repo's answer when the host said it holds no such document. */
export const UNAVAILABLE = /^Document \S+ is unavailable$/;

export class SourcesReplica {
  /** The machine's state (sources-open-machine.mjs). */
  state$ = new Store(sourcesOpenMachine.initial);
  #doc = new BehaviorSubject(undefined);
  /** The open sources document's current value, or undefined while none is
   * open. Emits synchronously on subscribe. */
  doc$ = this.#doc.asObservable();
  #handle;
  #found;
  #onChange;
  #lookup;
  #retry;
  #find;
  #link;
  #scheduler;
  #lookupTimeout;

  /**
   * `find(id, { signal })` looks a document up in the replica's repo.
   * `link()` names the connection a lookup runs on (undefined while none is
   * up): an unavailable answer on a link that is still up is the host's
   * answer, and one after the link changed is a lost connection.
   * `scheduler` runs the retry and lookup timers.
   */
  constructor({
    find,
    link = () => true,
    scheduler = asyncScheduler,
    lookupTimeout = SOURCES_LOOKUP_TIMEOUT_MS,
  }) {
    this.#find = find;
    this.#link = link;
    this.#scheduler = scheduler;
    this.#lookupTimeout = lookupTimeout;
  }

  /** The open document's value, or undefined. */
  get doc() {
    return this.#doc.getValue();
  }

  /** A connection was admitted with `connection` as its discovery. */
  discovered(connection) {
    return this.step(discoveryEvent(connection, parseDocumentDescriptor));
  }

  /** The replica is retiring with the Page's other documents: a lookup is
   * cancelled and the document dropped from memory. */
  retire() {
    return this.step({ type: "retire" });
  }

  /** The replica closed or is being replaced. */
  close() {
    return this.step({ type: "close" });
  }

  /** Step the machine and run its effects at the edge. */
  step(event) {
    const result = sourcesOpenMachine.step(this.state$.snapshot(), event);
    if (result.rejected) return result;
    this.state$.update(() => result.state);
    for (const effect of result.effects) this.#run(effect);
    return result;
  }

  #run(effect) {
    switch (effect.type) {
      case "lookup":
        return this.#start(effect);
      case "cancel":
        this.#lookup?.abort();
        this.#lookup = undefined;
        return;
      case "schedule":
        this.#retry?.unsubscribe();
        this.#retry = timer(effect.delay, this.#scheduler).subscribe(() => {
          this.#retry = undefined;
          this.step({ type: "timer", attempt: effect.attempt });
        });
        return;
      case "clearTimer":
        this.#retry?.unsubscribe();
        this.#retry = undefined;
        return;
      case "install":
        return this.#install();
      case "uninstall":
        return this.#uninstall();
    }
    throw new Error(`unknown effect ${effect.type}`);
  }

  /** One lookup. Its result reaches the machine only through events that
   * name its attempt, so a cancelled one is ignored there. */
  #start({ attempt, id }) {
    this.#lookup?.abort();
    const lookup = new AbortController();
    this.#lookup = lookup;
    const link = this.#link();
    const deadline = timer(this.#lookupTimeout, this.#scheduler).subscribe(() =>
      lookup.abort(Object.assign(Error("The sources lookup timed out"), { name: "TimeoutError" })),
    );
    const settle = (event) => {
      deadline.unsubscribe();
      if (this.#lookup === lookup) this.#lookup = undefined;
      if (lookup.signal.aborted && lookup.signal.reason?.name !== "TimeoutError") return;
      this.step(event);
    };
    Promise.resolve()
      .then(() => this.#find(id, { signal: lookup.signal }))
      .then(
        (handle) => {
          if (lookup.signal.aborted) return settle({ type: "lookupFailed", attempt });
          this.#found = handle;
          settle({ type: "opened", attempt });
          if (this.#found === handle) this.#found = undefined;
        },
        (error) =>
          settle({
            // The host answered on a connection still up that it holds no
            // such document: an older host. Anything else may pass.
            type:
              !lookup.signal.aborted &&
              UNAVAILABLE.test(error?.message ?? "") &&
              link !== undefined &&
              this.#link() === link
                ? "unknown"
                : "lookupFailed",
            attempt,
          }),
      );
  }

  #install() {
    const handle = this.#found;
    this.#found = undefined;
    this.#uninstall();
    this.#handle = handle;
    this.#onChange = () => {
      if (this.#handle === handle) this.#doc.next(handle.doc());
    };
    handle.on("change", this.#onChange);
    this.#doc.next(handle.doc());
  }

  #uninstall() {
    if (this.#handle) this.#handle.off?.("change", this.#onChange);
    this.#handle = this.#onChange = undefined;
    if (this.#doc.getValue() !== undefined) this.#doc.next(undefined);
  }
}
