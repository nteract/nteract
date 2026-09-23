import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { startCelld } from "./local-celld.mjs";
const root = fileURLToPath(new URL("..", import.meta.url));

test(
  "real celld Python sessions persist, isolate and contain termination",
  { timeout: 60000 },
  async (t) => {
    const bundle = await build({
      absWorkingDir: root,
      entryPoints: ["test/session-driver.js"],
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      target: "es2022",
      loader: { ".wasm": "binary" },
      plugins: [
        {
          name: "session-source",
          setup(builder) {
            builder.onLoad({ filter: /dist\/session\.js$/ }, async (args) => ({
              contents: await readFile(args.path, "utf8"),
              loader: "text",
            }));
          },
        },
      ],
    });
    const server = await startCelld(
      { "index.js": bundle.outputFiles[0].text },
      { worker_loaders: [{ binding: "LOADER" }] },
    );
    t.after(server.close);
    const response = await fetch(server.url, { signal: AbortSignal.timeout(40000) });
    const text = await response.text();
    assert.equal(response.status, 200, text + server.logs());
    const result = JSON.parse(text);
    assert.deepEqual(
      result.assignment.outputs.map((o) => o.text ?? o.data["text/plain"]),
      ["hello\n", "42"],
    );
    assert.equal(result.persisted.outputs[0].data["text/plain"], "43");
    assert.equal(result.isolated.outputs[0].data["text/plain"], "False");
    assert.equal(result.error.success, false);
    assert.equal(result.error.outputs[0].ename, "ValueError");
    assert.equal(result.recovered.outputs[0].data["text/plain"], "41");
    assert.equal(result.denied.success, false);
    assert.match(result.timeout, /CPU|cpu|invalidated/);
    assert.equal(result.sibling.outputs[0].data["text/plain"], "42");
    await mkdir(new URL("../.scratch/", import.meta.url), { recursive: true });
    await writeFile(
      new URL("../.scratch/session-evidence.json", import.meta.url),
      JSON.stringify(result, null, 2),
    );
    t.diagnostic(
      JSON.stringify({
        coldMs: result.coldMs,
        warmMs: result.warmMs,
        linearMemory: result.ready.linearMemory,
      }),
    );
  },
);
