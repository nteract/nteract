import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { assembleRuntimeAssets } from "@nteract/pyodide-runtime/deployment";
import { basename } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
// The service assembles the machine's immutable assets into its deployment.
// It does not compile Python or own the interpreter/package dependency graph.
await assembleRuntimeAssets(new URL("../dist/", import.meta.url));
await build({
  absWorkingDir: fileURLToPath(new URL("..", import.meta.url)),
  entryPoints: ["src/provider.js"],
  outfile: "dist/provider.js",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  external: ["cloudflare:workers"],
  plugins: [
    {
      name: "session-source",
      setup(builder) {
        builder.onLoad({ filter: /\.wasm$/ }, async (args) => {
          const bytes = await readFile(args.path);
          return {
            contents: `export default ${JSON.stringify({ asset: basename(args.path), sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length })};`,
            loader: "js",
          };
        });
        builder.onLoad({ filter: /dist\/session\.js$/ }, async (args) => ({
          contents: await readFile(args.path, "utf8"),
          loader: "text",
        }));
      },
    },
  ],
});
