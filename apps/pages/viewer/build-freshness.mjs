// Tells an open tab when the Worker behind it has moved to another build.
//
// Every request through request.mjs reports its response headers here, so a
// reconnect (/api/connect), a save (/api/saved) or the session refresh
// (/api/auth/session) compares builds at no extra cost. /health is polled only
// when the tab becomes visible again and on a slow interval while visible.
import { asyncScheduler, fromEventPattern, merge, timer } from "rxjs";
import {
  PAGES_BUILD,
  VIEWER_PROTOCOL,
  advertisementFromHeaders,
  compareBuild,
  readAdvertisement,
  strongerBuildState,
} from "../shared/build-identity.mjs";
import { reloadGateMachine } from "./reload-gate-machine.mjs";
import { pauseReason } from "./session-machine.mjs";
import { Store } from "./store.mjs";
import { monotonicNow } from "./monotonic.mjs";
export {
  SAVE_BEFORE_RELOAD_MS,
  UNSENT_COMMENT,
  checkpointedMessage,
  unsavedMessage,
} from "./reload-gate-machine.mjs";

export const BUILD_CHECK_INTERVAL_MS = 10 * 60_000;
// A tab switched back and forth checks at most this often.
export const VISIBLE_RECHECK_MS = 30_000;

export class BuildMonitor {
  snapshot = { state: "current", server: null };
  listeners = new Set();
  lastCheck = -Infinity;
  constructor({
    build = PAGES_BUILD,
    protocol = VIEWER_PROTOCOL,
    fetchAdvertisement,
    document: page = globalThis.document,
    setInterval: every = globalThis.setInterval?.bind(globalThis),
    clearInterval: cancel = globalThis.clearInterval?.bind(globalThis),
    now = monotonicNow,
  } = {}) {
    Object.assign(this, { build, protocol, fetchAdvertisement, page, every, cancel, now });
  }
  subscribe = (fn) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = () => this.snapshot;
  observe(advertisement) {
    const server = readAdvertisement(advertisement);
    if (!server) return;
    const state = strongerBuildState(
      this.snapshot.state,
      compareBuild(server, { build: this.build, protocol: this.protocol }),
    );
    if (state === this.snapshot.state) return;
    this.snapshot = { state, server };
    if (state === "required") this.stop();
    for (const fn of this.listeners) fn(this.snapshot);
  }
  observeHeaders = (headers) => this.observe(advertisementFromHeaders(headers));
  check() {
    if (this.snapshot.state === "required" || !this.fetchAdvertisement) return Promise.resolve();
    this.lastCheck = this.now();
    this.checking ??= Promise.resolve()
      .then(() => this.fetchAdvertisement())
      .then(
        (value) => this.observe(value),
        () => {}, // Offline or mid-deploy: the next trigger asks again.
      )
      .finally(() => {
        this.checking = undefined;
      });
    return this.checking;
  }
  visible() {
    return !this.page || this.page.visibilityState !== "hidden";
  }
  arm() {
    this.cancel?.(this.timer);
    this.timer = undefined;
    if (this.started && this.visible() && this.snapshot.state !== "required")
      this.timer = this.every?.(() => void this.check(), BUILD_CHECK_INTERVAL_MS);
  }
  onVisibility = () => {
    this.arm();
    if (this.visible() && this.now() - this.lastCheck >= VISIBLE_RECHECK_MS) void this.check();
  };
  start() {
    if (this.started) return this;
    this.started = true;
    // Requests made while opening the app already carried the build headers.
    this.lastCheck = this.now();
    this.page?.addEventListener?.("visibilitychange", this.onVisibility);
    this.arm();
    return this;
  }
  stop() {
    this.started = false;
    this.page?.removeEventListener?.("visibilitychange", this.onVisibility);
    this.cancel?.(this.timer);
    this.timer = undefined;
  }
}

const keyOf = (session) => `${session.identity?.principal}:${session.pageId}`;

function pendingOf(session) {
  if (session.hidden) return false;
  try {
    return !!session.recoveryPending;
  } catch {
    return false;
  }
}

const HELD = new Set(["opening", "open", "paused"]);
// The release has started: the checkpoint settled, or a retired copy's
// archive write settled, whatever its result. A failed capture holds its
// backend until the session is left.
const releasing = (phase) =>
  phase.name === "closed" ||
  phase.name === "retired" ||
  (phase.name === "retireFailed" && !phase.held);

/** What the gate keeps about an owned session, from its phase and receipt.
 * Membership follows the lifecycle, not who started the close: a session
 * closed directly is closing exactly like one left through the drain. */
