import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { sourceFingerprint } from "./source-fingerprint.mjs";

test("artifact fingerprints need source only; builds also reject missing or stale installed code", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "pages-artifact-fingerprint-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const app = path.join(root, "apps/pages");
  const write = (relative, value) => {
    const file = path.join(root, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, value);
  };
  for (const file of ["package.json", "package-lock.json", "upstream-provenance.json"])
    write(`apps/pages/${file}`, "{}");
  for (const file of ["patch-upstream.mjs", "setup.mjs", "UPSTREAM.md"])
    write(`apps/pages/${file}`, "");
  write("apps/pages/view.mjs", 'import { mount } from "@nteract/output-frame";');
  const packageRoot = path.join(root, "packages/output-frame");
  write(
    "packages/output-frame/package.json",
    JSON.stringify({
      name: "@nteract/output-frame",
      type: "module",
      exports: "./src/host.mjs",
    }),
  );
  write("packages/output-frame/src/host.mjs", "export const mount = () => {};");
  write("packages/output-frame/src/runtime.mjs", "export const runtime = 1;");
  write("packages/output-frame/src/styles.css", "button { color: red; }");

  // The deployment controller hashes an artifact checkout without node_modules.
  const artifact = sourceFingerprint(app, { root });
  assert.ok(artifact.files["packages/output-frame/src/styles.css"]);
  assert.ok(artifact.files["packages/output-frame/src/runtime.mjs"]);
  assert.throws(
    () => sourceFingerprint(app, { root, verifyInstalled: true }),
    /Cannot find module/,
  );

  cpSync(packageRoot, path.join(app, "node_modules/@nteract/output-frame"), { recursive: true });
  assert.equal(sourceFingerprint(app, { root, verifyInstalled: true }).sha256, artifact.sha256);

  // A source-only change must affect the receipt and prevent a stale-copy build.
  write("packages/output-frame/src/styles.css", "button { color: blue; }");
  assert.notEqual(sourceFingerprint(app, { root }).sha256, artifact.sha256);
  assert.throws(
    () => sourceFingerprint(app, { root, verifyInstalled: true }),
    /differs from this checkout/,
  );
});
