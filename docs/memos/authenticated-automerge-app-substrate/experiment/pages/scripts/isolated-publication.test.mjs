import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import {
  routesFor,
  assetPaths,
  imagePaths,
  indexPaths,
  projectPaths,
} from "./deployment/routes.mjs";
import { isIndexRoute, readPageRoute } from "../shared/routes.mjs";
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
  {
    failStart = false,
    failRestart = false,
    interruptRollback = null,
    target = "page3",
    misroutePath = null,
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
  let active = false,
    frozenPid = "12345";
  const changedFrozenPids = new Map();
  const run = (command, args) => {
    calls.push({ command, args });
    if (command === "systemctl") {
      if (args[0] === "show") {
        if (args[1] === "cloudflared.service") return "3393474";
        return args.includes("--property=MainPID")
          ? (changedFrozenPids.get(args[1]) ?? frozenPid)
          : "not-found";
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
      const forwarded = pattern.test(pathname) !== (pathname === misroutePath);
      return "service: " + (forwarded ? "http://" + profile.deployment.listen : "http_status:404");
    }
    throw Error("Unexpected command " + command);
  };
  return {
    target,
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
    changeFrozenPid: (unit) => {
      if (unit) changedFrozenPids.set(unit, "54321");
      else frozenPid = "54321";
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
function priorConfig(config, target) {
  return target === "page5"
    ? config.replace("|connect|connect[.]js|", "|")
    : target === "page7"
      ? config.replace(imagePaths, "")
      : target === "page8"
        ? config.replace("|theme[.]js|", "|")
        : target === "page9"
          ? config.replace(indexPaths, "")
          : config.replace("|mermaid[.]js|", "|");
}
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
    "/etc/nteract-" + f.target + "/tunnel-installation.json",
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

test("OAuth and private images publish only exact Page7 through Page9 routes while previous targets remain closed", () => {
  for (const target of [
    "pages-next",
    "page3",
    "page4",
    "page5",
    "page6",
    "page7",
    "page8",
    "page9",
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
        ["page7", "page8", "page9"].includes(target),
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

for (const target of ["page3", "page5", "page7", "page8", "page9"]) {
  test(`${target} known route upgrade restarts only its dedicated connector then becomes a no-op`, (t) => {
    const f = fixture(t, { target });
    const expected = previousInstallation(f);
    assert.equal(f.execute().routesUpdated, true);
    assert.equal(fs.readFileSync(f.local(expected.plan.configPath), "utf8"), expected.plan.config);
    assert.equal(
      fs.readFileSync(f.local("/etc/nteract-" + target + "/tunnel-installation.json"), "utf8"),
      expected.newReceipt,
    );
    assert.equal(fs.readFileSync(f.local("/etc/cloudflared/config.yml"), "utf8"), sharedConfig);
    assert.equal(f.execute().routesUpdated, false);
    const restarts = f.calls.filter(
      ({ command, args }) => command === "systemctl" && args[0] === "restart",
    );
    assert.deepEqual(
      restarts.map(({ args }) => args[1]),
      ["cloudflared-" + target + ".service"],
    );
    assert.ok(f.writes.every((file) => file.startsWith("/etc/nteract-" + target + "/")));
  });

  for (const newConfig of [false, true]) {
    test(`${target} interrupted route upgrade resumes with ${newConfig ? "new" : "old"} config bytes and a pending receipt`, (t) => {
      const f = fixture(t, { target });
      const expected = previousInstallation(f, { pending: true, newConfig });
      assert.equal(f.execute().routesUpdated, true);
      assert.equal(
        fs.readFileSync(f.local("/etc/nteract-" + target + "/tunnel-installation.json"), "utf8"),
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
      fs.readFileSync(f.local("/etc/nteract-" + target + "/tunnel-installation.json"), "utf8"),
      expected.oldReceipt,
    );
    assert.equal(f.execute().routesUpdated, true);
    assert.equal(fs.readFileSync(f.local("/etc/cloudflared/config.yml"), "utf8"), sharedConfig);
    assert.ok(
      f.calls
        .filter(({ command, args }) => command === "systemctl" && args[0] === "restart")
        .every(({ args }) => args[1] === "cloudflared-" + target + ".service"),
    );
  });

  test(`${target} migration rejects unknown receipt, modified unit/config, and unreceipted new bytes before writes`, (t) => {
    for (const changed of ["receipt", "unit", "config", "new-with-old-receipt"]) {
      const f = fixture(t, { target });
      const expected = previousInstallation(f, { newConfig: changed === "new-with-old-receipt" });
      if (changed === "receipt")
        f.write("/etc/nteract-" + target + "/tunnel-installation.json", "unknown receipt");
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
        f.local("/etc/nteract-" + target + "/tunnel-installation.json"),
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
        fs.readFileSync(f.local("/etc/nteract-" + target + "/tunnel-installation.json"), "utf8"),
        expected.newReceipt,
      );
      assert.equal(fs.readFileSync(f.local("/etc/cloudflared/config.yml"), "utf8"), sharedConfig);
      assert.ok(
        f.calls
          .filter(({ command, args }) => command === "systemctl" && args[0] === "restart")
          .every(({ args }) => args[1] === "cloudflared-" + target + ".service"),
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
};
for (const target of ["page7", "page8", "page9"])
  test(`${target} publication retries preserve every earlier deployment`, (t) => {
    const f = fixture(t, { target, failStart: true });
    assert.throws(f.execute, /injected connector startup failure/);
    const installation = `/etc/nteract-${target}/tunnel-installation.json`;
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
          file.startsWith(`/etc/nteract-${target}/`) ||
          file === `/etc/systemd/system/cloudflared-${target}.service`,
      ),
    );
    assert.ok(
      f.calls
        .filter(
          ({ command, args }) =>
            command === "systemctl" && ["start", "restart", "stop", "enable"].includes(args[0]),
        )
        .every(({ args }) => args[1] === `cloudflared-${target}.service`),
    );
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
for (const target of ["page6", "page7", "page8", "page9"])
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

test("page9 publisher verifies hashed chunk and asset ingress before starting its connector", (t) => {
  const f = fixture(t, { target: "page9" });
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

test("page9 publisher verifies Project link ingress before starting its connector", (t) => {
  const f = fixture(t, { target: "page9" });
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

test("page9 publisher verifies /projects and /pages ingress before starting its connector", (t) => {
  const f = fixture(t, { target: "page9" });
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
  test(`Page9 does not activate a connector with misrouted path ${misroutePath}`, (t) => {
    const f = fixture(t, { target: "page9", misroutePath });
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
