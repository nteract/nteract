import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { viewerBuildOptions } from "../scripts/viewer-chunks.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
// Production code: these directories, recursively, and the root modules.
// Bundled dependencies are checked separately from this source inventory.
const PRODUCTION_DIRS = ["authz", "model", "shared", "sync", "viewer", "worker"];
const PM_IMPORT =
  /(?:from\s*|import\s*\(\s*|import\s+|require\s*\(\s*)["'](?:@automerge\/prosemirror|prosemirror-[a-z-]+)(?:\/[^"']*)?["']/;
const SOURCE = /\.(mjs|cjs|js|jsx|ts|tsx)$/;
const isTest = (name) => /\.test\.[cm]?[jt]sx?$/.test(name);

function sources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sources(path);
    return SOURCE.test(entry.name) && !isTest(entry.name) ? [path] : [];
  });
}
const rootModules = () =>
  readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && SOURCE.test(entry.name) && !isTest(entry.name))
    .map((entry) => join(root, entry.name));

test("production source has no ProseMirror imports", () => {
  const importers = [
    ...PRODUCTION_DIRS.flatMap((dir) => sources(join(root, dir))),
    ...rootModules(),
  ]
    .filter((path) => PM_IMPORT.test(readFileSync(path, "utf8")))
    .map((path) => relative(root, path).split("\\").join("/"))
    .sort();
  assert.deepEqual(importers, []);
});

test("complete worker and viewer dependency graphs contain no ProseMirror", async () => {
  const result = await build({
    entryPoints: [join(root, "worker/index.mjs"), join(root, "viewer/main.jsx")],
    outdir: "unused",
    bundle: true,
    write: false,
    metafile: true,
    platform: "browser",
    format: "esm",
    alias: viewerBuildOptions(root, root).alias,
    external: ["cloudflare:workers", "node:*", "*.wasm", "pages-sift-assets"],
    loader: { ".css": "empty", ".svg": "dataurl" },
    tsconfig: join(root, "tsconfig.json"),
  });
  assert.deepEqual(
    Object.keys(result.metafile.inputs).filter((path) =>
      /prosemirror|pm-adapter|pm-markdown-parser/.test(path),
    ),
    [],
  );
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.deepEqual(
    Object.keys(pkg.dependencies).filter((name) => /prosemirror/.test(name)),
    [],
  );
});

test("the boundary pattern catches every import form", () => {
  for (const line of [
    'import { Schema } from "prosemirror-model";',
    "import 'prosemirror-view/style/prosemirror.css';",
    'const pm = await import("@automerge/prosemirror/dist/traversal.js");',
    'export { MarkdownParser } from "prosemirror-markdown";',
    'const { Schema } = require("prosemirror-model");',
  ])
    assert.ok(PM_IMPORT.test(line), line);
  assert.ok(!PM_IMPORT.test('import { adapter } from "./pm-adapter.mjs";'));
});
