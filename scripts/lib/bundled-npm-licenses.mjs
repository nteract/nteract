import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(import.meta.url);
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const slash = (path) => path.split(sep).join("/");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const scope = "notebook-ui-and-renderers:conservative-production-dependency-closure";

// These parsers are already locked build dependencies. Do not resolve from a
// machine-global install or download tooling during release attribution.
function tool(name, repoRoot) {
  for (const root of new Set([repoRoot, scriptRoot])) {
    const store = join(root, "node_modules/.pnpm");
    if (!existsSync(store)) continue;
    const candidates = readdirSync(store).filter((entry) => entry.startsWith(`${name}@`)).sort(compare);
    for (const candidate of candidates) {
      const path = join(store, candidate, "node_modules", name);
      if (existsSync(join(path, "package.json"))) return require(path);
    }
  }
  throw new Error(`Attribution requires installed locked build tool ${name}; run pnpm install --frozen-lockfile.`);
}

function inside(root, path) {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function installedPackage(root, owner, name) {
  if (!/^(@[^/]+\/)?[^/.][^/]*$/.test(name) || name.includes("\\")) {
    throw new Error(`Invalid npm dependency name: ${name}`);
  }
  for (let dir = owner; inside(root, dir); dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) {
      const path = realpathSync(candidate);
      if (!inside(root, path)) throw new Error(`Dependency ${name} resolves outside repository: ${path}`);
      return path;
    }
    if (dir === root) break;
  }
  throw new Error(`Missing installed package ${name} required by ${slash(relative(root, owner)) || "."}; run pnpm install --frozen-lockfile.`);
}

function evidence(packageDir) {
  const texts = [];
  const native = [];
  const fonts = [];
  const visited = new Set();
  function walk(dir, inheritedLicense = false) {
    const real = realpathSync(dir);
    if (!inside(packageDir, real)) throw new Error(`Attribution file escapes package: ${dir}`);
    if (visited.has(real)) return;
    visited.add(real);
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => compare(a.name, b.name))) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const path = join(dir, entry.name);
      const label = slash(relative(packageDir, path));
      const named = inheritedLicense || /(?:^|[._ -])(licen[cs]es?|copying|notices?|copyright|ofl)(?:$|[._ -])/i.test(entry.name);
      if (entry.isDirectory()) {
        walk(path, named);
      } else if (entry.isSymbolicLink()) {
        throw new Error(`Unreviewed symlink in package attribution input: ${label}`);
      } else if (entry.isFile()) {
        if (/\.(?:node|wasm|a|so|dylib|dll|c|cc|cpp|cxx)$/i.test(entry.name)) native.push(label);
        if (/\.(?:ttf|otf|woff2?)$/i.test(entry.name)) fonts.push(label);
        if (named) {
          const bytes = readFileSync(path);
          const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          if (!text.trim()) throw new Error(`Empty license/notice file: ${label}`);
          texts.push({ path: label, text, sha256: sha256(bytes), kind: "file" });
        } else if (/\.(?:[cm]?js|css)$/i.test(entry.name)) {
          const source = readFileSync(path, "utf8");
          let index = 0;
          for (const match of source.matchAll(/\/\*[\s\S]*?\*\//g)) {
            if (!/(?:@license|@preserve|copyright|bundled license|licensed under|SPDX-License-Identifier)/i.test(match[0])) continue;
            texts.push({ path: `${label}#legal-comment-${++index}`, text: match[0], sha256: sha256(match[0]), kind: "comment" });
          }
        }
      }
    }
  }
  walk(packageDir);
  return { texts, native, fonts };
}

/**
 * Collect a conservative, locked, installed production closure, not a bundler
 * module inventory. Includes optional/peer edges resolved in pnpm snapshots.
 * Workspace code is first-party; its dependencies and vendored notices remain
 * in scope. No network access, package execution, or output files are needed.
 *
 * Returns Promise<{components: CycloneDXComponent[], notices: string}>. Throws
 * on incomplete evidence, including opaque upstream bundles/native payloads.
 * The caller must separately attribute Rust/WASM and verify artifact receipts.
 */
