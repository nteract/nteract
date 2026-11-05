// Release dependency inventory, not a reconstruction of a linker's output.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WASM = "wasm32-unknown-unknown";
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const property = (name, value) => ({ name: `nteract:${name}`, value });
export const SCOPE = "Conservative resolved dependency inventory with default Cargo features, filtered by target; build and dev dependency edges excluded. Cargo feature unification and npm production closure can overapproximate linked or bundled code. This is not an exact linker or tree-shaking inventory. External system libraries, downloaded tools, and user-installed kernels/environments are not bundled dependencies. Prebuilt assets require their own provenance checks. License selection is an attribution policy, not blanket legal approval.";
const NODE_SCOPE = "Conservative native runtimed-node Cargo dependency inventory with default features, filtered by target; build and dev dependency edges excluded. Cargo feature unification can overapproximate linked code. Includes Rust standard-library attribution; excludes the daemon executable, npm renderers, and sift WASM. External system libraries and the Node.js host are not bundled. This is not an exact linker inventory. License selection is an attribution policy, not blanket legal approval.";

// Maintainer-only refresh, never called by release generation. textutil extracts
// all document text; generated Word list numbering is not part of the plain text.
export async function prepareMsvcMaterials() {
  const sources = [
    ["vs2022", "https://visualstudio.microsoft.com/wp-content/uploads/2021/11/Visual-Studio-2022-Enterprise-Professional-License-EN.docx", "docx"],
    ["sdk", "https://download.microsoft.com/download/0/F/F/0FF2B061-47DD-4F55-89B6-FD1D8C44F14D/sdk_license.rtf", "rtf"],
    ["sdk-package", "https://api.nuget.org/v3-flatcontainer/microsoft.windows.sdk.cpp/10.0.26100.7705/microsoft.windows.sdk.cpp.nuspec", null],
    ["sdk-package-x64", "https://api.nuget.org/v3-flatcontainer/microsoft.windows.sdk.cpp.x64/10.0.26100.7705/microsoft.windows.sdk.cpp.x64.nuspec", null],
    ["sdk-package-arm64", "https://api.nuget.org/v3-flatcontainer/microsoft.windows.sdk.cpp.arm64/10.0.26100.7705/microsoft.windows.sdk.cpp.arm64.nuspec", null],
  ];
  const manifest = {};
  for (const [id, url, format] of sources) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Cannot fetch ${url}: ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const text = format ? execFileSync("textutil", ["-convert", "txt", "-format", format, "-stdin", "-stdout"], { input: bytes }) : bytes;
    const file = `msvc-${id}.txt`;
    writeFileSync(join(repoRoot, "scripts/licenses", file), text);
    const sourceFile = format ? `msvc-${id}.${format}` : file;
    if (format) writeFileSync(join(repoRoot, "scripts/licenses", sourceFile), bytes);
    manifest[id] = { file, sourceFile, url, sourceSha256: sha256(bytes), textSha256: sha256(text), extraction: format ? `macOS textutil -convert txt -format ${format} -stdin -stdout; all text, Word-generated numbering omitted; complete original document retained separately` : "Original UTF-8 metadata, unmodified" };
  }
  writeFileSync(join(repoRoot, "scripts/licenses/msvc-provenance.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

export function pinnedMsvcMaterial(id, directory = join(repoRoot, "scripts/licenses")) {
  const pins = {
    vs2022: "a91d6e094ba3758d7ea13019d4fd782f7a340019f75f7eb9e46ef4d5c643d120",
    sdk: "b51ec2350d938f5b6c8d6207ee5a3e10effbf8a134e432aa393577d41d3dae06",
    "sdk-package": "7b2f153f9f995726172e30bbc0d77ac6b73443b66a95ac04f8ef2ebcb3b66c4a",
    "sdk-package-x64": "340621de62d163b9dd76611ba816ee0b95a3462c89b3140bd2137ca5c9b3dee3",
    "sdk-package-arm64": "13e6e7575569646f5c0fbe678f9f962e4a0398f4314081bd9129938614d813a0",
  };
  const manifest = JSON.parse(readFileSync(join(directory, "msvc-provenance.json"), "utf8"));
  const entry = manifest[id];
  if (!entry || !pins[id] || entry.textSha256 !== pins[id] || !/^msvc-[a-z0-9-]+\.txt$/.test(entry.file)) throw new Error(`Unreviewed Microsoft terms asset: ${id}`);
  const path = join(directory, entry.file);
  const bytes = readFileSync(path);
  if (sha256(bytes) !== pins[id]) throw new Error(`Microsoft terms asset digest mismatch: ${path}`);
  const originalPins = { vs2022: "9c0cd52b20db9d081854c75bd1b50c75514b8f8cb09c8cad15e89d90b97b5bf3", sdk: "dd07eb178e00c6bba4148457fc00ff77cd4887eb521d504186fe59c9ec8bbe62" };
  if (!/^msvc-[a-z0-9-]+\.(txt|rtf|docx)$/.test(entry.sourceFile ?? "") || entry.sourceSha256 !== (originalPins[id] ?? pins[id]) || sha256(readFileSync(join(directory, entry.sourceFile))) !== entry.sourceSha256) throw new Error(`Microsoft original source digest mismatch: ${id}`);
  return { path, digest: pins[id], text: bytes.toString("utf8"), provenance: `Official source: ${entry.url}\nOriginal source SHA-256: ${entry.sourceSha256}\nPreserved text SHA-256: ${pins[id]}\nExtraction: ${entry.extraction}` };
}

export function parseArgs(args) {
  const options = {};
  const keys = new Set(["kind", "target", "output", "version", "commit", "binary"]);
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].replace(/^--/, "");
    if (!args[i].startsWith("--") || !keys.has(key) || options[key] !== undefined || !args[i + 1] || args[i + 1].startsWith("--")) {
      throw new Error(`Invalid or duplicate argument: ${args[i]}`);
    }
    options[key] = args[i + 1];
  }
  validateIdentity(options);
  if (!options.output) throw new Error("--output is required");
  return options;
}

