import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {readFileSync} from "node:fs";
import {test} from "node:test";
import {fileURLToPath} from "node:url";

function workflow(name) {
  return readFileSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), "utf8");
}

// Like the preview workflow contract tests, require the current plain job-ID
// layout. Layout changes must update the contract instead of silently passing.
function workflowJobs(source) {
  const parsed = new Map();
  let current;
  for (const line of source.split("\njobs:\n")[1].split("\n")) {
    const start = /^  ([a-z][a-z0-9_-]*):$/.exec(line);
    if (start) {
      current = start[1];
      assert.ok(!parsed.has(current), "duplicate workflow job");
      parsed.set(current, "");
    } else if (current) parsed.set(current, `${parsed.get(current)}${line}\n`);
  }
  return parsed;
}

const release = workflow("release-common");
const jobs = workflowJobs(release);
const validation = workflow("release-validation");
const validationJobs = workflowJobs(validation);

function needs(id) {
  const body = jobs.get(id);
  assert.ok(body, `missing job ${id}`);
  const field = /^    needs:\s*(\[[\s\S]*?\])\s*$/m.exec(body)?.[1];
  assert.ok(field, `${id} must declare a literal needs list`);
  return field.slice(1, -1).split(",").map(value => value.trim()).filter(Boolean);
}

test("plugin publication waits for a successful release and remains optional", () => {
  const plugin = jobs.get("publish-plugin");
  assert.deepEqual(needs("publish-plugin").sort(), ["compute-version", "prerelease"]);
  // With no status-function override, GitHub requires successful dependencies.
  assert.match(plugin, /^    if: inputs\.publish_plugin_channel != ''$/m);
  assert.doesNotMatch(plugin, /^\s+continue-on-error:/m);
  assert.match(release, /      publish_plugin_channel:\n(?:        [^\n]+\n)*        default: ""/);
});

test("release qualification requires all binaries, wheel tests, and the AppImage smoke", () => {
  assert.deepEqual(needs("prerelease").sort(), [
    "build-linux",
    "build-macos",
    "build-notebook-linux",
    "build-notebook-macos-arm64",
    "build-notebook-macos-x64",
    "build-notebook-windows-arm64",
    "build-notebook-windows-x64",
    "build-python-wheels",
    "compute-version",
    "smoke-fedora-appimage",
  ]);
  // In particular, prerelease cannot depend on the optional plugin job.
  for (const id of ["prerelease", ...needs("prerelease")]) {
    assert.doesNotMatch(jobs.get(id), /^    (?:if|continue-on-error):/m, `${id} must fail closed`);
  }
});

test("the final tag check uses the built source and precedes release publication", () => {
  const body = jobs.get("prerelease");
  const check = body.indexOf("      - name: Verify release tag matches built source\n");
  assert.ok(check >= 0);
  const step = body.slice(check).split(/\n      - /)[0];
  assert.match(step, /TAG_NAME: v\$\{\{ needs\.compute-version\.outputs\.version \}\}/);
  assert.match(step, /SOURCE_SHA: \$\{\{ needs\.compute-version\.outputs\.source_sha \}\}/);
  assert.match(step, /run: bash scripts\/ci\/check-release-tag\.sh "\$TAG_NAME" "\$SOURCE_SHA"/);
  assert.doesNotMatch(step, /^\s+(?:if|continue-on-error):/m);
  for (const publication of ["run: uv publish ", "uses: softprops/action-gh-release@", "gh release upload "]) {
    assert.ok(body.indexOf(publication) > check, `${publication} must follow tag verification`);
  }
});

test("stable and nightly keep publishing their own plugin slice", () => {
  const plugin = jobs.get("publish-plugin");
  assert.match(plugin, /--channel "\$\{\{ inputs\.publish_plugin_channel \}\}"/);
  for (const channel of ["stable", "nightly"]) {
    const caller = workflow(`release-${channel}`);
    assert.match(caller, /uses: \.\/\.github\/workflows\/release-common\.yml/);
    assert.match(caller, new RegExp(`^      publish_plugin_channel: "${channel}"$`, "m"));
  }
});

test("Linux releases build, smoke, and publish both x64 and ARM64", () => {
  for (const id of ["build-linux", "build-notebook-linux", "smoke-fedora-appimage"]) {
    const body = jobs.get(id);
    assert.match(body, /^            runner: ubuntu-22\.04$/m, `${id} must build x64 natively`);
    assert.match(body, /^            runner: ubuntu-22\.04-arm$/m, `${id} must build ARM64 natively`);
    assert.match(body, /^      fail-fast: false$/m, `${id} must report both architectures`);
  }
  const wheels = jobs.get("build-python-wheels");
  assert.match(wheels, /runner: ubuntu-24\.04-arm\n\s+target: aarch64-unknown-linux-gnu/);
  assert.match(wheels, /run: python scripts\/ci\/smoke-linux-arm64-wheel\.py python\/runtimed\/dist/);

  const body = jobs.get("prerelease");
  assert.match(body, /"linux-aarch64": \{ signature: \$sig_linux_arm64, url: \$url_linux_arm64 \}/);
  for (const arch of ["x64", "arm64"]) {
    assert.match(body, new RegExp(`require_sig "release-assets/nteract-\\$\\{CHANNEL\\}-linux-${arch}\\.AppImage\\.sig"`));
    for (const asset of ["runt*", "nteract-cli*", "nteract-mcp*"]) {
      assert.ok(body.includes(`./release-assets/${asset}-linux-${arch}\n`), `missing ${asset}-linux-${arch} upload`);
    }
    assert.ok(
      body.includes(`./release-assets/nteract-\${{ inputs.version_suffix }}-linux-${arch}.AppImage\n`),
      `missing linux-${arch} AppImage upload`,
    );
  }
});

