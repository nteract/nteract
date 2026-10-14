import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {test} from "node:test";

const action = readFileSync(new URL("../../.github/actions/install-cargo-about/action.yml", import.meta.url), "utf8");
const workflow = readFileSync(new URL("../../.github/workflows/publish-npm.yml", import.meta.url), "utf8");

// Execute the actual YAML run blocks, including the publisher's inline copies
// that must work when the release checkout predates the composite action.
function installerPrograms(yaml) {
  const lines = yaml.replace(/\r\n/g, "\n").split("\n");
  const programs = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== "- name: Install cargo-about") continue;
    const stepIndent = lines[i].search(/\S/);
    while (++i < lines.length && !/^\s+run: \|$/.test(lines[i])) {
      assert.ok(lines[i].search(/\S/) > stepIndent, "installer must have a multiline run block");
    }
    assert.ok(i < lines.length, "installer run block missing");
    const indent = lines[i].search(/\S/) + 2;
    const body = [];
    while (++i < lines.length && (lines[i].trim() === "" || lines[i].search(/\S/) >= indent)) {
      body.push(lines[i].slice(indent));
    }
    programs.push(body.join("\n"));
    i--;
  }
  return programs;
}

const programs = [...installerPrograms(action), ...installerPrograms(workflow)];

test("build and both release pack jobs install and verify cargo-about consistently", () => {
  assert.equal(programs.length, 3);
  for (const program of programs) assert.equal(program.trim(), programs[0].trim());
  assert.match(action, /CARGO_ABOUT_VERSION: \$\{\{ inputs\.version \}\}/);
  assert.equal((workflow.match(/CARGO_ABOUT_VERSION: "0\.9\.2"/g) ?? []).length, 2);
});

function runInstaller(t, program, scenario) {
  const dir = mkdtempSync(join(tmpdir(), "cargo-about-installer-"));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const cargo = join(dir, "cargo");
  writeFileSync(cargo, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const root = process.env.CARGO_ABOUT_TEST_ROOT;
const scenario = process.env.CARGO_ABOUT_TEST_SCENARIO;
fs.appendFileSync(root + "/calls.jsonl", JSON.stringify(args) + "\\n");
if (args[0] === "binstall") {
  if (scenario.startsWith("fallback") || scenario === "both-fail") process.exit(1);
  if (scenario !== "missing") fs.writeFileSync(root + "/installed", "binary");
} else if (args[0] === "install") {
  if (scenario === "both-fail") process.exit(1);
  // Reproduce cargo-about 0.9.2: source install may succeed without a binary
  // unless its non-default cli feature is requested.
  const features = args[args.indexOf("--features") + 1];
  if (features?.split(",").includes("cli") && scenario !== "fallback-missing") {
    fs.writeFileSync(root + "/installed", "source");
  }
} else if (args[0] === "about" && args[1] === "--version") {
  if (!fs.existsSync(root + "/installed") || scenario === "broken") process.exit(1);
  console.log("cargo-about " + (scenario === "wrong-version" ? "0.8.0" : process.env.CARGO_ABOUT_VERSION));
} else process.exit(2);
`);
  chmodSync(cargo, 0o755);
  const result = spawnSync("bash", ["-c", program], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      CARGO_ABOUT_VERSION: "0.9.2",
      CARGO_ABOUT_TEST_ROOT: dir,
      CARGO_ABOUT_TEST_SCENARIO: scenario,
    },
  });
  assert.ifError(result.error);
  const calls = readFileSync(join(dir, "calls.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  return {...result, calls};
}

for (const [index, program] of programs.entries()) {
  const label = ["composite action", "pack-sift", "pack-sift-csv"][index];

  test(`${label}: prebuilt success verifies the executable without compiling`, t => {
    const result = runInstaller(t, program, "binary");
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.calls, [
      ["binstall", "cargo-about", "--version", "=0.9.2", "--no-confirm", "--locked", "--force", "--disable-strategies", "compile"],
      ["about", "--version"],
    ]);
    assert.match(result.stdout, /cargo-about 0\.9\.2/);
  });

  test(`${label}: unavailable prebuilt binary builds the pinned CLI and verifies it`, t => {
    const result = runInstaller(t, program, "fallback");
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.calls[1], ["install", "cargo-about", "--version", "=0.9.2", "--locked", "--force", "--features", "cli", "--bin", "cargo-about"]);
    assert.deepEqual(result.calls[2], ["about", "--version"]);
    assert.match(result.stdout, /cargo-about 0\.9\.2/);
  });

  for (const scenario of ["both-fail", "missing", "fallback-missing", "wrong-version", "broken"]) {
    test(`${label}: ${scenario} fails the install step`, t => {
      const result = runInstaller(t, program, scenario);
      assert.notEqual(result.status, 0, result.stdout);
      if (scenario === "both-fail") assert.equal(result.calls.length, 2);
      else assert.deepEqual(result.calls.at(-1), ["about", "--version"]);
    });
  }
}
