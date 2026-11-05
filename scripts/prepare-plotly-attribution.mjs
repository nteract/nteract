#!/usr/bin/env node
// Regenerate reviewed attribution inputs; this does not build or modify Plotly.
import {createHash, randomUUID} from "node:crypto";
import {execFileSync} from "node:child_process";
import {mkdir, readFile, rename, unlink, writeFile} from "node:fs/promises";
import {realpathSync} from "node:fs";
import {createRequire} from "node:module";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const CACHE = join(ROOT, ".context/plotly-attribution-cache");
const VERSION = "3.4.0";
const HELPER_SOURCES = {
  "@rollup/plugin-commonjs@26.0.1": {path: "package/dist/es/index.js", sha256: "f51e642ce2dc3b3edd7fb95c86fa3080846446bedc123a634ef170d6e2fbfd5d"},
  "rollup-plugin-commonjs@10.1.0": {path: "package/src/helpers.js", sha256: "540519752f929e78c0c4e731f0f7ab7027a3f4c8e14fc15e2649e0c56862d2ef"},
  "esbuild-plugin-inline-css@0.0.1": {path: "package/index.js", sha256: "9da7168aaf4309b12804b2e60c1de634f90db21122ab70341963bffbfa2791fc"},
};
const RESTORED_LICENSES = {
  "has-hover@1.0.1": {
    url: "https://raw.githubusercontent.com/dy/has-hover/d6ea395a32403b0ab54e5bb9350a59a4dbab3e00/license",
    sha256: "d7faad981dff71dff21e4d0cc3ffdaa67a7fe1cd4a75a50e2a7439b029d220c0",
    reason: "Upstream license clarification retains version 1.0.1 and identical runtime; npm differs only by CRLF",
  },
  "is-svg-path@1.0.2": {
    url: "https://raw.githubusercontent.com/dy/is-svg-path/dedb60ce3c89129d6f6be56df3678aa7df368626/license",
    sha256: "d7faad981dff71dff21e4d0cc3ffdaa67a7fe1cd4a75a50e2a7439b029d220c0",
    reason: "Direct child of published gitHead adds only license; runtime identical apart from npm CRLF",
  },
  "normalize-svg-path@0.1.0": {
    url: "https://raw.githubusercontent.com/jkroso/normalize-svg-path/ef665d269f28b5afd2d4302920689d23bec700c4/License",
    sha256: "85acc0e2f3679e910e732e0f54f5492bc444fe0d367ea96e10765d16f85db388",
    reason: "Exact upstream annotated 0.1.0 release tag, peeled to source commit",
  },
  "color-id@1.1.0": {
    url: "https://raw.githubusercontent.com/colorjs/color-id/e5f7186687ac5861e5969b59949d7977366ca872/license",
    sha256: "d7faad981dff71dff21e4d0cc3ffdaa67a7fe1cd4a75a50e2a7439b029d220c0",
    reason: "Direct child of published gitHead adds license and package metadata only; runtime identical apart from npm CRLF",
  },
  "abs-svg-path@0.1.1": {
    url: "https://raw.githubusercontent.com/jkroso/abs-svg-path/f0f57c97b12cdc4fc1d94798256fba357394e40a/License",
    sha256: "2d5ffdfe09268750ba687a149db8392038772e7f156db3a98b615a7de0cab76e",
    reason: "Exact upstream 0.1.1 tag; runtime index.js matches published tarball bytes",
  },
  "array-bounds@1.0.1": {
    url: "https://raw.githubusercontent.com/dy/array-bounds/7da1a4791a2a911b792ba74eb9423def7664698f/license",
    sha256: "d7faad981dff71dff21e4d0cc3ffdaa67a7fe1cd4a75a50e2a7439b029d220c0",
    reason: "Upstream Add license clarification retains version 1.0.1 and identical runtime source; npm source differs only by CRLF",
  },
  "color-rgba@3.0.0": {
    url: "https://raw.githubusercontent.com/colorjs/color-rgba/75b3d827a5136088dc29a9b4ee72a30496b57d22/LICENSE",
    sha256: "aa81b6e6ec7319e1af6e32ba5544200e324266fb4a63b40762f93e3343f1ce7d",
    reason: "Upstream Add MIT license clarification changes only README and LICENSE since published gitHead; runtime index.js is identical",
  },
  "@mapbox/jsonlint-lines-primitives@2.0.2": {
    url: "https://raw.githubusercontent.com/mapbox/jsonlint/21c821af6c176bc0b8d240d715d416223d1deb7b/README.md",
    sha256: "83f102d55e9a00e125cd8f2331b2b0949173d18d088ae139ab0cfa0ef5128b37",
    reason: "Maintainer Restore license commit is direct child of published gitHead 1272a5add2d731a4892319ed556a15852792d2b8; only README grant restoration changed",
  },
};
const SOURCES = [
  {
    repo: "plotly/plotly.js", commit: "9718f136a1c7764c6ee3c13bcd383454a1aac57a",
    files: {
      "package.json": "d8605b0955ee7a99a1ce43f229c81decf181416cf7984a360da7e29e991406f8",
      "package-lock.json": "9ac5d2d6243a7d4dbf705fd766057073df24b9a8c5884c389d6ec43ea99d19e3",
      "esbuild-config.js": "c453af98578dc90ad7594087fba12890213e893c426562f12d2e739d59ee3884",
    },
    // Browser shims and generators with inline runtime code, not all dev tools.
    extra: ["assert", "buffer", "stream-browserify"],
    helpers: ["esbuild-plugin-inline-css"],
  },
  {
    repo: "maplibre/maplibre-gl-js", commit: "87486a5ef2085e600e8fa4e31252629dd8488dcd",
    files: {
      "package.json": "cfcc0150ccd44be31fd0747c7d62f823496275bf7e453332b3e448b7a35c8ae4",
      "package-lock.json": "01adcc53c75d5fd5adb014d5048a730df6d46e48e8f0e61e24e58b0e39190fef",
      "rollup.config.ts": "3cd77c8a51592d3df07664e6517796d50499143ad2c8b84a529544eda22915f1",
      "build/rollup_plugins.ts": "8f9f1691e688ee1b308fccaadc8e502d97dcc5897a68650701959e4841e42bc2",
    },
    extra: ["tslib"],
    helpers: ["@rollup/plugin-commonjs"],
  },
  {
    repo: "plotly/mapbox-gl-js", commit: "52fa02f543e8403946a861b4736261561b2a2b6b",
    files: {
      "package.json": "fc67e6ee38752df42a1fc9e0875b8b963738a1775454cc0271a21a3bfb826410",
      "yarn.lock": "76fb0f6c2014e34b795346177d8a9c22668685e9db64603456d490bd9a38b6b1",
      "rollup.config.js": "3909da828f11ebaaa4c4c6ff54cac1bd9d96e7a7d33da4e13d804bd4e67bf5cd",
      "build/rollup_plugins.js": "0f444c5f526d94c2d3fc20fc524adda3f76724c05182bd56f026bbfd20d9e1e2",
    },
    extra: [],
    helpers: ["rollup-plugin-commonjs"],
  },
];

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function verifyIntegrity(bytes, integrity, label) {
  const match = /^(sha512|sha384|sha256|sha1)-([A-Za-z0-9+/]+=*)$/.exec(integrity ?? "");
  if (!match || createHash(match[1]).update(bytes).digest("base64") !== match[2]) {
    throw new Error(`Integrity mismatch or missing integrity: ${label}`);
  }
}

