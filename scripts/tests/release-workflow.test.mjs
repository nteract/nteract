import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {test} from "node:test";
import {fileURLToPath} from "node:url";
import {runInNewContext} from "node:vm";

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

const ATTRIBUTION_FILES = ["LICENSE.nteract", "THIRD_PARTY_NOTICES.txt", "sbom.cdx.json"];
const DAEMON_PLATFORMS = ["linux-x64", "linux-arm64", "darwin-arm64", "darwin-x64", "windows-x64.exe", "windows-arm64.exe"];

function workflowStep(body, name) {
  const start = body.indexOf(`      - name: ${name}\n`);
  assert.ok(start >= 0, `missing step ${name}`);
  return body.slice(start).split(/\n      - /)[0];
}

test("native attribution preflights run for collector, dependency, and packaging changes", () => {
  const paths = validation.split("\n  workflow_dispatch:")[0];
  assert.match(paths, /\n  pull_request:\n    paths:/);
  for (const path of [
    "packages/runtimed-node/scripts/**", ".github/actions/install-cargo-about/**",
    "Cargo.lock", "rust-toolchain.toml", "scripts/licenses/**",
    "scripts/release-attribution.mjs", "scripts/release-about.toml",
    "scripts/tests/release-workflow.test.mjs",
  ]) assert.ok(paths.includes(`      - ${path}\n`), `missing attribution trigger: ${path}`);
});

test("license exception review dates warn after the UTC review day without failing CI", () => {
  const body = validationJobs.get("release-tag");
  const step = workflowStep(body, "Warn about overdue license exception reviews");
  assert.ok(body.indexOf("uses: actions/setup-node@v6") < body.indexOf(step));
  assert.ok(body.indexOf(step) < body.indexOf("pnpm install"));
  const program = step.match(/          node --input-type=module <<'JS'\n([\s\S]*?)          JS(?:\n|$)/)?.[1];
  assert.ok(program, "execute the actual workflow warning program");
  const records = JSON.parse(readFileSync(new URL("../licenses/plotly-exceptions.json", import.meta.url), "utf8"));
  assert.equal(records.exceptions.length, 4);
  for (const today of ["2026-12-04", "2026-12-05", "2026-12-06"]) {
    const warnings = [];
    assert.doesNotThrow(() => runInNewContext(program.replace(/^\s*import .+;\n/m, ""), {
      readFileSync(path, encoding) {
        assert.equal(path, "scripts/licenses/plotly-exceptions.json");
        assert.equal(encoding, "utf8");
        return JSON.stringify(records);
      },
      Date: class { toISOString() { return `${today}T23:59:59.999Z`; } },
      console: {log: message => warnings.push(message)},
    }));
    const overdue = records.exceptions.filter(record => today > record.reviewDate);
    assert.equal(warnings.length, overdue.length);
    for (const [index, record] of overdue.entries()) {
      assert.ok(warnings[index].startsWith("::warning::"));
      for (const value of [`${record.name}@${record.version}`, record.reviewDate, record.owner, record.trackingUrl]) {
        assert.ok(warnings[index].includes(value));
      }
    }
  }
  assert.doesNotMatch(step, /::error::|process\.exit|exitCode|throw|continue-on-error:/);
});

test("Linux attribution preflight collects native daemon and Node metadata across release OS targets without building", () => {
  const body = validationJobs.get("native-rust-attribution");
  assert.ok(body, "missing native-rust-attribution job");
  assert.match(body, /runs-on: ubuntu-24\.04/);
  const collect = workflowStep(body, "Validate native Cargo attribution without building artifacts");
  for (const prerequisite of [
    "uses: actions/checkout@v6", "uses: dsherret/rust-toolchain-file@v1",
    "uses: actions/setup-node@v6", "uses: pnpm/action-setup@v4",
    "pnpm install --frozen-lockfile --ignore-scripts", "uses: ./.github/actions/install-cargo-about",
  ]) assert.ok(body.indexOf(prerequisite) >= 0 && body.indexOf(prerequisite) < body.indexOf(collect), prerequisite);
  assert.match(collect, /import \{ collectRust \} from '\.\/scripts\/release-attribution\.mjs'/);
  assert.match(collect, /for \(const kind of \['runtimed', 'runtimed-node'\]\)/);
  assert.match(collect, /collectRust\(process\.cwd\(\), \{ kind, target \}\)/);
  const program = collect.match(/          node --input-type=module <<'JS'\n([\s\S]*?)          JS\n/)?.[1];
  assert.ok(program);
  const calls = [];
  runInNewContext(program.replace(/^\s*import .+;\n/m, ""), {
    process: {cwd: () => "/checkout"}, console: {log() {}},
    collectRust(root, {kind, target}) {
      assert.equal(root, "/checkout");
      calls.push(`${kind}:${target}`);
      return {components: [], materials: []};
    },
  });
  assert.deepEqual(calls, ["runtimed", "runtimed-node"].flatMap(kind =>
    ["x86_64-unknown-linux-gnu", "aarch64-apple-darwin", "x86_64-pc-windows-msvc"].map(target => `${kind}:${target}`)));
  assert.match(collect, /node --input-type=module/);
  assert.doesNotMatch(body, /continue-on-error:|\|\| true|collectBundledNpm|--binary|cargo build|pnpm build|build-runtime-artifacts|npm publish|upload-artifact|: write|\n    (?:needs|if):/);
});

