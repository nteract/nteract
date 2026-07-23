/**
 * Find the most recent Playwright video for a spec (or test title pattern),
 * encode a 2x-speed lossless copy with ffmpeg, and open it.
 *
 * Usage:
 *   node e2e/show-video.mjs [spec-or-pattern]
 *
 * Examples:
 *   node e2e/show-video.mjs                        # most recent video overall
 *   node e2e/show-video.mjs ana-comment            # match dir name substring
 *   node e2e/show-video.mjs ana-comment.spec.ts    # same, strips extension
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const resultsDir = path.join(appRoot, "test-results");
const [, , rawPattern] = process.argv;

// Normalize: strip .spec.ts, .spec.js suffixes and use as substring match.
const pattern = rawPattern ? rawPattern.replace(/\.spec\.[jt]s$/, "").toLowerCase() : null;

function findVideos() {
  if (!fs.existsSync(resultsDir)) return [];
  const entries = fs.readdirSync(resultsDir, { withFileTypes: true });
  const dirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => !pattern || name.toLowerCase().includes(pattern));

  const videos = [];
  for (const dir of dirs) {
    const videoPath = path.join(resultsDir, dir, "video.webm");
    if (fs.existsSync(videoPath)) {
      const { mtimeMs } = fs.statSync(videoPath);
      videos.push({ dir, videoPath, mtimeMs });
    }
  }
  return videos.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function hasFfmpeg() {
  const result = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" });
  return result.status === 0;
}

const videos = findVideos();

if (videos.length === 0) {
  const hint = pattern ? ` matching "${pattern}"` : "";
  console.error(`No videos found in ${resultsDir}${hint}.`);
  console.error("Run the spec first: node e2e/run-browser-e2e.mjs <spec>");
  process.exit(1);
}

const { videoPath, dir } = videos[0];
if (videos.length > 1) {
  console.log(`Found ${videos.length} videos — using most recent: ${dir}`);
}

const outPath = videoPath.replace(/\.webm$/, "-2x.webm");

if (hasFfmpeg()) {
  console.log(`Encoding 2x lossless → ${path.basename(outPath)}`);
  execFileSync(
    "ffmpeg",
    ["-i", videoPath, "-vf", "setpts=0.5*PTS", "-c:v", "vp9", "-lossless", "1", "-y", outPath],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  execFileSync("open", [outPath]);
} else {
  console.warn("ffmpeg not found — opening original speed video.");
  execFileSync("open", [videoPath]);
}

console.log(`Done. Video: ${outPath}`);
