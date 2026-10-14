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

test("macOS runner migration preserves ARM64 hosts and explicit release architectures", () => {
  const build = workflow("build");
  assert.doesNotMatch(build + release, /\bmacos-14(?:\b|-)/);
  assert.match(workflowJobs(build).get("build"), /name: macOS\n\s+runner: macos-15\n/);
  for (const id of ["build-macos", "build-notebook-macos-arm64", "build-notebook-macos-x64"]) {
    assert.match(jobs.get(id), /^    runs-on: macos-15$/m, `${id} must keep its ARM64 host`);
  }

  const executables = jobs.get("build-macos");
  for (const [target, arch] of [["aarch64-apple-darwin", "arm64"], ["x86_64-apple-darwin", "x64"]]) {
    assert.ok(executables.includes(`cargo build --release --target ${target} -p runt -p runtimed`));
    for (const binary of ["runt", "runtimed"]) {
      assert.ok(executables.includes(`cp target/${target}/release/${binary} ${binary}-darwin-${arch}`));
    }
    assert.match(jobs.get("build-python-wheels"), new RegExp(`runner: macos-15\\n\\s+target: ${target}\\n`));
  }
  const x64 = jobs.get("build-notebook-macos-x64");
  assert.match(x64, /run: rustup target add x86_64-apple-darwin/);
  assert.match(x64, /cargo build --release --target x86_64-apple-darwin -p runtimed -p runt -p nteract-mcp/);
  assert.match(x64, /args: --target x86_64-apple-darwin --bundles app,dmg/);
  assert.match(x64, /target\/x86_64-apple-darwin\/release\/bundle\/macos/);
});

test("Linux npm validation tests packed wrapper and addon on the oldest supported userspace", () => {
  const body = validationJobs.get("linux-node-addon");
  assert.match(body, /arch: x64\n\s+runner: ubuntu-22\.04\n/);
  assert.match(body, /arch: arm64\n\s+runner: ubuntu-22\.04-arm\n/);
  assert.match(body, /glibcVersionRuntime, '2\.35'/);
  assert.match(body, /require\.cache\[require\.resolve\(process\.env\.ADDON\)\]/);
  const install = body.indexOf('npm install --prefix "$RUNNER_TEMP/npm-linux/installed"');
  const audit = body.indexOf('node scripts/ci/audit-linux-node.mjs "$ARCH" "$ADDON"');
  const load = body.indexOf("const rt = require(wrapper)");
  assert.ok(install >= 0 && audit > install && load > audit);
  assert.doesNotMatch(body, /continue-on-error:/);
  for (const path of ["scripts/ci/audit-linux-node.mjs", "scripts/tests/audit-linux-node.test.mjs", "crates/runtimed-node/**", "Cargo.lock", "rust-toolchain.toml"]) {
    assert.ok(validation.includes(`      - ${path}\n`), `missing trigger: ${path}`);
  }
  assert.match(validationJobs.get("linux-arm64-packages"), /name: validation-npm-linux-arm64-gnu-ubuntu2404/);
  assert.doesNotMatch(validationJobs.get("linux-arm64-packages"), /name: npm-package-linux-arm64-gnu\n/);
});

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

test("reserve the immutable tag before any build and require it at publication", () => {
  const compute = jobs.get("compute-version");
  assert.match(compute, /SOURCE_SHA: \$\{\{ steps\.version\.outputs\.SOURCE_SHA \}\}/);
  assert.ok(compute.includes('check-release-tag.sh "$TAG_NAME" "$SOURCE_SHA" --reserve'));
  assert.deepEqual(needs("build-wasm"), ["compute-version"]);
  const body = jobs.get("prerelease");
  assert.equal(body.match(/check-release-tag\.sh "\$TAG_NAME" "\$SOURCE_SHA" --require/g)?.length, 2);
  // Existing tags select source. Passing an old SHA as target_commitish can
  // demand Workflows:write after main advances, even though Contents:write is set.
  assert.doesNotMatch(body, /^\s+target_commitish:/m);
  const github = body.indexOf("      - name: Create GitHub Release\n");
  const recheck = body.indexOf("      - name: Verify published release tag still matches built source\n");
  const pypi = body.indexOf("      - name: Publish runtimed to PyPI\n");
  const updater = body.indexOf("      - name: Update ");
  assert.ok(github >= 0 && recheck > github && pypi > recheck && updater > pypi);
  assert.match(body.slice(pypi, updater), /--trusted-publishing always --check-url/);
});

test("changelog excludes reserved tags without touching the remote", () => {
  const body = jobs.get("prerelease");
  assert.match(body, /gh api --paginate "repos\/\$GITHUB_REPOSITORY\/releases"/);
  const filter = body.indexOf("bash scripts/ci/filter-unpublished-release-tags.sh");
  assert.ok(filter >= 0 && filter < body.indexOf("CHANGELOG=$(git-cliff"));
  assert.match(body, /select\(\.draft == false\)/);
  assert.ok(body.includes("git tag -l 'v*-stable.*' --merged HEAD --sort=-creatordate"));
  assert.ok(body.includes('filter-unpublished-release-tags.sh "$RUNNER_TEMP/published-release-tags" "$TAG_NAME"'));
  assert.ok(validation.includes("      - scripts/ci/filter-unpublished-release-tags.sh\n"));
});

