import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
await build({
  absWorkingDir: fileURLToPath(new URL("..", import.meta.url)),
  entryPoints: ["src/provider.js"],
  outfile: "dist/provider.js",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  external: ["cloudflare:workers"],
  loader: { ".wasm": "binary", ".whl": "binary" },
  plugins: [
    {
      name: "session-source",
      setup(builder) {
        builder.onLoad({ filter: /dist\/session\.js$/ }, async (args) => ({
          contents: await readFile(args.path, "utf8"),
          loader: "text",
        }));
      },
    },
  ],
});
