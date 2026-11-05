import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const PRODUCTION_DIRS = ["authz", "model", "shared", "sync", "viewer", "worker"];
const PM_MODULES = [
  "model/pm-adapter.mjs",
  "model/pm-markdown-parser.mjs",
  "model/pm-markdown-serializer.mjs",
];
const PM_IMPORT =
  /(?:from\s*|import\s*\(\s*)["'](?:@automerge\/prosemirror|prosemirror-[a-z-]+)(?:\/[^"']*)?["']/;

function sources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sources(path);
    return /\.(mjs|js|jsx)$/.test(entry.name) && !entry.name.endsWith(".test.mjs") ? [path] : [];
  });
}

test("only the pm-* modules import ProseMirror packages", () => {
  const importers = PRODUCTION_DIRS.flatMap((dir) => sources(join(root, dir)))
    .filter((path) => PM_IMPORT.test(readFileSync(path, "utf8")))
    .map((path) => relative(root, path).split("\\").join("/"))
    .sort();
  assert.deepEqual(importers, PM_MODULES);
});
