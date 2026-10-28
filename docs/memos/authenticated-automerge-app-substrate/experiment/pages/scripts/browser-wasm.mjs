// Both independent runtimes must be initialized before their consumers run,
// but neither initialization depends on the other. Use one shared module so
// bundling cannot turn their separate top-level awaits into a fetch waterfall.
export function browserWasmPlugin(app) {
  return {
    name: "browser-wasm",
    setup(b) {
      b.onResolve({ filter: /^@automerge\/(automerge|subduction)$/ }, (args) => ({
        path: args.path,
        namespace: "wasm-entry",
      }));
      b.onResolve({ filter: /^pages-wasm-ready$/ }, () => ({
        path: "pages-wasm-ready",
        namespace: "wasm-ready",
      }));
      b.onLoad({ filter: /.*/, namespace: "wasm-entry" }, (args) => ({
        contents: `import "pages-wasm-ready"; export * from "${args.path}/slim";`,
        resolveDir: app,
        loader: "js",
      }));
      b.onLoad({ filter: /.*/, namespace: "wasm-ready" }, () => ({
        contents: `
          import { initializeWasm } from "@automerge/automerge/slim";
          import initializeSubduction from "@automerge/subduction/slim";
          await Promise.all([
            initializeWasm(fetch("/automerge.wasm")),
            initializeSubduction({ module_or_path: "/subduction.wasm" }),
          ]);
        `,
        resolveDir: app,
        loader: "js",
      }));
    },
  };
}