// Walk physical package-lock locations, never solve version ranges or install code.
export function selectNpmLock(lock, extra = [], helpers = []) {
  if (lock.lockfileVersion !== 3 || !lock.packages?.[""]) throw new Error("Expected npm lockfile v3");
  const packages = lock.packages;
  const selected = new Set();
  const locate = (from, name) => {
    let prefix = from;
    while (true) {
      const key = `${prefix ? `${prefix}/` : ""}node_modules/${name}`;
      if (packages[key]) return key;
      if (!prefix) throw new Error(`Missing locked dependency ${name} from ${from}`);
      const index = prefix.lastIndexOf("/node_modules/");
      prefix = index < 0 ? "" : prefix.slice(0, index);
    }
  };
  for (const name of [...Object.keys(packages[""].dependencies ?? {}), ...extra]) selected.add(locate("", name));
  for (const key of selected) {
    const entry = packages[key];
    // glslify's browser entry is import-free; its Node preprocessing tree is not shipped.
    if (key === "node_modules/glslify" && entry.version === "7.1.1") continue;
    for (const name of Object.keys({...entry.dependencies, ...entry.optionalDependencies})) selected.add(locate(key, name));
  }
  // Emitted import-free helpers need their owner notice, not build-time AST tools.
  for (const name of helpers) selected.add(locate("", name));
  return [...selected].sort().map((key) => ({name: key.split("node_modules/").at(-1), ...packages[key], location: key}));
}

export function selectYarnLock(entries, metadata, extra = [], helpers = []) {
  const queue = Object.entries(metadata.dependencies ?? {});
  for (const name of extra) {
    const range = metadata.devDependencies?.[name];
    if (!range) throw new Error(`Missing reviewed build dependency ${name}`);
    queue.push([name, range]);
  }
  const selected = new Map();
  for (const [name, range] of queue) {
    const key = `${name}@${range}`;
    if (selected.has(key)) continue;
    const entry = entries.get(key);
    if (!entry?.version) throw new Error(`Missing yarn lock entry ${key}`);
    selected.set(key, {name, ...entry, location: key});
    queue.push(...Object.entries({...entry.dependencies, ...entry.optionalDependencies}));
  }
  for (const name of helpers) {
    const key = `${name}@${metadata.devDependencies[name]}`;
    const entry = entries.get(key);
    if (!entry) throw new Error(`Missing helper owner ${key}`);
    selected.set(key, {name, ...entry, location: key});
  }
  return [...selected.values()];
}

