import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORDGARD_PATCHES, patchWordgard } from "../patch-wordgard.mjs";

const apply = (source, edit) =>
  WORDGARD_PATCHES.reduce(
    (text, [before, from, to]) =>
      edit === "undo"
        ? text.replace(before.replace(from, to), before)
        : text.replace(before, before.replace(from, to)),
    source,
  );

test("Wordgard patch accepts only the pinned original source and makes each edit once", () => {
  const root = mkdtempSync(join(tmpdir(), "wordgard-patch-"));
  try {
    mkdirSync(join(root, "dist"));
    const installed = readFileSync(
      new URL("../node_modules/wordgard/dist/editor.js", import.meta.url),
      "utf8",
    );
    for (const [before, from, to] of WORDGARD_PATCHES)
      assert.equal(installed.split(before.replace(from, to)).length, 2, "installed is patched");
    const original = apply(installed, "undo");
    const manifest = (version) =>
      writeFileSync(join(root, "package.json"), JSON.stringify({ name: "wordgard", version }));
    const file = join(root, "dist/editor.js");
    manifest("0.6.2");
    writeFileSync(file, original);
    patchWordgard(root);
    const patched = readFileSync(file, "utf8");
    assert.equal(patched, installed);
    assert.equal(patched.split("\n").length, original.split("\n").length, "no line moves");
    assert.match(patched, /let posA = posB \+ off;/);
    assert.match(patched, /tile\.posAtCoords\(this\.flushedState, coords\.x, coords\.y\)/);
    assert.throws(() => patchWordgard(root), /source hash/);
    writeFileSync(file, `${original}\n`);
    assert.throws(() => patchWordgard(root), /source hash/);
    manifest("0.6.3");
    writeFileSync(file, original);
    assert.throws(() => patchWordgard(root), /package version/);
    assert.equal(readFileSync(file, "utf8"), original);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
