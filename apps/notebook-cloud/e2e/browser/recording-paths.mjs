/**
 * Where this app's recording artifacts live, for show-video.mjs/show-frames.mjs.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

const browserDir = path.dirname(fileURLToPath(import.meta.url));

/** Matches the explicit outputDir in playwright.config.ts (this directory, not the app root). */
export const resultsDir = path.join(browserDir, "test-results");

/** Persistent, gitignored archive of encoded clips — survives Playwright wiping test-results/. */
export const recordingsDir = path.resolve(browserDir, "..", "recordings");

export const recordCommand = "NTERACT_E2E_RECORD=1 node e2e/browser/run-cloud-e2e.mjs <spec>";
