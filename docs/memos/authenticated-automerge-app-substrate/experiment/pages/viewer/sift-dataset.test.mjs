import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { PARQUET_MEDIA_TYPE } from "../shared/dataset-assets.mjs";
import { ensureSiftStyles, fetchDataset } from "./sift-dataset.mjs";

const src = `/api/pages/33333333-3333-4333-8333-333333333333/assets/${"b".repeat(64)}`;
const respond =
  (status, type = PARQUET_MEDIA_TYPE, body = new Uint8Array([1, 2, 3])) =>
  async () =>
    new Response(status === 200 ? body : JSON.stringify({ error: "x" }), {
      status,
      headers: { "content-type": type },
    });

test("a dataset is read same-origin with the reader's session", async () => {
  const calls = [];
  const signal = new AbortController().signal;
  const bytes = await fetchDataset(src, {
    signal,
    request: async (url, init) => {
      calls.push([url, init]);
      return respond(200, `${PARQUET_MEDIA_TYPE}; charset=binary`)();
    },
  });
  assert.deepEqual(bytes, new Uint8Array([1, 2, 3]));
  assert.deepEqual(calls, [[src, { credentials: "same-origin", signal }]]);
});

test("access, missing assets and other media types fail with a reason", async () => {
  for (const [request, message] of [
    [respond(401), /access/],
    [respond(403), /access/],
    [respond(404), /isn't stored/],
    [respond(500), /\(500\)/],
    [respond(200, "image/png"), /isn't a Parquet dataset/],
  ])
    await assert.rejects(fetchDataset(src, { request }), { message });
});

test("a src outside this origin's Page assets is never requested", async () => {
  let requested = false;
  const request = async () => {
    requested = true;
    return respond(200)();
  };
  for (const value of ["https://example.com/x.parquet", `${src}?redirect=1`])
    await assert.rejects(fetchDataset(value, { request }), /Page asset path/);
  assert.equal(requested, false);
});

test("Sift's stylesheet is added once", () => {
  const { window } = new JSDOM("<!doctype html><head></head><body></body>");
  ensureSiftStyles(window.document, ".sift-root{color:red}");
  ensureSiftStyles(window.document, ".sift-root{color:blue}");
  const styles = window.document.querySelectorAll("style[data-pages-sift]");
  assert.equal(styles.length, 1);
  assert.equal(styles[0].textContent, ".sift-root{color:red}");
  window.close();
});
