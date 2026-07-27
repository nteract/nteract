/**
 * Long-lived localhost static file server for e2e video recordings, shared
 * across all git worktrees on this dev machine.
 *
 * Per-worktree ephemeral servers don't scale (one port per worktree, each dying
 * on Ctrl-C). Instead this serves the common ancestor of the root repo and every
 * worktree (e.g. /Users/mm/conductor) on a stable, path-derived port, so a single
 * process can serve the viewer HTML and any worktree's recording by relative
 * path. show-video.mjs --serve spawns this detached and reuses it if healthy.
 *
 * Localhost-only (binds 127.0.0.1), dev-machine-only. It can read anything under
 * the doc root; that's an accepted trade for a bound-to-loopback dev tool.
 *
 * Usage:
 *   node e2e/video-server.mjs --root <dir> --port <n>
 *   node e2e/video-server.mjs                     # derive root + port from cwd's worktree
 *
 * Routes:
 *   GET /__health         -> {"root": "<docRoot>"} so a client can confirm it
 *                            reached the right server before reusing the port.
 *   GET /<path under root> -> the file, with HTTP range support (video seeking).
 */

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const MIME = {
	".html": "text/html; charset=utf-8",
	".webm": "video/webm",
	".mp4": "video/mp4",
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
};

// Doc root = the longest common directory prefix of the root repo and every
// worktree, so one server reaches all of them (e.g. /Users/mm/conductor).
export function deriveDocRoot(cwd = process.cwd()) {
	const commonGitDir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
		cwd,
		encoding: "utf8",
	}).trim();
	const rootRepo = path.resolve(cwd, commonGitDir).replace(/\/\.git$/, "");
	const listing = execFileSync("git", ["worktree", "list", "--porcelain"], {
		cwd,
		encoding: "utf8",
	});
	const worktrees = listing
		.split("\n")
		.filter((l) => l.startsWith("worktree "))
		.map((l) => l.slice("worktree ".length).trim());
	return longestCommonDir([rootRepo, ...worktrees]);
}

// Longest common *directory* prefix (compares whole path segments, so /a/bc and
// /a/bd yield /a, never /a/b).
function longestCommonDir(paths) {
	if (paths.length === 0) return "/";
	const split = paths.map((p) => p.split(path.sep));
	const first = split[0];
	const common = [];
	for (let i = 0; i < first.length; i++) {
		const seg = first[i];
		if (split.every((parts) => parts[i] === seg)) common.push(seg);
		else break;
	}
	const joined = common.join(path.sep);
	return joined === "" ? path.sep : joined;
}

// Stable port from the doc root string, so every worktree computes the same one
// and they converge on a single shared server. Range 40000-49999.
export function derivePort(docRoot) {
	const hash = crypto.createHash("sha256").update(docRoot).digest();
	return 40000 + (hash.readUInt16BE(0) % 10000);
}

export function createServer(docRoot) {
	return http.createServer((req, res) => {
		const reqPath = decodeURIComponent((req.url || "/").split("?")[0]);

		if (reqPath === "/__health") {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ root: docRoot }));
			return;
		}

		// Resolve under docRoot; reject traversal escapes and sibling-prefix dirs.
		// path.join normalizes `..`; the trailing-sep check keeps us inside docRoot.
		const filePath = path.join(docRoot, reqPath);
		if (filePath !== docRoot && !filePath.startsWith(docRoot + path.sep)) {
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
		if (stat.isDirectory()) {
			res.writeHead(403).end("is a directory");
			return;
		}

		const type =
			MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream";
		const range = req.headers.range;
		if (range) {
			// Parse "bytes=start-end"; serve 206 partial so the browser can seek/scrub.
			const match = /bytes=(\d*)-(\d*)/.exec(range);
			const start = match && match[1] ? Number.parseInt(match[1], 10) : 0;
			const end =
				match && match[2] ? Number.parseInt(match[2], 10) : stat.size - 1;
			res.writeHead(206, {
				"Content-Type": type,
				"Content-Range": `bytes ${start}-${end}/${stat.size}`,
				"Accept-Ranges": "bytes",
				"Content-Length": end - start + 1,
			});
			fs.createReadStream(filePath, { start, end }).pipe(res);
		} else {
			res.writeHead(200, {
				"Content-Type": type,
				"Content-Length": stat.size,
				"Accept-Ranges": "bytes",
			});
			fs.createReadStream(filePath).pipe(res);
		}
	});
}

// Run directly (not imported): start the server and keep the process alive.
if (import.meta.url === `file://${process.argv[1]}`) {
	const argv = process.argv.slice(2);
	const argOf = (name) => {
		const i = argv.indexOf(name);
		return i >= 0 ? argv[i + 1] : undefined;
	};
	const docRoot = argOf("--root") || deriveDocRoot();
	const port = Number.parseInt(
		argOf("--port") || String(derivePort(docRoot)),
		10,
	);
	const server = createServer(docRoot);
	server.listen(port, "127.0.0.1", () => {
		console.log(`video-server serving ${docRoot} at http://127.0.0.1:${port}`);
	});
	server.on("error", (err) => {
		console.error(`video-server failed to listen on ${port}: ${err.message}`);
		process.exit(1);
	});
}
