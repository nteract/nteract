import { build } from "esbuild";
import { readFile, mkdir, copyFile } from "node:fs/promises";
import { basename } from "node:path";
import { createHash } from "node:crypto";
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
const wheels = JSON.parse(
  await readFile(new URL("../dist/packages.json", import.meta.url), "utf8"),
);
await mkdir(new URL("../dist/wheels/", import.meta.url), { recursive: true });
for (const { filename } of wheels) {
  await copyFile(
    new URL(`../.scratch/packages/${filename}`, import.meta.url),
    new URL(`../dist/wheels/${filename}`, import.meta.url),
  );
}
const { readdir } = await import("node:fs/promises");
for (const filename of await readdir(new URL("../dist/", import.meta.url))) {
  if (!filename.endsWith(".wasm")) continue;
  await copyFile(
    new URL(`../dist/${filename}`, import.meta.url),
    new URL(`../dist/wheels/${filename}`, import.meta.url),
  );
}
