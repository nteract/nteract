// Runs scripts/worktree-setup.sh against a scratch repository whose worktree
// starts with Git LFS pointer files. Every case stays offline: the scratch
// repository has no remote, so content can only come from its local LFS store.
//
//   node --test scripts/tests/worktree-setup.test.mjs

import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {after, before, test} from "node:test";
import {fileURLToPath} from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "worktree-setup.sh");
const POINTER_PREFIX = "version https://git-lfs.github.com/spec/";
const CONTENT = "real content\n";

const hasLfs = spawnSync("git", ["lfs", "version"]).status === 0;
const skip = hasLfs ? false : "git-lfs is not installed";

let scratch;
let repo;
let worktreeCount = 0;

function git(cwd, args, env = {}) {
  const result = spawnSync("git", args, {cwd, encoding: "utf8", env: {...process.env, ...env}});
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

// A new worktree checked out without the LFS smudge filter, the state the
// setup script exists to repair.
function coldWorktree() {
  const path = join(scratch, `wt-${++worktreeCount}`);
  git(repo, ["worktree", "add", "--detach", path, "HEAD"], {GIT_LFS_SKIP_SMUDGE: "1"});
  return path;
}

function setup(args, {input, env = {}} = {}) {
  return spawnSync(SCRIPT, args, {encoding: "utf8", input, env: {...process.env, ...env}});
}

const isPointer = file => readFileSync(file, "utf8").startsWith(POINTER_PREFIX);

before(() => {
  if (!hasLfs) return;
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "worktree-setup-")));
  repo = join(scratch, "repo");
  git(scratch, ["init", "--quiet", "--initial-branch=main", repo]);
  git(repo, ["lfs", "install", "--local"]);
  git(repo, ["config", "user.name", "test"]);
  git(repo, ["config", "user.email", "test@example.invalid"]);
  writeFileSync(join(repo, ".gitattributes"), "*.bin filter=lfs diff=lfs merge=lfs -text\n");
  writeFileSync(join(repo, "a.bin"), CONTENT);
  writeFileSync(join(repo, "b.bin"), CONTENT.repeat(2));
  git(repo, ["add", "."]);
  git(repo, ["commit", "--quiet", "-m", "fixture"]);
});

after(() => {
  if (scratch) rmSync(scratch, {recursive: true, force: true});
});

test("a cold worktree starts with pointer files", {skip}, () => {
  const worktree = coldWorktree();
  assert.ok(isPointer(join(worktree, "a.bin")));
  assert.ok(isPointer(join(worktree, "b.bin")));
});

test("direct mode hydrates from the local store and reports on stderr only", {skip}, () => {
  const worktree = coldWorktree();
  const result = setup([worktree]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /hydrated 2 LFS files from the local store/);
  assert.equal(readFileSync(join(worktree, "a.bin"), "utf8"), CONTENT);
  assert.equal(git(worktree, ["status", "--porcelain"]), "");
});

test("a second run finds nothing to do", {skip}, () => {
  const worktree = coldWorktree();
  setup([worktree]);
  const result = setup([worktree]);
  assert.equal(result.status, 0);
  assert.match(result.stderr, /already hydrated/);
});

test("hook mode reads cwd from stdin, hydrates, and prints nothing", {skip}, () => {
  const worktree = coldWorktree();
  const result = setup(["--hook"], {input: JSON.stringify({cwd: worktree})});
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  assert.ok(!isPointer(join(worktree, "a.bin")));
});

test("a locally edited LFS file is left alone", {skip}, () => {
  const worktree = coldWorktree();
  writeFileSync(join(worktree, "a.bin"), "local edit\n");
  const result = setup([worktree]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(worktree, "a.bin"), "utf8"), "local edit\n");
  assert.ok(!isPointer(join(worktree, "b.bin")));
});

test("objects missing from the store fail direct mode and name the files", {skip}, () => {
  const worktree = coldWorktree();
  const emptyStore = mkdtempSync(join(scratch, "empty-store-"));
  const env = {GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "lfs.storage", GIT_CONFIG_VALUE_0: emptyStore};

  const direct = setup([worktree], {env});
  assert.equal(direct.status, 1);
  assert.equal(direct.stdout, "");
  assert.match(direct.stderr, /2 LFS files are still pointers/);
  assert.match(direct.stderr, /a\.bin/);

  const hook = setup(["--hook"], {input: JSON.stringify({cwd: worktree}), env});
  assert.equal(hook.status, 0);
  assert.equal(hook.stdout + hook.stderr, "");
  assert.ok(isPointer(join(worktree, "a.bin")));
});

test("a directory outside git fails direct mode and passes hook mode", {skip}, () => {
  const outside = mkdtempSync(join(tmpdir(), "worktree-setup-outside-"));
  try {
    assert.equal(setup([outside]).status, 1);
    assert.equal(setup(["--hook"], {input: JSON.stringify({cwd: outside})}).status, 0);
    assert.equal(setup(["--hook"], {input: "{}"}).status, 0);
  } finally {
    rmSync(outside, {recursive: true, force: true});
  }
});
