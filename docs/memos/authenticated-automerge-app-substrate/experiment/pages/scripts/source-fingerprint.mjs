import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const excluded = new Set([
  "dist",
  "node_modules",
  "test-results",
  "playwright-report",
  ".celld",
  ".git",
]);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const repository = (app) =>
  execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: app, encoding: "utf8" }).trim();

/** Hash only the prototype, pinned experiment setup, and imported local source. */
export function sourceFingerprint(app, { root = repository(app) } = {}) {
  app = path.resolve(app);
  root = path.resolve(root);
  const inputs = new Set();
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
            : name === "@nteract/local-oidc"
              ? path.join(root, "packages/local-oidc/src/index.ts")
              : name === "runtimed"
                ? path.join(root, "packages/runtimed/src/scope-capabilities.ts")
                : undefined;
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
  for (const name of [
    "package.json",
    "package-lock.json",
    "upstream-provenance.json",
    "patch-upstream.mjs",
    "setup.mjs",
    "UPSTREAM.md",
  ])
    add(path.join(app, "..", name));
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

export function writeBuildReceipt(app, { expectedFingerprint } = {}) {
  const root = repository(app);
  const fingerprint = sourceFingerprint(app, { root });
  if (expectedFingerprint && expectedFingerprint !== fingerprint.sha256)
    throw new Error("Source changed during the build; rebuild before validating");
  const receipt = {
    schema: 1,
    built_at: new Date().toISOString(),
    source_sha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    source_dirty: Boolean(
      execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim(),
    ),
    // Matches the X-Pages-Build header and /health `build` of this bundle.
    build_id: fingerprint.sha256.slice(0, 12),
    fingerprint,
  };
  writeFileSync(path.join(app, "dist/build-receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  return receipt;
}
