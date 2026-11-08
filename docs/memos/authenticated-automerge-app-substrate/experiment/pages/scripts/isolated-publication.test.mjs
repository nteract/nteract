import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import {
  routesFor,
  accountPaths,
  assetPaths,
  cardImagePaths,
  imagePaths,
  indexPaths,
  linkPreviewPaths,
  projectAssetPaths,
  projectPaths,
  siftPaths,
  whoamiPaths,
} from "./deployment/routes.mjs";
import { isIndexRoute, readPageRoute } from "../shared/routes.mjs";
import { deploymentProfile } from "./deployment/profiles.mjs";
import {
  isolatedPublicationPlan,
  publishIsolated,
  runCommand,
  unitActive,
} from "./deployment/isolated-publication.mjs";
import { execFileSync } from "node:child_process";

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
  {
    failStart = false,
    failRestart = false,
    interruptRollback = null,
    target = "page3",
    misroutePath = null,
    neverReady = false,
    readyConnections = 4,
    failStop = null,
    // Whether the host runs lab1's shared connector config.
    sharedTunnel = true,
  } = {},
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
  if (sharedTunnel) write("/etc/cloudflared/config.yml", sharedConfig);
  fs.mkdirSync(local("/etc/systemd/system"), { recursive: true });
  for (const frozenTarget of profile.frozenTargets ?? []) {
    const frozen = deploymentProfile(frozenTarget);
    const connectors = frozen.tunnelSlots
      ? Object.values(frozen.tunnelSlots).map((slot) => slot.service)
      : [frozen.tunnelService];
    for (const unit of [frozen.deployment.service + ".service", ...connectors].filter(Boolean))
      write("/etc/systemd/system/" + unit, "unchanged " + unit);
    if (frozen.tunnelService)
      write(
        "/etc/" + frozen.deployment.service + "/tunnel.yml",
        "tunnel: abcdef12-1234-4123-8123-123456789abc\ningress:\n  - service: http_status:404\n",
      );
    if (frozen.tunnelSlots)
      for (const name of ["tunnel-installation.json", "tunnel-connector.json"])
        write("/etc/" + frozen.deployment.service + "/" + name, "unchanged " + name);
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
      const oldConfig = priorConfig(isolatedPublicationPlan(current).config, target);
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
  let frozenPid = "12345";
  const changedFrozenPids = new Map();
  // Every unit that serves this target's tunnel, and a snapshot of the active
  // ones after each systemctl change. systemd's restart stops before it starts,
  // so a restart records the moment its unit is down.
  const connectors = [profile.tunnelService, ...connectorSlots(target).map((s) => s.service)];
  const activeUnits = new Set();
  const timeline = [];
  const snapshot = () =>
    timeline.push(
      connectors
        .filter((unit) => activeUnits.has(unit))
        .sort()
        .join(","),
    );
  const run = (command, args) => {
    calls.push({ command, args });
    if (command === "systemctl") {
      if (args[0] === "show") {
        if (args[1] === "cloudflared.service") return "3393474";
        return args.includes("--property=MainPID")
          ? (changedFrozenPids.get(args[1]) ?? frozenPid)
          : "not-found";
      }
      // Exit codes as systemctl reports them: is-active exits 0 only for an
      // active unit, 3 for an inactive one and 4 for one systemd doesn't know.
      // Lifecycle verbs on a unit without a unit file fail too.
      const known = args[1] === service || fs.existsSync(local("/etc/systemd/system/" + args[1]));
      if (args[0] === "is-active") {
        if (args[1] === service || activeUnits.has(args[1])) return "active";
        throw systemctlExit(known ? 3 : 4, "inactive");
      }
      if (["start", "restart", "stop"].includes(args[0]) && !known) throw systemctlExit(5, "");
      if (["enable", "disable"].includes(args[0]) && !known) throw systemctlExit(1, "");
      if (args[0] === "restart") {
        if (activeUnits.delete(args[1])) snapshot();
        if (failRestart) {
          failRestart = false;
          throw Error("injected connector restart failure");
        }
        activeUnits.add(args[1]);
        snapshot();
      }
      if (args[0] === "start") {
        if (failStart) {
          failStart = false;
          throw Error("injected connector startup failure");
        }
        activeUnits.add(args[1]);
        snapshot();
      }
      if (args[0] === "stop" && args[1] === failStop) {
        failStop = null;
        throw Error("injected connector stop failure");
      }
      if (args[0] === "stop" && activeUnits.delete(args[1])) snapshot();
      return "";
    }
    if (command === "curl" && args.at(-1).endsWith("/ready")) {
      const slot = connectorSlots(target).find(
        (s) => args.at(-1) === "http://" + s.metrics + "/ready",
      );
      if (!slot || !activeUnits.has(slot.service) || neverReady)
        throw Error("curl failed (status 22)");
      return JSON.stringify({ status: 200, readyConnections, connectorId: tunnelId });
    }
    if (command === "curl") return JSON.stringify({ ok: true, prototype: "pages-celld-native" });
    if (command === "systemd-analyze") return "";
    if (command === "/usr/bin/cloudflared") {
      if (args.includes("validate")) return "OK";
      const pathname = new URL(args.at(-1)).pathname;
      const contents = fs.readFileSync(local(args[1]), "utf8");
      const pattern = new RegExp(/^    path: (.+)$/m.exec(contents)[1]);
      const forwarded = pattern.test(pathname) !== (pathname === misroutePath);
      return "service: " + (forwarded ? "http://" + profile.deployment.listen : "http_status:404");
    }
    throw Error("Unexpected command " + command);
  };
  const sleep = (ms) => sleeps.push(ms);
  const sleeps = [];
  return {
    target,
    execute: () => publishIsolated(stage, { filesystem, run, sleep }),
    executeWith: (mutate) =>
      publishIsolated(stage, {
        filesystem,
        sleep,
        run: (command, args) => {
          const result = run(command, args);
          if (command === "systemctl" && args[0] === "start") mutate();
          return result;
        },
      }),
    changeFrozenPid: (unit) => {
      if (unit) changedFrozenPids.set(unit, "54321");
      else frozenPid = "54321";
    },
    activate: (unit) => {
      activeUnits.add(unit);
      snapshot();
    },
    activeUnits,
    timeline,
    sleeps,
    failNextStart: () => {
      failStart = true;
    },
    setNeverReady: (value) => {
      neverReady = value;
    },
    write,
    writes,
    calls,
    local,
  };
}
// The error runCommand throws for a non-zero exit: it keeps the status.
const systemctlExit = (status, stdout) =>
  Object.assign(Error("systemctl failed (status " + status + "); inspect restricted server logs"), {
    status,
    stdout,
  });
function connectorSlots(target) {
  const slots = deploymentProfile(target).tunnelSlots;
  return slots ? ["a", "b"].map((name) => ({ name, ...slots[name] })) : [];
}
const lifecycle = (f) =>
  f.calls
    .filter(
      ({ command, args }) =>
        command === "systemctl" &&
        ["start", "restart", "stop", "enable", "disable"].includes(args[0]),
    )
    .map(({ args }) => args.join(" "));

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
// A live target's routes without link previews, card images and Project
// assets: the route set the release before them sealed.
const beforePreviews = (config) =>
  config.replace(linkPreviewPaths, "").replace(cardImagePaths, "").replace(projectAssetPaths, "");
