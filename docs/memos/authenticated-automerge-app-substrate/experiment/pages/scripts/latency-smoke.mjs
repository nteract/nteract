import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
// Generated local OIDC fixtures only; native frames are observed, never changed.
// Run against scripts/dev.mjs: node scripts/latency-smoke.mjs
const origin = process.env.PAGES_ORIGIN || "http://localhost:9894";
assert.equal(new URL(origin).hostname, "localhost");
const reportPath = process.env.PAGES_LATENCY_REPORT || "/tmp/pages-latency-smoke.json";
const historyChanges = Number(process.env.PAGES_HISTORY_CHANGES || 500);
assert.ok(Number.isSafeInteger(historyChanges) && historyChanges >= 100 && historyChanges <= 900);
const epoch = () => performance.timeOrigin + performance.now();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const browser = await chromium.launch({ headless: true });
const frames = [],
  errors = [],
  receipts = [],
  initial = [],
  phases = [];
const output = {
  origin,
  mode: "local-generated-OIDC; same-context tabs; headless",
  frames,
  errors,
  receipts,
  initial,
  phases,
};
const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWX";
assert.equal(chars.length, 50);
const content = (page) => page.locator("wg-content").first();
const saved = (page) =>
  expect(page.getByRole("status", { name: "All changes saved", exact: true })).toBeVisible({
    timeout: 30000,
  });
const cleanText = (editor) =>
  editor.evaluate((el) => {
    const c = el.cloneNode(true);
    c.querySelectorAll(
      ".peer-caret,.wordgard-widget,.wordgard-diagram-actions,select,button",
    ).forEach((n) => n.remove());
    return c.textContent;
  });
// Resolve authority once per exact mutation request, and preserve it if a caller
// retries after an uncertain response. Reads and receipt timings stay separate.
const requestsByPage = new WeakMap();
async function call(page, operation, args = {}) {
  if (args.idempotency_key && !args.retry_token) {
    let requests = requestsByPage.get(page);
    if (!requests) requestsByPage.set(page, (requests = new Map()));
    const key = JSON.stringify([operation, args.idempotency_key]);
    const fingerprint = JSON.stringify(args);
    let request = requests.get(key);
    if (!request) {
      const catalog = ["create_page", "delete_page"].includes(operation);
      const authority = await rawCall(
        page,
        catalog ? "list_pages" : "read_page",
        catalog ? {} : { page_id: args.page_id },
      );
      assert.equal(typeof authority.retry_token, "string");
      assert.match(authority.retry_key_prefix, /^v1_[a-f0-9]{64}_$/);
      request = {
        fingerprint,
        args: structuredClone({
          ...args,
          retry_token: authority.retry_token,
          idempotency_key: authority.retry_key_prefix + args.idempotency_key,
        }),
      };
      requests.set(key, request);
    }
    assert.equal(request.fingerprint, fingerprint, "fixture retry must keep its original payload");
    args = request.args;
  }
  return rawCall(page, operation, args);
}
async function rawCall(page, operation, args = {}) {
  const response = await page.request.post(origin + "/api/tools", {
    headers: { Origin: origin, "X-Pages-Driver": "Wordgard latency fixture" },
    data: { operation, arguments: args },
    timeout: 15000,
  });
  const body = await response.json();
  if (!response.ok()) throw Error(body.error || "fixture tool failed");
  return body;
}
async function calibrate(page) {
  const samples = [];
  for (let i = 0; i < 5; i++) {
    const start = epoch();
    const browserTime = await page.evaluate(() => performance.timeOrigin + performance.now());
    const end = epoch();
    samples.push({ rtt: end - start, browser_minus_node: browserTime - (start + end) / 2 });
  }
  return samples.sort((a, b) => a.rtt - b.rtt)[0];
}
async function install(page, base) {
  await page.evaluate(
    ({ base, chars }) => {
      const el = document.querySelector("wg-content");
      if (!el) throw Error("Wordgard content is not mounted");
      const state = {
        base,
        chars,
        seen: Array(chars.length).fill(null),
        mutations: [],
        input: [],
        beforeinput: [],
        keydown: [],
      };
      const now = () => performance.timeOrigin + performance.now();
      const text = () => {
        const c = el.cloneNode(true);
        c.querySelectorAll(
          ".peer-caret,.wordgard-widget,.wordgard-diagram-actions,select,button",
        ).forEach((n) => n.remove());
        return c.textContent;
      };
      let batch = 0;
      const inspect = () => {
        const value = text();
        if (!value.startsWith(base)) return;
        const rest = value.slice(base.length);
        let matched = 0;
        while (matched < chars.length && rest[matched] === chars[matched]) matched++;
        const at = now(),
          indices = [];
        batch++;
        for (let i = 0; i < matched; i++)
          if (!state.seen[i]) {
            state.seen[i] = { at, batch };
            indices.push(i);
          }
        if (indices.length) state.mutations.push({ at, indices });
      };
      const listeners = [];
      for (const kind of ["beforeinput", "input", "keydown"]) {
        const fn = (e) =>
          state[kind].push({
            at: now(),
            data: e.data ?? null,
            key: e.key ?? null,
            inputType: e.inputType ?? null,
          });
        el.addEventListener(kind, fn, true);
        listeners.push([kind, fn]);
      }
      const observer = new MutationObserver(inspect);
      observer.observe(el, { subtree: true, childList: true, characterData: true });
      window.__latency = {
        state,
        stop: () => {
          observer.disconnect();
          for (const [kind, fn] of listeners) el.removeEventListener(kind, fn, true);
        },
      };
    },
    { base, chars },
  );
}
function stat(values) {
  const x = values.filter(Number.isFinite).sort((a, b) => a - b);
  return {
    n: x.length,
    p50: x[Math.ceil(x.length * 0.5) - 1] ?? null,
    p95: x[Math.ceil(x.length * 0.95) - 1] ?? null,
    max: x.at(-1) ?? null,
    min: x[0] ?? null,
  };
}

