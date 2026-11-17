// Automerge's WASM must be initialized before its consumers run. One shared
// module initializes it, so bundling keeps a single top-level await. Only the
// editor chunk reaches this module; app.js renders without it.
// viewer/wasm-preload.mjs preloads this URL so the download overlaps the
// editor chunk's. The browser reuses a preload only when URL and request mode
// match, so this module issues the request itself as a plain same-origin
// fetch(url) call. This is the source name. scripts/build.mjs passes the
// content-hashed URL to the plugin and, through wasmUrlDefine, to the
// preload in theme.js and app.js.
export const BROWSER_WASM_URLS = Object.freeze({
  automerge: "/automerge.wasm",
});

/** The esbuild define naming the WASM URL viewer/wasm-preload.mjs preloads. */
export const wasmUrlDefine = (urls = BROWSER_WASM_URLS) => ({
  __PAGES_AUTOMERGE_WASM_URL__: JSON.stringify(urls.automerge),
});

export function browserWasmPlugin(app, urls = BROWSER_WASM_URLS) {
  return {
    name: "browser-wasm",
    setup(b) {
      b.onResolve({ filter: /^@automerge\/automerge$/ }, (args) => ({
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
          await initializeWasm(fetch(${JSON.stringify(urls.automerge)}));
        `,
        resolveDir: app,
        loader: "js",
      }));
    },
  };
}
