import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { routesFor } from "./deployment/routes.mjs";
import { deploymentProfile } from "./deployment/profiles.mjs";
import { isolatedPublicationPlan, publishIsolated } from "./deployment/isolated-publication.mjs";

const tunnelId = "12345678-1234-4123-8123-123456789abc";
const accountId = "1cfb529b94b3d6cde3aaf49d1d6ed5e6";
const sharedConfig =
  "tunnel: b08c5d4e-41e9-4b75-8ada-4d4b84b58770\ningress:\n  - service: http_status:404\n";
const deployment = deploymentProfile("page3").deployment;
const input = {
  manifest: { source_sha: "a".repeat(40), deployment },
  ownership: { hostname: deployment.hostname, prefix: deployment.prefix },
  credentials: {
    AccountTag: accountId,
    TunnelID: tunnelId,
    TunnelSecret: Buffer.alloc(32, 42).toString("base64"),
  },
  tunnelReceipt: {
    schema: 1,
    account_id: accountId,
    tunnel_id: tunnelId,
    name: "nteract-page3",
    config_src: "local",
  },
  sharedConfig,
};

function inputFor(target) {
  const deployment = deploymentProfile(target).deployment;
  return {
    ...input,
    target,
    manifest: { ...input.manifest, deployment },
    ownership: { hostname: deployment.hostname, prefix: deployment.prefix },
    tunnelReceipt: { ...input.tunnelReceipt, name: deployment.service },
  };
}

test("dedicated page3 plan cannot use shared or unowned tunnel credentials", () => {
  const plan = isolatedPublicationPlan(input);
  assert.equal(plan.service, "cloudflared-page3.service");
  assert.match(plan.config, /hostname: page3.runtimed.run/);
  assert.match(plan.config, /http:\/\/127.0.0.1:9473/);
  assert.ok(plan.config.endsWith("  - service: http_status:404\n"));
  assert.doesNotMatch(plan.config, /pages-next|\*\.runtimed.run/);
  assert.doesNotMatch(plan.unit, /\/etc\/cloudflared\/|cloudflared\.service/);
  assert.ok(!JSON.stringify(plan).includes(input.credentials.TunnelSecret));
  for (const changed of [
    { manifest: { ...input.manifest, deployment: deploymentProfile().deployment } },
    { tunnelReceipt: { ...input.tunnelReceipt, name: "existing-tunnel" } },
    { credentials: { ...input.credentials, AccountTag: "f".repeat(32) } },
    { sharedConfig: "tunnel: " + tunnelId + "\n" },
    { sharedConfig: "unrecognized shared config" },
  ])
    assert.throws(() => isolatedPublicationPlan({ ...input, ...changed }));
});

