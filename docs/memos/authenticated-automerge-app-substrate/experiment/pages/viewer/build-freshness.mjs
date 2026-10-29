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

// A Page being left keeps syncing this long for its receipt before closing.
export const CLOSE_DRAIN_MS = 10_000;
const drainingStates = new Set(["Connecting", "Reconnecting", "Saving"]);
export const UNSENT_COMMENT = "You have an unsent comment. Send or discard it before reloading.";
const keyOf = (account, pageId) => `${account}:${pageId}`;
const pageKey = (session) => keyOf(session.identity?.principal, session.pageId);
const names = (pages) => {
  const titles = pages.map((page) => page.title);
  return titles.length === 1 ? titles[0] : `${titles.slice(0, -1).join(", ")} and ${titles.at(-1)}`;
};
/** Closed Pages whose edits are only in this browser's IndexedDB checkpoint.
 * Reopening a Page imports its checkpoint and syncs it. */
export const checkpointedMessage = (pages) =>
  `Edits on ${names(pages)} haven't reached the server yet. They're saved in this browser and sync when you open ${pages.length === 1 ? "that Page" : "those Pages"} again.`;
/** Closed Pages whose final checkpoint failed: the edits exist nowhere else. */
export const unsavedMessage = (pages) =>
  `Edits on ${names(pages)} couldn't be saved in this browser and haven't reached the server. Download them before reloading, or they'll be lost.`;

/** Wait, without retrying, while a Page being left is still saving. Leaving
 * must not hang: offline or failed states end the wait and the local
 * checkpoint keeps the edits. Resolves true when the host has every edit. */
export function settleBeforeClose(
  session,
  {
    timeoutMs = CLOSE_DRAIN_MS,
    setTimeout: schedule = globalThis.setTimeout,
    clearTimeout: cancel = globalThis.clearTimeout,
  } = {},
) {
  // A deleted Page has nothing left to save. A closed replica can't report.
  const saved = () => {
    if (session.deleted) return true;
    try {
      return !session.recoveryPending;
    } catch {
      return false;
    }
  };
  const settled = () =>
    !session.alive || session.deleted || saved() || !drainingStates.has(session.status);
  if (settled()) return Promise.resolve(saved());
  return new Promise((resolve) => {
    const finish = () => {
      cancel(timer);
      unsubscribe();
      resolve(saved());
    };
    const unsubscribe = session.subscribe(() => {
      if (settled()) finish();
    });
    const timer = schedule(finish, timeoutMs);
  });
}

/** App-scope reload coordination. A reload replaces every Page this tab holds,
 * not only the visible one, so it waits for:
 * - the open Page's accepted edits (its receipt);
 * - Pages being left, which keep syncing until their receipt or CLOSE_DRAIN_MS;
 * - unsent comment drafts, which live only in React state.
 * Navigation during the wait cancels the attempt.
 *
 * A left Page holds its session only while it drains. Once closed, the gate
 * keeps plain metadata for a Page whose edits never reached the server:
 * { key, account, pageId, title, checkpointWritten }. When the IndexedDB
 * checkpoint failed, the record also keeps the recovery Markdown and the heads
 * it covers, since that export is the only copy left. Such a record goes away
 * only when a host receipt includes all of its heads, or when the person
 * confirms "Discard unsaved edits". Reopening the Page never clears it: the
 * reopened replica can't contain edits its checkpoint failed to write. */