function summarize(id, session) {
  const phase = session.phase$.snapshot();
  const entry = {
    id,
    key: keyOf(session),
    phase: HELD.has(phase.name) ? "held" : "closing",
    alive: session.alive,
    pending: pendingOf(session),
    save: session.saveState,
    savedHeads: [...(session.savedHeads ?? [])],
  };
  const reason = pauseReason(phase);
  if (reason) entry.reason = reason;
  // A held session's schema hold: its edits wait on a local checkpoint.
  const schema = entry.phase === "held" ? session.schemaHold : undefined;
  if (schema) Object.assign(entry, { schema, title: session.doc?.title ?? "" });
  return entry;
}

/** A session whose backend release settled: how it closed, and what a failed
 * final checkpoint left to recover. An access reload reports saved: it keeps
 * its own recovery record. */
function released(id, session) {
  const savedHeads = [...(session.savedHeads ?? [])];
  if (session.hidden) {
    // An archived copy is in IndexedDB like a deleted one: the gate keeps no
    // record. A failed archive leaves only the tab's export, or a failed
    // capture's best-effort copy, so it keeps that as an unsaved record and
    // blocks Reload until it is downloaded.
    const kept = session.retireFailed ? session.retainedCopy : undefined;
    if (!kept) return { id, key: keyOf(session), phase: "deleted", savedHeads };
    return {
      id,
      key: keyOf(session),
      phase: "closed",
      saved: false,
      checkpointWritten: false,
      savedHeads,
      account: session.identity?.principal,
      pageId: session.pageId,
      title: kept.title ?? "",
      // A retired copy can hold comment drafts no document receipt
      // acknowledges, and its host refused it: only Discard clears it.
      recovery: { markdown: kept.markdown, heads: [...(kept.heads ?? [])], explicit: true },
    };
  }
  const left = (!session.phase$.snapshot().archived && session.leaveRecord) || { saved: true };
  const event = {
    id,
    key: keyOf(session),
    phase: "closed",
    saved: left.saved,
    checkpointWritten: session.checkpointWritten === true,
    savedHeads,
    account: session.identity?.principal,
    pageId: session.pageId,
    title: left.title ?? "",
  };
  if (left.recovery)
    event.recovery = { markdown: left.recovery.markdown, heads: [...left.recovery.heads] };
  return event;
}

function outcomeOf(state) {
  if (state.name === "reloading") return { ok: true };
  if (state.name === "blocked") return { ok: false, ...state.outcome };
  return { ok: false, cancelled: true };
}

/**
 * App-scope reload coordination, interpreted from reload-gate-machine.mjs. A
 * reload replaces every Page this tab holds, so it waits for the held Pages'
 * receipts, for Pages being left to finish closing, and for unsent comment
 * drafts. Navigation during the wait cancels the attempt.
 *
 * The gate watches a SessionHost: each owned session's phase and receipt
 * become `sessionPhase` events, and a change of the installed Page is
 * `navigate`. A closed or deleted session's final event waits for its backend
 * release to settle; the gate drops a session at that point or when the host
 * stops owning it, whichever comes first. Records for
 * Pages left with unsaved edits are plain data in the machine's state: a
 * checkpointed record waits in IndexedDB and a failed one keeps its recovery
 * Markdown and heads until a covering receipt or "Discard unsaved edits".
 */
