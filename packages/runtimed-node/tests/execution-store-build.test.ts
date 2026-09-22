import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vite-plus/test";

it("ships current CommonJS and declarations from the shared source", () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const script = path.resolve(directory, "../scripts/build-execution-store.mjs");
  execFileSync(process.execPath, [script, "--check"]);
  const manifest = JSON.parse(readFileSync(path.resolve(directory, "../package.json"), "utf8"));
  expect(manifest.files).toContain("src/execution-store.cjs");
  expect(manifest.files).toContain("src/execution-store.d.cts");
});