export function validateIdentity({ kind, target, version, commit }) {
  if (!["notebook-ui", "runtimed", "runtimed-node"].includes(kind)) throw new Error("--kind must be notebook-ui, runtimed, or runtimed-node");
  if (!/^[a-z0-9_]+(?:-[a-z0-9_]+){2,}$/.test(target ?? "")) throw new Error("Invalid Rust --target triple");
  if (kind === "notebook-ui" && target !== WASM) throw new Error(`notebook-ui requires --target ${WASM}`);
  if (kind !== "notebook-ui" && target.startsWith("wasm")) throw new Error(`${kind} requires a native --target`);
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(version ?? "")) throw new Error("Invalid release --version");
  if (!/^[0-9a-fA-F]{40}$/.test(commit ?? "")) throw new Error("--commit must be a full 40-hex source SHA");
}

function requiredText(path) {
  const text = readFileSync(path, "utf8").trim();
  if (!text) throw new Error(`Empty attribution material: ${path}`);
  return text;
}

function filesUnder(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Unreviewed source symlink: ${path}`);
    return entry.isDirectory() ? filesUnder(path) : [path];
  }).sort(compare);
}

// Version-bound review: upgrades must review bundled material again. Test and
// benchmark C files are exempt only at the exact paths inspected here.
const NATIVE = {
  "aws-lc-sys": { versions: ["0.47.0"], files: ["LICENSE", "aws-lc/LICENSE", "aws-lc/third_party/fiat/LICENSE"], expression: "ISC AND Apache-2.0 AND MIT AND BSD-3-Clause AND CC0-1.0" },
  ring: { versions: ["0.17.14"], files: ["LICENSE", "LICENSE-BoringSSL", "LICENSE-other-bits", "third_party/fiat/LICENSE", "src/polyfill/once_cell/LICENSE-APACHE", "src/polyfill/once_cell/LICENSE-MIT"], expression: "ISC AND Apache-2.0 AND MIT" },
  "zstd-sys": { versions: ["2.0.16+zstd.1.5.7"], files: ["zstd/LICENSE"], expression: "BSD-3-Clause" },
  "libsqlite3-sys": { versions: ["0.30.1"], files: ["sqlcipher/LICENSE"], expression: "LicenseRef-SQLite-Public-Domain" },
  "signal-hook": { versions: ["0.3.18"], files: ["LICENSE-APACHE"], expression: "Apache-2.0" },
  "fancy-regex": { versions: ["0.17.0"], excluded: /^tests\/oniguruma\/test_utf8(?:_ignore)?\.c$/ },
  nix: { versions: ["0.29.0", "0.30.1", "0.31.2"], excluded: /^test\/test_kmod\/hello_mod\/hello\.c$/ },
  walkdir: { versions: ["2.5.0"], excluded: /^compare\/nftw\.c$/ },
  zeromq: { versions: ["0.7.0"], excluded: /^c_benches\/(client|server)\.c$/ },
  "openssl-sys": { versions: ["0.9.114"], excluded: /^build\/expando\.c$/ },
};

export function nativeMaterial(pkg, files = filesUnder(dirname(pkg.manifest_path))) {
  const root = dirname(pkg.manifest_path);
  const native = files.filter((path) => /\.(c|cc|cpp|cxx|s|asm)$/i.test(path));
  const review = NATIVE[pkg.name];
  if (!native.length && !review?.files) return [];
  if (!review?.versions.includes(pkg.version)) throw new Error(`Unreviewed native sources: ${pkg.name}@${pkg.version}`);
  if (review.excluded) {
    for (const path of native) {
      if (!review.excluded.test(relative(root, path).replaceAll("\\", "/"))) throw new Error(`Unreviewed native source: ${path}`);
    }
    return [];
  }
  const materials = review.files.map((file) => ({ title: `${pkg.name}@${pkg.version}: ${file}`, text: requiredText(join(root, file)), expression: review.expression }));
  if (pkg.name === "libsqlite3-sys") {
    const source = requiredText(join(root, "sqlite3/sqlite3.c"));
    const blessing = source.match(/\*\* The author disclaims copyright[^]*?May you share freely, never taking more than you give\./)?.[0];
    if (!blessing) throw new Error("Missing SQLite public-domain declaration");
    materials.push({ title: `SQLite via ${pkg.name}@${pkg.version}`, expression: review.expression, text: `SQLite is public domain, not the MIT license of its Rust bindings.\nhttps://www.sqlite.org/copyright.html\n\n${blessing}\n\nSQLCipher license is included conservatively; the default bundled feature uses SQLite.` });
  }
  return materials;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort(compare).map((key) => [key, stable(value[key])]));
  return value;
}