// Windows release validation runs on the native runner for each architecture.
const WINDOWS_LEGS = [
  {arch: "arm64", runner: "windows-11-vs2026-arm", target: "aarch64-pc-windows-msvc", npm: "win32-arm64-msvc"},
  {arch: "x64", runner: "windows-latest", target: "x86_64-pc-windows-msvc", npm: "win32-x64-msvc"},
];

function matrixLeg(body, name, fields) {
  const lines = [`          - name: ${name}`, ...Object.entries(fields).map(([key, value]) => `            ${key}: ${value}`)];
  assert.ok(body.includes(`${lines.join("\n")}\n`), `missing matrix leg ${name}`);
}

function stepIndex(body, text) {
  const index = body.indexOf(text);
  assert.ok(index >= 0, `missing step text: ${text}`);
  return index;
}

test("Windows wheel validation builds, audits, and smokes x64 and ARM64 natively", () => {
  const body = validationJobs.get("windows-wheel");
  assert.ok(body, "missing windows-wheel job");
  assert.match(body, /^      fail-fast: false$/m);
  for (const {arch, runner, target} of WINDOWS_LEGS) {
    const name = `Native Windows ${arch === "x64" ? "x64" : "ARM64"} wheel`;
    matrixLeg(body, name, {runner, target, arch});
  }
  assert.match(body, /^          architecture: \$\{\{ matrix\.arch \}\}$/m);
  const audit = stepIndex(body, "run: node scripts/ci/audit-windows-crt-imports.mjs --machine ${{ matrix.arch }} target/${{ matrix.target }}/release/runtimed.exe python/runtimed/dist/*.whl");
  const smoke = stepIndex(body, "python scripts/ci/smoke-windows-wheel.py ${{ matrix.arch }} python/runtimed/dist");
  assert.ok(audit < smoke, "the CRT audit must run before the wheel smoke");
  assert.match(jobs.get("build-python-wheels"), /python scripts\/ci\/smoke-windows-wheel\.py arm64 python\/runtimed\/dist/);
});

test("Windows npm addon validation loads the audited addon in native Node 24 and pinned Bun", () => {
  const body = validationJobs.get("windows-node-addon");
  assert.ok(body, "missing windows-node-addon job");
  assert.match(body, /^      fail-fast: false$/m);
  for (const {arch, runner, npm} of WINDOWS_LEGS) {
    const name = `Native Windows ${arch === "x64" ? "x64" : "ARM64"} npm addon`;
    matrixLeg(body, name, {runner, target: npm, arch});
  }
  assert.match(body, /^          node-version: "24"$/m);
  assert.match(body, /^          bun-version: "1\.4\.1"$/m);
  const addon = '"packages/runtimed-node/npm/${{ matrix.target }}/runtimed-node.${{ matrix.target }}.node"';
  const order = [
    "run: pnpm --dir packages/runtimed-node build",
    'run: pnpm --dir packages/runtimed-node assemble:platform -- --expected-target "${{ matrix.target }}"',
    'run: node scripts/ci/audit-windows-crt-imports.mjs --machine ${{ matrix.arch }} "packages/runtimed-node/npm/${{ matrix.target }}"',
    `run: node scripts/ci/smoke-windows-node-addon.cjs \${{ matrix.arch }} ${addon}`,
    "uses: oven-sh/setup-bun@v2",
    `run: bun scripts/ci/smoke-windows-node-addon.cjs \${{ matrix.arch }} ${addon}`,
  ].map((text) => stepIndex(body, text));
  assert.deepEqual([...order].sort((a, b) => a - b), order, "build, assemble, audit, then Node and Bun loads");
});

test("release validation reruns when the Windows smoke scripts change", () => {
  const paths = validation.split("\n  workflow_dispatch:")[0];
  for (const script of ["smoke-windows-node-addon.cjs", "smoke-windows-wheel.py", "audit-windows-crt-imports.mjs"]) {
    assert.ok(paths.includes(`      - scripts/ci/${script}\n`), `missing path filter for ${script}`);
  }
});

test("Windows smoke scripts reject bad arguments and non-native hosts", () => {
  const script = (name) => fileURLToPath(new URL(`../ci/${name}`, import.meta.url));
  const addon = spawnSync(process.execPath, [script("smoke-windows-node-addon.cjs"), "ia32", "x.node"], {encoding: "utf8"});
  assert.equal(addon.status, 2, addon.stderr);
  assert.match(addon.stderr, /usage:/);
  const wheel = spawnSync("python3", [script("smoke-windows-wheel.py"), "ia32", "dist"], {encoding: "utf8"});
  assert.notEqual(wheel.status, 0);
  assert.match(wheel.stderr, /usage:/);
  if (process.platform !== "win32") {
    const foreign = spawnSync(process.execPath, [script("smoke-windows-node-addon.cjs"), "x64", "x.node"], {encoding: "utf8"});
    assert.notEqual(foreign.status, 0);
    assert.match(foreign.stderr, /expected win32/);
    const foreignWheel = spawnSync("python3", [script("smoke-windows-wheel.py"), "x64", "dist"], {encoding: "utf8"});
    assert.notEqual(foreignWheel.status, 0);
    assert.match(foreignWheel.stderr, /requires native Windows x64 Python/);
  }
});
