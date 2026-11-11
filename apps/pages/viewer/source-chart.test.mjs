import assert from "node:assert/strict";
import test from "node:test";
import * as A from "@automerge/automerge";
import { JSDOM } from "jsdom";
import { setPageSource } from "../model/page-sources.mjs";
import { pageSourceStore } from "./page-source-store.mjs";
import { mountSourceChart } from "./source-chart.mjs";

const pageId = "33333333-3333-4333-8333-333333333333";
const first = "a".repeat(64),
  second = "b".repeat(64);
const write = (doc, source_id, asset_id, expected_revision = null) =>
  A.change(doc, (draft) =>
    setPageSource(draft, { source_id, name: source_id, asset_id, expected_revision }),
  );
const spec = JSON.stringify({
  data: { name: "daily" },
  mark: "bar",
  encoding: { x: { field: "day", type: "nominal" }, y: { field: "calls", type: "quantitative" } },
});
// Each asset's bytes name it; the decoder turns them into that version's rows.
const rowsFor = { [first]: 3, [second]: 5 };
const settle = () => new Promise((resolve) => setTimeout(resolve, 120));

test("a chart following a source redraws at its new version, and frees each decode", async () => {
  const { window } = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true });
  const previous = globalThis.document;
  globalThis.document = window.document;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) =>
    new Response(new TextEncoder().encode(String(url).slice(-64)), {
      headers: { "content-type": "application/vnd.apache.parquet" },
    });
  let doc = write(A.from({ sources: {} }), "daily", first);
  const listeners = new Set();
  const sources = pageSourceStore({
    pageId,
    read: () => doc,
    subscribe: (fn) => (listeners.add(fn), () => listeners.delete(fn)),
  });
  let decoded = 0,
    freed = 0;
  const loadTableFile = async (bytes) => {
    decoded++;
    const n = rowsFor[new TextDecoder().decode(bytes)];
    return {
      columns: ["day", "calls"],
      rows: Array.from({ length: n }, (_, i) => ({ day: `d${i}`, calls: i })),
      dispose: () => freed++,
    };
  };
  try {
    const container = window.document.body.appendChild(window.document.createElement("div"));
    Object.defineProperty(container, "clientWidth", { get: () => 400 });
    const reports = [];
    const chart = mountSourceChart(container, {
      src: `/api/pages/${pageId}/assets/${first}`,
      pageId,
      chart: spec,
      source: "daily",
      sources,
      loadTableFile,
      onReport: (report) => reports.push(report),
    });
    await settle();
    assert.deepEqual(JSON.parse(container.dataset.sourceVersions), {
      daily: { asset_id: first, source_revision: "1" },
    });
    doc = write(doc, "daily", second, "1");
    for (const fn of listeners) fn();
    await settle();
    assert.deepEqual(JSON.parse(container.dataset.sourceVersions), {
      daily: { asset_id: second, source_revision: "2" },
    });
    assert.deepEqual(
      reports.map((report) => [report.status, report.sources.daily.rows]),
      [
        ["rendered", 3],
        ["rendered", 5],
      ],
    );
    assert.equal(container.querySelectorAll(".mark-rect path").length, 5);
    assert.equal(freed, decoded);
    chart.destroy();
    assert.equal(listeners.size, 0);
  } finally {
    sources.destroy();
    globalThis.fetch = realFetch;
    globalThis.document = previous;
    window.close();
  }
});
