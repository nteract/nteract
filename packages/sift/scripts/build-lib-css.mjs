import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const require = createRequire(import.meta.url);

function packageRoot(specifier) {
  let dir = dirname(require.resolve(specifier, { paths: [process.cwd()] }));
  while (dir !== dirname(dir)) {
    if (existsSync(resolve(dir, "package.json"))) return dir;
    dir = dirname(dir);
  }
  throw new Error(`Could not resolve package root for ${specifier}`);
}

// Reuse the Tailwind compiler that the package already gets through the Vite plugin.
const tailwindViteRoot = packageRoot("@tailwindcss/vite");
const { compile, optimize, Features } = require(
  require.resolve("@tailwindcss/node", {
    paths: [tailwindViteRoot],
  }),
);
const { Scanner } = require(require.resolve("@tailwindcss/oxide", { paths: [tailwindViteRoot] }));

const inputPath = resolve("src/style.css");
const outputPath = resolve("lib/style.css");
const css = await readFile(inputPath, "utf8");

const compiler = await compile(css, {
  base: dirname(inputPath),
  from: inputPath,
  shouldRewriteUrls: true,
  onDependency() {},
});

let candidates = [];
if (compiler.features & Features.Utilities) {
  const sources = (
    compiler.root === "none"
      ? []
      : compiler.root === null
        ? [{ base: process.cwd(), pattern: "**/*", negated: false }]
        : [{ ...compiler.root, negated: false }]
  ).concat(compiler.sources);
  candidates = new Scanner({ sources }).scan();
}

const output = compiler.build(candidates);
const optimized = optimize(output, { file: inputPath, minify: true });

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, optimized.code);