// Only set-valued fields combine. Conflicting identities or descriptions fail
// rather than silently choosing whichever graph was traversed first.
export function mergeComponents(...groups) {
  const merged = new Map();
  const sets = new Set(["properties", "externalReferences", "hashes"]);
  for (const component of groups.flat()) {
    const ref = component["bom-ref"];
    if (!ref || !component.name || !component.version || !component.licenses?.length) throw new Error("Incomplete SBOM component identity/license");
    const result = merged.get(ref) ?? {};
    for (const [key, value] of Object.entries(component)) {
      if (sets.has(key)) {
        const entries = [...(result[key] ?? []), ...value].map((v) => JSON.stringify(stable(v)));
        result[key] = [...new Set(entries)].sort(compare).map((v) => JSON.parse(v));
      } else if (result[key] !== undefined && JSON.stringify(stable(result[key])) !== JSON.stringify(stable(value))) {
        throw new Error(`Conflicting ${key} for ${ref}`);
      } else result[key] = value;
    }
    merged.set(ref, result);
  }
  return [...merged.values()].sort((a, b) => compare(a["bom-ref"], b["bom-ref"]));
}

export function collectRustReport(report, { root, target }) {
  if (!report.crates?.length || !report.licenses?.length) throw new Error(`Empty cargo-about report for ${root}`);
  const selected = new Map();
  const materials = [];
  for (const group of report.licenses) {
    if (!group.id || !group.text?.trim() || !group.used_by?.length) throw new Error("Missing cargo-about license material");
    const users = [];
    for (const { crate: pkg } of group.used_by) {
      const ids = selected.get(pkg.id) ?? new Set();
      ids.add(group.id);
      selected.set(pkg.id, ids);
      users.push(`${pkg.name}@${pkg.version}`);
    }
    materials.push({ title: `${group.id}: ${[...new Set(users)].sort(compare).join(", ")}`, text: group.text.trim() });
  }
  const components = report.crates.map(({ package: pkg, license }) => {
    const ids = selected.get(pkg.id);
    if (!ids?.size) throw new Error(`Missing selected license for ${pkg.name}@${pkg.version}`);
    if (pkg.source && pkg.source !== "registry+https://github.com/rust-lang/crates.io-index") throw new Error(`Unreviewed Cargo source: ${pkg.id}`);
    const purl = `pkg:cargo/${pkg.name}@${encodeURIComponent(pkg.version)}`;
    const nativeExpression = pkg.source ? NATIVE[pkg.name]?.expression : undefined;
    const expression = [...new Set([...ids, ...(nativeExpression?.split(" AND ") ?? [])])].sort(compare).join(" AND ");
    const properties = [property("cargo-root", root), property("target", target), property("declared-license", license)];
    const externalReferences = [];
    if (pkg.source) {
      const archive = `https://static.crates.io/crates/${pkg.name}/${pkg.name}-${pkg.version}.crate`;
      externalReferences.push({ type: "distribution", url: archive });
      const files = filesUnder(dirname(pkg.manifest_path));
      materials.push(...nativeMaterial(pkg, files));
      // Preserve copyright notices and nested vendored Rust license material,
      // including texts for alternative licenses without selecting those terms.
      for (const path of files.filter((p) => /^(?:LICENSE|LICENCE|COPYING|NOTICE|COPYRIGHT)(?:[._-]|$)/i.test(p.split(/[\\/]/).at(-1)))) {
        materials.push({ title: `${pkg.name}@${pkg.version}: ${relative(dirname(pkg.manifest_path), path)}`, text: requiredText(path) });
      }
      if (ids.has("MPL-2.0")) materials.push({ title: `MPL-2.0 source availability: ${pkg.name}@${pkg.version}`, text: `Source for the MPL-covered crate is available in this exact registry archive:\n${archive}\nMPL-2.0 applies to the covered files; consult its terms when modifying or redistributing them.` });
      const native = NATIVE[pkg.name];
      if (native?.expression) properties.push(property("bundled-native-license", native.expression));
    } else properties.push(property("source", "workspace"));
    if (pkg.repository) externalReferences.push({ type: "vcs", url: pkg.repository });
    return { type: "library", "bom-ref": purl, name: pkg.name, version: pkg.version, purl, licenses: [{ expression }], properties, externalReferences };
  });
  return { components, materials };
}

