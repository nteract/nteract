import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { controllerAcquisitionCompatibility, revision, setup } from "./setup.mjs";

test("symlinked CLI executes setup validation instead of silently succeeding", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "pages-setup-cli-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const link = path.join(directory, "setup.mjs");
  symlinkSync(fileURLToPath(new URL("./setup.mjs", import.meta.url)), link);
  const result = spawnSync(process.execPath, [link, "--unknown"], {
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Usage: setup.mjs/);
});

function fixture({ lock = true, tracked = true, changed = false, regular = true } = {}) {
  const calls = [];
  return {
    calls,
    options: {
      root: "/fixture/",
      chdir() {},
      exec(file, args) {
        calls.push([file, args]);
        if (args[0] === "show") {
          if (!tracked) throw new Error("not in HEAD");
          return Buffer.from(changed ? "different" : "lock");
        }
        if (args.includes("rev-parse")) return revision;
        return "";
      },
      fs: {
        existsSync: (file) => (file === "package-lock.json" ? lock : false),
        lstatSync: () => ({ isFile: () => regular }),
        mkdirSync() {},
        cpSync() {},
        writeFileSync() {},
        readFileSync: (file) =>
          file === "package-lock.json"
            ? Buffer.from("lock")
            : JSON.stringify({
                dependencies: {
                  debug: "catalog:",
                  "@automerge/subduction": "0.23.0",
                },
              }),
      },
      patch: () => {
        calls.push(["patch-upstream"]);
        return {};
      },
      patchEditor: () => {
        calls.push(["patch-wordgard"]);
      },
    },
  };
}

test("acquisition installs from the committed lock without executing the compiler", () => {
  const f = fixture();
  setup(["--acquire-only"], f.options);
  assert.equal(controllerAcquisitionCompatibility, "pages-acquire-v1");
  assert.deepEqual(f.calls[0], ["git", ["show", "HEAD:./package-lock.json"]]);
  assert.deepEqual(
    f.calls.filter(([file]) => file === "npm"),
    [["npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"]]],
  );
  assert.deepEqual(f.calls.at(-1), ["patch-wordgard"]);
  const fetch = f.calls.find(([, args]) => args?.includes("fetch"));
  assert.ok(fetch[1].includes("https://github.com/automerge/automerge-repo.git"));
  assert.equal(fetch[1].at(-1), revision);
});

test("acquisition rejects missing, uncommitted, changed or symlink locks before fetching", () => {
  for (const input of [
    { lock: false },
    { tracked: false },
    { changed: true },
    { regular: false },
  ]) {
    const f = fixture(input);
    assert.throws(() => setup(["--acquire-only"], f.options));
    assert.ok(f.calls.every(([file, args]) => file === "git" && args[0] === "show"));
  }
});

test("normal setup preserves install fallback and compilation; unknown modes refuse", () => {
  for (const lock of [true, false]) {
    const f = fixture({ lock });
    setup([], f.options);
    assert.deepEqual(
      f.calls.filter(([file]) => file === "npm"),
      [
        ["npm", [lock ? "ci" : "install", "--ignore-scripts", "--no-audit", "--no-fund"]],
        ["npm", ["run", "build"]],
      ],
    );
  }
  for (const args of [["--unknown"], ["--acquire-only", "extra"]]) {
    const f = fixture();
    assert.throws(() => setup(args, f.options), /Usage/);
    assert.equal(f.calls.length, 0);
  }
});

test("failed acquisition never runs patching of installed packages or compilation", () => {
  const f = fixture(),
    exec = f.options.exec;
  f.options.exec = (file, args) => {
    if (file === "npm") throw new Error("install failed");
    return exec(file, args);
  };
  assert.throws(() => setup(["--acquire-only"], f.options), /install failed/);
  assert.ok(!f.calls.some(([file]) => file === "patch-wordgard"));
});
