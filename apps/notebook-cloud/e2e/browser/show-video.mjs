/**
 * Open the most recent recorded video for a spec. Thin wrapper around the
 * shared implementation in @nteract/e2e-record.
 *
 * Usage:
 *   node e2e/browser/show-video.mjs [spec-or-pattern]
 */

import { showVideo } from "@nteract/e2e-record/show-video";
import { recordCommand, recordingsDir, resultsDir } from "./recording-paths.mjs";

showVideo({
  resultsDir,
  recordingsDir,
  recordCommand,
  pattern: process.argv.slice(2).find((a) => !a.startsWith("--")),
});