export function collectRust(rootDirectory, options) {
  const version = execFileSync("cargo", ["about", "--version"], { encoding: "utf8" }).trim();
  if (version !== "cargo-about 0.9.2") throw new Error(`Expected cargo-about 0.9.2, got ${version}`);
  const targets = execFileSync("rustc", ["--print", "target-list"], { encoding: "utf8" }).split(/\r?\n/);
  if (!targets.includes(options.target)) throw new Error(`Unknown Rust target: ${options.target}`);
  const roots = options.kind === "runtimed-node" ? [["runtimed-node", options.target]] : options.kind === "notebook-ui" ? [["runtimed-wasm", WASM], ["sift-wasm", WASM]] : [["runtimed", options.target], ["sift-wasm", WASM]];
  const reports = roots.map(([root, target]) => {
    const report = JSON.parse(execFileSync("cargo", ["about", "generate", "--locked", "--fail", "--format", "json", "--config", join(rootDirectory, "scripts/release-about.toml"), "--manifest-path", join(rootDirectory, "crates", root, "Cargo.toml"), "--target", target], { cwd: rootDirectory, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], maxBuffer: 128 * 1024 * 1024 }));
    return collectRustReport(report, { root, target });
  });
  return { components: mergeComponents(...reports.map((r) => r.components)), materials: reports.flatMap((r) => r.materials) };
}

