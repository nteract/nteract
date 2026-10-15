// Consume only the final packed files in a fresh package-resolution root.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { readTarball } from "../../scripts/ci/npm-wasm-release.mjs";

const tarball = resolve(process.argv[2]);
const tsc = resolve(process.env.TSC_PATH ?? "node_modules/typescript/bin/tsc");
const files = readTarball(readFileSync(tarball));
const temporary = mkdtempSync(join(tmpdir(), "runtimed-wasm-consumer-"));
try {
  for (const [name, bytes] of Object.entries(files)) {
    const path = join(temporary, "node_modules/@runtimed/wasm", name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  }
  writeFileSync(join(temporary, "package.json"), '{"type":"module"}\n');
  const program = `
    import assert from 'node:assert/strict';
    import {readFileSync} from 'node:fs';
    import init, {initSync, NotebookHandle} from '@runtimed/wasm';
    const url = new URL(import.meta.resolve('@runtimed/wasm/runtimed_wasm_bg.wasm'));
    const bytes = readFileSync(url);
    const mode = process.env.INIT_MODE;
    if (mode === 'sync') initSync({module: bytes});
    else if (mode === 'async') await init({module_or_path: bytes});
    else if (mode === 'module') await init({module_or_path: await WebAssembly.compile(bytes)});
    else if (mode === 'response') await init({module_or_path: new Response(bytes, {headers: {'Content-Type': 'application/wasm'}})});
    else {
      globalThis.fetch = async input => {
        assert.equal(String(input), url.href);
        return new Response(bytes, {headers: {'Content-Type': 'application/wasm'}});
      };
      await init();
    }
    const doc = NotebookHandle.create_bootstrap('npm-package-smoke');
    try {
      doc.add_cell_after('npm-cell', 'code');
      assert.equal(doc.update_source('npm-cell', '1 + 1'), true);
      assert.equal(doc.get_cell_source('npm-cell'), '1 + 1');
      assert.ok(doc.save().length > 0);
      assert.ok(JSON.parse(doc.get_cells_json()).some(cell => cell.id === 'npm-cell'));
    } finally {doc.free();}
    const info = JSON.parse(readFileSync(new URL(import.meta.resolve('@runtimed/wasm/build-info.json'))));
    assert.match(info.release.sourceSha, /^[a-f0-9]{40}$/);
    assert.ok(info.protocol.wireVersion > 0);
  `;
  for (const mode of ["sync", "async", "module", "response", "default-url"]) {
    execFileSync(process.execPath, ["--input-type=module", "-e", program], {
      cwd: temporary,
      env: { ...process.env, INIT_MODE: mode },
      stdio: "inherit",
    });
  }
  writeFileSync(
    join(temporary, "consumer.ts"),
    `
    import init, {initSync, NotebookHandle, type InitInput, type SyncInitInput} from '@runtimed/wasm';
    const bytes = new Uint8Array();
    const input: InitInput = bytes;
    const sync: SyncInitInput = bytes;
    void init({module_or_path: input});
    initSync({module: sync});
    const doc: NotebookHandle = NotebookHandle.create_bootstrap('typed-consumer');
    const source: string | undefined = doc.get_cell_source('cell');
    doc.free();
  `,
  );
  for (const [module, resolution] of [
    ["NodeNext", "NodeNext"],
    ["ESNext", "Bundler"],
  ]) {
    execFileSync(
      process.execPath,
      [
        tsc,
        "--noEmit",
        "--strict",
        "--target",
        "ES2022",
        "--lib",
        "ES2022,DOM,ESNext.Disposable",
        "--module",
        module,
        "--moduleResolution",
        resolution,
        "consumer.ts",
      ],
      { cwd: temporary, stdio: "inherit" },
    );
  }
  assert.ok(files["lib/THIRD_PARTY_NOTICES.md"].includes("automerge"));
  console.log(
    "Packed WASM consumer: 5 initialization paths, document mutation/save, NodeNext and bundler types passed.",
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
