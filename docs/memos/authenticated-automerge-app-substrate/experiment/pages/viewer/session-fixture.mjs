// A Page session for SessionHost and reload-gate tests.
//
// Its phase steps through the real viewer-session machine. Effects are
// immediate unless the test holds them: `closeGate` holds the final
// checkpoint and `reloadForAccess()` waits for `finishArchive`. The drain
// ends on PageSession's conditions (receipt, pause or a non-saving receipt
// state) or when the test fires `timers` at CLOSE_DRAIN_MS.
import { Store } from "./store.mjs";
import { CLOSE_DRAIN_MS, drainingStatus, saveStateOf } from "./session.mjs";
import { isLive, viewerSessionMachine } from "./session-machine.mjs";

export function deferred() {
  let resolve, reject;
  const promise = new Promise((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

export function manualTimers() {
  const pending = new Set();
  return {
    pending,
    setTimeout: (fn, ms) => {
      const timer = { fn, ms };
      pending.add(timer);
      return timer;
    },
    clearTimeout: (timer) => pending.delete(timer),
    fire() {
      for (const timer of pending) {
        pending.delete(timer);
        timer.fn();
      }
    },
  };
}

const PAUSES = {
  auth: { type: "signIn", ok: false },
  access: { type: "accessChanged", grant: "denied" },
  trash: { type: "trash" },
  reload: { type: "accessChanged", grant: "changed" },
};

export class FakeSession {
  phase$ = new Store({ name: "open" });
  // The status id the reload gate reads (STATUS_IDS in sync-status-machine.mjs).
  statusId = "saving";
  pending = true;
  savedHeads = [];
  heads = ["h1"];
  doc = { title: "Garden notes" };
  checkpointFails = false;
  listeners = new Set();
  pauses = new Set();
  calls = [];
  #closing;
  constructor(pageId = crypto.randomUUID(), { principal = "dev", timers } = {}) {
    this.pageId = pageId;
    this.identity = { principal };
    this.timers = timers;
  }
  get alive() {
    return isLive(this.phase$.snapshot());
  }
  get deleted() {
    return this.phase$.snapshot().name === "deleted";
  }
  get hidden() {
    const name = this.phase$.snapshot().name;
    return name === "deleted" || name === "revoked";
  }
  get recoveryPending() {
    return this.pending;
  }
  get saveState() {
    return saveStateOf(this.statusId);
  }
  get checkpointWritten() {
    const phase = this.phase$.snapshot();
    return phase.name === "closed" && phase.checkpointWritten;
  }
  get editsPaused() {
    return this.pauses.size > 0;
  }
  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  emit() {
    for (const fn of this.listeners) fn();
  }
  set(patch) {
    Object.assign(this, patch);
    this.emit();
  }
  step(event) {
    const result = viewerSessionMachine.step(this.phase$.snapshot(), event);
    if (!result.rejected) this.phase$.update(() => result.state);
    return result;
  }
  /** Pause syncing for `reason` (auth, access, trash or reload). */
  pause(reason) {
    this.step(PAUSES[reason]);
    this.emit();
  }
  pauseEdits(reason, paused = true) {
    if (paused) this.pauses.add(reason);
    else this.pauses.delete(reason);
  }
  retryConnection(options) {
    this.calls.push(["retry", options]);
  }
  queueSaved() {
    this.calls.push("queueSaved");
  }
  publishPresence() {}
  exportRecovery() {
    return { markdown: `# ${this.doc.title}\n\nUnsent edit\n`, heads: [...this.heads] };
  }
  /** As PageSession: re-read the close after each settle until stable. */
  async closeSettled() {
    for (;;) {
      const closing = this.#closing;
      const [result] = await Promise.allSettled([closing]);
      if (this.#closing !== closing) continue;
      if (result.status === "rejected") throw result.reason;
      return;
    }
  }
  leave({ drain = true } = {}) {
    if (this.phase$.snapshot().name === "draining") return this.closeSettled();
    if (this.step({ type: "leave", drain }).rejected) return this.closeSettled();
    if (!drain) this.#recordLeave();
    this.#closing = drain ? this.#drain() : this.#checkpoint();
    return this.closeSettled();
  }
  #recordLeave() {
    const saved = this.deleted || !this.pending;
    this.leaveRecord = { saved };
    if (!saved) {
      this.leaveRecord.title = this.doc.title;
      this.leaveRecord.recovery = this.exportRecovery();
    }
  }
  close() {
    return this.leave({ drain: false });
  }
  restore() {
    const phase = this.phase$.snapshot().name;
    if (phase !== "open" && phase !== "paused") return undefined;
    if (this.step({ type: "restore" }).rejected) return undefined;
    this.#closing = this.#drain();
    return this.closeSettled();
  }
  markDeleted() {
    if (this.step({ type: "accessChanged", grant: "deleted" }).rejected) return undefined;
    this.emit();
    return this.close();
  }
  /** Start an access reload; settle it with finishArchive. */
  reloadForAccess() {
    if (this.step({ type: "reloadAccess" }).rejected)
      return Promise.reject(Error("No access reload is pending"));
    this.archive = deferred();
    return this.archive.promise.then(
      (replacement) => {
        this.step({ type: "checkpointOk" });
        // The backend release settles when the test opens closeGate.
        this.#closing = Promise.resolve(this.closeGate?.promise);
        return replacement;
      },
      (error) => {
        this.step({ type: "checkpointFail", deleted: false });
        this.emit();
        throw error;
      },
    );
  }
  finishArchive(error, replacement) {
    if (error) this.archive.reject(error);
    else this.archive.resolve(replacement);
  }
  #drain() {
    const settled = () =>
      this.phase$.snapshot().name !== "draining" ||
      !!this.phase$.snapshot().reason ||
      this.deleted ||
      !this.pending ||
      !drainingStatus(this.statusId);
    return new Promise((resolve) => {
      let finished = false;
      let unsubscribe;
      let subscription;
      let timer;
      const finish = () => {
        if (finished) return;
        finished = true;
        unsubscribe?.();
        subscription?.unsubscribe();
        if (timer) this.timers?.clearTimeout(timer);
        resolve();
      };
      if (settled()) return finish();
      unsubscribe = this.subscribe(() => settled() && finish());
      subscription = this.phase$.state$.subscribe(() => settled() && finish());
      timer = this.timers?.setTimeout(finish, CLOSE_DRAIN_MS);
    }).then(() => {
      if (this.phase$.snapshot().name !== "draining") return undefined;
      this.#recordLeave();
      this.step({ type: "drained", saved: this.leaveRecord.saved });
      return this.#checkpoint();
    });
  }
  async #checkpoint() {
    this.calls.push("close");
    await this.closeGate?.promise;
    if (this.phase$.snapshot().name !== "checkpointing") return;
    this.step(
      this.checkpointFails ? { type: "checkpointFail", deleted: false } : { type: "checkpointOk" },
    );
    if (this.closeError) throw this.closeError;
  }
}
