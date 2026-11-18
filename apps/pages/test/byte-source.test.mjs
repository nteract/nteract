import assert from "node:assert/strict";
import test from "node:test";
import {
  exposeByteSource,
  receiveByteSource,
} from "../../../packages/output-frame/src/byte-source.mjs";
import { openAssetByteSource } from "../viewer/asset-byte-source.mjs";

test("a file capability transfers only the selected span and cancels individual reads", async () => {
  const lifetime = new AbortController();
  let started, cancelled;
  const waiting = new Promise((r) => {
    started = r;
  });
  const stopped = new Promise((r) => {
    cancelled = r;
  });
  const input = {
    byteLength: 9,
    async read(offset, length, signal) {
      if (offset !== 1) return Uint8Array.from([0, 1, 2, 3, 4]).subarray(2, 2 + length);
      started();
      return new Promise((_, reject) =>
        signal.addEventListener(
          "abort",
          () => {
            cancelled();
            reject(signal.reason);
          },
          { once: true },
        ),
      );
    },
  };
  try {
    const source = receiveByteSource(exposeByteSource(input, lifetime.signal), lifetime.signal);
    const controller = new AbortController();
    const pending = source.read(1, 1, controller.signal);
    await waiting;
    controller.abort();
    await assert.rejects(pending, { name: "AbortError" });
    await stopped;
    const result = await source.read(0, 2);
    assert.equal(result.buffer.byteLength, 2);
    assert.deepEqual([...result], [2, 3]);
    await assert.rejects(source.read(8, 2), /Invalid/);
  } finally {
    lifetime.abort();
  }
});

test("a full response to a requested range is refused without consuming the file", async () => {
  let cancelled = false;
  const source = await openAssetByteSource(
    "33333333-3333-4333-8333-333333333333",
    { asset_id: "a".repeat(64), media_type: "application/octet-stream" },
    {
      request: async (_, opt) =>
        opt.method === "HEAD"
          ? new Response(null, {
              headers: {
                "content-length": "4096",
                "x-pages-media-type": "application/octet-stream",
              },
            })
          : new Response(
              new ReadableStream({
                cancel() {
                  cancelled = true;
                },
              }),
            ),
    },
  );
  await assert.rejects(source.read(0, 4), /requested range/);
  assert.ok(cancelled);
});
