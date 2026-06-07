import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { saveSmokeScreenshot, smokeOutputPath } from "../scripts/smoke-paths.mjs";

describe("notebook-cloud smoke paths", () => {
  it("returns undefined for absent output paths", () => {
    assert.equal(smokeOutputPath(undefined), undefined);
    assert.equal(smokeOutputPath(""), undefined);
  });

  it("preserves absolute output paths", () => {
    const absolute = path.join(os.tmpdir(), "notebook-cloud-smoke.png");
    assert.equal(smokeOutputPath(absolute, { INIT_CWD: "/ignored" }), absolute);
  });

  it("resolves relative output paths against INIT_CWD when available", () => {
    assert.equal(
      smokeOutputPath(".context/smoke.png", { INIT_CWD: "/workspace" }),
      path.resolve("/workspace", ".context/smoke.png"),
    );
  });

  it("falls back to process.cwd() for relative output paths", () => {
    assert.equal(smokeOutputPath(".context/smoke.png", {}), path.resolve(".context/smoke.png"));
  });

  it("creates screenshot parent directories before capture", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "notebook-cloud-smoke-"));
    try {
      const screenshotPath = path.join(root, "nested", "smoke.png");
      let capturedPath = null;
      await saveSmokeScreenshot(
        {
          async screenshot(options) {
            capturedPath = options.path;
            await writeFile(options.path, "captured");
          },
        },
        screenshotPath,
      );

      assert.equal(capturedPath, screenshotPath);
      assert.equal(await readFile(screenshotPath, "utf8"), "captured");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