function observe(label, page) {
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/saved")
      receipts.push({ label, event: "request", at: epoch() });
  });
  page.on("requestfailed", (request) => {
    if (new URL(request.url()).pathname === "/api/saved")
      receipts.push({ label, event: "failed", at: epoch(), error: request.failure()?.errorText });
  });
  page.on("pageerror", (e) => errors.push({ label, message: e.message }));
  page.on("websocket", (ws) => {
    frames.push({ label, event: "open", at: epoch() });
    for (const event of ["framesent", "framereceived"])
      ws.on(event, ({ payload }) =>
        frames.push({
          label,
          event,
          at: epoch(),
          bytes: typeof payload === "string" ? Buffer.byteLength(payload) : payload.length,
        }),
      );
    ws.on("close", () => frames.push({ label, event: "close", at: epoch() }));
  });
  page.on("response", (r) => {
    if (new URL(r.url()).pathname === "/api/saved")
      receipts.push({ label, event: "response", at: epoch(), status: r.status() });
  });
}
async function login(context) {
  const page = await context.newPage();
  await page.goto(origin + "/api/auth/login");
  // Keep the fixture's API driver out of the editor while growing its history.
  await page.goto(origin + "/api/auth/session");
  const auth = await page.evaluate(() => fetch("/api/auth/session").then((r) => r.json()));
  assert.ok(auth.identity, "generated local OIDC login succeeded");
  return page;
}
async function nativeRecords(page, pageId) {
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
    return Promise.all(
      names.map(async (name) => {
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
          return {
            commit_records: keys.filter((k) => String(k).includes("/commits/")).length,
            fragment_records: keys.filter((k) => String(k).includes("/fragments/")).length,
          };
        } finally {
          db.close();
        }
      }),
    );
  }, pageId);
}
async function openPair(context, pageId, expected, phase) {
  const pair = [];
  for (const label of ["A", "B"]) {
    const page = await context.newPage();
    pair.push(page);
    observe(label, page);
    const sample = {
      phase,
      label,
      navigation_at: epoch(),
      browser_cache: label === "A" ? "cold IndexedDB" : "shared local checkpoint",
    };
    initial.push(sample);
    await page.goto(origin + "/p/" + pageId);
    await expect(content(page)).toHaveText(expected, { timeout: 30000 });
    sample.navigation_to_content_ms = epoch() - sample.navigation_at;
    await saved(page);
    sample.navigation_to_saved_ms = epoch() - sample.navigation_at;
    if (label === "A") sample.native_records = await nativeRecords(page, pageId);
  }
  return pair;
}

