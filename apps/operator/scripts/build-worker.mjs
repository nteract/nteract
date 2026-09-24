import { build } from "esbuild";
await build({
  entryPoints: ["src/worker.ts"],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  outfile: "dist/worker.js",
});
