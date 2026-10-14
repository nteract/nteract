import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {test} from "node:test";
import {fileURLToPath} from "node:url";

const script = fileURLToPath(new URL("../ci/runtime-peer-image-debug.sh", import.meta.url));
const probe = readFileSync(new URL("../ci/runtime-peer-binding-exit-gdb.sh", import.meta.url), "utf8");

function fakeProbe(failureAt, exitStatus) {
  const fn = probe.match(/^run_probes\(\) \{\n[\s\S]*?^\}/m)?.[0];
  assert.ok(fn, "test the actual debugger loop without its daemon startup");
  return spawnSync("bash", ["-s"], {
    input: [
      "set -euo pipefail",
      "PROBE_FILE=/fake/probe.py",
      "calls=0",
      "gdb() {",
      "  calls=$((calls + 1))",
      "  printf 'debugger call %s args: %s\\n' \"$calls\" \"$*\"",
      "  if [ \"$calls\" = \"$FAKE_FAILURE_AT\" ]; then",
      "    printf 'captured failure trace\\n'",
      "    return \"$FAKE_EXIT_STATUS\"",
      "  fi",
      "}",
      fn,
      "run_probes",
    ].join("\n"),
    encoding: "utf8",
    env: {...process.env, FAKE_FAILURE_AT: String(failureAt), FAKE_EXIT_STATUS: String(exitStatus)},
  });
}

test("debugger probe requires 20 clean child exits and requests all-thread stacks", () => {
  const result = fakeProbe(0, 0);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.match(/exited cleanly/g)?.length, 20);
  assert.equal(result.stdout.match(/--batch --nx --return-child-result/g)?.length, 20);
  assert.equal(result.stdout.match(/thread apply all backtrace/g)?.length, 20);
  assert.equal(result.stdout.match(/--args python3 -X faulthandler -u \/fake\/probe.py/g)?.length, 20);
  assert.match(result.stdout, /set disable-randomization off/);
});

for (const exitStatus of [139, 255, 1]) {
  test(`debugger probe preserves first failed child/tracer status ${exitStatus}`, () => {
    const result = fakeProbe(3, exitStatus);
    assert.equal(result.status, exitStatus, result.stderr);
    assert.equal(result.stdout.match(/debugger call/g)?.length, 3);
    assert.equal(result.stdout.match(/exited cleanly/g)?.length, 2);
    assert.match(result.stdout, /captured failure trace/);
    assert.doesNotMatch(result.stdout, /4\/20|20\/20/);
    assert.match(result.stderr, new RegExp(`3/20 failed.*${exitStatus}`));
  });
}

function fakeImageDiagnostic(t, {status = 0, mismatch = false} = {}) {
  const fixture = mkdtempSync(join(tmpdir(), "image-debug-fixture-"));
  t.after(() => rmSync(fixture, {recursive: true, force: true}));
  const bin = join(fixture, "bin");
  const output = join(fixture, "output");
  const calls = join(fixture, "docker-calls.jsonl");
  mkdirSync(bin);
  writeFileSync(join(bin, "docker"), [
    `#!${process.execPath}`,
    'const fs = require("node:fs");',
    'const args = process.argv.slice(2);',
    'fs.appendFileSync(process.env.FAKE_CALLS, JSON.stringify(args) + "\\n");',
    'if (args[0] === "build") {',
    '  fs.writeFileSync(process.env.FAKE_DOCKERFILE, fs.readFileSync(0));',
    '} else if (args[0] === "run") {',
    '  const debug = args.includes("test-image:built-debug");',
    '  const entry = args[args.indexOf("--entrypoint") + 1];',
    '  if (entry === "python3") {',
    '    const kind = args.at(-1);',
    '    const changed = debug && (kind === "libraries" || process.env.FAKE_MISMATCH === "true");',
    '    console.log(JSON.stringify({[kind]: changed ? "changed" : "ordinary"}));',
    '  } else if (entry === "dpkg-query") {',
    '    console.log("libc6\\t2.36");',
    '    if (debug) console.log("gdb\\t13.1");',
    '  } else if (entry === "bash") {',
    '    console.log("fake native stack evidence");',
    '    process.exit(Number(process.env.FAKE_STATUS));',
    '  } else process.exit(91);',
    '} else process.exit(92);',
  ].join("\n"), {mode: 0o755});
  const result = spawnSync("bash", [script, "test-image:built", output], {
    encoding: "utf8",
    env: {
      ...process.env, GITHUB_ACTIONS: "true", PATH: `${bin}:${process.env.PATH}`,
      FAKE_CALLS: calls, FAKE_DOCKERFILE: join(fixture, "Dockerfile"),
      FAKE_STATUS: String(status), FAKE_MISMATCH: String(mismatch),
    },
  });
  return {
    ...result, output,
    calls: readFileSync(calls, "utf8").trim().split("\n").map(JSON.parse),
    dockerfile: readFileSync(join(fixture, "Dockerfile"), "utf8"),
  };
}

