export const controllerAcquisitionCompatibility = "pages-acquire-v1";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { patchUpstream } from "./patch-upstream.mjs";
import { patchWordgard } from "./patch-wordgard.mjs";

export const revision = "afec0444191a5a662e065f24193bef58ab07122a";
export function setup(
  argv = [],
  {
    root = fileURLToPath(new URL(".", import.meta.url)),
    exec = execFileSync,
    fs = {
      cpSync,
      existsSync,
      lstatSync,
      mkdirSync,
      readFileSync,
      writeFileSync,
    },
    patch = patchUpstream,
    patchEditor = patchWordgard,
    chdir = process.chdir,
  } = {},
) {
  const acquireOnly = argv.length === 1 && argv[0] === "--acquire-only";
  if (argv.length && !acquireOnly) throw new Error("Usage: setup.mjs [--acquire-only]");
  const { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } = fs;
  const execFileSync = exec;
  const patchUpstream = patch,
    patchWordgard = patchEditor;
  chdir(root);
  if (acquireOnly) {
    if (!existsSync("package-lock.json") || !lstatSync("package-lock.json").isFile())
      throw new Error("Acquisition requires a regular committed package-lock.json");
    const committed = execFileSync("git", ["show", "HEAD:./package-lock.json"]);
    if (!Buffer.from(committed).equals(readFileSync("package-lock.json")))
      throw new Error("Acquisition lockfile must match HEAD");
  }
  const source = `${root}.source-cache`;
  {
    mkdirSync(source, { recursive: true });
    if (!existsSync(`${source}/.git`)) execFileSync("git", ["init", source]);
    execFileSync(
      "git",
      [
        "-C",
        source,
        "fetch",
        "--depth=1",
        "https://github.com/automerge/automerge-repo.git",
        revision,
      ],
      { stdio: "inherit" },
    );
    execFileSync("git", ["-C", source, "checkout", "--detach", "FETCH_HEAD"], {
      stdio: "inherit",
    });
    const actual = execFileSync("git", ["-C", source, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    if (actual !== revision) throw new Error(`Unexpected upstream revision ${actual}`);
    if (
      execFileSync("git", ["-C", source, "status", "--porcelain"], {
        encoding: "utf8",
      }).trim()
    )
      throw new Error("Upstream source cache has local changes; refusing to overwrite them");
  }
  mkdirSync("upstream/packages", { recursive: true });
  for (const name of ["automerge-repo"]) {
    cpSync(`${source}/packages/${name}`, `upstream/packages/${name}`, {
      recursive: true,
    });
    const path = `upstream/packages/${name}/package.json`;
    const pkg = JSON.parse(readFileSync(path));
    delete pkg.devDependencies;
    const catalog = {
      "@automerge/automerge": "3.5.0",
      "cbor-x": "1.6.4",
      debug: "4.4.3",
      eventemitter3: "5.0.4",
      uuid: "14.0.1",
    };
    for (const [key, value] of Object.entries(pkg.dependencies)) {
      if (value === "catalog:") pkg.dependencies[key] = catalog[key];
      if (value === "workspace:*") pkg.dependencies[key] = "3.0.0-experimental.1";
    }
    writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
  }
  for (const name of ["tsconfig.base.json", "tsconfig.lib.json", "LICENSE"])
    cpSync(`${source}/${name}`, `upstream/${name}`);
  const upstreamPatch = patchUpstream("upstream");
  writeFileSync(
    "upstream-provenance.json",
    `${JSON.stringify({ repository: "https://github.com/automerge/automerge-repo", revision, automerge: "3.5.0", patch: upstreamPatch }, null, 2)}\n`,
  );
  execFileSync(
    "npm",
    [
      acquireOnly || existsSync("package-lock.json") ? "ci" : "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ],
    { stdio: "inherit" },
  );
  patchWordgard("node_modules/wordgard");
  if (!acquireOnly) execFileSync("npm", ["run", "build:upstream"], { stdio: "inherit" });
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)
  setup(process.argv.slice(2));
