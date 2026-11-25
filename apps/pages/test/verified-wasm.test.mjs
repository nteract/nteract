import test from "node:test";
import assert from "node:assert/strict";
import { verifiedWasmUrl } from "../shared/verified-wasm.mjs";

test("the wasm is asked for with its integrity and handed to Sift as a data: URL", async () => {
  const bytes = Uint8Array.from({ length: 70000 }, (_, i) => i % 251);
  const asked = [];
  const url = await verifiedWasmUrl(
    "https://libraries.example/catalog/r/sift.wasm",
    "sha256-x",
    async (...args) => {
      asked.push(args);
      return new Response(bytes);
    },
  );
  assert.deepEqual(asked, [
    [
      "https://libraries.example/catalog/r/sift.wasm",
      { integrity: "sha256-x", credentials: "omit" },
    ],
  ]);
  assert.ok(url.startsWith("data:application/wasm;base64,"));
  assert.deepEqual(new Uint8Array(Buffer.from(url.split(",")[1], "base64")), bytes);
});

test("a wasm the host doesn't serve is an error, not an empty module", async () => {
  await assert.rejects(
    verifiedWasmUrl(
      "https://libraries.example/x.wasm",
      "sha256-x",
      async () => new Response(null, { status: 404 }),
    ),
    /HTTP 404/,
  );
});
