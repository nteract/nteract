import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { patchWordgard } from "../patch-wordgard.mjs";

test("Wordgard patch accepts only the pinned original source and changes one sign", () => {
  const root = mkdtempSync(join(tmpdir(), "wordgard-patch-"));
  try {
    mkdirSync(join(root, "dist"));
    const installed = readFileSync(
      new URL("../node_modules/wordgard/dist/editor.js", import.meta.url),
      "utf8",
    );
    const original = installed.replace("let posA = posB + off;", "let posA = posB - off;");
    const manifest = (version) =>
      writeFileSync(join(root, "package.json"), JSON.stringify({ name: "wordgard", version }));
    const file = join(root, "dist/editor.js");
    manifest("0.6.2");
    writeFileSync(file, original);
    patchWordgard(root);
    assert.equal(
      readFileSync(file, "utf8"),
      original.replace("let posA = posB - off;", "let posA = posB + off;"),
    );
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
