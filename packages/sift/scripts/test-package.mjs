import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

// Exercise the packed package outside this workspace: source aliases and
// undeclared workspace dependencies must not make a broken artifact pass.
const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(new URL("../package.json", import.meta.url));
// Vite resolves source paths through realpath; macOS /var -> /private/var must
// not make this isolated consumer's entry look like it is outside its root.
const scratch = await realpath(await mkdtemp(join(tmpdir(), "sift-package-")));

function run(command, args, cwd = scratch) {
  return execFileSync(command, args, { cwd, encoding: "utf8", stdio: "pipe" });
}

async function packageDirectory(specifier) {
  let directory;
  try {
    directory = dirname(require.resolve(`${specifier}/package.json`));
  } catch {
    directory = dirname(require.resolve(specifier));
  }
  while (directory !== dirname(directory)) {
    try {
      const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
      if (manifest.name === specifier) return directory;
    } catch {
      // The resolved file can be in a package's dist directory.
    }
    directory = dirname(directory);
  }
  throw new Error(`Cannot locate installed dependency ${specifier}`);
}

async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? files(path) : [path];
    }),
  );
  return nested.flat();
}

try {
  run("pnpm", ["pack", "--pack-destination", scratch], packageRoot);
  const tarball = (await readdir(scratch)).find((file) => file.endsWith(".tgz"));
  assert(tarball, "pnpm pack must produce a tarball");
  const modules = join(scratch, "node_modules");
  const packed = join(modules, "@nteract/sift");
  await mkdir(packed, { recursive: true });
  run("tar", ["-xzf", join(scratch, tarball), "--strip-components=1", "-C", packed]);
  const manifest = JSON.parse(await readFile(join(packed, "package.json"), "utf8"));
  const dependencies = { ...manifest.dependencies, ...manifest.peerDependencies };
  assert(
    !dependencies["@nteract/odometer"],
    "Bundled private odometer must not be installed by consumers",
  );
  assert(!Object.values(dependencies).some((value) => /^(workspace|link|file):/.test(value)));
  assert(
    !(await readdir(packed)).includes("src"),
    "The package must not depend on source checkout files",
  );

  for (const entry of Object.values(manifest.exports)) {
    for (const file of typeof entry === "string" ? [entry] : Object.values(entry)) {
      assert((await readFile(resolve(packed, file))).byteLength > 0, `Missing export ${file}`);
    }
  }

  // Reuse installed public dependencies without a registry request. Only
  // declared dependencies enter this isolated consumer's resolution tree.
  for (const dependency of [...Object.keys(dependencies), "@types/react", "@types/react-dom"]) {
    const destination = join(modules, dependency);
    await mkdir(dirname(destination), { recursive: true });
    await symlink(await packageDirectory(dependency), destination, "dir");
  }
  await writeFile(join(scratch, "package.json"), JSON.stringify({ type: "module" }));
  await writeFile(
    join(scratch, "consumer.tsx"),
    `
    import { SiftTable, createTable, parseCsv, loadTableFile, setWasmUrl, type TableData } from "@nteract/sift";
    import { SiftFocusStatus } from "@nteract/sift/handoff";
    const view = <SiftTable source={{ kind: "url", url: "/local.arrow" }} />;
    const status = <SiftFocusStatus label="Table focused" />;
    declare const data: TableData;
    createTable(document.createElement("div"), data).destroy();
    setWasmUrl("/local/sift.wasm");
    parseCsv("name\\nAda", { typing: "text" });
    void loadTableFile(new Uint8Array(), { maxRows: 100 });
    const binaryView = <SiftTable source={{ kind: "loader", load: () => loadTableFile(new Uint8Array()) }} />;
    void binaryView;
    void view; void status;
  `,
  );
  const program = ts.createProgram([join(scratch, "consumer.tsx")], {
    strict: true,
    noEmit: true,
    skipLibCheck: false,
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX,
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(
    diagnostics.length,
    0,
    ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCurrentDirectory: () => scratch,
      getCanonicalFileName: (file) => file,
      getNewLine: () => "\n",
    }),
  );

  // Check every generated import, not just modules touched by the smoke call.
  for (const file of await files(join(packed, "lib"))) {
    if (!/\.(js|ts)$/.test(file)) continue;
    const content = await readFile(file, "utf8");
    const imports = ts.preProcessFile(content, true, true).importedFiles;
    for (const { fileName: imported } of imports) {
      if (imported.startsWith(".")) continue;
      const name = imported.startsWith("@")
        ? imported.split("/").slice(0, 2).join("/")
        : imported.split("/")[0];
      assert(name in dependencies, `${file} imports undeclared package ${imported}`);
    }
  }
  // Notices must name third-party code from both shipped builds.
  const notices = await readFile(join(packed, "lib/THIRD_PARTY_NOTICES.md"), "utf8");
  for (const name of ["parquet", "arrow-array", "rxjs"]) {
    assert.match(notices, new RegExp(`^\\| ${name} \\| `, "m"), `Notices must list ${name}`);
  }
  const css = await readFile(join(packed, "lib/style.css"), "utf8");
  assert(css.includes(".sift-table-container"), "Compiled table styles must be shipped");
  assert(!/@(?:import|source|theme)\b/.test(css), "Consumers must not need a Tailwind compiler");

  const api = await import(pathToFileURL(join(packed, "lib/index.js")));
  assert.equal(typeof api.SiftTable, "function");
  assert.equal(typeof api.createTable, "function");
  const binary = await readFile(join(packed, "lib/wasm/sift_wasm_bg.wasm"));
  api.setWasmUrl(`data:application/wasm;base64,${binary.toString("base64")}`);
  // Initialize through the public API to verify its relative dynamic import
  // resolves to the packaged glue. Invalid data must reject after initialization.
  await assert.rejects(
    api.loadTableFile(new Uint8Array([1, 2, 3])),
    /Arrow|IPC|EOF|metadata|message|buffer/i,
  );
  const wasm = await import(pathToFileURL(join(packed, "lib/wasm/sift_wasm.js")));
  await wasm.default({ module_or_path: binary });
  // A synthetic Arrow fixture exercises the shipped glue and binary together.
  const { tableFromArrays, tableToIPC } = await import("apache-arrow");
  const handle = wasm.load_ipc(tableToIPC(tableFromArrays({ value: [3, 1, null] })));
  try {
    assert.equal(wasm.num_rows(handle), 3);
    assert.equal(wasm.is_null(handle, 2, 0), true);
    assert.deepEqual([...wasm.store_sort_indices(handle, 0, true)], [1, 0, 2]);
  } finally {
    wasm.free(handle);
  }
  // Exercise the shipped bounded loaders and filters, not source stubs. The
  // browser smoke covers the public adapter, whose text layout needs a canvas.
  // Missing values must not become the empty-string category in either format.
  const categories = tableToIPC(tableFromArrays({ name: [null, "", "null", "NA", null] }));
  for (const load of [
    () => wasm.load_ipc_bounded(categories, 5, 1, 1024 * 1024),
    () => wasm.load_parquet_bounded(wasm.write_parquet_ipc(categories), 5, 1, 1024 * 1024),
  ]) {
    const categoryHandle = load();
    try {
      assert.equal(wasm.is_null(categoryHandle, 0, 0), true);
      assert.equal(wasm.is_null(categoryHandle, 1, 0), false);
      assert.equal(wasm.get_cell_string(categoryHandle, 1, 0), "");
      assert.deepEqual(
        [...wasm.store_filter_rows(categoryHandle, [{ kind: "set", col: 0, values: [""] }])],
        [1],
      );
      assert.deepEqual(
        [...wasm.store_filter_rows(categoryHandle, [{ kind: "not_in", col: 0, values: [""] }])],
        [0, 2, 3, 4],
      );
    } finally {
      wasm.free(categoryHandle);
    }
  }
  if (process.argv.includes("--browser")) {
    const { testPackageBrowser } = await import("./test-package-browser.mjs");
    await testPackageBrowser({
      scratch,
      packageRoot,
      tarballPath: join(scratch, tarball),
      wasm,
      tableFromArrays,
      tableToIPC,
    });
  }
  console.log(
    "Packed Sift: exports, declarations, compiled CSS, standalone imports, and real WASM decode/sort passed.",
  );
} finally {
  await rm(scratch, { recursive: true, force: true });
}
