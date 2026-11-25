import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildLibraryCatalog } from "./library-catalog.mjs";

const app = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// The wasm loads outside import map integrity (shared/verified-wasm.mjs), so
// the hashed Parquet entry must carry the wasm's own hash.
test("the Parquet entry carries the integrity of the catalog's sift.wasm", async () => {
  const { files } = await buildLibraryCatalog(app, { entries: ["@nteract/sift/parquet"] });
  const integrity =
    "sha256-" + createHash("sha256").update(files.get("sift.wasm")).digest("base64");
  const entry = new TextDecoder().decode(files.get("nteract-sift-parquet.js"));
  assert.ok(entry.includes(JSON.stringify(integrity)));
  assert.ok(!entry.includes(app), "the entry names no build path");
});
