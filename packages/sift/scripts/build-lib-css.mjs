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

// Tailwind emits its theme variables (--spacing, --text-sm, ...) on
// `:root, :host`. Sift writes nothing to the document root, so move that
// block onto `.sift-root`, where the utilities that read it already live.
const themeSelector = /^(\s*):root,\s*:host\s*\{/m;
if (!themeSelector.test(output)) {
  throw new Error("Expected one Tailwind `:root, :host` theme block in the compiled CSS.");
}
const scoped = output.replace(themeSelector, "$1.sift-root {");
if (/:root|:host/.test(scoped)) {
  throw new Error(
    "Compiled Sift CSS still targets the document root; it must only style .sift-root.",
  );
}

// Restrict every emitted style rule, including shared Tailwind utility names,
// to Sift-owned elements. Keeping this as a zero-specificity condition retains
// the cascade within Sift; placing it before pseudo-elements also scopes those.
const { transform } = require(
  require.resolve("lightningcss", {
    paths: [require.resolve("@tailwindcss/node", { paths: [tailwindViteRoot] })],
  }),
);
const ownership = {
  type: "pseudo-class",
  kind: "where",
  selectors: [
    [{ type: "class", name: "sift-root" }],
    [
      { type: "class", name: "sift-root" },
      { type: "combinator", value: "descendant" },
      { type: "universal" },
    ],
  ],
};
const isolated = transform({
  filename: inputPath,
  code: Buffer.from(scoped),
  visitor: {
    Selector(selector) {
      const pseudo = selector.findIndex((part) => part.type === "pseudo-element");
      selector.splice(pseudo < 0 ? selector.length : pseudo, 0, structuredClone(ownership));
      return selector;
    },
  },
});
const optimized = optimize(isolated.code.toString(), { file: inputPath, minify: true });

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, optimized.code);
