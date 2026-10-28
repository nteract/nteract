import assert from "node:assert/strict";
import { test } from "node:test";
import { fixtureFetch } from "./fixtures/local-api-keys.mjs";
import { fixtureImageFetch, imageDownloadUrl, imagePng } from "./fixtures/local-mcp-images.mjs";

test("MCP image fixture only serves the exact synthetic URL and never reaches public hosts", async () => {
  const calls = [];
  const images = fixtureImageFetch(
    fixtureFetch("http://localhost:1234", {}, async (url) => {
      calls.push(url);
      return new Response("local");
    }),
  );
  assert.deepEqual(
    new Uint8Array(await (await images.fetch(imageDownloadUrl)).arrayBuffer()),
    imagePng(),
  );
  assert.equal(images.state.downloads, 1);
  assert.deepEqual(calls, []);
  await assert.rejects(images.fetch(imageDownloadUrl + "&other=1"), /external network/);
  await assert.rejects(images.fetch("https://example.com/image.png"), /external network/);
  await assert.rejects(
    images.fetch(imageDownloadUrl, { headers: { Authorization: "Bearer fake" } }),
    /unexpected credential/,
  );
  images.state.expired = true;
  assert.equal((await images.fetch(imageDownloadUrl)).status, 403);
  assert.equal((await images.fetch("http://localhost:1234/health")).status, 200);
  assert.deepEqual(calls, ["http://localhost:1234/health"]);
});
