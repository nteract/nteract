/**
 * Find the most recent Playwright video for a spec (or test title pattern),
 * encode a 2x-speed copy with ffmpeg, and open it.
 *
 * Videos only exist for runs made in recording mode:
 *   NTERACT_E2E_RECORD=1 node e2e/run-browser-e2e.mjs <spec>
 *
 * The encoded copy is archived to a persistent, gitignored `e2e/recordings/`
 * dir under a unique timestamped name, so re-running a spec never clobbers a
 * prior recording — keep before/after clips open side by side. (Playwright
 * wipes each test's own output dir on every run, so the source video.webm and
 * anything written next to it does NOT survive a re-run; recordings/ does.)
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
import { newestResultDir, resultsDir } from "./test-results.mjs";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const recordingsDir = path.join(appRoot, "e2e", "recordings");
const viewerHtml = path.join(appRoot, "e2e", "video-viewer.html");

const rawPattern = process.argv.slice(2).find((a) => !a.startsWith("--"));

// Write a viewer page next to the recording that references it by relative
// filename, then open that page. The viewer scales the 2x-density video down to
// intrinsicWidth / devicePixelRatio, so it renders at the compact size the spec
// framed for and stays crisp on retina — unlike QuickTime, which shows the raw
// pixels oversized.
//
// The video filename can't be passed as a ?v= query param: macOS `open` treats
// a file:// URL as a path and silently strips the query string, so the page
// would always load with no video.
function openViewer(absVideoPath) {
  const template = fs.readFileSync(viewerHtml, "utf8");
  const videoFile = path.basename(absVideoPath);
  const page = template.replace(/"__VIDEO_FILE__"/, JSON.stringify(videoFile));
  const pagePath = absVideoPath.replace(/\.webm$/, ".html");
  fs.writeFileSync(pagePath, page, "utf8");

  execFileSync("open", [pagePath]);
  console.log(`Viewer (proper scale on retina): ${pagePath}`);
}

// Sortable, filesystem-safe local timestamp (YYYYMMDD-HHMMSS) so archived
// recordings list in chronological order and never collide across runs.
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
  console.error("Record the spec first: NTERACT_E2E_RECORD=1 node e2e/run-browser-e2e.mjs <spec>");
  process.exit(1);
}

const videoPath = path.join(found.dir, "video.webm");

// markClipStart() writes video-meta.json next to the video: `trimSeconds` (when
// the app became ready, so we can cut the boring load prefix) and `segments`
// (the archive path as spec/describe/test parts). Absent if the spec never
// marked a clip start.
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

// Archive into the persistent recordings dir, nested by spec/test so a spec's
// before/after clips group together, and timestamped so a re-run never clobbers
// a prior one. Falls back to Playwright's flat dir name if the spec never marked
// a clip start (no video-meta.json).
const segments = meta.segments?.length ? meta.segments : [found.name];
const outDir = path.join(recordingsDir, ...segments.slice(0, -1));
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, `${segments.at(-1)}-${timestamp()}.webm`);

if (hasFfmpeg()) {
  const trimNote = trimStart > 0 ? ` (trimming first ${trimStart.toFixed(1)}s)` : "";
  console.log(`Encoding 2x → ${path.basename(outPath)}${trimNote}`);
  // `-ss` before `-i` seeks to the ready-for-typing point; setpts then resets the
  // trimmed clip's timestamps to zero before the 2x speed-up.
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
  console.log(`Kept in ${path.relative(appRoot, recordingsDir)}/ — prior recordings preserved.`);
  openViewer(outPath);
} else {
  console.warn("ffmpeg not found — archiving original speed video.");
  fs.copyFileSync(videoPath, outPath);
  console.log(`Done. Video: ${outPath}`);
  openViewer(outPath);
}
