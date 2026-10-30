import assert from "node:assert/strict";
import { test } from "node:test";
import { fixtureFetch } from "./fixtures/local-api-keys.mjs";
import { startImageSource } from "./fixtures/local-mcp-image-source.mjs";
import {
  fixtureImageFetch,
  imageDownloadUrl,
  imagePng,
  imageTokenOf,
} from "./fixtures/local-mcp-images.mjs";

const tokenOf = (url) => imageTokenOf(url).token;

test("MCP image fixture forwards only well-formed synthetic URLs and never reaches public hosts", async () => {
  const calls = [],
    forwarded = [];
  const fetchImage = fixtureImageFetch(
    fixtureFetch("http://localhost:1234", {}, async (url) => {
      calls.push(url);
      return new Response("local");
    }),
    {
      source: "http://127.0.0.1:5678",
      identity: "fixture-a",
      isolate: "isolate-1",
      realFetch: async (url, init) => {
        forwarded.push({ url, headers: init.headers });
        return new Response("forwarded");
      },
    },
  );
  const ok = imageDownloadUrl("ok");
  assert.equal(await (await fetchImage(ok)).text(), "forwarded");
  assert.deepEqual(forwarded, [
    {
      url: `http://127.0.0.1:5678/download/${tokenOf(ok)}`,
      headers: { "X-Pages-E2E-Fixture": "fixture-a", "X-Pages-E2E-Isolate": "isolate-1" },
    },
  ]);
  for (const url of [
    ok + "&other=1",
    ok.replace("token=ok-", "token=slow-"),
    "https://files.oaiusercontent.com/file_pages_mcp_fixture?token=local-only",
  ])
    await assert.rejects(fetchImage(url), /unknown download URL/);
  await assert.rejects(fetchImage("https://example.com/image.png"), /external network/);
  await assert.rejects(
    fetchImage(ok, { headers: { Authorization: "Bearer fake" } }),
    /unexpected credential/,
  );
  assert.equal(forwarded.length, 1);
  assert.equal((await fetchImage("http://localhost:1234/health")).status, 200);
  assert.deepEqual(calls, ["http://localhost:1234/health"]);
});

test("image source serves each token's behavior and counts downloads by token", async () => {
  const source = await startImageSource({ identity: "fixture-a" });
  try {
    const download = (url, identity = "fixture-a") =>
      fetch(`${source.origin}/download/${tokenOf(url)}`, {
        headers: { "X-Pages-E2E-Fixture": identity, "X-Pages-E2E-Isolate": "isolate-1" },
      });
    const ok = imageDownloadUrl("ok"),
      expired = imageDownloadUrl("expired");
    const image = await download(ok);
    assert.equal(image.status, 200);
    assert.deepEqual(new Uint8Array(await image.arrayBuffer()), imagePng());
    assert.equal((await download(expired)).status, 403);
    assert.equal((await download(expired)).status, 403);
    assert.equal(source.downloads(tokenOf(ok)), 1);
    assert.equal(source.downloads(tokenOf(expired)), 2);
    assert.equal(source.downloads(tokenOf(imageDownloadUrl("ok"))), 0);
    assert.deepEqual(source.errors, []);
    // Another fixture build is refused, recorded and not counted.
    assert.equal((await download(ok, "fixture-b")).status, 400);
    assert.equal(source.total(), 3);
    assert.equal(source.errors.length, 1);
    assert.match(source.errors[0], /fixture fixture-b/);
  } finally {
    await source.close();
  }
});
