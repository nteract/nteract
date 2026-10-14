#!/usr/bin/env bash
# Verifies a notebook-cloud-assets tarball using only tar, sha256sum, and Node.
#
# Usage: notebook-cloud-assets-smoke.sh <tarball-path-or-https-url>
# A URL also fetches the `.sha256` sidecar next to it (needs curl).
set -euo pipefail

src="${1:?usage: $0 <tarball-path-or-url>}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

if [[ "$src" == https://* ]]; then
  curl -fsSL -o "$work/$(basename "$src")" "$src"
  curl -fsSL -o "$work/$(basename "$src").sha256" "$src.sha256"
  tarball="$work/$(basename "$src")"
else
  tarball="$src"
fi

echo "verifying sidecar"
(cd "$(dirname "$tarball")" && sha256sum -c "$(basename "$tarball").sha256")

mkdir "$work/root"
tar -xzf "$tarball" -C "$work/root"

echo "verifying manifest entries"
node - "$work/root" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const http = require("node:http");
const root = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const fail = (m) => { console.error(`FAIL: ${m}`); process.exit(1); };

if (manifest.name !== "notebook-cloud-assets") fail("manifest name");
for (const k of ["version", "channel", "protocol_version", "source_sha", "built_at"]) {
  if (manifest[k] === undefined || manifest[k] === "") fail(`manifest missing ${k}`);
}
if (!Number.isInteger(manifest.protocol_version)) fail("protocol_version is not an integer");

const listed = new Set(Object.keys(manifest.files));
for (const [rel, want] of Object.entries(manifest.files)) {
  if (rel.startsWith("/") || rel.split("/").includes("..")) fail(`unsafe path ${rel}`);
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) fail(`missing ${rel}`);
  const got = "sha256:" + crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  if (got !== want) fail(`hash mismatch ${rel}`);
}
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(path.join(d, e.name)) : [path.relative(root, path.join(d, e.name)).split(path.sep).join("/")]);
for (const rel of walk(root)) if (rel !== "manifest.json" && !listed.has(rel)) fail(`unlisted file ${rel}`);
console.log(`${listed.size} files verified, protocol_version=${manifest.protocol_version}`);

for (const dir of ["viewer", "output-document", "wasm/runtimed-wasm", "protocol/src"]) {
  if (![...listed].some((f) => f.startsWith(dir + "/"))) fail(`no files under ${dir}/`);
}

// Serve viewer/ at "/" with the siblings mounted beside it.
const mounts = [
  ["/wasm/runtimed-wasm/", "wasm/runtimed-wasm"],
  ["/output-document/", "output-document"],
  ["/", "viewer"],
];
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const [prefix, dir] = mounts.find(([p]) => url.startsWith(p));
  const file = path.join(root, dir, url.slice(prefix.length));
  if (!file.startsWith(path.join(root, dir)) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200).end(fs.readFileSync(file));
});
server.listen(0, "127.0.0.1", async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  // The host page loads the entry script and stylesheet from viewer/assets/,
  // and the browser fetches the hashed WASM copy from the same directory. The
  // wasm/runtimed-wasm/ probe covers the server-side engine copy.
  const wasmFiles = [...listed].filter((f) => f.endsWith(".wasm"));
  const probes = [
    "/assets/notebook-cloud-viewer.js",
    "/assets/notebook-cloud-viewer.css",
    "/output-document/index.html",
    ...wasmFiles.filter((f) => f.startsWith("viewer/assets/")).map((f) => f.slice("viewer".length)),
    ...wasmFiles.filter((f) => f.startsWith("wasm/runtimed-wasm/")).map((f) => "/" + f),
  ];
  try {
    for (const p of probes) {
      const r = await fetch(base + p);
      if (!r.ok) fail(`GET ${p} -> ${r.status}`);
      if (p.endsWith(".wasm") && !(new Uint8Array(await r.arrayBuffer()).slice(0, 4).join() === "0,97,115,109")) fail(`${p} is not wasm`);
    }
    console.log(`served ${probes.length} probes`);
  } finally {
    server.close();
  }
});
NODE
echo "ok"
