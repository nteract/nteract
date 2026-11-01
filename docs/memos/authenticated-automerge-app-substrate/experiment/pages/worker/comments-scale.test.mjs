import assert from "node:assert/strict";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import { applyComment } from "../model/comments.mjs";
import { fixture } from "./trash-fixture.mjs";

// A heavily commented Page under tool writes (#4654). celld counts a request
// against the Page's per-cell limit until its context is quiet: response sent,
// waitUntil promises settled, and every timer it created fired or cleared. So
// a write must leave no timer behind, its background work must settle quickly,
// and reads during that window must still answer.

const THREADS = 200;
const MESSAGES = 1000;
/** Generous for CI; the local in-process cost is tens of milliseconds. A
 * regression that re-resolves or re-projects the whole comments document per
 * write lands well above it. */
const BUDGET = Object.freeze({ handlerMs: 1500, backgroundMs: 1500 });

const sorted = (values) => [...values].sort((a, b) => a - b);
const quantile = (values, q) =>
  sorted(values)[Math.min(values.length - 1, Math.floor(q * values.length))];

/** Record every timer set while `run` executes, and which of them were cleared
 * or fired afterwards. Timers a request leaves pending are what celld waits for. */
async function timersLeftBy(t, run) {
  const set = globalThis.setTimeout;
  const clear = globalThis.clearTimeout;
  const pending = new Map();
  let next = 0;
  const trackedSet = (fn, ms, ...rest) => {
    const id = ++next;
    const handle = set(
      (...args) => {
        pending.delete(handle);
        return fn(...args);
      },
      ms,
      ...rest,
    );
    pending.set(handle, { id, ms });
    return handle;
  };
  const trackedClear = (handle) => {
    pending.delete(handle);
    return clear(handle);
  };
  globalThis.setTimeout = trackedSet;
  globalThis.clearTimeout = trackedClear;
  try {
    const result = await run();
    return { result, pending: () => [...pending.values()] };
  } finally {
    globalThis.setTimeout = set;
    globalThis.clearTimeout = clear;
  }
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

test(
  "a patch_page on a Page with 200 threads and 1,000 messages stays within budget and leaves nothing pending",
  { timeout: 120_000 },
  async (t) => {
    const { f, read, retry, threads, commentWriteP50 } = await heavyPage(t);
    await settled(f);
    f.tasks.length = 0;
    const before = f.commentHeads();

    const edit = await timersLeftBy(t, async () => {
      const t0 = performance.now();
      const response = await f.tool("owner", "patch_page", {
        base_heads: read.body.heads,
        ...retry(),
        operations: [
          {
            op: "replace_match",
            block_id: f.blockId,
            match_text: "Friday",
            replacement: "Friday",
          },
        ],
      });
      return { response, handlerMs: performance.now() - t0 };
    });
    assert.equal(edit.result.response.status, 200, JSON.stringify(edit.result.response.body));
    assert.ok(
      edit.result.handlerMs < BUDGET.handlerMs,
      `patch_page took ${Math.round(edit.result.handlerMs)} ms`,
    );

    // Reads during the post-edit window answer with the edit applied.
    const during = await Promise.all([
      f.tool("owner", "read_page", { comments: "none" }),
      f.tool("owner", "list_page_comments", { include_messages: false }),
      f.tool("owner", "read_page_presence", {}),
    ]);
    for (const response of during)
      assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual(during[0].body.heads, edit.result.response.body.heads);
    assert.deepEqual(f.commentHeads(), before, "a Page edit never touches the comments document");

    const backgroundMs = await settled(f);
    assert.ok(
      backgroundMs < BUDGET.backgroundMs,
      `background work took ${Math.round(backgroundMs)} ms`,
    );
    // The caret's fade and expiry travel with the presence entry; no timer
    // outlives the request to announce them.
    assert.deepEqual(
      edit.pending().map((timer) => timer.ms),
      [],
      "a Page edit leaves no timer pending",
    );
    const [agent] = f.page.activity.snapshot().agents;
    assert.equal(agent.state, "active");
    assert.ok(agent.idle_at && agent.expires_at);

    // A comment write on the same Page, likewise.
    const comment = await timersLeftBy(t, () =>
      f.tool("owner", "manage_page_comment", {
        action: "reply",
        thread_id: threads[0],
        body: "after the edit",
        ...retry(),
      }),
    );
    assert.equal(comment.result.status, 200, JSON.stringify(comment.result.body));
    await settled(f);
    assert.deepEqual(comment.pending(), [], "a comment write leaves no timer pending");
    t.diagnostic(
      `patch_page ${Math.round(edit.result.handlerMs)} ms, background ${Math.round(backgroundMs)} ms, tool comment write p50 ${Math.round(commentWriteP50)} ms at ~${MESSAGES} messages`,
    );
  },
);
