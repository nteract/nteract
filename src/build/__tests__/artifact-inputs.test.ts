// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  artifactInputs,
  digestFile,
  writeArtifactReceipt,
  writeIfChanged,
} from "../artifact-inputs";

const roots: string[] = [];
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nteract-asset-inputs-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src/input.ts"), "export const value = 1;");
  fs.writeFileSync(path.join(root, "bundle.js"), "bundle");
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test("source directory fingerprints detect additions, edits and deletion", () => {
  const root = fixture();
  const dir = path.join(root, "src");
  const before = digestFile(dir);
  fs.writeFileSync(path.join(dir, "new.tsx"), '<div className="p-4" />');
  expect(digestFile(dir)).not.toBe(before);
  fs.unlinkSync(path.join(dir, "new.tsx"));
  expect(digestFile(dir)).toBe(before);
  fs.writeFileSync(path.join(dir, "input.ts"), "export const value = 2;");
  expect(digestFile(dir)).not.toBe(before);
});

test("no-op output publication preserves timestamps and receipts", () => {
  const root = fixture();
  const output = path.join(root, "bundle.js");
  fs.utimesSync(output, 1, 1);
  writeIfChanged(output, "bundle");
  expect(fs.statSync(output).mtimeMs).toBe(1000);
  const inputs = { "src/input.ts": digestFile(path.join(root, "src/input.ts")) };
  writeArtifactReceipt(root, "example", inputs, ["bundle.js"]);
  const receipt = path.join(root, "target/xtask/example.inputs.json");
  fs.utimesSync(receipt, 1, 1);
  writeArtifactReceipt(root, "example", inputs, ["bundle.js"]);
  expect(fs.statSync(receipt).mtimeMs).toBe(1000);
  writeIfChanged(output, "new bundle");
  expect(fs.readFileSync(output, "utf8")).toBe("new bundle");
});

test("edits during a build cannot certify stale output", () => {
  const root = fixture();
  const source = path.join(root, "src/input.ts");
  const inputs = artifactInputs(root, ["src/input.ts"]);
  fs.utimesSync(source, new Date(), new Date(Date.now() + 10_000));
  expect(() => inputs.snapshot()).toThrow("changed during build");
  const old = { "src/input.ts": digestFile(source) };
  fs.writeFileSync(source, "changed");
  expect(() => writeArtifactReceipt(root, "example", old, ["bundle.js"])).toThrow(
    "changed before publication",
  );
  expect(fs.existsSync(path.join(root, "target/xtask/example.inputs.json"))).toBe(false);
});
