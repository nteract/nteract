import { copyFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

// The WASM the Worker imports: compiled modules that ship beside index.js.
// Automerge's workerd entry imports its binary; Pages' `#sift-wasm` imports
// Sift's (worker/sift-wasm.workerd.mjs). The browser copies of both are
// separate hashed assets under public/ (scripts/build.mjs).
const MODULE_SOURCES = Object.freeze({
  "automerge.wasm": "@automerge/automerge/",
  "sift.wasm": "@nteract/sift/",
});

/** Every Worker module, by its file name in a build, a release and a stage. */
export const WORKER_MODULES = Object.freeze(Object.keys(MODULE_SOURCES));

/** The module a resolved `.wasm` path ships as: the one its package owns. */
export function workerModuleName(resolved) {
  const normalized = resolved.split(path.sep).join("/");
  const name = WORKER_MODULES.find((file) =>
    normalized.includes(`/node_modules/${MODULE_SOURCES[file]}`),
  );
  if (!name) throw Error(`The Worker imports WASM no Worker module names: ${resolved}`);
  return name;
}

/** esbuild plugin: copy each `.wasm` the Worker imports to `outdir` under its
 * module name, and leave the import to the runtime as a compiled module. */
export function workerWasmPlugin(outdir) {
  return {
    name: "worker-wasm",
    setup(b) {
      b.onResolve({ filter: /\.wasm$/ }, async (args) => {
        const resolved = args.path.startsWith(".")
          ? path.resolve(args.resolveDir, args.path)
          : createRequire(path.join(args.resolveDir, "noop.js")).resolve(args.path);
        const name = workerModuleName(resolved);
        await copyFile(resolved, path.join(outdir, name));
        return { path: `./${name}`, external: true };
      });
    },
  };
}
