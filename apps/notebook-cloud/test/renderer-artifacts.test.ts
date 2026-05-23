import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const REPO_ROOT = new URL("../../../", import.meta.url);
const REGISTRY_SOURCE = new URL("src/lib/renderer-registry.ts", REPO_ROOT);
const ISOLATED_RENDERER_ARTIFACT = new URL(
  "apps/notebook/src/renderer-plugins/isolated-renderer.js",
  REPO_ROOT,
);

describe("renderer plugin artifacts", () => {
  it("keeps the checked-in isolated renderer artifact compatible with the install context", async () => {
    const [registrySource, artifactSource] = await Promise.all([
      readFile(REGISTRY_SOURCE, "utf8"),
      readFile(ISOLATED_RENDERER_ARTIFACT, "utf8"),
    ]);

    assert.ok(
      !artifactSource.startsWith("version https://git-lfs.github.com/spec/"),
      "isolated renderer artifact must be checked out through Git LFS",
    );

    const fields = rendererInstallContextFields(registrySource);
    assert.notEqual(fields.length, 0, "RendererInstallContext fields were not found");

    for (const field of fields) {
      assert.ok(
        artifactSource.includes(field),
        `isolated renderer artifact is missing RendererInstallContext.${field}; run cargo xtask renderer-plugins`,
      );
    }
  });
});

function rendererInstallContextFields(source: string): string[] {
  const interfaceBody = source.match(
    /export interface RendererInstallContext\s*{(?<body>[\s\S]*?)^}/m,
  )?.groups?.body;
  if (!interfaceBody) return [];

  return Array.from(interfaceBody.matchAll(/^\s{2}(\w+):/gm), (match) => match[1]);
}
