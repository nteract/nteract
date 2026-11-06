import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  QUALIFIED_TARGETS,
  assertQualifiedDeploymentTarget,
  deploymentProfile,
} from "./deployment/profiles.mjs";

const scripts = path.dirname(fileURLToPath(import.meta.url));
const frozen = ["pages-next", "page3", "page4", "page5", "page6", "page7", "page8", "page9"];

test("current build qualifies Page10, Pages and Pages2 while historical profiles remain inspectable", () => {
  assert.deepEqual(QUALIFIED_TARGETS, ["page10", "pages", "pages2"]);
  for (const target of QUALIFIED_TARGETS)
    assert.doesNotThrow(() => assertQualifiedDeploymentTarget(target), target);
  for (const target of frozen) {
    assert.ok(deploymentProfile(target).deployment.hostname);
    assert.throws(
      () => assertQualifiedDeploymentTarget(target),
      /qualified only for page10, pages and pages2/,
    );
  }
});

test("operator entrypoints reject every frozen target and implicit default before external calls", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "pages-release-guard-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const called = path.join(directory, "external-call");
  // A missing guard must fail locally even on a workstation with working SSH.
  for (const command of ["ssh", "scp"])
    writeFileSync(path.join(directory, command), `#!/bin/sh\ntouch '${called}'\nexit 97\n`, {
      mode: 0o700,
    });
  const env = {
    ...process.env,
    PATH: directory + path.delimiter + process.env.PATH,
    CLOUDFLARE_API_TOKEN: "",
  };
  const reject = (entry, args) => {
    const result = spawnSync(process.execPath, [path.join(scripts, entry), ...args], {
      env,
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(result.status, 1, `${entry} ${args.join(" ")}: ${result.stderr}`);
    assert.match(result.stderr, /This build is qualified only for page10, pages and pages2/);
    assert.equal(existsSync(called), false, "qualification must precede SSH/SCP");
  };
  for (const target of [undefined, ...frozen]) {
    const selected = target ?? "pages-next";
    const prefix = target ? ["--target", target] : [];
    const stage = `/tmp/${deploymentProfile(selected).deployment.service}-stage-ZZguard1`;
    reject("deploy.mjs", [...prefix, "prepare"]);
    reject("deploy.mjs", [...prefix, "upload", path.join(directory, "absent-stage")]);
    reject("deploy.mjs", [...prefix, "install", stage, "--apply"]);
    reject("deploy.mjs", [...prefix, "provision"]);
    reject("deploy.mjs", [...prefix, "provision", "--apply"]);
    reject("deploy.mjs", [...prefix, "publish", stage, "--apply"]);
    reject("deploy.mjs", [...prefix, "rotate-key"]);
    reject("deploy.mjs", [...prefix, "retire-key", "--apply", "--from", "k2"]);
    reject("deployment/firewall.mjs", prefix);
    reject("deployment/dns.mjs", [...prefix, "12345678-1234-4123-8123-123456789abc", "--apply"]);
    reject("deployment/tunnel.mjs", [...prefix, "--apply"]);
  }
  for (const target of frozen) {
    const stage = `/tmp/${deploymentProfile(target).deployment.service}-stage-ZZguard1`;
    reject("deployment/install.mjs", [stage, "--apply"]);
    reject("deployment/publish.mjs", [stage, "--apply"]);
  }
});

for (const target of QUALIFIED_TARGETS)
  test(`${target} provision needs a token from the environment before any external call`, (t) => {
    const directory = mkdtempSync(path.join(tmpdir(), `${target}-provision-guard-`));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const called = path.join(directory, "external-call");
    for (const command of ["ssh", "scp"])
      writeFileSync(path.join(directory, command), `#!/bin/sh\ntouch '${called}'\nexit 97\n`, {
        mode: 0o700,
      });
    const env = { ...process.env, PATH: directory + path.delimiter + process.env.PATH };
    delete env.CLOUDFLARE_API_TOKEN;
    for (const [args, message] of [
      [["provision"], /Cloudflare token required/],
      [["provision", "--apply"], /Cloudflare token required/],
      [["provision", "--force"], /Usage: deploy[.]mjs/],
      [["provision", "--apply", "extra"], /Usage: deploy[.]mjs/],
    ]) {
      const result = spawnSync(
        process.execPath,
        [path.join(scripts, "deploy.mjs"), "--target", target, ...args],
        { env, encoding: "utf8", timeout: 5000 },
      );
      assert.equal(result.status, 1, `${args.join(" ")}: ${result.stderr}`);
      assert.match(result.stderr, message);
      assert.equal(existsSync(called), false, "provision must not reach SSH without a token");
    }
  });

// A fake ssh: `cat <stage>/manifest.json` prints `manifest`; any other command
// logs its arguments to `log` and prints `{}`.
const fakeSsh = (log, manifest) =>
  `#!/bin/sh\ncase "$*" in\n  *"cat "*manifest.json*) cat '${manifest}' ;;\n  *) printf '%s\\n' "$@" > '${log}'; echo '{}' ;;\nesac\n`;

test("install refuses an old staged plain format before the host installer", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "page10-install-storage-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const log = path.join(directory, "ssh-args");
  const manifest = path.join(directory, "manifest.json");
  writeFileSync(
    manifest,
    JSON.stringify({
      source_sha: "d".repeat(40),
      build_receipt: {
        build_id: "9ae4ed83e44e",
        record_storage: ["local", "buffered", "automerge"],
      },
    }),
  );
  writeFileSync(path.join(directory, "ssh"), fakeSsh(log, manifest), { mode: 0o700 });
  const env = { ...process.env, PATH: directory + path.delimiter + process.env.PATH };
  const stage = `/tmp/${deploymentProfile("page10").deployment.service}-stage-ZZstorag`;
  const result = spawnSync(
    process.execPath,
    [path.join(scripts, "deploy.mjs"), "--target", "page10", "install", stage, "--apply"],
    { env, encoding: "utf8", timeout: 5000 },
  );
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Refusing release d{12} \(build 9ae4ed83e44e\) for page10: /);
  assert.equal(existsSync(log), false, "the host installer must not run");
  assert.match(result.stderr, /plain_storage_formats/);
});

