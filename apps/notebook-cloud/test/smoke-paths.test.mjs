import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  saveSmokeScreenshot,
  smokeJsonReportPath,
  smokeOutputPath,
  writeSmokeJsonReport,
} from "../scripts/smoke-paths.mjs";

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

  it("preserves explicit JSON report paths", () => {
    const absolute = path.join(os.tmpdir(), "notebook-cloud-smoke.json");
    assert.equal(
      smokeJsonReportPath("hosted", { NOTEBOOK_CLOUD_SMOKE_REPORT: absolute }),
      absolute,
    );
  });

  it("resolves explicit relative JSON report paths against INIT_CWD", () => {
    assert.equal(
      smokeJsonReportPath("hosted", {
        INIT_CWD: "/workspace",
        NOTEBOOK_CLOUD_SMOKE_REPORT: ".context/hosted.json",
      }),
      path.resolve("/workspace", ".context/hosted.json"),
    );
  });

  it("returns undefined when JSON reports are not requested", () => {
    assert.equal(smokeJsonReportPath("hosted", {}), undefined);
  });

  it("creates automatic JSON report paths under .context when requested", () => {
    assert.equal(
      smokeJsonReportPath(
        "hosted-render-smoke",
        {
          INIT_CWD: "/workspace",
          NOTEBOOK_CLOUD_WRITE_SMOKE_REPORT: "1",
        },
        new Date("2026-06-07T14:28:36.789Z"),
      ),
      path.resolve(
        "/workspace",
        ".context/smokes/reports/hosted-render-smoke-20260607-142836.json",
      ),
    );
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

  it("creates JSON report parent directories before writing", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "notebook-cloud-smoke-"));
    try {
      const reportPath = path.join(root, "nested", "smoke.json");
      const written = await writeSmokeJsonReport({ ok: true, count: 2 }, reportPath);

      assert.equal(written, true);
      assert.equal(await readFile(reportPath, "utf8"), '{\n  "ok": true,\n  "count": 2\n}\n');
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("skips JSON report writes when no path is configured", async () => {
    assert.equal(await writeSmokeJsonReport({ ok: true }, undefined), false);
  });
});