export class ReloadGate {
  sessions = new Set();
  draining = new Set();
  closed = new Map();
  draftSources = new Set();
  epoch = 0;
  constructor({ timers = {}, closeTimeoutMs = CLOSE_DRAIN_MS } = {}) {
    Object.assign(this, { timers, closeTimeoutMs });
  }
  /** Track the open Page. It loads a checkpointed record's IndexedDB copy and
   * owns its receipt, so that record is superseded. */
  hold(session) {
    this.epoch++;
    const key = pageKey(session);
    if (this.closed.get(key)?.checkpointWritten) this.closed.delete(key);
    this.sessions.add(session);
  }
  /** Leave a Page: let it finish saving, then close it. Returns the close. */
  drainAndClose(session) {
    this.epoch++;
    this.sessions.delete(session);
    const key = pageKey(session);
    const page = { key, account: session.identity?.principal, pageId: session.pageId };
    let recovery;
    const closed = settleBeforeClose(session, { ...this.timers, timeoutMs: this.closeTimeoutMs })
      .catch(() => false)
      .then(async (saved) => {
        if (!saved) {
          // Read what a failed checkpoint would need while the document is live.
          try {
            page.title = session.doc?.title;
            recovery = session.exportRecovery?.();
          } catch {}
        }
        try {
          await session.close();
        } finally {
          page.saved = saved || !!session.deleted;
          page.checkpointWritten = session.checkpointWritten === true;
          page.savedHeads = [...(session.savedHeads ?? [])];
        }
      });
    const settled = closed
      .catch(() => {})
      .then(() => {
        this.draining.delete(settled);
        this.acknowledge(key, page.savedHeads);
        const previous = this.closed.get(key);
        if (page.saved) return;
        const { account, pageId, checkpointWritten } = page;
        const title = page.title?.trim() || "Untitled";
        if (checkpointWritten) {
          // A newer session superseded this checkpoint; a failed record stays.
          if (!previous && ![...this.sessions].some((open) => pageKey(open) === key))
            this.closed.set(key, { key, account, pageId, title, checkpointWritten });
          return;
        }
        // Each failed checkpoint is its own lost copy: keep every one.
        const lost = !previous?.checkpointWritten && previous;
        this.closed.set(key, {
          key,
          account,
          pageId,
          title,
          checkpointWritten: false,
          heads: [...(lost ? lost.heads : []), ...(recovery?.heads ?? [])],
          markdown: [lost?.markdown, recovery?.markdown ?? ""]
            .filter((part) => part !== undefined)
            .join("\n---\n\n"),
        });
      });
    this.draining.add(settled);
    return closed;
  }
  /** A session closing through its own flow, such as an access reload,
   * archives its recovery itself. Reload still waits for that close. */
  track(session, closing) {
    this.epoch++;
    this.sessions.delete(session);
    const settled = Promise.resolve(closing)
      .catch(() => {})
      .then(() => this.draining.delete(settled));
    this.draining.add(settled);
    return closing;
  }
  /** A host receipt for `savedHeads` makes a failed record covered by those
   * heads redundant. */
  acknowledge(key, savedHeads = []) {
    const record = this.closed.get(key);
    if (
      record &&
      !record.checkpointWritten &&
      record.heads.length > 0 &&
      record.heads.every((head) => savedHeads.includes(head))
    )
      this.closed.delete(key);
  }
  /** Forget a closed Page's unsent edits. Call only after the person confirmed
   * "Discard unsaved edits". */
  discard({ key }) {
    this.closed.delete(key);
  }
  watchDrafts(hasDraft) {
    this.draftSources.add(hasDraft);
    return () => this.draftSources.delete(hasDraft);
  }
  hasDrafts() {
    for (const hasDraft of this.draftSources) if (hasDraft()) return true;
    return false;
  }
  /** Returns { ok: true } after calling reload, or { ok: false, ... }:
   * - { message } when an open Page or comment draft can't be saved;
   * - { reason: "unsaved", pages, message } when a closed Page's checkpoint
   *   failed: download or discard each, then try again;
   * - { reason: "checkpointed", pages, message } when closed Pages wait in
   *   IndexedDB; pass acceptCheckpoints to reload anyway;
   * - { cancelled: true } when navigation changed what to save. */
  async reload({
    reload = () => globalThis.location.reload(),
    timeoutMs,
    acceptCheckpoints = false,
  } = {}) {
    if (this.hasDrafts()) return { ok: false, message: UNSENT_COMMENT };
    const epoch = this.epoch;
    const live = [...this.sessions].filter((session) => {
      if (session.alive && !session.deleted) return true;
      // Closed by its own flow (deletion, access reload, sign-out), which
      // keeps any recovery itself.
      this.sessions.delete(session);
      return false;
    });
    for (const session of live) session.pauseEdits?.("reload");
    let reloaded = false;
    try {
      const results = await Promise.all([
        ...live.map((session) => saveBeforeReload(session, { ...this.timers, timeoutMs })),
        ...[...this.draining].map((settled) => settled.then(() => ({ ok: true }))),
      ]);
      if (epoch !== this.epoch) return { ok: false, cancelled: true };
      if (this.hasDrafts()) return { ok: false, message: UNSENT_COMMENT };
      const failed = results.find((result) => !result.ok);
      if (failed) return failed;
      for (const session of live) this.acknowledge(pageKey(session), session.savedHeads);
      const closed = [...this.closed.values()].map((page) => ({ ...page }));
      const unsaved = closed.filter((page) => !page.checkpointWritten);
      if (unsaved.length)
        return { ok: false, reason: "unsaved", pages: unsaved, message: unsavedMessage(unsaved) };
      if (closed.length && !acceptCheckpoints)
        return {
          ok: false,
          reason: "checkpointed",
          pages: closed,
          message: checkpointedMessage(closed),
        };
      reloaded = true;
      reload();
      return { ok: true };
    } finally {
      // Release only this attempt's pause; a protocol floor keeps its own.
      if (!reloaded) for (const session of live) session.pauseEdits?.("reload", false);
    }
  }
}

export const reloadGate = new ReloadGate();
