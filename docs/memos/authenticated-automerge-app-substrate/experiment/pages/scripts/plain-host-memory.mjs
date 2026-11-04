#!/usr/bin/env node
// From pages: node --expose-gc scripts/plain-host-memory.mjs bare 13
// Also: bridge 13; cycles 13 (eight batches of N load/free pairs).
// Optional: --fixture /path/to/page.automerge. No document content is printed.
// Each invocation samples a fresh process. Generation/inspection runs outside
// that process so its WASM high-water mark cannot mask the measured allocation.
// Capacity is allocator capacity, NOT live bytes; WASM memory does not shrink.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const child = args[0] === "--sample";
if (child) args.shift();
const [mode, countArg = "13", ...options] = args;
const count = Number(countArg);
assert.ok(["bare", "bridge", "cycles"].includes(mode), "Mode must be bare, bridge, or cycles");
assert.ok(Number.isSafeInteger(count) && count > 0, "N must be a positive integer");
assert.ok(
  options.length === 0 || (options.length === 2 && options[0] === "--fixture"),
  "Usage: node --expose-gc scripts/plain-host-memory.mjs MODE N [--fixture PATH]",
);
assert.equal(typeof global.gc, "function", "Run with node --expose-gc");

const memories = new Set();
const Instance = WebAssembly.Instance;
if (child) {
  // Automerge's pinned Node entry point instantiates synchronously. Fail below
  // rather than silently reporting zero if its WASM loader changes.
  WebAssembly.Instance = new Proxy(Instance, {
    construct(target, values) {
      const instance = Reflect.construct(target, values);
      for (const value of Object.values(instance.exports))
        if (value instanceof WebAssembly.Memory) memories.add(value);
      return instance;
    },
  });
}
const A = await import("@automerge/automerge");

if (!child) {
  let doc;
  if (options.length) doc = A.load(new Uint8Array(readFileSync(options[1])));
  else {
    let seed = 42;
    const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
    const words =
      "notebook document policy actor admission change history storage snapshot browser shared title paragraph transaction journal durable comment receipt current pending applied exact immutable content projection".split(
        " ",
      );
    doc = A.change(A.init({ actor: "11".repeat(16) }), { time: 1700000000 }, (d) => {
      d.title = "Plain host memory fixture";
      d.blocks = {};
    });
    for (let i = 0; i < 300; i++) {
      let text = `Section ${i}\n\n`;
      while (text.length < 670) text += `${words[random() % words.length]} `;
      doc = A.change(doc, { time: 1700000001 + i }, (d) => {
        d.blocks[`b${i}`] = { richText: `${text.slice(0, 670)}\n`, position: String(i) };
      });
    }
    for (let i = 0; i < 499; i++) {
      const block = `b${random() % 300}`;
      const position = 20 + (random() % 600);
      doc = A.change(doc, { time: 1700000301 + i }, (d) => {
        A.splice(
          d,
          ["blocks", block, "richText"],
          position,
          1,
          String.fromCharCode(97 + (random() % 26)),
        );
      });
    }
  }
  const bytes = A.save(doc);
  const fixture = {
    source: options.length ? "file" : "seed:42",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    savedBytes: bytes.byteLength,
    materializedJsonBytes: Buffer.byteLength(JSON.stringify(doc)),
    changes: A.getAllChanges(doc).length,
    heads: A.getHeads(doc),
  };
  A.free(doc);
  const result = spawnSync(
    process.execPath,
    ["--expose-gc", fileURLToPath(import.meta.url), "--sample", mode, String(count)],
    {
      input: JSON.stringify({ fixture, bytes: Buffer.from(bytes).toString("base64") }),
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: 180_000,
    },
  );
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `Measurement failed: ${result.stdout}`);
  process.stdout.write(result.stdout);
} else {
  WebAssembly.Instance = Instance;
  assert.ok(memories.size > 0, "Automerge WASM memory was not captured");
  // PlainSync's worker imports use the Pages TypeScript path aliases.
  const { register } = await import("tsx/esm/api");
  register({ tsconfig: fileURLToPath(new URL("../tsconfig.json", import.meta.url)) });
  // Every mode loads the same module graph before taking its baseline.
  const { interpretAsDocumentId } = await import("@automerge/automerge-repo");
  const { plainHostFixture } = await import("../sync/plain-host-fixture.mjs");
  const { fixture, bytes: encoded } = JSON.parse(readFileSync(0, "utf8"));
  const bytes = new Uint8Array(Buffer.from(encoded, "base64"));
  const samples = [];
  const sample = async (phase, documents, cycle) => {
    for (let i = 0; i < 5; i++) {
      global.gc();
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const { rss, heapUsed, external } = process.memoryUsage();
    const wasmCapacity = [...memories].reduce((sum, memory) => sum + memory.buffer.byteLength, 0);
    samples.push({
      phase,
      documents,
      ...(cycle && { cycle }),
      bytes: { wasmCapacity, rss, heapUsed, external },
    });
  };
  await sample("baseline", 0);
  if (mode === "bridge") {
    const hosts = [];
    for (let i = 1; i <= count; i++) {
      const documentId = interpretAsDocumentId(
        Uint8Array.from(Buffer.from(i.toString(16).padStart(32, "0"), "hex")),
      );
      const plain = await plainHostFixture({ documentId, bytes, heads: fixture.heads });
      const handle = await plain.repo.find(documentId);
      await plain.flush([documentId]);
      assert.deepEqual(A.getHeads(handle.doc()), fixture.heads);
      assert.deepEqual(await plain.durableHeads(documentId), fixture.heads);
      hosts.push({ plain, handle });
      await sample("loaded", i);
    }
    for (const { plain } of hosts) await plain.close();
    // Do not free private bridge documents or claim shutdown reclaims them.
    // These measurements describe residency; cycles isolates explicit A.free.
  } else {
    for (let cycle = 1; cycle <= (mode === "cycles" ? 8 : 1); cycle++) {
      const docs = [];
      for (let i = 1; i <= count; i++) {
        docs.push(A.load(bytes));
        if (mode === "bare" || i === count) await sample("loaded", i, cycle);
      }
      while (docs.length) A.free(docs.pop());
      await sample("freed", 0, cycle);
    }
  }
  const loaded = samples.filter((s) => s.phase === "loaded");
  const first = count > 1 && mode !== "cycles" ? loaded[0] : samples[0];
  const last = loaded.at(-1);
  const divisor = mode === "cycles" ? count : last.documents - first.documents;
  const perDocumentSlopeBytes = Object.fromEntries(
    Object.keys(last.bytes).map((key) => [key, (last.bytes[key] - first.bytes[key]) / divisor]),
  );
  console.log(
    JSON.stringify(
      {
        mode,
        count,
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        fixture,
        samples,
        perDocumentSlopeBytes,
        slopeBasis:
          mode === "cycles"
            ? "last batch minus baseline / N"
            : count === 1
              ? "one minus baseline"
              : "N minus one / (N - 1)",
      },
      null,
      2,
    ),
  );
}
