// The view library catalog: the libraries in shared/widget-imports.mjs,
// bundled as ES modules that share one split graph, and their manifest.
//
// manifest.json is {imports: id → file name, files: file name → sha256 of its
// bytes}. The catalog's revision is the sha256 of the manifest's text, so the
// revision names every byte. npm run build writes the catalog under
// dist/public/catalog/<revision>/, the Pages Worker serves it from there
// (worker/library-catalog.mjs), and a view's catalog_revision pins one.
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { standardImports } from "../shared/widget-imports.mjs";

/** The catalog's directory in a build's dist, and its URL path prefix. */
export const LIBRARY_CATALOG_DIRECTORY = "public/catalog";
/** A catalog file name: the only names a catalog directory holds. */
export const LIBRARY_FILE = /^[\w-]+\.(?:js|css|wasm|json)$/;
export const LIBRARY_MANIFEST = "manifest.json";

const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const nameOf = (id) => id.replace(/^@/, "").replaceAll("/", "-");

/**
 * Bundle the catalog for the app at `app`. Returns {revision, manifest, files}:
 * the manifest's text and every file by name, manifest.json included. The
 * same sources give the same bytes, so the same revision.
 */
export async function buildLibraryCatalog(app, { entries = standardImports } = {}) {
  const requireFromApp = createRequire(path.join(app, "package.json"));
  const result = await build({
    absWorkingDir: app,
    entryPoints: entries.map((id) => ({ in: `catalog:${id}`, out: nameOf(id) })),
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    minify: true,
    write: false,
    outdir: path.join(app, ".output-dist/catalog-build"),
    define: { "process.env.NODE_ENV": '"production"' },
    alias: {
      react: path.join(app, "node_modules/react"),
      "react-dom": path.join(app, "node_modules/react-dom"),
    },
    plugins: [
      {
        name: "catalog-entries",
        setup(plugin) {
          plugin.onResolve({ filter: /^catalog:/ }, ({ path }) => ({
            path: path.slice(8),
            namespace: "catalog",
          }));
          plugin.onLoad({ filter: /.*/, namespace: "catalog" }, ({ path: id }) => {
            let contents;
            if (id === "@nteract/sift/parquet") {
              contents =
                "import {setWasmUrl} from '@nteract/sift'; setWasmUrl(new URL('./sift.wasm', import.meta.url).href); export {loadTableFile} from '@nteract/sift';";
            } else if (id.startsWith("react")) {
              // Publish CJS React entry points as real named ESM exports. All
              // importers resolve the same React module within the split graph.
              const names = Object.keys(requireFromApp(id)).filter((name) =>
                /^[a-zA-Z_$][\w$]*$/.test(name),
              );
              contents = `import api from '${id}'; export default api; export const {${names.join(",")}} = api;`;
            } else {
              contents = `export * from '${id}';`;
            }
            return { contents, resolveDir: app };
          });
        },
      },
    ],
  });
  const files = new Map(result.outputFiles.map((f) => [path.basename(f.path), f.contents]));
  files.set("sift.wasm", await readFile(requireFromApp.resolve("@nteract/sift/sift.wasm")));
  for (const name of files.keys())
    if (!LIBRARY_FILE.test(name) || name === LIBRARY_MANIFEST)
      throw new Error(`The library catalog cannot hold a file named ${name}`);
  const manifest =
    JSON.stringify(
      {
        imports: Object.fromEntries(entries.map((id) => [id, nameOf(id) + ".js"])),
        files: Object.fromEntries(
          [...files]
            .map(([name, data]) => [name, sha256(data)])
            .sort(([a], [b]) => a.localeCompare(b, "en")),
        ),
      },
      null,
      2,
    ) + "\n";
  files.set(LIBRARY_MANIFEST, new TextEncoder().encode(manifest));
  return { revision: sha256(manifest), manifest, files };
}

/** Write `catalog` into `directory`/<revision>/. Returns each file's path
 * relative to `directory`, sorted. */
export async function writeLibraryCatalog(directory, { revision, files }) {
  const into = path.join(directory, revision);
  await mkdir(into, { recursive: true });
  for (const [name, data] of files) await writeFile(path.join(into, name), data);
  return [...files.keys()].map((name) => `${revision}/${name}`).sort();
}
