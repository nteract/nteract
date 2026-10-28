import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { patchUpstream } from "./patch-upstream.mjs";
import { subductionRelease, pinSubductionDependency } from "./native-version.mjs";

export const revision = "afec0444191a5a662e065f24193bef58ab07122a";
const root = fileURLToPath(new URL(".", import.meta.url));
process.chdir(root);
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
  execFileSync("git", ["-C", source, "checkout", "--detach", "FETCH_HEAD"], { stdio: "inherit" });
  const actual = execFileSync("git", ["-C", source, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  if (actual !== revision) throw new Error(`Unexpected upstream revision ${actual}`);
  if (execFileSync("git", ["-C", source, "status", "--porcelain"], { encoding: "utf8" }).trim())
    throw new Error("Upstream source cache has local changes; refusing to overwrite them");
}
mkdirSync("upstream/packages", { recursive: true });
for (const name of ["automerge-repo", "automerge-repo-subduction"]) {
  cpSync(`${source}/packages/${name}`, `upstream/packages/${name}`, { recursive: true });
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
  pinSubductionDependency(pkg);
  writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
}
for (const name of ["tsconfig.base.json", "tsconfig.lib.json", "LICENSE"])
  cpSync(`${source}/${name}`, `upstream/${name}`);
const patch = patchUpstream("upstream");
writeFileSync(
  "upstream-provenance.json",
  `${JSON.stringify({ repository: "https://github.com/automerge/automerge-repo", revision, subduction: subductionRelease.version, nativeRelease: subductionRelease, automerge: "3.5.0", patch }, null, 2)}\n`,
);
execFileSync(
  "npm",
  [
    existsSync("package-lock.json") ? "ci" : "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
  ],
  { stdio: "inherit" },
);
execFileSync("npm", ["run", "build"], { stdio: "inherit" });
