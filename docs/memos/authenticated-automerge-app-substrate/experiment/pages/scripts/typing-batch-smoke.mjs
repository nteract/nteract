// Local OIDC + two browser writers on one Page. Never uses live credentials.
// Run against the built local Pages fixture; this script does not start servers.
//
// Types 200 characters into one writer at a person's pace (60–100 ms per key)
// and at 20 ms per key, then counts what that cost: Automerge changes the
// writer created, WebSocket frames and bytes it sent, and the main-thread time
// the other writer spent applying and drawing them. The other writer must end
// with the exact text. Each run prints a GATE line with the 20 ms phase's
// rounds and caret frames against their budget. PAGES_TYPING_MEASURE_ONLY=1
// skips the batching assertions so the same run can measure a build without
// batching. PAGES_TYPING_CPU_THROTTLE=<rate> slows both browsers' CPUs through
// CDP, to reproduce a slow runner where saves trail the keys.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { OUTBOUND_DEBOUNCE_MS, OUTBOUND_MAX_WAIT_MS } from "../viewer/outbound-sync-machine.mjs";

const origin = process.env.PAGES_ORIGIN || "http://localhost:9896";
const url = new URL(origin);
assert.equal(url.origin, origin);
assert.equal(url.hostname, "localhost");
const output = process.env.PAGES_SCREENSHOTS || "/tmp/pages-typing-batch";
await mkdir(output, { recursive: true });
const measureOnly = process.env.PAGES_TYPING_MEASURE_ONLY === "1";
const cpuThrottle = Number(process.env.PAGES_TYPING_CPU_THROTTLE || 1);
assert.ok(cpuThrottle >= 1, "PAGES_TYPING_CPU_THROTTLE must be 1 or more");
const CHARACTERS = 200;
const BASE = "Typing fixture.";
const epoch = () => performance.timeOrigin + performance.now();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const browser = await chromium.launch({
  headless: true,
  args: [
    "--no-proxy-server",
    "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1",
  ],
});
const report = { origin, measureOnly, cpuThrottle, phases: [], errors: [] };
const frames = [];
// Subduction 0.26 frames, as observed on the wire: "SUM", a zero byte, a u32
// length, then a message type byte for sync messages, "SUE" for ephemeral (presence)
// messages. Sync type 4 opens a sync round; type 0 carries one commit.
// An unrecognized frame fails the run, so a framing change can't skew the
// counts.
function frameKind(payload) {
  const bytes = Buffer.from(payload);
  const magic = bytes.subarray(0, 3).toString("latin1");
  if (magic === "SUE") return "presence";
  if (magic !== "SUM" || bytes.length < 9) return "unrecognized";
  return { 4: "round", 0: "commit" }[bytes[8]] ?? "other";
}
const content = (page) => page.locator(".page-block wg-content").first();
const cleanText = (page) =>
  content(page).evaluate((el) => {
    const c = el.cloneNode(true);
    c.querySelectorAll(
      ".peer-caret,.wordgard-widget,.wordgard-diagram-actions,select,button",
    ).forEach((n) => n.remove());
    return c.textContent.replace(/\u200b/g, "");
  });
const saved = (page) =>
  expect(page.getByRole("status").filter({ hasText: /^Saved$/ })).toBeVisible({ timeout: 30000 });

async function signIn(label) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  context.setDefaultTimeout(15000);
  const page = await context.newPage();
  page.on("pageerror", (error) => report.errors.push(`${label}: ${error.message.slice(0, 500)}`));
  page.on("websocket", (ws) => {
    for (const event of ["framesent", "framereceived"])
      ws.on(event, ({ payload }) =>
        frames.push({
          label,
          event,
          at: epoch(),
          bytes: typeof payload === "string" ? Buffer.byteLength(payload) : payload.length,
          kind: frameKind(payload),
        }),
      );
  });
  await page.goto(origin + "/api/auth/login", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("button", { name: /, switch page$/ })).toBeVisible({
    timeout: 20000,
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable", { timeDomain: "threadTicks" });
  if (cpuThrottle > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpuThrottle });
  return { page, cdp, label };
}

async function tool(page, operation, args = {}) {
  const { status, body } = await page.evaluate(
    async ({ operation, args }) => {
      const response = await fetch("/api/tools", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operation, arguments: args }),
      });
      return { status: response.status, body: await response.json() };
    },
    { operation, args },
  );
  if (status !== 200) throw Error(`${operation}: HTTP ${status} ${body?.code ?? ""}`);
  return body;
}

/** Commit records in this browser's native store for the Page. The browser
 * never compacts, so the count grows by one per Automerge change it made or
 * received. */
