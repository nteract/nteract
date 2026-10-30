// Both independent runtimes must be initialized before their consumers run,
// but neither initialization depends on the other. Use one shared module so
// bundling cannot turn their separate top-level awaits into a fetch waterfall.
// viewer/index.html preloads these URLs so the downloads overlap app.js. The
// browser reuses a preload only when URL and request mode match, so this
// module issues both requests itself as plain same-origin fetch(url) calls.
export const BROWSER_WASM_URLS = Object.freeze({
  automerge: "/automerge.wasm",
  subduction: "/subduction.wasm",
});

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
            initializeWasm(fetch(${JSON.stringify(BROWSER_WASM_URLS.automerge)})),
            initializeSubduction({
              module_or_path: fetch(${JSON.stringify(BROWSER_WASM_URLS.subduction)}),
            }),
          ]);
        `,
        resolveDir: app,
        loader: "js",
      }));
    },
  };
}
