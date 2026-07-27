/**
 * Share this worktree's Rust build with the root repo so quick UI changes never
 * pay a cold `cargo build`.
 *
 * Why: run-browser-e2e.mjs needs `target/debug/runt`, and the dev daemon needs
 * `target/debug/runtimed` — both built by `cargo build`. A fresh worktree has an
 * empty `target/`, so that first build is a full cold compile (minutes). Point
 * this worktree's `target/` at the root repo's warm one and the build becomes a
 * ~0.5s no-op: the frontend still hot-reloads via Vite, so UI work rebuilds no
 * Rust at all.
 *
 * SAFETY — UI-only worktrees. cargo file-locks the target dir, so concurrent
 * builds serialize (no corruption). The real hazard is fingerprint churn: if
 * THIS worktree's Rust source differs from the root's, building here recompiles
 * those crates into the shared target and forces the root/backend dev to rebuild
 * on their next `cargo build`. So only link a worktree whose Rust matches main
 * (i.e. you're doing UI/TypeScript work). For a branch that changes Rust, keep
 * an independent target.
 *
 * Usage:
 *   node e2e/link-build.mjs           # link this worktree's target/ -> root
 *   node e2e/link-build.mjs --force   # replace an existing real target/ dir
 *   node e2e/link-build.mjs --unlink  # restore an independent (empty) target/
 *   node e2e/link-build.mjs --status  # report current linkage
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const worktreeRoot = path.resolve(appRoot, "../..");
const worktreeTarget = path.join(worktreeRoot, "target");

const flags = new Set(process.argv.slice(2));

function rootRepo() {
  // The main worktree is the parent of the shared (common) git dir.
  const commonDir = execFileSync(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    { cwd: worktreeRoot, encoding: "utf8" },
  ).trim();
  return path.dirname(commonDir);
}

function describeTarget() {
  if (fs.existsSync(worktreeTarget) && fs.lstatSync(worktreeTarget).isSymbolicLink()) {
    return { kind: "symlink", to: fs.readlinkSync(worktreeTarget) };
  }
  if (fs.existsSync(worktreeTarget)) return { kind: "dir" };
  return { kind: "absent" };
}

function status() {
  const t = describeTarget();
  if (t.kind === "symlink") console.log(`target/ -> ${t.to} (linked)`);
  else if (t.kind === "dir") console.log("target/ is an independent directory (not linked)");
  else console.log("target/ is absent");
}

if (flags.has("--status")) {
  status();
  process.exit(0);
}

if (flags.has("--unlink")) {
  const t = describeTarget();
  if (t.kind !== "symlink") {
    console.log("target/ is not a symlink — nothing to unlink.");
    process.exit(0);
  }
  fs.unlinkSync(worktreeTarget);
  fs.mkdirSync(worktreeTarget, { recursive: true });
  console.log("Restored an independent (empty) target/. Next build is a cold compile.");
  process.exit(0);
}

const root = rootRepo();
const rootTarget = path.join(root, "target");

if (path.resolve(root) === path.resolve(worktreeRoot)) {
  console.error("This IS the root repo — nothing to link to. Run from a worktree.");
  process.exit(1);
}
if (!fs.existsSync(rootTarget)) {
  console.error(`Root target not found: ${rootTarget}`);
  console.error("Build once in the root repo first (e.g. `cargo build -p runtimed -p runt`).");
  process.exit(1);
}

const current = describeTarget();
if (current.kind === "symlink") {
  if (path.resolve(current.to) === path.resolve(rootTarget)) {
    console.log(`Already linked: target/ -> ${current.to}`);
    process.exit(0);
  }
  fs.unlinkSync(worktreeTarget); // repoint an existing symlink
} else if (current.kind === "dir") {
  if (!flags.has("--force")) {
    const size = (() => {
      try {
        return execFileSync("du", ["-sh", worktreeTarget], { encoding: "utf8" }).split("\t")[0];
      } catch {
        return "?";
      }
    })();
    console.error(`target/ is an existing directory (${size.trim()}).`);
    console.error("Re-run with --force to delete it and link to the root's target instead.");
    console.error("(Only do this on a UI-only worktree — see the header of this file.)");
    process.exit(1);
  }
  fs.rmSync(worktreeTarget, { recursive: true, force: true });
}

fs.symlinkSync(rootTarget, worktreeTarget, "dir");
console.log(`Linked: target/ -> ${rootTarget}`);
console.log("Quick UI changes now skip the cold build. Use --unlink to undo.");
console.log("Reminder: keep this worktree's Rust in sync with main, or the backend dev rebuilds.");
