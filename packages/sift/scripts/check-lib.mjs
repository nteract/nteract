import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const packageRoot = new URL("../", import.meta.url);

export async function requiredWasmExports() {
  // Use the current runtime contract, not generated declarations that could be
  // stale alongside an old binary. New API methods automatically join this check.
  const text = await readFile(new URL("src/predicate.ts", packageRoot), "utf8");
  const source = ts.createSourceFile("predicate.ts", text, ts.ScriptTarget.Latest, true);
  const contract = source.statements.find(
    (node) => ts.isTypeAliasDeclaration(node) && node.name.text === "PredicateModule",
  );
  assert(
    contract && ts.isTypeLiteralNode(contract.type),
    "Missing PredicateModule runtime contract",
  );
  const names = contract.type.members
    .filter(ts.isMethodSignature)
    .map((method) => method.name.getText(source));
  assert(names.length > 0, "PredicateModule must declare its WASM methods");
  return names;
}

export async function verifyWasmPair(binary, glueUrl, required) {
  const module = new WebAssembly.Module(binary);
  const exported = new Set(
    WebAssembly.Module.exports(module)
      .filter((entry) => entry.kind === "function")
      .map((entry) => entry.name),
  );
  for (const name of required) {
    assert(
      exported.has(name),
      `Sift WASM binary is missing runtime export ${name}. Rebuild with cargo xtask wasm sift --skip-renderer-plugins, then pnpm run build:lib.`,
    );
  }
  const glue = await import(glueUrl.href);
  for (const name of required) {
    assert.equal(
      typeof glue[name],
      "function",
      `Sift WASM glue is missing runtime export ${name}. Rebuild the WASM and library together.`,
    );
  }
  // Instantiation validates that the glue supplies the binary's actual imports.
  // Valid bytecode and matching export names alone do not establish ABI pairing.
  await glue.default({ module_or_path: module });
}

async function checkLibrary() {
  const manifest = JSON.parse(await readFile(new URL("package.json", packageRoot), "utf8"));
  for (const entry of Object.values(manifest.publishConfig.exports)) {
    for (const file of typeof entry === "string" ? [entry] : Object.values(entry)) {
      try {
        assert((await readFile(new URL(file, packageRoot))).byteLength > 0);
      } catch {
        throw new Error(
          `Missing library output ${file}. Run pnpm run build:lib before packing Sift.`,
        );
      }
    }
  }
  const wasm = await readFile(new URL("lib/wasm/sift_wasm_bg.wasm", packageRoot));
  await verifyWasmPair(
    wasm,
    new URL("lib/wasm/sift_wasm.js", packageRoot),
    await requiredWasmExports(),
  );
  console.log(
    `Verified library assets and WASM runtime ABI in ${fileURLToPath(new URL("lib/", packageRoot))}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await checkLibrary();
}