function priorConfig(config, target) {
  return target === "page5"
    ? config.replace("|connect|connect[.]js|", "|")
    : target === "page7"
      ? config.replace(imagePaths, "")
      : target === "page8"
        ? config.replace("|theme[.]js|", "|")
        : target === "page9"
          ? config.replace(indexPaths, "")
          : target === "page10" || target === "pages"
            ? beforePreviews(config).replace(accountPaths, "").replace(whoamiPaths, "")
            : config.replace("|mermaid[.]js|", "|");
}
const configDir = (target) => "/etc/" + deploymentProfile(target).deployment.service;
function previousInstallation(f, { pending = false, newConfig = false } = {}) {
  const plan = isolatedPublicationPlan(inputFor(f.target));
  const oldConfig = priorConfig(plan.config, f.target);
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
    configDir(f.target) + "/tunnel-installation.json",
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

test("Page8 admits only the exact theme asset while every older route receipt stays frozen", () => {
  const frozen = {
    "pages-next": "2dbfabe3e649e0f79afc9df766e0a19c52177b76667d89ad8e45acaaf523e5f3",
    page3: "db474e430d27227ee9bf407beee948ad6cf7f601fafd55c60bbf34effa38200a",
    page4: "9c5872feed6898ee236a96dc70226c625d5c3a299c3c3866b351b0f4b41f47de",
    page5: "4bda4497169b48213638b5085f4ce5e2b9c335cf483d501f965e1c7f8fd8321c",
    page6: "5240e6014b88bddb73115809c273da72b7e15e5516b67f43db8ed66ad82a12ac",
    page7: "ed30a9fe9aef61a9f8f42451d81bea1c7fb399181b529081d138a91d259730a8",
  };
  for (const [target, expected] of Object.entries(frozen)) {
    assert.equal(digest(routesFor(target)), expected, target);
    const route = new RegExp(/^    path: (.+)$/m.exec(routesFor(target))[1]);
    assert.equal(route.test("/theme.js"), false, target);
  }
  const current = routesFor("page8");
  assert.equal(
    digest(priorConfig(current, "page8")),
    "e0a13fdeda80d2edfd1ec8d341045929def65b8e2eba35c1da4cdc8c4be28af7",
    "the permitted migration must start from Page8's exact deployed route bytes",
  );
  const route = new RegExp(/^    path: (.+)$/m.exec(current)[1]);
  assert.equal(route.test("/theme.js"), true);
  for (const pathname of ["/themeXjs", "/theme.js/", "/theme.js/private", "/theme.css"])
    assert.equal(route.test(pathname), false, pathname);
});

test("Page9 admits only hashed viewer files while every older route receipt stays frozen", () => {
  const frozen = {
    "pages-next": "2dbfabe3e649e0f79afc9df766e0a19c52177b76667d89ad8e45acaaf523e5f3",
    page3: "db474e430d27227ee9bf407beee948ad6cf7f601fafd55c60bbf34effa38200a",
    page4: "9c5872feed6898ee236a96dc70226c625d5c3a299c3c3866b351b0f4b41f47de",
    page5: "4bda4497169b48213638b5085f4ce5e2b9c335cf483d501f965e1c7f8fd8321c",
    page6: "5240e6014b88bddb73115809c273da72b7e15e5516b67f43db8ed66ad82a12ac",
    page7: "ed30a9fe9aef61a9f8f42451d81bea1c7fb399181b529081d138a91d259730a8",
    page8: "c5fb35e6dfc9e1483cf813ed4a3b4c3c84b9bb3d551244aa98f89c5d0e36836a",
  };
  for (const [target, expected] of Object.entries(frozen)) {
    assert.equal(digest(routesFor(target)), expected, target);
    const route = new RegExp(/^    path: (.+)$/m.exec(routesFor(target))[1]);
    for (const pathname of ["/chunks/ABCDEFGH.js", "/app-ABCDEFGH.js", "/automerge-ABCDEFGH.wasm"])
      assert.equal(route.test(pathname), false, `${target} ${pathname}`);
  }
  const current = routesFor("page9");
  // The hashed-asset routes are part of the config Page9 serves (#4582), as
  // are Project links (#4585). Removing the index routes, Project links and
  // hashed assets gives back #4578's chunk-route config.
  assert.equal(
    digest(priorConfig(current, "page9").replace(projectPaths, "").replace(assetPaths, "")),
    "f18afa2a0c82ddad000a3724e8c940d0208a46d6c3f50101bd337492e2d59cd7",
  );
  const route = new RegExp(/^    path: (.+)$/m.exec(current)[1]);
  for (const pathname of [
    "/chunks/ABCDEFGH.js",
    "/chunks/C5DM4OBS.js",
    "/chunks/ZZZZ2222.js",
    "/app-ABCDEFGH.js",
    "/app-ZONXTRV2.css",
    "/theme-PYDRB3DW.js",
    "/mermaid-ETH6F3P4.js",
    "/automerge-FJQTWO5F.wasm",
    "/subduction-Y5U24H5D.wasm",
  ])
    assert.equal(route.test(pathname), true, pathname);
  for (const pathname of [
    "/chunks/",
    "/chunks/abcdefgh.js",
    "/chunks/ABCDEFG1.js",
    "/chunks/ABCDEFGHI.js",
    "/chunks/ABCDEFG.js",
    "/chunks/ABCDEFGH.css",
    "/chunks/ABCDEFGH.js/",
    "/chunks/ABCDEFGH.js/private",
    "/chunks/nested/ABCDEFGH.js",
    "/ABCDEFGH.js",
    "/app-abcdefgh.js",
    "/app-ABCDEFG.js",
    "/app-ABCDEFGHI.js",
    "/app-ABCDEFGH.wasm",
    "/app-ABCDEFGH.js/",
    "/app-ABCDEFGH.js/private",
    "/theme-ABCDEFGH.css",
    "/mermaid-ABCDEFGH.css",
    "/automerge-ABCDEFGH.js",
    "/subduction-ABCDEFGH.css",
    "/connect-ABCDEFGH.js",
    "/index-ABCDEFGH.html",
    "/chunks/app-ABCDEFGH.js",
  ])
    assert.equal(route.test(pathname), false, pathname);
});

const projectUuid = "12345678-1234-4123-8123-123456789abc";
test("Page9 admits exact Project links while every older route receipt stays frozen", () => {
  const frozen = {
    "pages-next": "2dbfabe3e649e0f79afc9df766e0a19c52177b76667d89ad8e45acaaf523e5f3",
    page3: "db474e430d27227ee9bf407beee948ad6cf7f601fafd55c60bbf34effa38200a",
    page4: "9c5872feed6898ee236a96dc70226c625d5c3a299c3c3866b351b0f4b41f47de",
    page5: "4bda4497169b48213638b5085f4ce5e2b9c335cf483d501f965e1c7f8fd8321c",
    page6: "5240e6014b88bddb73115809c273da72b7e15e5516b67f43db8ed66ad82a12ac",
    page7: "ed30a9fe9aef61a9f8f42451d81bea1c7fb399181b529081d138a91d259730a8",
    page8: "c5fb35e6dfc9e1483cf813ed4a3b4c3c84b9bb3d551244aa98f89c5d0e36836a",
  };
  for (const [target, expected] of Object.entries(frozen)) {
    assert.equal(digest(routesFor(target)), expected, target);
    const route = new RegExp(/^    path: (.+)$/m.exec(routesFor(target))[1]);
    for (const pathname of [`/project/prj_${projectUuid}`, `/s/sp_${projectUuid}`])
      assert.equal(route.test(pathname), false, `${target} ${pathname}`);
  }
  const current = routesFor("page9");
  // #4585 added Project links to #4582's hashed-asset config.
  assert.equal(
    digest(priorConfig(current, "page9").replace(projectPaths, "")),
    "f96c389fd51d3e1e3c1e76ab4c005e578cb2cc13123c256c4025c7237dc1d4b5",
  );
  const route = new RegExp(/^    path: (.+)$/m.exec(current)[1]);
  const admitted = [
    `/project/prj_${projectUuid}`,
    `/project/prj_${projectUuid}/`,
    `/project/sp_${projectUuid}`,
    `/s/sp_${projectUuid}`,
    `/s/sp_${projectUuid}/`,
    `/s/prj_${projectUuid}`,
  ];
  const rejected = [
    "/project",
    "/project/",
    "/s/",
    `/project/${projectUuid}`,
    `/s/${projectUuid}`,
    "/project/prj_not-a-project",
    `/project/prj_${projectUuid.toUpperCase()}`,
    `/project/prj_${projectUuid.replace("-4123-", "-1123-")}`,
    `/project/prj_${projectUuid.replace("-8123-", "-c123-")}`,
    `/project/prj_${projectUuid}0`,
    `/project/pg_${projectUuid}`,
    `/project/sp${projectUuid}`,
    `/project/prj_${projectUuid}//`,
    `/project/prj_${projectUuid}/private`,
    `/project/prj_${projectUuid}/p/${projectUuid}`,
    `/projects/prj_${projectUuid}`,
    `/x/project/prj_${projectUuid}`,
    `/s/sp_${projectUuid}/private`,
    `/space/sp_${projectUuid}`,
    `/p/prj_${projectUuid}`,
  ];
  for (const pathname of admitted) assert.equal(route.test(pathname), true, pathname);
  for (const pathname of rejected) assert.equal(route.test(pathname), false, pathname);
  // Ingress admits exactly the Project paths the viewer opens.
  for (const pathname of [...admitted, ...rejected].filter(
    (pathname) => !pathname.startsWith("/p/"),
  ))
    assert.equal(
      route.test(pathname),
      readPageRoute(pathname).kind === "project",
      `viewer and ingress disagree on ${pathname}`,
    );
});

test("Page9 admits exactly /projects and /pages while every older route receipt stays frozen", () => {
  const frozen = {
    "pages-next": "2dbfabe3e649e0f79afc9df766e0a19c52177b76667d89ad8e45acaaf523e5f3",
    page3: "db474e430d27227ee9bf407beee948ad6cf7f601fafd55c60bbf34effa38200a",
    page4: "9c5872feed6898ee236a96dc70226c625d5c3a299c3c3866b351b0f4b41f47de",
    page5: "4bda4497169b48213638b5085f4ce5e2b9c335cf483d501f965e1c7f8fd8321c",
    page6: "5240e6014b88bddb73115809c273da72b7e15e5516b67f43db8ed66ad82a12ac",
    page7: "ed30a9fe9aef61a9f8f42451d81bea1c7fb399181b529081d138a91d259730a8",
    page8: "c5fb35e6dfc9e1483cf813ed4a3b4c3c84b9bb3d551244aa98f89c5d0e36836a",
  };
  for (const [target, expected] of Object.entries(frozen)) {
    assert.equal(digest(routesFor(target)), expected, target);
    const route = new RegExp(/^    path: (.+)$/m.exec(routesFor(target))[1]);
    for (const pathname of ["/projects", "/projects/", "/pages", "/pages/"])
      assert.equal(route.test(pathname), false, `${target} ${pathname}`);
  }
  const current = routesFor("page9");
  // Page9 serves #4585's Project-link config; the migration adds only the
  // index routes to those exact bytes.
  assert.equal(
    digest(priorConfig(current, "page9")),
    "c4916695004a67dcba3919e95e7958dc3de2c33152ad10ed079a979fa4379b15",
    "the permitted migration must start from Page9's exact deployed route bytes",
  );
  assert.equal(current.split(indexPaths).length, 2, "the index routes appear once");
  const route = new RegExp(/^    path: (.+)$/m.exec(current)[1]);
  const admitted = ["/projects", "/projects/", "/pages", "/pages/"];
  const rejected = [
    "/projects//",
    "/pages//",
    "/projects/private",
    "/pages/private",
    `/pages/${projectUuid}`,
    `/projects/prj_${projectUuid}`,
    "/projectsX",
    "/pagesX",
    "/project",
    "/page",
    "/Pages",
    "/PROJECTS",
    "/x/pages",
    "/pages.json",
    "/projects.txt",
  ];
  for (const pathname of admitted) assert.equal(route.test(pathname), true, pathname);
  for (const pathname of rejected) assert.equal(route.test(pathname), false, pathname);
  // Ingress admits exactly the index paths the viewer opens.
  for (const pathname of [...admitted, ...rejected].filter(
    (pathname) => !readPageRoute(pathname).kind.startsWith("project"),
  ))
    assert.equal(
      route.test(pathname),
      isIndexRoute(readPageRoute(pathname)),
      `viewer and ingress disagree on ${pathname}`,
    );
});

test("page9 publisher refuses to skip the Project-link config on its way to the index routes", (t) => {
  const f = fixture(t, { target: "page9" });
  const plan = isolatedPublicationPlan(inputFor("page9"));
  const assetConfig = priorConfig(plan.config, "page9").replace(projectPaths, "");
  f.write(plan.configPath, assetConfig);
  f.write(plan.unitPath, plan.unit);
  const installation =
    JSON.stringify({
      schema: 1,
      tunnel_id: tunnelId,
      config_sha256: digest(assetConfig),
      unit_sha256: digest(plan.unit),
    }) + "\n";
  f.write("/etc/nteract-page9/tunnel-installation.json", installation);
  assert.throws(f.execute, /Dedicated tunnel installation differs/);
  assert.equal(fs.readFileSync(f.local(plan.configPath), "utf8"), assetConfig);
  assert.equal(
    fs.readFileSync(f.local("/etc/nteract-page9/tunnel-installation.json"), "utf8"),
    installation,
  );
  assert.equal(f.writes.length, 0);
});

test("page9 publisher refuses to skip the hashed-asset config on its way to Project links", (t) => {
  const f = fixture(t, { target: "page9" });
  const plan = isolatedPublicationPlan(inputFor("page9"));
  const chunkConfig = priorConfig(plan.config, "page9")
    .replace(projectPaths, "")
    .replace(assetPaths, "");
  f.write(plan.configPath, chunkConfig);
  f.write(plan.unitPath, plan.unit);
  const installation =
    JSON.stringify({
      schema: 1,
      tunnel_id: tunnelId,
      config_sha256: digest(chunkConfig),
      unit_sha256: digest(plan.unit),
    }) + "\n";
  f.write("/etc/nteract-page9/tunnel-installation.json", installation);
  assert.throws(f.execute, /Dedicated tunnel installation differs/);
  assert.equal(fs.readFileSync(f.local(plan.configPath), "utf8"), chunkConfig);
  assert.equal(
    fs.readFileSync(f.local("/etc/nteract-page9/tunnel-installation.json"), "utf8"),
    installation,
  );
  assert.equal(f.writes.length, 0);
});

test("Page10 serves Page9's route set on its own origin while every older route receipt stays frozen", () => {
  const frozen = {
    "pages-next": "2dbfabe3e649e0f79afc9df766e0a19c52177b76667d89ad8e45acaaf523e5f3",
    page3: "db474e430d27227ee9bf407beee948ad6cf7f601fafd55c60bbf34effa38200a",
    page4: "9c5872feed6898ee236a96dc70226c625d5c3a299c3c3866b351b0f4b41f47de",
    page5: "4bda4497169b48213638b5085f4ce5e2b9c335cf483d501f965e1c7f8fd8321c",
    page6: "5240e6014b88bddb73115809c273da72b7e15e5516b67f43db8ed66ad82a12ac",
    page7: "ed30a9fe9aef61a9f8f42451d81bea1c7fb399181b529081d138a91d259730a8",
    page8: "c5fb35e6dfc9e1483cf813ed4a3b4c3c84b9bb3d551244aa98f89c5d0e36836a",
    // routesFor("page9") with the index routes: the bytes Page9 serves.
    page9: "6cde01edff05cbeeae4820869496dd46479558e57a64dc9851db6e8f1cb75a89",
  };
  for (const [target, expected] of Object.entries(frozen))
    assert.equal(digest(routesFor(target)), expected, target);
  const current = routesFor("page10");
  const page9 = deploymentProfile("page9").deployment;
  const page10 = deploymentProfile("page10").deployment;
  // Page10 copies Page9's route flags and adds Sift and whoami. Otherwise only the
  // hostname and listener differ.
  assert.equal(current.split(siftPaths).length, 2, "the Sift route appears once");
  assert.equal(
    beforePreviews(current)
      .replace(accountPaths, "")
      .replace(whoamiPaths, "")
      .replace(siftPaths, "")
      .replaceAll(page10.hostname, page9.hostname)
      .replaceAll(page10.listen, page9.listen),
    routesFor("page9"),
  );
  assert.doesNotMatch(current, /page9[.]runtimed[.]run|127[.]0[.]0[.]1:9479/);
});

const whoamiRejected = ["/whoami/", "/whoami/private", "/whoamiX", "/Whoami", "/api/whoami"];
test("only explicit live profiles admit exact whoami, never legacy routes", () => {
  for (const target of [
    "pages-next",
    "page3",
    "page4",
    "page5",
    "page6",
    "page7",
    "page8",
    "page9",
    "page10",
    "pages",
  ]) {
    const enabled = ["page10", "pages"].includes(target);
    assert.equal(deploymentProfile(target).whoami === true, enabled);
    for (const legacy of [false, true]) {
      const route = new RegExp(/^    path: (.+)$/m.exec(routesFor(target, legacy))[1]);
      assert.equal(route.test("/whoami"), enabled && !legacy, target);
      assert.equal(
        route.test(new URL("https://example.com/whoami?probe=1").pathname),
        enabled && !legacy,
      );
      for (const pathname of [...whoamiRejected, "/whoami.json", "/x/whoami", "/%77hoami"])
        assert.equal(route.test(pathname), false, `${target} ${pathname}`);
    }
  }
});

test("whoami predecessors retain the exact Sift and pre-Sift route bytes", () => {
  for (const [target, sift, beforeSift] of [
    [
      "page10",
      "6ba30080c9a94d04fe6ba71ec1d123289ab8d885e86aa3279909fd20795f18c8",
      "a2b973dfa57ee7ea2a2ab8d6f0cfca4b7238e6ef12240dfc0a365e03daba9904",
    ],
    [
      "pages",
      "f10e88bd040d7c1a691736ee8619d228a439cd816ae508ed25d5e8096ecc69cd",
      "4aa6f96562532f3c5739fe7ffc44728cd210432abf45a80f74fef383081e6ce5",
    ],
  ]) {
    const prior = beforePreviews(routesFor(target))
      .replace(accountPaths, "")
      .replace(whoamiPaths, "");
    assert.equal(digest(prior), sift);
    assert.equal(digest(prior.replace(siftPaths, "")), beforeSift);
  }
});

for (const target of ["page7", "page8", "page9", "page10", "pages"])
  for (const misroutePath of ["/whoami", ...whoamiRejected])
    test(`${target} refuses misrouted ${misroutePath} before connector activation`, (t) => {
      const f = fixture(t, { target, misroutePath });
      assert.throws(f.execute, /route validation failed/);
      assert.deepEqual(lifecycle(f), []);
    });

test("Page10 and Pages admit exactly Sift's hashed WASM; Page9 never does", () => {
  const page9 = new RegExp(/^    path: (.+)$/m.exec(routesFor("page9"))[1]);
  assert.equal(page9.test("/sift-ABCDEFGH.wasm"), false);
  for (const target of ["page10", "pages"]) {
    const route = new RegExp(/^    path: (.+)$/m.exec(routesFor(target))[1]);
    for (const pathname of ["/sift-ABCDEFGH.wasm", "/sift-EMZCXH4D.wasm"])
      assert.equal(route.test(pathname), true, `${target} ${pathname}`);
    for (const pathname of [
      "/sift.wasm",
      "/sift-abcdefgh.wasm",
      "/sift-ABCDEFG.wasm",
      "/sift-ABCDEFGHI.wasm",
      "/sift-ABCDEFGH.js",
      "/sift-ABCDEFGH.css",
      "/sift-ABCDEFGH.wasm/",
      "/sift-ABCDEFGH.wasm/private",
      "/chunks/sift-ABCDEFGH.wasm",
    ])
      assert.equal(route.test(pathname), false, `${target} ${pathname}`);
  }
});

test("page10 installs fresh and refuses Page9's route predecessors", (t) => {
  const f = fixture(t, { target: "page10" });
  const plan = isolatedPublicationPlan(inputFor("page10"));
  const installation = "/etc/nteract-page10/tunnel-installation.json";
  const receipt = (config, unit = plan.unitSha256) =>
    JSON.stringify({
      schema: 1,
      tunnel_id: tunnelId,
      config_sha256: digest(config),
      unit_sha256: unit,
    }) + "\n";
  const result = f.execute();
  assert.equal(result.routesUpdated, false);
  assert.equal(result.connectorSlot, "a");
  assert.deepEqual(result.frozenTargetsUnchanged, ["page7", "page8", "page9"]);
  assert.equal(fs.readFileSync(f.local(plan.configPath), "utf8"), plan.config);
  assert.equal(fs.readFileSync(f.local(installation), "utf8"), receipt(plan.config));
  assert.deepEqual(lifecycle(f), [
    "start cloudflared-page10-a.service",
    "enable cloudflared-page10-a.service",
  ]);
  assert.equal(fs.existsSync(f.local(plan.unitPath)), false, "no legacy unit on a fresh install");
  // Page9's migration predecessors are not Page10's. Each one is refused,
  // under either connector layout.
  for (const prior of [
    plan.config.replace(indexPaths, ""),
    plan.config.replace(indexPaths, "").replace(projectPaths, ""),
    plan.config.replace("|mermaid[.]js|", "|"),
  ])
    for (const unit of [digest(plan.unit), plan.unitSha256]) {
      assert.notEqual(prior, plan.config);
      const g = fixture(t, { target: "page10" });
      g.write(plan.configPath, prior);
      g.write(plan.unitPath, plan.unit);
      g.write(installation, receipt(prior, unit));
      assert.throws(g.execute, /Dedicated tunnel installation differs/);
      assert.equal(g.writes.length, 0);
      assert.equal(fs.readFileSync(g.local(plan.configPath), "utf8"), prior);
    }
});

test("Page10 refuses Page9 manifests, connector credentials and installation receipts", (t) => {
  const value = inputFor("page10");
  assert.throws(
    () => isolatedPublicationPlan({ ...value, target: "page9" }),
    /Unexpected deployment target/,
  );
  assert.throws(
    () =>
      isolatedPublicationPlan({ ...value, frozenTunnelConfigs: ["tunnel: " + tunnelId + "\n"] }),
    /different tunnel/,
  );
  const f = fixture(t, { target: "page10" });
  const foreign = isolatedPublicationPlan(inputFor("page9"));
  f.write(
    "/etc/nteract-page10/tunnel-installation.json",
    JSON.stringify({
      schema: 1,
      tunnel_id: tunnelId,
      config_sha256: digest(foreign.config),
      unit_sha256: digest(foreign.unit),
    }),
  );
  assert.throws(f.execute, /Dedicated tunnel installation differs/);
  assert.equal(f.writes.length, 0);
});

for (const mutation of ["config", "pid"])
  test(`Page10 publication detects changed frozen Page9 ${mutation}`, (t) => {
    const f = fixture(t, { target: "page10" });
    assert.throws(
      () =>
        f.executeWith(() =>
          mutation === "config"
            ? f.write("/etc/nteract-page9/tunnel.yml", "foreign change")
            : f.changeFrozenPid("cloudflared-page9.service"),
        ),
      /Frozen Pages (configuration|service) changed/,
    );
  });

test("Pages serves Page10's route set on pages.runtimed.run and its own listener", () => {
  const current = routesFor("pages");
  const page10 = deploymentProfile("page10").deployment;
  const pages = deploymentProfile("pages").deployment;
  // Pages copies Page10's route flags. Only the hostname and listener differ.
  assert.equal(
    current.replaceAll(pages.hostname, page10.hostname).replaceAll(pages.listen, page10.listen),
    routesFor("page10"),
  );
  assert.match(current, /^  - hostname: pages[.]runtimed[.]run\n/);
  assert.match(current, /service: http:\/\/127[.]0[.]0[.]1:9481\n/);
  assert.doesNotMatch(current, /page10[.]runtimed[.]run|127[.]0[.]0[.]1:9480/);
});

test("pages installs fresh and refuses Page10's receipts", (t) => {
  const f = fixture(t, { target: "pages" });
  const plan = isolatedPublicationPlan(inputFor("pages"));
  const installation = "/etc/nteract-pages-live/tunnel-installation.json";
  assert.equal(plan.service, "cloudflared-pages-live.service");
  assert.equal(plan.configPath, "/etc/nteract-pages-live/tunnel.yml");
  const result = f.execute();
  assert.equal(result.routesUpdated, false);
  assert.equal(result.service, "cloudflared-pages-live-a.service");
  assert.deepEqual(result.frozenTargetsUnchanged, ["page7", "page8", "page9"]);
  assert.equal(fs.readFileSync(f.local(plan.configPath), "utf8"), plan.config);
  assert.deepEqual(lifecycle(f), [
    "start cloudflared-pages-live-a.service",
    "enable cloudflared-pages-live-a.service",
  ]);
  // Page10's connector bytes are not Pages' to adopt, under either layout.
  const page10 = isolatedPublicationPlan(inputFor("page10"));
  for (const unit of [digest(page10.unit), page10.unitSha256]) {
    const g = fixture(t, { target: "pages" });
    g.write(
      installation,
      JSON.stringify({
        schema: 1,
        tunnel_id: tunnelId,
        config_sha256: digest(page10.config),
        unit_sha256: unit,
      }) + "\n",
    );
    assert.throws(g.execute, /Dedicated tunnel installation differs/);
    assert.equal(g.writes.length, 0);
  }
  assert.throws(
    () => isolatedPublicationPlan({ ...inputFor("pages"), target: "page10" }),
    /Unexpected deployment target/,
  );
});

for (const mutation of ["config", "pid"])
  test(`Pages publication detects changed frozen Page9 ${mutation}`, (t) => {
    const f = fixture(t, { target: "pages" });
    assert.throws(
      () =>
        f.executeWith(() =>
          mutation === "config"
            ? f.write("/etc/nteract-page9/tunnel.yml", "foreign change")
            : f.changeFrozenPid("cloudflared-page9.service"),
        ),
      /Frozen Pages (configuration|service) changed/,
    );
  });

test("OAuth and private images publish only exact Page7 through Pages routes while previous targets remain closed", () => {
  for (const target of [
    "pages-next",
    "page3",
    "page4",
    "page5",
    "page6",
    "page7",
    "page8",
    "page9",
    "page10",
    "pages",
  ]) {
    const route = new RegExp(/^    path: (.+)$/m.exec(routesFor(target))[1]);
    for (const pathname of [
      "/oauth/authorize",
      "/oauth/token",
      "/oauth/revoke",
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
      "/.well-known/oauth-authorization-server",
      "/api/pages/08c583e5-d29e-4f1e-b06b-333965254e94/assets",
      "/api/pages/08c583e5-d29e-4f1e-b06b-333965254e94/assets/" + "a".repeat(64),
    ])
      assert.equal(
        route.test(pathname),
        ["page7", "page8", "page9", "page10", "pages"].includes(target),
        `${target}: ${pathname}`,
      );
    for (const pathname of [
      "/oauth/register",
      "/oauth/test/callback",
      "/oauth/token/private",
      "/.well-known/oauth-protected-resource/private",
      "/api/pages/arbitrary/assets",
      "/api/pages/08c583e5-d29e-4f1e-b06b-333965254e94/assets/arbitrary",
      "/api/pages/08c583e5-d29e-4f1e-b06b-333965254e94/assets/" + "a".repeat(64) + "/private",
    ])
      assert.equal(route.test(pathname), false, `${target}: ${pathname}`);
  }
});

// Single-connector targets restart their connector in place. Page10 and Pages
// hand off between connector slots instead; see the slot tests below.
for (const target of ["page3", "page5", "page7", "page8", "page9"]) {
  const connector = deploymentProfile(target).tunnelService;
  test(`${target} known route upgrade restarts only its dedicated connector then becomes a no-op`, (t) => {
    const f = fixture(t, { target });
    const expected = previousInstallation(f);
    assert.equal(f.execute().routesUpdated, true);
    assert.equal(fs.readFileSync(f.local(expected.plan.configPath), "utf8"), expected.plan.config);
    assert.equal(
      fs.readFileSync(f.local(configDir(target) + "/tunnel-installation.json"), "utf8"),
      expected.newReceipt,
    );
    assert.equal(fs.readFileSync(f.local("/etc/cloudflared/config.yml"), "utf8"), sharedConfig);
    assert.equal(f.execute().routesUpdated, false);
    const restarts = f.calls.filter(
      ({ command, args }) => command === "systemctl" && args[0] === "restart",
    );
    assert.deepEqual(
      restarts.map(({ args }) => args[1]),
      [connector],
    );
    assert.ok(f.writes.every((file) => file.startsWith(configDir(target) + "/")));
  });

  for (const newConfig of [false, true]) {
    test(`${target} interrupted route upgrade resumes with ${newConfig ? "new" : "old"} config bytes and a pending receipt`, (t) => {
      const f = fixture(t, { target });
      const expected = previousInstallation(f, { pending: true, newConfig });
      assert.equal(f.execute().routesUpdated, true);
      assert.equal(
        fs.readFileSync(f.local(configDir(target) + "/tunnel-installation.json"), "utf8"),
        expected.newReceipt,
      );
      assert.equal(
        f.calls.filter(({ command, args }) => command === "systemctl" && args[0] === "restart")
          .length,
        1,
      );
    });
  }

  test(`${target} failed upgrade restores exact old config and receipt before retry`, (t) => {
    const f = fixture(t, { target, failRestart: true });
    const expected = previousInstallation(f);
    assert.throws(f.execute, /injected connector restart failure/);
    assert.equal(fs.readFileSync(f.local(expected.plan.configPath), "utf8"), expected.oldConfig);
    assert.equal(
      fs.readFileSync(f.local(configDir(target) + "/tunnel-installation.json"), "utf8"),
      expected.oldReceipt,
    );
    assert.equal(f.execute().routesUpdated, true);
    assert.equal(fs.readFileSync(f.local("/etc/cloudflared/config.yml"), "utf8"), sharedConfig);
    assert.ok(
      f.calls
        .filter(({ command, args }) => command === "systemctl" && args[0] === "restart")
        .every(({ args }) => args[1] === connector),
    );
  });

  test(`${target} migration rejects unknown receipt, modified unit/config, and unreceipted new bytes before writes`, (t) => {
    for (const changed of ["receipt", "unit", "config", "new-with-old-receipt"]) {
      const f = fixture(t, { target });
      const expected = previousInstallation(f, { newConfig: changed === "new-with-old-receipt" });
      if (changed === "receipt")
        f.write(configDir(target) + "/tunnel-installation.json", "unknown receipt");
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
    test(`${target} retry completes after interrupted rollback ${interruptRollback} rename leaves its staged bytes`, (t) => {
      const f = fixture(t, { target, failRestart: true, interruptRollback });
      const expected = previousInstallation(f);
      assert.throws(f.execute, /injected interruption before rollback rename/);
      const beforeRetry = fs.readFileSync(
        f.local(configDir(target) + "/tunnel-installation.json"),
        "utf8",
      );
      assert.ok(
        JSON.parse(beforeRetry).previous_config_sha256,
        "the pending receipt remains until an active configuration is confirmed",
      );
      assert.equal(f.execute().routesUpdated, true);
      assert.equal(
        fs.readFileSync(f.local(expected.plan.configPath), "utf8"),
        expected.plan.config,
      );
      assert.equal(
        fs.readFileSync(f.local(configDir(target) + "/tunnel-installation.json"), "utf8"),
        expected.newReceipt,
      );
      assert.equal(fs.readFileSync(f.local("/etc/cloudflared/config.yml"), "utf8"), sharedConfig);
      assert.ok(
        f.calls
          .filter(({ command, args }) => command === "systemctl" && args[0] === "restart")
          .every(({ args }) => args[1] === connector),
      );
    });
  }
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

test("page5 plan owns its hostname, paths and connector and refuses frozen tunnel reuse", () => {
  const value = inputFor("page5"),
    plan = isolatedPublicationPlan(value);
  assert.equal(plan.service, "cloudflared-page5.service");
  assert.equal(plan.configPath, "/etc/nteract-page5/tunnel.yml");
  assert.equal(plan.unitPath, "/etc/systemd/system/cloudflared-page5.service");
  assert.match(plan.config, /hostname: page5.runtimed.run/);
  assert.match(plan.config, /http:\/\/127.0.0.1:9475/);
  assert.doesNotMatch(plan.config + plan.unit, /page3|page4|pages-next|9473|19473|9474|19474/);
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
  const route = new RegExp(/^    path: (.+)$/m.exec(routesFor("page5"))[1]);
  for (const pathname of [
    "/",
    "/mermaid.js",
    "/mcp",
    "/llms.txt",
    "/oidc",
    "/api/sync",
    "/api/access",
  ])
    assert.equal(route.test(pathname), true, pathname);
  for (const pathname of [
    "/state",
    "/mermaid.js/private",
    "/internal/create",
    "/api/config",
    "/api/access/private",
  ])
    assert.equal(route.test(pathname), false, pathname);
});

test("page5 publication and retries touch only its connector and preserve all three frozen targets", (t) => {
  const f = fixture(t, { target: "page5" });
  for (let i = 0; i < 2; i++) {
    const result = f.execute();
    assert.deepEqual(result.frozenTargetsUnchanged, ["pages-next", "page3", "page4"]);
    assert.equal(result.sharedTunnelUnchanged, true);
    assert.equal(result.routesUpdated, false);
  }
  assert.ok(
    f.writes.every(
      (file) =>
        file.startsWith("/etc/nteract-page5/") ||
        file === "/etc/systemd/system/cloudflared-page5.service",
    ),
  );
  assert.ok(
    f.calls
      .filter(
        ({ command, args }) =>
          command === "systemctl" && ["start", "restart", "stop", "enable"].includes(args[0]),
      )
      .every(({ args }) => args[1] === "cloudflared-page5.service"),
  );
  assert.equal(
    f.calls.some(({ command, args }) => command === "systemctl" && args[0] === "restart"),
    false,
  );
  assert.equal(fs.readFileSync(f.local("/etc/cloudflared/config.yml"), "utf8"), sharedConfig);
});

for (const mutation of ["config", "pid"])
  test(`page5 publication detects changed frozen ${mutation} without claiming isolation`, (t) => {
    const f = fixture(t, { target: "page5" });
    assert.throws(
      () =>
        f.executeWith(() =>
          mutation === "config"
            ? f.write("/etc/nteract-page4/tunnel.yml", "foreign change")
            : f.changeFrozenPid(),
        ),
      /Frozen Pages (configuration|service) changed/,
    );
  });

test("page5 rejects an unrecognized receipt instead of applying page3 historical migrations", (t) => {
  const f = fixture(t, { target: "page5" });
  f.execute();
  const before = f.writes.length;
  f.write("/etc/nteract-page5/tunnel-installation.json", "{}\n");
  assert.throws(f.execute, /Dedicated tunnel installation differs/);
  assert.equal(f.writes.length, before);
});

test("sharing and setup routes leave all frozen deployment ingress byte-identical", () => {
  const expected = {
    "pages-next": "2dbfabe3e649e0f79afc9df766e0a19c52177b76667d89ad8e45acaaf523e5f3",
    page3: "db474e430d27227ee9bf407beee948ad6cf7f601fafd55c60bbf34effa38200a",
    page4: "9c5872feed6898ee236a96dc70226c625d5c3a299c3c3866b351b0f4b41f47de",
    page5: "4bda4497169b48213638b5085f4ce5e2b9c335cf483d501f965e1c7f8fd8321c",
  };
  for (const [target, hash] of Object.entries(expected)) {
    assert.equal(digest(routesFor(target)), hash, target);
  }
});

test("page5 setup permits only the exact public page and script paths", () => {
  const current = new RegExp(/^    path: (.+)$/m.exec(routesFor("page5"))[1]);
  for (const pathname of ["/connect", "/connect.js"]) {
    assert.equal(current.test(pathname), true, pathname);
    for (const frozen of ["pages-next", "page3", "page4"]) {
      const route = new RegExp(/^    path: (.+)$/m.exec(routesFor(frozen))[1]);
      assert.equal(route.test(pathname), false, frozen + pathname);
    }
  }
  for (const pathname of [
    "/connect/private",
    "/connect.js/private",
    "/connectXjs",
    "/connect.js/",
    "/connections",
  ])
    assert.equal(current.test(pathname), false, pathname);
  assert.equal(
    digest(priorConfig(routesFor("page5"), "page5")),
    "73203575cae1d3374a984e901f23258e7a2f2ffc5c30b8b314a619604ff3d233",
    "the admitted predecessor is the exact existing page5 ingress",
  );
});

test("page6 owns its connector and exact sharing routes without reusing frozen tunnels", () => {
  const value = inputFor("page6"),
    plan = isolatedPublicationPlan(value);
  assert.equal(plan.service, "cloudflared-page6.service");
  assert.equal(plan.configPath, "/etc/nteract-page6/tunnel.yml");
  assert.equal(plan.unitPath, "/etc/systemd/system/cloudflared-page6.service");
  assert.match(plan.config, /hostname: page6[.]runtimed[.]run/);
  assert.match(plan.config, /http:\/\/127[.]0[.]0[.]1:9476/);
  assert.doesNotMatch(plan.config + plan.unit, /page[345]|pages-next|947[345]|1947[345]/);
  assert.throws(
    () =>
      isolatedPublicationPlan({ ...value, frozenTunnelConfigs: ["tunnel: " + tunnelId + "\n"] }),
    /different tunnel/,
  );
  assert.throws(
    () => isolatedPublicationPlan({ ...value, target: "page5" }),
    /Unexpected deployment target/,
  );
  const route = new RegExp(/^    path: (.+)$/m.exec(routesFor("page6"))[1]);
  for (const pathname of [
    "/",
    "/connect",
    "/connect.js",
    "/api/access",
    "/mermaid.js",
    "/mcp",
    "/llms.txt",
    "/oidc",
    "/api/sync",
    "/api/auth/login",
  ])
    assert.equal(route.test(pathname), true, pathname);
  for (const pathname of [
    "/state",
    "/internal/create",
    "/api/config",
    "/api/access/private",
    "/connect/private",
    "/connect.js/private",
    "/connectXjs",
    "/connect.js/",
    "/connections",
    "/mermaid.js/private",
    "/dev/oidc/authorize",
  ])
    assert.equal(route.test(pathname), false, pathname);
});

test("page6 startup failure and retry preserve every frozen app and connector", (t) => {
  const f = fixture(t, { target: "page6", failStart: true });
  assert.throws(f.execute, /injected connector startup failure/);
  const installation = "/etc/nteract-page6/tunnel-installation.json";
  const receipt = fs.readFileSync(f.local(installation), "utf8");
  for (let i = 0; i < 2; i++) {
    const result = f.execute();
    assert.deepEqual(result.frozenTargetsUnchanged, ["pages-next", "page3", "page4", "page5"]);
    assert.equal(result.sharedTunnelUnchanged, true);
    assert.equal(result.routesUpdated, false);
    assert.equal(fs.readFileSync(f.local(installation), "utf8"), receipt);
  }
  assert.ok(
    f.writes.every(
      (file) =>
        file.startsWith("/etc/nteract-page6/") ||
        file === "/etc/systemd/system/cloudflared-page6.service",
    ),
  );
  assert.ok(
    f.calls
      .filter(
        ({ command, args }) =>
          command === "systemctl" && ["start", "restart", "stop", "enable"].includes(args[0]),
      )
      .every(({ args }) => args[1] === "cloudflared-page6.service"),
  );
  assert.equal(
    f.calls.some(({ command, args }) => command === "systemctl" && args[0] === "restart"),
    false,
  );
  assert.equal(fs.readFileSync(f.local("/etc/cloudflared/config.yml"), "utf8"), sharedConfig);
});

for (const mutation of ["config", "pid"])
  test(`page6 publication detects changed frozen page5 ${mutation}`, (t) => {
    const f = fixture(t, { target: "page6" });
    assert.throws(
      () =>
        f.executeWith(() =>
          mutation === "config"
            ? f.write("/etc/nteract-page5/tunnel.yml", "foreign change")
            : f.changeFrozenPid(),
        ),
      /Frozen Pages (configuration|service) changed/,
    );
  });

test("page6 cannot adopt other targets' historical or pending route receipts", (t) => {
  for (const predecessor of ["page3", "page5"]) {
    for (const pending of [false, true]) {
      const f = fixture(t, { target: "page6" });
      const plan = isolatedPublicationPlan(inputFor("page6"));
      const previous = priorConfig(plan.config, predecessor);
      f.write(plan.configPath, pending ? plan.config : previous);
      f.write(plan.unitPath, plan.unit);
      f.write(
        "/etc/nteract-page6/tunnel-installation.json",
        JSON.stringify({
          schema: 1,
          tunnel_id: plan.tunnelId,
          config_sha256: digest(pending ? plan.config : previous),
          unit_sha256: digest(plan.unit),
          ...(pending ? { previous_config_sha256: digest(previous) } : {}),
        }) + "\n",
      );
      assert.throws(f.execute, /Dedicated tunnel installation differs/);
      assert.equal(f.writes.length, 0);
      assert.equal(
        f.calls.some(
          ({ command, args }) => command === "systemctl" && ["start", "restart"].includes(args[0]),
        ),
        false,
      );
    }
  }
});

const frozenBy = {
  page7: ["pages-next", "page3", "page4", "page5", "page6"],
  page8: ["pages-next", "page3", "page4", "page5", "page6", "page7"],
  page9: ["page7", "page8"],
  page10: ["page7", "page8", "page9"],
  pages: ["page7", "page8", "page9"],
};
for (const target of ["page7", "page8", "page9", "page10", "pages"])
  test(`${target} publication retries preserve every earlier deployment`, (t) => {
    const { deployment, tunnelService } = deploymentProfile(target);
    // A slotted target never installs its legacy unit; it owns only its slots.
    const units = connectorSlots(target).length
      ? connectorSlots(target).map((slot) => slot.service)
      : [tunnelService];
    const f = fixture(t, { target, failStart: true });
    assert.throws(f.execute, /injected connector startup failure/);
    const installation = `/etc/${deployment.service}/tunnel-installation.json`;
    const receipt = fs.readFileSync(f.local(installation), "utf8");
    for (let i = 0; i < 2; i++) {
      const result = f.execute();
      assert.deepEqual(result.frozenTargetsUnchanged, frozenBy[target]);
      assert.equal(result.sharedTunnelUnchanged, true);
      assert.equal(result.routesUpdated, false);
      assert.equal(fs.readFileSync(f.local(installation), "utf8"), receipt);
    }
    assert.ok(
      f.writes.every(
        (file) =>
          file.startsWith(`/etc/${deployment.service}/`) ||
          units.some((unit) => file === `/etc/systemd/system/${unit}`),
      ),
    );
    assert.ok(lifecycle(f).every((call) => units.includes(call.split(" ")[1])));
    const route = new RegExp(/^    path: (.+)$/m.exec(routesFor(target))[1]);
    for (const pathname of [
      "/",
      "/connect",
      "/connect.js",
      "/api/access",
      "/mcp",
      "/llms.txt",
      "/api/sync",
      "/oidc",
    ])
      assert.equal(route.test(pathname), true, pathname);
    for (const pathname of [
      "/state",
      "/internal/create",
      "/api/access/private",
      "/connect/private",
      "/connect.js/private",
      "/dev/oidc/authorize",
    ])
      assert.equal(route.test(pathname), false, pathname);
  });

test("page7 refuses page6 manifests and foreign tunnel receipts", (t) => {
  const value = inputFor("page7");
  assert.throws(
    () => isolatedPublicationPlan({ ...value, target: "page6" }),
    /Unexpected deployment target/,
  );
  assert.throws(
    () =>
      isolatedPublicationPlan({ ...value, frozenTunnelConfigs: ["tunnel: " + tunnelId + "\n"] }),
    /different tunnel/,
  );
  const f = fixture(t, { target: "page7" });
  const foreign = isolatedPublicationPlan(inputFor("page6"));
  f.write(
    "/etc/nteract-page7/tunnel-installation.json",
    JSON.stringify({
      schema: 1,
      tunnel_id: tunnelId,
      config_sha256: digest(foreign.config),
      unit_sha256: digest(foreign.unit),
    }),
  );
  assert.throws(f.execute, /Dedicated tunnel installation differs/);
  assert.equal(f.writes.length, 0);
});

test("Page8 refuses Page7 manifests, connector credentials and installation receipts", (t) => {
  const value = inputFor("page8");
  assert.throws(
    () => isolatedPublicationPlan({ ...value, target: "page7" }),
    /Unexpected deployment target/,
  );
  assert.throws(
    () =>
      isolatedPublicationPlan({ ...value, frozenTunnelConfigs: ["tunnel: " + tunnelId + "\n"] }),
    /different tunnel/,
  );
  const f = fixture(t, { target: "page8" });
  const foreign = isolatedPublicationPlan(inputFor("page7"));
  f.write(
    "/etc/nteract-page8/tunnel-installation.json",
    JSON.stringify({
      schema: 1,
      tunnel_id: tunnelId,
      config_sha256: digest(foreign.config),
      unit_sha256: digest(foreign.unit),
    }),
  );
  assert.throws(f.execute, /Dedicated tunnel installation differs/);
  assert.equal(f.writes.length, 0);
});

for (const mutation of ["config", "pid"])
  test(`Page8 publication detects changed frozen Page7 ${mutation}`, (t) => {
    const f = fixture(t, { target: "page8" });
    assert.throws(
      () =>
        f.executeWith(() =>
          mutation === "config"
            ? f.write("/etc/nteract-page7/tunnel.yml", "foreign change")
            : f.changeFrozenPid("nteract-page7.service"),
        ),
      /Frozen Pages (configuration|service) changed/,
    );
  });

const imageAssetPath = "/api/pages/08c583e5-d29e-4f1e-b06b-333965254e94/assets";
for (const target of ["page6", "page7", "page8", "page9", "page10", "pages"])
  test(`${target} publisher verifies private image ingress before starting its connector`, (t) => {
    const f = fixture(t, { target });
    f.execute();
    const start = f.calls.findIndex(
      ({ command, args }) => command === "systemctl" && ["start", "restart"].includes(args[0]),
    );
    assert.ok(start >= 0);
    const paths = f.calls
      .slice(0, start)
      .filter(({ command, args }) => command === "/usr/bin/cloudflared" && args.includes("rule"))
      .map(({ args }) => new URL(args.at(-1)).pathname);
    for (const pathname of [
      imageAssetPath,
      imageAssetPath + "/" + "a".repeat(64),
      "/api/pages/arbitrary/assets",
      imageAssetPath + "/private",
      imageAssetPath + "/" + "a".repeat(64) + "/private",
    ])
      assert.ok(paths.includes(pathname), pathname);
  });

for (const target of ["page9", "page10", "pages"])
  test(`${target} publisher verifies hashed chunk and asset ingress before starting its connector`, (t) => {
    const f = fixture(t, { target });
    f.execute();
    const start = f.calls.findIndex(
      ({ command, args }) => command === "systemctl" && ["start", "restart"].includes(args[0]),
    );
    const paths = f.calls
      .slice(0, start)
      .filter(({ command, args }) => command === "/usr/bin/cloudflared" && args.includes("rule"))
      .map(({ args }) => new URL(args.at(-1)).pathname);
    for (const pathname of [
      "/chunks/ABCDEFGH.js",
      "/chunks/abcdefgh.js",
      "/chunks/ABCDEFGH.js/private",
      "/chunks/ABCDEFGH.css",
      "/chunks/ABCDEFGHI.js",
      "/chunks/",
      "/app-ABCDEFGH.js",
      "/app-ABCDEFGH.css",
      "/theme-ABCDEFGH.js",
      "/mermaid-ABCDEFGH.js",
      "/automerge-ABCDEFGH.wasm",
      "/subduction-ABCDEFGH.wasm",
      "/app-abcdefgh.js",
      "/app-ABCDEFGHI.js",
      "/app-ABCDEFGH.wasm",
      "/theme-ABCDEFGH.css",
      "/automerge-ABCDEFGH.js",
      "/connect-ABCDEFGH.js",
      "/app-ABCDEFGH.js/private",
    ])
      assert.ok(paths.includes(pathname), pathname);
  });

for (const target of ["page9", "page10", "pages"])
  test(`${target} publisher verifies Project link ingress before starting its connector`, (t) => {
    const f = fixture(t, { target });
    f.execute();
    const start = f.calls.findIndex(
      ({ command, args }) => command === "systemctl" && ["start", "restart"].includes(args[0]),
    );
    assert.ok(start >= 0);
    const paths = f.calls
      .slice(0, start)
      .filter(({ command, args }) => command === "/usr/bin/cloudflared" && args.includes("rule"))
      .map(({ args }) => new URL(args.at(-1)).pathname);
    const id = "08c583e5-d29e-4f1e-b06b-333965254e94";
    for (const pathname of [
      `/project/prj_${id}`,
      `/project/prj_${id}/`,
      `/project/sp_${id}`,
      `/s/sp_${id}`,
      `/s/prj_${id}`,
      `/project/${id}`,
      "/project/prj_not-a-project",
      `/project/prj_${id.toUpperCase()}`,
      `/project/pg_${id}`,
      `/project/prj_${id}/private`,
      `/projects/prj_${id}`,
      "/project/",
      `/s/${id}`,
    ])
      assert.ok(paths.includes(pathname), pathname);
  });

for (const target of ["page9", "page10", "pages"])
  test(`${target} publisher verifies /projects and /pages ingress before starting its connector`, (t) => {
    const f = fixture(t, { target });
    f.execute();
    const start = f.calls.findIndex(
      ({ command, args }) => command === "systemctl" && ["start", "restart"].includes(args[0]),
    );
    assert.ok(start >= 0);
    const probes = f.calls
      .slice(0, start)
      .filter(({ command, args }) => command === "/usr/bin/cloudflared" && args.includes("rule"))
      .map(({ args }) => new URL(args.at(-1)));
    const paths = probes.map((url) => url.pathname + url.search);
    for (const pathname of [
      "/projects",
      "/projects/",
      "/pages",
      "/pages/",
      "/pages?q=roadmap",
      "/projects//",
      "/pages//",
      "/projects/private",
      "/pages/private",
      "/pages/08c583e5-d29e-4f1e-b06b-333965254e94",
      "/projectsX",
      "/pagesX",
      "/page",
      "/Pages",
    ])
      assert.ok(paths.includes(pathname), pathname);
  });

for (const misroutePath of [
  "/projects",
  "/projects/",
  "/pages",
  "/pages/",
  "/pages/private",
  "/projectsX",
  "/chunks/ABCDEFGH.js",
  "/chunks/ABCDEFGH.js/private",
  "/app-ABCDEFGH.js",
  "/automerge-ABCDEFGH.wasm",
  "/app-ABCDEFGH.js/private",
  "/project/prj_08c583e5-d29e-4f1e-b06b-333965254e94",
  "/s/sp_08c583e5-d29e-4f1e-b06b-333965254e94",
  "/project/prj_08c583e5-d29e-4f1e-b06b-333965254e94/private",
  "/project/08c583e5-d29e-4f1e-b06b-333965254e94",
])
  for (const target of ["page9", "page10", "pages"])
    test(`${target} does not activate a connector with misrouted path ${misroutePath}`, (t) => {
      const f = fixture(t, { target, misroutePath });
      assert.throws(f.execute, /Dedicated tunnel route validation failed/);
      assert.equal(
        f.calls.some(
          ({ command, args }) =>
            command === "systemctl" && ["start", "restart", "enable"].includes(args[0]),
        ),
        false,
      );
    });

for (const misroutePath of [
  imageAssetPath,
  imageAssetPath + "/" + "a".repeat(64),
  imageAssetPath + "/private",
  "/theme.js",
  "/theme.js/private",
])
  test(`Page8 does not activate a connector with misrouted asset path ${misroutePath}`, (t) => {
    const f = fixture(t, { target: "page8", misroutePath });
    assert.throws(f.execute, /Dedicated tunnel route validation failed/);
    assert.equal(
      f.calls.some(
        ({ command, args }) =>
          command === "systemctl" && ["start", "restart", "enable"].includes(args[0]),
      ),
      false,
    );
  });

// Connector slots: Page10 and Pages hand the tunnel between two units so a
// route change never leaves the edge without a connector.
const recordPath = (target) => configDir(target) + "/tunnel-connector.json";
function connectorRecord(f) {
  const file = f.local(recordPath(f.target));
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
}
function assertNoGap(f) {
  const first = f.timeline.findIndex((units) => units !== "");
  assert.ok(first >= 0, "a connector came up");
  assert.ok(
    f.timeline.slice(first).every((units) => units !== ""),
    "the edge lost every connector: " + f.timeline.join(" | "),
  );
}
function slotReceipt(config, unit, extra = {}) {
  return (
    JSON.stringify({
      schema: 1,
      tunnel_id: tunnelId,
      config_sha256: digest(config),
      unit_sha256: unit,
      ...extra,
    }) + "\n"
  );
}
// An installation made by a release before slots: one legacy unit, running.
function legacyInstall(f, { config = "previous", pending = null, newConfig = false } = {}) {
  const plan = isolatedPublicationPlan(inputFor(f.target));
  const oldConfig = priorConfig(plan.config, f.target);
  const from = config === "previous" ? oldConfig : plan.config;
  const legacyUnit = digest(plan.unit);
  const sealed = slotReceipt(from, legacyUnit);
  const installed =
    pending === "slots"
      ? slotReceipt(plan.config, plan.unitSha256, {
          previous_config_sha256: digest(from),
          previous_unit_sha256: legacyUnit,
        })
      : pending === "legacy"
        ? slotReceipt(plan.config, legacyUnit, { previous_config_sha256: digest(oldConfig) })
        : sealed;
  f.write(plan.configPath, newConfig ? plan.config : from);
  f.write(plan.unitPath, plan.unit);
  f.write(configDir(f.target) + "/tunnel-installation.json", installed);
  f.activate(plan.service);
  return {
    plan,
    oldConfig,
    from,
    sealed,
    final: slotReceipt(plan.config, plan.unitSha256),
    legacy: plan.service,
    a: plan.slots[0].service,
    b: plan.slots[1].service,
  };
}
const installedReceipt = (f) =>
  fs.readFileSync(f.local(configDir(f.target) + "/tunnel-installation.json"), "utf8");

for (const target of ["page10", "pages"]) {
  for (const phase of ["starting", "stopping", "reverting", "serving"])
    test(`${target} resumes unchanged-Sift legacy handoff at ${phase}, rolls back and retries`, (t) => {
      const f = fixture(t, { target, neverReady: true });
      const plan = isolatedPublicationPlan(inputFor(target));
      const sift = beforePreviews(plan.config).replace(accountPaths, "").replace(whoamiPaths, "");
      const hash = digest(sift);
      // HEAD's predecessor(plan.config, true): routes did not change, units did.
      const historical = slotReceipt(sift, plan.unitSha256, {
        previous_config_sha256: hash,
        previous_unit_sha256: digest(plan.unit),
      });
      f.write(plan.configPath, sift);
      f.write(plan.unitPath, plan.unit);
      for (const slot of plan.slots) f.write(slot.unitPath, slot.unit);
      f.write(configDir(target) + "/tunnel-installation.json", historical);
      const record =
        phase === "starting"
          ? { phase, live: "legacy", config: hash, next: "a", nextConfig: hash }
          : phase === "stopping"
            ? { phase, live: "a", config: hash, previous: "legacy", previousConfig: hash }
            : phase === "reverting"
              ? { phase, live: "legacy", config: hash, next: "a" }
              : { phase, live: "a", config: hash };
      f.write(recordPath(target), JSON.stringify({ schema: 1, ...record }));
      if (phase !== "serving") f.activate(plan.service);
      if (phase !== "starting") f.activate(plan.slots[0].service);
      assert.throws(f.execute, /reported fewer than 2 edge connections/);
      assert.equal(installedReceipt(f), historical);
      assert.equal(fs.readFileSync(f.local(plan.configPath), "utf8"), sift);
      f.setNeverReady(false);
      assert.equal(f.execute().routesUpdated, true);
      assert.equal(installedReceipt(f), slotReceipt(plan.config, plan.unitSha256));
      assert.equal(fs.readFileSync(f.local(plan.configPath), "utf8"), plan.config);
      assert.equal(f.execute().routesUpdated, false);
      assertNoGap(f);
    });

  test(`${target} unchanged-Sift pending receipt rejects pre-Sift or edited files`, (t) => {
    const plan = isolatedPublicationPlan(inputFor(target));
    const sift = beforePreviews(plan.config).replace(accountPaths, "").replace(whoamiPaths, "");
    for (const config of [sift.replace(siftPaths, ""), sift + "# foreign\n"]) {
      const f = fixture(t, { target });
      f.write(plan.configPath, config);
      f.write(plan.unitPath, plan.unit);
      f.write(
        configDir(target) + "/tunnel-installation.json",
        slotReceipt(sift, plan.unitSha256, {
          previous_config_sha256: digest(sift),
          previous_unit_sha256: digest(plan.unit),
        }),
      );
      assert.throws(f.execute, /migration requires exact previous files/);
      assert.equal(f.writes.length, 0);
      assert.deepEqual(lifecycle(f), []);
    }
  });

  for (const legacy of [false, true])
    for (const state of [
      "sealed",
      "pending-old",
      "pending-new",
      "pending-legacy-old",
      "pending-legacy-new",
    ]) {
      if (!legacy && state.startsWith("pending-legacy")) continue;
      test(`${target} migrates exact pre-whoami Sift history: ${legacy ? "legacy" : "slots"} ${state}`, (t) => {
        const f = fixture(t, { target });
        const plan = isolatedPublicationPlan(inputFor(target));
        const sift = beforePreviews(plan.config).replace(accountPaths, "").replace(whoamiPaths, "");
        const beforeSift = sift.replace(siftPaths, "");
        const config = state.endsWith("new") ? sift : beforeSift;
        const unit = legacy ? digest(plan.unit) : plan.unitSha256;
        const receipt =
          state === "sealed"
            ? slotReceipt(beforeSift, unit)
            : slotReceipt(sift, state.startsWith("pending-legacy") ? unit : plan.unitSha256, {
                previous_config_sha256: digest(beforeSift),
                ...(state.startsWith("pending-legacy") ? {} : { previous_unit_sha256: unit }),
              });
        f.write(plan.configPath, config);
        f.write(configDir(target) + "/tunnel-installation.json", receipt);
        if (legacy) f.write(plan.unitPath, plan.unit);
        else {
          for (const slot of plan.slots) f.write(slot.unitPath, slot.unit);
          f.write(
            recordPath(target),
            JSON.stringify({ schema: 1, phase: "serving", live: "a", config: digest(beforeSift) }),
          );
        }
        f.activate(legacy ? plan.service : plan.slots[0].service);
        // A failed new connector preserves an exact historical receipt and
        // config, which must remain retryable under this release.
        f.failNextStart();
        assert.throws(f.execute, /injected connector startup failure/);
        assert.equal(installedReceipt(f), receipt);
        assert.equal(fs.readFileSync(f.local(plan.configPath), "utf8"), config);
        assert.equal(f.execute().routesUpdated, true);
        assert.equal(installedReceipt(f), slotReceipt(plan.config, plan.unitSha256));
        assertNoGap(f);
        assert.equal(f.execute().routesUpdated, false);
      });
    }

  test(`${target} refuses arbitrary edits to either whoami predecessor even with matching receipts`, (t) => {
    const plan = isolatedPublicationPlan(inputFor(target));
    for (const base of [
      beforePreviews(plan.config).replace(accountPaths, "").replace(whoamiPaths, ""),
      beforePreviews(plan.config)
        .replace(accountPaths, "")
        .replace(whoamiPaths, "")
        .replace(siftPaths, ""),
    ])
      for (const changed of [
        base + "# foreign edit\n",
        base.replace("health|", "health|private|"),
      ]) {
        const f = fixture(t, { target });
        f.write(plan.configPath, changed);
        f.write(plan.unitPath, plan.unit);
        f.write(
          configDir(target) + "/tunnel-installation.json",
          slotReceipt(changed, digest(plan.unit)),
        );
        assert.throws(f.execute, /installation differs/);
        assert.equal(f.writes.length, 0);
        assert.deepEqual(lifecycle(f), []);
      }
  });

  test(`${target} slot units add metrics and a bounded grace period; the legacy unit is unchanged`, () => {
    const plan = isolatedPublicationPlan(inputFor(target));
    const { deployment } = deploymentProfile(target);
    assert.match(
      plan.unit,
      new RegExp(
        `^ExecStart=/usr/bin/cloudflared --no-autoupdate --config /etc/${deployment.service}/tunnel.yml tunnel run$`,
        "m",
      ),
    );
    assert.equal(plan.slots.length, 2);
    const ports = new Set();
    for (const slot of plan.slots) {
      assert.equal(slot.unitPath, "/etc/systemd/system/" + slot.service);
      assert.match(
        slot.unit,
        new RegExp(
          `^ExecStart=/usr/bin/cloudflared --no-autoupdate --config /etc/${deployment.service}/tunnel.yml tunnel --metrics ${slot.metrics.replaceAll(".", "[.]")} --grace-period 10s run$`,
          "m",
        ),
      );
      assert.match(slot.metrics, /^127[.]0[.]0[.]1:\d+$/);
      ports.add(slot.metrics);
      // Everything but the description and ExecStart matches the legacy unit.
      const strip = (unit) =>
        unit.replace(/^(Description|ExecStart)=.*$/gm, "").replace(/\n+/g, "\n");
      assert.equal(strip(slot.unit), strip(plan.unit));
    }
    assert.equal(ports.size, 2);
    assert.equal(plan.unitSha256, digest(plan.slots[0].unit + plan.slots[1].unit));
  });

  test(`${target} hands a route change from its legacy connector to slot a without a gap`, (t) => {
    const f = fixture(t, { target });
    const x = legacyInstall(f);
    const result = f.execute();
    assert.equal(result.routesUpdated, true);
    assert.equal(result.connectorSlot, "a");
    assert.equal(result.connectorHandoff, true);
    assert.equal(result.service, x.a);
    assert.equal(result.sharedTunnelUnchanged, true);
    assert.equal(fs.readFileSync(f.local(x.plan.configPath), "utf8"), x.plan.config);
    assert.equal(installedReceipt(f), x.final);
    assert.deepEqual(connectorRecord(f), {
      schema: 1,
      phase: "serving",
      live: "a",
      config: digest(x.plan.config),
    });
    assert.deepEqual(lifecycle(f), [
      "start " + x.a,
      "enable " + x.a,
      "stop " + x.legacy,
      "disable " + x.legacy,
    ]);
    const ready = f.calls.findIndex(
      ({ command, args }) => command === "curl" && args.at(-1).endsWith("/ready"),
    );
    const stop = f.calls.findIndex(
      ({ command, args }) => command === "systemctl" && args[0] === "stop",
    );
    assert.ok(ready >= 0 && ready < stop, "the old connector stops only after /ready");
    assert.ok(f.sleeps.includes(5_000), "the slots overlap before the old one stops");
    assertNoGap(f);
    assert.deepEqual([...f.activeUnits].sort(), [x.a]);
    // The legacy unit stays on disk, stopped and disabled.
    assert.equal(fs.readFileSync(f.local(x.plan.unitPath), "utf8"), x.plan.unit);
    assert.ok(
      f.writes.every(
        (file) =>
          file.startsWith(configDir(target) + "/") ||
          x.plan.slots.some((slot) => file === slot.unitPath),
      ),
    );
    assert.ok(
      f.calls
        .filter(({ command, args }) => command === "systemctl" && args[1] === "cloudflared.service")
        .every(({ args }) => args[0] === "show"),
    );
    f.calls.length = 0;
    const again = f.execute();
    assert.equal(again.routesUpdated, false);
    assert.equal(again.connectorHandoff, false);
    assert.deepEqual(lifecycle(f), ["enable " + x.a, "start " + x.a]);
    assert.equal(installedReceipt(f), x.final);
  });

  test(`${target} moves a legacy connector with unchanged routes onto slot a`, (t) => {
    const f = fixture(t, { target });
    const x = legacyInstall(f, { config: "current" });
    const result = f.execute();
    assert.equal(result.routesUpdated, false);
    assert.equal(result.connectorHandoff, true);
    assert.equal(fs.readFileSync(f.local(x.plan.configPath), "utf8"), x.plan.config);
    assert.equal(installedReceipt(f), x.final);
    assert.deepEqual(lifecycle(f), [
      "start " + x.a,
      "enable " + x.a,
      "stop " + x.legacy,
      "disable " + x.legacy,
    ]);
    assertNoGap(f);
  });

  test(`${target} alternates slots on each route change`, (t) => {
    const f = fixture(t, { target });
    const plan = isolatedPublicationPlan(inputFor(target));
    const oldConfig = priorConfig(plan.config, target);
    const [a, b] = plan.slots;
    for (const slot of plan.slots) f.write(slot.unitPath, slot.unit);
    for (const [live, next] of [
      [a, b],
      [b, a],
    ]) {
      f.write(plan.configPath, oldConfig);
      f.write(
        configDir(target) + "/tunnel-installation.json",
        slotReceipt(oldConfig, plan.unitSha256),
      );
      f.write(
        recordPath(target),
        JSON.stringify({ schema: 1, phase: "serving", live: live.name, config: digest(oldConfig) }),
      );
      f.activeUnits.clear();
      f.activate(live.service);
      f.calls.length = 0;
      const result = f.execute();
      assert.equal(result.routesUpdated, true);
      assert.equal(result.connectorSlot, next.name);
      assert.deepEqual(lifecycle(f), [
        "start " + next.service,
        "enable " + next.service,
        "stop " + live.service,
        "disable " + live.service,
      ]);
      assert.deepEqual(connectorRecord(f), {
        schema: 1,
        phase: "serving",
        live: next.name,
        config: digest(plan.config),
      });
      assert.equal(installedReceipt(f), slotReceipt(plan.config, plan.unitSha256));
      assertNoGap(f);
    }
  });

  for (const failure of ["start", "ready"])
    test(`${target} keeps the legacy connector serving when slot a fails to ${failure}`, (t) => {
      const f = fixture(t, {
        target,
        failStart: failure === "start",
        neverReady: failure === "ready",
      });
      const x = legacyInstall(f);
      assert.throws(
        f.execute,
        failure === "start"
          ? /injected connector startup failure/
          : /reported fewer than 2 edge connections/,
      );
      assert.equal(fs.readFileSync(f.local(x.plan.configPath), "utf8"), x.oldConfig);
      assert.equal(installedReceipt(f), x.sealed);
      assert.deepEqual(connectorRecord(f), {
        schema: 1,
        phase: "serving",
        live: "legacy",
        config: digest(x.oldConfig),
      });
      assert.deepEqual(lifecycle(f), ["start " + x.a, "stop " + x.a, "disable " + x.a]);
      if (failure === "ready") assert.equal(f.sleeps.filter((ms) => ms === 1_000).length, 29);
      assert.ok(f.activeUnits.has(x.legacy), "the legacy connector never stopped");
      assertNoGap(f);
      f.setNeverReady(false);
      const retry = f.execute();
      assert.equal(retry.routesUpdated, true);
      assert.equal(retry.connectorSlot, "a");
      assert.equal(installedReceipt(f), x.final);
      assertNoGap(f);
    });

  // Each persisted step resumes on retry. The old connector keeps serving
  // until the new one is ready, so none of these leave a gap.
  for (const [name, record, active, expected] of [
    [
      "starting, slot a not yet up",
      { phase: "starting", live: "legacy", next: "a" },
      ["legacy"],
      ["start a", "enable a", "stop legacy", "disable legacy"],
    ],
    [
      "starting, slot a already up",
      { phase: "starting", live: "legacy", next: "a" },
      ["legacy", "a"],
      ["restart a", "enable a", "stop legacy", "disable legacy"],
    ],
    [
      "stopping the legacy connector",
      { phase: "stopping", live: "a", previous: "legacy" },
      ["legacy", "a"],
      ["stop legacy", "disable legacy"],
    ],
    // Slot a died after the record said `stopping`: it comes up again before
    // the legacy connector stops.
    [
      "stopping, slot a died",
      { phase: "stopping", live: "a", previous: "legacy" },
      ["legacy"],
      ["start a", "enable a", "stop legacy", "disable legacy"],
    ],
    // The legacy connector died after slot a started: slot a is the only
    // connector, so it is adopted, not restarted.
    [
      "starting, slot a up and the legacy connector gone",
      { phase: "starting", live: "legacy", next: "a" },
      ["a"],
      ["enable a", "stop legacy", "disable legacy"],
    ],
    [
      "reverting slot a",
      { phase: "reverting", live: "legacy", next: "a" },
      ["legacy", "a"],
      ["stop a", "disable a", "start a", "enable a", "stop legacy", "disable legacy"],
    ],
    [
      "serving slot a before the receipt was sealed",
      { phase: "serving", live: "a" },
      ["a"],
      ["enable a", "start a"],
    ],
  ])
    test(`${target} resumes an interrupted handoff: ${name}`, (t) => {
      const f = fixture(t, { target });
      const x = legacyInstall(f, { pending: "slots", newConfig: true });
      for (const slot of x.plan.slots) f.write(slot.unitPath, slot.unit);
      const units = { legacy: x.legacy, a: x.a, b: x.b };
      const want = digest(x.plan.config);
      const old = digest(x.oldConfig);
      const full =
        record.phase === "starting"
          ? { ...record, config: old, nextConfig: want }
          : record.phase === "reverting"
            ? { ...record, config: old }
            : record.phase === "stopping"
              ? { ...record, config: want, previousConfig: old }
              : { ...record, config: want };
      f.write(recordPath(target), JSON.stringify({ schema: 1, ...full }));
      f.activeUnits.clear();
      for (const unit of active) f.activate(units[unit]);
      const result = f.execute();
      assert.equal(result.routesUpdated, true);
      assert.equal(result.connectorSlot, "a");
      assert.deepEqual(
        lifecycle(f),
        expected.map((call) => call.replace(/ (\w+)$/, (_, unit) => " " + units[unit])),
      );
      assert.equal(installedReceipt(f), x.final);
      assert.deepEqual(connectorRecord(f), {
        schema: 1,
        phase: "serving",
        live: "a",
        config: want,
      });
      assert.deepEqual([...f.activeUnits].sort(), [x.a]);
      assertNoGap(f);
    });

  for (const newConfig of [false, true])
    test(`${target} finishes a legacy migration the previous release left pending with ${newConfig ? "new" : "old"} config bytes`, (t) => {
      const f = fixture(t, { target });
      const x = legacyInstall(f, { pending: "legacy", newConfig });
      const result = f.execute();
      assert.equal(result.routesUpdated, true);
      assert.equal(result.connectorHandoff, true);
      assert.equal(installedReceipt(f), x.final);
      assert.equal(lifecycle(f).includes("stop " + x.legacy), true);
      assert.equal(
        lifecycle(f).some((call) => call.startsWith("restart")),
        false,
      );
      assertNoGap(f);
    });

  test(`${target} refuses to guess when the connector record is missing or invalid`, (t) => {
    const missing = fixture(t, { target });
    missing.execute();
    fs.rmSync(missing.local(recordPath(target)));
    assert.throws(missing.execute, /connector state is missing while a slot is active/);
    const invalid = fixture(t, { target });
    invalid.execute();
    invalid.write(recordPath(target), JSON.stringify({ schema: 1, phase: "serving", live: "c" }));
    assert.throws(invalid.execute, /Invalid tunnel connector state/);
  });

  // The connector checks run before the pending receipt, the config rename
  // and any slot unit are written, so a refused route change leaves the
  // installation exactly as it was.
  for (const [problem, setup, error] of [
    [
      "an invalid record",
      (f) => f.write(recordPath(target), "{"),
      /Invalid tunnel connector state/,
    ],
    [
      "a slot running without a record",
      (f, x) => f.activate(x.b),
      /connector state is missing while a slot is active/,
    ],
    [
      "a foreign slot unit",
      (f, x) => f.write(x.plan.slots[0].unitPath, "foreign unit\n"),
      /Dedicated tunnel file differs/,
    ],
  ])
    test(`${target} refuses a route change with ${problem} before writing anything`, (t) => {
      const f = fixture(t, { target });
      const x = legacyInstall(f);
      setup(f, x);
      f.writes.length = 0;
      assert.throws(f.execute, error);
      assert.deepEqual(f.writes, []);
      assert.deepEqual(lifecycle(f), []);
      assert.equal(fs.readFileSync(f.local(x.plan.configPath), "utf8"), x.oldConfig);
      assert.equal(installedReceipt(f), x.sealed);
    });

  test(`${target} waits for every edge connection and settles for two at the end of the budget`, (t) => {
    const full = fixture(t, { target });
    legacyInstall(full);
    full.execute();
    assert.equal(full.sleeps.filter((ms) => ms === 1_000).length, 0, "four connections: no wait");

    const two = fixture(t, { target, readyConnections: 2 });
    const x = legacyInstall(two);
    assert.equal(two.execute().connectorSlot, "a");
    assert.equal(two.sleeps.filter((ms) => ms === 1_000).length, 29);
    assert.equal(installedReceipt(two), x.final);
    assertNoGap(two);

    const one = fixture(t, { target, readyConnections: 1 });
    const y = legacyInstall(one);
    assert.throws(one.execute, /reported fewer than 2 edge connections/);
    assert.ok(one.activeUnits.has(y.legacy), "one connection never replaces the old connector");
    assert.equal(fs.readFileSync(one.local(y.plan.configPath), "utf8"), y.oldConfig);
    assert.equal(installedReceipt(one), y.sealed);
    assertNoGap(one);
  });

  test(`${target} rollback starts the old connector again when it died during the handoff`, (t) => {
    const f = fixture(t, { target, failStart: true });
    const x = legacyInstall(f);
    f.activeUnits.delete(x.legacy);
    assert.throws(f.execute, /injected connector startup failure/);
    assert.deepEqual(lifecycle(f), [
      "start " + x.a,
      "stop " + x.a,
      "disable " + x.a,
      "start " + x.legacy,
    ]);
    // The legacy connector starts only after its old routes are back on disk.
    assert.equal(fs.readFileSync(f.local(x.plan.configPath), "utf8"), x.oldConfig);
    assert.ok(f.activeUnits.has(x.legacy));
    assert.equal(installedReceipt(f), x.sealed);
    assert.deepEqual(connectorRecord(f), {
      schema: 1,
      phase: "serving",
      live: "legacy",
      config: digest(x.oldConfig),
    });
  });

  test(`${target} a revert whose stop fails reports why the handoff failed and resumes`, (t) => {
    const f = fixture(t, {
      target,
      neverReady: true,
      failStop: deploymentProfile(target).tunnelSlots.a.service,
    });
    const x = legacyInstall(f);
    let thrown;
    try {
      f.execute();
    } catch (error) {
      thrown = error;
    }
    assert.match(thrown.message, /injected connector stop failure/);
    assert.match(thrown.cause.message, /reported fewer than 2 edge connections/);
    // Nothing rolled back: the record still owes the stop, and the pending
    // receipt keeps the migration resumable.
    assert.equal(connectorRecord(f).phase, "reverting");
    assert.equal(JSON.parse(installedReceipt(f)).previous_unit_sha256, digest(x.plan.unit));
    assert.ok(f.activeUnits.has(x.legacy));
    f.setNeverReady(false);
    const retry = f.execute();
    assert.equal(retry.connectorSlot, "a");
    assert.equal(installedReceipt(f), x.final);
    assertNoGap(f);
  });

  test(`${target} migration refuses changed legacy or slot files before writes`, (t) => {
    for (const changed of ["legacy-unit", "receipt", "missing-slot-unit"]) {
      const f = fixture(t, { target });
      const x = legacyInstall(f);
      if (changed === "legacy-unit") f.write(x.plan.unitPath, x.plan.unit + "# foreign\n");
      if (changed === "receipt")
        f.write(
          configDir(target) + "/tunnel-installation.json",
          slotReceipt(x.oldConfig, "f".repeat(64)),
        );
      if (changed === "missing-slot-unit") {
        f.write(x.plan.slots[0].unitPath, x.plan.slots[0].unit);
        f.write(
          configDir(target) + "/tunnel-installation.json",
          slotReceipt(x.oldConfig, x.plan.unitSha256),
        );
      }
      f.writes.length = 0;
      assert.throws(
        f.execute,
        /Dedicated tunnel (installation differs|migration requires exact previous files)/,
        changed,
      );
      assert.equal(f.writes.length, 0, changed);
      assert.deepEqual(lifecycle(f), [], changed);
    }
  });

  test(`${target} fresh install refuses an existing slot unit or connector record`, (t) => {
    const plan = isolatedPublicationPlan(inputFor(target));
    for (const file of [plan.slots[1].unitPath, recordPath(target)]) {
      const f = fixture(t, { target });
      f.write(file, "foreign");
      assert.throws(f.execute, /Unowned dedicated tunnel configuration or service already exists/);
      assert.equal(f.writes.length, 0);
    }
  });
}

test("unitActive is true only for exit 0 and `active`; exits 3 and 4 mean not active", () => {
  const exits = (status, stdout) => () =>
    runCommand("sh", ["-c", `echo ${stdout}; exit ${status}`]);
  assert.equal(unitActive("x.service", exits(0, "active")), true);
  assert.equal(unitActive("x.service", exits(0, "activating")), false);
  for (const [status, state] of [
    [3, "inactive"],
    [3, "failed"],
    [4, "inactive"],
  ])
    assert.equal(unitActive("x.service", exits(status, state)), false, `${status} ${state}`);
  // publish.mjs runs execFileSync directly; its errors carry the status too.
  assert.equal(
    unitActive("x.service", () => execFileSync("sh", ["-c", "echo inactive; exit 3"])),
    false,
  );
  // Exit 1 is systemctl's own failure (a bus error, an invalid unit name),
  // not a unit state.
  assert.throws(() => unitActive("x.service", exits(1, "")), /failed \(status 1\)/);
  assert.throws(
    () => unitActive("x.service", () => execFileSync("sh", ["-c", "exit 1"], { stdio: "pipe" })),
    (error) => error.status === 1,
  );
  // systemctl that can't run at all is not a unit state.
  assert.throws(
    () => unitActive("x.service", () => runCommand("/nonexistent/systemctl", [])),
    /failed \(status null\)/,
  );
});

// #4797's first real publish: Page10's legacy connector runs and neither slot
// unit exists yet, so `systemctl is-active` exits 4 for both slots.
for (const target of ["page10", "pages"])
  test(`${target} first publish after slots migrates a running legacy connector whose slots systemd doesn't know`, (t) => {
    const f = fixture(t, { target });
    const x = legacyInstall(f, { config: "current" });
    for (const slot of x.plan.slots) assert.equal(fs.existsSync(f.local(slot.unitPath)), false);
    const result = f.execute();
    const slotChecks = f.calls.filter(
      ({ command, args }) =>
        command === "systemctl" &&
        args[0] === "is-active" &&
        x.plan.slots.some((slot) => slot.service === args[1]),
    );
    assert.ok(slotChecks.length >= 2, "both unknown slots were checked");
    assert.equal(result.connectorSlot, "a");
    assert.equal(result.connectorHandoff, true);
    assert.equal(installedReceipt(f), x.final);
    assert.deepEqual(lifecycle(f), [
      "start " + x.a,
      "enable " + x.a,
      "stop " + x.legacy,
      "disable " + x.legacy,
    ]);
    assertNoGap(f);
  });

test("pages2 publishes fresh on a host without a shared connector", (t) => {
  const f = fixture(t, { target: "pages2", sharedTunnel: false });
  const plan = isolatedPublicationPlan({ ...inputFor("pages2"), sharedConfig: null });
  assert.match(plan.config, /hostname: page2.runtimed.run/);
  assert.match(plan.config, /http:\/\/127.0.0.1:9482/);
  const result = f.execute();
  assert.equal(result.published, true);
  assert.equal(result.hostname, "page2.runtimed.run");
  assert.equal(result.routesUpdated, false);
  assert.equal(result.connectorSlot, "a");
  assert.equal(result.sharedTunnelAbsent, true);
  assert.equal(result.sharedTunnelUnchanged, undefined);
  assert.equal(result.frozenTargetsUnchanged, undefined);
  assert.equal(fs.readFileSync(f.local(plan.configPath), "utf8"), plan.config);
  assert.deepEqual(lifecycle(f), [
    "start cloudflared-pages2-a.service",
    "enable cloudflared-pages2-a.service",
  ]);
  assert.equal(fs.existsSync(f.local(plan.unitPath)), false, "no legacy unit on a fresh install");
  assert.equal(fs.existsSync(f.local("/etc/cloudflared/config.yml")), false);
  assert.ok(
    f.calls.every(({ args }) => !args.includes("cloudflared.service")),
    "a host without a shared connector never asks systemd about one",
  );
  assert.ok(
    f.writes.every(
      (file) =>
        file.startsWith("/etc/nteract-pages2/") ||
        /^\/etc\/systemd\/system\/cloudflared-pages2-[ab][.]service$/.test(file),
    ),
  );
  // A retry is a no-op on the live slot.
  f.calls.length = 0;
  assert.equal(f.execute().published, true);
  assert.deepEqual(lifecycle(f), [
    "enable cloudflared-pages2-a.service",
    "start cloudflared-pages2-a.service",
  ]);
});

test("page11 publication and retry preserve pages2 slotted connectors", (t) => {
  const f = fixture(t, { target: "page11", sharedTunnel: false });
  const result = f.execute();
  assert.deepEqual(result.frozenTargetsUnchanged, ["pages2"]);
  assert.equal(result.hostname, "page11.runtimed.run");
  assert.equal(result.connectorSlot, "a");
  f.calls.length = 0;
  assert.equal(f.execute().connectorHandoff, false);
  assert.ok(
    f.writes.every(
      (file) =>
        file.startsWith("/etc/nteract-page11/") ||
        /^\/etc\/systemd\/system\/cloudflared-page11-[ab][.]service$/.test(file),
    ),
  );
  assert.ok(lifecycle(f).every((line) => line.includes("cloudflared-page11-a.service")));
  assert.equal(fs.existsSync(f.local("/etc/systemd/system/cloudflared-pages2.service")), false);
});

test("page11 detects changes to either pages2 slot and its persistent connector state", (t) => {
  for (const unit of [
    "nteract-pages2.service",
    "cloudflared-pages2-a.service",
    "cloudflared-pages2-b.service",
  ]) {
    const f = fixture(t, { target: "page11", sharedTunnel: false });
    assert.throws(
      () => f.executeWith(() => f.changeFrozenPid(unit)),
      /Frozen Pages service changed/,
    );
  }
  for (const name of ["tunnel.yml", "tunnel-installation.json", "tunnel-connector.json"]) {
    const f = fixture(t, { target: "page11", sharedTunnel: false });
    assert.throws(
      () => f.executeWith(() => f.write("/etc/nteract-pages2/" + name, "concurrent change")),
      /Frozen Pages configuration changed/,
    );
  }
});

test("page11 rejects a pages2 manifest or tunnel identity before publication writes", (t) => {
  for (const [file, value] of [
    ["/tmp/nteract-page11-stage-test1234/manifest.json", inputFor("pages2").manifest],
    ["/etc/nteract-page11/tunnel-provisioning.json", inputFor("pages2").tunnelReceipt],
  ]) {
    const f = fixture(t, { target: "page11", sharedTunnel: false });
    f.write(file, JSON.stringify(value));
    assert.throws(f.execute, /Unexpected deployment|provisioning receipt/);
    assert.deepEqual(f.writes, []);
    assert.deepEqual(lifecycle(f), []);
  }
  const f = fixture(t, { target: "page11", sharedTunnel: false });
  f.write("/etc/nteract-pages2/tunnel.yml", "tunnel: " + tunnelId + "\n");
  assert.throws(f.execute, /different tunnel/);
  assert.deepEqual(f.writes, []);
});

test("pages2 still checks a shared connector that appears on lab2", (t) => {
  const f = fixture(t, { target: "pages2", sharedTunnel: false });
  f.write("/etc/cloudflared/config.yml", "tunnel: " + tunnelId + "\n");
  assert.throws(f.execute, /different tunnel/);
  assert.deepEqual(lifecycle(f), []);
  const g = fixture(t, { target: "pages2", sharedTunnel: false });
  g.write("/etc/cloudflared/config.yml", sharedConfig);
  assert.equal(g.execute().sharedTunnelUnchanged, true);
});

test("lab1 targets still require the shared connector config", (t) => {
  assert.throws(
    () => isolatedPublicationPlan({ ...inputFor("pages"), sharedConfig: null }),
    /shared tunnel configuration is required on lab1/,
  );
  assert.doesNotThrow(() => isolatedPublicationPlan({ ...inputFor("pages2"), sharedConfig: null }));
  const f = fixture(t, { target: "pages", sharedTunnel: false });
  assert.throws(f.execute);
  assert.deepEqual(lifecycle(f), []);
  assert.equal(fs.existsSync(f.local("/etc/nteract-pages-live/tunnel-installation.json")), false);
});

test("pages2 serves the Pages route set under its own hostname and listener", () => {
  const pages = deploymentProfile("pages").deployment;
  const pages2 = deploymentProfile("pages2").deployment;
  assert.equal(
    routesFor("pages2"),
    routesFor("pages")
      .replaceAll("hostname: " + pages.hostname, "hostname: " + pages2.hostname)
      .replace("http://" + pages.listen, "http://" + pages2.listen),
  );
});

const ACCOUNT_TARGETS = ["page10", "pages", "pages2"];
const handle = "A".repeat(43);
const accountAdmitted = [
  "/api/auth/logout-all",
  "/api/auth/grants",
  `/api/auth/grants/${handle}/revoke`,
  "/api/auth/grants/aZ09_-aZ09_-aZ09_-aZ09_-aZ09_-aZ09_-aZ09_-a/revoke",
];
const accountRejected = [
  "/api/auth/logout-all/",
  "/api/auth/logout-all/private",
  "/api/auth/logoutall",
  "/api/auth/grants/",
  `/api/auth/grants/${handle}`,
  `/api/auth/grants/${handle}/`,
  `/api/auth/grants/${"A".repeat(42)}/revoke`,
  `/api/auth/grants/${"A".repeat(44)}/revoke`,
  `/api/auth/grants/${"A".repeat(42)}.revoke`,
  `/api/auth/grants/${handle}/revoke/private`,
  `/api/auth/grants/${"A".repeat(42)}%2F/revoke`,
  "/api/auth/other",
  "/auth/grants",
];

test("only page10, pages and pages2 admit the exact account routes, never legacy routes", () => {
  for (const target of [
    "pages-next",
    "page3",
    "page4",
    "page5",
    "page6",
    "page7",
    "page8",
    "page9",
    ...ACCOUNT_TARGETS,
  ]) {
    const enabled = ACCOUNT_TARGETS.includes(target);
    assert.equal(deploymentProfile(target).accountRoutes === true, enabled, target);
    const current = routesFor(target);
    assert.equal(current.split(accountPaths).length, enabled ? 2 : 1, target);
    for (const legacy of [false, true]) {
      const route = new RegExp(/^    path: (.+)$/m.exec(routesFor(target, legacy))[1]);
      for (const pathname of accountAdmitted)
        assert.equal(route.test(pathname), enabled && !legacy, `${target} ${pathname}`);
      for (const pathname of accountRejected)
        assert.equal(route.test(pathname), false, `${target} ${pathname}`);
      // The routes that were there stay admitted.
      for (const pathname of ["/api/auth/login", "/api/auth/logout", "/api/auth/session"])
        assert.equal(route.test(pathname), true, `${target} ${pathname}`);
    }
  }
});

test("the account routes are the only difference from the route set before them", () => {
  // routesFor(target) as published before the account routes existed.
  for (const [target, sealed] of [
    ["page10", "5c1fc74e475e84d586539900096e1d44e4187a75caabfd0ec0822d6d517dabba"],
    ["pages", "188d8940a17166b111085dfb351c84777851e7eaadd752ef9f1bd4158d54f153"],
    ["pages2", "64ab836acaa2aaa3acf0f10bdc8f0fab573294dfecf58c860199882ea286d658"],
  ]) {
    const withAccount = beforePreviews(routesFor(target));
    const prior = withAccount.replace(accountPaths, "");
    assert.equal(digest(prior), sealed, target);
    assert.equal(prior.includes("logout-all"), false);
    assert.equal(withAccount.length - prior.length, accountPaths.length);
  }
});

// An installation on slot units at the route set `from(plan.config)`:
// sealed, or interrupted after its pending receipt with the old (pending-old)
// or new (pending-new) config on disk.
function slotInstall(f, from, { state = "sealed", edit = (config) => config } = {}) {
  const plan = isolatedPublicationPlan(inputFor(f.target));
  const base = from(plan.config);
  const onDisk = state === "pending-new" ? plan.config : edit(base);
  const receipt =
    state === "sealed"
      ? slotReceipt(edit(base), plan.unitSha256)
      : slotReceipt(plan.config, plan.unitSha256, {
          previous_config_sha256: digest(base),
          previous_unit_sha256: plan.unitSha256,
        });
  f.write(plan.configPath, onDisk);
  for (const slot of plan.slots) f.write(slot.unitPath, slot.unit);
  f.write(configDir(f.target) + "/tunnel-installation.json", receipt);
  f.write(
    recordPath(f.target),
    JSON.stringify({ schema: 1, phase: "serving", live: "a", config: digest(base) }),
  );
  f.activate(plan.slots[0].service);
  return { plan, base, receipt };
}
// Before the account routes, which also predate link previews, card images
// and Project assets: it migrates straight to plan.config.
const accountInstall = (f, options) =>
  slotInstall(f, (config) => beforePreviews(config).replace(accountPaths, ""), options);

for (const target of ACCOUNT_TARGETS) {
  for (const state of ["sealed", "pending-old", "pending-new"])
    test(`${target} adds the account routes to its sealed installation (${state})`, (t) => {
      const f = fixture(t, { target, sharedTunnel: target !== "pages2" });
      const x = accountInstall(f, { state });
      const units = x.plan.slots.map((slot) => fs.readFileSync(f.local(slot.unitPath), "utf8"));
      // A failed new connector rolls back to the sealed pre-account
      // installation, which stays retryable.
      f.failNextStart();
      assert.throws(f.execute, /injected connector startup failure/);
      assert.equal(installedReceipt(f), slotReceipt(x.base, x.plan.unitSha256));
      assert.equal(fs.readFileSync(f.local(x.plan.configPath), "utf8"), x.base);
      const result = f.execute();
      assert.equal(result.routesUpdated, true);
      assert.equal(result.connectorHandoff, true);
      assert.equal(fs.readFileSync(f.local(x.plan.configPath), "utf8"), x.plan.config);
      assert.equal(installedReceipt(f), slotReceipt(x.plan.config, x.plan.unitSha256));
      assert.deepEqual(connectorRecord(f), {
        schema: 1,
        phase: "serving",
        live: "b",
        config: digest(x.plan.config),
      });
      // The slot units and the legacy unit are untouched; only the routes changed.
      assert.deepEqual(
        x.plan.slots.map((slot) => fs.readFileSync(f.local(slot.unitPath), "utf8")),
        units,
      );
      assert.equal(fs.existsSync(f.local(x.plan.unitPath)), false);
      assertNoGap(f);
      assert.deepEqual([...f.activeUnits].sort(), [x.plan.slots[1].service]);
      f.calls.length = 0;
      assert.equal(f.execute().routesUpdated, false);
      assert.equal(installedReceipt(f), slotReceipt(x.plan.config, x.plan.unitSha256));
    });

  test(`${target} refuses an edited pre-account route set even with a matching receipt`, (t) => {
    for (const edit of [
      (config) => config + "# foreign edit\n",
      (config) => config.replace("health|", "health|private|"),
    ]) {
      const f = fixture(t, { target, sharedTunnel: target !== "pages2" });
      accountInstall(f, { edit });
      assert.throws(f.execute, /installation differs/);
      assert.equal(f.writes.length, 0);
      assert.deepEqual(lifecycle(f), []);
    }
  });

  test(`${target} refuses misrouted account paths before connector activation`, (t) => {
    for (const misroutePath of [
      "/api/auth/logout-all",
      `/api/auth/grants/${handle}/revoke`,
      "/api/auth/grants/",
    ]) {
      const f = fixture(t, { target, misroutePath, sharedTunnel: target !== "pages2" });
      assert.throws(f.execute, /route validation failed/);
      assert.deepEqual(lifecycle(f), []);
    }
  });
}

// Link previews, card images and Project assets: the same live targets.
const PREVIEW_TARGETS = ACCOUNT_TARGETS;
const previewUuid = "08c583e5-d29e-4f1e-b06b-333965254e94";
const previewHash = "0123456789abcdef".repeat(4);
const previewAdmitted = [
  `/p/${previewUuid}/meta.json`,
  `/p/${previewUuid}/card.json`,
  `/project/prj_${previewUuid}/meta.json`,
  `/project/sp_${previewUuid}/card.json`,
  `/api/pages/${previewUuid}/card-image`,
  `/api/pages/${previewUuid}/card-image/${previewHash}-light.webp`,
  `/api/pages/${previewUuid}/card-image/${previewHash}-dark.png`,
  `/api/pages/${previewUuid}/card-image/${previewHash}-light.jpg`,
  `/api/projects/prj_${previewUuid}/assets`,
  `/api/projects/sp_${previewUuid}/assets/${previewHash}`,
];
const previewRejected = [
  `/p/${previewUuid}/meta.json/`,
  `/p/${previewUuid}/other.json`,
  `/p/${previewUuid}/meta.json/private`,
  `/p/${previewUuid.toUpperCase()}/meta.json`,
  `/project/${previewUuid}/meta.json`,
  `/project/prj_${previewUuid.toUpperCase()}/meta.json`,
  `/project/prj_${previewUuid}/card.json/`,
  `/s/sp_${previewUuid}/meta.json`,
  `/api/pages/${previewUuid}/card-image/`,
  `/api/pages/${previewUuid}/card-image/${previewHash.slice(1)}-light.webp`,
  `/api/pages/${previewUuid}/card-image/${previewHash}0-dark.webp`,
  `/api/pages/${previewUuid}/card-image/${previewHash}-sepia.webp`,
  `/api/pages/${previewUuid}/card-image/${previewHash}-light.gif`,
  `/api/pages/${previewUuid}/card-image/${previewHash}-light.webp/private`,
  `/api/pages/${previewUuid.toUpperCase()}/card-image`,
  `/api/projects/${previewUuid}/assets`,
  `/api/projects/prj_${previewUuid}/assets/private`,
  `/api/projects/prj_${previewUuid}/assets/${previewHash}/private`,
];

test("only page10, pages and pages2 admit link previews, card images and Project assets, never legacy routes", () => {
  for (const target of [
    "pages-next",
    "page3",
    "page4",
    "page5",
    "page6",
    "page7",
    "page8",
    "page9",
    ...PREVIEW_TARGETS,
  ]) {
    const enabled = PREVIEW_TARGETS.includes(target);
    const profile = deploymentProfile(target);
    for (const flag of ["linkPreviews", "cardImages", "projectAssets"])
      assert.equal(profile[flag] === true, enabled, `${target} ${flag}`);
    const current = routesFor(target);
    for (const group of [linkPreviewPaths, cardImagePaths, projectAssetPaths])
      assert.equal(current.split(group).length, enabled ? 2 : 1, `${target} ${group}`);
    for (const legacy of [false, true]) {
      const route = new RegExp(/^    path: (.+)$/m.exec(routesFor(target, legacy))[1]);
      for (const pathname of previewAdmitted)
        assert.equal(route.test(pathname), enabled && !legacy, `${target} ${pathname}`);
      for (const pathname of previewRejected)
        assert.equal(route.test(pathname), false, `${target} ${pathname}`);
    }
    // The viewer routes beside them stay as they were.
    if (enabled) {
      const route = new RegExp(/^    path: (.+)$/m.exec(current)[1]);
      for (const pathname of [
        `/p/${previewUuid}`,
        `/p/${previewUuid}/`,
        `/project/prj_${previewUuid}`,
        `/api/pages/${previewUuid}/assets/${previewHash}`,
      ])
        assert.equal(route.test(pathname), true, `${target} ${pathname}`);
    }
  }
});

test("link previews, card images and Project assets are the only difference from the last sealed route set", () => {
  // routesFor(target) as the account-route release published it.
  for (const [target, sealed] of [
    ["page10", "28021152f7762d52cd7ffeb4d539544697755f5afb0031a7c62aaf19733043b8"],
    ["pages", "52527063f9c1a57c4a0e54c57025dc12f896ccfb03a1dae537205d9a188bfd02"],
    ["pages2", "fc8123d752d159dfae99503b41dbd37490cbb7d9b6e0088f79136beaf7d4bf56"],
  ]) {
    const current = routesFor(target);
    const prior = beforePreviews(current);
    assert.equal(digest(prior), sealed, target);
    assert.equal(prior.includes("meta|card"), false);
    assert.equal(prior.includes("card-image"), false);
    assert.equal(prior.includes("projects/(prj|sp)"), false);
    assert.equal(
      current.length - prior.length,
      linkPreviewPaths.length + cardImagePaths.length + projectAssetPaths.length,
    );
  }
});

// The installation the account-route release sealed, without this release's
// groups.
const previewInstall = (f, options) => slotInstall(f, beforePreviews, options);

for (const target of PREVIEW_TARGETS) {
  const shared = { target, sharedTunnel: target !== "pages2" };
  for (const state of ["sealed", "pending-old", "pending-new"])
    test(`${target} adds link previews, card images and Project assets to its sealed installation (${state})`, (t) => {
      const f = fixture(t, shared);
      const x = previewInstall(f, { state });
      const units = x.plan.slots.map((slot) => fs.readFileSync(f.local(slot.unitPath), "utf8"));
      // A failed new connector rolls back to the sealed installation, which
      // stays retryable.
      f.failNextStart();
      assert.throws(f.execute, /injected connector startup failure/);
      assert.equal(installedReceipt(f), slotReceipt(x.base, x.plan.unitSha256));
      assert.equal(fs.readFileSync(f.local(x.plan.configPath), "utf8"), x.base);
      const result = f.execute();
      assert.equal(result.routesUpdated, true);
      assert.equal(result.connectorHandoff, true);
      assert.equal(fs.readFileSync(f.local(x.plan.configPath), "utf8"), x.plan.config);
      assert.equal(installedReceipt(f), slotReceipt(x.plan.config, x.plan.unitSha256));
      assert.deepEqual(connectorRecord(f), {
        schema: 1,
        phase: "serving",
        live: "b",
        config: digest(x.plan.config),
      });
      // Only the routes changed: the slot units are untouched and the legacy
      // unit stays absent.
      assert.deepEqual(
        x.plan.slots.map((slot) => fs.readFileSync(f.local(slot.unitPath), "utf8")),
        units,
      );
      assert.equal(fs.existsSync(f.local(x.plan.unitPath)), false);
      assertNoGap(f);
      assert.deepEqual([...f.activeUnits].sort(), [x.plan.slots[1].service]);
      f.calls.length = 0;
      assert.equal(f.execute().routesUpdated, false);
      assert.equal(installedReceipt(f), slotReceipt(x.plan.config, x.plan.unitSha256));
    });

  test(`${target} hands the sealed route set from its legacy connector to slot a with this release's routes`, (t) => {
    const f = fixture(t, shared);
    const plan = isolatedPublicationPlan(inputFor(target));
    const sealed = beforePreviews(plan.config);
    f.write(plan.configPath, sealed);
    f.write(plan.unitPath, plan.unit);
    f.write(
      configDir(target) + "/tunnel-installation.json",
      slotReceipt(sealed, digest(plan.unit)),
    );
    f.activate(plan.service);
    const result = f.execute();
    assert.equal(result.routesUpdated, true);
    assert.equal(result.connectorSlot, "a");
    assert.equal(fs.readFileSync(f.local(plan.configPath), "utf8"), plan.config);
    assert.equal(installedReceipt(f), slotReceipt(plan.config, plan.unitSha256));
    assertNoGap(f);
    assert.deepEqual([...f.activeUnits].sort(), [plan.slots[0].service]);
  });

  test(`${target} refuses an edited sealed route set even with a matching receipt`, (t) => {
    for (const edit of [
      (config) => config + "# foreign edit\n",
      (config) => config.replace("health|", "health|private|"),
      // Only one of this release's groups, as no release published it.
      (config) => config.replace("api/(", "api/(" + cardImagePaths),
    ]) {
      const f = fixture(t, shared);
      previewInstall(f, { edit });
      assert.throws(f.execute, /installation differs/);
      assert.equal(f.writes.length, 0);
      assert.deepEqual(lifecycle(f), []);
    }
  });

  test(`${target} stops for inspection at a pending receipt from the account-route publish`, (t) => {
    // That publish was interrupted after its pending receipt: this release
    // doesn't resume it. Finish it with that release's stage first.
    const f = fixture(t, shared);
    const plan = isolatedPublicationPlan(inputFor(target));
    const sealed = beforePreviews(plan.config);
    const before = sealed.replace(accountPaths, "");
    f.write(plan.configPath, sealed);
    for (const slot of plan.slots) f.write(slot.unitPath, slot.unit);
    f.write(
      configDir(target) + "/tunnel-installation.json",
      slotReceipt(sealed, plan.unitSha256, {
        previous_config_sha256: digest(before),
        previous_unit_sha256: plan.unitSha256,
      }),
    );
    f.write(
      recordPath(target),
      JSON.stringify({ schema: 1, phase: "serving", live: "a", config: digest(sealed) }),
    );
    f.activate(plan.slots[0].service);
    assert.throws(f.execute, /installation differs/);
    assert.equal(f.writes.length, 0);
    assert.deepEqual(lifecycle(f), []);
  });

  test(`${target} refuses misrouted preview, card image and Project asset paths before connector activation`, (t) => {
    for (const misroutePath of [
      `/p/${previewUuid}/meta.json`,
      `/project/sp_${previewUuid}/card.json`,
      `/p/${previewUuid}/meta.json/`,
      `/api/pages/${previewUuid}/card-image`,
      `/api/pages/${previewUuid}/card-image/${"a".repeat(64)}-light.webp`,
      `/api/pages/${previewUuid}/card-image/${"a".repeat(64)}-sepia.webp`,
      `/api/projects/prj_${previewUuid}/assets`,
      `/api/projects/${previewUuid}/assets`,
    ]) {
      const f = fixture(t, { ...shared, misroutePath });
      assert.throws(f.execute, /route validation failed/, misroutePath);
      assert.deepEqual(lifecycle(f), []);
    }
  });
}