export function collectRustToolchain() {
  const sysroot = execFileSync("rustc", ["--print", "sysroot"], { encoding: "utf8" }).trim();
  const details = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
  const version = details.match(/^release: (.+)$/m)?.[1];
  const commit = details.match(/^commit-hash: ([a-f0-9]{40})$/m)?.[1];
  if (!version || !commit) throw new Error("Missing Rust toolchain identity");
  const documentation = join(sysroot, "share/doc/rust");
  // This upstream report includes std/alloc/compiler-builtins attribution,
  // which Cargo's application dependency graph cannot enumerate.
  const report = requiredText(join(documentation, "COPYRIGHT-library.html"));
  const licenseFiles = [...report.matchAll(/href="licenses\/([^"]+)"/g)].map((m) => m[1]);
  const materials = [{ title: `Rust standard library ${version}: upstream COPYRIGHT-library.html (HTML source)`, text: report }];
  for (const file of [...new Set(["Apache-2.0.txt", "MIT.txt", ...licenseFiles])].sort(compare)) {
    if (!/^[A-Za-z0-9.-]+\.txt$/.test(file)) throw new Error(`Invalid toolchain license path: ${file}`);
    materials.push({ title: `Rust toolchain ${version}: ${file}`, text: requiredText(join(documentation, "licenses", file)) });
  }
  const ref = `pkg:generic/rust-standard-library@${encodeURIComponent(version)}`;
  return { components: [{ type: "library", "bom-ref": ref, name: "rust-standard-library", version, purl: ref, licenses: [{ license: { name: "Rust standard library and bundled dependencies; see upstream COPYRIGHT-library.html in notices" } }], externalReferences: [{ type: "vcs", url: `https://github.com/rust-lang/rust/tree/${commit}/library` }], properties: [property("inventory-scope", "Conservative upstream standard-library attribution, not target-specific linked code. Compiler executable is not bundled."), property("rustc-commit", commit)] }], materials };
}

