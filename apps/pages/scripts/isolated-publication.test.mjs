import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import {
  ROUTE_REGISTRY,
  routesFor,
  strippableSlots,
  accountPaths,
  cardImagePaths,
  indexPaths,
  linkPreviewPaths,
  mediaGuidePaths,
  pageSlugPaths,
  projectAssetPaths,
  projectPaths,
  publishedPreviewApiPaths,
  publishedPreviewPaths,
  restPaths,
  siftPaths,
  whoamiPaths,
} from "./deployment/routes.mjs";
import { isIndexRoute, readPageRoute } from "../shared/routes.mjs";
import { DEPLOYMENT_TARGETS, deploymentProfile } from "./deployment/profiles.mjs";
import {
  isolatedPublicationPlan,
  knownTunnelConfigs,
  publishIsolated,
  runCommand,
  unitActive,
} from "./deployment/isolated-publication.mjs";
import { execFileSync } from "node:child_process";

const tunnelId = "12345678-1234-4123-8123-123456789abc";
const accountId = "1cfb529b94b3d6cde3aaf49d1d6ed5e6";
const sharedConfig =
  "tunnel: b08c5d4e-41e9-4b75-8ada-4d4b84b58770\ningress:\n  - service: http_status:404\n";
const deployment = deploymentProfile("page10").deployment;
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
    name: "nteract-page10",
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

test("dedicated page10 plan cannot use shared or unowned tunnel credentials", () => {
  const plan = isolatedPublicationPlan({ ...input, target: "page10" });
  assert.equal(plan.service, "cloudflared-page10.service");
  assert.match(plan.config, /hostname: page10.runtimed.run/);
  assert.match(plan.config, /http:\/\/127.0.0.1:9480/);
  assert.ok(plan.config.endsWith("  - service: http_status:404\n"));
  assert.doesNotMatch(plan.config, /pages[.]runtimed[.]run|\*\.runtimed.run/);
  assert.doesNotMatch(plan.unit, /\/etc\/cloudflared\/|cloudflared\.service/);
  assert.ok(!JSON.stringify(plan).includes(input.credentials.TunnelSecret));
  for (const changed of [
    { manifest: { ...input.manifest, deployment: deploymentProfile("pages").deployment } },
    { tunnelReceipt: { ...input.tunnelReceipt, name: "existing-tunnel" } },
    { credentials: { ...input.credentials, AccountTag: "f".repeat(32) } },
    { sharedConfig: "tunnel: " + tunnelId + "\n" },
    { sharedConfig: "unrecognized shared config" },
  ])
    assert.throws(() => isolatedPublicationPlan({ ...input, target: "page10", ...changed }));
});

