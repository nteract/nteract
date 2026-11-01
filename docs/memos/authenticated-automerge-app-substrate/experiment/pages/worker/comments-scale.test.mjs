import assert from "node:assert/strict";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import { applyComment } from "../model/comments.mjs";
import { fixture } from "./trash-fixture.mjs";
import { BufferedRecordStore } from "./record-persistence.mjs";

// A heavily commented Page under tool writes (#4654). celld counts a request
// against the Page's per-cell limit until its context is quiet: response sent,
// waitUntil promises settled, and every timer it created fired or cleared. So
// a write must leave no timer behind, its background work must settle quickly,
// and reads during that window must still answer.

const THREADS = 200;
const MESSAGES = 1000;
/** Generous for CI; the local in-process handler cost is tens of milliseconds,
 * and the background work is the one-second persistence flush wait plus the
 * flush. A regression that re-resolves or re-projects the whole comments
 * document per write, or chains another timer, lands well above these. */
const BUDGET = Object.freeze({ handlerMs: 1500, backgroundMs: 2500 });

const sorted = (values) => [...values].sort((a, b) => a - b);
const quantile = (values, q) =>
  sorted(values)[Math.min(values.length - 1, Math.floor(q * values.length))];

/**
 * Track every timer set while installed, including timers a timer's callback
 * sets, and which were cleared or fired. Stays installed until `stop()`, so a
 * chain that starts after the handler answers (a short timer whose callback
 * sets a long one) is seen whole. A tracked timer still pending after the
 * request's background work has settled is what celld keeps waiting for.
 */
function trackTimers() {
  const set = globalThis.setTimeout;
  const clear = globalThis.clearTimeout;
  const pending = new Map();
  const seen = [];
  let next = 0;
  globalThis.setTimeout = (fn, ms, ...rest) => {
    const timer = { id: ++next, ms: ms ?? 0 };
    seen.push(timer);
    const handle = set(
      (...args) => {
        pending.delete(handle);
        return fn(...args);
      },
      ms,
      ...rest,
    );
    pending.set(handle, timer);
    return handle;
  };
  globalThis.clearTimeout = (handle) => {
    const timer = pending.get(handle);
    if (timer) timer.cleared = true;
    pending.delete(handle);
    return clear(handle);
  };
  return {
    pending: () => [...pending.values()],
    /** Timers that ran or still wait: a cleared timer held nothing. */
    held: () => seen.filter((timer) => !timer.cleared),
    /** Let the Page's background work settle and short timers fire, so a timer
     * set by another timer's callback shows up. Stops early when nothing short
     * is pending; a long timer is left for the caller to see. */
    async drain(f, { shortMs = 1500, limitMs = 5000 } = {}) {
      const t0 = performance.now();
      for (;;) {
        await settled(f);
        const short = [...pending.values()].filter((timer) => timer.ms < shortMs);
        if (!short.length || performance.now() - t0 > limitMs) break;
        // The wait itself is not tracked.
        await new Promise((resolve) => set(resolve, Math.min(...short.map((t) => t.ms)) + 5));
      }
      return performance.now() - t0;
    },
    stop() {
      for (const handle of pending.keys()) clear(handle);
      globalThis.setTimeout = set;
      globalThis.clearTimeout = clear;
    },
  };
}

/** Settle the Page's background work and say how long it took. */
async function settled(f) {
  const t0 = performance.now();
  // Tasks can enqueue more tasks while they run.
  for (let seen = 0; seen < f.tasks.length; ) {
    const batch = f.tasks.slice(seen);
    seen = f.tasks.length;
    await Promise.allSettled(batch);
  }
  return performance.now() - t0;
}

/**
 * Give the fixture Page the production record path: a BufferedRecordStore
 * over an in-memory PageRecords, dirtied by every repo flush, which schedules
 * the one-second persistence flush under waitUntil. The fixture's repo is a
 * stub, so no document records flow through it on their own; this stands in
 * for the records a real flush saves.
 */