test("diagnostic derivative records library/package differences and preserves production identity", (t) => {
  const result = fakeImageDiagnostic(t);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.dockerfile, /^FROM test-image:built\nUSER root\n/);
  assert.match(result.dockerfile, /--no-install-recommends --no-upgrade gdb/);
  assert.match(result.dockerfile, /USER runt\n$/);
  assert.match(readFileSync(join(result.output, "packages.diff"), "utf8"), /\+gdb\s+13\.1/);
  assert.match(readFileSync(join(result.output, "libraries.diff"), "utf8"), /changed/);
  assert.equal(readFileSync(join(result.output, "ordinary-identity.json"), "utf8"),
    readFileSync(join(result.output, "debug-identity.json"), "utf8"));
  assert.match(readFileSync(join(result.output, "gdb-probe.log"), "utf8"), /fake native stack evidence/);
  assert.ok(result.calls.every(args => ["build", "run"].includes(args[0])));
  assert.doesNotMatch(JSON.stringify(result.calls), /--privileged|--cap-add|--security-opt|sysctl/);
});

test("diagnostic derivative refuses changed interpreter or native identity before RPC", (t) => {
  const result = fakeImageDiagnostic(t, {mismatch: true});
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /changed interpreter\/libpython\/native binding identity; refusing/);
  assert.ok(!result.calls.some(args => args.includes("/diagnostics/probe.sh")));
});

for (const status of [139, 255]) {
  test(`image diagnostic preserves failed probe status ${status} through log capture`, (t) => {
    const result = fakeImageDiagnostic(t, {status});
    assert.equal(result.status, status, result.stderr);
    assert.match(readFileSync(join(result.output, "gdb-probe.log"), "utf8"), /fake native stack evidence/);
    assert.equal(result.calls.filter(args => args.includes("/diagnostics/probe.sh")).length, 1);
  });
}

test("debugger scripts reject local invocation before attempting container or daemon work", () => {
  for (const path of [script, fileURLToPath(new URL("../ci/runtime-peer-binding-exit-gdb.sh", import.meta.url))]) {
    const result = spawnSync("bash", [path], {encoding: "utf8", env: {...process.env, GITHUB_ACTIONS: "false"}});
    assert.equal(result.status, 2);
    assert.match(result.stderr, /CI-only diagnostic/);
  }
});

test("PR debugger capture cannot replace or erase the ordinary release-image gate", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/release-validation.yml", import.meta.url), "utf8");
  const job = workflow.match(/^  runtime-peer-image:\n[\s\S]*?(?=^  windows-npm-packaging:)/m)?.[0];
  assert.ok(job);
  const ordinary = job.indexOf('bash scripts/ci/runtime-peer-image-smoke.sh "$IMAGE" "$EXPECTED_VERSION"');
  const diagnostic = job.indexOf('bash scripts/ci/runtime-peer-image-debug.sh "$IMAGE"');
  assert.ok(ordinary >= 0 && diagnostic > ordinary);
  assert.match(job, /id: image-smoke/);
  assert.match(job, /!cancelled\(\) && \(steps\.image-smoke\.outcome == 'success' \|\| steps\.image-smoke\.outcome == 'failure'\)/);
  assert.match(job, /set -o pipefail\n[^\n]*runtime-peer-image-debug\.sh[^\n]*\| tee/);
  assert.match(job, /actions\/upload-artifact@v7/);
  assert.doesNotMatch(job, /continue-on-error|docker push|push: true|packages: write/);
  for (const path of ["scripts/ci/runtime-peer-image-debug.sh", "scripts/ci/runtime-peer-binding-exit-gdb.sh", "scripts/tests/runtime-peer-image-debug.test.mjs"]) {
    assert.ok(workflow.includes(`      - ${path}\n`), `missing diagnostic PR trigger: ${path}`);
  }
  assert.match(workflow, /run: node --test[^\n]*scripts\/tests\/runtime-peer-image-debug\.test\.mjs/);
  for (const path of ["../../.github/workflows/release-common.yml", "../../images/runtime-peer/Dockerfile"]) {
    assert.doesNotMatch(readFileSync(new URL(path, import.meta.url), "utf8"), /runtime-peer-image-debug|\bgdb\b/);
  }
});
