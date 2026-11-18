// Local celld companion. Only catalog assets and the isolated output shell
// are exposed on this loopback listener.
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { startCatalogServer } from "./server.mjs";
import { brotliCompressSync, constants } from "node:zlib";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { standardImports as entries } from "../../shared/widget-imports.mjs";

const app = fileURLToPath(new URL("../../", import.meta.url));
const dir = path.join(app, ".output-dist/catalog");
const port = Number(process.env.PAGES_CATALOG_PORT || 9446);
const origin = `http://127.0.0.1:${port}`;
const nameOf = (id) => id.replace(/^@/, "").replaceAll("/", "-");
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
  outdir: dir,
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
const hash = (data) => createHash("sha256").update(data).digest("hex");
const manifest =
  JSON.stringify(
    {
      imports: Object.fromEntries(entries.map((id) => [id, nameOf(id) + ".js"])),
      files: Object.fromEntries(
        [...files]
          .map(([name, data]) => [name, hash(data)])
          .sort(([a], [b]) => a.localeCompare(b, "en")),
      ),
    },
    null,
    2,
  ) + "\n";
const pin = hash(manifest);
const directory = path.join(dir, pin);
await mkdir(directory, { recursive: true });
for (const [name, data] of files) {
  await writeFile(path.join(directory, name), data);
  if (data.length >= 1024)
    await writeFile(
      path.join(directory, name + ".br"),
      brotliCompressSync(data, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } }),
    );
}
await writeFile(path.join(directory, "manifest.json"), manifest);
await writeFile(path.join(dir, "current-" + port), pin);
if (process.argv.includes("--build-only")) console.log(pin);
else startCatalogServer({ dir, pin, origin, port });
