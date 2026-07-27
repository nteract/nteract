/**
 * List the screenshot frames captured by `screenshot(page, "label")` in the
 * most recent spec run, so an agent can Read the PNGs to verify a UI change.
 *
 * The video (video.webm) is the human/PR artifact; these PNGs are what an agent
 * can actually see. One run produces both — no separate screenshot pass.
 *
 * Usage:
 *   node e2e/show-frames.mjs [spec-or-pattern]
 *
 * Prints one absolute PNG path per line (call order), newest test dir wins.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const resultsDir = path.join(appRoot, "test-results");
const [, , rawPattern] = process.argv;
const pattern = rawPattern ? rawPattern.replace(/\.spec\.[jt]s$/, "").toLowerCase() : null;

function newestFrameDir() {
  if (!fs.existsSync(resultsDir)) return null;
  const dirs = fs
    .readdirSync(resultsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => !pattern || name.toLowerCase().includes(pattern));

  let best = null;
  for (const dir of dirs) {
    const full = path.join(resultsDir, dir);
    const frames = fs.readdirSync(full).filter((f) => f.startsWith("frame-") && f.endsWith(".png"));
    if (frames.length === 0) continue;
    const mtimeMs = Math.max(...frames.map((f) => fs.statSync(path.join(full, f)).mtimeMs));
    if (!best || mtimeMs > best.mtimeMs) best = { dir: full, frames, mtimeMs };
  }
  return best;
}

const found = newestFrameDir();
if (!found) {
  const hint = pattern ? ` matching "${pattern}"` : "";
  console.error(`No frame-*.png screenshots found in ${resultsDir}${hint}.`);
  console.error('Add `await screenshot(page, "label")` calls and run the spec first.');
  process.exit(1);
}

// Sort by filename so the numeric label prefixes (01-, 02-, ...) order the flow.
for (const frame of found.frames.sort()) {
  console.log(path.join(found.dir, frame));
}
