/**
 * List the screenshot frames captured by `screenshot(page, "label")` in the
 * most recent spec run, so an agent can Read the PNGs to verify a UI change.
 * Mirrors apps/notebook/e2e/show-frames.mjs.
 *
 * Usage:
 *   node e2e/browser/show-frames.mjs [spec-or-pattern]
 *
 * Prints one absolute PNG path per line (call order), newest test dir wins.
 */

import path from "node:path";
import { newestResultDir, resultsDir } from "./test-results.mjs";

const [, , rawPattern] = process.argv;

const found = newestResultDir(rawPattern, (f) => f.startsWith("frame-") && f.endsWith(".png"));
if (!found) {
  console.error(`No frame-*.png screenshots found in ${resultsDir}.`);
  console.error(
    "Record the spec first: NTERACT_E2E_RECORD=1 node e2e/browser/run-cloud-e2e.mjs <spec>",
  );
  process.exit(1);
}

for (const frame of found.files.sort()) {
  console.log(path.join(found.dir, frame));
}