export class ReloadGate {
  store = new Store(reloadGateMachine.initial);
  #tracked = new Map();
  #released = new WeakSet();
  #byId = new Map();
  #ids = 0;
  #current = null;
  #drafts = new Map();
  #waiters = [];
  #timer = null;
  #reload = () => globalThis.location.reload();
  #watching;
  /** `idOf` names a session in the machine's state; tests pass their own. */
  constructor({ scheduler = asyncScheduler, idOf } = {}) {
    this.scheduler = scheduler;
    this.idOf = idOf ?? (() => `s${++this.#ids}`);
  }
  /** Follow a SessionHost's owned sessions. Returns a stop function. */
  watch(host) {
    this.#watching?.unsubscribe();
    this.#watching = host.store.state$.subscribe((state) => this.#observe(state));
    return () => this.#watching.unsubscribe();
  }
  #observe({ current, owned }) {
    const seen = new Set();
    for (const { session } of owned) {
      seen.add(session);
      // The host can still own a released session, e.g. while its access
      // reload opens the replacement; its final event was already sent.
      if (this.#released.has(session)) continue;
      let tracked = this.#tracked.get(session);
      if (!tracked) {
        tracked = { id: this.idOf(session) };
        this.#tracked.set(session, tracked);
        this.#byId.set(tracked.id, session);
        tracked.subscription = merge(
          session.phase$.state$,
          fromEventPattern(
            (handler) => session.subscribe(handler),
            (_, unsubscribe) => unsubscribe(),
          ),
        ).subscribe(() => this.#report(session));
      }
      this.#report(session);
    }
    for (const session of this.#tracked.keys()) {
      if (seen.has(session)) continue;
      // A closing session stays followed until its own release settles,
      // whenever the host lets go of it.
      if (HELD.has(session.phase$.snapshot().name)) this.#release(session);
    }
    if (current !== this.#current) {
      this.#current = current;
      this.#dispatch({ type: "navigate" });
    }
  }
  #report(session) {
    const tracked = this.#tracked.get(session);
    if (!tracked) return;
    const summary = summarize(tracked.id, session);
    const text = JSON.stringify(summary);
    if (text !== tracked.last) {
      tracked.last = text;
      this.#dispatch({ type: "sessionPhase", ...summary });
    }
    if (!tracked.releasing && releasing(session.phase$.snapshot())) {
      tracked.releasing = true;
      // Wait for the whole close after the transition's effects start it.
      void Promise.resolve()
        .then(() => session.closeSettled())
        .catch(() => {})
        .then(() => this.#release(session));
    }
  }
  /** Report a session's final phase once and stop following it. */
  #release(session) {
    const tracked = this.#tracked.get(session);
    if (!tracked) return;
    tracked.subscription.unsubscribe();
    this.#tracked.delete(session);
    this.#byId.delete(tracked.id);
    this.#released.add(session);
    this.#dispatch({ type: "sessionPhase", ...released(tracked.id, session) });
  }
  #dispatch(event) {
    const result = reloadGateMachine.step(this.store.snapshot(), event);
    if (result.rejected) return result;
    this.store.update(() => result.state);
    for (const effect of result.effects) this.#perform(effect);
    const state = this.store.snapshot();
    if (state.name !== "waiting") {
      this.#timer?.unsubscribe();
      this.#timer = null;
      if (this.#waiters.length) {
        const outcome = outcomeOf(state);
        for (const resolve of this.#waiters.splice(0)) resolve(outcome);
      }
    }
    return result;
  }
  #perform(effect) {
    switch (effect.type) {
      case "pauseEdits":
        for (const id of effect.ids) this.#byId.get(id)?.pauseEdits?.("reload");
        return;
      case "resumeEdits":
        // Release only this attempt's pause; a protocol floor keeps its own.
        for (const id of effect.ids) this.#byId.get(id)?.pauseEdits?.("reload", false);
        return;
      case "requestSave": {
        // A stalled save gets the same retry as the Retry button. Otherwise
        // ask for a receipt; an in-flight one for these heads is reused.
        const session = this.#byId.get(effect.id);
        if (effect.retry) void session?.retryConnection({ retryReceipt: true });
        else session?.queueSaved();
        return;
      }
      case "checkpoint":
        // The session reports `writing`, then `written` or `failed`.
        void this.#byId.get(effect.id)?.checkpointForSchema?.();
        return;
      case "startTimer":
        this.#timer?.unsubscribe();
        this.#timer = timer(effect.ms, this.scheduler).subscribe(() => {
          this.#timer = null;
          if (this.store.snapshot().name === "waiting") this.#dispatch({ type: "timeout" });
        });
        return;
      case "reload":
        this.#reload();
        return;
    }
    throw new Error(`unknown effect ${effect.type}`);
  }
  /** Returns { ok: true } after calling reload, or { ok: false, ... }:
   * - { message } when an open Page or comment draft can't be saved;
   * - { reason: "unsaved", pages, message } when a closed Page's checkpoint
   *   failed: download or discard each (`discard` takes their keys);
   * - { reason: "checkpointed", pages, message } when closed Pages wait in
   *   IndexedDB; pass acceptCheckpoints to reload anyway;
   * - { cancelled: true } when navigation changed what to save. */
  reload({
    reload = () => globalThis.location.reload(),
    acceptCheckpoints = false,
    discard = [],
  } = {}) {
    this.#reload = reload;
    return new Promise((resolve) => {
      const state = this.store.snapshot();
      // The banner disables Reload while an attempt waits, and after it
      // reloads; a second call joins the attempt or repeats the reload.
      if (state.name === "reloading") {
        reload();
        resolve({ ok: true });
        return;
      }
      this.#waiters.push(resolve);
      if (state.name !== "waiting")
        this.#dispatch({ type: "reload", acceptCheckpoints, discard: [...discard] });
    });
  }
  /** A source of comment drafts. `set(true)` while it holds an unsent
   * draft; `stop()` when it unmounts. */
  watchDrafts() {
    const source = {};
    this.#drafts.set(source, false);
    return {
      set: (present) => {
        if (!this.#drafts.has(source)) return;
        this.#drafts.set(source, !!present);
        this.#syncDrafts();
      },
      stop: () => {
        this.#drafts.delete(source);
        this.#syncDrafts();
      },
    };
  }
  hasDrafts() {
    return this.store.snapshot().drafts;
  }
  #syncDrafts() {
    const present = [...this.#drafts.values()].some(Boolean);
    if (present !== this.store.snapshot().drafts) this.#dispatch({ type: "draft", present });
  }
}

export const reloadGate = new ReloadGate();