// /MT includes both the MSVC startup/vcruntime and the SDK's static UCRT.
// These are proprietary runtime inputs, not external Windows DLLs or Cargo crates.
export function collectMsvcRuntime({ target }, env = process.env, run = execFileSync) {
  if (!target.endsWith("-windows-msvc")) return { components: [], materials: [] };
   const fail = (reason) => { throw new Error(`Windows CRT attribution action required: ${reason}. Run build and attribution in the same VS Developer environment (VCToolsInstallDir, VCToolsVersion, VSINSTALLDIR, WindowsSdkDir, UCRTVersion, LIB). Preserve the producer's Visual Studio and Windows SDK license terms; set NTERACT_MSVC_LICENSE_FILE and NTERACT_WINDOWS_SDK_LICENSE_FILE to matching plain-text terms files when automatic discovery fails. Microsoft terms and REDIST lists govern redistribution; this generator cannot grant permission.`); };
  const arch = { x86_64: "x64", aarch64: "arm64", i686: "x86" }[target.split("-")[0]];
  if (!arch) fail(`unreviewed MSVC architecture ${target}`);
  for (const key of ["VCToolsInstallDir", "VCToolsVersion", "VSINSTALLDIR", "WindowsSdkDir", "UCRTVersion", "LIB"]) if (!env[key]) fail(`missing producer ${key}`);
  const tools = resolve(env.VCToolsInstallDir);
  const studio = resolve(env.VSINSTALLDIR);
  const sdk = resolve(env.WindowsSdkDir);
  const version = env.VCToolsVersion.replace(/[\\/]+$/, "");
  const sdkVersion = env.UCRTVersion.replace(/[\\/]+$/, "");
  if (!/^14\.\d+\.\d+$/.test(version) || basename(tools) !== version || !/^10\.0\.\d+\.\d+$/.test(sdkVersion)) fail("toolset/SDK versions do not match producer paths");
  if (env.VSCMD_ARG_TGT_ARCH && env.VSCMD_ARG_TGT_ARCH !== arch) fail("developer environment architecture does not match release target");
  if (relative(studio, tools).startsWith("..")) fail("MSVC tools are outside the identified Visual Studio installation");
  let compiler;
  try {
    compiler = run("where.exe", ["cl.exe"], { encoding: "utf8" }).trim().split(/\r?\n/)[0];
    if (!compiler || relative(tools, compiler).startsWith("..") || !existsSync(compiler)) fail("PATH compiler is not from VCToolsInstallDir");
  } catch (error) { fail(`cannot identify the active cl.exe compiler: ${error.message}`); }
  const compilerHash = sha256(readFileSync(compiler));
  let installation;
  try {
    const vswhere = join(env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Microsoft Visual Studio", "Installer", "vswhere.exe");
    const installed = JSON.parse(run(vswhere, ["-all", "-products", "*", "-format", "json", "-utf8"], { encoding: "utf8" }));
    installation = installed.find((item) => resolve(item.installationPath).toLowerCase() === studio.toLowerCase());
  } catch (error) { fail(`cannot identify producer edition with vswhere: ${error.message}`); }
  if (!installation || !/Microsoft\.VisualStudio\.Product\.(Enterprise|Professional|Community|BuildTools)$/.test(installation.productId ?? "") || !/^(17|18)\./.test(installation.installationVersion ?? "")) fail("unrecognized Visual Studio producer edition/version");
  if (installation.isPrerelease) fail("preview Visual Studio toolsets need a separate redistribution review");
  const year = installation.installationVersion.startsWith("17.") ? "2022" : "2026";
  const paths = env.LIB.split(";").filter(Boolean).map((path) => resolve(path));
  const materials = [];
  function terms(label, override, candidates, expectedProduct, fallback) {
    for (const path of override ? [override] : candidates) {
      if (!existsSync(path)) continue;
      const bytes = readFileSync(path);
       const text = bytes.subarray(0, 2).equals(Buffer.from([0xff, 0xfe])) ? bytes.subarray(2).toString("utf16le") : bytes.toString("utf8");
       if (text.includes("\0") || /^\s*(?:\{\\rtf|<!doctype|<html|<\?xml)/i.test(text) || /\.(?:rtf|html?|docx?)$/i.test(path)) {
         if (override) fail(`convert structured ${label} terms to complete UTF-8 or UTF-16 plain text before supplying ${path}`);
         continue;
       }
      if (!/Microsoft/i.test(text) || !/licen[sc]e/i.test(text) || !/Distributable\s+Code/i.test(text) || !expectedProduct.test(text)) continue;
      materials.push({ title: `${label} producer license terms (${path}; SHA-256 ${sha256(bytes)})`, text });
      return { path, digest: sha256(bytes) };
    }
    if (!override && fallback) {
      const pinned = pinnedMsvcMaterial(fallback);
      materials.push({ title: `${label} official pinned terms`, text: `${pinned.provenance}\n\n${pinned.text}` });
      return pinned;
    }
    fail(`cannot locate ${label} redistribution license text for this product (searched ${(override ? [override] : candidates).join(", ")})`);
  }
  const sdkLicenseDir = join(sdk, "Licenses", sdkVersion);
   const sdkLicenseFiles = existsSync(sdkLicenseDir) ? readdirSync(sdkLicenseDir).filter((name) => /\.txt$/i.test(name)).sort(compare).map((name) => join(sdkLicenseDir, name)) : [];
  const vsLicenseDir = join(studio, "Licenses");
   const vsLicenseFiles = existsSync(vsLicenseDir) ? filesUnder(vsLicenseDir).filter((file) => /\.txt$/i.test(file)) : [];
  const edition = installation.productId.split(".").at(-1);
  const vsProduct = new RegExp(`Visual Studio[^]*?(?:${edition === "BuildTools" ? "Enterprise|Professional|Community" : edition})[^]*?${year}`, "i");
  const vsFallback = year === "2022" && ["Enterprise", "Professional"].includes(edition) && /^17\.14\./.test(installation.installationVersion) && /^14\.44\./.test(version) ? "vs2022" : undefined;
   const vsTerms = terms(`Visual Studio ${year} ${installation.productId}`, env.NTERACT_MSVC_LICENSE_FILE, [join(studio, "License.txt"), join(studio, "Common7/IDE/License.txt"), ...vsLicenseFiles], vsProduct, vsFallback);
  let sdkFallback;
  if (!env.NTERACT_WINDOWS_SDK_LICENSE_FILE && sdkVersion === "10.0.26100.0" && ["x64", "arm64"].includes(arch)) {
    // The library directory omits servicing revisions. Match the installed SDK
    // product as well, rather than extending a 26100 grant to future servicing.
    const script = "$ErrorActionPreference='Stop'; @(Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like 'Windows Software Development Kit*' } | Select-Object DisplayName,DisplayVersion) | ConvertTo-Json -Compress";
    let products;
    try { products = JSON.parse(run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" })); }
    catch (error) { if (!sdkLicenseFiles.length) fail(`cannot verify SDK servicing product for pinned terms: ${error.message}`); }
    if ([products].flat().some((product) => product?.DisplayVersion === "10.1.26100.7705" && /^Windows Software Development Kit/.test(product.DisplayName))) {
      sdkFallback = "sdk";
      const evidence = pinnedMsvcMaterial("sdk-package");
      materials.push({ title: "Windows SDK 10.0.26100.7705 license applicability evidence", text: `${evidence.provenance}\n\n${evidence.text}\nThe exact Microsoft SDK package declares https://aka.ms/WinSDKLicenseURL, resolved during preparation to the preserved sdk_license.rtf source. Installed product 10.1.26100.7705 uses the 10.0.26100.0 library directory. This fallback applies only to that installed servicing product, not future SDK versions.` });
      const architecture = pinnedMsvcMaterial(`sdk-package-${arch}`);
      materials.push({ title: `Windows SDK ${arch} runtime package license applicability`, text: `${architecture.provenance}\n\n${architecture.text}` });
    }
  }
  const sdkTerms = terms(`Windows SDK ${sdkVersion}`, env.NTERACT_WINDOWS_SDK_LICENSE_FILE, sdkLicenseFiles, /Windows[^]*?(?:Development Kit|SDK)/i, sdkFallback);
  const guidance = "https://learn.microsoft.com/en-us/cpp/windows/redistributing-visual-cpp-files";
  const vsRedist = `https://learn.microsoft.com/en-us/visualstudio/releases/${year}/redistribution`;
  const sdkRedist = "https://learn.microsoft.com/en-us/legal/windows-sdk/redist";
  const components = [["Microsoft Visual C++ static CRT", "msvc-static-crt", version, tools, ["libcmt.lib", "libvcruntime.lib"], join(tools, "lib", arch), vsTerms, vsRedist], ["Microsoft Universal C Runtime (static)", "ucrt-static", sdkVersion, sdk, ["libucrt.lib"], join(sdk, "Lib", sdkVersion, "ucrt", arch), sdkTerms, sdkRedist]].map(([name, id, release, source, libraries, directory, license, redist]) => {
    const inventory = libraries.map((library) => {
      const found = paths.map((dir) => join(dir, library)).find((path) => existsSync(path));
      if (!found || resolve(dirname(found)).toLowerCase() !== resolve(directory).toLowerCase()) fail(`${library} LIB resolution does not match identified producer ${directory}`);
      const bytes = readFileSync(found);
      if (!bytes.length) fail(`empty runtime library ${found}`);
      return { path: found, sha256: sha256(bytes) };
    });
    const purl = `pkg:generic/microsoft/${id}@${release}?arch=${arch}`;
    materials.push({ title: `${name} ${release}`, text: `Proprietary Microsoft runtime statically linked by the release's +crt-static configuration; not covered by nteract's BSD license.\nProducer: ${installation.productId} ${installation.installationVersion}\nSource toolchain: ${source}\nRuntime input inventory (not an exact linker member map):\n${inventory.map((item) => `${item.path}\nSHA-256: ${item.sha256}`).join("\n")}\n\nRedistribution is subject to the producer's Microsoft license terms and applicable REDIST lists. No independent license grant or legal approval is supplied by these notices. Preserving these documents does not itself satisfy all distribution requirements, including applicable downstream protective terms. The SDK REDIST list permits listed static .lib inputs only as linked program output, subject to its terms. Debug CRTs are not redistributable. Security fixes for statically linked runtime code require rebuilding and redistributing the application.\nGuidance: ${guidance}\nApplicable REDIST list: ${redist}\nCRT library descriptions: https://learn.microsoft.com/en-us/cpp/c-runtime-library/crt-library-features\nVisual Studio licensing directory: https://visualstudio.microsoft.com/license-terms/` });
    return { type: "library", name, version: release, purl, "bom-ref": purl, licenses: [{ license: { name: "Microsoft proprietary software license terms (producer edition; see notices)", url: "https://visualstudio.microsoft.com/license-terms/" } }], externalReferences: [{ type: "documentation", url: guidance }, { type: "license", url: redist }], properties: [property("target", target), property("linkage", "static"), property("source-toolchain-path", source), property("visual-studio-product", installation.productId), property("visual-studio-version", installation.installationVersion), property("compiler-path", compiler), property("compiler-sha256", compilerHash), property("runtime-inputs", JSON.stringify(inventory)), property("producer-license-path", license.path), property("producer-license-sha256", license.digest)] };
  });
  return { components, materials };
}

export function renderRelease(options, { ownLicense, rust, npm, binary }) {
  validateIdentity(options);
  const nodeBinding = options.kind === "runtimed-node";
  if (!ownLicense?.trim() || (!nodeBinding && !npm?.notices?.trim()) || !rust.materials.length) throw new Error("Missing release attribution material");
  if (nodeBinding && binary === undefined) throw new Error("runtimed-node requires --binary for the shipped .node digest");
  if (nodeBinding && npm !== undefined) throw new Error("runtimed-node must not include npm renderer attribution");
  const scope = nodeBinding ? NODE_SCOPE : SCOPE;
  const components = mergeComponents(rust.components, npm?.components ?? []);
  const commit = options.commit.toLowerCase();
  const source = `https://github.com/nteract/nteract/tree/${commit}`;
  const application = { type: "application", "bom-ref": `nteract:${options.kind}:${options.version}:${options.target}:${commit}`, name: options.kind, version: options.version, licenses: [{ license: { id: "BSD-3-Clause" } }], externalReferences: [{ type: "vcs", url: source }] };
  if (binary !== undefined) application.hashes = [{ alg: "SHA-256", content: sha256(binary) }];
  const sbom = { bomFormat: "CycloneDX", specVersion: "1.6", version: 1, metadata: { component: application, properties: [property("source-commit", commit), property("target", options.target), property("inventory-scope", scope), property("cargo-about-version", "0.9.2")] }, components };
  const materialGroups = new Map();
  for (const { title, text } of rust.materials) {
    if (!text?.trim()) throw new Error(`Missing license material: ${title}`);
    const titles = materialGroups.get(text.trim()) ?? new Set();
    titles.add(title);
    materialGroups.set(text.trim(), titles);
  }
  const notices = ["THIRD-PARTY NOTICES", "", `${options.kind} ${options.version} (${options.target})`, `Source: ${source}`, "", scope, "", "NTERACT LICENSE (BSD-3-Clause)", "", ownLicense.trim(), "", "RUST DEPENDENCY INVENTORY (selected licenses)", "", ...components.filter((c) => c.purl?.startsWith("pkg:cargo/")).map((c) => `${c.name}@${c.version}: ${c.licenses.map((l) => l.expression).join("; ")}`), "", "RUST LICENSE AND NOTICE MATERIAL", "", ...[...materialGroups].map(([text, titles]) => ({ text, title: [...titles].sort(compare).join("\n") })).sort((a, b) => compare(a.title, b.title) || compare(a.text, b.text)).flatMap(({ title, text }) => [title, "", text, ""]), ...(nodeBinding ? [] : ["BUNDLED NPM MATERIAL", "", npm.notices.trim(), ""])].join("\n");
  return { "LICENSE.nteract": ownLicense, "THIRD_PARTY_NOTICES.txt": notices, "sbom.cdx.json": `${JSON.stringify(stable(sbom), null, 2)}\n` };
}

export async function generate(options, rootDirectory = repoRoot) {
  validateIdentity(options);
  if (options.kind === "runtimed-node" && !options.binary) throw new Error("runtimed-node requires --binary");
  const microsoft = collectMsvcRuntime(options);
  const rust = collectRust(rootDirectory, options);
  const toolchain = collectRustToolchain();
  rust.components = mergeComponents(rust.components, toolchain.components);
  rust.materials.push(...toolchain.materials);
  rust.components = mergeComponents(rust.components, microsoft.components);
  rust.materials.push(...microsoft.materials);
  let npm;
  if (options.kind !== "runtimed-node") {
    const { collectBundledNpm } = await import("./lib/bundled-npm-licenses.mjs");
    npm = await collectBundledNpm(rootDirectory);
  }
  const outputs = renderRelease(options, { ownLicense: readFileSync(join(rootDirectory, "LICENSE"), "utf8"), rust, npm, binary: options.binary ? readFileSync(options.binary) : undefined });
  mkdirSync(resolve(options.output), { recursive: true });
  for (const [name, text] of Object.entries(outputs)) writeFileSync(join(resolve(options.output), name), text);
  return outputs;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    await generate(options);
    console.log(`Wrote release attribution to ${resolve(options.output)}`);
  } catch (error) {
    console.error(`Release attribution failed: ${error.message}`);
    process.exitCode = 1;
  }
}
