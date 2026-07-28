/**
 * List the screenshot frames captured by `screenshot(page, "label")` in the
 * most recent spec run, so an agent can Read the PNGs to verify a UI change.
 *
 * The video (video.webm) is the human/PR artifact; these PNGs are what an agent
 * can actually see. One recording run produces both — no separate screenshot
 * pass. Frames only exist for runs made in recording mode:
 *   NTERACT_E2E_RECORD=1 node e2e/run-browser-e2e.mjs <spec>
 *
 * Usage:
 *   node e2e/show-frames.mjs [spec-or-pattern]
 *
 * Prints one absolute PNG path per line (call order), newest test dir wins.
 */

import path from "node:path";
import { newestResultDir, resultsDir } from "./test-results.mjs";

const [, , rawPattern] = process.argv;

const found = newestResultDir(rawPattern, (f) => f.startsWith("frame-") && f.endsWith(".png"));
if (!found) {
  console.error(`No frame-*.png screenshots found in ${resultsDir}.`);
  console.error("Record the spec first: NTERACT_E2E_RECORD=1 node e2e/run-browser-e2e.mjs <spec>");
  process.exit(1);
}

// Sort by filename so the numeric prefixes (frame-01, frame-02, ...) order the flow.
for (const frame of found.files.sort()) {
  console.log(path.join(found.dir, frame));
}
