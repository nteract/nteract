// Tells an open tab when the Worker behind it has moved to another build.
//
// Every request through request.mjs reports its response headers here, so a
// reconnect (/api/connect), a save (/api/saved) or the session refresh
// (/api/auth/session) compares builds at no extra cost. /health is polled only
// when the tab becomes visible again and on a slow interval while visible.
import {
  PAGES_BUILD,
  VIEWER_PROTOCOL,
  advertisementFromHeaders,
  compareBuild,
  readAdvertisement,
  strongerBuildState,
} from "../shared/build-identity.mjs";

export const BUILD_CHECK_INTERVAL_MS = 10 * 60_000;
// A tab switched back and forth checks at most this often.
export const VISIBLE_RECHECK_MS = 30_000;
export const SAVE_BEFORE_RELOAD_MS = 15_000;

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
    now = Date.now,
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

const retryable = new Set(["Unsaved", "Offline", "Saved locally"]);
const unsavable = {
  "Sign in to sync": "Sign in again so your latest edits can save, then reload.",
  "Access removed":
    "Your latest edits can't be saved to this Page. Download the local draft before reloading.",
  "Access changed":
    "Your latest edits can't be saved to this Page. Download the local draft before reloading.",
  "Local save failed": "Your latest edits couldn't be saved on this device, so Pages won't reload.",
};

/** Resolve when every edit this tab accepted is durable on the host, or report
 * why it is not. Never resolves ok while edits are only local: a reload is
 * when an unsaved edit is most likely to be lost.
 * Returns { ok: true } or { ok: false, message }. */
export function saveBeforeReload(
  session,
  {
    timeoutMs = SAVE_BEFORE_RELOAD_MS,
    setTimeout: schedule = globalThis.setTimeout,
    clearTimeout: cancel = globalThis.clearTimeout,
  } = {},
) {
  if (!session || !session.alive || session.deleted || !session.recoveryPending)
    return Promise.resolve({ ok: true });
  const blocked = () => unsavable[session.status];
  if (blocked()) return Promise.resolve({ ok: false, message: blocked() });
  return new Promise((resolve) => {
    let timer;
    const finish = (result) => {
      cancel(timer);
      unsubscribe();
      resolve(result);
    };
    const inspect = () => {
      if (!session.alive || session.deleted || !session.recoveryPending) finish({ ok: true });
      else if (blocked()) finish({ ok: false, message: blocked() });
    };
    const unsubscribe = session.subscribe(inspect);
    timer = schedule(
      () =>
        finish({
          ok: false,
          message:
            "Your latest edits haven't saved yet, so Pages won't reload. Check your connection and try again.",
        }),
      timeoutMs,
    );
    // A stalled save gets the same retry as the Retry button. Otherwise ask for
    // a receipt; an in-flight one for these heads is reused, not restarted.
    if (retryable.has(session.status)) void session.retryConnection({ retryReceipt: true });
    else session.queueSaved();
    inspect();
  });
}

/** Pause edits, wait for accepted edits to save, then reload. If they can't
 * be saved, edits resume (unless `keepPaused`) and the reason is returned. */
export async function reloadWhenSaved(
  session,
  { reload = () => globalThis.location.reload(), keepPaused = false, ...options } = {},
) {
  session?.pauseEdits?.(true);
  const result = await saveBeforeReload(session, options);
  if (result.ok) reload();
  else if (!keepPaused) session?.pauseEdits?.(false);
  return result;
}