function bufferedPersistence(f) {
  const committed = [];
  const sink = {
    async *snapshot() {},
    async commit(batch) {
      committed.push(batch.map(([key]) => key));
    },
  };
  const store = new BufferedRecordStore(sink, { onDirty: () => f.page.schedulePersistence() });
  f.page.recordStore = store;
  let records = 0;
  const flush = f.page.repo.flush.bind(f.page.repo);
  f.page.repo.flush = async (...args) => {
    await flush(...args);
    await store.save(`commit/${records++}`, new Uint8Array(16));
  };
  return { store, committed };
}

async function heavyPage(t) {
  const f = await fixture(t, { memberRole: "commenter" });
  const who = { principal: f.member, displayName: "Member", driver: "Browser" };
  const page = f.page.handle.doc();
  // Most of the history lands as native changes, one per message, as browser
  // comments do. Tool writes then add the last threads and replies, so the
  // journal, retry tokens and receipts are exercised on top of it.
  const toolWrites = 40;
  const threads = [];
  await f.page.commentsHandle.update((doc) => {
    let next = doc;
    for (let i = 0; i < MESSAGES - toolWrites; i++) {
      next = A.change(next, (draft) => {
        // The fixture's own thread is one of the 200.
        if (threads.length < THREADS - 1 - toolWrites / 2) {
          const result = applyComment(
            draft,
            {
              action: "add",
              block_id: f.blockId,
              body: `Thread ${i} **bold** with some text to make it realistic.`,
              body_format: "markdown",
              ...(i % 3 === 0 ? { selected_text: "Friday" } : {}),
            },
            who,
            undefined,
            { page, role: "commenter" },
          );
          threads.push(result.thread_id);
        } else {
          applyComment(
            draft,
            { action: "reply", thread_id: threads[i % threads.length], body: `Reply ${i}` },
            who,
            undefined,
            { page, role: "commenter" },
          );
        }
      });
    }
    return next;
  });
  const read = await f.tool("owner", "read_page", { comments: "none" });
  assert.equal(read.status, 200);
  const retry = () => ({
    retry_token: read.body.retry_token,
    idempotency_key: read.body.retry_key_prefix + crypto.randomUUID(),
  });
  const latencies = [];
  for (let i = 0; i < toolWrites; i++) {
    const t0 = performance.now();
    const result =
      i % 2 === 0
        ? await f.tool("owner", "manage_page_comment", {
            action: "add",
            block_id: f.blockId,
            body: `Tool thread ${i}`,
            selected_text: "Friday",
            base_heads: read.body.heads,
            ...retry(),
          })
        : await f.tool("owner", "manage_page_comment", {
            action: "reply",
            thread_id: threads[i],
            body: `Tool reply ${i}`,
            ...retry(),
          });
    latencies.push(performance.now() - t0);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    if (i % 2 === 0) threads.push(result.body.result.thread_id);
  }
  const listed = await f.tool("owner", "list_page_comments", {
    include_messages: false,
    state: "all",
  });
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  const messages = listed.body.comments.reduce((n, thread) => n + thread.message_count, 0);
  assert.equal(listed.body.comments.length, THREADS);
  // The fixture's own thread adds one message.
  assert.equal(messages, MESSAGES + 1);
  return { f, read, retry, threads, commentWriteP50: quantile(latencies, 0.5) };
}

const patch = (f, read, retry) =>
  f.tool("owner", "patch_page", {
    base_heads: read.body.heads,
    ...retry(),
    operations: [
      { op: "replace_match", block_id: f.blockId, match_text: "Friday", replacement: "Friday" },
    ],
  });

