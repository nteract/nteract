import test from "node:test";
import assert from "node:assert/strict";
import { projectCloudPackages } from "../viewer/cloud-packages.ts";

test("package projection keeps saved intent separate and rejects stale session observations", () => {
  const metadata = { runt: { pyodide: { requirements: [] } } };
  const progress = {
    message: "Waiting for another package installation…",
    managed_packages: {
      session_id: "old",
      phase: "ready",
      installed: ["six==1.0"],
      error: "Old failure",
      needs_restart: true,
    },
  };
  assert.deepEqual(projectCloudPackages(metadata, progress, "new", true), {
    requirements: [],
    installed: [],
    phase: "unavailable",
    error: null,
    progressMessage: null,
    needsRestart: false,
  });
  const current = projectCloudPackages(metadata, progress, "old", true);
  assert.equal(current.progressMessage, progress.message);
  assert.deepEqual(current.requirements, []);
  assert.deepEqual(current.installed, ["six==1.0"]);
  assert.deepEqual(projectCloudPackages(metadata, progress, "old", false).installed, []);
});
