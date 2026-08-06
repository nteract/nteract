/**
 * Locate artifacts in a Playwright test-results/ dir, shared by show-video.mjs
 * and show-frames.mjs.
 */

import fs from "node:fs";
import path from "node:path";

/**
 * Newest test output dir (by artifact mtime) under `resultsDir` whose name
 * matches `rawPattern` and that contains at least one file passing `matches`.
 * Returns { dir, name, files, mtimeMs } with `dir` absolute, or null.
 * `rawPattern` is a case-insensitive substring of the dir name; a
 * `.spec.ts`/`.spec.js` suffix is stripped so a spec filename works.
 */
export function newestResultDir(resultsDir, rawPattern, matches) {
  if (!fs.existsSync(resultsDir)) return null;
  const pattern = rawPattern ? rawPattern.replace(/\.spec\.[jt]s$/, "").toLowerCase() : null;

  let best = null;
  for (const entry of fs.readdirSync(resultsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (pattern && !entry.name.toLowerCase().includes(pattern)) continue;
    const dir = path.join(resultsDir, entry.name);
    const files = fs.readdirSync(dir).filter(matches);
    if (files.length === 0) continue;
    const mtimeMs = Math.max(...files.map((f) => fs.statSync(path.join(dir, f)).mtimeMs));
    if (!best || mtimeMs > best.mtimeMs) best = { dir, name: entry.name, files, mtimeMs };
  }
  return best;
}
