import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const workspaceRoot = resolve(import.meta.dirname, "../../..");
const script = resolve(import.meta.dirname, "../scripts/portable-host-benchmark.mjs");

test("portable benchmark rejects an unknown scenario before contacting a host", () => {
  const dir = mkdtempSync(join(tmpdir(), "nteract-portable-benchmark-"));
  const manifest = join(dir, "manifest.json");
  const output = join(dir, "result.json");
  writeFileSync(manifest, JSON.stringify({ artifact: "fixture" }));

  const run = spawnSync(
    process.execPath,
    [
      script,
      "--candidate",
      "fixture",
      "--base-url",
      "http://127.0.0.1:9",
      "--manifest",
      manifest,
      "--output",
      output,
      "--scenario",
      "not-a-scenario",
    ],
    { cwd: workspaceRoot, encoding: "utf8" },
  );

  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /Unknown scenario not-a-scenario/);
});

test("portable benchmark emits a result bundle when a scenario fails", () => {
  const dir = mkdtempSync(join(tmpdir(), "nteract-portable-benchmark-"));
  const manifest = join(dir, "manifest.json");
  const output = join(dir, "result.json");
  writeFileSync(manifest, JSON.stringify({ artifact: "fixture" }));

  const run = spawnSync(
    process.execPath,
    [
      script,
      "--candidate",
      "fixture",
      "--candidate-version",
      "0",
      "--base-url",
      "http://127.0.0.1:9",
      "--manifest",
      manifest,
      "--output",
      output,
      "--scenario",
      "ingress",
    ],
    { cwd: workspaceRoot, encoding: "utf8" },
  );

  assert.notEqual(run.status, 0);
  const bundle = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(bundle.schema_version, 1);
  assert.equal(bundle.candidate.name, "fixture");
  assert.equal(bundle.summary.ok, false);
  assert.deepEqual(bundle.summary.failed, ["ingress"]);
  assert.equal(bundle.scenarios[0].log.exitCode, 1);
});
