import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { build } from "esbuild";
import { celldCborPlugin } from "./celld-cbor.mjs";

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
async function bundle(plugins = []) {
  const result = await build({
    stdin: {
      contents:
        'import {Encoder, decode} from "cbor-x"; export function roundTrip(value) {return decode(new Encoder({tagUint8Array:false,useRecords:false}).encode(value));}',
      resolveDir: app,
    },
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    globalName: "CborProbe",
    target: "es2022",
    plugins,
  });
  return result.outputFiles[0].text;
}
function evaluate(source) {
  // Static class methods are callable but not constructors, matching celld's
  // Buffer allocator. Keep this stub inside the VM; never change Node globals.
  class WorkerBuffer extends Uint8Array {
    static allocUnsafeSlow(size) {
      return new WorkerBuffer(size);
    }
  }
  const context = vm.createContext({ Buffer: WorkerBuffer, TextEncoder, TextDecoder });
  vm.runInContext(source, context);
  return { context, buffer: WorkerBuffer, allocator: WorkerBuffer.allocUnsafeSlow };
}

test("celld CBOR workaround round-trips text and binary past initial buffer size", async () => {
  const original = evaluate(await bundle());
  assert.throws(
    () => original.context.CborProbe.roundTrip({ hello: "world" }),
    /ByteArrayAllocate is not a constructor/,
  );
  const fixed = evaluate(await bundle([celldCborPlugin()]));
  const result = vm.runInContext(
    'CborProbe.roundTrip({text:"🌊 collaboration".repeat(1500),binary:new Uint8Array([0,1,254,255])})',
    fixed.context,
  );
  assert.equal(result.text, "🌊 collaboration".repeat(1500));
  assert.deepEqual([...result.binary], [0, 1, 254, 255]);
  assert.strictEqual(fixed.context.Buffer, fixed.buffer);
  assert.strictEqual(fixed.context.Buffer.allocUnsafeSlow, fixed.allocator);
  const packageRoot = path.dirname(require.resolve("cbor-x/package.json"));
  assert.match(
    readFileSync(path.join(packageRoot, "encode.js"), "utf8"),
    /const hasNodeBuffer = typeof Buffer !== 'undefined'/,
  );
});

test("celld CBOR workaround fails closed on an unexpected upstream allocation check", async () => {
  let loader;
  celldCborPlugin().setup({
    onLoad(_options, callback) {
      loader = callback;
    },
  });
  await assert.rejects(
    loader({ path: path.join(app, "package.json") }),
    /allocation check changed/,
  );
});
