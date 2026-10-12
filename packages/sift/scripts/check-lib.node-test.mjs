import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { requiredWasmExports, verifyWasmPair } from "./check-lib.mjs";

const wasmUrl = new URL("../lib/wasm/", import.meta.url);
const binary = await readFile(new URL("sift_wasm_bg.wasm", wasmUrl));
const glue = await readFile(new URL("sift_wasm.js", wasmUrl), "utf8");
const required = await requiredWasmExports();
const fileExports = [
  "load_parquet_bounded",
  "load_ipc_bounded",
  "arrow_ipc_column_hints_with_row_count",
];

async function withGlue(source, run) {
  const scratch = await mkdtemp(join(tmpdir(), "sift-wasm-contract-"));
  try {
    const path = join(scratch, "glue.mjs");
    await writeFile(path, source);
    await run(pathToFileURL(path));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

test("accepts the current glue/binary against all runtime methods", async () => {
  for (const name of fileExports) assert(required.includes(name));
  await withGlue(glue, (url) => verifyWasmPair(binary, url, required));
});

for (const name of fileExports) {
  test(`rejects valid WASM lacking ${name}`, async () => {
    const changed = Buffer.from(binary);
    const position = changed.indexOf(name);
    assert(position >= 0);
    changed[position] = "_".charCodeAt(0); // Rename the export without changing bytecode size.
    assert(WebAssembly.validate(changed));
    assert(
      !WebAssembly.Module.exports(new WebAssembly.Module(changed)).some(
        (entry) => entry.name === name,
      ),
    );
    await withGlue(glue, (url) =>
      assert.rejects(
        verifyWasmPair(changed, url, required),
        new RegExp(`binary is missing runtime export ${name}`),
      ),
    );
  });

  test(`rejects generated glue lacking ${name}`, async () => {
    const changed = glue.replace(`export function ${name}(`, `function ${name}(`);
    assert.notEqual(changed, glue);
    await withGlue(changed, (url) =>
      assert.rejects(
        verifyWasmPair(binary, url, required),
        new RegExp(`glue is missing runtime export ${name}`),
      ),
    );
  });
}

test("rejects mismatched glue imports even when public exports exist", async () => {
  const changed = glue.replace(
    "function __wbg_get_imports() {",
    "function __wbg_get_imports() { return {}; ",
  );
  assert.notEqual(changed, glue);
  await withGlue(changed, (url) =>
    assert.rejects(verifyWasmPair(binary, url, required), /import|module|LinkError/i),
  );
});
