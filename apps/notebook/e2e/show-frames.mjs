/**
 * List the screenshot frames from the most recent recorded spec run, so an
 * agent can Read the PNGs. Thin wrapper around the shared implementation in
 * @nteract/e2e-record.
 *
 * Usage:
 *   node e2e/show-frames.mjs [spec-or-pattern]
 *
 * Prints one absolute PNG path per line (call order), newest test dir wins.
 */

import { showFrames } from "@nteract/e2e-record/show-frames";
import { recordCommand, resultsDir } from "./recording-paths.mjs";

showFrames({ resultsDir, recordCommand, pattern: process.argv[2] });