test("install --restart reaches the host installer; other extra flags do not", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "page10-install-restart-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const log = path.join(directory, "ssh-args");
  const manifest = path.join(directory, "manifest.json");
  writeFileSync(
    manifest,
    JSON.stringify({
      source_sha: "a".repeat(40),
      build_receipt: {
        build_id: "0123456789ab",
        record_storage: ["local", "buffered", "automerge"],
        plain_storage_formats: ["doc-store-v2-host-actor-prefix"],
      },
    }),
  );
  writeFileSync(path.join(directory, "ssh"), fakeSsh(log, manifest), { mode: 0o700 });
  const env = { ...process.env, PATH: directory + path.delimiter + process.env.PATH };
  const stage = `/tmp/${deploymentProfile("page10").deployment.service}-stage-ZZrstart`;
  const deploy = (...args) =>
    spawnSync(process.execPath, [path.join(scripts, "deploy.mjs"), "--target", "page10", ...args], {
      env,
      encoding: "utf8",
      timeout: 5000,
    });
  const lastCommand = () =>
    existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").at(-1) : "";

  let result = deploy("install", stage, "--apply", "--restart");
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    lastCommand(),
    /install[.]mjs' '\/tmp\/nteract-page10-stage-ZZrstart' --apply --restart$/,
  );
  result = deploy("install", stage, "--apply");
  assert.equal(result.status, 0, result.stderr);
  assert.match(lastCommand(), /--apply$/);
  rmSync(log);
  for (const args of [
    ["install", stage, "--apply", "--force"],
    ["publish", stage, "--apply", "--restart"],
    ["install", stage, "--apply", "--restart", "extra"],
  ]) {
    result = deploy(...args);
    assert.equal(result.status, 1, args.join(" "));
    assert.match(result.stderr, /Unexpected deployment argument/);
    assert.equal(existsSync(log), false, "rejected flags must not reach SSH");
  }
});

test("rotate-key streams this checkout's keyring helper to the host under the deployment lock", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "page10-rotate-key-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const log = path.join(directory, "ssh-args");
  const input = path.join(directory, "ssh-stdin");
  writeFileSync(
    path.join(directory, "ssh"),
    `#!/bin/sh\nprintf '%s\\n' "$@" > '${log}'\ncat > '${input}'\necho '{"applied":false}'\n`,
    { mode: 0o700 },
  );
  const env = { ...process.env, PATH: directory + path.delimiter + process.env.PATH };
  const deploy = (...args) =>
    spawnSync(process.execPath, [path.join(scripts, "deploy.mjs"), "--target", "page10", ...args], {
      env,
      encoding: "utf8",
      timeout: 5000,
    });
  const result = deploy("rotate-key", "--apply", "--from", "k1");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '{"applied":false}');
  const [, , host, command] = readFileSync(log, "utf8").trim().split("\n");
  assert.equal(host, deploymentProfile("page10").deployment.host);
  assert.equal(
    command,
    "sudo flock -n /run/nteract-pages-next-deploy.lock node --input-type=module - 'rotate' " +
      "'--file' '/etc/nteract-page10/session-keys.json' " +
      "'--secret-file' '/etc/nteract-page10/session-secret' '--apply' '--from' 'k1'",
  );
  assert.equal(
    readFileSync(input, "utf8"),
    readFileSync(path.join(scripts, "deployment", "session-keys.mjs"), "utf8"),
  );
  rmSync(log);
  const refused = deploy("rotate-key", "--force");
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /Usage: session-keys/);
  assert.equal(existsSync(log), false, "bad options never reach the host");
});
