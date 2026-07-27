/**
 * Find the most recent Playwright video for a spec (or test title pattern),
 * encode a 2x-speed lossless copy with ffmpeg, and open it.
 *
 * The encoded copy is archived to a persistent, gitignored `e2e/recordings/`
 * dir under a unique timestamped name, so re-running a spec never clobbers a
 * prior recording — keep before/after clips open side by side. (Playwright
 * wipes each test's own output dir on every run, so the source video.webm and
 * anything written next to it does NOT survive a re-run; recordings/ does.)
 *
 * Usage:
 *   node e2e/show-video.mjs [spec-or-pattern] [--serve]
 *
 * Examples:
 *   node e2e/show-video.mjs                        # most recent video overall
 *   node e2e/show-video.mjs ana-comment            # match dir name substring
 *   node e2e/show-video.mjs ana-comment.spec.ts    # same, strips extension
 *   node e2e/show-video.mjs add-cell --serve       # serve over http (if file:// media is blocked)
 *
 * By default the viewer opens over file://. Some browsers refuse to load
 * file:// media from a file:// page; pass --serve to spin up a localhost static
 * server (with HTTP range support so scrubbing works) and open over http instead.
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const resultsDir = path.join(appRoot, "test-results");
const recordingsDir = path.join(appRoot, "e2e", "recordings");
const viewerHtml = path.join(appRoot, "e2e", "video-viewer.html");

// --serve is a flag anywhere in argv; the first non-flag arg is the pattern.
const argv = process.argv.slice(2);
const serve = argv.includes("--serve");
const rawPattern = argv.find((a) => !a.startsWith("--")) ?? undefined;

// Build a file:// URL to video-viewer.html carrying the recording's absolute
// path as URL-safe base64 in ?v=. The viewer scales the 2x-density video down
// to intrinsicWidth / devicePixelRatio, so it renders at the compact size the
// spec framed for and stays crisp on retina — unlike QuickTime, which shows the
// raw pixels oversized. Base64 sidesteps spaces/special chars in the path.
function viewerUrlFor(absVideoPath) {
  const b64 = Buffer.from(absVideoPath, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `file://${viewerHtml}?v=${b64}`;
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".webm": "video/webm",
  ".mp4": "video/mp4",
};

// Serve appRoot over localhost with HTTP range support (needed so the browser
// can seek/scrub the video), open the viewer over http pointed at the recording,
// and keep the process alive until Ctrl-C so playback keeps working.
function serveAndOpen(absVideoPath) {
  const server = http.createServer((req, res) => {
    // Resolve the request path against appRoot, refusing traversal escapes.
    // path.join normalizes `..`; the trailing-sep check rejects both escapes
    // above appRoot and sibling dirs that merely share its name as a prefix.
    const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
    const filePath = path.join(appRoot, urlPath);
    if (filePath !== appRoot && !filePath.startsWith(appRoot + path.sep)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      res.writeHead(404).end("not found");
      return;
    }
    const type = MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream";
    const range = req.headers.range;
    if (range) {
      // Parse "bytes=start-end"; serve a 206 partial so seeking works.
      const match = /bytes=(\d*)-(\d*)/.exec(range);
      const start = match && match[1] ? Number.parseInt(match[1], 10) : 0;
      const end = match && match[2] ? Number.parseInt(match[2], 10) : stat.size - 1;
      res.writeHead(206, {
        "Content-Type": type,
        "Content-Range": `bytes ${start}-${end}/${stat.size}`,
        "Accept-Ranges": "bytes",
        "Content-Length": end - start + 1,
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { "Content-Type": type, "Content-Length": stat.size });
      fs.createReadStream(filePath).pipe(res);
    }
  });

  // Port 0 → OS picks a free port, so parallel worktrees never collide.
  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    const rel = (p) => path.relative(appRoot, p).split(path.sep).map(encodeURIComponent).join("/");
    const base = `http://127.0.0.1:${port}`;
    const videoUrl = `${base}/${rel(absVideoPath)}`;
    const url = `${base}/${rel(viewerHtml)}?src=${encodeURIComponent(videoUrl)}`;
    execFileSync("open", [url]);
    console.log(`Serving ${appRoot} at ${base}`);
    console.log(`Viewer (proper scale on retina): ${url}`);
    console.log("Press Ctrl-C to stop the server.");
  });
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

// Archive into the persistent recordings dir under a unique, sortable name
// (spec dir + timestamp) so a re-run of the same spec keeps prior clips around.
fs.mkdirSync(recordingsDir, { recursive: true });
const outPath = path.join(recordingsDir, `${dir}-${timestamp()}-2x.webm`);

// Specs can drop a `video-trim.txt` (seconds) next to the video to mark when the
// app became ready for typing. Trim that boring load prefix before speeding up.
function readTrimStart(videoFile) {
  const trimFile = path.join(path.dirname(videoFile), "video-trim.txt");
  if (!fs.existsSync(trimFile)) return 0;
  const seconds = Number.parseFloat(fs.readFileSync(trimFile, "utf8").trim());
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
}

if (hasFfmpeg()) {
  const trimStart = readTrimStart(videoPath);
  const trimNote = trimStart > 0 ? ` (trimming first ${trimStart.toFixed(1)}s)` : "";
  console.log(`Encoding 2x lossless → ${path.basename(outPath)}${trimNote}`);
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
      "vp9",
      "-lossless",
      "1",
      "-y",
      outPath,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  console.log(`Done. Video: ${outPath}`);
  console.log(`Kept in ${path.relative(appRoot, recordingsDir)}/ — prior recordings preserved.`);
  if (serve) {
    serveAndOpen(outPath);
  } else {
    const url = viewerUrlFor(outPath);
    execFileSync("open", [url]);
    console.log(`Viewer (proper scale on retina): ${url}`);
  }
} else {
  console.warn("ffmpeg not found — archiving original speed video.");
  const originalOut = outPath.replace(/-2x\.webm$/, ".webm");
  fs.copyFileSync(videoPath, originalOut);
  console.log(`Done. Video: ${originalOut}`);
  if (serve) {
    serveAndOpen(originalOut);
  } else {
    const url = viewerUrlFor(originalOut);
    execFileSync("open", [url]);
    console.log(`Viewer (proper scale on retina): ${url}`);
  }
}
