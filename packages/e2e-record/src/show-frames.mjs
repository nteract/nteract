/**
 * List the screenshot frames captured by `screenshot(page, "label")` in the
 * most recent spec run, so an agent can Read the PNGs to verify a UI change.
 *
 * The video (video.webm) is the human/PR artifact; these PNGs are what an agent
 * can actually see. One recording run produces both — no separate screenshot
 * pass. Frames only exist for runs made in recording mode.
 *
 * Each app wires this up in a small `e2e/show-frames.mjs` shim that passes its
 * own resultsDir and record command; see apps/notebook/e2e/show-frames.mjs.
 */

import path from "node:path";
import { newestResultDir } from "./artifacts.mjs";

/**
 * Print one absolute PNG path per line (call order), newest test dir wins.
 * Exits the process non-zero when there is nothing to show.
 *
 * @param {object} options
 * @param {string} options.resultsDir Playwright output dir to search.
 * @param {string} options.recordCommand Command that produces frames, for the error hint.
 * @param {string} [options.pattern] Substring of the spec/dir name.
 */
export function showFrames({ resultsDir, recordCommand, pattern }) {
  const found = newestResultDir(
    resultsDir,
    pattern,
    (f) => f.startsWith("frame-") && f.endsWith(".png"),
  );
  if (!found) {
    console.error(`No frame-*.png screenshots found in ${resultsDir}.`);
    console.error(`Record the spec first: ${recordCommand}`);
    process.exit(1);
  }

  // Sort by filename so the numeric prefixes (frame-01, frame-02, ...) order the flow.
  for (const frame of found.files.sort()) {
    console.log(path.join(found.dir, frame));
  }
}