function fixture(
  t,
  { failStart = false, failRestart = false, interruptRollback = null, target = "page3" } = {},
) {
  const current = inputFor(target);
  const profile = deploymentProfile(target);
  const service = profile.deployment.service;
  const configDir = "/etc/" + service;
  const root = fs.mkdtempSync(path.join(tmpdir(), "page3-isolated-publication-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const local = (file) => path.join(root, file);
  const write = (file, value, mode = 0o600) => {
    fs.mkdirSync(path.dirname(local(file)), { recursive: true });
    fs.writeFileSync(local(file), value, { mode });
  };
  const stage = "/tmp/" + service + "-stage-test1234";
  for (const [file, value] of [
    [stage + "/manifest.json", current.manifest],
    [configDir + "/ownership.json", current.ownership],
    [configDir + "/tunnel.json", current.credentials],
    [configDir + "/tunnel-provisioning.json", current.tunnelReceipt],
  ])
    write(file, JSON.stringify(value));
  write("/etc/cloudflared/config.yml", sharedConfig);
  fs.mkdirSync(local("/etc/systemd/system"), { recursive: true });
  for (const frozenTarget of profile.frozenTargets ?? []) {
    const frozen = deploymentProfile(frozenTarget);
    for (const unit of [frozen.deployment.service + ".service", frozen.tunnelService].filter(
      Boolean,
    ))
      write("/etc/systemd/system/" + unit, "unchanged " + unit);
    if (frozen.tunnelService)
      write(
        "/etc/" + frozen.deployment.service + "/tunnel.yml",
        "tunnel: abcdef12-1234-4123-8123-123456789abc\ningress:\n  - service: http_status:404\n",
      );
  }
  const writes = [],
    calls = [];
  const filesystem = {
    existsSync: (file) => fs.existsSync(local(file)),
    readFileSync: (file, ...args) => fs.readFileSync(local(file), ...args),
    lstatSync: (file) => {
      const stat = fs.lstatSync(local(file));
      stat.uid = 0;
      return stat;
    },
    renameSync: (from, to) => {
      writes.push(to);
      const staged = fs.readFileSync(local(from), "utf8");
      const oldConfig = isolatedPublicationPlan(current).config.replace("|mermaid[.]js|", "|");
      if (
        (interruptRollback === "config" && to.endsWith("/tunnel.yml") && staged === oldConfig) ||
        (interruptRollback === "receipt" &&
          to.endsWith("/tunnel-installation.json") &&
          JSON.parse(staged).config_sha256 === digest(oldConfig))
      ) {
        interruptRollback = null;
        throw Error("injected interruption before rollback rename");
      }
      return fs.renameSync(local(from), local(to));
    },
    writeFileSync: (file, ...args) => {
      writes.push(file);
      return fs.writeFileSync(local(file), ...args);
    },
  };
  let active = false,
    frozenPid = "12345";
  const run = (command, args) => {
    calls.push({ command, args });
    if (command === "systemctl") {
      if (args[0] === "show") {
        if (args[1] === "cloudflared.service") return "3393474";
        return args.includes("--property=MainPID") ? frozenPid : "not-found";
      }
      if (args[0] === "is-active") return args[1] === service || active ? "active" : "inactive";
      if (args[0] === "restart") {
        if (failRestart) {
          failRestart = false;
          throw Error("injected connector restart failure");
        }
        active = true;
      }
      if (args[0] === "start") {
        if (failStart) {
          failStart = false;
          throw Error("injected connector startup failure");
        }
        active = true;
      }
      return "";
    }
    if (command === "curl") return JSON.stringify({ ok: true, prototype: "pages-celld-native" });
    if (command === "systemd-analyze") return "";
    if (command === "/usr/bin/cloudflared") {
      if (args.includes("validate")) return "OK";
      const pathname = new URL(args.at(-1)).pathname;
      const contents = fs.readFileSync(local(args[1]), "utf8");
      const pattern = new RegExp(/^    path: (.+)$/m.exec(contents)[1]);
      return (
        "service: " +
        (pattern.test(pathname) ? "http://" + profile.deployment.listen : "http_status:404")
      );
    }
    throw Error("Unexpected command " + command);
  };
  return {
    execute: () => publishIsolated(stage, { filesystem, run }),
    executeWith: (mutate) =>
      publishIsolated(stage, {
        filesystem,
        run: (command, args) => {
          const result = run(command, args);
          if (command === "systemctl" && args[0] === "start") mutate();
          return result;
        },
      }),
    changeFrozenPid: () => {
      frozenPid = "54321";
    },
    write,
    writes,
    calls,
    local,
  };
}

test("publishing and retrying page3 only starts the dedicated connector", (t) => {
  const f = fixture(t);
  const first = f.execute();
  assert.equal(first.sharedTunnelUnchanged, true);
  f.execute();
  assert.ok(
    f.writes.every(
      (file) =>
        file.startsWith("/etc/nteract-page3/") ||
        file === "/etc/systemd/system/cloudflared-page3.service",
    ),
  );
  assert.equal(fs.readFileSync(f.local("/etc/cloudflared/config.yml"), "utf8"), sharedConfig);
  assert.ok(
    f.calls
      .filter(({ command, args }) => command === "systemctl" && args[1] === "cloudflared.service")
      .every(({ args }) => args[0] === "show"),
  );
  assert.ok(
    f.calls
      .filter(
        ({ command, args }) =>
          command === "systemctl" && ["start", "enable", "restart", "stop"].includes(args[0]),
      )
      .every(({ args }) => args[1] === "cloudflared-page3.service"),
  );
  assert.equal(
    f.calls.some(({ command, args }) => command === "systemctl" && args[0] === "restart"),
    false,
  );
});

test("failed dedicated startup retries the exact installation without touching shared connector", (t) => {
  const f = fixture(t, { failStart: true });
  assert.throws(f.execute, /injected connector/);
  const before = fs.readFileSync(f.local("/etc/nteract-page3/tunnel-installation.json"), "utf8");
  assert.equal(f.execute().published, true);
  assert.equal(
    fs.readFileSync(f.local("/etc/nteract-page3/tunnel-installation.json"), "utf8"),
    before,
  );
});

test("dedicated publisher refuses unowned or changed files instead of replacing them", (t) => {
  const unowned = fixture(t);
  unowned.write("/etc/systemd/system/cloudflared-page3.service", "foreign service");
  assert.throws(unowned.execute, /Unowned dedicated/);
  assert.equal(unowned.writes.length, 0);
  const changed = fixture(t);
  changed.execute();
  changed.write("/etc/nteract-page3/tunnel.yml", "foreign configuration");
  assert.throws(changed.execute, /Dedicated tunnel file differs/);
  assert.equal(
    fs.readFileSync(changed.local("/etc/nteract-page3/tunnel.yml"), "utf8"),
    "foreign configuration",
  );
});

const digest = (text) => createHash("sha256").update(text).digest("hex");
function previousInstallation(f, { pending = false, newConfig = false } = {}) {
  const plan = isolatedPublicationPlan(input);
  const oldConfig = plan.config.replace("|mermaid[.]js|", "|");
  const receipt = (config, extra = {}) =>
    JSON.stringify({
      schema: 1,
      tunnel_id: tunnelId,
      config_sha256: digest(config),
      unit_sha256: digest(plan.unit),
      ...extra,
    }) + "\n";
  const oldReceipt = receipt(oldConfig);
  const newReceipt = receipt(plan.config);
  f.write(plan.configPath, newConfig ? plan.config : oldConfig);
  f.write(plan.unitPath, plan.unit);
  f.write(
    "/etc/nteract-page3/tunnel-installation.json",
    pending ? receipt(plan.config, { previous_config_sha256: digest(oldConfig) }) : oldReceipt,
  );
  return { plan, oldConfig, oldReceipt, newReceipt };
}

test("page3 admits the exact Mermaid asset path; existing pages-next routes stay frozen", () => {
  const current = new RegExp(/^    path: (.+)$/m.exec(routesFor("page3"))[1]);
  const frozen = new RegExp(/^    path: (.+)$/m.exec(routesFor("pages-next"))[1]);
  assert.equal(current.test("/mermaid.js"), true);
  assert.equal(frozen.test("/mermaid.js"), false);
  for (const path of [
    "/mermaidXjs",
    "/mermaid.js/",
    "/mermaid.js/private",
    "/renderer.js",
    "/state",
    "/internal/create",
  ])
    assert.equal(current.test(path), false, path);
});

test("known page3 route upgrade restarts only its dedicated connector then becomes a no-op", (t) => {
  const f = fixture(t);
  const expected = previousInstallation(f);
  assert.equal(f.execute().routesUpdated, true);
  assert.equal(fs.readFileSync(f.local(expected.plan.configPath), "utf8"), expected.plan.config);
  assert.equal(
    fs.readFileSync(f.local("/etc/nteract-page3/tunnel-installation.json"), "utf8"),
    expected.newReceipt,
  );
  assert.equal(fs.readFileSync(f.local("/etc/cloudflared/config.yml"), "utf8"), sharedConfig);
  assert.equal(f.execute().routesUpdated, false);
  const restarts = f.calls.filter(
    ({ command, args }) => command === "systemctl" && args[0] === "restart",
  );
  assert.deepEqual(
    restarts.map(({ args }) => args[1]),
    ["cloudflared-page3.service"],
  );
  assert.ok(f.writes.every((file) => file.startsWith("/etc/nteract-page3/")));
});

for (const newConfig of [false, true]) {
  test(`interrupted route upgrade resumes with ${newConfig ? "new" : "old"} config bytes and a pending receipt`, (t) => {
    const f = fixture(t);
    const expected = previousInstallation(f, { pending: true, newConfig });
    assert.equal(f.execute().routesUpdated, true);
    assert.equal(
      fs.readFileSync(f.local("/etc/nteract-page3/tunnel-installation.json"), "utf8"),
      expected.newReceipt,
    );
    assert.equal(
      f.calls.filter(({ command, args }) => command === "systemctl" && args[0] === "restart")
        .length,
      1,
    );
  });
}

test("failed dedicated upgrade restores exact old config and receipt before retry", (t) => {
  const f = fixture(t, { failRestart: true });
  const expected = previousInstallation(f);
  assert.throws(f.execute, /injected connector restart failure/);
  assert.equal(fs.readFileSync(f.local(expected.plan.configPath), "utf8"), expected.oldConfig);
  assert.equal(
    fs.readFileSync(f.local("/etc/nteract-page3/tunnel-installation.json"), "utf8"),
    expected.oldReceipt,
  );
  assert.equal(f.execute().routesUpdated, true);
  assert.equal(fs.readFileSync(f.local("/etc/cloudflared/config.yml"), "utf8"), sharedConfig);
  assert.ok(
    f.calls
      .filter(({ command, args }) => command === "systemctl" && args[0] === "restart")
      .every(({ args }) => args[1] === "cloudflared-page3.service"),
  );
});

test("route migration rejects unknown receipt, modified unit/config, and unreceipted new bytes before writes", (t) => {
  for (const changed of ["receipt", "unit", "config", "new-with-old-receipt"]) {
    const f = fixture(t);
    const expected = previousInstallation(f, { newConfig: changed === "new-with-old-receipt" });
    if (changed === "receipt")
      f.write("/etc/nteract-page3/tunnel-installation.json", "unknown receipt");
    if (changed === "unit")
      f.write(expected.plan.unitPath, expected.plan.unit + "# foreign change\n");
    if (changed === "config")
      f.write(expected.plan.configPath, expected.oldConfig + "# foreign change\n");
    assert.throws(
      f.execute,
      /Dedicated tunnel (installation differs|migration requires exact previous files)/,
    );
    assert.equal(f.writes.length, 0);
    assert.equal(
      f.calls.some(
        ({ command, args }) => command === "systemctl" && ["restart", "start"].includes(args[0]),
      ),
      false,
    );
  }
});

for (const interruptRollback of ["config", "receipt"]) {
  test(`retry completes after interrupted rollback ${interruptRollback} rename leaves its staged bytes`, (t) => {
    const f = fixture(t, { failRestart: true, interruptRollback });
    const expected = previousInstallation(f);
    assert.throws(f.execute, /injected interruption before rollback rename/);
    const beforeRetry = fs.readFileSync(
      f.local("/etc/nteract-page3/tunnel-installation.json"),
      "utf8",
    );
    assert.ok(
      JSON.parse(beforeRetry).previous_config_sha256,
      "the pending receipt remains until an active configuration is confirmed",
    );
    assert.equal(f.execute().routesUpdated, true);
    assert.equal(fs.readFileSync(f.local(expected.plan.configPath), "utf8"), expected.plan.config);
    assert.equal(
      fs.readFileSync(f.local("/etc/nteract-page3/tunnel-installation.json"), "utf8"),
      expected.newReceipt,
    );
    assert.equal(fs.readFileSync(f.local("/etc/cloudflared/config.yml"), "utf8"), sharedConfig);
    assert.ok(
      f.calls
        .filter(({ command, args }) => command === "systemctl" && args[0] === "restart")
        .every(({ args }) => args[1] === "cloudflared-page3.service"),
    );
  });
}

test("page3 generated tunnel configuration stays byte-identical to the frozen deployment", () => {
  const id = "9e9b461a-1f04-46b4-a635-72b547035d28";
  const plan = isolatedPublicationPlan({
    ...input,
    credentials: { ...input.credentials, TunnelID: id },
    tunnelReceipt: { ...input.tunnelReceipt, tunnel_id: id },
  });
  assert.equal(
    digest(plan.config),
    "6d611f651e87767a8c144b47cb40da4fb153c909178eb543aa9e6b55d47fc8ee",
  );
  assert.equal(
    digest(plan.unit),
    "881a11628ebf81ca02fbb50ba8c837ec4ef9f37c6e77a68c08317c451b0f4c5e",
  );
});

test("page4 plan owns its hostname, paths and connector and refuses frozen tunnel reuse", () => {
  const value = inputFor("page4"),
    plan = isolatedPublicationPlan(value);
  assert.equal(plan.service, "cloudflared-page4.service");
  assert.equal(plan.configPath, "/etc/nteract-page4/tunnel.yml");
  assert.equal(plan.unitPath, "/etc/systemd/system/cloudflared-page4.service");
  assert.match(plan.config, /hostname: page4.runtimed.run/);
  assert.match(plan.config, /http:\/\/127.0.0.1:9474/);
  assert.doesNotMatch(plan.config + plan.unit, /page3|pages-next|9473|19473/);
  assert.throws(
    () =>
      isolatedPublicationPlan({ ...value, frozenTunnelConfigs: ["tunnel: " + tunnelId + "\n"] }),
    /different tunnel/,
  );
  assert.throws(
    () => isolatedPublicationPlan({ ...value, target: "page3" }),
    /Unexpected deployment target/,
  );
  assert.throws(() => isolatedPublicationPlan(inputFor("pages-next")), /dedicated tunnel target/);
  const route = new RegExp(/^    path: (.+)$/m.exec(routesFor("page4"))[1]);
  for (const pathname of ["/", "/mermaid.js", "/mcp", "/llms.txt", "/oidc", "/api/sync"])
    assert.equal(route.test(pathname), true, pathname);
  for (const pathname of ["/state", "/mermaid.js/private", "/internal/create", "/api/config"])
    assert.equal(route.test(pathname), false, pathname);
});

test("page4 publication and retries touch only its connector and preserve both frozen targets", (t) => {
  const f = fixture(t, { target: "page4" });
  for (let i = 0; i < 2; i++) {
    const result = f.execute();
    assert.deepEqual(result.frozenTargetsUnchanged, ["pages-next", "page3"]);
    assert.equal(result.sharedTunnelUnchanged, true);
    assert.equal(result.routesUpdated, false);
  }
  assert.ok(
    f.writes.every(
      (file) =>
        file.startsWith("/etc/nteract-page4/") ||
        file === "/etc/systemd/system/cloudflared-page4.service",
    ),
  );
  assert.ok(
    f.calls
      .filter(
        ({ command, args }) =>
          command === "systemctl" && ["start", "restart", "stop", "enable"].includes(args[0]),
      )
      .every(({ args }) => args[1] === "cloudflared-page4.service"),
  );
  assert.equal(
    f.calls.some(({ command, args }) => command === "systemctl" && args[0] === "restart"),
    false,
  );
  assert.equal(fs.readFileSync(f.local("/etc/cloudflared/config.yml"), "utf8"), sharedConfig);
});

for (const mutation of ["config", "pid"])
  test(`page4 publication detects changed frozen ${mutation} without claiming isolation`, (t) => {
    const f = fixture(t, { target: "page4" });
    assert.throws(
      () =>
        f.executeWith(() =>
          mutation === "config"
            ? f.write("/etc/nteract-page3/tunnel.yml", "foreign change")
            : f.changeFrozenPid(),
        ),
      /Frozen Pages (configuration|service) changed/,
    );
  });

test("page4 rejects an unrecognized receipt instead of applying page3 historical migrations", (t) => {
  const f = fixture(t, { target: "page4" });
  f.execute();
  const before = f.writes.length;
  f.write("/etc/nteract-page4/tunnel-installation.json", "{}\n");
  assert.throws(f.execute, /Dedicated tunnel installation differs/);
  assert.equal(f.writes.length, before);
});
