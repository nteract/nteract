import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const helpersSource = readFileSync(new URL("./helpers.js", import.meta.url), "utf8");

function exportedFunctionBody(name) {
  const start = helpersSource.indexOf(`export async function ${name}`);
  assert.notEqual(start, -1, `${name} should be exported`);
  const nextExport = helpersSource.indexOf("\nexport async function ", start + 1);
  return helpersSource.slice(start, nextExport === -1 ? undefined : nextExport);
}

test("waitForKernelReady gates execution on session runtime readiness", () => {
  const body = exportedFunctionBody("waitForKernelReady");

  assert.match(body, /getKernelStatus\(/);
  assert.match(body, /getSessionRuntimeState\(/);
  assert.match(body, /sessionState === "ready"/);
  assert.doesNotMatch(body, /waitForNotebookSynced\(/);
});

test("waitForCellOutput stays scoped to the requested cell", () => {
  const body = exportedFunctionBody("waitForCellOutput");

  assert.doesNotMatch(body, /global output/i);
  assert.doesNotMatch(body, /\$\(\s*selector\s*\)/);
});
