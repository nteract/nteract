import test from "node:test";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { sourceFingerprint } from "./source-fingerprint.mjs";
import { configureDns } from "./deployment/dns.mjs";
import {
  pagesFirewall,
  enforcePublicHttps,
  metadataEgressQualification,
} from "./deployment/firewall.mjs";
import * as profiles from "./deployment/profiles.mjs";
import { CRONS } from "../shared/schedule.mjs";
import * as activation from "./deployment/activation.mjs";
import * as sessionKeys from "./deployment/session-keys.mjs";
import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import ts from "typescript";

test("fingerprint follows imported auth source and ignores output, generated upstream and unrelated churn", () => {
  const root = mkdtempSync(path.join(tmpdir(), "pages-inputs-"));
  const app = path.join(root, "apps/pages");
  const write = (file, value) => {
    const absolute = path.join(root, file);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, value);
  };
  try {
    for (const name of [
      "package.json",
      "package-lock.json",
      "upstream-provenance.json",
      "patch-upstream.mjs",
      "setup.mjs",
      "UPSTREAM.md",
    ])
      write("apps/pages/" + name, name.endsWith(".json") ? "{}" : "");
    write("apps/pages/worker.mjs", 'import "@cloud/identity.ts";');
    // Setup generates upstream/. An import into it is pinned by setup.mjs and
    // upstream-provenance.json, so the fingerprint neither follows nor needs it.
    write(
      "apps/pages/contract.vitest.mjs",
      'import "./upstream/packages/automerge-repo/test/contract.ts";',
    );
    write(
      "apps/notebook-cloud/src/identity.ts",
      'import "./verify.ts"; import "@nteract/local-oidc"; import "runtimed";',
    );
    write("apps/notebook-cloud/src/verify.ts", "export const verified = true;");
    write("packages/local-oidc/src/index.ts", "export const local = true;");
    write("packages/runtimed/src/scope-capabilities.ts", "export const scopes = ['reader'];");
    const original = sourceFingerprint(app, { root });
    assert.equal(sourceFingerprint(app, { root }).sha256, original.sha256);
    for (const output of [
      "dist/app.js",
      "node_modules/fake/index.js",
      "test-results/out.txt",
      "upstream/packages/automerge-repo/src/index.ts",
      ".source-cache/README.md",
      ".celld/state",
      ".env",
      ".dev.vars",
    ])
      write("apps/pages/" + output, "not an input");
    write("unrelated/README.md", "unrelated change");
    assert.equal(sourceFingerprint(app, { root }).sha256, original.sha256);
    write("apps/notebook-cloud/src/verify.ts", "export const verified = false;");
    assert.notEqual(sourceFingerprint(app, { root }).sha256, original.sha256);
    const updated = sourceFingerprint(app, { root }).sha256;
    write("apps/pages/new.mjs", "export const feature = true;");
    assert.notEqual(sourceFingerprint(app, { root }).sha256, updated);
    assert.ok(original.files["packages/runtimed/src/scope-capabilities.ts"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("every deployable target owns a tunnel service, so publication never edits a shared tunnel", () => {
  for (const target of profiles.QUALIFIED_TARGETS) {
    const profile = profiles.deploymentProfile(target);
    assert.match(profile.tunnelService, /^cloudflared-.+[.]service$/, target);
    assert.ok(profile.tunnelSlots.a && profile.tunnelSlots.b, target);
  }
  assert.deepEqual(profiles.DEPLOYMENT_TARGETS, profiles.QUALIFIED_TARGETS);
  assert.deepEqual(
    Object.fromEntries(
      profiles.QUALIFIED_TARGETS.map((target) => [
        target,
        profiles.deploymentProfile(target).frozenTargets ?? [],
      ]),
    ),
    { page10: [], pages: [], pages2: [], page11: ["pages2"] },
  );
});

test("service firewall uses its own cgroup, table and mark", () => {
  const rules = pagesFirewall(998, false, "page10");
  assert.match(rules, /table inet nteract_page10/);
  assert.match(rules, /system.slice\/nteract-page10.service/);
  assert.match(rules, /0x00200000/);
  assert.match(rules, /meta skuid \{ 0, 998 \}/);
  assert.doesNotMatch(rules, /nteract-pages.service|nteract_operator|0x40000000|0x80000000/);
  assert.throws(() => pagesFirewall(0, false, "page10"));
  assert.throws(() => pagesFirewall(998), /Unknown Pages deployment target/);
});

test("egress preparation is opt-in and installed rules survive qualification removal", () => {
  for (const phase of ["unconfigured", "prepared", "public-https"])
    for (const installed of [false, true]) {
      const enabled = enforcePublicHttps(phase, installed);
      assert.equal(enabled, installed || phase !== "unconfigured");
      const rules = pagesFirewall(998, false, "page10", enabled);
      assert.equal(rules.includes("chain public_https"), enabled);
      assert.ok(rules.includes("chain private_listener"));
    }
});

function dnsFixture(initial = []) {
  let records = initial;
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, options) => {
      calls.push({ url, method: options.method });
      let result;
      if (url.endsWith("/zones/7de7c86232f80c97a7aabfc880186b63"))
        result = {
          id: "7de7c86232f80c97a7aabfc880186b63",
          name: "runtimed.run",
          status: "active",
          type: "full",
        };
      else if (options.method === "POST") {
        records = [{ ...JSON.parse(options.body), id: "a".repeat(32) }];
        result = records[0];
      } else
        return Response.json({
          success: true,
          result: records,
          result_info: { page: 1, count: records.length, total_count: records.length },
        });
      return Response.json({ success: true, result });
    },
  };
}
const tunnelId = "b08c5d4e-41e9-4b75-8ada-4d4b84b58770";
test("DNS defaults to read-only and creates only the exact owned CNAME", async () => {
  const fixture = dnsFixture();
  const before = await configureDns({
    token: "fixture",
    tunnelId,
    target: "page10",
    fetchImpl: fixture.fetchImpl,
  });
  assert.equal(before.present, false);
  assert.ok(fixture.calls.every((call) => call.method === "GET"));
  const created = await configureDns({
    token: "fixture",
    tunnelId,
    target: "page10",
    apply: true,
    fetchImpl: fixture.fetchImpl,
  });
  assert.equal(created.changed, true);
  assert.equal(created.name, "page10.runtimed.run");
  assert.equal(fixture.calls.filter((call) => call.method === "POST").length, 1);
  const again = await configureDns({
    token: "fixture",
    tunnelId,
    target: "page10",
    apply: true,
    fetchImpl: fixture.fetchImpl,
  });
  assert.equal(again.changed, false);
  assert.equal(fixture.calls.filter((call) => call.method === "POST").length, 1);
});
test("DNS refuses foreign ownership, another tunnel, and ambiguous records", async () => {
  const desired = {
    id: "b".repeat(32),
    name: "page10.runtimed.run",
    type: "CNAME",
    content: `${tunnelId}.cfargotunnel.com`,
    proxied: true,
    ttl: 1,
    comment: "nteract/pages:experiment:page10",
  };
  for (const records of [
    [{ ...desired, comment: "foreign" }],
    [{ ...desired, content: "elsewhere.example" }],
    [desired, desired],
  ]) {
    const fixture = dnsFixture(records);
    await assert.rejects(
      configureDns({
        token: "fixture",
        tunnelId,
        target: "page10",
        apply: true,
        fetchImpl: fixture.fetchImpl,
      }),
    );
    assert.ok(fixture.calls.every((call) => call.method === "GET"));
  }
});
test("DNS transport errors do not echo credentials", async () => {
  await assert.rejects(
    configureDns({
      token: "secret-value",
      tunnelId,
      target: "page10",
      fetchImpl: async () => {
        throw new Error("secret-value");
      },
    }),
    (error) => !error.message.includes("secret-value"),
  );
});

test("release staging copies only built artifacts, never development credentials/state", async () => {
  const { stageArtifacts, releaseArtifacts, releaseFilesOf } =
    await import("./stage-artifacts.mjs");
  const { readFileSync, readdirSync, symlinkSync } = await import("node:fs");
  const root = mkdtempSync(path.join(tmpdir(), "pages-artifacts-"));
  const dist = path.join(root, "dist"),
    destination = path.join(root, "release");
  function write(relative, value) {
    const file = path.join(dist, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, value);
  }
  function files(directory, prefix = "") {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? files(path.join(directory, entry.name), prefix + entry.name + "/")
        : [prefix + entry.name],
    );
  }
  const { createHash } = await import("node:crypto");
  const { VIEWER_ASSETS, hashedAssetPath } = await import("./viewer-chunks.mjs");
  const sha256 = (value) => createHash("sha256").update(value).digest("hex");
  const chunks = ["public/chunks/ABCDEFGH.js", "public/chunks/IJKLMN23.js"];
  const certified = Object.fromEntries(chunks.map((file) => [file, sha256("artifact:" + file)]));
  // Each shell asset's name carries the hash of its bytes.
  const assetBytes = Object.fromEntries(
    VIEWER_ASSETS.map((name) => [hashedAssetPath(name, "asset:" + name), "asset:" + name]),
  );
  const assets = Object.keys(assetBytes);
  const certifiedAssets = Object.fromEntries(
    Object.entries(assetBytes).map(([file, bytes]) => [file, sha256(bytes)]),
  );
  const contents = (artifact) =>
    artifact === "build-receipt.json" ? receipt : (assetBytes[artifact] ?? "artifact:" + artifact);
  const releaseFiles = Object.fromEntries(
    releaseFilesOf(chunks, assets).map((file) => [file, sha256(contents(file))]),
  );
  const receipt = JSON.stringify({
    viewer_chunks: certified,
    viewer_assets: certifiedAssets,
    files: releaseFiles,
  });
  const hashed = [...chunks, ...assets];
  const theme = assets.find((file) => file.startsWith("public/theme-"));
  try {
    for (const artifact of [...releaseArtifacts, ...hashed]) write(artifact, contents(artifact));
    for (const secret of [
      ".dev.vars",
      ".env",
      ".celld/dev/account.sqlite",
      "node_modules/extra.js",
      "public/.env",
      "unreviewed-worker.js",
    ])
      write(secret, "DO NOT SHIP");
    stageArtifacts(dist, destination);
    assert.deepEqual(files(destination).sort(), [...releaseArtifacts, ...hashed].sort());
    for (const artifact of [...releaseArtifacts, ...hashed])
      assert.equal(readFileSync(path.join(destination, artifact), "utf8"), contents(artifact));
    // public/chunks must match the receipt exactly: a stale chunk from an
    // earlier build, a missing chunk, or a receipt without the list all fail.
    write("public/chunks/STALE234.js", "artifact:stale");
    assert.throws(
      () => stageArtifacts(dist, path.join(root, "stale-chunk")),
      /differs from the viewer chunks/,
    );
    rmSync(path.join(dist, "public/chunks/STALE234.js"));
    rmSync(path.join(dist, chunks[1]));
    assert.throws(
      () => stageArtifacts(dist, path.join(root, "missing-chunk")),
      /differs from the viewer chunks/,
    );
    write(chunks[1], contents(chunks[1]));
    // A listed chunk whose bytes changed after the build keeps its name, so
    // only its digest gives it away. Nothing is staged.
    write(chunks[0], "artifact:tampered");
    assert.throws(
      () => stageArtifacts(dist, path.join(root, "tampered-chunk")),
      /Viewer chunk changed since the build: public[/]chunks[/]ABCDEFGH[.]js/,
    );
    assert.throws(() => readdirSync(path.join(root, "tampered-chunk")));
    write(chunks[0], contents(chunks[0]));
    for (const listed of [
      undefined,
      {},
      chunks,
      { "public/chunks/../index.js": certified[chunks[0]] },
      { "public/app.js": certified[chunks[0]] },
      { ...certified, [chunks[1]]: "not-a-digest" },
      { ...certified, [chunks[1]]: certified[chunks[1]].toUpperCase() },
    ]) {
      write(
        "build-receipt.json",
        JSON.stringify({ viewer_chunks: listed, viewer_assets: certifiedAssets }),
      );
      assert.throws(
        () => stageArtifacts(dist, path.join(root, "unlisted-chunks")),
        /must list the viewer chunks with their sha256/,
      );
    }
    assert.throws(() => readdirSync(path.join(root, "stale-chunk")));
    assert.throws(() => readdirSync(path.join(root, "unlisted-chunks")));
    // The shell assets follow the same rules, and each name must carry the
    // hash of the digest it is listed with.
    const { [theme]: themeDigest, ...withoutTheme } = certifiedAssets;
    const otherTheme = hashedAssetPath("theme.js", "other theme");
    for (const listed of [
      undefined,
      {},
      assets,
      withoutTheme,
      { ...withoutTheme, [otherTheme]: themeDigest },
      { ...certifiedAssets, "public/app-ABCDEFGH.js": certifiedAssets[assets[0]] },
      { ...certifiedAssets, "public/theme.js": themeDigest },
      { ...certifiedAssets, [theme]: themeDigest.toUpperCase() },
    ]) {
      write(
        "build-receipt.json",
        JSON.stringify({ viewer_chunks: certified, viewer_assets: listed }),
      );
      assert.throws(
        () => stageArtifacts(dist, path.join(root, "unlisted-assets")),
        /must list the viewer assets with their sha256/,
        JSON.stringify(listed),
      );
    }
    assert.throws(() => readdirSync(path.join(root, "unlisted-assets")));
    write("build-receipt.json", receipt);
    write(otherTheme, "other theme");
    assert.throws(
      () => stageArtifacts(dist, path.join(root, "stale-asset")),
      /public differs from the viewer assets/,
    );
    rmSync(path.join(dist, otherTheme));
    rmSync(path.join(dist, theme));
    assert.throws(
      () => stageArtifacts(dist, path.join(root, "missing-theme")),
      /public differs from the viewer assets/,
    );
    assert.throws(() => readdirSync(path.join(root, "missing-theme")));
    write(theme, "asset:tampered");
    assert.throws(
      () => stageArtifacts(dist, path.join(root, "tampered-theme")),
      /Viewer asset changed since the build: public[/]theme-[A-Z2-7]{8}[.]js/,
    );
    assert.throws(() => readdirSync(path.join(root, "tampered-theme")));
    write(theme, contents(theme));
    rmSync(path.join(dist, "public/connect.js"));
    assert.throws(() => stageArtifacts(dist, path.join(root, "missing-connect")), /connect[.]js/);
    assert.throws(() => readdirSync(path.join(root, "missing-connect")));
    write("public/connect.js", contents("public/connect.js"));
    rmSync(path.join(dist, "index.js"));
    symlinkSync(path.join(dist, ".dev.vars"), path.join(dist, "index.js"));
    assert.throws(() => stageArtifacts(dist, path.join(root, "rejected")), /regular file/);
    assert.throws(() => readdirSync(path.join(root, "rejected")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The deployment version the fixture's `celld deploy` reports.
const DEPLOYED = "c0ffee0123456789";
// What a build receipt lists as `record_storage` since the list exists.
const CURRENT_RECORD_STORAGE = ["automerge"];
const CURRENT_PLAIN_STORAGE_FORMATS = ["doc-store-v2-host-actor-prefix"];
function installFixture(
  t,
  {
    failure,
    previous = true,
    target = "page10",
    fresh = false,
    listeners = "",
    rules = "{}",
    prefixCount = "0",
    userExists = false,
    installedRuntime,
    candidateVersion,
    qualify = profiles.assertQualifiedDeploymentTarget,
    profile = profiles.deploymentProfile(target),
    // The unit's systemd state: { active, pid, startedAt (unix s),
    // needDaemonReload, dropIns (loaded paths), reloadSticks }.
    service = { active: false },
    // Live node leases; each node's /state reports `version(addr, deployed)`.
    nodes,
    nodeVersion = (_addr, deployed) => deployed,
    // Each local /health probe returns this body; a function receives the
    // build the manifest wants.
    health = (build) => JSON.stringify({ ok: true, prototype: "pages-celld-native", build }),
    // A fake clock that `sleep` advances, for adoption timeouts.
    clock,
    // The staged release's build receipt. The default is a current build that
    // reads the formats `target` holds.
    buildReceipt = {
      build_id: "0123456789ab",
      record_storage: CURRENT_RECORD_STORAGE,
      plain_storage_formats: CURRENT_PLAIN_STORAGE_FORMATS,
      document_formats:
        target === "page10"
          ? { "pages.page": [3], "pages.comments": [2] }
          : { "pages.page": [1], "pages.comments": [1] },
    },
  } = {},
) {
  const root = mkdtempSync(path.join(tmpdir(), "pages-install-retry-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const deployment = profiles.deploymentProfile(target).deployment;
  const stage = "/tmp/" + deployment.service + "-stage-test1234";
  const configDir = "/etc/" + deployment.service;
  const stateDir = "/var/lib/" + deployment.service;
  const local = (file) => path.join(root, file);
  const write = (file, value) => {
    mkdirSync(path.dirname(local(file)), { recursive: true });
    // The installer creates the service's config directory 0700; seeded ones match.
    if (file.startsWith(configDir + "/")) fs.chmodSync(local(configDir), 0o700);
    writeFileSync(local(file), value);
  };
  const digest = (value) => createHash("sha256").update(value).digest("hex");
  const source = fs.readFileSync(new URL("./deployment/install.mjs", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  const files = {
    "release/wrangler.json": JSON.stringify({
      main: "index.js",
      no_bundle: true,
      d1_databases: [profiles.AUTH_D1, profiles.USAGE_D1],
      triggers: { crons: [...CRONS] },
      durable_objects: { bindings: [{ name: "PAGES", class_name: "Page" }] },
      r2_buckets: [{ binding: "PAGES_ASSETS", bucket_name: "pages-images" }],
      migrations: [{ tag: "fixture", new_sqlite_classes: ["Page"] }],
    }),
    "release/index.js": "export default {};",
    "release/public/app.js": "console.log('fixture');",
    "install.mjs": "fixture installer",
    "firewall.mjs": "fixture firewall",
    "publish.mjs": "fixture publisher",
    "profiles.mjs": "fixture profiles",
  };
  for (const [file, value] of Object.entries(files)) write(stage + "/" + file, value);
  const manifest = {
    source_sha: "a".repeat(40),
    source_tree: "b".repeat(40),
    build_receipt: buildReceipt,
    deployment,
    runtime: { version: profiles.CELLD_RELEASE.version, sha256: profiles.CELLD_RELEASE.sha256 },
    files: Object.fromEntries(Object.entries(files).map(([file, value]) => [file, digest(value)])),
  };
  write(stage + "/manifest.json", JSON.stringify(manifest));
  write(deployment.runtime, "qualified runtime");
  if (installedRuntime)
    write("/opt/" + deployment.service + "/celld", installedRuntime.bytes ?? "previous runtime");
  if (!fresh) {
    write(
      configDir + "/ownership.json",
      JSON.stringify({ prefix: deployment.prefix, hostname: deployment.hostname }),
    );
    write(configDir + "/session-secret", "fixture-only-session-secret");
    if (previous) write(configDir + "/deployment.json", JSON.stringify({ id: "previous" }));
    mkdirSync(local(stateDir), { recursive: true });
  }
  for (const parent of ["/opt", "/etc", "/var/lib"]) mkdirSync(local(parent), { recursive: true });
  mkdirSync(local("/etc/systemd/system"), { recursive: true });
  const calls = [];
  const mutations = [];
  const outputs = [];
  const unitState = { dropIns: [], ...service };
  const dropInDir = "/etc/systemd/system/" + deployment.service + ".service.d";
  const leases = nodes ?? [
    { node: "node_" + "1".repeat(32), addr: deployment.internalListen, expires_ms: 9e15 },
  ];
  let pendingFailure = failure;
  const filesystem = {};
  for (const name of [
    "existsSync",
    "lstatSync",
    "mkdirSync",
    "readFileSync",
    "readdirSync",
    "statSync",
    "writeFileSync",
  ])
    // A number is a descriptor from openSync, already inside the fixture root.
    filesystem[name] = (file, ...args) =>
      fs[name](typeof file === "number" ? file : local(file), ...args);
  filesystem.chmodSync = filesystem.chownSync = () => {};
  // The fixture runs unprivileged while the installer sees uid 0, so files
  // under the fixture root present as root-owned, as on the host.
  const asRoot = (stat) =>
    Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { uid: 0, gid: 0 });
  filesystem.lstatSync = (file, ...args) => asRoot(fs.lstatSync(local(file), ...args));
  filesystem.openSync = (file, ...args) => fs.openSync(local(file), ...args);
  filesystem.fstatSync = (fd, ...args) => asRoot(fs.fstatSync(fd, ...args));
  filesystem.closeSync = (fd) => fs.closeSync(fd);
  filesystem.constants = fs.constants;
  filesystem.mkdtempSync = (prefix) => fs.mkdtempSync(local(prefix)).slice(root.length);
  filesystem.rmSync = (file, ...args) => fs.rmSync(local(file), ...args);
  filesystem.renameSync = (from, to) => fs.renameSync(local(from), local(to));
  filesystem.cpSync = (from, to, ...args) => {
    if (pendingFailure === "runtime-copy" && to.endsWith("/celld.next")) {
      pendingFailure = undefined;
      fs.writeFileSync(local(to), "changed during copy");
      return;
    }
    if (pendingFailure === "copy" && to.endsWith("/public/app.js")) {
      pendingFailure = undefined;
      throw Error("injected copy failure");
    }
    return fs.cpSync(local(from), local(to), ...args);
  };
  for (const name of [
    "mkdirSync",
    "writeFileSync",
    "chmodSync",
    "chownSync",
    "mkdtempSync",
    "rmSync",
    "renameSync",
    "cpSync",
  ]) {
    const mutate = filesystem[name];
    filesystem[name] = (...args) => {
      mutations.push(name);
      return mutate(...args);
    };
  }
  const childProcess = {
    execFileSync(command, args) {
      calls.push({ command, args });
      if (
        (pendingFailure === "deploy" && command === "runuser") ||
        (pendingFailure === "restart" && command === "systemctl" && args[0] === "restart") ||
        (pendingFailure === "verify" && command === "systemd-analyze") ||
        (pendingFailure === "firewall" && command === "/usr/bin/node")
      ) {
        pendingFailure = undefined;
        throw Object.assign(Error("injected command failure"), { status: 1 });
      }
      if (command === deployment.runtime) return candidateVersion ?? deployment.requiredVersion;
      if (command === "/opt/" + deployment.service + "/celld")
        return fs.readFileSync(local(command), "utf8") === "qualified runtime"
          ? deployment.requiredVersion
          : installedRuntime.version;
      if (command === "id") {
        if (fresh && !userExists && args.length === 1)
          throw Object.assign(Error("missing user"), { status: 1 });
        return "998";
      }
      if (command === "ss") return listeners;
      if (command === "/usr/local/bin/aws" && args.includes("KeyCount")) return prefixCount;
      if (command === "/usr/local/bin/aws" && args.includes("Contents[].Key"))
        return JSON.stringify(
          leases.map(({ node }) => deployment.prefix + "/nodes/" + node + ".json"),
        );
      if (command === "/usr/local/bin/aws" && args[0] === "s3" && args[1] === "cp")
        return JSON.stringify(leases.find(({ node }) => args[2].endsWith("/" + node + ".json")));
      if (command === "/usr/sbin/nft") return rules;
      if (command === "useradd") return "";
      if (command === "runuser") return JSON.stringify({ id: "current", version: DEPLOYED });
      if (command === "systemctl" && args[0] === "is-active") {
        if (unitState.active) return "active";
        throw Object.assign(Error("inactive"), { status: 3 });
      }
      if (command === "systemctl" && args[0] === "show")
        return [
          "MainPID=" + (unitState.pid ?? 0),
          "ExecMainStartTimestamp=" + (unitState.startedAt ? "@" + unitState.startedAt : ""),
          "NeedDaemonReload=" + (unitState.needDaemonReload ? "yes" : "no"),
          "DropInPaths=" + unitState.dropIns.join(" "),
        ].join("\n");
      if (command === "systemctl" && args[0] === "daemon-reload") {
        unitState.needDaemonReload = Boolean(unitState.reloadSticks);
        unitState.dropIns = fs.existsSync(local(dropInDir))
          ? fs
              .readdirSync(local(dropInDir))
              .filter((name) => name.endsWith(".conf"))
              .sort()
              .map((name) => dropInDir + "/" + name)
          : [];
        return "";
      }
      if (command === "systemctl" && args[0] === "restart") {
        Object.assign(unitState, {
          active: true,
          needDaemonReload: false,
          pid: (unitState.pid ?? 4000) + 1,
          startedAt: Math.floor(Date.now() / 1000),
        });
        return "";
      }
      if (command === "curl" && args.at(-1).endsWith("/state")) {
        const addr = args.at(-1).slice("http://".length, -"/state".length);
        return JSON.stringify({ deployment: { version: nodeVersion(addr, DEPLOYED) } });
      }
      if (command === "curl")
        return health(JSON.parse(read(stage + "/manifest.json")).build_receipt.build_id);
      if (command === "sleep") {
        if (clock) clock.now += Number(args[0]) * 1000;
        return "";
      }
      if (command === "/usr/bin/node") return "";
      if (command === "systemd-analyze" || command === "systemctl") return "";
      throw Error("Unexpected command: " + command);
    },
  };
  const modules = {
    "node:child_process": childProcess,
    "node:crypto": {
      // Stand in for the large official executable only; every other artifact
      // and tampered runtime still uses real SHA256 hashing.
      createHash: (algorithm) => ({
        update(value) {
          if (Buffer.from(value).equals(Buffer.from("qualified runtime")))
            return { digest: () => profiles.CELLD_RELEASE.sha256 };
          return createHash(algorithm).update(value);
        },
      }),
      randomBytes: (size) => Buffer.alloc(size, 42),
    },
    "node:fs": filesystem,
    "node:path": path,
    "./profiles.mjs": {
      ...profiles,
      assertQualifiedDeploymentTarget: qualify,
      deploymentProfile: () => profile,
    },
    "./activation.mjs": activation,
    "./session-keys.mjs": sessionKeys,
    "./firewall.mjs": { metadataEgressQualification },
  };
  const read = (file) => fs.readFileSync(local(file), "utf8");
  const execute = (flags = []) =>
    runInNewContext(compiled, {
      exports: {},
      require: (name) => {
        if (!Object.hasOwn(modules, name)) throw Error("Unexpected import: " + name);
        return modules[name];
      },
      process: { argv: ["node", "install.mjs", stage, "--apply", ...flags], getuid: () => 0 },
      console: { log: (line) => outputs.push(JSON.parse(line)) },
      ...(clock && { Date: { now: () => clock.now } }),
    });
  return {
    execute,
    calls,
    mutations,
    outputs,
    unitState,
    write,
    local,
    manifest,
    stage,
    configDir,
    release: "/opt/" + deployment.service + "/releases/" + manifest.source_sha,
    audit: configDir + "/rollout-" + manifest.source_sha,
    read,
  };
}

test("version parsing tolerates allocator diagnostics without accepting ambiguous builds", () => {
  assert.equal(profiles.parseRuntimeVersion("celld 0.6.3\n"), "celld 0.6.3");
  assert.equal(
    profiles.parseRuntimeVersion("WARN allocator background thread unavailable\r\ncelld 0.6.3\r\n"),
    "celld 0.6.3",
  );
  for (const value of [
    undefined,
    "",
    "celld 0.6.3 (debug)",
    "celld 0.6.3\ncelld 0.6.4",
    "celld 0.6.3\ncelld custom",
    "celld 0.6.3\ncelld 0.6.3",
  ])
    assert.throws(() => profiles.parseRuntimeVersion(value), /canonical celld release/);
});

test("installer accepts an official runtime with allocator warning stdout", (t) => {
  const fixture = installFixture(t, {
    candidateVersion: "WARN allocator background thread unavailable\ncelld 0.6.3\n",
    installedRuntime: { version: "WARN allocator background thread unavailable\ncelld 0.6.1\n" },
  });
  fixture.execute();
  assert.equal(fixture.read("/opt/nteract-page10/celld"), "qualified runtime");
});

test("all Pages targets require the verified 0.6.3 Linux executable", () => {
  const release = profiles.CELLD_RELEASE;
  assert.equal(release.version, "celld 0.6.3");
  assert.equal(release.path, "/usr/local/bin/celld-v0.6.3");
  assert.equal(release.sha256, "eb0a8158421b69d68dd5d28f2298a7d411dde498295833deeb1cc5ce53b7eb75");
  for (const target of profiles.DEPLOYMENT_TARGETS) {
    const config = profiles.deploymentProfile(target).deployment;
    assert.equal(config.runtime, release.path);
    assert.equal(config.requiredVersion, release.version);
  }
  profiles.verifyRuntime(release);
  for (const candidate of [
    undefined,
    { ...release, version: "celld 0.6.1" },
    { ...release, sha256: "0".repeat(64) },
  ])
    assert.throws(() => profiles.verifyRuntime(candidate), /official celld 0.6.3/);
});

for (const installed of ["celld 0.6.1", "celld 0.6.2", "celld 0.6.3"])
  test(`installation permits ${installed} to the pinned release and keeps telemetry on retry`, (t) => {
    const fixture = installFixture(t, {
      target: "page10",
      installedRuntime: {
        version: installed,
        ...(installed === "celld 0.6.3" && { bytes: "qualified runtime" }),
      },
    });
    fixture.execute();
    fixture.execute();
    assert.equal(fixture.read("/opt/nteract-page10/celld"), "qualified runtime");
    const unit = fixture.read("/etc/systemd/system/nteract-page10.service");
    assert.match(unit, /Environment=CELLD_OTEL=1\n/);
    assert.match(unit, /Environment=CELLD_OTEL_RETENTION=30d\n/);
    assert.doesNotMatch(unit, /CELLD_OTEL_(?:FLUSH_MS|FLUSH_BYTES|SINK)=/);
  });

for (const installed of [
  "celld 0.6.4",
  "celld 0.7.0",
  "celld 1.0.0",
  "celld 0.6.3",
  "celld 0.6.3-custom",
  "unknown",
])
  test(`installation refuses to replace an existing ${installed} build before mutation`, (t) => {
    const fixture = installFixture(t, {
      target: "page10",
      installedRuntime: { version: installed },
    });
    assert.throws(
      fixture.execute,
      /newer or unrecognized|same version but a different build|canonical celld release/,
    );
    assert.equal(fixture.read("/opt/nteract-page10/celld"), "previous runtime");
    assert.equal(fs.existsSync(fixture.local(fixture.release)), false);
    assert.ok(fixture.calls.every(({ args }) => args[0] === "--version"));
  });

test("runtime copy mismatch preserves the active executable and can be retried", (t) => {
  const fixture = installFixture(t, {
    target: "page10",
    failure: "runtime-copy",
    installedRuntime: { version: "celld 0.6.1" },
  });
  assert.throws(fixture.execute, /Copied celld differs/);
  assert.equal(fixture.read("/opt/nteract-page10/celld"), "previous runtime");
  assert.ok(fixture.calls.every(({ command }) => command !== "runuser"));
  fixture.execute();
  assert.equal(fixture.read("/opt/nteract-page10/celld"), "qualified runtime");
});

test("installer rejects unqualified staged or changed source runtimes before mutation", (t) => {
  const badManifest = installFixture(t);
  badManifest.write(
    badManifest.stage + "/manifest.json",
    JSON.stringify({
      ...badManifest.manifest,
      runtime: { version: "celld 0.6.3", sha256: "0".repeat(64) },
    }),
  );
  assert.throws(badManifest.execute, /official celld 0.6.3/);
  assert.deepEqual(badManifest.calls, []);
  const badVersion = installFixture(t, { candidateVersion: "celld 0.6.1" });
  assert.throws(badVersion.execute, /official celld 0.6.3/);
  const badBytes = installFixture(t);
  badBytes.write(profiles.CELLD_RELEASE.path, "unexpected runtime");
  assert.throws(badBytes.execute, /official celld 0.6.3/);
  for (const fixture of [badVersion, badBytes])
    assert.equal(fs.existsSync(fixture.local(fixture.release)), false);
});

for (const failure of ["deploy", "restart"])
  for (const previous of [true, false])
    test(`installation retries ${failure} failure with previous deployment ${previous}`, (t) => {
      const fixture = installFixture(t, { failure, previous });
      assert.throws(fixture.execute, /failed \(status 1\)/);
      const before = fixture.read(fixture.audit + "/previous-deployment.json");
      assert.deepEqual(JSON.parse(before), previous ? { id: "previous" } : null);
      fixture.execute();
      assert.equal(fixture.read(fixture.audit + "/previous-deployment.json"), before);
      assert.deepEqual(JSON.parse(fixture.read(fixture.audit + "/deployment.json")), {
        id: "current",
        version: DEPLOYED,
      });
      assert.equal(fixture.calls.filter(({ command }) => command === "runuser").length, 2);
    });

test("installation fills only missing verified artifacts after a partial copy", (t) => {
  const fixture = installFixture(t, { failure: "copy" });
  assert.throws(fixture.execute, /injected copy failure/);
  assert.equal(fs.existsSync(fixture.local(fixture.release + "/public/app.js")), false);
  fixture.execute();
  assert.equal(fixture.read(fixture.release + "/public/app.js"), "console.log('fixture');");
  assert.equal(fixture.calls.filter(({ command }) => command === "runuser").length, 1);
});

for (const tampering of ["artifact", "extra-file", "symlink", "audit-manifest", "wrangler"])
  test(`installation retry rejects changed ${tampering}`, (t) => {
    const fixture = installFixture(t, { failure: "deploy" });
    assert.throws(fixture.execute, /failed \(status 1\)/);
    if (tampering === "artifact") fixture.write(fixture.release + "/index.js", "modified");
    if (tampering === "extra-file") fixture.write(fixture.release + "/unexpected.js", "extra");
    // Only vars may differ in an earlier configured wrangler.json.
    if (tampering === "wrangler") {
      const config = JSON.parse(fixture.read(fixture.release + "/wrangler.json"));
      config.durable_objects.bindings.push({ name: "EXTRA", class_name: "Extra" });
      fixture.write(fixture.release + "/wrangler.json", JSON.stringify(config));
    }
    if (tampering === "symlink") {
      rmSync(fixture.local(fixture.release + "/index.js"));
      fs.symlinkSync(
        fixture.local(fixture.release + "/public/app.js"),
        fixture.local(fixture.release + "/index.js"),
      );
    }
    if (tampering === "audit-manifest")
      fixture.write(
        fixture.audit + "/manifest.json",
        JSON.stringify({ ...fixture.manifest, source_tree: "c".repeat(40) }),
      );
    assert.throws(
      fixture.execute,
      /Existing release differs|Special files|rollout manifest differs/,
    );
    assert.equal(fixture.calls.filter(({ command }) => command === "runuser").length, 1);
  });

test("deployment CLI requires an explicit allowlisted target", () => {
  const command = new URL("./deploy.mjs", import.meta.url);
  const plan = (args) =>
    JSON.parse(execFileSync(process.execPath, [command.pathname, ...args], { encoding: "utf8" }));
  const pages = plan(["--target", "pages", "plan"]),
    page10 = plan(["--target", "page10", "plan"]);
  assert.equal(pages.hostname, "pages.runtimed.run");
  assert.equal(page10.hostname, "page10.runtimed.run");
  for (const key of ["hostname", "service", "prefix", "listen", "internalListen"])
    assert.notEqual(page10[key], pages[key], key);
  assert.equal(page10.bucket, pages.bucket);
  assert.throws(
    () => execFileSync(process.execPath, [command.pathname, "plan"], { stdio: "pipe" }),
    /Name the Pages deployment target with --target/,
  );
  assert.throws(() => profiles.selectTarget([]), /Name the Pages deployment target/);
  assert.throws(() => profiles.selectTarget(["plan"]), /Name the Pages deployment target/);
  for (const argv of [["--target"], ["--target", "elsewhere"], ["--target", "__proto__"]])
    assert.throws(() => profiles.selectTarget(argv), /Unknown Pages deployment target/);
});

test("prepared stages and manifests cannot cross deployment targets", () => {
  const pages = profiles.deploymentProfile("pages").deployment;
  const page10 = profiles.deploymentProfile("page10").deployment;
  assert.equal(profiles.stageTarget("/tmp/nteract-page10-stage-abcd1234"), "page10");
  assert.equal(profiles.stagePattern("pages").test("/tmp/nteract-page10-stage-abcd1234"), false);
  assert.throws(() => profiles.stageTarget("/tmp/nteract-page10-stage-abcd1234/../other"));
  assert.throws(() =>
    profiles.verifyDeployment({ source_sha: "a".repeat(40), deployment: pages }, "page10"),
  );
  assert.throws(() =>
    profiles.verifyDeployment({ source_sha: "a".repeat(40), deployment: page10 }),
  );
  assert.throws(() => profiles.stagePattern(), /Unknown Pages deployment target/);
});

test("page10 firewall refreshes only its own table and cgroup", () => {
  const rules = pagesFirewall(999, true, "page10");
  assert.match(rules, /^delete table inet nteract_page10\n/);
  assert.match(rules, /system.slice\/nteract-page10.service/);
  assert.match(rules, /0x00200000/);
  assert.doesNotMatch(rules, /pages.live|0x00100000/);
});

test("page10 DNS is independently owned and never adopts pages records", async () => {
  const fixture = dnsFixture();
  const args = { token: "fixture", tunnelId, target: "page10", fetchImpl: fixture.fetchImpl };
  assert.equal((await configureDns(args)).present, false);
  assert.ok(
    fixture.calls.every(
      ({ url, method }) => method === "GET" && !url.includes("pages.runtimed.run"),
    ),
  );
  const created = await configureDns({ ...args, apply: true });
  assert.equal(created.name, "page10.runtimed.run");
  assert.equal(created.changed, true);
  assert.equal((await configureDns({ ...args, apply: true })).changed, false);
  const foreign = dnsFixture([
    {
      id: "b".repeat(32),
      name: "page10.runtimed.run",
      type: "CNAME",
      content: `${tunnelId}.cfargotunnel.com`,
      proxied: true,
      ttl: 1,
      comment: "nteract/pages:experiment:pages",
    },
  ]);
  await assert.rejects(
    configureDns({ ...args, apply: true, fetchImpl: foreign.fetchImpl }),
    /conflicts/,
  );
  assert.ok(foreign.calls.every(({ method }) => method === "GET"));
});

for (const target of profiles.QUALIFIED_TARGETS)
  test(`${target} installation retains auth, bindings, and bucket durability with isolated service state`, (t) => {
    const fixture = installFixture(t, { target });
    fixture.execute();
    const deployment = profiles.deploymentProfile(target).deployment;
    const config = JSON.parse(fixture.read(fixture.release + "/wrangler.json"));
    assert.equal(config.vars.NOTEBOOK_CLOUD_PUBLIC_ORIGIN, "https://" + deployment.hostname);
    assert.equal(config.vars.PAGES_OAUTH_METADATA_EGRESS, undefined);
    assert.equal(
      config.vars.NOTEBOOK_CLOUD_OIDC_REDIRECT_URI,
      "https://" + deployment.hostname + "/oidc",
    );
    assert.equal(config.vars.NOTEBOOK_CLOUD_OIDC_ISSUER, "https://auth.anaconda.com/api/auth");
    assert.equal(
      config.vars.NOTEBOOK_CLOUD_ANACONDA_API_KEY_USERINFO_URL,
      "https://anaconda.com/api/auth/sessions/whoami",
    );
    assert.equal(
      config.vars.NOTEBOOK_CLOUD_OIDC_PRINCIPAL_NAMESPACE,
      config.vars.NOTEBOOK_CLOUD_ANACONDA_API_KEY_PRINCIPAL_NAMESPACE,
    );
    assert.deepEqual(config.durable_objects.bindings, [{ name: "PAGES", class_name: "Page" }]);
    assert.deepEqual(config.migrations, [{ tag: "fixture", new_sqlite_classes: ["Page"] }]);
    assert.deepEqual(config.r2_buckets, [{ binding: "PAGES_ASSETS", bucket_name: "pages-images" }]);
    const unit = fixture.read("/etc/systemd/system/" + deployment.service + ".service");
    assert.match(unit, /Environment=CELLD_DURABILITY=bucket/);
    assert.match(unit, /Environment=CELLD_MAX_REQUEST_BODY_BYTES=6291456\n/);
    assert.match(unit, /Environment=CELLD_OTEL=1\n/);
    assert.match(unit, /Environment=CELLD_OTEL_RETENTION=30d\n/);
    assert.doesNotMatch(unit, /CELLD_OTEL_(?:FLUSH_MS|FLUSH_BYTES|SINK)=/);
    assert.ok(
      unit.includes(
        "--listen " + deployment.listen + " --internal-listen " + deployment.internalListen,
      ),
    );
    assert.ok(unit.includes("firewall.mjs --target " + target));
    assert.ok(unit.includes("s3://" + deployment.bucket + "/" + deployment.prefix));
    for (const otherTarget of profiles.QUALIFIED_TARGETS.filter((value) => value !== target)) {
      const other = profiles.deploymentProfile(otherTarget).deployment.service;
      for (const directory of ["/opt/", "/etc/", "/var/lib/"])
        assert.equal(fs.existsSync(fixture.local(directory + other)), false);
      assert.ok(
        fixture.calls
          .filter(({ command }) => command === "systemctl")
          .every(({ args }) => !args.includes(other)),
      );
    }
  });

test("page10 installation rejects a pages manifest before running any host command", (t) => {
  const fixture = installFixture(t, { target: "page10" });
  fixture.write(
    fixture.stage + "/manifest.json",
    JSON.stringify({
      ...fixture.manifest,
      deployment: profiles.deploymentProfile("pages").deployment,
    }),
  );
  assert.throws(fixture.execute, /Unexpected deployment target/);
  assert.equal(fixture.calls.length, 0);
});

test("new page10 setup tolerates pages resources but rejects its own port or mark collisions", (t) => {
  const existing =
    "LISTEN 0 4096 127.0.0.1:9481 0.0.0.0:*\nLISTEN 0 4096 127.0.0.1:19481 0.0.0.0:*";
  const fixture = installFixture(t, {
    target: "page10",
    fresh: true,
    listeners: existing,
    rules: '{"name":"nteract_pages_live","mark":1048576}',
  });
  fixture.execute();
  assert.equal(
    JSON.parse(fixture.read(fixture.configDir + "/ownership.json")).hostname,
    "page10.runtimed.run",
  );
  const prefixCheck = fixture.calls.find(({ command }) => command === "/usr/local/bin/aws");
  assert.equal(prefixCheck.args[prefixCheck.args.indexOf("--prefix") + 1], "standalone/page10/");
  for (const collision of [
    { listeners: existing + "\nLISTEN 0 4096 127.0.0.1:9480 0.0.0.0:*" },
    { rules: '{"mark":2097152}' },
  ]) {
    const rejected = installFixture(t, { target: "page10", fresh: true, ...collision });
    assert.throws(rejected.execute, /port is occupied|firewall namespace or mark is occupied/);
    assert.equal(
      rejected.calls.some(({ command }) => command === "useradd"),
      false,
    );
  }
});

const frozenBy = {
  page11: ["pages2"],
};
test("every deploy profile owns distinct hosts, ports, prefixes and firewall resources", () => {
  // Every profile, so a new one can't skip the check. Ports are compared
  // across hosts too: a profile may move hosts, and its ports must stay free.
  const targets = profiles.DEPLOYMENT_TARGETS;
  assert.deepEqual(targets, ["page10", "pages", "pages2", "page11"]);
  const seen = new Map();
  const claim = (kind, value, target) => {
    if (value === undefined) return;
    const key = `${kind}:${value}`;
    assert.equal(seen.get(key), undefined, `${target} reuses ${key} from ${seen.get(key)}`);
    seen.set(key, target);
  };
  for (const target of targets) {
    const profile = profiles.deploymentProfile(target);
    claim("hostname", profile.deployment.hostname, target);
    claim("service", profile.deployment.service, target);
    claim("prefix", profile.deployment.prefix, target);
    // Both listeners share one port namespace on the host.
    claim("port", profile.deployment.listen?.split(":").at(-1), target);
    claim("port", profile.deployment.internalListen?.split(":").at(-1), target);
    claim("firewallTable", profile.firewallTable, target);
    claim("firewallMark", profile.firewallMark, target);
    claim("tunnelService", profile.tunnelService, target);
    // Connector slots are tunnel units too, and their metrics listeners share
    // the host's port namespace with every Pages listener.
    for (const slot of Object.values(profile.tunnelSlots ?? {})) {
      claim("tunnelService", slot.service, target);
      assert.match(slot.metrics, /^127[.]0[.]0[.]1:\d+$/, target);
      claim("port", slot.metrics.split(":").at(-1), target);
    }
  }
});

for (const target of Object.keys(frozenBy))
  test(`${target} rejects frozen manifests, DNS ownership and occupied resources`, async (t) => {
    const profile = profiles.deploymentProfile(target);
    assert.deepEqual(profile.frozenTargets, frozenBy[target]);
    const stage = `/tmp/${profile.deployment.service}-stage-abcd1234`;
    assert.equal(profiles.stageTarget(stage), target);
    for (const other of profile.frozenTargets) {
      const previous = profiles.deploymentProfile(other);
      for (const key of ["hostname", "service", "prefix", "listen", "internalListen"])
        assert.notEqual(profile.deployment[key], previous.deployment[key], `${other}: ${key}`);
      for (const key of ["firewallTable", "firewallMark", "tunnelService"])
        assert.notEqual(profile[key], previous[key], `${other}: ${key}`);
      assert.equal(profiles.stagePattern(other).test(stage), false);
      const rejected = installFixture(t, { target });
      rejected.write(
        rejected.stage + "/manifest.json",
        JSON.stringify({
          ...rejected.manifest,
          deployment: previous.deployment,
        }),
      );
      assert.throws(rejected.execute, /Unexpected deployment target/);
      assert.deepEqual(rejected.calls, []);
      const foreign = dnsFixture([
        {
          id: "b".repeat(32),
          name: profile.deployment.hostname,
          type: "CNAME",
          content: `${tunnelId}.cfargotunnel.com`,
          proxied: true,
          ttl: 1,
          comment: "nteract/pages:experiment:" + other,
        },
      ]);
      await assert.rejects(
        configureDns({
          token: "fixture",
          tunnelId,
          target,
          apply: true,
          fetchImpl: foreign.fetchImpl,
        }),
        /conflicts/,
      );
      assert.ok(foreign.calls.every(({ method }) => method === "GET"));
      const rules = pagesFirewall(999, true, target);
      assert.ok(!rules.includes(previous.firewallTable));
      assert.ok(!rules.includes(previous.firewallMark));
    }
    for (const collision of [
      { listeners: `LISTEN 0 4096 ${profile.deployment.listen} 0.0.0.0:*` },
      { listeners: `LISTEN 0 4096 ${profile.deployment.internalListen} 0.0.0.0:*` },
      { rules: JSON.stringify({ mark: Number(profile.firewallMark) }) },
      { rules: JSON.stringify({ table: profile.firewallTable }) },
    ]) {
      const rejected = installFixture(t, { target, fresh: true, ...collision });
      assert.throws(rejected.execute, /port is occupied|firewall namespace or mark is occupied/);
      assert.equal(
        rejected.calls.some(({ command }) => command === "useradd"),
        false,
      );
    }
  });

test("company viewing and the catalog index are enabled for every serving target", (t) => {
  for (const target of ["page10", "pages", "pages2", "page11"]) {
    const f = installFixture(t, { target });
    f.execute();
    const config = JSON.parse(f.read(f.release + "/wrangler.json"));
    assert.equal(config.vars.PAGES_COMPANY_VIEW_DOMAINS, "anaconda.com");
    assert.equal(config.vars.PAGES_CATALOG_INDEX, "1");
    // Subduction's switches are gone: every Page syncs with plain Automerge.
    for (const name of [
      "PAGES_ASYNC_PERSISTENCE",
      "PAGES_COMPACT_RECORDS",
      "PAGES_RECORD_STORAGE",
      "PAGES_MIGRATE_RECORD_STORAGE",
      "PAGES_MIGRATE_PAGE_IDS",
    ])
      assert.equal(config.vars[name], undefined, `${target} ${name}`);
  }
});

test("Pages and Page10 retain the local build's isolated usage binding and UTC crons", (t) => {
  for (const target of ["page10", "pages"]) {
    const f = installFixture(t, { target });
    f.execute();
    const config = JSON.parse(f.read(f.release + "/wrangler.json"));
    assert.deepEqual(
      config.d1_databases.find((db) => db.binding === "PAGES_USAGE"),
      profiles.USAGE_D1,
    );
    assert.notEqual(profiles.USAGE_D1.database_id, profiles.AUTH_D1.database_id);
    assert.deepEqual(config.triggers, { crons: ["5 0 * * *", "35 * * * *"] });
  }
  assert.notEqual(
    profiles.deploymentProfile("page10").deployment.prefix,
    profiles.deploymentProfile("pages").deployment.prefix,
  );
});

test("the installer writes the single session secret until a keyring file exists", (t) => {
  const f = installFixture(t, { target: "page10" });
  f.execute();
  const vars = JSON.parse(f.read(f.release + "/wrangler.json")).vars;
  assert.equal(vars.NOTEBOOK_CLOUD_APP_SESSION_SECRET, "fixture-only-session-secret");
  assert.equal(vars.NOTEBOOK_CLOUD_APP_SESSION_KEYS, undefined);
});

test("the installer writes a keyring file as the session keys var and drops the secret", (t) => {
  const f = installFixture(t, { target: "page10" });
  const keyring = {
    active: "k2",
    keys: { k1: "k1-fixture-session-key-".repeat(2), k2: "k2-fixture-session-key-".repeat(2) },
    activated_at: { k2: "2026-11-06T00:00:00.000Z" },
  };
  f.write(f.configDir + "/session-keys.json", JSON.stringify(keyring, null, 2) + "\n");
  f.execute();
  const vars = JSON.parse(f.read(f.release + "/wrangler.json")).vars;
  assert.deepEqual(JSON.parse(vars.NOTEBOOK_CLOUD_APP_SESSION_KEYS), keyring);
  assert.equal(vars.NOTEBOOK_CLOUD_APP_SESSION_SECRET, undefined);
});

test("the installer refuses a malformed keyring file before it writes anything", (t) => {
  const f = installFixture(t, { target: "page10" });
  f.write(
    f.configDir + "/session-keys.json",
    JSON.stringify({ active: "k2", keys: { k1: "k1-fixture-session-key-".repeat(2) } }),
  );
  assert.throws(f.execute, /Session keyring is invalid: active must name a kid/);
  assert.equal(fs.existsSync(f.local(f.release)), false);
  assert.equal(fs.existsSync(f.local(f.audit)), false);
  // Only the runtime version probes ran; no host command changed anything.
  assert.deepEqual(
    f.calls.filter(({ args }) => args[0] !== "--version"),
    [],
  );
});

test("fresh Page10 installation owns its origin, storage, runtime and service", (t) => {
  const target = "page10";
  const profile = profiles.deploymentProfile(target);
  assert.deepEqual(profiles.selectTarget(["--target", target, "plan"]), { target, args: ["plan"] });
  assert.doesNotThrow(() => profiles.assertQualifiedDeploymentTarget(target));
  const f = installFixture(t, { target, fresh: true });
  f.execute();
  const config = JSON.parse(f.read(f.release + "/wrangler.json"));
  assert.equal(config.vars.NOTEBOOK_CLOUD_PUBLIC_ORIGIN, "https://page10.runtimed.run");
  assert.equal(config.vars.NOTEBOOK_CLOUD_OIDC_REDIRECT_URI, "https://page10.runtimed.run/oidc");
  assert.equal(config.vars.PAGES_COMPANY_VIEW_DOMAINS, "anaconda.com");
  assert.equal(config.vars.PAGES_CATALOG_INDEX, "1");
  assert.equal(config.vars.PAGES_DEFAULT_PAGE_QUOTA, "250");
  const unit = f.read("/etc/systemd/system/nteract-page10.service");
  assert.match(unit, /Environment=OTEL_TRACES_SAMPLER=always_on\n/);
  assert.match(unit, /User=nteract-page10\n/);
  assert.match(unit, /WorkingDirectory=\/var\/lib\/nteract-page10\n/);
  assert.match(
    unit,
    /ExecStart=\/opt\/nteract-page10\/celld --bucket s3:\/\/[^ ]+\/standalone\/page10 /,
  );
  assert.match(unit, /--listen 127[.]0[.]0[.]1:9480 --internal-listen 127[.]0[.]0[.]1:19480/);
  // Each service starts from its own installed copy of the firewall helper and
  // profiles, so installing one target never changes another's copy.
  assert.match(
    unit,
    /ExecStartPre=\+\/usr\/bin\/node \/opt\/nteract-page10\/firewall[.]mjs --target page10\n/,
  );
  assert.equal(f.read("/opt/nteract-page10/firewall.mjs"), "fixture firewall");
  assert.equal(f.read("/opt/nteract-page10/profiles.mjs"), "fixture profiles");
  const prefixCheck = f.calls.find(
    ({ command, args }) => command === "/usr/local/bin/aws" && args.includes("--prefix"),
  );
  assert.equal(prefixCheck.args[prefixCheck.args.indexOf("--prefix") + 1], "standalone/page10/");
  assert.ok(
    f.calls
      .filter(
        ({ command, args }) =>
          command === "systemctl" && ["restart", "start", "stop", "enable"].includes(args[0]),
      )
      .every(({ args }) => args[1] === profile.deployment.service),
  );
  assert.equal(profile.frozenTargets, undefined);
});

test("fresh Pages installation owns pages.runtimed.run and its -live resources", (t) => {
  const target = "pages";
  const profile = profiles.deploymentProfile(target);
  assert.deepEqual(profiles.selectTarget(["--target", target, "plan"]), { target, args: ["plan"] });
  assert.doesNotThrow(() => profiles.assertQualifiedDeploymentTarget(target));
  assert.deepEqual(profile.deployment, {
    host: "lab1",
    hostname: "pages.runtimed.run",
    service: "nteract-pages-live",
    bucket: profiles.deploymentProfile("page10").deployment.bucket,
    prefix: "standalone/pages-live",
    region: "us-east-1",
    listen: "127.0.0.1:9481",
    internalListen: "127.0.0.1:19481",
    runtime: profiles.CELLD_RELEASE.path,
    requiredVersion: "celld 0.6.3",
  });
  assert.equal(profile.firewallTable, "nteract_pages_live");
  assert.equal(profile.firewallMark, "0x00100000");
  assert.equal(profile.tunnelService, "cloudflared-pages-live.service");
  // Every Page10 flag carries over; only the owned resources differ.
  const owned = [
    "deployment",
    "firewallTable",
    "firewallMark",
    "firewallComment",
    "tunnelService",
    "tunnelSlots",
  ];
  const flags = (name) =>
    Object.fromEntries(
      Object.entries(profiles.deploymentProfile(name)).filter(([key]) => !owned.includes(key)),
    );
  assert.deepEqual(flags(target), flags("page10"));
  // Page10 stays deployable until its Projects are copied in, so it is not frozen.
  assert.equal(profile.frozenTargets, undefined);

  // An earlier prototype left a disabled nteract-pages.service, /etc/nteract-pages
  // and an nteract_pages table on the host. None of them belongs to this target,
  // and neither do live Page10's listeners, table and mark.
  const legacy = {
    unit: "/etc/systemd/system/nteract-pages.service",
    config: "/etc/nteract-pages/ownership.json",
    base: "/opt/nteract-pages/celld",
  };
  const page10 = profiles.deploymentProfile("page10");
  const f = installFixture(t, {
    target,
    fresh: true,
    listeners: [page10.deployment.listen, page10.deployment.internalListen]
      .map((listen) => `LISTEN 0 4096 ${listen} 0.0.0.0:*`)
      .join("\n"),
    rules: JSON.stringify([
      { table: "nteract_pages" },
      { table: page10.firewallTable, mark: Number(page10.firewallMark) },
    ]),
  });
  f.write(legacy.unit, "legacy unit");
  f.write(
    legacy.config,
    JSON.stringify({ prefix: "standalone/pages", hostname: "pages.runtimed.run" }),
  );
  f.write(legacy.base, "legacy runtime");
  f.execute();
  for (const [file, contents] of [
    [legacy.unit, "legacy unit"],
    [legacy.config, JSON.stringify({ prefix: "standalone/pages", hostname: "pages.runtimed.run" })],
    [legacy.base, "legacy runtime"],
  ])
    assert.equal(f.read(file), contents, file);
  const config = JSON.parse(f.read(f.release + "/wrangler.json"));
  assert.equal(config.vars.NOTEBOOK_CLOUD_PUBLIC_ORIGIN, "https://pages.runtimed.run");
  assert.equal(config.vars.NOTEBOOK_CLOUD_OIDC_REDIRECT_URI, "https://pages.runtimed.run/oidc");
  assert.equal(config.vars.NOTEBOOK_CLOUD_OIDC_CLIENT_ID, "1a90d36b-5b97-4ebb-a1bc-f3de7ddb70e0");
  assert.equal(config.vars.PAGES_CATALOG_INDEX, "1");
  assert.equal(config.vars.PAGES_DEFAULT_PAGE_QUOTA, "250");
  assert.deepEqual(JSON.parse(f.read("/etc/nteract-pages-live/ownership.json")), {
    prefix: "standalone/pages-live",
    hostname: "pages.runtimed.run",
  });
  const unit = f.read("/etc/systemd/system/nteract-pages-live.service");
  assert.match(unit, /User=nteract-pages-live\n/);
  assert.match(unit, /WorkingDirectory=\/var\/lib\/nteract-pages-live\n/);
  assert.match(
    unit,
    /ExecStart=\/opt\/nteract-pages-live\/celld --bucket s3:\/\/[^ ]+\/standalone\/pages-live /,
  );
  assert.match(unit, /--listen 127[.]0[.]0[.]1:9481 --internal-listen 127[.]0[.]0[.]1:19481/);
  assert.match(
    unit,
    /ExecStartPre=\+\/usr\/bin\/node \/opt\/nteract-pages-live\/firewall[.]mjs --target pages\n/,
  );
  const prefixCheck = f.calls.find(
    ({ command, args }) => command === "/usr/local/bin/aws" && args.includes("--prefix"),
  );
  assert.equal(
    prefixCheck.args[prefixCheck.args.indexOf("--prefix") + 1],
    "standalone/pages-live/",
  );
  assert.ok(
    f.calls
      .filter(
        ({ command, args }) =>
          command === "systemctl" && ["restart", "start", "stop", "enable"].includes(args[0]),
      )
      .every(({ args }) => args[1] === "nteract-pages-live"),
  );
  const rules = pagesFirewall(999, false, target);
  assert.match(rules, /table inet nteract_pages_live \{/);
  assert.match(rules, /ct mark set ct mark \| 0x00100000/);
  assert.match(rules, /"system[.]slice\/nteract-pages-live[.]service"/);
});

test("pages2 is a fresh lab2 target with Pages' flags and plain sync only", () => {
  const profile = profiles.deploymentProfile("pages2");
  assert.deepEqual(profiles.selectTarget(["--target", "pages2", "plan"]), {
    target: "pages2",
    args: ["plan"],
  });
  assert.doesNotThrow(() => profiles.assertQualifiedDeploymentTarget("pages2"));
  assert.deepEqual(profile.deployment, {
    host: "lab2",
    hostname: "page2.runtimed.run",
    service: "nteract-pages2",
    bucket: profiles.deploymentProfile("pages").deployment.bucket,
    prefix: "standalone/pages2",
    region: "us-east-1",
    listen: "127.0.0.1:9482",
    internalListen: "127.0.0.1:19482",
    runtime: profiles.CELLD_RELEASE.path,
    requiredVersion: "celld 0.6.3",
  });
  assert.equal(profiles.stageTarget("/tmp/nteract-pages2-stage-abcd1234"), "pages2");
  // Pages' flags carry over. Only owned resources differ, plus lab2's lack of
  // a shared connector and of frozen neighbors.
  const owned = [
    "deployment",
    "firewallTable",
    "firewallMark",
    "firewallComment",
    "tunnelService",
    "tunnelSlots",
    "sharedTunnel",
    "frozenTargets",
  ];
  const flags = (name) =>
    Object.fromEntries(
      Object.entries(profiles.deploymentProfile(name)).filter(([key]) => !owned.includes(key)),
    );
  assert.deepEqual(flags("pages2"), flags("pages"));
  assert.equal(profile.sharedTunnel, false);
  assert.equal(profile.frozenTargets, undefined);
  assert.deepEqual(profile.d1, profiles.AUTH_D1);
  assert.deepEqual(profiles.unitMemory(profile), { maxRssMb: 2560, memoryMax: "4G" });
  assert.deepEqual(profiles.RECORD_STORAGE_HISTORY.pages2, ["automerge"]);
  // A build that can't open plain Pages is refused before it reaches lab2.
  assert.throws(
    () =>
      profiles.assertReleaseOpensTargetPages("pages2", {
        source_sha: "a".repeat(40),
        build_id: "0123456789ab",
        record_storage: [],
      }),
    /pages2 may hold "automerge" Pages/,
  );
  assert.doesNotThrow(() =>
    profiles.assertReleaseOpensTargetPages("pages2", {
      record_storage: CURRENT_RECORD_STORAGE,
      plain_storage_formats: CURRENT_PLAIN_STORAGE_FORMATS,
    }),
  );
});

test("page11 owns a new namespace with its own plain backend storage floor", () => {
  const p = profiles.deploymentProfile("page11");
  assert.equal(p.deployment.host, "lab2");
  assert.equal(p.deployment.hostname, "page11.runtimed.run");
  assert.equal(p.deployment.prefix, "standalone/page11");
  assert.deepEqual(p.frozenTargets, ["pages2"]);
  assert.equal(p.sharedTunnel, false);
  assert.equal(Number(p.firewallMark) & 0x00ff0000, 0, "avoid Tailscale's mark mask");
  assert.deepEqual(profiles.unitMemory(p), { maxRssMb: 1280, memoryMax: "2G" });
  assert.deepEqual(
    [...profiles.targetRecordStorage("page11")],
    [["automerge", ["RECORD_STORAGE_HISTORY lists it"]]],
  );
  assert.throws(() => profiles.assertReleaseOpensTargetPages("page11", {}), /record_storage/);
  assert.doesNotThrow(() => profiles.assertReleaseOpensTargetPages("page11", PLAIN));
  for (const other of profiles.DEPLOYMENT_TARGETS.filter((name) => name !== "page11")) {
    const deployment = profiles.deploymentProfile(other).deployment;
    assert.throws(() =>
      profiles.verifyDeployment({ source_sha: "a".repeat(40), deployment }, "page11"),
    );
    assert.equal(profiles.stagePattern(other).test("/tmp/nteract-page11-stage-abcd1234"), false);
  }
});

test("page11 installation and retry preserve neighbors and own existing data", (t) => {
  const f = installFixture(t, { target: "page11", fresh: true });
  const neighbors = ["nteract-pages2", "nteract-page10", "nteract-pages-live"];
  const sentinels = neighbors.flatMap((name) => [
    `/etc/${name}/ownership.json`,
    `/var/lib/${name}/keep`,
    `/opt/${name}/keep`,
  ]);
  for (const file of sentinels) f.write(file, "unchanged neighbor");
  f.execute();
  const secret = f.read(f.configDir + "/session-secret");
  const previous = f.read(f.audit + "/previous-deployment.json");
  f.write("/var/lib/nteract-page11/keep", "existing target data");
  f.execute();
  assert.equal(f.read(f.configDir + "/session-secret"), secret);
  assert.equal(f.read(f.audit + "/previous-deployment.json"), previous);
  assert.equal(f.read("/var/lib/nteract-page11/keep"), "existing target data");
  for (const file of sentinels) assert.equal(f.read(file), "unchanged neighbor");
  const config = JSON.parse(f.read(f.release + "/wrangler.json"));
  assert.equal(config.vars.NOTEBOOK_CLOUD_PUBLIC_ORIGIN, "https://page11.runtimed.run");
  assert.equal(config.vars.NOTEBOOK_CLOUD_OIDC_REDIRECT_URI, "https://page11.runtimed.run/oidc");
  assert.deepEqual(config.d1_databases, [profiles.AUTH_D1, profiles.USAGE_D1]);
  const deploys = f.calls.filter(({ command }) => command === "runuser");
  assert.equal(deploys.length, 2);
  for (const { args } of deploys) {
    assert.equal(
      args[args.indexOf("--bucket") + 1],
      "s3://nteract-celld-lab-621741996708/standalone/page11",
    );
    assert.equal(args[1], "nteract-page11");
  }
  assert.ok(f.calls.every(({ args }) => !neighbors.some((name) => args.join(" ").includes(name))));
});

test("page11 refuses occupied resources and nonempty storage before creating a user", (t) => {
  for (const collision of [
    { prefixCount: "1" },
    { userExists: true },
    { listeners: "LISTEN 0 4096 127.0.0.1:9483 0.0.0.0:*" },
    { listeners: "LISTEN 0 4096 127.0.0.1:19483 0.0.0.0:*" },
    { rules: '{"mark":32768}' },
    { rules: '{"table":"nteract_page11"}' },
  ]) {
    const f = installFixture(t, { target: "page11", fresh: true, ...collision });
    assert.throws(f.execute, /not empty|already exists|occupied/);
    assert.ok(!f.calls.some(({ command }) => command === "useradd"));
  }
  for (const file of [
    "/opt/nteract-page11/keep",
    "/etc/nteract-page11/keep",
    "/var/lib/nteract-page11/keep",
    "/etc/systemd/system/nteract-page11.service",
  ]) {
    const f = installFixture(t, { target: "page11", fresh: true });
    f.write(file, "unowned");
    assert.throws(f.execute, /unowned deployment path/);
    assert.equal(f.read(file), "unowned");
  }
});

test("page11 DNS refuses neighboring ownership and retries only its own record", async () => {
  const f = dnsFixture();
  const args = { token: "fixture", tunnelId, target: "page11", fetchImpl: f.fetchImpl };
  assert.equal((await configureDns(args)).present, false);
  assert.equal((await configureDns({ ...args, apply: true })).name, "page11.runtimed.run");
  assert.equal((await configureDns({ ...args, apply: true })).changed, false);
  for (const owner of ["pages", "page10", "pages2"]) {
    const foreign = dnsFixture([
      {
        id: "b".repeat(32),
        name: "page11.runtimed.run",
        type: "CNAME",
        content: `${tunnelId}.cfargotunnel.com`,
        proxied: true,
        ttl: 1,
        comment: "nteract/pages:experiment:" + owner,
      },
    ]);
    await assert.rejects(
      configureDns({ ...args, apply: true, fetchImpl: foreign.fetchImpl }),
      /conflicts/,
    );
    assert.ok(foreign.calls.every(({ method }) => method === "GET"));
  }
});

test("fresh pages2 installation owns page2.runtimed.run, its prefix and its unit", (t) => {
  const f = installFixture(t, { target: "pages2", fresh: true });
  f.execute();
  const config = JSON.parse(f.read(f.release + "/wrangler.json"));
  assert.equal(config.vars.NOTEBOOK_CLOUD_PUBLIC_ORIGIN, "https://page2.runtimed.run");
  assert.equal(config.vars.NOTEBOOK_CLOUD_OIDC_REDIRECT_URI, "https://page2.runtimed.run/oidc");
  assert.equal(config.vars.PAGES_RECORD_STORAGE, undefined);
  assert.equal(config.vars.PAGES_MIGRATE_RECORD_STORAGE, undefined);
  assert.equal(config.vars.PAGES_MIGRATE_PAGE_IDS, undefined);
  assert.equal(config.vars.PAGES_DEFAULT_PAGE_QUOTA, "250");
  assert.deepEqual(
    config.d1_databases.find((db) => db.binding === "DB"),
    profiles.AUTH_D1,
  );
  assert.deepEqual(JSON.parse(f.read("/etc/nteract-pages2/ownership.json")), {
    prefix: "standalone/pages2",
    hostname: "page2.runtimed.run",
  });
  const unit = f.read("/etc/systemd/system/nteract-pages2.service");
  assert.match(unit, /User=nteract-pages2\n/);
  assert.match(unit, /Environment=CELLD_MAX_RSS_MB=2560\n/);
  assert.match(unit, /MemoryMax=4G\n/);
  assert.match(
    unit,
    /ExecStart=\/opt\/nteract-pages2\/celld --bucket s3:\/\/[^ ]+\/standalone\/pages2 /,
  );
  assert.match(unit, /--listen 127[.]0[.]0[.]1:9482 --internal-listen 127[.]0[.]0[.]1:19482/);
  const prefixCheck = f.calls.find(
    ({ command, args }) => command === "/usr/local/bin/aws" && args.includes("--prefix"),
  );
  assert.equal(prefixCheck.args[prefixCheck.args.indexOf("--prefix") + 1], "standalone/pages2/");
  const rules = pagesFirewall(999, false, "pages2");
  assert.match(rules, /table inet nteract_pages2 \{/);
  assert.match(rules, /ct mark set ct mark \| 0x00080000/);
});

// Activation: a running node adopts a new pointer without a restart unless
// something it reads at startup changed.
function liveFixture(t, options = {}) {
  const f = installFixture(t, {
    target: "page10",
    installedRuntime: { version: "celld 0.6.3", bytes: "qualified runtime" },
    ...options,
  });
  f.execute();
  assert.equal(f.outputs.at(-1).activation, "restart");
  f.calls.length = 0;
  return f;
}
// A second release: new source, new build id, same artifacts.
function nextRelease(f, build = "ba9876543210", source = "c") {
  const manifest = {
    ...f.manifest,
    source_sha: source.repeat(40),
    build_receipt: { ...f.manifest.build_receipt, build_id: build },
  };
  f.write(f.stage + "/manifest.json", JSON.stringify(manifest));
  return manifest;
}
const commands = (f, verb) =>
  f.calls.filter(({ command, args }) => command === "systemctl" && args[0] === verb);
const running = (f) => JSON.parse(f.read(f.configDir + "/running.json"));
// The recorded inputs, without the process they describe.
const inputs = (record) =>
  Object.fromEntries(
    Object.entries(record).filter(([key]) => !["pid", "started_at"].includes(key)),
  );

test("an app-only release adopts the new pointer without restarting celld", (t) => {
  const f = liveFixture(t);
  const before = running(f);
  nextRelease(f);
  f.execute();
  assert.equal(f.calls.filter(({ command }) => command === "runuser").length, 1);
  assert.deepEqual(commands(f, "restart"), []);
  assert.deepEqual(commands(f, "daemon-reload"), []);
  assert.ok(f.calls.some(({ command }) => command === "curl"));
  assert.deepEqual(running(f), before);
  const output = f.outputs.at(-1);
  assert.equal(output.activation, "adopt");
  assert.equal(output.build, "ba9876543210");
  assert.equal(output.restart_reasons, undefined);
});

for (const [input, reason] of [
  ["unit_sha256", "unit"],
  ["celld_sha256", "celld"],
  ["config_sha256", "config"],
])
  test(`a changed ${reason} restarts the node`, (t) => {
    const f = liveFixture(t);
    const desired = running(f);
    f.write(f.configDir + "/running.json", JSON.stringify({ ...desired, [input]: "0".repeat(64) }));
    nextRelease(f);
    f.execute();
    assert.equal(commands(f, "restart").length, 1);
    assert.deepEqual(f.outputs.at(-1).restart_reasons, [reason]);
    assert.deepEqual(inputs(running(f)), inputs(desired));
  });

test("a rendered unit that differs on disk is rewritten, reloaded and restarted", (t) => {
  const f = liveFixture(t);
  const unit = "/etc/systemd/system/nteract-page10.service";
  const rendered = f.read(unit);
  const old = rendered.replace("CELLD_TOKIO_THREADS=2", "CELLD_TOKIO_THREADS=1");
  f.write(unit, old);
  const desired = running(f);
  f.write(
    f.configDir + "/running.json",
    JSON.stringify({
      ...desired,
      unit_sha256: createHash("sha256").update(old).digest("hex"),
    }),
  );
  nextRelease(f);
  f.execute();
  assert.equal(f.read(unit), rendered);
  assert.equal(commands(f, "daemon-reload").length, 1);
  assert.equal(commands(f, "restart").length, 1);
  assert.deepEqual(f.outputs.at(-1).restart_reasons, ["unit"]);
});

test("preparing a node does not enable metadata fetching for the fleet", (t) => {
  const f = liveFixture(t);
  f.write(f.configDir + "/oauth-metadata-egress", "prepared");
  f.execute();
  assert.equal(
    JSON.parse(f.read(f.release + "/wrangler.json")).vars.PAGES_OAUTH_METADATA_EGRESS,
    undefined,
  );
});

test("install requires an external operator qualification before enabling fleet metadata fetches", (t) => {
  const f = liveFixture(t);
  const configPath = "/opt/nteract-page10/releases/" + "a".repeat(40) + "/wrangler.json";
  assert.equal(JSON.parse(f.read(configPath)).vars.PAGES_OAUTH_METADATA_EGRESS, undefined);
  assert.equal(fs.existsSync(f.local(f.configDir + "/oauth-metadata-egress")), false);
  f.write(f.configDir + "/oauth-metadata-egress", "public-https\n");
  f.execute();
  assert.equal(JSON.parse(f.read(configPath)).vars.PAGES_OAUTH_METADATA_EGRESS, "public-https");
  assert.equal(f.outputs.at(-1).firewall_applied, true);
});

for (const kind of ["invalid", "symlink", "writable"])
  test(`a ${kind} egress qualification stops install before any mutation`, (t) => {
    const f = installFixture(t);
    const marker = f.configDir + "/oauth-metadata-egress";
    f.write(marker, kind === "invalid" ? "true" : "public-https");
    if (kind === "symlink") {
      fs.renameSync(f.local(marker), f.local(marker + "-target"));
      fs.symlinkSync(f.local(marker + "-target"), f.local(marker));
    }
    if (kind === "writable") fs.chmodSync(f.local(marker), 0o666);
    assert.throws(() => f.execute(), /Invalid operator egress qualification/);
    assert.deepEqual(f.mutations, []);
  });

test("installing one node never enables metadata fetching on an unqualified fleet", (t) => {
  const f = installFixture(t, {
    nodes: [
      { node: "node_" + "1".repeat(32), addr: "127.0.0.1:19480", expires_ms: 9e15 },
      { node: "node_" + "2".repeat(32), addr: "10.0.0.2:19480", expires_ms: 9e15 },
    ],
  });
  f.execute();
  assert.equal(
    JSON.parse(f.read(f.release + "/wrangler.json")).vars.PAGES_OAUTH_METADATA_EGRESS,
    undefined,
  );
});

test("the egress boundary is installed before an active node can adopt new vars", (t) => {
  const f = liveFixture(t);
  nextRelease(f);
  f.execute();
  const firewall = f.calls.findIndex(({ command }) => command === "/usr/bin/node");
  const publish = f.calls.findIndex(({ command }) => command === "runuser");
  assert.ok(firewall >= 0 && firewall < publish);
});

test("failed egress installation prevents publishing a deployment", (t) => {
  const f = installFixture(t, { failure: "firewall", service: { active: true } });
  assert.throws(() => f.execute(), /failed/);
  assert.equal(
    f.calls.some(({ command }) => command === "runuser"),
    false,
  );
});

test("a changed firewall helper applies in place without a restart", (t) => {
  const f = liveFixture(t);
  f.write(
    f.configDir + "/running.json",
    JSON.stringify({ ...running(f), firewall_sha256: "0".repeat(64) }),
  );
  nextRelease(f);
  f.execute();
  assert.deepEqual(commands(f, "restart"), []);
  assert.deepEqual(
    f.calls.filter(({ command }) => command === "/usr/bin/node").map(({ args }) => [...args]),
    [["/opt/nteract-page10/firewall.mjs", "--target", "page10"]],
  );
  assert.equal(f.outputs.at(-1).firewall_applied, true);
});

test("an inactive service starts even when nothing changed", (t) => {
  const f = liveFixture(t);
  f.unitState.active = false;
  nextRelease(f);
  f.execute();
  assert.equal(commands(f, "restart").length, 1);
  assert.deepEqual(f.outputs.at(-1).restart_reasons, ["inactive"]);
});

test("adoption that never serves the new build fails loudly and keeps the record", (t) => {
  const clock = { now: 1_000_000 };
  const f = liveFixture(t, {
    clock,
    health: () =>
      JSON.stringify({ ok: true, prototype: "pages-celld-native", build: "0123456789ab" }),
  });
  const before = f.read(f.configDir + "/running.json");
  nextRelease(f);
  assert.throws(
    f.execute,
    /Local node 127[.]0[.]0[.]1:9480 build ba9876543210 did not serve within 120000 ms; last: ok=true build=0123456789ab/,
  );
  assert.deepEqual(commands(f, "restart"), []);
  assert.equal(f.read(f.configDir + "/running.json"), before);
  assert.ok(clock.now - 1_000_000 >= 120_000);
});

test("a failed restart is retried, and the record moves only after the node serves", (t) => {
  const f = liveFixture(t);
  const desired = running(f);
  const stale = { ...desired, celld_sha256: "0".repeat(64) };
  f.write(f.configDir + "/running.json", JSON.stringify(stale));
  nextRelease(f);
  // Fail the first restart only.
  const original = f.calls.push.bind(f.calls);
  let failed = false;
  f.calls.push = (call) => {
    original(call);
    if (!failed && call.command === "systemctl" && call.args[0] === "restart") {
      failed = true;
      throw Object.assign(Error("injected"), { status: 1 });
    }
  };
  assert.throws(f.execute, /failed \(status 1\)/);
  assert.deepEqual(running(f), stale);
  f.execute();
  assert.equal(commands(f, "restart").length, 2);
  assert.deepEqual(inputs(running(f)), inputs(desired));
});

// Services installed before running.json existed are observed: a file older
// than the process start is what the process read.
function legacyFixture(t, { startedOffset, needDaemonReload = false, exe = "qualified runtime" }) {
  const f = liveFixture(t);
  rmSync(f.local(f.configDir + "/running.json"));
  f.write("/proc/4242/exe", exe);
  Object.assign(f.unitState, {
    active: true,
    pid: 4242,
    startedAt: Math.floor(Date.now() / 1000) + startedOffset,
    needDaemonReload,
  });
  nextRelease(f);
  return f;
}

test("a running service from an earlier installer adopts without a restart", (t) => {
  const f = legacyFixture(t, { startedOffset: 5 });
  f.execute();
  assert.deepEqual(commands(f, "restart"), []);
  assert.equal(f.outputs.at(-1).activation, "adopt");
  assert.equal(running(f).celld_sha256, profiles.CELLD_RELEASE.sha256);
});

for (const [name, options] of [
  ["files newer than the process", { startedOffset: -100 }],
  ["a pending daemon-reload", { startedOffset: 5, needDaemonReload: true }],
  ["a different running executable", { startedOffset: 5, exe: "older runtime" }],
])
  test(`an earlier installation with ${name} restarts`, (t) => {
    const f = legacyFixture(t, options);
    f.execute();
    assert.equal(commands(f, "restart").length, 1);
    assert.deepEqual(f.outputs.at(-1).restart_reasons, [
      { "a different running executable": "celld", "a pending daemon-reload": "reload" }[name] ??
        "unknown",
    ]);
  });

test("a record from an earlier process is ignored, and the current one observed", (t) => {
  const f = liveFixture(t);
  // A stale record that would restart, then an out-of-band restart after it.
  f.write(
    f.configDir + "/running.json",
    JSON.stringify({ ...running(f), config_sha256: "0".repeat(64) }),
  );
  f.write("/proc/4242/exe", "qualified runtime");
  Object.assign(f.unitState, { pid: 4242, startedAt: Math.floor(Date.now() / 1000) + 5 });
  nextRelease(f);
  f.execute();
  assert.deepEqual(commands(f, "restart"), []);
  assert.equal(f.outputs.at(-1).activation, "adopt");
  assert.equal(running(f).pid, 4242);
});

// Drop-ins and daemon-reload: the unit is what systemd loads, not only the
// fragment the installer renders.
const unitPath = "/etc/systemd/system/nteract-page10.service";
const dropIn = "/etc/systemd/system/nteract-page10.service.d/zz-test.conf";
const unitDigest = (fragment, dropIns = []) =>
  createHash("sha256").update(activation.unitInput(fragment, dropIns)).digest("hex");

test("a drop-in added without daemon-reload reloads, restarts and is recorded", (t) => {
  const f = liveFixture(t);
  const fragment = f.read(unitPath);
  f.write(dropIn, "[Service]\nEnvironment=PAGES_TEST=1\n");
  f.unitState.needDaemonReload = true;
  nextRelease(f);
  f.execute();
  assert.equal(commands(f, "daemon-reload").length, 1);
  assert.equal(commands(f, "restart").length, 1);
  assert.deepEqual(f.outputs.at(-1).restart_reasons, ["unit", "reload"]);
  assert.deepEqual(f.unitState.dropIns, [dropIn]);
  assert.equal(
    running(f).unit_sha256,
    unitDigest(fragment, [{ path: dropIn, text: "[Service]\nEnvironment=PAGES_TEST=1\n" }]),
  );
  // Unchanged since: the next release adopts.
  f.calls.length = 0;
  nextRelease(f, "cafe00000001", "d");
  f.execute();
  assert.equal(f.outputs.at(-1).activation, "adopt");
});

test("a drop-in loaded by an operator's daemon-reload still restarts once", (t) => {
  const f = liveFixture(t);
  f.write(dropIn, "[Service]\nEnvironment=PAGES_TEST=1\n");
  f.unitState.dropIns = [dropIn];
  nextRelease(f);
  f.execute();
  assert.deepEqual(commands(f, "daemon-reload"), []);
  assert.deepEqual(f.outputs.at(-1).restart_reasons, ["unit"]);
});

test("a removed drop-in restarts", (t) => {
  const f = liveFixture(t);
  f.write(dropIn, "[Service]\nEnvironment=PAGES_TEST=1\n");
  f.unitState.dropIns = [dropIn];
  nextRelease(f);
  f.execute();
  rmSync(f.local(dropIn));
  f.unitState.needDaemonReload = true;
  f.calls.length = 0;
  nextRelease(f, "cafe00000002", "e");
  f.execute();
  assert.deepEqual(f.outputs.at(-1).restart_reasons, ["unit", "reload"]);
  assert.deepEqual(f.unitState.dropIns, []);
});

test("NeedDaemonReload=yes with a matching record reloads and restarts", (t) => {
  const f = liveFixture(t);
  f.unitState.needDaemonReload = true;
  nextRelease(f);
  f.execute();
  assert.equal(commands(f, "daemon-reload").length, 1);
  assert.equal(commands(f, "restart").length, 1);
  assert.deepEqual(f.outputs.at(-1).restart_reasons, ["reload"]);
});

test("a unit that fails verification is never renamed into place or deployed", (t) => {
  const f = liveFixture(t);
  const rendered = f.read(unitPath);
  const old = rendered.replace("CELLD_TOKIO_THREADS=2", "CELLD_TOKIO_THREADS=1");
  f.write(unitPath, old);
  const recorded = { ...running(f), unit_sha256: unitDigest(old) };
  f.write(f.configDir + "/running.json", JSON.stringify(recorded));
  nextRelease(f);
  // Fail this fixture's verify once.
  const push = f.calls.push.bind(f.calls);
  let failed = false;
  f.calls.push = (call) => {
    push(call);
    if (!failed && call.command === "systemd-analyze") {
      failed = true;
      throw Object.assign(Error("injected"), { status: 1 });
    }
  };
  assert.throws(f.execute, /systemd-analyze failed/);
  assert.equal(f.read(unitPath), old);
  assert.deepEqual(
    fs.readdirSync(f.local("/etc/systemd")).filter((name) => name.startsWith(".")),
    [],
  );
  assert.deepEqual(commands(f, "daemon-reload"), []);
  assert.deepEqual(commands(f, "restart"), []);
  assert.ok(f.calls.every(({ command }) => command !== "runuser"));
  f.execute();
  assert.equal(f.read(unitPath), rendered);
  assert.deepEqual(f.outputs.at(-1).restart_reasons, ["unit"]);
});

test("a unit written by an interrupted run but never loaded is reloaded and restarted", (t) => {
  const f = liveFixture(t);
  // The record describes a process that loaded an older fragment; the new
  // text is on disk, and systemd says the loaded definition is stale.
  f.write(
    f.configDir + "/running.json",
    JSON.stringify({ ...running(f), unit_sha256: unitDigest("older fragment") }),
  );
  f.unitState.needDaemonReload = true;
  nextRelease(f);
  f.execute();
  assert.equal(commands(f, "daemon-reload").length, 1);
  assert.equal(commands(f, "restart").length, 1);
  assert.deepEqual(f.outputs.at(-1).restart_reasons, ["unit", "reload"]);
  assert.equal(running(f).unit_sha256, unitDigest(f.read(unitPath)));
});

test("a reload that does not take refuses before deploying or restarting", (t) => {
  const f = liveFixture(t);
  Object.assign(f.unitState, { needDaemonReload: true, reloadSticks: true });
  nextRelease(f);
  assert.throws(f.execute, /NeedDaemonReload=yes after daemon-reload; refusing/);
  assert.deepEqual(commands(f, "restart"), []);
  assert.ok(f.calls.every(({ command }) => command !== "runuser"));
});

test("--restart restarts an unchanged service", (t) => {
  const f = liveFixture(t);
  nextRelease(f);
  f.execute(["--restart"]);
  assert.equal(commands(f, "restart").length, 1);
  assert.deepEqual(f.outputs.at(-1).restart_reasons, ["requested"]);
});

test("the installer rejects unknown flags", (t) => {
  const f = liveFixture(t);
  assert.throws(() => f.execute(["--force"]), /Explicit root installation/);
  assert.deepEqual(f.calls, []);
});

test("a restart that never serves times out at 240 s and names the rollback", (t) => {
  const clock = { now: 1_000_000 };
  const f = liveFixture(t, {
    clock,
    health: () =>
      JSON.stringify({ ok: true, prototype: "pages-celld-native", build: "0123456789ab" }),
  });
  const before = f.read(f.configDir + "/running.json");
  nextRelease(f);
  const start = clock.now;
  let message = "";
  try {
    f.execute(["--restart"]);
  } catch (error) {
    message = error.message;
  }
  assert.match(message, /did not serve within 240000 ms/);
  assert.match(
    message,
    new RegExp(
      "previous deployment c0ffee0123456789 is recorded in /etc/nteract-page10/rollout-c{40}/previous-deployment[.]json",
    ),
  );
  assert.match(
    message,
    /sudo runuser -u nteract-page10 -- \/opt\/nteract-page10\/celld deploy \/opt\/nteract-page10\/releases\/a{40} --bucket s3:\/\/\S+\/standalone\/page10 --region us-east-1 --json/,
  );
  assert.equal(commands(f, "restart").length, 1);
  assert.ok(clock.now - start >= 240_000 && clock.now - start < 250_000);
  assert.equal(f.read(f.configDir + "/running.json"), before);
});

test("a timeout without an earlier deployment says so", (t) => {
  const clock = { now: 1_000_000 };
  const f = installFixture(t, {
    target: "page10",
    clock,
    health: () => JSON.stringify({ ok: false }),
  });
  assert.throws(f.execute, /did not serve within 240000 ms.*No earlier deployment to roll back to/);
});

// Fleet-wide serving: every live node's /state names the deployed version.
const peer = { node: "node_" + "2".repeat(32), addr: "172.31.1.233:19480", expires_ms: 9e15 };
const self = { node: "node_" + "1".repeat(32), addr: "172.31.1.152:19480", expires_ms: 9e15 };

test("install waits until every live node runs the deployed version", (t) => {
  const clock = { now: 1_000_000 };
  let polls = 0;
  const f = installFixture(t, {
    target: "page10",
    clock,
    nodes: [
      self,
      peer,
      { ...peer, node: "node_" + "3".repeat(32), expires_ms: 1 },
      // lab1's previous process, same listener, lease not yet expired.
      { ...self, node: "node_" + "4".repeat(32), expires_ms: self.expires_ms - 5000 },
    ],
    nodeVersion: (addr, deployed) =>
      addr === peer.addr && ++polls < 4 ? "0000000000000000" : deployed,
  });
  f.execute();
  const output = f.outputs.at(-1);
  assert.equal(output.fleet_nodes, 2);
  assert.equal(output.deployment_version, DEPLOYED);
  assert.ok(output.fleet_serving_after_ms >= 9000);
  assert.ok("local_serving_after_ms" in output && !("serving_after_ms" in output));
  // The expired lease is never asked.
  assert.ok(
    f.calls.every(({ command, args }) => command !== "curl" || !args.at(-1).includes("node_3")),
  );
});

test("a node that never adopts fails the install after the local record", (t) => {
  const clock = { now: 1_000_000 };
  const f = installFixture(t, {
    target: "page10",
    clock,
    nodes: [self, peer],
    nodeVersion: (addr, deployed) => (addr === peer.addr ? "0000000000000000" : deployed),
  });
  assert.throws(
    f.execute,
    new RegExp(
      `Fleet deployment ${DEPLOYED} did not serve within 120000 ms; last: ` +
        `${self.node}@${self.addr}=${DEPLOYED}, ${peer.node}@${peer.addr}=0000000000000000`,
    ),
  );
  assert.equal(JSON.parse(f.read(f.configDir + "/running.json")).schema, 2);
});

// Record storage: a release must open every Page record storage its target may
// hold. A build from before `record_storage` was recorded opens none beyond the
// native modes.
const PRE_PLAIN = { source_sha: "d".repeat(40), build_id: "9ae4ed83e44e" };
// A receipt that qualifies for every target: it reads the formats of each.
const PLAIN = {
  ...PRE_PLAIN,
  record_storage: CURRENT_RECORD_STORAGE,
  plain_storage_formats: CURRENT_PLAIN_STORAGE_FORMATS,
  document_formats: { "pages.page": [1, 3], "pages.comments": [1, 2] },
};

test("a release without plain storage is refused for a target that has enabled it", () => {
  for (const receipt of [PRE_PLAIN, { ...PRE_PLAIN, record_storage: ["local", "buffered"] }])
    assert.throws(
      () => profiles.assertReleaseOpensTargetPages("page10", receipt),
      (error) => {
        assert.match(error.message, /^Refusing release d{12} \(build 9ae4ed83e44e\) for page10: /);
        assert.match(error.message, /page10 may hold "automerge" Pages/);
        assert.match(error.message, /RECORD_STORAGE_HISTORY lists it\)/);
        assert.match(error.message, /Unsupported Page record storage mode/);
        return true;
      },
    );
});

test("a release that declares plain storage qualifies for a target that has enabled it", () => {
  assert.doesNotThrow(() => profiles.assertReleaseOpensTargetPages("page10", PLAIN));
});

test("plain targets refuse receipts that know automerge but not the current plain format", () => {
  for (const formats of [undefined, [], ["v1"]]) {
    const receipt = { ...PLAIN, plain_storage_formats: formats };
    assert.throws(
      () => profiles.assertReleaseOpensTargetPages("page10", receipt),
      /plain_storage_formats.*doc-store-v2-host-actor-prefix/,
    );
    assert.throws(
      () => profiles.assertReleaseOpensTargetPages("pages", receipt),
      /plain_storage_formats.*doc-store-v2-host-actor-prefix/,
    );
    assert.throws(
      () =>
        profiles.assertReleaseOpensTargetPages("page10", receipt, [
          { mode: "automerge", release: "old" },
        ]),
      /plain_storage_formats/,
    );
  }
});

test("a release must list the document formats a target's documents are in", () => {
  const format1 = { "pages.page": [1], "pages.comments": [1] };
  const format3 = { "pages.page": [3], "pages.comments": [2] };
  // page10 holds pages.page 3 and pages.comments 2. The other targets hold
  // format 1 of both.
  for (const [target, formats] of [
    ["page10", format3],
    ["pages", format1],
    ["pages2", format1],
    ["page11", format1],
  ])
    assert.doesNotThrow(() =>
      profiles.assertReleaseOpensTargetPages(target, { ...PLAIN, document_formats: formats }),
    );
  // A current build reads pages.page 3: page10 accepts it and the format 1
  // targets refuse it.
  for (const target of ["pages", "pages2", "page11"])
    assert.throws(
      () => profiles.assertReleaseOpensTargetPages(target, { ...PLAIN, document_formats: format3 }),
      /pages\.page documents are in format 1/,
      target,
    );
  assert.throws(
    () => profiles.assertReleaseOpensTargetPages("page10", { ...PLAIN, document_formats: format1 }),
    /page10's pages\.page documents are in format 3/,
  );
  // A build that reads the formats before these doesn't open page10.
  assert.throws(
    () =>
      profiles.assertReleaseOpensTargetPages("page10", {
        ...PLAIN,
        document_formats: { "pages.page": [2], "pages.comments": [1] },
      }),
    /page10's pages\.page documents are in format 3/,
  );
  // A receipt built before the field wrote and read format 1 of both types.
  const { document_formats: _absent, ...beforeField } = PLAIN;
  assert.doesNotThrow(() => profiles.assertReleaseOpensTargetPages("pages", beforeField));
  assert.throws(
    () => profiles.assertReleaseOpensTargetPages("page10", beforeField),
    /page10's pages\.page documents are in format 3/,
  );
  for (const [type, listed, format] of [
    ["pages.page", [2], 3],
    ["pages.page", [], 3],
    ["pages.comments", [1], 2],
    ["pages.comments", undefined, 2],
  ])
    assert.throws(
      () =>
        profiles.assertReleaseOpensTargetPages("page10", {
          ...PLAIN,
          document_formats: { ...format3, [type]: listed },
        }),
      (error) => {
        assert.match(error.message, /^Refusing release d{12} \(build 9ae4ed83e44e\) for page10: /);
        assert.match(
          error.message,
          new RegExp(`page10's ${type.replace(".", "\\.")} documents are in format ${format}`),
        );
        assert.match(error.message, /lists document_formats/);
        return true;
      },
    );
  // Only an absent field means a receipt from before it. Anything else that
  // lists no formats opens no documents.
  for (const document_formats of [{}, null, [], "pages.page:3", { "pages.page": "3" }])
    assert.throws(
      () => profiles.assertReleaseOpensTargetPages("page10", { ...PLAIN, document_formats }),
      /documents are in format 3/,
      JSON.stringify(document_formats),
    );
});

test("install refuses an old plain format before any write", (t) => {
  const f = installFixture(t, {
    target: "page10",
    buildReceipt: { ...PLAIN, plain_storage_formats: undefined },
  });
  assert.throws(f.execute, /plain_storage_formats/);
  assert.ok(f.calls.every(({ args }) => args[0] === "--version"));
  assert.equal(fs.existsSync(f.local(f.release)), false);
  assert.equal(fs.existsSync(f.local(f.audit)), false);
});

for (const [label, receipt, error] of [
  ["missing storage declaration", PRE_PLAIN, /record_storage/],
  [
    "incompatible storage mode",
    { ...PLAIN, record_storage: ["local", "buffered"] },
    /record_storage/,
  ],
  ...[undefined, [], ["v1"]].map((formats) => [
    `incompatible plain format ${JSON.stringify(formats)}`,
    { ...PLAIN, plain_storage_formats: formats },
    /plain_storage_formats.*doc-store-v2-host-actor-prefix/,
  ]),
])
  test(`page11 second install refuses ${label} without retired storage vars`, (t) => {
    const f = installFixture(t, { target: "page11", fresh: true });
    f.execute();
    assert.equal(f.outputs.at(-1).installed, true);
    const config = JSON.parse(f.read(f.release + "/wrangler.json"));
    assert.equal(Object.hasOwn(config.vars, "PAGES_RECORD_STORAGE"), false);
    const installed = [
      f.configDir + "/deployment.json",
      f.configDir + "/running.json",
      f.configDir + "/session-secret",
      f.release + "/wrangler.json",
    ];
    const before = installed.map(f.read);
    f.write(
      f.stage + "/manifest.json",
      JSON.stringify({
        ...f.manifest,
        source_sha: "c".repeat(40),
        build_receipt: receipt,
      }),
    );
    f.calls.length = 0;
    f.mutations.length = 0;
    assert.throws(f.execute, error);
    assert.deepEqual(f.mutations, []);
    assert.ok(f.calls.every(({ args }) => args[0] === "--version"));
    assert.equal(f.outputs.length, 1);
    assert.deepEqual(installed.map(f.read), before);
    assert.equal(fs.existsSync(f.local("/opt/nteract-page11/releases/" + "c".repeat(40))), false);
    assert.equal(fs.existsSync(f.local(f.configDir + "/rollout-" + "c".repeat(40))), false);
  });

test("a release the host ran with plain storage is named beside the target's history", () => {
  assert.deepEqual(
    [...profiles.targetRecordStorage("page10", [{ mode: "automerge", release: "a2c9d5dded35" }])],
    [
      [
        "automerge",
        [
          "RECORD_STORAGE_HISTORY lists it",
          "release a2c9d5dded35 on the host was configured with it",
        ],
      ],
    ],
  );
  assert.throws(
    () =>
      profiles.assertReleaseOpensTargetPages("page10", PRE_PLAIN, [
        { mode: "automerge", release: "a2c9d5dded35" },
      ]),
    /page10 may hold "automerge" Pages \(RECORD_STORAGE_HISTORY lists it; release a2c9d5dded35 on the host was configured with it\)/,
  );
});

test("Pages refuses a release without plain storage from its history alone", () => {
  // The restart deploy that turns plain Pages on may not have run yet; the
  // history entry already refuses every build that could not open them.
  assert.deepEqual(
    [...profiles.targetRecordStorage("pages")],
    [["automerge", ["RECORD_STORAGE_HISTORY lists it"]]],
  );
  for (const receipt of [PRE_PLAIN, { ...PRE_PLAIN, record_storage: ["local", "buffered"] }])
    assert.throws(
      () => profiles.assertReleaseOpensTargetPages("pages", receipt),
      /^Error: Refusing release d{12} \(build 9ae4ed83e44e\) for pages: pages may hold "automerge" Pages \(RECORD_STORAGE_HISTORY lists it\)/,
    );
  assert.doesNotThrow(() => profiles.assertReleaseOpensTargetPages("pages", PLAIN));
});

test("serving targets hold plain Pages for good, and no profile names record storage", () => {
  for (const target of ["page10", "pages", "pages2", "page11"]) {
    const profile = profiles.deploymentProfile(target);
    for (const key of ["recordStorage", "recordStorageMigration", "asyncPersistence"])
      assert.equal(profile[key], undefined, `${target} ${key}`);
  }
  assert.deepEqual(profiles.RECORD_STORAGE_HISTORY.page10, ["automerge"]);
  assert.deepEqual(profiles.RECORD_STORAGE_HISTORY.pages, ["automerge"]);
  assert.deepEqual(profiles.RECORD_STORAGE_HISTORY.pages2, ["automerge"]);
});

test("the build receipt lists every record storage mode the Worker opens", async () => {
  const { RECORD_STORAGE_MODES } = await import("../shared/record-storage.mjs");
  assert.deepEqual([...RECORD_STORAGE_MODES], CURRENT_RECORD_STORAGE);
  const source = fs.readFileSync(new URL("./source-fingerprint.mjs", import.meta.url), "utf8");
  assert.match(source, /record_storage: \[\.\.\.RECORD_STORAGE_MODES\]/);
  const { PLAIN_STORAGE_FORMATS } = await import("../shared/record-storage.mjs");
  assert.deepEqual(PLAIN_STORAGE_FORMATS, CURRENT_PLAIN_STORAGE_FORMATS);
  assert.match(source, /plain_storage_formats: \[\.\.\.PLAIN_STORAGE_FORMATS\]/);
  assert.match(source, /document_formats: documentFormats/);
  for (const entry of ["deploy.mjs", "deployment/install.mjs"])
    assert.match(
      fs.readFileSync(new URL(entry, import.meta.url), "utf8"),
      /assertReleaseOpensTargetPages\(/,
    );
  const worker = fs.readFileSync(new URL("../worker/index.mjs", import.meta.url), "utf8");
  assert.match(worker, /!RECORD_STORAGE_MODES\.includes\(metadata\.recordStorage\)/);
});

test("Page10 refuses to install a release without plain storage before any write", (t) => {
  const f = installFixture(t, {
    target: "page10",
    installedRuntime: { version: "celld 0.6.3", bytes: "qualified runtime" },
    buildReceipt: { build_id: PRE_PLAIN.build_id },
  });
  assert.throws(f.execute, /Refusing release a{12} \(build 9ae4ed83e44e\) for page10: /);
  assert.ok(f.calls.every(({ args }) => args[0] === "--version"));
  assert.equal(fs.existsSync(f.local(f.release)), false);
  assert.equal(fs.existsSync(f.local(f.audit)), false);
  assert.deepEqual(JSON.parse(f.read(f.configDir + "/deployment.json")), { id: "previous" });
});

test("Pages refuses to install a release without plain storage before any write", (t) => {
  const f = installFixture(t, {
    target: "pages",
    installedRuntime: { version: "celld 0.6.3", bytes: "qualified runtime" },
    buildReceipt: { build_id: PRE_PLAIN.build_id },
  });
  assert.throws(f.execute, /Refusing release a{12} \(build 9ae4ed83e44e\) for pages: /);
  assert.ok(f.calls.every(({ args }) => args[0] === "--version"));
  assert.equal(fs.existsSync(f.local(f.release)), false);
  assert.equal(fs.existsSync(f.local(f.audit)), false);
  assert.deepEqual(JSON.parse(f.read(f.configDir + "/deployment.json")), { id: "previous" });
});

test("a host release configured with plain storage blocks a release without it", (t) => {
  const f = installFixture(t, {
    target: "page10",
    buildReceipt: { build_id: PRE_PLAIN.build_id },
  });
  f.write(
    "/opt/nteract-page10/releases/" + "e".repeat(40) + "/wrangler.json",
    JSON.stringify({ vars: { PAGES_RECORD_STORAGE: "automerge" } }),
  );
  assert.throws(f.execute, /release e{12} on the host was configured with it/);
  assert.equal(fs.existsSync(f.local(f.release)), false);
});

test("a timeout does not name a rollback to a release without the plain format capability", (t) => {
  const clock = { now: 1_000_000 };
  const f = liveFixture(t, {
    clock,
    health: () =>
      JSON.stringify({ ok: true, prototype: "pages-celld-native", build: "0123456789ab" }),
  });
  // The previous deployment knows automerge but not its current storage format.
  const earlier = f.audit + "/manifest.json";
  const recorded = JSON.parse(f.read(earlier));
  f.write(
    earlier,
    JSON.stringify({
      ...recorded,
      build_receipt: {
        build_id: "0123456789ab",
        record_storage: CURRENT_RECORD_STORAGE,
        document_formats: PLAIN.document_formats,
      },
    }),
  );
  nextRelease(f);
  let message = "";
  try {
    f.execute(["--restart"]);
  } catch (error) {
    message = error.message;
  }
  assert.match(message, /did not serve within 240000 ms/);
  assert.match(
    message,
    /previous deployment c0ffee0123456789 is recorded in .*, but do not roll back/,
  );
  assert.match(message, /Refusing release a{12} \(build 0123456789ab\) for page10: /);
  assert.doesNotMatch(message, /Roll back with/);
  assert.match(message, /plain_storage_formats/);
});

test("serving targets shed above 2.5 GB and a profile without memory keeps the default limits", () => {
  for (const target of ["page10", "pages"])
    assert.deepEqual(profiles.unitMemory(profiles.deploymentProfile(target)), {
      maxRssMb: 2560,
      memoryMax: "4G",
    });
  assert.deepEqual(profiles.unitMemory(profiles.deploymentProfile("page11")), {
    maxRssMb: 1280,
    memoryMax: "2G",
  });
  assert.deepEqual(profiles.unitMemory({}), profiles.DEFAULT_MEMORY);
  assert.deepEqual(profiles.DEFAULT_MEMORY, { maxRssMb: 768, memoryMax: "1G" });
  for (const memory of [
    { maxRssMb: 100, memoryMax: "4G" },
    { maxRssMb: 2560.5, memoryMax: "4G" },
    { maxRssMb: 2560, memoryMax: "4096M" },
    { maxRssMb: 2560, memoryMax: "3G" },
    { maxRssMb: 2560, memoryMax: "0G" },
    { maxRssMb: 2560 },
  ])
    assert.throws(() => profiles.unitMemory({ memory }), /memory\./);
});

const FIXTURE_KEYRING = {
  active: "k2",
  keys: { k1: "k1-fixture-session-key-".repeat(2), k2: "k2-fixture-session-key-".repeat(2) },
};

test("the installer refuses a host with neither a keyring nor the single secret", (t) => {
  const f = installFixture(t, { target: "page10" });
  fs.rmSync(f.local(f.configDir + "/session-secret"));
  assert.throws(f.execute, /Neither .*session-keys[.]json nor .*session-secret exists/);
  assert.equal(fs.existsSync(f.local(f.release)), false);
  assert.ok(f.calls.every(({ args }) => args[0] === "--version"));
});

test("a keyring install records when the Worker began signing and carries it along one line", (t) => {
  const f = liveFixture(t);
  assert.equal(fs.existsSync(f.local(f.configDir + "/session-keys-active.json")), false);
  f.write(f.configDir + "/session-keys.json", JSON.stringify(FIXTURE_KEYRING));
  fs.rmSync(f.local(f.configDir + "/session-secret"));
  nextRelease(f);
  f.execute();
  const record = JSON.parse(f.read(f.configDir + "/session-keys-active.json"));
  assert.equal(record.active, "k2");
  assert.equal(record.deployment_version, DEPLOYED);
  assert.ok(!Number.isNaN(Date.parse(record.activated_at)));
  assert.deepEqual(f.outputs.at(-1).session_key, {
    active: "k2",
    signing_since: record.activated_at,
  });
  // The node reported the recorded deployment before this install: same line.
  assert.ok(
    f.calls.some(
      ({ command, args }) => command === "curl" && args.at(-1) === "http://127.0.0.1:19480/state",
    ),
  );
  nextRelease(f, "cd9876543210", "d");
  f.execute();
  assert.deepEqual(JSON.parse(f.read(f.configDir + "/session-keys-active.json")), record);
});

test("a keyring install gives older release configs the current session vars", (t) => {
  const f = liveFixture(t);
  const earlier = f.release + "/wrangler.json";
  const before = JSON.parse(f.read(earlier));
  assert.equal(before.vars.NOTEBOOK_CLOUD_APP_SESSION_SECRET, "fixture-only-session-secret");
  f.write(f.configDir + "/session-keys.json", JSON.stringify(FIXTURE_KEYRING));
  nextRelease(f);
  f.execute();
  const after = JSON.parse(f.read(earlier));
  assert.equal(after.vars.NOTEBOOK_CLOUD_APP_SESSION_SECRET, undefined);
  assert.deepEqual(JSON.parse(after.vars.NOTEBOOK_CLOUD_APP_SESSION_KEYS), FIXTURE_KEYRING);
  const { NOTEBOOK_CLOUD_APP_SESSION_SECRET: _secret, ...otherVars } = before.vars;
  const { NOTEBOOK_CLOUD_APP_SESSION_KEYS: _keys, ...keptVars } = after.vars;
  assert.deepEqual(keptVars, otherVars);
  assert.deepEqual({ ...after, vars: null }, { ...before, vars: null });
  // After a retire, the next install takes the retired key off the disk too.
  f.write(
    f.configDir + "/session-keys.json",
    JSON.stringify({ active: "k2", keys: { k2: FIXTURE_KEYRING.keys.k2 } }),
  );
  nextRelease(f, "cd9876543210", "d");
  f.execute();
  for (const sha of ["a", "c"])
    assert.doesNotMatch(
      f.read("/opt/nteract-page10/releases/" + sha.repeat(40) + "/wrangler.json"),
      /k1-fixture-session-key/,
    );
});

for (const [label, keyringBuild] of [
  ["refuses", false],
  ["names", true],
])
  test(`a keyring timeout ${label} a rollback to a release ${keyringBuild ? "with" : "without"} the keyring`, (t) => {
    const clock = { now: 1_000_000 };
    const f = liveFixture(t, {
      clock,
      health: () =>
        JSON.stringify({ ok: true, prototype: "pages-celld-native", build: "0123456789ab" }),
    });
    if (keyringBuild) {
      const earlier = f.audit + "/manifest.json";
      const recorded = JSON.parse(f.read(earlier));
      f.write(
        earlier,
        JSON.stringify({ ...recorded, files: { ...recorded.files, "session-keys.mjs": "0" } }),
      );
    }
    f.write(f.configDir + "/session-keys.json", JSON.stringify(FIXTURE_KEYRING));
    nextRelease(f);
    let message = "";
    try {
      f.execute(["--restart"]);
    } catch (error) {
      message = error.message;
    }
    assert.match(message, /did not serve within 240000 ms/);
    if (keyringBuild) assert.match(message, /Roll back with/);
    else {
      assert.match(message, /but do not roll back to it. It predates the session keyring/);
      assert.doesNotMatch(message, /Roll back with/);
    }
    assert.equal(fs.existsSync(f.local(f.configDir + "/session-keys-active.json")), false);
  });

test("an install without a keyring drops a stale activation record", (t) => {
  const f = liveFixture(t);
  f.write(f.configDir + "/session-keys-active.json", JSON.stringify({ active: "k2" }));
  nextRelease(f);
  f.execute();
  assert.equal(fs.existsSync(f.local(f.configDir + "/session-keys-active.json")), false);
});
