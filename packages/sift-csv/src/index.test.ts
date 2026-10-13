import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tableFromIPC } from "apache-arrow";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { _setWasmModuleLoaderForTests, csvToArrowIpc, setWasmUrl } from "./index";

const wasmPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../crates/sift-csv-wasm/pkg/sift_csv_wasm_bg.wasm",
);

// Run `cargo xtask wasm sift-csv` to produce the binary; the Rust suite covers
// the parser itself, this suite covers the JS wrapper and the IPC contract.
describe.skipIf(!existsSync(wasmPath))("csvToArrowIpc", () => {
  beforeAll(async () => {
    const wasm = await import("sift-csv-wasm/sift_csv_wasm.js");
    await wasm.default({ module_or_path: readFileSync(wasmPath) });
    // The real binary is already instantiated above; the wrapper's init
    // becomes a no-op. The URL just has to resolve, since the wrapper reads
    // `file:` URLs before handing them to the glue.
    setWasmUrl(pathToFileURL(wasmPath));
    _setWasmModuleLoaderForTests(async () => ({
      ...wasm,
      default: async () => undefined,
    }));
  });

  afterAll(() => {
    _setWasmModuleLoaderForTests(null);
  });

  it("returns an Arrow IPC stream any Arrow reader can open", async () => {
    const ipc = await csvToArrowIpc(
      "id,ratio,flag,name\n1,0.1111111111111111,True,ann\n2,,false,\n",
    );
    const table = tableFromIPC(ipc);
    expect(table.schema.fields.map((f) => `${f.name}:${f.type}`)).toEqual([
      "id:Int64",
      "ratio:Float64",
      "flag:Bool",
      "name:Utf8",
    ]);
    expect(table.numRows).toBe(2);
    expect(table.getChild("ratio")?.get(0)).toBeCloseTo(0.1111111111111111);
    expect(table.getChild("ratio")?.get(1)).toBeNull();
    expect(table.getChild("name")?.get(1)).toBeNull();
  });

  it("accepts bytes and a tab delimiter", async () => {
    const ipc = await csvToArrowIpc(new TextEncoder().encode("a\tb\n1\t2\n"), { delimiter: "\t" });
    expect(tableFromIPC(ipc).schema.fields.map((f) => f.name)).toEqual(["a", "b"]);
  });

  it("passes limits through and rejects with the reason", async () => {
    await expect(csvToArrowIpc("a\n1\n2\n3\n", { maxRows: 2 })).rejects.toThrow(/row limit/);
    await expect(csvToArrowIpc("a,b\n1\n")).rejects.toThrow(/record/);
    await expect(csvToArrowIpc("a\n1\n", { delimiter: ";;" })).rejects.toThrow(/single ASCII/);
  });

  it("ignores undefined options so callers can spread partial config", async () => {
    const ipc = await csvToArrowIpc("a\n1\n", { maxRows: undefined, hasHeader: undefined });
    expect(tableFromIPC(ipc).numRows).toBe(1);
  });
});