async function measure(name, a, b) {
  const editors = [content(a), content(b)];
  const timeOrigins = await Promise.all(
    [a, b].map((p) => p.evaluate(() => performance.timeOrigin)),
  );
  output.clock = { A: await calibrate(a), B: await calibrate(b) };

  const base = await cleanText(editors[0]);
  assert.equal(await cleanText(editors[1]), base);
  await a.bringToFront();
  await editors[0].focus();
  await editors[0].evaluate((el) => {
    const s = getSelection();
    s.selectAllChildren(el);
    s.collapseToEnd();
  });
  await Promise.all([a, b].map((p) => install(p, base)));
  const start = epoch(),
    dispatch = [];
  for (let i = 0; i < chars.length; i++) {
    await sleep(Math.max(0, start + i * 100 - epoch()));
    const before = epoch();
    await a.keyboard.type(chars[i]);
    dispatch.push({ index: i, char: chars[i], before, after: epoch() });
  }
  let converged = true;
  try {
    await b.waitForFunction(
      () => window.__latency.state.seen.at(-1) !== null,
      {},
      { timeout: 30000 },
    );
  } catch {
    converged = false;
  }
  const [local, remote] = await Promise.all(
    [a, b].map((p) =>
      p.evaluate(() => {
        window.__latency.stop();
        return window.__latency.state;
      }),
    ),
  );
  const relevant = frames.filter((f) => f.at >= start);
  const localOffset = output.clock.A.browser_minus_node,
    remoteOffset = output.clock.B.browser_minus_node;
  const rows = dispatch.map((d, i) => {
    const li = local.beforeinput[i]?.at ?? local.input[i]?.at;
    const ld = local.seen[i]?.at,
      rd = remote.seen[i]?.at;
    const firstOut = relevant.find(
      (f) => f.label === "A" && f.event === "framesent" && f.at >= li - localOffset,
    );
    const lastIn = relevant
      .filter((f) => f.label === "B" && f.event === "framereceived" && f.at <= rd - remoteOffset)
      .at(-1);
    return {
      index: i,
      char: d.char,
      dispatch_at: d.before,
      local_input_at: li,
      local_dom_at: ld,
      remote_dom_at: rd,
      remote_batch: remote.seen[i]?.batch,
      dispatch_to_input_ms: li - localOffset - d.before,
      input_to_local_dom_ms: ld - li,
      local_to_remote_dom_ms: rd - remoteOffset - (ld - localOffset),
      input_to_remote_dom_ms: rd - remoteOffset - (li - localOffset),
      first_outbound_after_input_ms: firstOut ? firstOut.at - (li - localOffset) : null,
      last_inbound_to_remote_dom_ms: lastIn ? rd - remoteOffset - lastIn.at : null,
    };
  });
  const stage = {};
  for (const key of [
    "dispatch_to_input_ms",
    "input_to_local_dom_ms",
    "local_to_remote_dom_ms",
    "input_to_remote_dom_ms",
    "first_outbound_after_input_ms",
    "last_inbound_to_remote_dom_ms",
  ])
    stage[key] = stat(rows.map((r) => r[key]));
  const counts = remote.mutations.map((m) => m.indices.length),
    gaps = remote.mutations.slice(1).map((m, i) => m.at - remote.mutations[i].at);
  const phase = {
    name,
    converged,
    clock: output.clock,
    stage,
    remote_batches: counts.length,
    remote_batch_sizes: counts,
    remote_arrival_gap_ms: stat(gaps),
    dispatch_interval_ms: stat(dispatch.slice(1).map((d, i) => d.before - dispatch[i].before)),
    rows,
    local,
    remote,
    dispatch,
    frame_counts: {
      A_sent: relevant.filter((f) => f.label === "A" && f.event === "framesent").length,
      B_received: relevant.filter((f) => f.label === "B" && f.event === "framereceived").length,
    },
  };
  phases.push(phase);
  console.log(
    "PHASE",
    JSON.stringify({
      name,
      converged,
      stage,
      remote_batches: counts.length,
      remote_batch_sizes: counts,
      remote_arrival_gap_ms: phase.remote_arrival_gap_ms,
      dispatch_interval_ms: phase.dispatch_interval_ms,
      frame_counts: phase.frame_counts,
    }),
  );
  assert.equal(converged, true);
  assert.equal(await cleanText(editors[0]), await cleanText(editors[1]));
  for (const p of [a, b]) await saved(p);
  phase.saved = true;
  console.log("SAVED", JSON.stringify({ name }));
  assert.deepEqual(
    await Promise.all([a, b].map((p) => p.evaluate(() => performance.timeOrigin))),
    timeOrigins,
  );
}