function fixture(
  t,
  {
    failStart = false,
    failRestart = false,
    interruptRollback = null,
    target = "page10",
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
  const root = fs.mkdtempSync(path.join(tmpdir(), "page10-isolated-publication-"));
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
      // cloudflared matches a rule against the decoded path.
      const forwarded = pattern.test(decodeURIComponent(pathname)) !== (pathname === misroutePath);
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

const digest = (text) => createHash("sha256").update(text).digest("hex");
// A live target's routes without Page slugs: the route set the release before
// them sealed.
const beforeMediaGuides = (config) => config.replace(mediaGuidePaths, "");
const beforePublishedPreviews = (config) =>
  beforeMediaGuides(config)
    .replace(publishedPreviewPaths, "")
    .replace(publishedPreviewApiPaths, "");
const beforeSlugs = (config) => beforePublishedPreviews(config).replace(pageSlugPaths, "");
// Without link previews, card images and Project assets either: the route
// set the release before those sealed.
const beforePreviews = (config) =>
  beforeSlugs(config)
    .replace(restPaths, "")
    .replace(linkPreviewPaths, "")
    .replace(cardImagePaths, "")
    .replace(projectAssetPaths, "");
function priorConfig(config) {
  return beforePreviews(config).replace(accountPaths, "").replace(whoamiPaths, "");
}
const configDir = (target) => "/etc/" + deploymentProfile(target).deployment.service;
test("Page10 admits only hashed viewer files", () => {
  const current = routesFor("page10");
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
test("Page10 admits exact Project links", () => {
  const current = routesFor("page10");
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

test("Page10 admits exactly /projects and /pages", () => {
  const current = routesFor("page10");
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

const whoamiRejected = ["/whoami/", "/whoami/private", "/whoamiX", "/Whoami", "/api/whoami"];
test("every live profile admits exact whoami and nothing near it", () => {
  for (const target of ["page10", "pages"]) {
    assert.equal(deploymentProfile(target).whoami, true);
    const route = new RegExp(/^    path: (.+)$/m.exec(routesFor(target))[1]);
    assert.equal(route.test("/whoami"), true, target);
    assert.equal(route.test(new URL("https://example.com/whoami?probe=1").pathname), true);
    for (const pathname of [...whoamiRejected, "/whoami.json", "/x/whoami", "/%77hoami"])
      assert.equal(route.test(pathname), false, `${target} ${pathname}`);
  }
});

for (const target of ["page10", "pages"])
  for (const misroutePath of ["/whoami", ...whoamiRejected])
    test(`${target} refuses misrouted ${misroutePath} before connector activation`, (t) => {
      const f = fixture(t, { target, misroutePath });
      assert.throws(f.execute, /route validation failed/);
      assert.deepEqual(lifecycle(f), []);
    });

test("Page10 and Pages admit exactly Sift's hashed WASM", () => {
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

test("page10 installs fresh and refuses older route sets as predecessors", (t) => {
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
  assert.equal(result.frozenTargetsUnchanged, undefined);
  assert.equal(fs.readFileSync(f.local(plan.configPath), "utf8"), plan.config);
  assert.equal(fs.readFileSync(f.local(installation), "utf8"), receipt(plan.config));
  assert.deepEqual(lifecycle(f), [
    "start cloudflared-page10-a.service",
    "enable cloudflared-page10-a.service",
  ]);
  assert.equal(fs.existsSync(f.local(plan.unitPath)), false, "no legacy unit on a fresh install");
  // A route set without the index routes, Project links or Mermaid path is not
  // a predecessor of Page10's. Each one is refused,
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

test("Page10 refuses Pages manifests, connector credentials and installation receipts", (t) => {
  const value = inputFor("page10");
  assert.throws(
    () => isolatedPublicationPlan({ ...value, target: "pages" }),
    /Unexpected deployment target/,
  );
  assert.throws(
    () =>
      isolatedPublicationPlan({ ...value, frozenTunnelConfigs: ["tunnel: " + tunnelId + "\n"] }),
    /different tunnel/,
  );
  const f = fixture(t, { target: "page10" });
  const foreign = isolatedPublicationPlan(inputFor("pages"));
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
  assert.equal(result.frozenTargetsUnchanged, undefined);
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

test("OAuth and private images publish only exact Page10 and Pages routes", () => {
  for (const target of ["page10", "pages"]) {
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
      assert.equal(route.test(pathname), true, `${target}: ${pathname}`);
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

for (const target of ["page10", "pages"])
  test(`${target} publication retries leave the shared connector untouched`, (t) => {
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
      assert.equal(result.frozenTargetsUnchanged, undefined);
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

const imageAssetPath = "/api/pages/08c583e5-d29e-4f1e-b06b-333965254e94/assets";
for (const target of ["page10", "pages"])
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

const tagPath = "/api/pages/08c583e5-d29e-4f1e-b06b-333965254e94/tags";
for (const target of ["page10", "pages"])
  test(`${target} publisher verifies REST ingress before starting its connector`, (t) => {
    const f = fixture(t, { target });
    f.execute();
    const start = f.calls.findIndex(
      ({ command, args }) => command === "systemctl" && ["start", "restart"].includes(args[0]),
    );
    assert.ok(start >= 0);
    const paths = f.calls
      .slice(0, start)
      .filter(({ command, args }) => command === "/usr/bin/cloudflared" && args.includes("rule"))
      .map(({ args }) => new URL(args.at(-1)))
      .map((url) => url.pathname + url.search);
    for (const pathname of [
      "/api/pages",
      "/api/pages?tags=status%3Adone&limit=1",
      tagPath + "/status",
      tagPath + "/repo%3Aorg%2Fname",
      "/api/pages/",
      tagPath,
      tagPath + "/",
      tagPath + "/a;b",
      "/api/pages/arbitrary/tags/status",
      "/api/projects/prj_08c583e5-d29e-4f1e-b06b-333965254e94/tags/status",
    ])
      assert.ok(paths.includes(pathname), pathname);
  });

for (const target of ["page10", "pages"])
  test(`${target} publisher refuses to start a connector that drops a tag's encoded slash`, (t) => {
    const f = fixture(t, { target, misroutePath: tagPath + "/repo%3Aorg%2Fname" });
    assert.throws(() => f.execute(), /Dedicated tunnel route validation failed/);
    assert.ok(
      !f.calls.some(
        ({ command, args }) => command === "systemctl" && ["start", "restart"].includes(args[0]),
      ),
    );
  });

for (const target of ["page10", "pages"])
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

for (const target of ["page10", "pages"])
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

for (const target of ["page10", "pages"])
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
  for (const target of ["page10", "pages"])
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

test("page10, pages and pages2 admit the exact account routes", () => {
  for (const target of ACCOUNT_TARGETS) {
    assert.equal(deploymentProfile(target).accountRoutes, true, target);
    const current = routesFor(target);
    assert.equal(current.split(accountPaths).length, 2, target);
    const route = new RegExp(/^    path: (.+)$/m.exec(current)[1]);
    for (const pathname of accountAdmitted)
      assert.equal(route.test(pathname), true, `${target} ${pathname}`);
    for (const pathname of accountRejected)
      assert.equal(route.test(pathname), false, `${target} ${pathname}`);
    // The routes that were there stay admitted.
    for (const pathname of ["/api/auth/login", "/api/auth/logout", "/api/auth/session"])
      assert.equal(route.test(pathname), true, `${target} ${pathname}`);
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
for (const state of ["sealed", "pending-old", "pending-new"])
  test(`page10 publishes explicit previews from its existing slotted installation (${state})`, (t) => {
    const f = fixture(t, { target: "page10" });
    const x = slotInstall(f, beforePublishedPreviews, { state });
    const units = x.plan.slots.map((slot) => fs.readFileSync(f.local(slot.unitPath), "utf8"));
    const result = f.execute();
    assert.equal(result.routesUpdated, true);
    assert.equal(fs.readFileSync(f.local(x.plan.configPath), "utf8"), x.plan.config);
    assert.equal(installedReceipt(f), slotReceipt(x.plan.config, x.plan.unitSha256));
    assert.deepEqual(
      x.plan.slots.map((slot) => fs.readFileSync(f.local(slot.unitPath), "utf8")),
      units,
    );
    assertNoGap(f);
    f.calls.length = 0;
    assert.equal(f.execute().routesUpdated, false);
  });

test("a failed preview-route connector restores the sealed page10 routes and can retry", (t) => {
  const f = fixture(t, { target: "page10" });
  const x = slotInstall(f, beforePublishedPreviews);
  f.failNextStart();
  assert.throws(f.execute, /injected connector startup failure/);
  assert.equal(fs.readFileSync(f.local(x.plan.configPath), "utf8"), x.base);
  assert.equal(installedReceipt(f), slotReceipt(x.base, x.plan.unitSha256));
  assertNoGap(f);
  assert.equal(f.execute().routesUpdated, true);
});

test("page10 migrates the same sealed preview predecessor from a legacy connector", (t) => {
  const f = fixture(t, { target: "page10" });
  const plan = isolatedPublicationPlan(inputFor("page10"));
  const previous = beforePublishedPreviews(plan.config);
  f.write(plan.configPath, previous);
  f.write(plan.unitPath, plan.unit);
  f.write(
    configDir("page10") + "/tunnel-installation.json",
    slotReceipt(previous, digest(plan.unit)),
  );
  f.activate(plan.service);
  assert.equal(f.execute().routesUpdated, true);
  assert.equal(installedReceipt(f), slotReceipt(plan.config, plan.unitSha256));
  assertNoGap(f);
});

test("preview-route migration adds either preview group alone", (t) => {
  for (const from of [
    (config) => config.replace(publishedPreviewPaths, ""),
    (config) => config.replace(publishedPreviewApiPaths, ""),
  ]) {
    const f = fixture(t, { target: "page10" });
    const x = slotInstall(f, from);
    assert.equal(f.execute().routesUpdated, true);
    assert.equal(fs.readFileSync(f.local(x.plan.configPath), "utf8"), x.plan.config);
    assert.equal(installedReceipt(f), slotReceipt(x.plan.config, x.plan.unitSha256));
  }
});

test("preview-route migration refuses unrelated edits even with matching receipts", (t) => {
  const f = fixture(t, { target: "page10" });
  slotInstall(f, (config) =>
    beforePublishedPreviews(config).replace("health|", "health|arbitrary|"),
  );
  assert.throws(f.execute, /installation differs/);
  assert.equal(f.writes.length, 0);
  assert.deepEqual(lifecycle(f), []);
});
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

test("page10, pages and pages2 admit link previews, card images and Project assets", () => {
  for (const target of PREVIEW_TARGETS) {
    const profile = deploymentProfile(target);
    for (const flag of ["linkPreviews", "cardImages", "projectAssets"])
      assert.equal(profile[flag], true, `${target} ${flag}`);
    const current = routesFor(target);
    for (const group of [linkPreviewPaths, cardImagePaths, projectAssetPaths])
      assert.equal(current.split(group).length, 2, `${target} ${group}`);
    const route = new RegExp(/^    path: (.+)$/m.exec(current)[1]);
    for (const pathname of previewAdmitted)
      assert.equal(route.test(pathname), true, `${target} ${pathname}`);
    for (const pathname of previewRejected)
      assert.equal(route.test(pathname), false, `${target} ${pathname}`);
    // The viewer routes beside them stay as they were.
    for (const pathname of [
      `/p/${previewUuid}`,
      `/p/${previewUuid}/`,
      `/project/prj_${previewUuid}`,
      `/api/pages/${previewUuid}/assets/${previewHash}`,
    ])
      assert.equal(route.test(pathname), true, `${target} ${pathname}`);
  }
});

test("Page slug routes admit bounded titles and refuse extra path segments", () => {
  for (const target of ["page10", "pages", "pages2", "page11"]) {
    const current = routesFor(target);
    assert.equal(current.split(pageSlugPaths).length, 2, target);

    const route = new RegExp(/^    path: (.+)$/m.exec(current)[1]);
    for (const pathname of [
      `/p/${previewUuid}/My-Dashboard`,
      `/p/${previewUuid}/My-Dashboard/`,
      `/p/${previewUuid}/q3_plan-v2`,
      `/p/${previewUuid}/${"a".repeat(80)}`,
    ])
      assert.equal(route.test(pathname), true, `${target} ${pathname}`);
    for (const pathname of [
      `/p/${previewUuid}/My.Dashboard`,
      `/p/${previewUuid}/My%20Dashboard`,
      `/p/${previewUuid}/${"a".repeat(81)}`,
      `/p/${previewUuid}/My-Dashboard/more`,
      `/p/${previewUuid}//My-Dashboard`,
      `/p/${previewUuid.toUpperCase()}/My-Dashboard`,
    ])
      assert.equal(route.test(pathname), false, `${target} ${pathname}`);
  }
});

// A set with Page slugs and without the REST routes was never published, but
// it is one this tool generates, so it migrates like any other.
for (const target of ["page10", "pages", "pages2", "page11"])
  test(`${target} migrates an installation with Page slugs and without the REST routes`, (t) => {
    const f = fixture(t, { target, sharedTunnel: !["pages2", "page11"].includes(target) });
    const x = slotInstall(f, (config) => config.replace(restPaths, ""));
    assert.equal(f.execute().routesUpdated, true);
    assert.equal(fs.readFileSync(f.local(x.plan.configPath), "utf8"), x.plan.config);
    assert.equal(installedReceipt(f), slotReceipt(x.plan.config, x.plan.unitSha256));
  });

for (const target of ["page10", "pages", "pages2", "page11"])
  for (const state of ["sealed", "pending-old", "pending-new"])
    test(`${target} adds Page slugs to the REST release's installation (${state})`, (t) => {
      const f = fixture(t, { target, sharedTunnel: !["pages2", "page11"].includes(target) });
      const x = slotInstall(f, beforeSlugs, { state });
      const units = x.plan.slots.map((slot) => fs.readFileSync(f.local(slot.unitPath), "utf8"));
      const result = f.execute();
      assert.equal(result.routesUpdated, true);
      assert.equal(fs.readFileSync(f.local(x.plan.configPath), "utf8"), x.plan.config);
      assert.equal(installedReceipt(f), slotReceipt(x.plan.config, x.plan.unitSha256));
      // Only the routes changed.
      assert.deepEqual(
        x.plan.slots.map((slot) => fs.readFileSync(f.local(slot.unitPath), "utf8")),
        units,
      );
      assertNoGap(f);
      f.calls.length = 0;
      assert.equal(f.execute().routesUpdated, false);
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

  test(`${target} migrates from a pending receipt the account-route publish left`, (t) => {
    // That publish was interrupted after its pending receipt, with its new
    // config already on disk. This release migrates from that config, and a
    // failed start restores the receipt as it was.
    const f = fixture(t, shared);
    const plan = isolatedPublicationPlan(inputFor(target));
    const sealed = beforePreviews(plan.config);
    const before = sealed.replace(accountPaths, "");
    f.write(plan.configPath, sealed);
    for (const slot of plan.slots) f.write(slot.unitPath, slot.unit);
    const pending = slotReceipt(sealed, plan.unitSha256, {
      previous_config_sha256: digest(before),
      previous_unit_sha256: plan.unitSha256,
    });
    f.write(configDir(target) + "/tunnel-installation.json", pending);
    f.write(
      recordPath(target),
      JSON.stringify({ schema: 1, phase: "serving", live: "a", config: digest(sealed) }),
    );
    f.activate(plan.slots[0].service);
    f.failNextStart();
    assert.throws(f.execute, /injected connector startup failure/);
    assert.equal(installedReceipt(f), pending);
    assert.equal(fs.readFileSync(f.local(plan.configPath), "utf8"), sealed);
    assertNoGap(f);
    assert.equal(f.execute().routesUpdated, true);
    assert.equal(fs.readFileSync(f.local(plan.configPath), "utf8"), plan.config);
    assert.equal(installedReceipt(f), slotReceipt(plan.config, plan.unitSha256));
    // With the older release's previous config on disk instead, it migrates
    // from that one.
    const g = fixture(t, shared);
    g.write(plan.configPath, before);
    for (const slot of plan.slots) g.write(slot.unitPath, slot.unit);
    g.write(configDir(target) + "/tunnel-installation.json", pending);
    g.write(
      recordPath(target),
      JSON.stringify({ schema: 1, phase: "serving", live: "a", config: digest(before) }),
    );
    g.activate(plan.slots[0].service);
    assert.equal(g.execute().routesUpdated, true);
    assert.equal(installedReceipt(g), slotReceipt(plan.config, plan.unitSha256));
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

// The installation the package release sealed, with neither the REST routes
// nor Page slugs (A). It migrates straight to both.
const restInstall = (f, options) =>
  slotInstall(f, (config) => beforeSlugs(config).replace(restPaths, ""), options);

for (const target of ["page10", "pages", "pages2", "page11"])
  for (const state of ["sealed", "pending-old", "pending-new"])
    test(`${target} adds the REST routes and Page slugs to the package release's installation (${state})`, (t) => {
      const f = fixture(t, { target, sharedTunnel: !["pages2", "page11"].includes(target) });
      const x = restInstall(f, { state });
      const units = x.plan.slots.map((slot) => fs.readFileSync(f.local(slot.unitPath), "utf8"));
      const result = f.execute();
      assert.equal(result.routesUpdated, true);
      assert.equal(result.connectorHandoff, true);
      assert.equal(fs.readFileSync(f.local(x.plan.configPath), "utf8"), x.plan.config);
      assert.equal(installedReceipt(f), slotReceipt(x.plan.config, x.plan.unitSha256));
      // Only the routes changed.
      assert.deepEqual(
        x.plan.slots.map((slot) => fs.readFileSync(f.local(slot.unitPath), "utf8")),
        units,
      );
      f.calls.length = 0;
      assert.equal(f.execute().routesUpdated, false);
    });

for (const state of ["sealed", "pending-old", "pending-new"])
  test(`page10 publishes media guides from the previously deployed routes (${state})`, (t) => {
    const f = fixture(t, { target: "page10" });
    const x = slotInstall(f, beforeMediaGuides, { state });
    assert.equal(f.execute().routesUpdated, true);
    assert.equal(fs.readFileSync(f.local(x.plan.configPath), "utf8"), x.plan.config);
    assert.equal(installedReceipt(f), slotReceipt(x.plan.config, x.plan.unitSha256));
    assertNoGap(f);
    assert.equal(f.execute().routesUpdated, false);
  });

test("media-guide migration rolls back a failed connector and retries", (t) => {
  const f = fixture(t, { target: "page10" });
  const x = slotInstall(f, beforeMediaGuides);
  f.failNextStart();
  assert.throws(f.execute, /injected connector startup failure/);
  assert.equal(fs.readFileSync(f.local(x.plan.configPath), "utf8"), x.base);
  assert.equal(installedReceipt(f), slotReceipt(x.base, x.plan.unitSha256));
  assertNoGap(f);
  assert.equal(f.execute().routesUpdated, true);
});

test("media-guide migration refuses unrelated config edits even with a matching receipt", (t) => {
  const f = fixture(t, { target: "page10" });
  slotInstall(f, (config) => beforeMediaGuides(config).replace("health|", "health|arbitrary|"));
  assert.throws(f.execute, /installation differs/);
  assert.equal(f.writes.length, 0);
  assert.deepEqual(lifecycle(f), []);
});

// The route registry (routes.mjs) and the installations publication derives
// from it. Publication recognizes a config only if it regenerates it.

// Every target's routes, by sha256. Update a hash only when the routes change
// on purpose.
const ROUTES_SHA256 = {
  page10: "d66bcef8809207ba4f54db72c0ae31e73ba163efa850fe381e3c1c00ca878359",
  pages: "6f24e1b42da8a405ed6682ff23076930f897f8aa079227f2971eab322e53b5a7",
  pages2: "08ce2af861a2563a4d091f4b04b937096da6a113b065ea0a3544d5a9f67e3ef0",
  page11: "e5882155195aea955d4e7950e36ab4da068398351a91b30b9657bd71fda47561",
};
// Each route group's path string, by sha256.
const SLOT_SHA256 = {
  themePaths: "10114183135a21a2e07cb9157fc1fcc2b7a8568e5be98e7607185b535276ca74",
  chunkPaths: "1387c0a673175a9a4685fd52b471f176125b11931af853d88cb37d0f4a5d060b",
  assetPaths: "3a7485ab6ba0e95b394d4565e1aef41a03daa7eeabf2a9597561a1f67214de6b",
  siftPaths: "68a984a8ef64a919f97f9c2a5623c33adf533cd6a39ac5b0894d88827f209fb5",
  rendererPaths: "3b31d8b815248a7e16df03943a4a667b15ea65faefe11b1f4322643284e48166",
  connectPaths: "837a28c92cf0090120b15be90c9aa315e867cf2faa416272981cff22c8cb8270",
  whoamiPaths: "4b183f7c96547772d245d5dcf53a8314059122bf5475ec562fd49ab0163d3076",
  oauthPaths: "39a99c073a5dbe656548867204e5ac90d223b17b9d8fd9db53472abaa241e909",
  mediaGuidePaths: "c4009a361ae5dd9a240f8fc1c5174a461d077eaac227f0212848d405520b786a",
  pageSlugPaths: "84878039740d3ab35cb3452e94bfec890dfe1bac6394534e3cb5edca489a2e1d",
  projectPaths: "e6116a064f1f1c567ffd3f8f261840ce2e1d933197562ac35e11d2b82bed9b42",
  indexPaths: "9c601632f93c7c191537301ee45ff16c70a98955c7589905da70b8911dcbdcdb",
  linkPreviewPaths: "a453f57327bbd5754a0983051de9df23bf33095c055a34d51e377a247bd49935",
  publishedPreviewPaths: "d4a119519b0b65b9b17986bbb43c05ef32ecf32df70d89cccb7c1fb7563a10a5",
  accessPaths: "90f99dd8cc2102c7e443b09533423a5305687f72321d7165fa8912cae43f246f",
  publishedPreviewApiPaths: "608832b4dc9705ee8a5aaaa2a3a5b2cac7bdbf1658ee4777a05f9a1cc0ed0fb9",
  imagePaths: "d6c871ac41ebb81f11e66de8db9b9d93cae291ab09edb3c96372e994faa097ca",
  accountPaths: "feb73d30bcc375d5ce9aac23109794f8c9ddfabd264266ce5d616a9325bd1091",
  cardImagePaths: "9dab97d302774e93c9ccf838728b0c8bdb6c10c690fe8a7b3c2901443acac2cf",
  projectAssetPaths: "3cdd4432f3c56ec249c4730852e620faf67d952c691a67f1e9a9fc9ec60b7b0d",
  restPaths: "e21835bed4ddd16f0ae7d4901fb579626ade73338e2433e2ad80d9cd60c86530",
};
// Groups present in every installation still recognized. Every other group
// is strippable: publication migrates from an installation without it.
const SETTLED_GROUPS = [
  "themePaths",
  "chunkPaths",
  "assetPaths",
  "rendererPaths",
  "connectPaths",
  "oauthPaths",
  "projectPaths",
  "indexPaths",
  "accessPaths",
  "imagePaths",
];
const STRIPPABLE_GROUPS = [
  "siftPaths",
  "whoamiPaths",
  "mediaGuidePaths",
  "pageSlugPaths",
  "linkPreviewPaths",
  "publishedPreviewPaths",
  "publishedPreviewApiPaths",
  "accountPaths",
  "cardImagePaths",
  "projectAssetPaths",
  "restPaths",
];
const SLOTTED_TARGETS = ["page10", "pages", "pages2", "page11"];
const hostOptions = (target) => ({
  target,
  sharedTunnel: !["pages2", "page11"].includes(target),
});
// This target's config without the strippable groups `omit`.
const configWithout = (target, omit) =>
  isolatedPublicationPlan(inputFor(target)).config.replace(
    routesFor(target),
    routesFor(target, { omit }),
  );

test("the route registry generates every target's routes byte for byte", () => {
  assert.deepEqual(Object.keys(ROUTES_SHA256).sort(), [...DEPLOYMENT_TARGETS].sort());
  for (const target of DEPLOYMENT_TARGETS)
    assert.equal(digest(routesFor(target)), ROUTES_SHA256[target], target);
});

test("route group strings are pinned", () => {
  const named = ROUTE_REGISTRY.filter((entry) => entry.name);
  assert.deepEqual(
    named.map((entry) => entry.name),
    Object.keys(SLOT_SHA256),
  );
  for (const entry of named)
    assert.equal(
      digest(entry.paths),
      SLOT_SHA256[entry.name],
      `${entry.name} changed. A changed group string makes configs sealed with the old one ` +
        "unrecognizable: keep the old string in the slot's `earlier` list, then update this hash.",
    );
});

test("every optional route group is either strippable or explicitly settled", () => {
  const named = ROUTE_REGISTRY.filter((entry) => entry.name);
  for (const entry of named) {
    assert.equal(typeof entry.settled, "boolean", entry.name);
    assert.ok(Array.isArray(entry.earlier), entry.name);
    assert.equal(typeof entry.enabled, "function", entry.name);
  }
  assert.deepEqual(
    named.filter((entry) => entry.settled).map((entry) => entry.name),
    SETTLED_GROUPS,
    "settle a group only once every installation still in service has it",
  );
  assert.deepEqual(
    named.filter((entry) => !entry.settled).map((entry) => entry.name),
    STRIPPABLE_GROUPS,
  );
  for (const target of SLOTTED_TARGETS)
    assert.deepEqual(
      strippableSlots(target).map((entry) => entry.name),
      STRIPPABLE_GROUPS,
    );
});

test("routesFor omits only strippable groups and uses only earlier strings", () => {
  assert.throws(() => routesFor("page10", { omit: ["themePaths"] }), /Not a strippable/);
  assert.throws(() => routesFor("page10", { omit: ["nonsense"] }), /Not a strippable/);
  assert.throws(() => routesFor("page10", { use: { restPaths: "pages|" } }), /Not an earlier/);
  assert.equal(
    routesFor("page10", { omit: ["restPaths"] }),
    routesFor("page10").replace(restPaths, ""),
  );
});

// Publication refuses more than 2^16 combinations, so this fails in CI first.
test("publication knows every combination of each target's strippable groups", () => {
  for (const target of SLOTTED_TARGETS) {
    const plan = isolatedPublicationPlan(inputFor(target));
    const known = knownTunnelConfigs(target, tunnelId);
    assert.equal(known.size, 2 ** STRIPPABLE_GROUPS.length, target);
    assert.equal(known.get(digest(plan.config)), plan.config);
    const none = configWithout(target, STRIPPABLE_GROUPS);
    assert.equal(known.get(digest(none)), none);
  }
});

for (const target of SLOTTED_TARGETS)
  test(`${target} migrates an installation missing any one strippable group`, (t) => {
    for (const group of STRIPPABLE_GROUPS) {
      const f = fixture(t, hostOptions(target));
      const x = slotInstall(f, () => configWithout(target, [group]));
      assert.notEqual(x.base, x.plan.config, group);
      assert.equal(f.execute().routesUpdated, true, group);
      assert.equal(fs.readFileSync(f.local(x.plan.configPath), "utf8"), x.plan.config, group);
      assert.equal(installedReceipt(f), slotReceipt(x.plan.config, x.plan.unitSha256), group);
      assertNoGap(f);
    }
  });
for (const target of SLOTTED_TARGETS)
  test(`${target} migrates an installation missing several strippable groups`, (t) => {
    for (const omit of [
      STRIPPABLE_GROUPS,
      STRIPPABLE_GROUPS.filter((_, index) => index % 2 === 0),
      STRIPPABLE_GROUPS.filter((_, index) => index % 3 === 1),
      ["pageSlugPaths", "cardImagePaths", "whoamiPaths"],
    ])
      for (const state of ["sealed", "pending-old", "pending-new"]) {
        const f = fixture(t, hostOptions(target));
        const x = slotInstall(f, () => configWithout(target, omit), { state });
        assert.equal(f.execute().routesUpdated, true, omit.join() + " " + state);
        assert.equal(fs.readFileSync(f.local(x.plan.configPath), "utf8"), x.plan.config);
        assert.equal(installedReceipt(f), slotReceipt(x.plan.config, x.plan.unitSha256));
      }
  });

test("page10 migrates a legacy connector at an installation missing several groups", (t) => {
  const f = fixture(t, { target: "page10" });
  const plan = isolatedPublicationPlan(inputFor("page10"));
  const previous = configWithout("page10", ["restPaths", "siftPaths", "accountPaths"]);
  f.write(plan.configPath, previous);
  f.write(plan.unitPath, plan.unit);
  f.write(
    configDir("page10") + "/tunnel-installation.json",
    slotReceipt(previous, digest(plan.unit)),
  );
  f.activate(plan.service);
  assert.equal(f.execute().routesUpdated, true);
  assert.equal(installedReceipt(f), slotReceipt(plan.config, plan.unitSha256));
  assertNoGap(f);
});

test("a config one character off every generated combination is refused, receipt forged or not", (t) => {
  const plan = isolatedPublicationPlan(inputFor("page10"));
  const subset = configWithout("page10", ["restPaths", "whoamiPaths"]);
  for (const changed of [
    subset.replace("health|", "healtH|"),
    subset.replace("health|", "healthy|"),
    subset.replace("health|", "healt|"),
    subset + "#",
    plan.config.replace("mcp|", "mcP|"),
  ]) {
    // The receipt forged to name the changed config.
    const f = fixture(t, { target: "page10" });
    slotInstall(f, () => changed);
    assert.throws(f.execute, /installation differs/);
    assert.equal(f.writes.length, 0);
    assert.deepEqual(lifecycle(f), []);
    // The receipt for the generated config, with the changed one on disk.
    const g = fixture(t, { target: "page10" });
    slotInstall(g, () => subset);
    g.write(plan.configPath, changed);
    assert.throws(g.execute, /Dedicated tunnel (installation differs|migration requires)/);
    assert.equal(g.writes.length, 0);
    assert.deepEqual(lifecycle(g), []);
  }
});

test("a receipt not byte-identical to one publication writes is refused", (t) => {
  const plan = isolatedPublicationPlan(inputFor("page10"));
  const subset = configWithout("page10", ["restPaths"]);
  const fields = {
    schema: 1,
    tunnel_id: tunnelId,
    config_sha256: digest(subset),
    unit_sha256: plan.unitSha256,
  };
  const pendingFields = {
    schema: 1,
    tunnel_id: tunnelId,
    config_sha256: digest(plan.config),
    unit_sha256: plan.unitSha256,
    previous_config_sha256: digest(subset),
    previous_unit_sha256: plan.unitSha256,
  };
  const line = (value) => JSON.stringify(value) + "\n";
  for (const receipt of [
    line({ ...fields, note: "x" }),
    line({ tunnel_id: tunnelId, schema: 1, ...fields }),
    line({
      schema: 1,
      tunnel_id: tunnelId,
      unit_sha256: plan.unitSha256,
      config_sha256: digest(subset),
    }),
    line({ ...fields, tunnel_id: "abcdef12-1234-4123-8123-123456789abc" }),
    line({ ...fields, schema: 2 }),
    line({ ...fields, unit_sha256: "f".repeat(64) }),
    line({ ...fields, config_sha256: "0".repeat(64) }),
    line({ ...fields, previous_unit_sha256: plan.unitSha256 }),
    line({ ...pendingFields, previous_unit_sha256: "f".repeat(64) }),
    line({ ...pendingFields, previous_config_sha256: "0".repeat(64) }),
    line({
      schema: 1,
      tunnel_id: tunnelId,
      config_sha256: digest(plan.config),
      unit_sha256: plan.unitSha256,
      previous_unit_sha256: plan.unitSha256,
      previous_config_sha256: digest(subset),
    }),
    // The receipt for the installed files, never a migration.
    line({
      ...pendingFields,
      previous_config_sha256: digest(plan.config),
      previous_unit_sha256: plan.unitSha256,
    }),
    JSON.stringify(fields, null, 2) + "\n",
    JSON.stringify(fields),
    line([fields]),
    "not json\n",
  ]) {
    const f = fixture(t, { target: "page10" });
    slotInstall(f, () => subset);
    f.write(configDir("page10") + "/tunnel-installation.json", receipt);
    assert.throws(f.execute, /installation differs/, receipt);
    assert.equal(f.writes.length, 0);
    assert.deepEqual(lifecycle(f), []);
  }
});

test("an interrupted migration from any generated combination rolls back to its exact bytes", (t) => {
  for (const omit of [
    ["restPaths"],
    ["mediaGuidePaths", "publishedPreviewApiPaths"],
    STRIPPABLE_GROUPS.filter((_, index) => index % 2 === 1),
    STRIPPABLE_GROUPS,
  ]) {
    const f = fixture(t, { target: "page10" });
    const x = slotInstall(f, () => configWithout("page10", omit), {
      state: "pending-new",
    });
    assert.equal(fs.readFileSync(f.local(x.plan.configPath), "utf8"), x.plan.config);
    f.failNextStart();
    assert.throws(f.execute, /injected connector startup failure/);
    assert.equal(fs.readFileSync(f.local(x.plan.configPath), "utf8"), x.base, omit.join());
    assert.equal(installedReceipt(f), slotReceipt(x.base, x.plan.unitSha256));
    assertNoGap(f);
    assert.equal(f.execute().routesUpdated, true);
    assert.equal(installedReceipt(f), slotReceipt(x.plan.config, x.plan.unitSha256));
  }
});
