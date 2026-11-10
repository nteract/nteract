import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEPLOYMENT_TARGETS,
  QUALIFIED_TARGETS,
  assertQualifiedDeploymentTarget,
  deploymentProfile,
} from "./deployment/profiles.mjs";

const scripts = path.dirname(fileURLToPath(import.meta.url));

test("deployment targets are exactly the four qualified profiles", () => {
  assert.deepEqual(QUALIFIED_TARGETS, ["page10", "pages", "pages2", "page11"]);
  assert.deepEqual(DEPLOYMENT_TARGETS, QUALIFIED_TARGETS);
  for (const target of QUALIFIED_TARGETS)
    assert.doesNotThrow(() => assertQualifiedDeploymentTarget(target), target);
  assert.throws(() => assertQualifiedDeploymentTarget("pages-next"), /Unknown Pages/);
});

test("operator entrypoints reject an unnamed or unknown target before external calls", (t) => {
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
  const reject = (entry, args, message) => {
    const result = spawnSync(process.execPath, [path.join(scripts, entry), ...args], {
      env,
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(result.status, 1, `${entry} ${args.join(" ")}: ${result.stderr}`);
    assert.match(result.stderr, message);
    assert.equal(existsSync(called), false, "target selection must precede SSH/SCP");
  };
  const unnamed = /Name the Pages deployment target with --target/;
  const unknown = /Unknown Pages deployment target/;
  for (const [prefix, message] of [
    [[], unnamed],
    [["--target", "pages-next"], unknown],
    [["--target", "elsewhere"], unknown],
  ]) {
    const stage = "/tmp/nteract-pages-live-stage-ZZguard1";
    reject("deploy.mjs", [...prefix, "prepare"], message);
    reject("deploy.mjs", [...prefix, "upload", path.join(directory, "absent-stage")], message);
    reject("deploy.mjs", [...prefix, "install", stage, "--apply"], message);
    reject("deploy.mjs", [...prefix, "provision"], message);
    reject("deploy.mjs", [...prefix, "provision", "--apply"], message);
    reject("deploy.mjs", [...prefix, "publish", stage, "--apply"], message);
    reject("deploy.mjs", [...prefix, "rotate-key"], message);
    reject("deploy.mjs", [...prefix, "retire-key", "--apply", "--from", "k2"], message);
    reject("deployment/firewall.mjs", prefix, message);
    reject(
      "deployment/dns.mjs",
      [...prefix, "12345678-1234-4123-8123-123456789abc", "--apply"],
      message,
    );
    reject("deployment/tunnel.mjs", [...prefix, "--apply"], message);
  }
  for (const entry of ["deployment/install.mjs", "deployment/publish.mjs"])
    reject(
      entry,
      ["/tmp/nteract-pages-next-stage-ZZguard1", "--apply"],
      /Explicit prepared stage for a known Pages target required/,
    );
});

test("page11 plan prints only its target without SSH", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "page11-plan-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const called = path.join(directory, "called");
  writeFileSync(path.join(directory, "ssh"), `#!/bin/sh\ntouch '${called}'\nexit 97\n`, {
    mode: 0o700,
  });
  const result = spawnSync(
    process.execPath,
    [path.join(scripts, "deploy.mjs"), "--target", "page11", "plan"],
    {
      encoding: "utf8",
      timeout: 5000,
      env: { ...process.env, PATH: directory + path.delimiter + process.env.PATH },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), deploymentProfile("page11").deployment);
  assert.equal(existsSync(called), false);
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
      "'--secret-file' '/etc/nteract-page10/session-secret' '--move-secret' '--apply' '--from' 'k1'",
  );
  assert.equal(
    readFileSync(input, "utf8"),
    readFileSync(path.join(scripts, "deployment", "session-keys.mjs"), "utf8"),
  );
  // Page10 issues OAuth grants, so retiring waits their 30-day lifetime.
  assert.equal(deploy("retire-key").status, 0);
  assert.match(
    readFileSync(log, "utf8"),
    /'--installed'\n?.*'\/etc\/nteract-page10\/session-keys-active.json' '--state-url' 'http:\/\/127[.]0[.]0[.]1:19480\/state' '--overlap-days' '30'/,
  );
  rmSync(log);
  const refused = deploy("rotate-key", "--force");
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /Usage: session-keys/);
  assert.equal(existsSync(log), false, "bad options never reach the host");
});