try {
  let context = await browser.newContext();
  let control = await login(context);
  const created = await call(control, "create_page", {
    title: "Local latency fixture " + Date.now(),
    markdown: "Latency fixture.",
    idempotency_key: crypto.randomUUID(),
  });
  output.page_id = created.page_id;
  let [a, b] = await openPair(context, created.page_id, "Latency fixture.", "fresh");
  output.visibility = await Promise.all(
    [a, b].map((p) => p.evaluate(() => document.visibilityState)),
  );
  await measure("warm", a, b);
  await sleep(20000);
  await measure("after_20s_idle", a, b);
  const before = await nativeRecords(a, created.page_id);
  await context.close();
  context = await browser.newContext();
  control = await login(context);
  const authority = await call(control, "read_page", { page_id: created.page_id });
  let heads = authority.heads;
  assert.equal(typeof authority.retry_token, "string");
  assert.match(authority.retry_key_prefix, /^v1_[a-f0-9]{64}_$/);
  const start = epoch(),
    timings = [];
  output.aging = {
    requested: historyChanges,
    before,
    body_changes: false,
    viewers_connected: false,
    timings,
  };
  for (let i = 0; i < historyChanges && epoch() - start < 180000; i++) {
    const at = epoch();
    const receipt = await call(control, "edit_page", {
      page_id: created.page_id,
      base_heads: heads,
      retry_token: authority.retry_token,
      idempotency_key: authority.retry_key_prefix + crypto.randomUUID(),
      operations: [{ op: "set_title", title: "Latency history " + (i % 2 === 0 ? "A" : "B") }],
    });
    assert.notDeepEqual(receipt.heads, heads, "each awaited mutation creates a distinct change");
    heads = receipt.heads;
    timings.push(epoch() - at);
    if (timings.length % 50 === 0)
      console.log(
        "AGING",
        JSON.stringify({ completed: timings.length, elapsed_ms: epoch() - start }),
      );
  }
  Object.assign(output.aging, {
    completed: timings.length,
    elapsed_ms: epoch() - start,
    request_ms: stat(timings),
  });
  assert.equal(timings.length, historyChanges, "history growth exceeded its three-minute budget");
  await context.close();
  context = await browser.newContext();
  control = await login(context);
  [a, b] = await openPair(
    context,
    created.page_id,
    "Latency fixture." + chars.repeat(2),
    "aged_history",
  );
  const cold = initial.find((sample) => sample.phase === "aged_history" && sample.label === "A");
  output.aging.after = cold.native_records;
  // Record compaction can consolidate many changes into one retained snapshot.
  // Keep physical record counts diagnostic instead of equating them with edits.
  assert.ok(
    cold.native_records.some((replica) => replica.commit_records + replica.fragment_records > 0),
    "cold replica persisted native records",
  );
  for (const page of [a, b])
    await expect(page.getByRole("textbox", { name: "Page title", exact: true })).toHaveValue(
      "Latency history " + ((historyChanges - 1) % 2 === 0 ? "A" : "B"),
    );
  await measure("aged_history", a, b);
  output.caveat =
    "DOM prefix times are observer observations; cross-page durations use calibrated clock offsets. Physical record counts are not edit counts after compaction. WebSocket nearest-frame timings are passive correlations, not decoded causal send/host/projection stages. Clock uncertainty is approximately half calibration RTT. A is cold IndexedDB at each pair opening; B can import A's shared local checkpoint. Native record counts inspect only this fixture's browser stores. Headless visibility is not background proof. This local fixture has no object-storage network latency.";
  assert.deepEqual(errors, []);
  output.complete = true;
  console.log(
    "COMPLETE",
    JSON.stringify({
      initial,
      visibility: output.visibility,
      errors,
      aging: { ...output.aging, timings: undefined },
    }),
  );
} catch (error) {
  output.failure = { name: error.name, message: error.message };
  output.visible = await Promise.all(
    browser
      .contexts()
      .flatMap((c) => c.pages())
      .map((p) =>
        p
          .evaluate(() => ({
            path: location.pathname,
            text: document.body.innerText.slice(0, 3000),
          }))
          .catch(() => ({ closed: true })),
      ),
  );
  console.error(error);
  process.exitCode = 1;
} finally {
  await writeFile(reportPath, JSON.stringify(output, null, 2));
  await browser.close();
}