export async function collectBundledNpm(repoRoot) {
  const root = realpathSync(repoRoot);
  const lockBytes = readFileSync(join(root, "pnpm-lock.yaml"));
  const lock = tool("yaml", root).parse(lockBytes.toString("utf8"));
  const parseSpdx = tool("spdx-expression-parse", root);
  if (String(lock.lockfileVersion) !== "9.0" && String(lock.lockfileVersion) !== "9") {
    throw new Error(`Unsupported pnpm lockfile version: ${lock.lockfileVersion}`);
  }
  if (!lock.importers || !lock.packages || !lock.snapshots) throw new Error("Incomplete pnpm lockfile");
  const components = new Map();
  const notices = new Map();
  const seen = new Set();
  const errors = new Set();
  const lockHash = sha256(lockBytes);
  const supplements = new Map();
  const supplementalComponents = [];
  const supplementalRoot = join(root, "scripts/licenses");
  for (const filename of ["bundled-npm-supplements.json", "plotly-supplement.json", "npm-missing-supplement.json"]) {
    const path = join(supplementalRoot, filename);
    if (!existsSync(path)) continue;
    const document = json(path);
    if (document.schemaVersion !== 1 || !document.packages) throw new Error(`Invalid npm supplement: ${filename}`);
    for (const [name, supplement] of Object.entries(document.packages)) {
      if (supplements.has(name)) throw new Error(`Duplicate npm supplement: ${name}`);
      supplements.set(name, supplement);
    }
  }

  function supplementalEvidence(name, dir) {
    const supplement = supplements.get(name);
    if (!supplement) return { covers: [], files: {} };
    if (!supplement.files || !Object.keys(supplement.files).length || !supplement.notices?.length || !Array.isArray(supplement.covers)) {
      throw new Error(`${name}: supplement needs bound files, notices and coverage`);
    }
    for (const [file, expected] of Object.entries(supplement.files)) {
      const path = resolve(dir, file);
      if (!inside(dir, path) || !inside(dir, realpathSync(path)) || !/^[a-f0-9]{64}$/.test(expected) || sha256(readFileSync(path)) !== expected) {
        throw new Error(`${name}: supplemental input digest mismatch or unsafe path: ${file}`);
      }
    }
    for (const entry of supplement.notices) {
      const path = resolve(supplementalRoot, entry.path);
      if (!inside(supplementalRoot, path) || !inside(supplementalRoot, realpathSync(path))) throw new Error(`${name}: unsafe supplemental notice path`);
      const bytes = readFileSync(path);
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (!text.trim() || !/^[a-f0-9]{64}$/.test(entry.sha256) || sha256(bytes) !== entry.sha256 || !/^https:\/\//.test(entry.source)) {
        throw new Error(`${name}: invalid supplemental notice text, digest or source: ${entry.path}`);
      }
      notices.set(`${name}/supplement/${entry.path}`, { name, path: `supplement/${entry.path} (${entry.source})`, text, sha256: entry.sha256 });
    }
    for (const component of supplement.components || []) {
      if (component.type !== "library" || !component.name || !component.version || !component.purl?.startsWith("pkg:") || component["bom-ref"] !== component.purl || component.licenses?.length !== 1) {
        throw new Error(`${name}: invalid supplemental CycloneDX component`);
      }
      if (/UNLICENSED|LicenseRef-|DocumentRef-/i.test(component.licenses[0].expression)) throw new Error(`${name}: unknown supplemental license expression`);
      parseSpdx(component.licenses[0].expression);
      supplementalComponents.push({ ...component, properties: [...(component.properties || []), { name: "nteract:attribution:scope", value: scope }, { name: "nteract:attribution:supplement-for", value: name }, { name: "nteract:attribution:inventory", value: "conservative reviewed upstream supplement; not exact bundled module inventory" }] });
    }
    if (supplement.licenseExpression) {
      if (!supplement.files["package.json"]) throw new Error(`${name}: license correction must bind package.json`);
      parseSpdx(supplement.licenseExpression);
    }
    return supplement;
  }

  function addEvidence(name, dir, firstParty) {
    const found = evidence(dir);
    // Notebook imports katex/dist/katex.min.css. This exact source-only font
    // input is not referenced by that CSS or copied into notebook assets.
    const fonts = name === "katex@0.16.38"
      ? found.fonts.filter((file) => file !== "src/fonts/lib/Extra.otf")
      : found.fonts;
    const supplement = firstParty ? { covers: [], files: {} } : supplementalEvidence(name, dir);
    for (const entry of found.texts) notices.set(`${name}/${entry.path}/${entry.sha256}`, { name, ...entry });
    if (!firstParty && !supplement.covers.includes("full-license") && !found.texts.some((entry) => entry.kind === "file" && /licen[cs]e|copying|ofl/i.test(entry.path))) {
      errors.add(`${name}: missing full LICENSE/COPYING text (license metadata or a NOTICE alone is insufficient)`);
    }
    if (!firstParty && found.native.length && !(supplement.covers.includes("native") && found.native.every((file) => supplement.files[file]))) {
      errors.add(`${name}: unreviewed native/embedded payloads (${found.native.slice(0, 3).join(", ")}); npm metadata does not attribute embedded native libraries`);
    }
    if (!firstParty && fonts.length && !(supplement.covers.includes("fonts") && fonts.every((file) => supplement.files[file]))) {
      errors.add(`${name}: unreviewed font payloads (${fonts.length}); require full font licenses, copyright/reserved-name declarations, and digest-bound provenance (KaTeX fonts use OFL-1.1, not the package MIT license)`);
    }
    if (/^plotly\.js-dist(?:-min)?@/.test(name) && !(supplement.covers.includes("upstream-bundle") && (supplement.files["plotly.min.js"] || supplement.files["plotly.js"]))) {
      errors.add(`${name}: opaque upstream JavaScript bundle; bundled notices are retained but do not supply complete embedded dependency licenses/versions. Require a reviewed digest-bound upstream inventory and full license texts`);
    }
    if (/^vega-lite@/.test(name) && !(supplement.covers.includes("vendored") && supplement.files["build/index.js"])) {
      errors.add(`${name}: vendored fast-deep-equal and fast-json-stable-stringify require reviewed supplemental full license texts bound to build/index.js`);
    }
    return { ...found, supplement };
  }

  function visitImporter(id) {
    const key = `workspace:${id}`;
    if (seen.has(key)) return;
    seen.add(key);
    const importer = lock.importers[id];
    if (!importer) throw new Error(`Workspace missing from pnpm-lock.yaml: ${id}`);
    const dir = resolve(root, id);
    if (!inside(root, dir)) throw new Error(`Workspace escapes repository: ${id}`);
    const manifest = json(join(dir, "package.json"));
    if (id !== ".") addEvidence(manifest.name || id, dir, true);
    for (const name of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies }).sort(compare)) {
      if (!importer.dependencies?.[name] && !importer.optionalDependencies?.[name]) {
        throw new Error(`${id}: declared production dependency ${name} missing from lockfile`);
      }
    }
    const deps = { ...importer.dependencies, ...importer.optionalDependencies };
    // These development declarations are shipped assets, not build tools.
    // Bokeh's renderer loads notebook-provided resources, not @bokeh/bokehjs.
    // Add that root here if the renderer starts embedding the npm package.
    const shipped = id === "apps/notebook" ? ["tw-animate-css"] : id === "packages/sift" ? ["@nteract/odometer"] : [];
    for (const name of shipped) {
      if (manifest.devDependencies?.[name]) {
        if (!importer.devDependencies?.[name]) throw new Error(`${id}: shipped dependency ${name} missing from lockfile`);
        deps[name] = importer.devDependencies[name];
      }
    }
    for (const [name, entry] of Object.entries(deps).sort(([a], [b]) => compare(a, b))) {
      visitDependency(dir, name, entry.version);
    }
  }

  function visitDependency(owner, alias, reference) {
    if (typeof reference !== "string") throw new Error(`Invalid lock reference for ${alias}`);
    const dir = installedPackage(root, owner, alias);
    if (reference.startsWith("link:")) {
      const expected = realpathSync(resolve(owner, reference.slice(5)));
      if (dir !== expected) throw new Error(`Workspace link mismatch for ${alias}`);
      visitImporter(slash(relative(root, dir)) || ".");
      return;
    }
    const snapshotKey = lock.snapshots[`${alias}@${reference}`] ? `${alias}@${reference}` : reference;
    const snapshot = lock.snapshots[snapshotKey];
    const packageKey = snapshotKey.replace(/\(.*/, "");
    const locked = lock.packages[packageKey];
    if (!snapshot || !locked) throw new Error(`Unresolved locked dependency ${alias}@${reference}`);
    const manifest = json(join(dir, "package.json"));
    if (`${manifest.name}@${manifest.version}` !== packageKey) {
      throw new Error(`Installed/locked version mismatch: expected ${packageKey}, found ${manifest.name}@${manifest.version}`);
    }
    const key = `${snapshotKey}:${dir}`;
    if (seen.has(key)) return;
    seen.add(key);
    const name = manifest.name;
    const version = manifest.version;
    const found = addEvidence(packageKey, dir, false);
    const expression = found.supplement.licenseExpression ?? (typeof manifest.license === "object" ? manifest.license?.type : manifest.license)
      ?? (manifest.licenses?.length === 1 ? manifest.licenses[0]?.type : undefined);
    try {
      if (typeof expression !== "string" || /UNLICENSED|LicenseRef-|DocumentRef-/i.test(expression)) throw new Error("missing/unknown license");
      parseSpdx(expression);
    } catch {
      errors.add(`${packageKey}: missing or invalid SPDX license expression: ${JSON.stringify(expression)}`);
    }
    const purl = `pkg:npm/${name.split("/").map(encodeURIComponent).join("/")}@${encodeURIComponent(version)}`;
    const integrity = locked.resolution?.integrity;
    if (typeof integrity !== "string" || !/^(sha512|sha384|sha256|sha1)-[A-Za-z0-9+/]+=*$/.test(integrity)) throw new Error(`${packageKey}: missing or invalid locked source integrity`);
    const previous = components.get(purl);
    if (previous && previous.licenses[0].expression !== expression) throw new Error(`${packageKey}: inconsistent installed license metadata`);
    const properties = [
      { name: "nteract:attribution:scope", value: scope },
      { name: "nteract:attribution:inventory", value: "overapproximation; not exact bundled module inventory" },
      { name: "nteract:attribution:lockfile", value: "pnpm-lock.yaml" },
      { name: "nteract:attribution:lockfile-sha256", value: lockHash },
      { name: "nteract:attribution:lock-key", value: packageKey },
      { name: "nteract:attribution:source-integrity", value: integrity },
      { name: "nteract:attribution:integrity-verification", value: "lockfile provenance; installed tarball bytes not reverified" },
    ];
    const evidenceProperties = found.texts.map((entry) => ({ name: `nteract:attribution:text-sha256:${entry.path}`, value: entry.sha256 }));
    const supplementProperties = Object.entries(found.supplement.files).map(([file, hash]) => ({ name: `nteract:attribution:supplement-input-sha256:${file}`, value: hash }));
    for (const entry of found.supplement.notices || []) {
      supplementProperties.push({ name: `nteract:attribution:supplement-notice-sha256:${entry.path}`, value: entry.sha256 }, { name: `nteract:attribution:supplement-source:${entry.path}`, value: entry.source });
    }
    const merged = new Map([...(previous?.properties || []), ...properties, ...evidenceProperties, ...supplementProperties].map((item) => [`${item.name}\0${item.value}`, item]));
    components.set(purl, { type: "library", name, version, "bom-ref": purl, purl, licenses: [{ expression }], properties: [...merged.values()].sort((a, b) => compare(a.name, b.name) || compare(a.value, b.value)) });
    const deps = { ...snapshot.dependencies, ...snapshot.optionalDependencies };
    for (const dependency of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies })) {
      if (!deps[dependency]) throw new Error(`${packageKey}: declared dependency ${dependency} missing from lock snapshot`);
    }
    for (const [dependency, ref] of Object.entries(deps).sort(([a], [b]) => compare(a, b))) visitDependency(dir, dependency, ref);
  }

  for (const id of [".", "apps/notebook", "packages/sift"]) visitImporter(id);
  if (errors.size) throw new Error(`Incomplete npm attribution:\n${[...errors].sort(compare).map((error) => `- ${error}`).join("\n")}`);
  for (const component of supplementalComponents) {
    const previous = components.get(component.purl);
    if (previous && previous.licenses[0].expression !== component.licenses[0].expression) throw new Error(`${component.purl}: inconsistent supplemental license expression`);
    const merged = new Map([...(previous?.properties || []), ...component.properties].map((item) => [`${item.name}\0${item.value}`, item]));
    components.set(component.purl, { ...(previous || component), properties: [...merged.values()].sort((a, b) => compare(a.name, b.name) || compare(a.value, b.value)) });
  }
  const ordered = [...notices.values()].sort((a, b) => compare(a.name, b.name) || compare(a.path, b.path) || compare(a.sha256, b.sha256));
  return {
    components: [...components.values()].sort((a, b) => compare(a.purl, b.purl)),
    notices: [
      "# Notebook and renderer npm notices",
      "",
      "Conservative overapproximation of the locked, installed production dependency closure, including resolved peers/optional dependencies and explicit shipped development dependencies. Not an exact bundled module inventory.",
      "Workspace packages are first-party; their production dependencies and vendored notices are included. Rust/WASM, native embedded libraries, operating-system components, dynamically loaded notebook content, and build artifact provenance require separate attribution and verification.",
      `Lockfile: pnpm-lock.yaml (SHA-256 ${lockHash}). Source integrity values describe locked archives, not a rehash of installed files.`,
      "",
      ...ordered.flatMap((entry) => [`## ${entry.name} / ${entry.path}`, `SHA-256: ${entry.sha256}`, "", entry.text, ""]),
    ].join("\n"),
  };
}