test("Windows CRT preflight validates all actual release runner environments without compiling", () => {
  const body = validationJobs.get("windows-crt-attribution");
  assert.ok(body, "missing windows-crt-attribution job");
  assert.match(body, /runs-on: \$\{\{ matrix\.runner \}\}/);
  assert.match(body, /fail-fast: false/);
  assert.match(body, /runner: windows-2025\n\s+arch: x64\n\s+target: x86_64-pc-windows-msvc/);
  assert.match(body, /runner: windows-latest\n\s+arch: x64\n\s+target: x86_64-pc-windows-msvc/);
  assert.doesNotMatch(body, /windows-2022/);
  assert.equal(body.match(/- runner:/g)?.length, 3);
  assert.match(body, /runner: windows-11-vs2026-arm\n\s+arch: arm64\n\s+target: aarch64-pc-windows-msvc/);
  const activate = workflowStep(body, "Activate producer MSVC environment");
  const verify = workflowStep(body, "Verify producer MSVC environment");
  const collect = workflowStep(body, "Validate installed producer CRT attribution without compiling");
  const producer = workflowJobs(workflow("publish-npm")).get("pack-native");
  assert.equal(activate.match(/uses: (.+)/)[1], workflowStep(producer, "Activate producer MSVC environment").match(/uses: (.+)/)[1]);
  assert.match(activate, /arch: \$\{\{ matrix\.arch \}\}/);
  assert.match(verify, /EXPECTED_MSVC_ARCH: \$\{\{ matrix\.arch \}\}/);
  assert.equal(verify.split("        run: |\n")[1].trim(), workflowStep(producer, "Verify producer MSVC environment").split("        run: |\n")[1].trim());
  assert.ok(body.indexOf("uses: actions/checkout@v6") < body.indexOf(activate));
  assert.ok(body.indexOf(activate) < body.indexOf(verify));
  assert.ok(body.indexOf(verify) < body.indexOf(collect));
  const servicing = workflowStep(body, "Report installed SDK servicing products");
  assert.match(servicing, /Get-ItemProperty/);
  assert.match(servicing, /Select-Object DisplayName,DisplayVersion/);
  assert.ok(body.indexOf(servicing) < body.indexOf(collect));
  assert.ok(body.indexOf("uses: actions/setup-node@v6") < body.indexOf(collect));
  assert.match(body, /node-version: "24"\n\s+architecture: \$\{\{ matrix\.arch \}\}/);
  assert.equal(body.match(/uses: ilammy\/msvc-dev-cmd@/g)?.length, 1);
  assert.match(collect, /TARGET: \$\{\{ matrix\.target \}\}/);
  assert.match(collect, /import \{ collectMsvcRuntime \} from '\.\/scripts\/release-attribution\.mjs'/);
  assert.match(collect, /collectMsvcRuntime\(\{ kind: 'runtimed-node', target: process\.env\.TARGET \}, process\.env\)/);
  assert.match(collect, /node --input-type=module/);
  assert.doesNotMatch(body, /continue-on-error:|\|\| true|collectRust|collectBundledNpm|cargo |rust-toolchain|pnpm |--binary|build-runtime-artifacts|npm publish|upload-artifact|: write|NTERACT_(?:MSVC|WINDOWS_SDK)_LICENSE_FILE|\n    (?:needs|if):|\n\s+(?:sdk|toolset|vsversion):/);
});

