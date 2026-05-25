import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(appDir, "../..");

describe("cloud renderer host contract", () => {
  it("keeps cloud API route knowledge out of shared renderer code", () => {
    const checkedFiles = [
      ...sourceFiles(path.join(appDir, "viewer")),
      ...sourceFiles(path.join(repoRoot, "src/components/isolated")),
      ...sourceFiles(path.join(repoRoot, "src/isolated-renderer")),
    ].filter((file) => !file.includes(`${path.sep}__tests__${path.sep}`));

    const offenders = checkedFiles.filter((file) =>
      fs.readFileSync(file, "utf8").includes("/api/n"),
    );

    assert.deepEqual(
      offenders.map((file) => path.relative(repoRoot, file)),
      [],
      "renderer paths must receive host URLs through BlobResolver/host context instead of reconstructing cloud API routes",
    );
  });
});

function sourceFiles(root: string): string[] {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(fullPath);
    if (!/\.(ts|tsx|js|jsx)$/.test(entry.name)) return [];
    return [fullPath];
  });
}