test("release channels serialize runs without cancelling active publication", () => {
  for (const channel of ["stable", "nightly"]) {
    const caller = workflow(`release-${channel}`);
    assert.ok(caller.includes(`concurrency:\n  group: nteract-release-${channel}\n  cancel-in-progress: false\n`));
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

test("runtime-peer image publication keeps packages:write scoped to the two image jobs", () => {
  const imageJobs = ["image-runtime-peer-build", "image-runtime-peer-publish"];
  for (const [id, body] of jobs) {
    assert.match(body, /^    permissions:\n/m, `${id} must declare its own permissions instead of inheriting the caller ceiling`);
    const grantsPackages = /^      packages: write$/m.test(body);
    assert.equal(grantsPackages, imageJobs.includes(id), `${id} packages:write grant`);
  }
  for (const id of imageJobs) {
    const body = jobs.get(id);
    assert.ok(body, `${id} must exist`);
    assert.match(body, /^      IMAGE: ghcr\.io\/nteract\/runtime-peer$/m, `${id} publishes to the repository owner's GHCR namespace`);
    assert.doesNotMatch(body, /ghcr\.io\/anaconda\//, `${id} must not target a namespace GITHUB_TOKEN cannot write`);
  }
  // compute-version reserves the release tag with `git push`; read-only would
  // stop every release at its first step.
  assert.match(jobs.get("compute-version"), /^    permissions:\n      contents: write$/m, "compute-version must keep tag-push access");

  const build = jobs.get("image-runtime-peer-build");
  assert.match(build, /uses: docker\/build-push-action@v6\n[\s\S]*?load: true\n\s+push: false/, "build via build-push-action so the gha cache credentials are present; load locally, do not push");
  assert.match(build, /cache-to: type=gha/, "gha cache requested through the action, not a raw docker build");
  assert.doesNotMatch(build, /run: \|\n\s+docker build/, "raw docker build cannot see the Actions cache credentials");
  assert.match(build, /STAGING_TAG: ghcr\.io\/nteract\/runtime-peer:build-\$\{\{ inputs\.version_suffix \}\}-/, "staging tag must be channel-qualified so stable and nightly on one commit cannot overwrite each other");
  assert.match(build, /runtime-peer-image-smoke\.sh[\s\S]*docker push "\$STAGING_TAG"/, "smoke must gate the staging push");
  assert.match(build, /outputs:\n\s+digest: \$\{\{ steps\.push\.outputs\.DIGEST \}\}/, "build exports the pushed digest");

  const publish = jobs.get("image-runtime-peer-publish");
  assert.match(publish, /needs: \[compute-version, prerelease, image-runtime-peer-build\]/);
  assert.match(publish, /DIGEST: \$\{\{ needs\.image-runtime-peer-build\.outputs\.digest \}\}/, "publish consumes the build digest");
  assert.match(publish, /docker buildx imagetools create[\s\S]*?"\$IMAGE@\$DIGEST"/, "promotion is by digest, not by re-pulling a mutable tag");
  // With one manifest source, imagetools wraps it in a new index by default,
  // so the tags would resolve to a digest the anonymous-pull check rejects.
  const promotions = publish.match(/docker buildx imagetools create(?:[^\n]*\\\n)*[^\n]*/g) ?? [];
  assert.equal(promotions.length, 2, "version/channel promotion and stable-only latest promotion");
  for (const promotion of promotions) {
    assert.match(promotion, /\n\s+--prefer-index=false \\\n/, `promotion must copy the built manifest unchanged:\n${promotion}`);
    assert.match(promotion, /"\$IMAGE@\$DIGEST"$/, `promotion must name the built digest:\n${promotion}`);
  }
  assert.doesNotMatch(publish, /docker pull "\$STAGING_TAG"|docker tag /, "publish must not retag from a mutable staging tag");
  assert.match(publish, /if: inputs\.github_release_prerelease == false\n\s+run: \|\n[\s\S]*?--tag "\$IMAGE:latest"/, "latest is stable-only");
  assert.match(publish, /docker logout ghcr\.io[\s\S]*?if \[ "\$PULLED" != "\$DIGEST" \]/, "anonymous pull must resolve to the promoted digest");

  // Callers must raise the ceiling for the reusable call or GitHub rejects the
  // whole release at validation time (the failure behind #4374).
  for (const name of ["release-nightly", "release-stable"]) {
    const caller = workflow(name);
    assert.doesNotMatch(caller, /^permissions:/m, `${name} must not grant workflow-wide permissions`);
    assert.match(workflowJobs(caller).get("release"), /^    permissions:\n      contents: write\n      id-token: write\n      packages: write\n/m, `${name} release job ceiling`);
  }
});

test("editor assets job publishes a channel-named tarball with least privilege", () => {
  const body = jobs.get("publish-notebook-cloud-assets");
  assert.ok(body, "publish-notebook-cloud-assets must exist");
  assert.match(body, /^    permissions:\n      contents: write\n/m, "job declares permissions");
  assert.doesNotMatch(body, /packages: write/);
  assert.match(body, /^    needs: \[compute-version, build-wasm, prerelease\]$/m);
  assert.match(body, /name: wasm-artifacts/, "reuses build-wasm output");
  assert.match(body, /skip-wasm: true/, "does not rebuild WASM");
  assert.match(body, /notebook-cloud-assets-\$\{\{ env\.RUNT_BUILD_CHANNEL \}\}\.tar\.gz\.sha256/, "names the sidecar with the channel");
  assert.match(body, /notebook-cloud-assets-smoke\.sh[\s\S]*gh release upload/, "smoke gates the upload");
});
