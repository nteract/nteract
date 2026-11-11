import assert from "node:assert/strict";
import test from "node:test";
import {
  createPageSourceResolver,
  sourceLoadStep,
  sourceResolverStep,
} from "./page-source-resolver.mjs";
import { PARQUET_MEDIA_TYPE } from "../shared/dataset-assets.mjs";

const pageId = "2ca661b0-7f60-4984-9438-01441e4b56b6";
const first = "a".repeat(64),
  second = "b".repeat(64);
test("load lifecycle covers every phase/event; disposal is terminal", () => {
  const expected = {
    fetching: ["decoding", "fetching", "failed", "disposed"],
    decoding: ["decoding", "ready", "failed", "disposed"],
    ready: ["ready", "ready", "ready", "disposed"],
    failed: ["failed", "failed", "failed", "disposed"],
    disposed: ["disposed", "disposed", "disposed", "disposed"],
  };
  const events = ["bytes", "decoded", "failed", "dispose"];
  for (const [state, outcomes] of Object.entries(expected))
    events.forEach((event, i) => assert.equal(sourceLoadStep(state, event), outcomes[i]));
  for (const state of ["active", "disposed"]) {
    assert.equal(sourceResolverStep(state, "resolve"), state);
    assert.equal(sourceResolverStep(state, "dispose"), "disposed");
  }
});
function fixture(overrides = {}) {
  let binding = { asset_id: first, source_id: "usage", source_revision: "v1" };
  const requests = [];
  let decodes = 0;
  const resolver = createPageSourceResolver({
    pageId,
    readBinding: (alias) => (alias === "pinned" ? { asset_id: first } : binding),
    request: async (url, options) => {
      requests.push({ url, options });
      return new Response(new Uint8Array([1]), { headers: { "content-type": PARQUET_MEDIA_TYPE } });
    },
    loadTableFile: async () => ({ rows: [], columns: [], decode: ++decodes }),
    ...overrides,
  });
  return {
    ...resolver,
    requests,
    refresh: () => {
      binding = { ...binding, asset_id: second, source_revision: "v2" };
    },
  };
}

test("table and chart share bytes but own separate decodes; refresh and pinned bindings report exact versions", async () => {
  const r = fixture();
  const [table, chart] = await Promise.all([r.resolveSource("table"), r.resolveSource("chart")]);
  assert.notEqual(table.table, chart.table);
  assert.equal(r.requests.length, 1);
  r.refresh();
  const next = await r.resolveSource("chart");
  assert.equal(next.asset_id, second);
  assert.equal(next.source_revision, "v2");
  assert.equal((await r.resolveSource("pinned")).asset_id, table.asset_id);
  assert.equal(r.requests.length, 2);
  r.destroy();
});

test("a canceled chart does not cancel the table; refresh during decode preserves observed revision", async () => {
  let finish;
  const decoded = new Promise((resolve) => {
    finish = resolve;
  });
  const r = fixture({ loadTableFile: () => decoded });
  const controller = new AbortController();
  const chart = r.resolveSource("chart", { signal: controller.signal });
  const table = r.resolveSource("table");
  controller.abort();
  await assert.rejects(chart, { name: "AbortError" });
  assert.equal(r.requests[0].options.signal.aborted, false);
  r.refresh();
  finish({ rows: [] });
  assert.equal((await table).source_revision, "v1");
  assert.equal((await r.resolveSource("chart")).source_revision, "v2");
  r.destroy();
});

test("failure can retry, disposal fences in-flight results, and readers never share a cache", async () => {
  let attempts = 0;
  const r = fixture({
    loadTableFile: async () => {
      if (++attempts === 1) throw Error("Decode failed");
      return { rows: [] };
    },
  });
  await assert.rejects(r.resolveSource("table"), /Decode failed/);
  await r.resolveSource("table");
  assert.equal(attempts, 2);
  const other = fixture();
  const pending = other.resolveSource("table");
  other.destroy();
  await assert.rejects(pending, { name: "AbortError" });
  await assert.rejects(other.resolveSource("table"), { name: "AbortError" });
  assert.equal(r.requests.length, 1);
  r.destroy();
});

test("late decoded tables are disposed on consumer cancellation and resolver destruction", async () => {
  for (const destroy of [false, true]) {
    let finish, started;
    const decoding = new Promise((resolve) => {
      started = resolve;
    });
    let disposed = 0;
    const r = fixture({
      loadTableFile: () => {
        started();
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    });
    const controller = new AbortController();
    const pending = r.resolveSource("table", { signal: controller.signal });
    await decoding;
    if (destroy) r.destroy();
    else controller.abort();
    finish({ dispose: () => disposed++ });
    await assert.rejects(pending, { name: "AbortError" });
    assert.equal(disposed, 1);
    r.destroy();
  }
});

test("cache eviction and destroying the resolver never invalidate consumer-owned tables", async () => {
  let disposed = 0;
  const r = fixture({ maxEntries: 1, loadTableFile: async () => ({ dispose: () => disposed++ }) });
  const first = await r.resolveSource("table");
  r.refresh();
  const second = await r.resolveSource("chart");
  r.destroy();
  assert.equal(disposed, 0);
  first.table.dispose();
  second.table.dispose();
  assert.equal(disposed, 2);
});
