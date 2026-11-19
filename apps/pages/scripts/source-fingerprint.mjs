import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { RECORD_STORAGE_MODES, PLAIN_STORAGE_FORMATS } from "../shared/record-storage.mjs";
import { OUTPUT_FRAME_PATH, OUTPUT_FRAME_PATHS } from "../shared/output-frame-paths.mjs";

const excluded = new Set([
  ".output-dist",
  ".wrangler",
  "dist",
  "node_modules",
  "upstream",
  ".source-cache",
  "test-results",
  "playwright-report",
  ".celld",
  ".git",
]);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const repository = (app) =>
  execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: app, encoding: "utf8" }).trim();

/** Hash only the Pages app, the pinned upstream setup, and imported local source. */
export function sourceFingerprint(app, { root = repository(app), verifyInstalled = false } = {}) {
  // Install/publish can import the adapter without build dependencies. Only
  // preparation needs TypeScript, resolved from this trusted checkout.
  const ts = createRequire(import.meta.url)("typescript");
  app = path.resolve(app);
  root = path.resolve(root);
  const inputs = new Set();
  let outputPackageVerified = false;
  const generated = (file) => {
    const relative = path.relative(app, file);
    return (
      !relative.startsWith("..") &&
      !path.isAbsolute(relative) &&
      relative.split(path.sep).some((segment) => excluded.has(segment))
    );
  };
  function add(file) {
    file = path.resolve(file);
    const relative = path.relative(root, file);
    if (relative.startsWith("../") || path.isAbsolute(relative))
      throw new Error("Source input escapes repository");
    if (!lstatSync(file).isFile())
      throw new Error("Source input must be a regular file: " + relative);
    if (inputs.has(file)) return;
    inputs.add(file);
    if (!/\.[cm]?[jt]sx?$/.test(file)) return;
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    function visit(node) {
      const specifier =
        ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
          ? node.moduleSpecifier
          : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
            ? node.arguments[0]
            : undefined;
      if (specifier && ts.isStringLiteralLike(specifier)) {
        const name = specifier.text;
        let base = name.startsWith(".")
          ? path.resolve(path.dirname(file), name)
          : name.startsWith("@cloud/")
            ? path.join(root, "apps/notebook-cloud/src", name.slice(7))
            : name.startsWith("@nteract/output-frame")
              ? path.join(
                  root,
                  "packages/output-frame/src",
                  name.endsWith("/lifecycle")
                    ? "lifecycle.mjs"
                    : name.endsWith("/runtime")
                      ? "runtime.mjs"
                      : "host.mjs",
                )
              : name === "@nteract/local-oidc"
                ? path.join(root, "packages/local-oidc/src/index.ts")
                : name === "@nteract/identity"
                  ? path.join(root, "packages/identity/src/index.ts")
                  : name === "@nteract/session"
                    ? path.join(root, "packages/session/src/index.ts")
                    : undefined;
        // An import into a generated directory, such as the pinned upstream
        // checkout, is not source: setup.mjs and upstream-provenance.json pin it.
        if (base && generated(base)) base = undefined;
        if (base) {
          const resolved = [
            base,
            ...[".ts", ".tsx", ".mjs", ".js", ".jsx"].map((ext) => base + ext),
            path.join(base, "index.ts"),
            path.join(base, "index.js"),
          ].find((candidate) => existsSync(candidate) && lstatSync(candidate).isFile());
          if (!resolved)
            throw new Error(
              "Unresolved source import: " + name + " in " + path.relative(root, file),
            );
          add(resolved);
          if (name.startsWith("@nteract/output-frame")) {
            const packageRoot = path.join(root, "packages/output-frame");
            // Always hash package source, including runtime and CSS. Only builds
            // need its installed copy; artifact preparation has no dependencies.
            if (!outputPackageVerified) {
              outputPackageVerified = true;
              const installed = verifyInstalled
                ? path.dirname(
                    path.dirname(
                      createRequire(path.join(app, "package.json")).resolve(
                        "@nteract/output-frame",
                      ),
                    ),
                  )
                : null;
              const files = [
                "package.json",
                ...readdirSync(path.join(packageRoot, "src")).map((entry) => `src/${entry}`),
              ];
              for (const entry of files) {
                const source = path.join(packageRoot, entry);
                const copy = installed && path.join(installed, entry);
                if (copy && (!existsSync(copy) || !readFileSync(source).equals(readFileSync(copy))))
                  throw new Error(
                    "Installed @nteract/output-frame differs from this checkout. Run npm run setup in apps/pages to refresh it.",
                  );
                add(source);
              }
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  function walk(directory) {
    for (const name of readdirSync(directory).sort()) {
      if (
        excluded.has(name) ||
        name === ".DS_Store" ||
        name.startsWith(".env") ||
        name.startsWith(".dev.vars")
      )
        continue;
      const file = path.join(directory, name),
        stat = lstatSync(file);
      if (stat.isDirectory()) walk(file);
      else if (stat.isFile()) add(file);
      else throw new Error("Symlink/special file in source inputs: " + file);
    }
  }
  walk(app);
  // The walk covers these. Naming them fails the fingerprint when one is missing.
  for (const name of [
    "package.json",
    "package-lock.json",
    "upstream-provenance.json",
    "patch-upstream.mjs",
    "setup.mjs",
    "UPSTREAM.md",
  ])
    add(path.join(app, name));
  for (const name of ["package.json", "pnpm-lock.yaml"])
    if (existsSync(path.join(root, name))) add(path.join(root, name));
  const files = Object.fromEntries(
    [...inputs]
      .map((file) => [
        path.relative(root, file).split(path.sep).join("/"),
        sha256(readFileSync(file)),
      ])
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  return { algorithm: "sha256-paths-and-content-v1", sha256: sha256(JSON.stringify(files)), files };
}

/** `viewerChunks` lists the viewer's hashed chunk files and `viewerAssets` its
 * hashed shell assets (paths in dist). The receipt maps each to the sha256 of
 * its bytes as built; staging copies exactly these files and only when their
 * bytes still match. `releaseFiles` lists every file the release carries
 * except build-receipt.json (see stage-artifacts.mjs `releaseFilesOf`); the
 * receipt's `files` maps each to its sha256, so a staged bundle can be
 * checked file by file without the source tree. `outputFiles` lists the
 * output Worker's files (stage-artifacts.mjs `OUTPUT_WORKER`), certified apart
 * from `files` because only the release package carries them. */
export function writeBuildReceipt(
  app,
  {
    expectedFingerprint,
    viewerChunks = [],
    viewerAssets = [],
    releaseFiles = [],
    outputFiles = [],
    outputFrameBootstrapSha256,
    documentFormats,
  } = {},
) {
  const root = repository(app);
  const fingerprint = sourceFingerprint(app, { root, verifyInstalled: true });
  if (expectedFingerprint && expectedFingerprint !== fingerprint.sha256)
    throw new Error("Source changed during the build; rebuild before validating");
  const certify = (files) =>
    Object.fromEntries(
      [...files].sort().map((file) => [file, sha256(readFileSync(path.join(app, "dist", file)))]),
    );
  const receipt = {
    schema: 1,
    built_at: new Date().toISOString(),
    source_sha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    source_dirty: Boolean(
      execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim(),
    ),
    // Matches the X-Pages-Build header and /health `build` of this bundle.
    build_id: fingerprint.sha256.slice(0, 12),
    // The Page record storage modes this build's Worker opens. Deployment
    // refuses a release whose receipt lacks a mode the target may hold.
    record_storage: [...RECORD_STORAGE_MODES],
    plain_storage_formats: [...PLAIN_STORAGE_FORMATS],
    // The formats of each document type this build reads, by type. Deployment
    // refuses a release that does not read the formats a target's documents
    // are in.
    document_formats: documentFormats,
    viewer_chunks: certify(viewerChunks),
    viewer_assets: certify(viewerAssets),
    files: certify(releaseFiles),
    // The frame paths this build's output Worker serves, and its bundled
    // module. The release package ships that module as output/worker.js.
    output_frame_paths: [...OUTPUT_FRAME_PATHS],
    // The frame path this build's viewer mounts, and the sha256 of the
    // bootstrap script it expects there. An installer compares the script the
    // output host serves with it before switching (deployment/install.mjs).
    output_frame_path: OUTPUT_FRAME_PATH,
    output_frame_bootstrap_sha256: outputFrameBootstrapSha256,
    output_files: certify(outputFiles),
    fingerprint,
  };
  writeFileSync(path.join(app, "dist/build-receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  return receipt;
}
