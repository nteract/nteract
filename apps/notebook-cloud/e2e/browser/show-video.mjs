/**
 * Find the most recent Playwright video for a spec (or test title pattern),
 * encode a 2x-speed copy with ffmpeg, and open it. Mirrors
 * apps/notebook/e2e/show-video.mjs.
 *
 * Videos only exist for runs made in recording mode:
 *   NTERACT_E2E_RECORD=1 node e2e/browser/run-cloud-e2e.mjs <spec>
 *
 * Usage:
 *   node e2e/browser/show-video.mjs [spec-or-pattern]
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { newestResultDir, resultsDir } from "./test-results.mjs";

const e2eRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const recordingsDir = path.join(e2eRoot, "recordings");
const viewerHtml = path.join(e2eRoot, "browser", "video-viewer.html");

const rawPattern = process.argv.slice(2).find((a) => !a.startsWith("--"));

function openViewer(absVideoPath) {
  const template = fs.readFileSync(viewerHtml, "utf8");
  const videoFile = path.basename(absVideoPath);
  const page = template.replace(/"__VIDEO_FILE__"/, JSON.stringify(videoFile));
  const pagePath = absVideoPath.replace(/\.webm$/, ".html");
  fs.writeFileSync(pagePath, page, "utf8");

  execFileSync("open", [pagePath]);
  console.log(`Viewer (proper scale on retina): ${pagePath}`);
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

function hasFfmpeg() {
  const result = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" });
  return result.status === 0;
}

const found = newestResultDir(rawPattern, (f) => f === "video.webm");
if (!found) {
  console.error(`No videos found in ${resultsDir}.`);
  console.error(
    "Record the spec first: NTERACT_E2E_RECORD=1 node e2e/browser/run-cloud-e2e.mjs <spec>",
  );
  process.exit(1);
}

const videoPath = path.join(found.dir, "video.webm");

function readMeta(videoFile) {
  const metaFile = path.join(path.dirname(videoFile), "video-meta.json");
  if (!fs.existsSync(metaFile)) return {};
  try {
    return JSON.parse(fs.readFileSync(metaFile, "utf8"));
  } catch {
    return {};
  }
}

const meta = readMeta(videoPath);
const trimStart = Number.isFinite(meta.trimSeconds) && meta.trimSeconds > 0 ? meta.trimSeconds : 0;

const segments = meta.segments?.length ? meta.segments : [found.name];
const outDir = path.join(recordingsDir, ...segments.slice(0, -1));
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, `${segments.at(-1)}-${timestamp()}.webm`);

if (hasFfmpeg()) {
  const trimNote = trimStart > 0 ? ` (trimming first ${trimStart.toFixed(1)}s)` : "";
  console.log(`Encoding 2x → ${path.basename(outPath)}${trimNote}`);
  const seekArgs = trimStart > 0 ? ["-ss", trimStart.toFixed(3)] : [];
  execFileSync(
    "ffmpeg",
    [
      ...seekArgs,
      "-i",
      videoPath,
      "-vf",
      "setpts=0.5*PTS",
      "-c:v",
      "libvpx-vp9",
      "-crf",
      "30",
      "-b:v",
      "0",
      "-y",
      outPath,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  console.log(`Done. Video: ${outPath}`);
  console.log(`Kept in ${path.relative(e2eRoot, recordingsDir)}/ — prior recordings preserved.`);
  openViewer(outPath);
} else {
  console.warn("ffmpeg not found — archiving original speed video.");
  fs.copyFileSync(videoPath, outPath);
  console.log(`Done. Video: ${outPath}`);
  openViewer(outPath);
}
