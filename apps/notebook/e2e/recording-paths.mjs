/**
 * Where this app's recording artifacts live, for show-video.mjs/show-frames.mjs.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

const e2eDir = path.dirname(fileURLToPath(import.meta.url));

/** Playwright's outputDir: default test-results/ next to playwright.config.ts (the app root). */
export const resultsDir = path.resolve(e2eDir, "..", "test-results");

/** Persistent, gitignored archive of encoded clips — survives Playwright wiping test-results/. */
export const recordingsDir = path.join(e2eDir, "recordings");

export const recordCommand = "NTERACT_E2E_RECORD=1 node e2e/run-browser-e2e.mjs <spec>";
