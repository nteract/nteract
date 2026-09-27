import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {test} from "node:test";

function workflow(name) {
  return readFileSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), "utf8");
}

// Like the preview workflow contract tests, require the current plain job-ID
// layout. Layout changes must update the contract instead of silently passing.
const release = workflow("release-common");
const jobs = new Map();
let current;
for (const line of release.split("\njobs:\n")[1].split("\n")) {
  const start = /^  ([a-z][a-z0-9_-]*):$/.exec(line);
  if (start) {
    current = start[1];
    assert.ok(!jobs.has(current), "duplicate workflow job");
    jobs.set(current, "");
  } else if (current) jobs.set(current, `${jobs.get(current)}${line}\n`);
}

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
    "build-notebook-linux-x64",
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
