import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertQualifiedDeploymentTarget, deploymentProfile } from "./deployment/profiles.mjs";

const scripts = path.dirname(fileURLToPath(import.meta.url));
const frozen = ["pages-next", "page3", "page4", "page5", "page6", "page7"];

test("current build qualifies Page8 while historical profiles remain inspectable", () => {
  assert.doesNotThrow(() => assertQualifiedDeploymentTarget("page8"));
  for (const target of frozen) {
    assert.ok(deploymentProfile(target).deployment.hostname);
    assert.throws(() => assertQualifiedDeploymentTarget(target), /qualified only for page8/);
  }
});

test("operator entrypoints reject every frozen target and implicit default before external calls", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "page8-release-guard-"));
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
    assert.match(result.stderr, /This build is qualified only for page8/);
    assert.equal(existsSync(called), false, "qualification must precede SSH/SCP");
  };
  for (const target of [undefined, ...frozen]) {
    const selected = target ?? "pages-next";
    const prefix = target ? ["--target", target] : [];
    const stage = `/tmp/${deploymentProfile(selected).deployment.service}-stage-ZZguard1`;
    reject("deploy.mjs", [...prefix, "prepare"]);
    reject("deploy.mjs", [...prefix, "upload", path.join(directory, "absent-stage")]);
    reject("deploy.mjs", [...prefix, "install", stage, "--apply"]);
    reject("deploy.mjs", [...prefix, "publish", stage, "--apply"]);
    reject("deployment/firewall.mjs", prefix);
    reject("deployment/dns.mjs", [...prefix, "12345678-1234-4123-8123-123456789abc", "--apply"]);
  }
  for (const target of frozen) {
    const stage = `/tmp/${deploymentProfile(target).deployment.service}-stage-ZZguard1`;
    reject("deployment/install.mjs", [stage, "--apply"]);
    reject("deployment/publish.mjs", [stage, "--apply"]);
  }
});