export function legalComments(source) {
  const comments = [...(source.match(/\/\*[\s\S]*?\*\//g) ?? []), ...(source.match(/(?:^\s*\/\/[^\n]*(?:\n|$))+/gm) ?? [])];
  return [...new Set(comments.filter((text) =>
    /@license|@preserve|copyright|MIT Licensed|permission is hereby granted|redistribution and use|bundled license information/i.test(text)))];
}

export class MissingMaterialError extends Error {
  constructor(label, result) {
    super(`No full license text in verified tarball: ${label}`);
    this.result = result;
  }
}

export function acceptMissingMaterials(error, exception, fingerprint, files) {
  if (!(error instanceof MissingMaterialError) || !exception) throw error;
  for (const field of ["name", "version", "tarballSha256", "registryGitHead", "bundleSha256"]) {
    if (exception[field] !== fingerprint[field]) throw new Error(`Attribution exception fingerprint mismatch: ${field}`);
  }
  if (exception.license !== "MIT" || error.result.license !== "MIT" || !exception.missingMaterial || !exception.evidence?.length
    || exception.owner !== "nteract maintainers" || !/^\d{4}-\d{2}-\d{2}$/.test(exception.reviewDate)
    || !/^https:\/\/github\.com\/nteract\/nteract\/issues(?:\/\d+)?$/.test(exception.trackingUrl)) {
    throw new Error("Invalid attribution exception record or license");
  }
  for (const evidence of exception.evidence) {
    const text = files.get(evidence.path);
    if (!text || sha256(text) !== evidence.sha256 || (evidence.declaration && !text.includes(evidence.declaration))) {
      throw new Error(`Attribution exception source evidence changed: ${evidence.path}`);
    }
  }
  const materials = [...error.result.materials];
  for (const evidence of exception.evidence) {
    if (!materials.some(({path}) => path === evidence.path)) materials.push({path: evidence.path, text: files.get(evidence.path)});
  }
  return {...error.result, materials, exception};
}

export function exceptionSummary(exceptions) {
  return ["Plotly attribution status: reviewed-with-exceptions",
    "These exact MIT-declared sources have incomplete notice material. Shipping these verified materials is a documented nteract maintenance exception, not a claim of complete attribution or legal approval. No copyright holder is inferred from author metadata. No exception permits integrity, network, or unknown-license failures.",
    ...exceptions.map((item) => `${item.name}@${item.version}\nDeclared license: ${item.license}\nMissing material: ${item.missingMaterial}\nTarball SHA256: ${item.tarballSha256}\nSource gitHead: ${item.gitHead ?? "not known"}\nPlotly 3.4.0 bundle SHA256: ${item.bundleSha256}\nEvidence: ${item.reason}\nOwner: ${item.owner}\nReview date: ${item.reviewDate}\nTracking: ${item.trackingUrl}`),
  ].join("\n\n");
}

function hasGrant(text) {
  const normalized = text.replace(/\s+/g, " ");
  return text.length > 400 && /warrant(?:y|ies|ed)|liability/i.test(normalized)
    && /permission is hereby granted|redistribution and use|apache license|permission to use|gnu (?:general|lesser)|mozilla public|blue oak model license|this software is provided ['"]?as.is|free and unencumbered software/i.test(normalized);
}

export function packageMaterials(files, label, declaration) {
  const metadataPaths = [...files.keys()].filter((path) => /^[^/]+\/package\.json$/.test(path));
  if (metadataPaths.length !== 1) throw new Error(`Missing or ambiguous package metadata: ${label}`);
  const metadata = JSON.parse(files.get(metadataPaths[0]));
  if (!metadata) throw new Error(`Missing package metadata: ${label}`);
  const packageRoot = metadataPaths[0].split("/")[0];
  const ownGrant = ({path, text}) => hasGrant(text) && (
    path.startsWith("upstream/") ||
    (path.startsWith(`${packageRoot}/`) && !path.slice(packageRoot.length + 1).includes("/"))
  );
  const materials = [];
  for (const [path, text] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    if (/(?:^|\/)(?:licen[cs]e|copying|copyright|notice|authors)(?:[._-].*)?$/i.test(path)) {
      if (!text.trim()) throw new Error(`Empty legal material: ${label}/${path}`);
      materials.push({path, text});
    } else if (/\.(?:[cm]?js|css|glsl|ts)$/i.test(path)) {
      for (const comment of legalComments(text)) materials.push({path: `${path} (legal comment)`, text: comment});
    }
  }
  // Older npm packages put the full grant only in their README.
  if (!materials.some(ownGrant)) {
    for (const [path, text] of files) {
      if (/\/readme(?:\..*)?$/i.test(path) && (hasGrant(text) || /\bMIT\b|copyright/i.test(text))) materials.push({path, text});
    }
  }
  let license = declaration ?? metadata.license;
  if (typeof license === "object") license = license.type;
  if (!license && metadata.licenses?.length) license = metadata.licenses.map((item) => item.type).join(" OR ");
  if (!license || /SEE LICENSE|UNLICENSED/i.test(license)) throw new Error(`Unresolved license declaration: ${label}`);
  if (!materials.some(ownGrant)) throw new MissingMaterialError(label, {metadata, materials, license});
  return {metadata, materials, license};
}

export async function publicBytes(url, expectedHash, {cache = CACHE, fetcher = fetch} = {}) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || !["raw.githubusercontent.com", "registry.npmjs.org", "registry.yarnpkg.com", "api.github.com", "www.apache.org", "getify.mit-license.org", "deanlandolt.mit-license.org"].includes(parsed.hostname) || parsed.username || parsed.password) throw new Error(`Non-public source: ${url}`);
  const path = join(cache, `${sha256(url)}.json`);
  let stored;
  try { stored = JSON.parse(await readFile(path, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (stored) {
    const bytes = Buffer.from(stored.base64, "base64");
    if (stored.url !== url || sha256(bytes) !== stored.sha256 || (expectedHash && stored.sha256 !== expectedHash)) throw new Error(`Cached source SHA256 mismatch: ${url}`);
    return bytes;
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    let response;
    let bytes;
    try {
      response = await fetcher(url, {redirect: "error", signal: AbortSignal.timeout(60_000)});
      if (response.ok) bytes = Buffer.from(await response.arrayBuffer());
    } catch (error) {
      if (attempt < 2) continue;
      throw new Error(`Public source network failure (not evidence of absence): ${url}: ${error.message}`);
    }
    if (!response.ok) {
      if ((response.status === 429 || response.status >= 500) && attempt < 2) continue;
      const detail = response.status === 403 ? " (access/rate limit; not evidence of absence)" : "";
      throw new Error(`Fetch ${url}${detail}: ${response.status}`);
    }
    if (expectedHash && sha256(bytes) !== expectedHash) throw new Error(`Source SHA256 mismatch: ${url}`);
    if (bytes.length > 64 * 1024 * 1024) throw new Error(`Public source exceeds 64 MiB: ${url}`);
    await mkdir(cache, {recursive: true});
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({url, sha256: sha256(bytes), base64: bytes.toString("base64")}));
    await rename(temporary, path);
    return bytes;
  }
}

export function assembleMIT(files, review, canonical) {
  const source = files.get(review.path);
  if (!source || sha256(source) !== review.sha256 || !source.includes(review.declaration) || !source.includes(review.copyright)) throw new Error("Reviewed MIT declaration/holder changed");
  if (!review.copyright || !/MIT/.test(review.declaration) || !canonical.includes("Copyright (c) <year> <copyright holders>")) throw new Error("Invalid reviewed MIT evidence");
  return `Assembled notice: verbatim upstream copyright and explicit MIT declaration, followed by canonical SPDX MIT terms. This is not an original upstream LICENSE file.\nOriginal declaration: ${review.declaration}\n\n${canonical.replace("Copyright (c) <year> <copyright holders>", review.copyright)}`;
}

async function sourceLicense(files, registry) {
  const repo = /github\.com[/:]([^/]+\/[^/#]+?)(?:\.git)?$/.exec(registry.repository?.url ?? "")?.[1];
  if (!repo) return [];
  const roots = registry.gitHead ? [registry.gitHead] : [`v${registry.version}`, registry.version];
  const sources = [];
  for (const ref of roots) {
    let commit = ref;
    if (!/^[a-f0-9]{40}$/.test(ref)) {
      try { commit = JSON.parse(await publicBytes(`https://api.github.com/repos/${repo}/commits/${ref}`)).sha; }
      catch (error) { if (!/: 404$/.test(error.message)) throw error; continue; }
    }
    const base = `https://raw.githubusercontent.com/${repo}/${commit}/`;
    let metadata;
    try { metadata = JSON.parse(await publicBytes(`${base}package.json`)); } catch (error) { if (!/: 404$/.test(error.message)) throw error; continue; }
    if (metadata.name !== registry.name || metadata.version !== registry.version) continue;
    const paths = ["LICENSE", "LICENSE.md", "LICENSE.txt", "license", "license.md", "License", "License.md", "LICENCE", "COPYING", "README.md", "readme.md", "Readme.md"];
    for (const path of paths) {
      let bytes;
      try { bytes = await publicBytes(`${base}${path}`); } catch (error) {
        if (!/: 404$/.test(error.message)) throw error;
        continue;
      }
      const text = bytes.toString("utf8");
      if (!hasGrant(text)) continue;
      files.set(`upstream/${path}`, text);
      sources.push({url: `${base}${path}`, sha256: sha256(bytes), reason: "Full legal text omitted from npm tarball; exact upstream package version"});
    }
    if (sources.length) return sources;
  }
  return sources;
}

function npmTools() {
  // Reuse npm's maintained tar and Yarn parsers. No npm install, hooks, or config reads.
  const npmPath = execFileSync(process.platform === "win32" ? "where.exe" : "which", ["npm"], {encoding: "utf8"}).trim().split(/\r?\n/)[0];
  const npmRoot = process.platform === "win32" ? join(dirname(npmPath), "node_modules/npm") : resolve(dirname(realpathSync(npmPath)), "..");
  const require = createRequire(join(npmRoot, "package.json"));
  return {tar: require("tar"), YarnLock: require("@npmcli/arborist/lib/yarn-lock.js"), parseSpdx: require("spdx-expression-parse")};
}

export async function readTarball(bytes, tar) {
  const files = new Map();
  let failure;
  let size = 0;
  const parser = tar.t({onReadEntry(entry) {
    const path = entry.path;
    if (path.startsWith("/") || path.split("/").includes("..") || path.includes("\\")) {
      failure = new Error(`Unsafe tar path: ${path}`);
      entry.resume();
      return;
    }
    size += entry.size;
    if (size > 256 * 1024 * 1024) { failure = new Error("Tarball exceeds 256 MiB expanded limit"); entry.resume(); return; }
    if (["SymbolicLink", "Link"].includes(entry.type)) { failure = new Error(`Unsupported archive link: ${path}`); entry.resume(); return; }
    if (entry.type !== "File") { entry.resume(); return; }
    const chunks = [];
    entry.on("data", (chunk) => chunks.push(chunk));
    entry.on("end", () => {
      if (files.has(path)) failure = new Error(`Duplicate tar path: ${path}`);
      files.set(path, Buffer.concat(chunks).toString("utf8"));
    });
  }});
  await new Promise((accept, reject) => {
    parser.on("error", reject);
    parser.on("end", accept);
    parser.end(bytes);
  });
  if (failure) throw failure;
  return files;
}

export async function prepare({repoRoot = ROOT, output = join(ROOT, "scripts/licenses")} = {}) {
  // A failed regeneration must not leave a previously published release gate usable.
  await unlink(join(output, "plotly-supplement.json")).catch((error) => { if (error.code !== "ENOENT") throw error; });
  const tools = npmTools();
  const reviewedBytes = await readFile(join(ROOT, "scripts/licenses/plotly-reviewed-notices.json"));
  const reviewed = JSON.parse(reviewedBytes);
  const exceptionBytes = await readFile(join(ROOT, "scripts/licenses/plotly-exceptions.json"));
  const exceptionDocument = JSON.parse(exceptionBytes);
  const exceptions = exceptionDocument.exceptions;
  if (exceptionDocument.schemaVersion !== 1 || !Array.isArray(exceptions)
    || exceptions.length !== 4 || new Set(exceptions.map(({name, version}) => `${name}@${version}`)).size !== 4
    || exceptions.some(({name, version}) => !["array-normalize@1.1.4", "color-alpha@1.0.4", "draw-svg-path@1.0.0", "jison-lex@0.3.4"].includes(`${name}@${version}`))) {
    throw new Error("Unexpected Plotly attribution exception set; new gaps require review");
  }
  const installedBundle = await readFile(join(repoRoot, "node_modules/plotly.js-dist-min/plotly.min.js"));
  const bundleSha256 = sha256(installedBundle);
  const canonical = (await publicBytes(reviewed.canonicalMIT.url, reviewed.canonicalMIT.sha256)).toString("utf8");
  const provenance = {schemaVersion: 1, reviewedNoticesSha256: sha256(reviewedBytes), selection: "Runtime and optional dependency closure in upstream locks. glslify 7.1.1 import-free browser entry replaces its Node build tree (package.json/browser.js SHA256 checked). CommonJS and inline-CSS generators contribute import-free helpers: owner included, AST/build dependencies excluded. GLSL/environment plugins transform inputs without contributing their implementation. Buble transpiles source without importing its AST dependencies. Jison and jison-lex generator versions named in jsonlint runtime headers included independently.", sources: [], packages: []};
  const inventory = new Map();
  provenance.exceptionsSha256 = sha256(exceptionBytes);
  provenance.bundleSha256 = bundleSha256;
  const add = (entry, source) => {
    const key = `${entry.name}@${entry.version}`;
    const previous = inventory.get(key);
    if (previous) {
      previous.sources.push(source);
      if (entry.integrity) previous.lockIntegrities.add(entry.integrity);
      return;
    }
    inventory.set(key, {...entry, lockIntegrities: new Set(entry.integrity ? [entry.integrity] : []), sources: [source]});
  };
  for (const source of SOURCES) {
    const files = {};
    for (const [path, digest] of Object.entries(source.files)) {
      const url = `https://raw.githubusercontent.com/${source.repo}/${source.commit}/${path}`;
      files[path] = (await publicBytes(url, digest)).toString("utf8");
      provenance.sources.push({url, sha256: digest});
    }
    const metadata = JSON.parse(files["package.json"]);
    const selected = files["package-lock.json"]
      ? selectNpmLock(JSON.parse(files["package-lock.json"]), source.extra, source.helpers)
      : selectYarnLock(tools.YarnLock.parse(files["yarn.lock"]).entries, metadata, source.extra, source.helpers);
    add({name: metadata.name, version: metadata.version}, source.repo);
    for (const entry of selected) add(entry, source.repo);
  }
  add({name: "plotly.js-dist-min", version: VERSION}, "published bundle");
  // jsonlint's generated parser names both runtime code generators in its header.
  add({name: "jison", version: "0.4.15"}, "jsonlint generated runtime header");
  add({name: "jison-lex", version: "0.3.4"}, "jsonlint generated runtime header");
  const components = [];
  const sections = [
    `Plotly ${VERSION}: conservative upstream attribution supplement`,
    "This is a superset of pinned upstream runtime dependencies and reviewed browser/build helpers, including nested Mapbox and MapLibre release locks. It is NOT an exact bundled inventory, proof of bit reproducibility, or legal certification. Source packages can include unused files and notices. Package versions describe upstream source candidates, not confirmed linkage. No rendering code is changed.",
    ...provenance.sources.map(({url, sha256: digest}) => `Source: ${url}\nSHA256: ${digest}`),
  ];
  // Fetch in bounded batches; sort results before emitting deterministic output.
  const entries = [...inventory.values()].sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
  const failures = [];
  for (let i = 0; i < entries.length; i += 6) {
    const results = await Promise.allSettled(entries.slice(i, i + 6).map(async (entry) => {
      const key = `${entry.name}@${entry.version}`;
      const exception = exceptions.find((item) => item.name === entry.name && item.version === entry.version);
      const metadataURL = `https://registry.npmjs.org/${entry.name}/${entry.version}`;
      const registryBytes = await publicBytes(metadataURL);
      const registry = JSON.parse(registryBytes);
      if (registry.name !== entry.name || registry.version !== entry.version) throw new Error(`Registry identity mismatch: ${key}`);
      const archiveURL = registry.dist.tarball;
      const bytes = await publicBytes(archiveURL);
      verifyIntegrity(bytes, registry.dist.integrity, key);
      for (const integrity of entry.lockIntegrities) verifyIntegrity(bytes, integrity, `${key} upstream lock`);
      const files = await readTarball(bytes, tools.tar);
      if (HELPER_SOURCES[key]) {
        const helper = HELPER_SOURCES[key];
        if (sha256(files.get(helper.path)) !== helper.sha256) throw new Error(`Reviewed emitted helper changed: ${key}`);
      }
      if (key === "glslify@7.1.1") {
        if (sha256(files.get("package/browser.js")) !== "9de5320d09d93b42e2e7aad2cbc4338046fc796a80b99ccf866095c88443249d" || sha256(files.get("package/package.json")) !== "ff15d4c07e04cbb51d5a63d454fbb93646547ddde933c4e7e5d8b4f19c1d8f4d") throw new Error("Reviewed glslify browser boundary changed");
      }
      const metadataPath = [...files.keys()].find((path) => /^[^/]+\/package\.json$/.test(path));
      const publishedMetadata = JSON.parse(files.get(metadataPath) ?? "null");
      if (publishedMetadata?.name !== entry.name || publishedMetadata?.version !== entry.version) throw new Error(`Tarball identity mismatch: ${key}`);
      if (entry.name === "plotly.js-dist-min") {
        if (bundleSha256 !== sha256(files.get("package/plotly.min.js"))) throw new Error("Installed Plotly bundle differs from verified published bundle");
      }
      let result;
      const extraSources = [];
      let declaration;
      if (exception) {
        for (const evidence of exception.evidence) {
          if (evidence.url) {
            files.set(evidence.path, (await publicBytes(evidence.url, evidence.sha256)).toString("utf8"));
            extraSources.push({url: evidence.url, sha256: evidence.sha256, reason: evidence.reason});
          }
        }
        // Jison-lex declares MIT in its verified README/header, not package.json.
        if (key === "jison-lex@0.3.4") {
          const evidence = exception.evidence.find((item) => item.declaration);
          if (!evidence || sha256(files.get(evidence.path) ?? "") !== evidence.sha256 || !files.get(evidence.path).includes(evidence.declaration)) throw new Error("Jison-lex MIT declaration changed");
          declaration = "MIT";
        }
      }
      if (reviewed.assembledMIT[key]) {
        const review = reviewed.assembledMIT[key];
        files.set("upstream/LICENSE.assembled", assembleMIT(files, review, canonical));
        extraSources.push({url: archiveURL, path: review.path, sha256: review.sha256, reason: "Verbatim copyright and explicit MIT declaration in integrity-verified exact-version tarball"}, {...reviewed.canonicalMIT, reason: "Canonical MIT terms used to assemble the separately labelled notice"});
        declaration = "MIT";
      }
      if (reviewed.incorporatedMIT[key]) {
        const review = reviewed.incorporatedMIT[key];
        const source = files.get(review.path);
        if (!source || sha256(source) !== review.sha256 || !source.includes(review.link)) throw new Error(`Incorporated license link changed: ${key}`);
        files.set("upstream/LICENSE.author-linked", (await publicBytes(review.url, review.licenseSha256)).toString("utf8"));
        extraSources.push({url: archiveURL, path: review.path, sha256: review.sha256, reason: "Published README expressly incorporates author-hosted license"}, {url: review.url, sha256: review.licenseSha256, reason: "Author-linked full terms captured in 2026, including actual current copyright year; not claimed as historical tarball text"});
        declaration = "MIT";
      }
      if (RESTORED_LICENSES[key]) {
        const source = RESTORED_LICENSES[key];
        files.set("upstream/LICENSE", (await publicBytes(source.url, source.sha256)).toString("utf8"));
        extraSources.push(source);
        declaration = "MIT";
      }
      // These declarations come from the complete compound grants in LICENSE.txt.
      if (["@plotly/mapbox-gl@1.13.4", "mapbox-gl@1.13.1"].includes(key)) declaration = "BSD-3-Clause AND MIT";
      if (key === "stack-trace@0.0.9") declaration = "MIT";
      if (key === "jison@0.4.15") declaration = "MIT";
      if (key === "weak-map@1.0.5") {
        const source = {url: "https://www.apache.org/licenses/LICENSE-2.0.txt", sha256: "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30", reason: "Full official terms explicitly referenced by the published weak-map.js Google 2011 Apache 2.0 line header"};
        files.set("upstream/LICENSE", (await publicBytes(source.url, source.sha256)).toString("utf8"));
        extraSources.push(source);
        declaration = "Apache-2.0";
      }
      try {
        try { result = packageMaterials(files, key, declaration); } catch (error) {
          if (!(error instanceof MissingMaterialError)) throw error;
          if (exception) {
            result = acceptMissingMaterials(error, exception, {name: entry.name, version: entry.version, tarballSha256: sha256(bytes), registryGitHead: registry.gitHead ?? null, bundleSha256}, files);
          } else {
            extraSources.push(...await sourceLicense(files, registry));
            result = packageMaterials(files, key, declaration);
          }
        }
        tools.parseSpdx(result.license);
        if (/LicenseRef-|DocumentRef-/i.test(result.license)) throw new Error(`Unknown license: ${key}`);
      } catch (error) {
        error.evidence = {package: key, error: error.message, metadataURL, metadataSha256: sha256(registryBytes), tarball: archiveURL, integrity: registry.dist.integrity, tarballSha256: sha256(bytes), gitHead: registry.gitHead ?? null, repository: registry.repository ?? null};
        throw error;
      }
      const purl = `pkg:npm/${entry.name.replace("@", "%40")}@${entry.version}`;
      return {
        component: {type: "library", name: entry.name, version: entry.version, purl, "bom-ref": purl, licenses: [{expression: result.license}], properties: [{name: "nteract:attribution:scope", value: "conservative-plotly-upstream-source"}, {name: "nteract:attribution:tarball", value: archiveURL}, ...(result.exception ? [{name: "nteract:attribution:status", value: "reviewed-with-exceptions"}, {name: "nteract:attribution:exception", value: JSON.stringify(result.exception)}] : [])]},
        record: {name: entry.name, version: entry.version, sources: [...new Set(entry.sources)].sort(), metadataURL, metadataSha256: sha256(registryBytes), tarball: archiveURL, integrity: registry.dist.integrity, lockIntegrities: [...entry.lockIntegrities].sort(), sha256: sha256(bytes), helperBoundary: HELPER_SOURCES[key] ?? null, extraSources, exception: result.exception ?? null, materials: result.materials.map(({path, text}) => ({path, sha256: sha256(text)}))},
        text: [`${key}\nSource: ${archiveURL}\nTarball integrity: ${registry.dist.integrity}\nDeclared license: ${result.license}`, ...(result.exception ? [exceptionSummary([result.exception])] : []), ...extraSources.map((item) => `Source: ${item.url}\nSHA256: ${item.sha256}\n${item.reason}`), ...result.materials.map(({path, text}) => `--- ${path} ---\n${text}`)].join("\n\n"),
      };
    }));
    for (const result of results) {
      if (result.status === "rejected") failures.push(result.reason.evidence ?? {error: result.reason.message});
      else {
        components.push(result.value.component);
        provenance.packages.push(result.value.record);
        sections.push(result.value.text);
      }
    }
    console.error(`Checked ${Math.min(i + 6, entries.length)}/${entries.length} Plotly source packages`);
  }
  if (failures.length) {
    await mkdir(output, {recursive: true});
    await writeFile(join(output, "plotly-review-notices.txt"), `INCOMPLETE REVIEW MATERIAL. NOT A RELEASE NOTICE BUNDLE.\n${failures.length} unresolved inputs remain; no collector supplement is published.\n\n${sections.join("\n\n============================================================\n\n")}\n`);
    await writeFile(join(output, "plotly-review-provenance.json"), `${JSON.stringify({...provenance, status: "incomplete", failures}, null, 2)}\n`);
    // An audit report is not a collector supplement and cannot open its release gate.
    await writeFile(join(output, "plotly-audit.json"), `${JSON.stringify({schemaVersion: 1, status: "incomplete", scope: "Conservative upstream source inventory; not exact bundle linkage or reproducibility", bundleSha256: provenance.bundleSha256, sources: provenance.sources, selectedPackages: entries.length, verifiedPackagesWithMaterials: components.length, failures}, null, 2)}\n`);
    throw new Error(`Plotly supplement incomplete; audit and non-publishable review material written:\n${failures.map((failure) => failure.error).join("\n")}`);
  }
  const acceptedExceptions = provenance.packages.flatMap((item) => item.exception ? [item.exception] : []);
  if (acceptedExceptions.length !== exceptions.length) throw new Error("Unused Plotly attribution exception; review the exception manifest");
  const status = "reviewed-with-exceptions";
  provenance.status = status;
  const exceptionText = `${exceptionSummary(acceptedExceptions)}\n`;
  const notices = `${exceptionText}\n${sections.join("\n\n============================================================\n\n")}\n`;
  const bundleComponent = components.find((item) => item.name === "plotly.js-dist-min");
  bundleComponent.properties.push({name: "nteract:attribution:status", value: status}, {name: "nteract:attribution:exception-summary", value: exceptionText}, {name: "nteract:attribution:exceptions-sha256", value: sha256(exceptionBytes)});
  const supplement = {schemaVersion: 1, packages: {[`plotly.js-dist-min@${VERSION}`]: {
    status, files: {"plotly.min.js": provenance.bundleSha256}, covers: ["upstream-bundle"],
    notices: [{path: "plotly-notices.txt", sha256: sha256(notices), source: `https://github.com/plotly/plotly.js/tree/${SOURCES[0].commit}`}, {path: "plotly-exceptions.txt", sha256: sha256(exceptionText), source: exceptions[0].trackingUrl}], components,
  }}};
  await mkdir(output, {recursive: true});
  await writeFile(join(output, "plotly-notices.txt"), notices);
  await writeFile(join(output, "plotly-exceptions.txt"), exceptionText);
  await writeFile(join(output, "plotly-provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`);
  await writeFile(join(output, "plotly-audit.json"), `${JSON.stringify({schemaVersion: 1, status, scope: "Conservative upstream source inventory; not exact bundle linkage, completeness, or legal approval", bundleSha256, selectedPackages: entries.length, verifiedPackagesWithFullMaterials: components.length - acceptedExceptions.length, exceptions: acceptedExceptions, failures: []}, null, 2)}\n`);
  for (const filename of ["plotly-review-notices.txt", "plotly-review-provenance.json"]) await unlink(join(output, filename)).catch((error) => { if (error.code !== "ENOENT") throw error; });
  // Publish the gate last, after verification and explicit missing-material review.
  await writeFile(join(output, "plotly-supplement.json"), `${JSON.stringify(supplement, null, 2)}\n`);
  return {status, packages: components.length, exceptions: acceptedExceptions.length, bundleSha256: provenance.bundleSha256};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepare().then((result) => console.log(JSON.stringify(result))).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