test(
  "a patch_page on a Page with 200 threads and 1,000 messages stays within budget and leaves nothing pending",
  { timeout: 120_000 },
  async (t) => {
    const { f, read, retry, threads, commentWriteP50 } = await heavyPage(t);
    const persistence = bufferedPersistence(f);
    await settled(f);
    f.tasks.length = 0;
    const before = f.commentHeads();

    // Tracking stays on through the handler, its background work and the
    // short timers that work sets, so a chain is seen whole.
    const timers = trackTimers();
    t.after(() => timers.stop());
    const t0 = performance.now();
    const edit = await patch(f, read, retry);
    const handlerMs = performance.now() - t0;
    assert.equal(edit.status, 200, JSON.stringify(edit.body));
    assert.ok(handlerMs < BUDGET.handlerMs, `patch_page took ${Math.round(handlerMs)} ms`);

    // Reads during the post-edit window answer with the edit applied.
    const during = await Promise.all([
      f.tool("owner", "read_page", { comments: "none" }),
      f.tool("owner", "list_page_comments", { include_messages: false }),
      f.tool("owner", "read_page_presence", {}),
    ]);
    for (const response of during)
      assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual(during[0].body.heads, edit.body.heads);
    assert.deepEqual(f.commentHeads(), before, "a Page edit never touches the comments document");

    // The write's records flush one second later, under waitUntil: the one
    // hold a write keeps, and it ends when the flush does.
    const backgroundMs = await timers.drain(f);
    assert.ok(
      backgroundMs < BUDGET.backgroundMs,
      `background work took ${Math.round(backgroundMs)} ms`,
    );
    assert.deepEqual(
      timers.held().map((timer) => timer.ms),
      [1000],
      "one persistence flush timer held the write, and nothing else",
    );
    // The handler's own flush already committed the write's records; the
    // timer's flush found nothing left and did not reschedule.
    const commits = persistence.committed.length;
    assert.ok(commits >= 1, "the write's records reached PageRecords");
    assert.equal(persistence.store.dirty, false);
    // The caret's fade and expiry travel with the presence entry; no timer
    // outlives the request's background work to announce them.
    assert.deepEqual(
      timers.pending().map((timer) => timer.ms),
      [],
      "a Page edit leaves no timer pending",
    );
    const [agent] = f.page.activity.snapshot().agents;
    assert.equal(agent.state, "active");
    assert.ok(agent.idle_at && agent.expires_at);

    // A comment write on the same Page, likewise.
    const comment = await f.tool("owner", "manage_page_comment", {
      action: "reply",
      thread_id: threads[0],
      body: "after the edit",
      ...retry(),
    });
    assert.equal(comment.status, 200, JSON.stringify(comment.body));
    await timers.drain(f);
    assert.deepEqual(timers.pending(), [], "a comment write leaves no timer pending");
    assert.deepEqual(
      timers.held().map((timer) => timer.ms),
      [1000, 1000],
      "one more persistence flush timer, and nothing else",
    );
    assert.ok(persistence.committed.length > commits);
    assert.equal(persistence.store.dirty, false);
    t.diagnostic(
      `patch_page ${Math.round(handlerMs)} ms, background ${Math.round(backgroundMs)} ms, tool comment write p50 ${Math.round(commentWriteP50)} ms at ~${MESSAGES} messages`,
    );
  },
);

test("the tracker sees a long timer that a request timer's callback sets", async (t) => {
  // The shape presence used to have: a short timer from the handler whose
  // callback sets the long one. The handler has answered and its waitUntil
  // work has settled before the long timer exists.
  const f = await fixture(t);
  const read = await f.tool("owner", "read_page", { comments: "none" });
  const retry = () => ({
    retry_token: read.body.retry_token,
    idempotency_key: read.body.retry_key_prefix + crypto.randomUUID(),
  });
  const activity = f.page.activityState();
  const agentEvent = activity.agentEvent.bind(activity);
  t.mock.method(activity, "agentEvent", (...args) => {
    setTimeout(() => setTimeout(() => {}, 45_000), 1);
    return agentEvent(...args);
  });
  const timers = trackTimers();
  t.after(() => timers.stop());
  const edit = await patch(f, read, retry);
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
  await settled(f);
  // Checking only when the handler returns misses it.
  assert.deepEqual(
    timers.pending().map((timer) => timer.ms),
    [1],
    "before the drain, only the short timer shows",
  );
  await timers.drain(f);
  assert.deepEqual(
    timers.pending().map((timer) => timer.ms),
    [45_000],
    "the drain surfaces the timer the callback set",
  );
  assert.throws(() => assert.deepEqual(timers.pending(), []), assert.AssertionError);
});