async function commitRecords(page, pageId) {
  return page.evaluate(async (pageId) => {
    const { identity } = await fetch("/api/auth/session").then((r) => r.json());
    const scope = Array.from(
      new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(identity.principal + "\0" + pageId),
        ),
      ),
      (b) => b.toString(16).padStart(2, "0"),
    ).join("");
    const names = (await indexedDB.databases())
      .map((d) => d.name)
      .filter((name) => name?.startsWith("pages-native-" + scope + "-"));
    let total = 0;
    for (const name of names) {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open(name);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        const keys = await new Promise((resolve, reject) => {
          const request = db.transaction("bytes", "readonly").objectStore("bytes").getAllKeys();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        total += keys.filter((k) => String(k).includes("/commits/")).length;
      } finally {
        db.close();
      }
    }
    return total;
  }, pageId);
}

const METRICS = ["TaskDuration", "ScriptDuration", "LayoutDuration", "RecalcStyleDuration"];
async function metrics(cdp) {
  const { metrics } = await cdp.send("Performance.getMetrics");
  return Object.fromEntries(
    metrics.filter((m) => METRICS.includes(m.name)).map((m) => [m.name, m.value * 1000]),
  );
}
const delta = (after, before) =>
  Object.fromEntries(METRICS.map((name) => [name, +(after[name] - before[name]).toFixed(1)]));

/** Count the receiving editor's DOM updates that changed its text. */
async function watchRenders(page) {
  await content(page).evaluate((el) => {
    const text = () => el.textContent;
    let last = text();
    const state = { renders: 0 };
    const observer = new MutationObserver(() => {
      const next = text();
      if (next !== last) state.renders++;
      last = next;
    });
    observer.observe(el, { subtree: true, childList: true, characterData: true });
    window.__typingRenders = { state, stop: () => observer.disconnect() };
  });
}
const stopRenders = (page) =>
  page.evaluate(() => {
    window.__typingRenders.stop();
    return window.__typingRenders.state.renders;
  });

// Deterministic per-key gaps, so before and after runs type the same rhythm.
function gaps(kind) {
  if (kind === "fast") return Array(CHARACTERS).fill(20);
  let seed = 7;
  return Array.from({ length: CHARACTERS }, () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return 60 + (seed % 41);
  });
}
/** Planned time from the first key to the last. */
const scheduled = (schedule) => schedule.slice(0, -1).reduce((n, gap) => n + gap, 0);
const SENTENCE = "The quick brown fox jumps over the lazy dog while the band plays on. ";
const typedText = (n) => SENTENCE.repeat(Math.ceil(n / SENTENCE.length)).slice(0, n);

async function phase(name, kind, writer, reader, pageId) {
  const text = typedText(CHARACTERS);
  const before = await cleanText(writer.page);
  assert.equal(await cleanText(reader.page), before);
  const expected = before + text;
  await content(writer.page).focus();
  await content(writer.page).evaluate((el) => {
    const s = getSelection();
    s.selectAllChildren(el);
    s.collapseToEnd();
    document.dispatchEvent(new Event("selectionchange"));
  });
  await sleep(300);
  const changesBefore = await commitRecords(writer.page, pageId);
  const readerChangesBefore = await commitRecords(reader.page, pageId);
  await watchRenders(reader.page);
  // Let presence and receipt traffic from placing the caret settle.
  await sleep(1500);
  const [writerBefore, readerBefore] = await Promise.all([
    metrics(writer.cdp),
    metrics(reader.cdp),
  ]);
  const start = epoch();
  const schedule = gaps(kind);
  let at = start;
  for (let i = 0; i < text.length; i++) {
    await sleep(Math.max(0, at - epoch()));
    await writer.page.keyboard.type(text[i]);
    at += schedule[i];
  }
  const typed = epoch();
  let converged = null;
  const deadline = typed + 30000;
  while (epoch() < deadline) {
    if ((await cleanText(reader.page)) === expected) {
      converged = epoch();
      break;
    }
    await sleep(10);
  }
  assert.ok(converged, `${name}: the reader never showed the exact typed text`);
  const [writerAfter, readerAfter] = await Promise.all([metrics(writer.cdp), metrics(reader.cdp)]);
  const renders = await stopRenders(reader.page);
  for (const { page } of [writer, reader]) await saved(page);
  const end = epoch();
  const window = frames.filter((f) => f.at >= start && f.at <= end);
  const sum = (list) => list.reduce((n, f) => n + f.bytes, 0);
  const sent = window.filter((f) => f.label === writer.label && f.event === "framesent");
  const received = window.filter((f) => f.label === reader.label && f.event === "framereceived");
  const rounds = sent.filter((f) => f.kind === "round");
  // Sends that leave later than one debounce after the last key are catch-up:
  // edits still reaching native storage when typing stopped. How long that
  // takes depends on the runner's store latency, not on batching.
  const typingEnd = typed + OUTBOUND_DEBOUNCE_MS;
  const late = sent.filter((f) => f.at > typingEnd && f.kind !== "commit");
  const result = {
    name,
    kind,
    characters: text.length,
    typing_ms: Math.round(typed - start),
    // How much longer the keys took to type than their schedule.
    typing_overrun_ms: Math.max(0, Math.round(typed - start - scheduled(schedule))),
    last_key_to_reader_ms: Math.round(converged - typed),
    writer_catchup_ms: late.length ? Math.round(late.at(-1).at - typingEnd) : 0,
    writer_typing_rounds: rounds.filter((f) => f.at <= typingEnd).length,
    writer_catchup_rounds: late.filter((f) => f.kind === "round").length,
    writer_catchup_presence_frames: late.filter((f) => f.kind === "presence").length,
    writer_changes: (await commitRecords(writer.page, pageId)) - changesBefore,
    reader_changes: (await commitRecords(reader.page, pageId)) - readerChangesBefore,
    writer_frames_sent: sent.length,
    writer_bytes_sent: sum(sent),
    writer_sync_rounds: rounds.length,
    writer_commit_frames: sent.filter((f) => f.kind === "commit").length,
    writer_presence_frames: sent.filter((f) => f.kind === "presence").length,
    reader_frames_received: received.length,
    reader_bytes_received: sum(received),
    reader_renders: renders,
    reader_main_thread_ms: delta(readerAfter, readerBefore),
    writer_main_thread_ms: delta(writerAfter, writerBefore),
  };
  // When each round left, relative to the last keystroke, for the report only.
  report.phases.push({ ...result, writer_round_ms: rounds.map((f) => Math.round(f.at - typed)) });
  assert.ok(
    window.every((f) => f.kind !== "unrecognized"),
    "an unrecognized native frame; requalify frameKind",
  );
  console.log("PHASE " + JSON.stringify(result));
  assert.equal(await cleanText(writer.page), expected);
  assert.equal(await cleanText(reader.page), expected);
  return result;
}

