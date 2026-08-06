/**
 * Open the most recent recorded video for a spec. Thin wrapper around the
 * shared implementation in @nteract/e2e-record.
 *
 * Usage:
 *   node e2e/show-video.mjs [spec-or-pattern]
 *
 * Examples:
 *   node e2e/show-video.mjs                        # most recent video overall
 *   node e2e/show-video.mjs ana-comment            # match dir name substring
 *   node e2e/show-video.mjs ana-comment.spec.ts    # same, strips extension
 */

import { showVideo } from "@nteract/e2e-record/show-video";
import { recordCommand, recordingsDir, resultsDir } from "./recording-paths.mjs";

showVideo({
  resultsDir,
  recordingsDir,
  recordCommand,
  pattern: process.argv.slice(2).find((a) => !a.startsWith("--")),
});