test("Windows release producers activate a pinned native MSVC environment before every build", () => {
  const npm = workflowJobs(workflow("publish-npm")).get("pack-native");
  const producers = [
    [jobs.get("build-notebook-windows-x64"), "x64", "Generate standalone runtimed attribution"],
    [jobs.get("build-notebook-windows-arm64"), "arm64", "Generate standalone runtimed attribution"],
    [npm, "${{ matrix.target == 'win32-arm64-msvc' && 'arm64' || 'x64' }}", "Generate native binding attribution"],
  ];
  const verificationPrograms = [];
  for (const [body, arch, attributionName] of producers) {
    const activate = workflowStep(body, "Activate producer MSVC environment");
    const verify = workflowStep(body, "Verify producer MSVC environment");
    assert.match(activate, /uses: ilammy\/msvc-dev-cmd@0b201ec74fa43914dc39ae48a89fd1d8cb592756 # v1\.13\.0/);
    assert.ok(activate.split("\n").includes(`          arch: ${arch}`));
    assert.ok(verify.includes(`          EXPECTED_MSVC_ARCH: ${arch}\n`));
    assert.doesNotMatch(activate, /\n\s+(?:sdk|toolset|vsversion):/, "keep the installed producer defaults, not a different SDK");
    assert.doesNotMatch(activate + verify, /continue-on-error:/);
    for (const variable of ["VCToolsInstallDir", "VCToolsVersion", "VSINSTALLDIR", "WindowsSdkDir", "UCRTVersion", "LIB"]) {
      assert.ok(verify.includes(`'${variable}'`), `must require producer ${variable}`);
    }
    assert.match(verify, /\$env:VSCMD_ARG_TGT_ARCH -ne \$env:EXPECTED_MSVC_ARCH/);
    assert.match(verify, /Get-Command cl\.exe -ErrorAction Stop/);
    assert.match(verify, /\$compiler\.StartsWith\(\$tools, \[StringComparison\]::OrdinalIgnoreCase\)/);
    assert.ok(body.indexOf(activate) < body.indexOf(verify));
    for (const build of ["uses: dsherret/rust-toolchain-file@", "uses: ./.github/actions/build-runtime-artifacts", "run: pnpm --dir packages/runtimed-node build", "cargo build --release"]) {
      const index = body.indexOf(build);
      if (index >= 0) assert.ok(body.indexOf(verify) < index, `${build} must share the activated producer environment`);
    }
    assert.ok(body.indexOf(verify) < body.indexOf(workflowStep(body, attributionName)));
    assert.equal(body.match(/uses: ilammy\/msvc-dev-cmd@/g)?.length, 1, "do not reactivate a different toolset after compilation");
    verificationPrograms.push(verify.split("        run: |\n")[1].trim());
  }
  assert.deepEqual(verificationPrograms, Array(3).fill(verificationPrograms[0]), "all producers enforce the same compiler/environment checks");
  for (const [id, target] of [
    ["build-notebook-windows-x64", "x86_64-pc-windows-msvc"],
    ["build-notebook-windows-arm64", "aarch64-pc-windows-msvc"],
  ]) {
    const body = jobs.get(id);
    const pin = body.slice(body.indexOf("      - uses: ./.github/actions/pin-msvc-linker\n")).split("\n      - ")[0];
    assert.ok(pin.startsWith("      - uses: ./.github/actions/pin-msvc-linker\n"));
    assert.ok(body.indexOf(workflowStep(body, "Verify producer MSVC environment")) < body.indexOf(pin));
    assert.ok(body.indexOf(pin) < body.indexOf("uses: dsherret/rust-toolchain-file@"));
    assert.match(pin, new RegExp(`target: ${target}`));
  }
  for (const name of ["Activate producer MSVC environment", "Verify producer MSVC environment"]) {
    assert.match(workflowStep(npm, name), /if: startsWith\(matrix\.target, 'win32-'\)/);
  }
});

test("native Windows x64 and ARM64 smoke builds execute the producer linker pin action", () => {
  const body = validationJobs.get("windows-msvc-linker-smoke");
  assert.ok(body, "missing windows-msvc-linker-smoke job");
  assert.match(body, /fail-fast: false/);
  assert.match(body, /runner: windows-2025\n\s+arch: x64\n\s+target: x86_64-pc-windows-msvc/);
  assert.match(body, /runner: windows-11-vs2026-arm\n\s+arch: arm64\n\s+target: aarch64-pc-windows-msvc/);
  const activate = workflowStep(body, "Activate producer MSVC environment");
  const verify = workflowStep(body, "Verify producer MSVC environment");
  const pin = body.slice(body.indexOf("      - uses: ./.github/actions/pin-msvc-linker\n")).split("\n      - ")[0];
  const setupRust = "uses: dsherret/rust-toolchain-file@v1";
  const build = workflowStep(body, "Build native Cargo executable from Git Bash");
  const verifyLinker = workflowStep(body, "Confirm Cargo used the selected producer linker");
  assert.ok(body.indexOf(activate) < body.indexOf(verify));
  assert.ok(body.indexOf(verify) < body.indexOf(pin));
  assert.ok(body.indexOf(pin) < body.indexOf(setupRust));
  assert.ok(body.indexOf(setupRust) < body.indexOf(build));
  assert.ok(body.indexOf(build) < body.indexOf(verifyLinker));
  assert.match(build, /shell: bash/);
  assert.match(build, /cargo build --verbose --manifest-path .* --target "\$TARGET"/);
  assert.match(build, /cygpath -u "\$RUNNER_TEMP"/);
  assert.match(build, /tee "\$runner_temp\/msvc-linker-smoke\.log"/);
  assert.match(verifyLinker, /\$env:LINKER_ENV_NAME/);
  assert.match(verifyLinker, /\$log\.Contains\(\$linker/);
  assert.match(verifyLinker, /Test-Path \$linker/);
});

test("shared producer linker action exports a target-specific Cargo linker from verified MSVC paths", () => {
  const action = readFileSync(new URL("../../.github/actions/pin-msvc-linker/action.yml", import.meta.url), "utf8");
  assert.match(action, /EXPECTED_RUST_TARGET: \$\{\{ inputs\.target \}\}/);
  assert.match(action, /Get-Command cl\.exe -ErrorAction Stop/);
  assert.match(action, /Join-Path \(Split-Path -Parent \$compiler\) 'link\.exe'/);
  assert.match(action, /Test-Path \$linker/);
  assert.match(action, /\$linker\.StartsWith\(\$tools, \[StringComparison\]::OrdinalIgnoreCase\)/);
  assert.match(action, /"\$targetEnv=\$linker" >> \$env:GITHUB_ENV/);
  assert.ok(validation.includes("      - .github/actions/pin-msvc-linker/**\n"));
});

test("UI attribution follows production build and gates the single archive publisher", () => {
  const body = jobs.get("build-notebook-linux");
  const attribution = workflowStep(body, "Generate notebook UI attribution");
  assert.match(attribution, /if: matrix\.platform\.package_notebook_ui/);
  assert.match(attribution, /--kind notebook-ui --target wasm32-unknown-unknown/);
  assert.match(attribution, /--output notebook-ui-attribution --version "\$VERSION" --commit "\$NTERACT_BUILD_GIT_HASH"/);
  assert.match(attribution, /VERSION: \$\{\{ needs\.compute-version\.outputs\.version \}\}/);
  assert.ok(body.indexOf("run: pnpm build") < body.indexOf(attribution));
  assert.ok(body.indexOf("uses: ./.github/actions/install-cargo-about") < body.indexOf(attribution));
  const pack = workflowStep(body, "Package notebook UI for embedders");
  assert.ok(body.indexOf(attribution) < body.indexOf(pack));
  assert.match(pack, /--attribution notebook-ui-attribution/);
  assert.doesNotMatch(pack, /--license/);
  assert.doesNotMatch(attribution, /continue-on-error/);
  assert.match(workflowStep(body, "Upload notebook UI release bundle"), /path: notebook-ui-assets\//);
  assert.match(jobs.get("prerelease"), /\.\/release-assets\/nteract-\$\{\{ inputs\.version_suffix \}\}-notebook-ui\.tar\.gz\n/);
});

test("all six standalone daemon targets generate and upload attribution after building", () => {
  const runtimeSetup = readFileSync(new URL("../../.github/actions/build-runtime-artifacts/action.yml", import.meta.url), "utf8");
  assert.match(runtimeSetup, /uses: actions\/setup-node@/);
  assert.match(runtimeSetup, /pnpm install --frozen-lockfile/);
  const installer = readFileSync(new URL("../../.github/actions/install-cargo-about/action.yml", import.meta.url), "utf8");
  assert.match(installer, /default: "0\.9\.2"/);
  for (const id of ["build-linux", "build-macos", "build-notebook-windows-x64", "build-notebook-windows-arm64"]) {
    const body = jobs.get(id);
    const attribution = workflowStep(body, "Generate standalone runtimed attribution");
    const index = body.indexOf(attribution);
    for (const prerequisite of ["uses: ./.github/actions/build-runtime-artifacts", "uses: ./.github/actions/install-cargo-about", "cargo build --release"]) {
      assert.ok(body.indexOf(prerequisite) >= 0 && body.indexOf(prerequisite) < index, `${id}: ${prerequisite}`);
    }
    assert.match(attribution, /--kind runtimed --target /);
    assert.match(attribution, /--version "\$VERSION" --commit "\$NTERACT_BUILD_GIT_HASH" --binary "\$ASSET"/);
    assert.match(attribution, /VERSION: \$\{\{ needs\.compute-version\.outputs\.version \}\}/);
    assert.match(attribution, /for name in LICENSE\.nteract THIRD_PARTY_NOTICES\.txt sbom\.cdx\.json; do/);
    assert.match(attribution, /cp "daemon-attribution\/.*\$name" "\$ASSET\.\$name"/);
    assert.doesNotMatch(attribution, /continue-on-error|\|\| true/);
  }
  const linux = jobs.get("build-linux");
  const linuxAttribution = workflowStep(linux, "Generate standalone runtimed attribution");
  assert.match(linuxAttribution, /TARGET: \$\{\{ matrix\.platform\.target \}\}/);
  assert.match(linuxAttribution, /ASSET="runtimed-linux-\$ARCH"/);
  assert.match(linux, /runtimed-linux-\$\{\{ matrix\.platform\.arch \}\}\.\*/);
  const mac = jobs.get("build-macos");
  assert.match(mac, /for pair in aarch64-apple-darwin:arm64 x86_64-apple-darwin:x64; do/);
  assert.match(mac, /ASSET="runtimed-darwin-\$ARCH"/);
  for (const arch of ["arm64", "x64"]) {
    assert.ok(mac.includes(`            runtimed-darwin-${arch}.*\n`));
    const windows = jobs.get(`build-notebook-windows-${arch}`);
    const attribution = workflowStep(windows, "Generate standalone runtimed attribution");
    const target = arch === "arm64" ? "aarch64" : "x86_64";
    assert.ok(attribution.includes(`--target ${target}-pc-windows-msvc`));
    assert.ok(attribution.includes(`ASSET="daemon/runtimed-windows-${arch}.exe"`));
    assert.ok(windows.indexOf(attribution) > windows.indexOf("uses: tauri-apps/tauri-action@v0"), "hash the post-signing binary");
    assert.ok(windows.indexOf(attribution) > windows.indexOf("- name: Stage standalone runtimed binary"));
    assert.ok(windows.indexOf(attribution) < windows.indexOf("- name: Upload standalone runtimed binary"));
    assert.ok(windows.includes(`path: daemon/runtimed-windows-${arch}.exe*\n`));
  }
});

for (const channel of ["stable", "nightly"]) {
  for (const missing of [null, "sbom.cdx.json"]) {
    test(`${channel} release staging ${missing ? "rejects a missing sidecar" : "retains all target sidecars and publication globs"}`, (t) => {
      const fixture = mkdtempSync(join(tmpdir(), "release-attribution-"));
      t.after(() => rmSync(fixture, {recursive: true, force: true}));
      mkdirSync(join(fixture, "executables"));
      mkdirSync(join(fixture, "release-assets"));
      for (const platform of DAEMON_PLATFORMS) {
        for (const name of ATTRIBUTION_FILES) {
          if (missing === name && platform === "windows-arm64.exe") continue;
          writeFileSync(join(fixture, "executables", `runtimed-${platform}.${name}`), `${platform}:${name}`);
        }
      }
      const prepare = workflowStep(jobs.get("prerelease"), "Prepare release assets");
      const rename = prepare.match(/          DAEMON_NAME="runtimed"[\s\S]*?          fi\n/)?.[0];
      const copy = prepare.match(/^          for platform in linux-x64 [\s\S]*?^          done\n/m)?.[0];
      assert.ok(rename && copy, "exercise actual channel selection and attribution staging loop");
      const result = spawnSync("bash", ["-euo", "pipefail", "-c", rename + copy], {
        cwd: fixture, encoding: "utf8", env: {...process.env, CHANNEL: channel},
      });
      if (missing) {
        assert.notEqual(result.status, 0, "missing attribution must stop release staging");
        return;
      }
      assert.equal(result.status, 0, result.stderr);
      const basename = channel === "nightly" ? "runtimed-nightly" : "runtimed";
      const expected = DAEMON_PLATFORMS.flatMap(platform => ATTRIBUTION_FILES.map(name => `${basename}-${platform}.${name}`)).sort();
      assert.deepEqual(readdirSync(join(fixture, "release-assets")).sort(), expected);
      for (const platform of DAEMON_PLATFORMS) {
        for (const name of ATTRIBUTION_FILES) {
          assert.equal(readFileSync(join(fixture, "release-assets", `${basename}-${platform}.${name}`), "utf8"), `${platform}:${name}`);
        }
      }
      const publish = workflowStep(jobs.get("prerelease"), "Create GitHub Release");
      const patterns = ATTRIBUTION_FILES.map(name => `./release-assets/runtimed*.${name}`);
      for (const pattern of patterns) assert.ok(publish.includes(`            ${pattern}\n`));
      const expansion = spawnSync("bash", ["-c", `printf '%s\\n' ${patterns.join(" ")}`], {cwd: fixture, encoding: "utf8"});
      assert.equal(expansion.status, 0, expansion.stderr);
      assert.deepEqual(expansion.stdout.trim().split("\n").map(path => path.replace("./release-assets/", "")).sort(), expected);
    });
  }
}

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
    if (id === "compute-version") assert.match(jobs.get(id), /^    if: inputs\.recovery_run_id == ''$/m);
    else assert.doesNotMatch(jobs.get(id), /^    (?:if|continue-on-error):/m, `${id} must fail closed`);
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

test("wheel recovery stays in the original workflow pair and cannot start normal release jobs", () => {
  const nightly = workflow("release-nightly");
  assert.match(nightly, /run-name:.*inputs\.recovery_run_id != ''.*Nightly wheel recovery/);
  assert.match(nightly, /recovery_run_id:\n\s+description:[^\n]+\n\s+type: string\n\s+default: ""/);
  assert.match(nightly, /recovery_run_id: \$\{\{ inputs\.recovery_run_id \|\| '' \}\}/);
  assert.match(jobs.get("compute-version"), /^    if: inputs\.recovery_run_id == ''$/m);
  const recovery = jobs.get("recover-nightly-wheel");
  assert.ok(recovery);
  assert.match(recovery, /^    if: inputs\.recovery_run_id != ''$/m);
  assert.match(recovery, /steps:\n      - name: Require the allowlisted nightly dispatch context/);
  const guard = workflowStep(recovery, "Require the allowlisted nightly dispatch context");
  assert.doesNotMatch(guard, /\$\{\{/);
  assert.match(guard, /test "\$RECOVERY_CHANNEL" = nightly/);
  assert.match(guard, /test "\$RECOVERY_RUN_ID" = 42465470406/);
  assert.doesNotMatch(recovery, /^    needs:/m);
  assert.match(recovery, /contents: read\n\s+actions: read\n\s+id-token: write/);
  assert.match(recovery, /ref: \$\{\{ github.sha \}\}\n\s+persist-credentials: false/);
  assert.match(recovery, /version: "0\.13\.7"/);
  assert.doesNotMatch(recovery, /secrets\.|contents: write|packages: write|softprops|--clobber|cargo build|uv publish|always\(\)|continue-on-error/);
  assert.doesNotMatch(workflow("release-stable"), /recovery_run_id|Nightly wheel recovery/);
  const reachesCompute = id => id === "compute-version" || needs(id).some(reachesCompute);
  for (const id of jobs.keys()) {
    if (id !== "recover-nightly-wheel") assert.ok(reachesCompute(id), `${id} must depend on normal version computation`);
  }
});

test("all three release consumers apply the shared identity guard before using source or publishing", () => {
  for (const name of ["npm-release-cli.mjs", "npm-wasm-release-cli.mjs", "editor-assets-release-cli.mjs"]) {
    const source = readFileSync(new URL(`../ci/${name}`, import.meta.url), "utf8");
    assert.match(source, /import[^;]*releaseIdentity[^;]*from ["']\.\/npm-release\.mjs["']/);
    assert.match(source, /releaseIdentity\(/);
  }
  assert.match(validation, /scripts\/ci\/nightly-wheel-recovery\.mjs/);
  assert.match(validation, /scripts\/tests\/nightly-wheel-recovery\.test\.mjs/);
  assert.match(validation, /node --test[^\n]*scripts\/tests\/nightly-wheel-recovery\.test\.mjs/);
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

test("runtime-peer release compilation follows real MCP widget generation and verification", () => {
  const dockerfile = readFileSync(new URL("../../images/runtime-peer/Dockerfile", import.meta.url), "utf8");
  const commands = dockerfile.replace(/\\\n\s*/g, " ");
  const releaseBuild = commands.indexOf("cargo build --release -p runtimed -p runt");
  assert.ok(releaseBuild >= 0, "image must build both release binaries");
  const preparation = commands.slice(0, releaseBuild);
  const frozenInstall = preparation.indexOf("pnpm install --frozen-lockfile");
  const artifactCommands = [...preparation.matchAll(/cargo xtask artifacts (ensure|verify) ([a-z,-]+)/g)];
  for (const scope of ["mcp-widget", "runtime", "sift", "renderer"]) {
    const covers = (command) => command[2].split(",").some((value) => value === scope || value === "all");
    const ensure = artifactCommands.find((command) => command[1] === "ensure" && covers(command));
    const verify = artifactCommands.find((command) => command[1] === "verify" && covers(command));
    assert.ok(ensure, `${scope} must be generated before release compilation`);
    assert.ok(verify, `${scope} must pass strict artifact verification, including receipts and placeholder detection`);
    assert.ok(frozenInstall >= 0 && ensure.index > frozenInstall && verify.index > ensure.index,
      `${scope} must be generated after the frozen install and verified afterward`);
  }
});

test("runtime-peer PR validation builds and smokes the release image without publishing", () => {
  const body = validationJobs.get("runtime-peer-image");
  assert.ok(body, "image recipe changes need a real container build before release");
  assert.match(body, /runs-on: ubuntu-24\.04/);
  assert.match(body, /lfs: true/);
  assert.match(body, /uses: docker\/setup-buildx-action@v3/);
  assert.match(body, /uses: docker\/build-push-action@v6[\s\S]*context: \.[\s\S]*file: images\/runtime-peer\/Dockerfile/);
  assert.match(body, /load: true\n\s+push: false/);
  assert.match(body, /RUNT_BUILD_CHANNEL=nightly/);
  assert.match(body, /crates\/runtimed\/Cargo\.toml/);
  const build = body.indexOf("uses: docker/build-push-action@v6");
  const smoke = body.indexOf('bash scripts/ci/runtime-peer-image-smoke.sh "$IMAGE" "$EXPECTED_VERSION"');
  assert.ok(smoke > build, "the existing full smoke test must run on the image just built");
  assert.doesNotMatch(body, /continue-on-error:|docker\/login-action|docker push|push: true|packages: write/);
  for (const path of [".dockerignore", "images/runtime-peer/**", "scripts/ci/runtime-peer-image-smoke.sh"]) {
    assert.ok(validation.includes(`      - ${path}\n`), `missing image validation trigger: ${path}`);
  }
});

test("runtime-peer release refreshes trust layers and bootstraps pip before package installs", () => {
  const build = jobs.get("image-runtime-peer-build");
  assert.match(build, /^          pull: true$/m);
  assert.match(build, /^          no-cache: true$/m);
  const validation = validationJobs.get("runtime-peer-image");
  assert.match(validation, /^          pull: true$/m);
  assert.match(validation, /^          no-cache: true$/m);
  const dockerfile = readFileSync(new URL("../../images/runtime-peer/Dockerfile", import.meta.url), "utf8");
  const bootstrap = "pip-26.2.2-py3-none-any.whl#sha256=fd7f4dfa8190e014013b9f08f3e973f4e4c26ffd179a204895533a7254813a70";
  const builder = dockerfile.split(" AS builder")[1].split(" AS runtime")[0];
  const runtime = dockerfile.split(" AS runtime")[1];
  for (const [stage, firstInstall] of [[builder, '"maturin[patchelf]==1.11.5"'], [runtime, "-r /tmp/base-packages.txt"]]) {
    assert.ok(stage.includes(bootstrap), "each stage must bootstrap the advisory's hash-pinned pip wheel");
    assert.ok(stage.indexOf(bootstrap) < stage.indexOf(firstInstall), "patched pip must precede ordinary package resolution");
  }
  assert.match(runtime, /"certifi>=2026\.10\.19" "uv>=0\.13\.5"/);
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
  assert.match(build, /uses: docker\/build-push-action@v6\n[\s\S]*?load: true\n\s+push: false/, "build via build-push-action with fresh layers; load locally, do not push");
  assert.doesNotMatch(build, /run: \|\n\s+docker build/, "use the declared build action inputs");
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
    assert.match(workflowJobs(caller).get("release"), /^    permissions:\n      contents: write\n      id-token: write\n      packages: write\n      actions: read\n/m, `${name} release job ceiling includes recovery metadata access`);
  }
});


// Exercise only the tier-1 shell boundary. The fake Python command consumes
// the real heredoc but never imports native code or starts a daemon/container.
function runImagePythonTier(exitStatus) {
  const source = readFileSync(new URL("../../images/runtime-peer/smoke.sh", import.meta.url), "utf8");
  const tier = source.match(/^python3 [^\n]*<<'PY'[^\n]*\nimport asyncio\n[\s\S]*?\nPY\n[\s\S]*?(?=\n# --- (?:Binding exit probe:|Tier 2:))/m)?.[0];
  assert.ok(tier, "must find the actual tier-1 Python command and its shell completion marker");
  const fail = source.match(/^fail\(\) \{[^\n]+$/m)?.[0];
  assert.ok(fail);
  const fakePython = [
    "python3() {",
    "  printf 'python args: %s\\n' \"$*\"",
    "  while IFS= read -r line; do",
    "    case \"$line\" in",
    "      'print(\"tier 1 ok\")') printf 'tier 1 ok\\n' ;;",
    "    esac",
    "  done",
    "  printf 'python application body returned\\n'",
    "  return \"$SIMULATED_PYTHON_STATUS\"",
    "}",
  ].join("\n");
  return spawnSync("bash", ["-s"], {
    input: ["set -euo pipefail", fail, fakePython, tier].join("\n"),
    encoding: "utf8",
    env: {...process.env, SIMULATED_PYTHON_STATUS: String(exitStatus)},
  });
}

test("image Python tier enables fault traces and waits for a clean interpreter exit", () => {
  const result = runImagePythonTier(0);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /python args: .*?-X ?faulthandler\b/);
  assert.match(result.stdout, /python args: .*?-u\b/);
  assert.ok(result.stdout.indexOf("tier 1 ok") > result.stdout.indexOf("python application body returned"),
    "application completion alone is not a successful interpreter exit");
});

test("image Python tier fails closed when the interpreter exits 139 after its body", () => {
  const result = runImagePythonTier(139);
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stdout, /tier 1 ok/);
  assert.match(result.stderr, /daemon execution tier failed.*139/);
});

test("image Python tier preserves ordinary assertion failure", () => {
  const result = runImagePythonTier(1);
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stdout, /tier 1 ok/);
  assert.match(result.stderr, /daemon execution tier failed.*1/);
});

// Consume the real probe heredoc without executing Python. Shell function calls
// share a counter, allowing a single bad exit to prove no later sample runs.
function runImageExitProbe(failureAt, exitStatus) {
  const source = readFileSync(new URL("../../images/runtime-peer/smoke.sh", import.meta.url), "utf8");
  const probe = source.match(/^for attempt in .*\n[\s\S]*?^done$/m)?.[0];
  assert.ok(probe, "must find the actual bounded fresh-process probe");
  assert.match(probe, /await asyncio\.wait_for\(runtimed\.Client\(\)\.ping\(\), timeout=10\)/);
  const fail = source.match(/^fail\(\) \{[^\n]+$/m)?.[0];
  assert.ok(fail);
  const fakePython = [
    "calls=0",
    "python3() {",
    "  calls=$((calls + 1))",
    "  printf 'python call %s args: %s\\n' \"$calls\" \"$*\"",
    "  cat >/dev/null",
    "  if [ \"$calls\" = \"$SIMULATED_FAILURE_AT\" ]; then",
    "    return \"$SIMULATED_PYTHON_STATUS\"",
    "  fi",
    "}",
  ].join("\n");
  return spawnSync("bash", ["-s"], {
    input: ["set -euo pipefail", fail, fakePython, probe].join("\n"),
    encoding: "utf8",
    env: {...process.env, SIMULATED_FAILURE_AT: String(failureAt), SIMULATED_PYTHON_STATUS: String(exitStatus)},
  });
}

test("image binding exit probe requires all 20 fresh Python exits with fault traces", () => {
  const result = runImageExitProbe(0, 0);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.match(/exited cleanly/g)?.length, 20);
  assert.equal(result.stdout.match(/python call \d+ args: -X faulthandler -u -/g)?.length, 20);
  assert.ok(result.stdout.indexOf("20/20 exited cleanly") > result.stdout.indexOf("python call 20"));
});

for (const exitStatus of [139, 1]) {
  test(`image binding exit probe stops at first failed exit (${exitStatus})`, () => {
    const result = runImageExitProbe(3, exitStatus);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout.match(/python call/g)?.length, 3);
    assert.equal(result.stdout.match(/exited cleanly/g)?.length, 2);
    assert.doesNotMatch(result.stdout, /4\/20|20\/20/);
    assert.match(result.stderr, new RegExp(`binding exit probe 3/20 failed.*${exitStatus}`));
  });
}

// Run only the actual cache selector against real temporary directory trees.
function selectImageLauncher(t, entries, {failTraversal = false} = {}) {
  const fixture = mkdtempSync(join(tmpdir(), "image-launcher-"));
  t.after(() => rmSync(fixture, {recursive: true, force: true}));
  const fixtureHome = join(fixture, "home with spaces");
  mkdirSync(join(fixtureHome, ".cache"), {recursive: true});
  for (const [relative, timestamp] of entries) {
    const dir = join(fixtureHome, ".cache", relative);
    mkdirSync(dir, {recursive: true});
    utimesSync(dir, timestamp, timestamp);
  }
  const source = readFileSync(new URL("../../images/runtime-peer/smoke.sh", import.meta.url), "utf8");
  const selection = source.match(/^LAUNCHER_DIR=[\s\S]*?(?=\nCONN_FILE=)/m)?.[0];
  assert.ok(selection, "must find the actual launcher cache selection");
  const fail = source.match(/^fail\(\) \{[^\n]+$/m)?.[0];
  assert.ok(fail);
  // Model an unrelated unreadable/disappearing descendant after a valid match,
  // independent of filesystem permissions or whether the test runs as root.
  const find = failTraversal ? [
    'find() {',
    '  printf "100 %s\\n" "$FIXTURE_HOME"/.cache/*/launcher/nteract_kernel_launcher',
    '  printf "find: unrelated cache entry disappeared\\n" >&2',
    '  return 1',
    '}',
  ].join("\n") : "";
  // Substitute only the cache root; never repoint HOME or touch a real cache.
  const result = spawnSync("bash", ["-s"], {
    input: ["set -euo pipefail", fail, find, selection.replaceAll("$HOME/.cache", "$FIXTURE_HOME/.cache"), 'printf "selected parent: %s\\n" "$PYTHONPATH_PARENT"'].join("\n"),
    encoding: "utf8",
    env: {...process.env, FIXTURE_HOME: fixtureHome},
  });
  return {...result, fixtureHome};
}

test("image launch shape excludes newer conda and UV site-packages from PYTHONPATH", (t) => {
  const result = selectImageLauncher(t, [
    ["runt-nightly/launcher/nteract_kernel_launcher", 100],
    ["runt-nightly/envs/runtimed-uv-new/lib/python3.13/site-packages/nteract_kernel_launcher", 200],
    ["runt-nightly/envs/runtimed-conda-new/lib/python3.13/site-packages/nteract_kernel_launcher", 300],
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(`selected parent: ${result.fixtureHome}/.cache/runt-nightly/launcher\n`));
  assert.doesNotMatch(result.stdout, /site-packages/);
});

test("image launch shape rejects environment launchers when standalone cache is missing", (t) => {
  const result = selectImageLauncher(t, [
    ["runt-nightly/envs/runtimed-conda-new/lib/python3.13/site-packages/nteract_kernel_launcher", 300],
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /standalone nteract_kernel_launcher cache not found/);
  assert.doesNotMatch(result.stdout, /selected parent:/);
});

test("image launch shape still selects the newest eligible standalone cache", (t) => {
  const result = selectImageLauncher(t, [
    ["runt/launcher/nteract_kernel_launcher", 100],
    ["runt-nightly/launcher/nteract_kernel_launcher", 200],
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(`selected parent: ${result.fixtureHome}/.cache/runt-nightly/launcher\n`));
});

test("image launch shape avoids unrelated cache traversal failures", (t) => {
  const result = selectImageLauncher(t, [
    ["runt-nightly/launcher/nteract_kernel_launcher", 100],
    ["uv/temporary-install", 200],
  ], {failTraversal: true});
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(`selected parent: ${result.fixtureHome}/.cache/runt-nightly/launcher\n`));
});

test("image launch shape preserves spaces in standalone cache paths", (t) => {
  const result = selectImageLauncher(t, [
    ["runt cache/launcher/nteract_kernel_launcher", 100],
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(`selected parent: ${result.fixtureHome}/.cache/runt cache/launcher\n`));
});

test("Linux Rust Tests provisions the pinned Ruff before running tests", () => {
  const job = workflowJobs(workflow("build")).get("linux-rust-tests");
  const step = workflowStep(job, "Install Ruff for Rust tests");
  const tools = readFileSync(new URL("../../crates/kernel-launch/src/tools.rs", import.meta.url), "utf8");
  const version = tools.match(/pub const RUFF_TARGET_VERSION: &str = "([^"]+)";/)?.[1];
  assert.ok(version, "must find the daemon's Ruff version");
  assert.ok(step.includes(`version="${version}"`));
  assert.ok(job.indexOf(workflowStep(job, "Install uv")) < job.indexOf(step));
  assert.ok(job.indexOf(step) < job.indexOf(workflowStep(job, "Run tests")));
});

for (const failure of ["install", "version-command", "version-mismatch", null]) {
  test(`Ruff prerequisite ${failure ? `rejects ${failure} failure` : "installs in runner-local directories and publishes PATH"}`, (t) => {
    const job = workflowJobs(workflow("build")).get("linux-rust-tests");
    const step = workflowStep(job, "Install Ruff for Rust tests");
    const script = step.split("        run: |\n")[1];
    assert.ok(script, "must exercise the actual Ruff installation step");
    const fixture = mkdtempSync(join(tmpdir(), "ruff prerequisite "));
    t.after(() => rmSync(fixture, {recursive: true, force: true}));
    const bin = join(fixture, "bin");
    const toolBin = join(fixture, "ruff-bin");
    mkdirSync(bin);
    mkdirSync(toolBin);
    writeFileSync(join(bin, "uv"), [
      "#!/bin/sh",
      'printf "%s\\n" "$@" > "$RUNNER_TEMP/uv-args"',
      'printf "%s\\n" "$UV_TOOL_DIR" "$UV_TOOL_BIN_DIR" > "$RUNNER_TEMP/uv-env"',
      `exit ${failure === "install" ? 23 : 0}`,
    ].join("\n"), {mode: 0o755});
    writeFileSync(join(bin, "ruff"), "#!/bin/sh\nexit 91\n", {mode: 0o755});
    writeFileSync(join(toolBin, "ruff"), [
      "#!/bin/sh",
      'printf "%s\\n" "$0" "$@" > "$RUNNER_TEMP/ruff-args"',
      `printf "ruff ${failure === "version-mismatch" ? "0.0.0" : "0.15.11"}\\n"`,
      `exit ${failure === "version-command" ? 29 : 0}`,
    ].join("\n"), {mode: 0o755});
    const result = spawnSync("/bin/bash", ["-s"], {
      input: script.split("\n").map(line => line.replace(/^ {10}/, "")).join("\n"),
      encoding: "utf8",
      timeout: 10_000,
      env: {PATH: bin, RUNNER_TEMP: fixture, GITHUB_PATH: join(fixture, "github-path")},
    });
    assert.ifError(result.error);
    assert.equal(readFileSync(join(fixture, "uv-args"), "utf8"), "tool\ninstall\n--python\n/usr/bin/python3\n--no-python-downloads\n--no-config\nruff==0.15.11\n");
    assert.equal(readFileSync(join(fixture, "uv-env"), "utf8"), `${fixture}/ruff-tools\n${toolBin}\n`);
    if (failure === "install") {
      assert.throws(() => readFileSync(join(fixture, "ruff-args")), {code: "ENOENT"});
    } else {
      assert.equal(readFileSync(join(fixture, "ruff-args"), "utf8"), `${toolBin}/ruff\n--version\n`);
    }
    if (failure) {
      assert.equal(result.status, failure === "install" ? 23 : failure === "version-command" ? 29 : 1, result.stderr);
      assert.throws(() => readFileSync(join(fixture, "github-path")), {code: "ENOENT"});
    } else {
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /ruff 0\.15\.11/);
      assert.equal(readFileSync(join(fixture, "github-path"), "utf8"), `${toolBin}\n`);
    }
  });
}

for (const failure of ["download", "checksum", "archive", null]) {
  test(`Deno bootstrap ${failure ? `rejects ${failure} failure without fallback` : "installs after all integrity checks pass"}`, (t) => {
    const fixture = mkdtempSync(join(tmpdir(), "deno-bootstrap-"));
    t.after(() => rmSync(fixture, {recursive: true, force: true}));
    const bin = join(fixture, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "curl"), `#!/bin/sh\nexit ${failure === "download" ? 1 : 0}\n`, {mode: 0o755});
    writeFileSync(join(bin, "sha256sum"), `#!/bin/sh\ncat >/dev/null\nexit ${failure === "checksum" ? 1 : 0}\n`, {mode: 0o755});
    writeFileSync(join(bin, "unzip"), [
      "#!/bin/sh",
      `if [ "$1" = "-tq" ]; then exit ${failure === "archive" ? 1 : 0}; fi`,
      '[ "$1" = "-q" ] || exit 2',
      'printf "#!/bin/sh\\necho qualified-deno\\n" > "$4/deno"',
    ].join("\n"), {mode: 0o755});
    writeFileSync(join(bin, "npm"), "#!/bin/sh\necho npm-fallback\nexit 1\n", {mode: 0o755});
    const step = workflow("build").match(/      - name: Install Deno\n        run: \|\n([\s\S]*?)(?=\n      - name:)/)?.[1];
    assert.ok(step, "must exercise the actual Deno installation step");
    const result = spawnSync("bash", ["-s"], {
      input: step.split("\n").map(line => line.replace(/^ {10}/, "")).join("\n"),
      encoding: "utf8",
      env: {...process.env, PATH: `${bin}:${process.env.PATH}`, RUNNER_TEMP: fixture, GITHUB_PATH: join(fixture, "github-path")},
    });
    assert.doesNotMatch(result.stdout, /npm-fallback/);
    if (failure) {
      assert.notEqual(result.status, 0, `${failure} failure must fail the job`);
      assert.doesNotMatch(result.stdout, /qualified-deno/);
    } else {
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /qualified-deno/);
      assert.equal(readFileSync(join(fixture, "github-path"), "utf8"), `${fixture}/deno/bin\n`);
    }
  });
}