let writer, reader;
try {
  writer = await signIn("writer");
  reader = await signIn("reader");
  const authority = await tool(writer.page, "list_pages");
  const created = await tool(writer.page, "create_page", {
    title: "Typing batch fixture",
    markdown: BASE,
    retry_token: authority.retry_token,
    idempotency_key: authority.retry_key_prefix + crypto.randomUUID(),
  });
  const pageId = created.page_id;
  for (const { page } of [writer, reader]) {
    await page.goto(`${origin}/p/${pageId}`);
    await expect(content(page)).toContainText(BASE);
    await saved(page);
  }
  const person = await phase("60–100 ms per key", "person", writer, reader, pageId);
  const fast = await phase("20 ms per key", "fast", writer, reader, pageId);
  // Each keystroke used to open its own sync round and send its own caret.
  // At 20 ms per key a round and a caret now go out about every 100 ms, so 200
  // keys on schedule take about 40 of each; the budget allows four keys per
  // send. While requests keep arriving the writer sends at most once per
  // maximum wait, so time it spent past the schedule (keys typed late, then
  // catch-up) adds one send per maximum wait. Unbatched typing sends one per
  // key and stays far over budget unless catch-up runs past 15 seconds.
  // Commits still travel one frame each: that is native framing, one per
  // Automerge change.
  const lateMs = fast.typing_overrun_ms + fast.writer_catchup_ms;
  const budget = CHARACTERS / 4 + Math.ceil(lateMs / OUTBOUND_MAX_WAIT_MS);
  const gate = Object.fromEntries(
    ["writer_sync_rounds", "writer_presence_frames"].map((key) => [
      key,
      { measured: fast[key], budget, margin: budget - fast[key] },
    ]),
  );
  console.log("GATE " + JSON.stringify({ late_ms: lateMs, ...gate }));
  report.gate = gate;
  if (!measureOnly) {
    for (const [key, { measured }] of Object.entries(gate))
      assert.ok(
        measured <= budget,
        `20 ms typing: ${key} was ${measured} for ${CHARACTERS} characters; ` +
          `budget ${budget} with ${lateMs} ms typing overrun and catch-up`,
      );
    assert.ok(
      fast.writer_frames_sent < 2 * CHARACTERS,
      `20 ms typing sent ${fast.writer_frames_sent} frames for ${CHARACTERS} characters`,
    );
    assert.ok(
      person.writer_frames_sent <= 3 * CHARACTERS,
      `60–100 ms typing sent ${person.writer_frames_sent} frames for ${CHARACTERS} characters`,
    );
  }
  assert.deepEqual(report.errors, []);
  report.complete = true;
} catch (error) {
  report.failure = { name: error.name, message: error.message };
  for (const peer of [writer, reader].filter(Boolean))
    await peer.page
      .screenshot({ path: path.join(output, `failure-${peer.label}.png`), fullPage: true })
      .catch(() => {});
  console.error(error);
  process.exitCode = 1;
} finally {
  await writeFile(path.join(output, "typing-report.json"), JSON.stringify(report, null, 2));
  await browser.close();
}
