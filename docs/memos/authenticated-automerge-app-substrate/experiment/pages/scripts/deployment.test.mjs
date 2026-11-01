import test from "node:test";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { sourceFingerprint } from "./source-fingerprint.mjs";
import { insertRoutes, routes } from "./deployment/publish.mjs";
import { configureDns } from "./deployment/dns.mjs";
import { pagesFirewall } from "./deployment/firewall.mjs";
import * as profiles from "./deployment/profiles.mjs";
import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import ts from "typescript";

test("fingerprint follows imported auth source and ignores output/unrelated churn", () => {
  const root = mkdtempSync(path.join(tmpdir(), "pages-inputs-"));
  const app = path.join(root, "experiment/pages");
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
      write("experiment/" + name, name.endsWith(".json") ? "{}" : "");
    write("experiment/pages/worker.mjs", 'import "@cloud/identity.ts";');
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
      ".celld/state",
      ".env",
      ".dev.vars",
    ])
      write("experiment/pages/" + output, "not an input");
    write("unrelated/README.md", "unrelated change");
    assert.equal(sourceFingerprint(app, { root }).sha256, original.sha256);
    write("apps/notebook-cloud/src/verify.ts", "export const verified = false;");
    assert.notEqual(sourceFingerprint(app, { root }).sha256, original.sha256);
    const updated = sourceFingerprint(app, { root }).sha256;
    write("experiment/pages/new.mjs", "export const feature = true;");
    assert.notEqual(sourceFingerprint(app, { root }).sha256, updated);
    assert.ok(original.files["packages/runtimed/src/scope-capabilities.ts"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("publication inserts only owned hostname rules and refuses conflicts", () => {
  const original =
    'tunnel: test\ningress:\n  - hostname: m.runtimed.run\n    service: http://127.0.0.1:9471\n  - hostname: "*.runtimed.run"\n    service: http://127.0.0.1:29999\n  - service: http_status:404\n';
  const updated = insertRoutes(original);
  assert.equal(updated.replace(routes, ""), original);
  assert.equal(insertRoutes(updated), updated);
  assert.throws(() => insertRoutes(original.replace('"*.runtimed.run"', "other.example")));
  assert.throws(() => insertRoutes(original + "\n# pages-next.runtimed.run is owned elsewhere"));
  assert.match(routes, /api\/\(tools\|connect\|sync\|saved/);
  assert.match(routes, /hostname: pages-next.runtimed.run\n    service: http_status:404/);
});

test("service firewall uses its own cgroup, table and mark", () => {
  const rules = pagesFirewall(998);
  assert.match(rules, /table inet nteract_pages_next/);
  assert.match(rules, /system.slice\/nteract-pages-next.service/);
  assert.match(rules, /0x20000000/);
  assert.match(rules, /meta skuid \{ 0, 998 \}/);
  assert.doesNotMatch(rules, /nteract-pages.service|nteract_operator|0x40000000|0x80000000/);
  assert.throws(() => pagesFirewall(0));
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
  const before = await configureDns({ token: "fixture", tunnelId, fetchImpl: fixture.fetchImpl });
  assert.equal(before.present, false);
  assert.ok(fixture.calls.every((call) => call.method === "GET"));
  const created = await configureDns({
    token: "fixture",
    tunnelId,
    apply: true,
    fetchImpl: fixture.fetchImpl,
  });
  assert.equal(created.changed, true);
  assert.equal(created.name, "pages-next.runtimed.run");
  assert.equal(fixture.calls.filter((call) => call.method === "POST").length, 1);
  const again = await configureDns({
    token: "fixture",
    tunnelId,
    apply: true,
    fetchImpl: fixture.fetchImpl,
  });
  assert.equal(again.changed, false);
  assert.equal(fixture.calls.filter((call) => call.method === "POST").length, 1);
});
test("DNS refuses foreign ownership, another tunnel, and ambiguous records", async () => {
  const desired = {
    id: "b".repeat(32),
    name: "pages-next.runtimed.run",
    type: "CNAME",
    content: `${tunnelId}.cfargotunnel.com`,
    proxied: true,
    ttl: 1,
    comment: "nteract/pages:experiment:pages-next",
  };
  for (const records of [
    [{ ...desired, comment: "foreign" }],
    [{ ...desired, content: "elsewhere.example" }],
    [desired, desired],
  ]) {
    const fixture = dnsFixture(records);
    await assert.rejects(
      configureDns({ token: "fixture", tunnelId, apply: true, fetchImpl: fixture.fetchImpl }),
    );
    assert.ok(fixture.calls.every((call) => call.method === "GET"));
  }
});
test("DNS transport errors do not echo credentials", async () => {
  await assert.rejects(
    configureDns({
      token: "secret-value",
      tunnelId,
      fetchImpl: async () => {
        throw new Error("secret-value");
      },
    }),
    (error) => !error.message.includes("secret-value"),
  );
});

test("release staging copies only built artifacts, never development credentials/state", async () => {
  const { stageArtifacts, releaseArtifacts } = await import("./stage-artifacts.mjs");
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
  const receipt = JSON.stringify({ viewer_chunks: certified, viewer_assets: certifiedAssets });
  const contents = (artifact) =>
    artifact === "build-receipt.json" ? receipt : (assetBytes[artifact] ?? "artifact:" + artifact);
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

function installFixture(
  t,
  {
    failure,
    previous = true,
    target = "pages-next",
    fresh = false,
    listeners = "",
    rules = "{}",
    installedRuntime,
    candidateVersion,
    qualify = profiles.assertQualifiedDeploymentTarget,
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
      durable_objects: { bindings: [{ name: "PAGE_RECORDS", class_name: "PageRecords" }] },
      r2_buckets: [{ binding: "PAGES_ASSETS", bucket_name: "pages-images" }],
      migrations: [{ tag: "fixture", new_sqlite_classes: ["PageRecords"] }],
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
  let pendingFailure = failure;
  const filesystem = {};
  for (const name of [
    "existsSync",
    "lstatSync",
    "mkdirSync",
    "readFileSync",
    "readdirSync",
    "writeFileSync",
  ])
    filesystem[name] = (file, ...args) => fs[name](local(file), ...args);
  filesystem.chmodSync = filesystem.chownSync = () => {};
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
  const childProcess = {
    execFileSync(command, args) {
      calls.push({ command, args });
      if (
        (pendingFailure === "deploy" && command === "runuser") ||
        (pendingFailure === "restart" && command === "systemctl" && args[0] === "restart")
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
        if (fresh && args.length === 1) throw Object.assign(Error("missing user"), { status: 1 });
        return "998";
      }
      if (command === "ss") return listeners;
      if (command === "/usr/local/bin/aws") return "0";
      if (command === "/usr/sbin/nft") return rules;
      if (command === "useradd") return "";
      if (command === "runuser") return JSON.stringify({ id: "current" });
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
    "./profiles.mjs": { ...profiles, assertQualifiedDeploymentTarget: qualify },
  };
  const execute = () =>
    runInNewContext(compiled, {
      exports: {},
      require: (name) => {
        if (!Object.hasOwn(modules, name)) throw Error("Unexpected import: " + name);
        return modules[name];
      },
      process: { argv: ["node", "install.mjs", stage, "--apply"], getuid: () => 0 },
      console: { log() {} },
    });
  return {
    execute,
    calls,
    write,
    local,
    manifest,
    stage,
    configDir,
    release: "/opt/" + deployment.service + "/releases/" + manifest.source_sha,
    audit: configDir + "/rollout-" + manifest.source_sha,
    read: (file) => fs.readFileSync(local(file), "utf8"),
  };
}

// Historical installer fixtures model the release that qualified that target.
// They retain recovery/collision coverage without weakening the real CLI guard.
function historicalInstallFixture(t, options = {}) {
  return installFixture(t, {
    ...options,
    ...(options.target !== "page10" && { qualify: profiles.deploymentProfile }),
  });
}

for (const target of ["pages-next", "page3", "page4", "page5", "page6", "page7", "page8", "page9"])
  test(`current installer refuses frozen ${target} before host commands or release writes`, (t) => {
    const fixture = installFixture(t, { target });
    assert.throws(fixture.execute, /qualified only for page10/);
    assert.deepEqual(fixture.calls, []);
    assert.equal(fs.existsSync(fixture.local(fixture.release)), false);
    assert.equal(fs.existsSync(fixture.local(fixture.audit)), false);
    assert.deepEqual(JSON.parse(fixture.read(fixture.configDir + "/deployment.json")), {
      id: "previous",
    });
  });

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
  const fixture = historicalInstallFixture(t, {
    candidateVersion: "WARN allocator background thread unavailable\ncelld 0.6.3\n",
    installedRuntime: { version: "WARN allocator background thread unavailable\ncelld 0.6.1\n" },
  });
  fixture.execute();
  assert.equal(fixture.read("/opt/nteract-pages-next/celld"), "qualified runtime");
});

test("all Pages targets require the verified 0.6.3 Linux executable", () => {
  const release = profiles.CELLD_RELEASE;
  assert.equal(release.version, "celld 0.6.3");
  assert.equal(release.path, "/usr/local/bin/celld-v0.6.3");
  assert.equal(release.sha256, "eb0a8158421b69d68dd5d28f2298a7d411dde498295833deeb1cc5ce53b7eb75");
  for (const target of ["pages-next", "page3", "page4", "page5", "page6"]) {
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
    const fixture = historicalInstallFixture(t, {
      target: "page6",
      installedRuntime: {
        version: installed,
        ...(installed === "celld 0.6.3" && { bytes: "qualified runtime" }),
      },
    });
    fixture.execute();
    fixture.execute();
    assert.equal(fixture.read("/opt/nteract-page6/celld"), "qualified runtime");
    const unit = fixture.read("/etc/systemd/system/nteract-page6.service");
    assert.match(unit, /Environment=CELLD_OTEL=1\n/);
    assert.match(unit, /Environment=CELLD_OTEL_RETENTION=30d\n/);
    assert.doesNotMatch(unit, /CELLD_OTEL_(?:FLUSH_MS|FLUSH_BYTES|SINK)=/);
    assert.doesNotMatch(unit, /OTEL_TRACES_SAMPLER=/);
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
    const fixture = historicalInstallFixture(t, {
      target: "page6",
      installedRuntime: { version: installed },
    });
    assert.throws(
      fixture.execute,
      /newer or unrecognized|same version but a different build|canonical celld release/,
    );
    assert.equal(fixture.read("/opt/nteract-page6/celld"), "previous runtime");
    assert.equal(fs.existsSync(fixture.local(fixture.release)), false);
    assert.ok(fixture.calls.every(({ args }) => args[0] === "--version"));
  });

test("runtime copy mismatch preserves the active executable and can be retried", (t) => {
  const fixture = historicalInstallFixture(t, {
    target: "page6",
    failure: "runtime-copy",
    installedRuntime: { version: "celld 0.6.1" },
  });
  assert.throws(fixture.execute, /Copied celld differs/);
  assert.equal(fixture.read("/opt/nteract-page6/celld"), "previous runtime");
  assert.ok(fixture.calls.every(({ command }) => command !== "runuser"));
  fixture.execute();
  assert.equal(fixture.read("/opt/nteract-page6/celld"), "qualified runtime");
});

test("installer rejects unqualified staged or changed source runtimes before mutation", (t) => {
  const badManifest = historicalInstallFixture(t);
  badManifest.write(
    badManifest.stage + "/manifest.json",
    JSON.stringify({
      ...badManifest.manifest,
      runtime: { version: "celld 0.6.3", sha256: "0".repeat(64) },
    }),
  );
  assert.throws(badManifest.execute, /official celld 0.6.3/);
  assert.deepEqual(badManifest.calls, []);
  const badVersion = historicalInstallFixture(t, { candidateVersion: "celld 0.6.1" });
  assert.throws(badVersion.execute, /official celld 0.6.3/);
  const badBytes = historicalInstallFixture(t);
  badBytes.write(profiles.CELLD_RELEASE.path, "unexpected runtime");
  assert.throws(badBytes.execute, /official celld 0.6.3/);
  for (const fixture of [badVersion, badBytes])
    assert.equal(fs.existsSync(fixture.local(fixture.release)), false);
});

for (const failure of ["deploy", "restart"])
  for (const previous of [true, false])
    test(`installation retries ${failure} failure with previous deployment ${previous}`, (t) => {
      const fixture = historicalInstallFixture(t, { failure, previous });
      assert.throws(fixture.execute, /failed \(status 1\)/);
      const before = fixture.read(fixture.audit + "/previous-deployment.json");
      assert.deepEqual(JSON.parse(before), previous ? { id: "previous" } : null);
      fixture.execute();
      assert.equal(fixture.read(fixture.audit + "/previous-deployment.json"), before);
      assert.deepEqual(JSON.parse(fixture.read(fixture.audit + "/deployment.json")), {
        id: "current",
      });
      assert.equal(fixture.calls.filter(({ command }) => command === "runuser").length, 2);
    });

test("installation fills only missing verified artifacts after a partial copy", (t) => {
  const fixture = historicalInstallFixture(t, { failure: "copy" });
  assert.throws(fixture.execute, /injected copy failure/);
  assert.equal(fs.existsSync(fixture.local(fixture.release + "/public/app.js")), false);
  fixture.execute();
  assert.equal(fixture.read(fixture.release + "/public/app.js"), "console.log('fixture');");
  assert.equal(fixture.calls.filter(({ command }) => command === "runuser").length, 1);
});

for (const tampering of ["artifact", "extra-file", "symlink", "audit-manifest"])
  test(`installation retry rejects changed ${tampering}`, (t) => {
    const fixture = historicalInstallFixture(t, { failure: "deploy" });
    assert.throws(fixture.execute, /failed \(status 1\)/);
    if (tampering === "artifact") fixture.write(fixture.release + "/index.js", "modified");
    if (tampering === "extra-file") fixture.write(fixture.release + "/unexpected.js", "extra");
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

test("deployment CLI preserves defaults and requires explicit allowlisted page3 target", () => {
  const command = new URL("./deploy.mjs", import.meta.url);
  const plan = (args) =>
    JSON.parse(execFileSync(process.execPath, [command.pathname, ...args], { encoding: "utf8" }));
  const next = plan([]),
    page3 = plan(["--target", "page3", "plan"]);
  assert.equal(next.hostname, "pages-next.runtimed.run");
  assert.equal(page3.hostname, "page3.runtimed.run");
  for (const key of ["hostname", "service", "prefix", "listen", "internalListen"])
    assert.notEqual(page3[key], next[key], key);
  assert.equal(page3.bucket, next.bucket);
  for (const argv of [["--target"], ["--target", "elsewhere"], ["--target", "__proto__"]])
    assert.throws(() => profiles.selectTarget(argv), /Unknown Pages deployment target/);
});

test("prepared stages and manifests cannot cross deployment targets", () => {
  const next = profiles.deploymentProfile().deployment;
  const page3 = profiles.deploymentProfile("page3").deployment;
  assert.equal(profiles.stageTarget("/tmp/nteract-page3-stage-abcd1234"), "page3");
  assert.equal(profiles.stagePattern().test("/tmp/nteract-page3-stage-abcd1234"), false);
  assert.throws(() => profiles.stageTarget("/tmp/nteract-page3-stage-abcd1234/../other"));
  assert.throws(() =>
    profiles.verifyDeployment({ source_sha: "a".repeat(40), deployment: next }, "page3"),
  );
  assert.throws(() => profiles.verifyDeployment({ source_sha: "a".repeat(40), deployment: page3 }));
});

test("page3 firewall refreshes only its own table and cgroup", () => {
  const rules = pagesFirewall(999, true, "page3");
  assert.match(rules, /^delete table inet nteract_page3\n/);
  assert.match(rules, /system.slice\/nteract-page3.service/);
  assert.match(rules, /0x10000000/);
  assert.doesNotMatch(rules, /pages.next|0x20000000|0x40000000|0x80000000/);
});

test("page3 DNS is independently owned and never adopts pages-next records", async () => {
  const fixture = dnsFixture();
  const args = { token: "fixture", tunnelId, target: "page3", fetchImpl: fixture.fetchImpl };
  assert.equal((await configureDns(args)).present, false);
  assert.ok(
    fixture.calls.every(({ url, method }) => method === "GET" && !url.includes("pages-next")),
  );
  const created = await configureDns({ ...args, apply: true });
  assert.equal(created.name, "page3.runtimed.run");
  assert.equal(created.changed, true);
  assert.equal((await configureDns({ ...args, apply: true })).changed, false);
  const foreign = dnsFixture([
    {
      id: "b".repeat(32),
      name: "page3.runtimed.run",
      type: "CNAME",
      content: `${tunnelId}.cfargotunnel.com`,
      proxied: true,
      ttl: 1,
      comment: "nteract/pages:experiment:pages-next",
    },
  ]);
  await assert.rejects(
    configureDns({ ...args, apply: true, fetchImpl: foreign.fetchImpl }),
    /conflicts/,
  );
  assert.ok(foreign.calls.every(({ method }) => method === "GET"));
});

for (const target of ["pages-next", "page3", "page4", "page5", "page6"])
  test(`${target} installation retains auth, bindings, and bucket durability with isolated service state`, (t) => {
    const fixture = historicalInstallFixture(t, { target });
    fixture.execute();
    const deployment = profiles.deploymentProfile(target).deployment;
    const config = JSON.parse(fixture.read(fixture.release + "/wrangler.json"));
    assert.equal(config.vars.NOTEBOOK_CLOUD_PUBLIC_ORIGIN, "https://" + deployment.hostname);
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
    assert.equal(config.vars.PAGES_ASYNC_PERSISTENCE, target === "pages-next" ? undefined : "true");
    assert.equal(
      config.vars.PAGES_EDITOR,
      ["page4", "page5", "page6"].includes(target) ? "wordgard" : undefined,
    );
    assert.deepEqual(config.durable_objects.bindings, [
      { name: "PAGE_RECORDS", class_name: "PageRecords" },
    ]);
    assert.deepEqual(config.migrations, [{ tag: "fixture", new_sqlite_classes: ["PageRecords"] }]);
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
    for (const otherTarget of ["pages-next", "page3", "page4", "page5", "page6"].filter(
      (value) => value !== target,
    )) {
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

test("page3 installation rejects a pages-next manifest before running any host command", (t) => {
  const fixture = historicalInstallFixture(t, { target: "page3" });
  fixture.write(
    fixture.stage + "/manifest.json",
    JSON.stringify({ ...fixture.manifest, deployment: profiles.deploymentProfile().deployment }),
  );
  assert.throws(fixture.execute, /Unexpected deployment target/);
  assert.equal(fixture.calls.length, 0);
});

test("new page3 setup tolerates pages-next resources but rejects its own port or mark collisions", (t) => {
  const existing =
    "LISTEN 0 4096 127.0.0.1:9472 0.0.0.0:*\nLISTEN 0 4096 127.0.0.1:19472 0.0.0.0:*";
  const fixture = historicalInstallFixture(t, {
    target: "page3",
    fresh: true,
    listeners: existing,
    rules: '{"name":"nteract_pages_next","mark":536870912}',
  });
  fixture.execute();
  assert.equal(
    JSON.parse(fixture.read(fixture.configDir + "/ownership.json")).hostname,
    "page3.runtimed.run",
  );
  const prefixCheck = fixture.calls.find(({ command }) => command === "/usr/local/bin/aws");
  assert.equal(prefixCheck.args[prefixCheck.args.indexOf("--prefix") + 1], "standalone/page3/");
  for (const collision of [
    { listeners: existing + "\nLISTEN 0 4096 127.0.0.1:19473 0.0.0.0:*" },
    { rules: '{"mark":268435456}' },
  ]) {
    const rejected = historicalInstallFixture(t, { target: "page3", fresh: true, ...collision });
    assert.throws(rejected.execute, /port is occupied|firewall namespace or mark is occupied/);
    assert.equal(
      rejected.calls.some(({ command }) => command === "useradd"),
      false,
    );
  }
});

test("page4 is explicitly allowlisted and cannot accept either frozen target's stage or manifest", () => {
  assert.deepEqual(profiles.selectTarget(["--target", "page4", "plan"]), {
    target: "page4",
    args: ["plan"],
  });
  const page4 = profiles.deploymentProfile("page4");
  assert.equal(page4.deployment.hostname, "page4.runtimed.run");
  assert.equal(page4.deployment.listen, "127.0.0.1:9474");
  assert.equal(page4.deployment.internalListen, "127.0.0.1:19474");
  assert.equal(page4.deployment.prefix, "standalone/page4");
  assert.equal(page4.editor, "wordgard");
  assert.equal(page4.tunnelService, "cloudflared-page4.service");
  assert.throws(
    () =>
      insertRoutes(
        'tunnel: test\ningress:\n  - hostname: "*.runtimed.run"\n    service: http_status:404\n',
        "page4",
      ),
    /dedicated tunnel publisher/,
  );
  assert.equal(profiles.stageTarget("/tmp/nteract-page4-stage-abcd1234"), "page4");
  for (const other of ["pages-next", "page3"]) {
    assert.equal(profiles.stagePattern(other).test("/tmp/nteract-page4-stage-abcd1234"), false);
    assert.throws(() =>
      profiles.verifyDeployment(
        { source_sha: "a".repeat(40), deployment: profiles.deploymentProfile(other).deployment },
        "page4",
      ),
    );
    assert.throws(() =>
      profiles.verifyDeployment(
        { source_sha: "a".repeat(40), deployment: page4.deployment },
        other,
      ),
    );
  }
});

test("page4 firewall owns only the new table, mark and cgroup", () => {
  const rules = pagesFirewall(999, true, "page4");
  assert.match(rules, /^delete table inet nteract_page4\n/);
  assert.match(rules, /system.slice\/nteract-page4.service/);
  assert.match(rules, /0x08000000/);
  assert.doesNotMatch(rules, /pages.next|page3|0x10000000|0x20000000|0x40000000|0x80000000/);
});

test("page4 DNS creates only its independently owned hostname and rejects foreign ownership", async () => {
  const fixture = dnsFixture();
  const args = { token: "fixture", tunnelId, target: "page4", fetchImpl: fixture.fetchImpl };
  assert.equal((await configureDns(args)).present, false);
  assert.ok(
    fixture.calls.every(
      ({ url, method }) =>
        method === "GET" && !url.includes("pages-next") && !url.includes("page3"),
    ),
  );
  const created = await configureDns({ ...args, apply: true });
  assert.equal(created.name, "page4.runtimed.run");
  assert.equal(created.changed, true);
  assert.equal((await configureDns({ ...args, apply: true })).changed, false);
  for (const other of ["pages-next", "page3"]) {
    const foreign = dnsFixture([
      {
        id: "b".repeat(32),
        name: "page4.runtimed.run",
        type: "CNAME",
        content: `${tunnelId}.cfargotunnel.com`,
        proxied: true,
        ttl: 1,
        comment: "nteract/pages:experiment:" + other,
      },
    ]);
    await assert.rejects(
      configureDns({ ...args, apply: true, fetchImpl: foreign.fetchImpl }),
      /conflicts/,
    );
    assert.ok(foreign.calls.every(({ method }) => method === "GET"));
  }
});

for (const other of ["pages-next", "page3"])
  test(`page4 installation rejects ${other} manifest before running host commands`, (t) => {
    const fixture = historicalInstallFixture(t, { target: "page4" });
    fixture.write(
      fixture.stage + "/manifest.json",
      JSON.stringify({
        ...fixture.manifest,
        deployment: profiles.deploymentProfile(other).deployment,
      }),
    );
    assert.throws(fixture.execute, /Unexpected deployment target/);
    assert.equal(fixture.calls.length, 0);
  });

test("new page4 setup tolerates frozen namespaces but rejects its own ports, mark and table collisions", (t) => {
  const existing = [9472, 19472, 9473, 19473]
    .map((port) => `LISTEN 0 4096 127.0.0.1:${port} 0.0.0.0:*`)
    .join("\n");
  const fixture = historicalInstallFixture(t, {
    target: "page4",
    fresh: true,
    listeners: existing,
    rules:
      '[{"name":"nteract_pages_next","mark":536870912},{"name":"nteract_page3","mark":268435456}]',
  });
  fixture.execute();
  assert.equal(
    JSON.parse(fixture.read(fixture.configDir + "/ownership.json")).hostname,
    "page4.runtimed.run",
  );
  const prefixCheck = fixture.calls.find(({ command }) => command === "/usr/local/bin/aws");
  assert.equal(prefixCheck.args[prefixCheck.args.indexOf("--prefix") + 1], "standalone/page4/");
  for (const collision of [
    { listeners: existing + "\nLISTEN 0 4096 127.0.0.1:9474 0.0.0.0:*" },
    { listeners: existing + "\nLISTEN 0 4096 127.0.0.1:19474 0.0.0.0:*" },
    { rules: '{"mark":134217728}' },
    { rules: '{"table":"nteract_page4"}' },
  ]) {
    const rejected = historicalInstallFixture(t, { target: "page4", fresh: true, ...collision });
    assert.throws(rejected.execute, /port is occupied|firewall namespace or mark is occupied/);
    assert.equal(
      rejected.calls.some(({ command }) => command === "useradd"),
      false,
    );
  }
});

test("page5 is explicitly allowlisted and cannot accept any frozen target's stage or manifest", () => {
  assert.deepEqual(profiles.selectTarget(["--target", "page5", "plan"]), {
    target: "page5",
    args: ["plan"],
  });
  const page5 = profiles.deploymentProfile("page5");
  assert.equal(page5.deployment.hostname, "page5.runtimed.run");
  assert.equal(page5.deployment.listen, "127.0.0.1:9475");
  assert.equal(page5.deployment.internalListen, "127.0.0.1:19475");
  assert.equal(page5.deployment.prefix, "standalone/page5");
  assert.equal(page5.editor, "wordgard");
  assert.equal(page5.asyncPersistence, true);
  assert.deepEqual(page5.frozenTargets, ["pages-next", "page3", "page4"]);
  assert.equal(page5.tunnelService, "cloudflared-page5.service");
  assert.throws(
    () =>
      insertRoutes(
        'tunnel: test\ningress:\n  - hostname: "*.runtimed.run"\n    service: http_status:404\n',
        "page5",
      ),
    /dedicated tunnel publisher/,
  );
  assert.equal(profiles.stageTarget("/tmp/nteract-page5-stage-abcd1234"), "page5");
  for (const other of ["pages-next", "page3", "page4"]) {
    assert.equal(profiles.stagePattern(other).test("/tmp/nteract-page5-stage-abcd1234"), false);
    assert.throws(() =>
      profiles.verifyDeployment(
        { source_sha: "a".repeat(40), deployment: profiles.deploymentProfile(other).deployment },
        "page5",
      ),
    );
    assert.throws(() =>
      profiles.verifyDeployment(
        { source_sha: "a".repeat(40), deployment: page5.deployment },
        other,
      ),
    );
  }
});

test("page5 firewall owns only the new table, mark and cgroup", () => {
  const rules = pagesFirewall(999, true, "page5");
  assert.match(rules, /^delete table inet nteract_page5\n/);
  assert.match(rules, /system.slice\/nteract-page5.service/);
  assert.match(rules, /0x04000000/);
  assert.doesNotMatch(
    rules,
    /pages.next|page3|page4|0x08000000|0x10000000|0x20000000|0x40000000|0x80000000/,
  );
});

test("page5 DNS creates only its independently owned hostname and rejects foreign ownership", async () => {
  const fixture = dnsFixture();
  const args = { token: "fixture", tunnelId, target: "page5", fetchImpl: fixture.fetchImpl };
  assert.equal((await configureDns(args)).present, false);
  assert.ok(
    fixture.calls.every(
      ({ url, method }) =>
        method === "GET" &&
        !url.includes("pages-next") &&
        !url.includes("page3") &&
        !url.includes("page4"),
    ),
  );
  const created = await configureDns({ ...args, apply: true });
  assert.equal(created.name, "page5.runtimed.run");
  assert.equal(created.changed, true);
  assert.equal((await configureDns({ ...args, apply: true })).changed, false);
  for (const other of ["pages-next", "page3", "page4"]) {
    const foreign = dnsFixture([
      {
        id: "b".repeat(32),
        name: "page5.runtimed.run",
        type: "CNAME",
        content: `${tunnelId}.cfargotunnel.com`,
        proxied: true,
        ttl: 1,
        comment: "nteract/pages:experiment:" + other,
      },
    ]);
    await assert.rejects(
      configureDns({ ...args, apply: true, fetchImpl: foreign.fetchImpl }),
      /conflicts/,
    );
    assert.ok(foreign.calls.every(({ method }) => method === "GET"));
  }
});

for (const other of ["pages-next", "page3", "page4"])
  test(`page5 installation rejects ${other} manifest before running host commands`, (t) => {
    const fixture = historicalInstallFixture(t, { target: "page5" });
    fixture.write(
      fixture.stage + "/manifest.json",
      JSON.stringify({
        ...fixture.manifest,
        deployment: profiles.deploymentProfile(other).deployment,
      }),
    );
    assert.throws(fixture.execute, /Unexpected deployment target/);
    assert.equal(fixture.calls.length, 0);
  });

test("new page5 setup tolerates frozen namespaces but rejects its own ports, mark and table collisions", (t) => {
  const existing = [9472, 19472, 9473, 19473, 9474, 19474]
    .map((port) => `LISTEN 0 4096 127.0.0.1:${port} 0.0.0.0:*`)
    .join("\n");
  const fixture = historicalInstallFixture(t, {
    target: "page5",
    fresh: true,
    listeners: existing,
    rules:
      '[{"name":"nteract_pages_next","mark":536870912},{"name":"nteract_page3","mark":268435456},{"name":"nteract_page4","mark":134217728}]',
  });
  fixture.execute();
  assert.equal(
    JSON.parse(fixture.read(fixture.configDir + "/ownership.json")).hostname,
    "page5.runtimed.run",
  );
  const prefixCheck = fixture.calls.find(({ command }) => command === "/usr/local/bin/aws");
  assert.equal(prefixCheck.args[prefixCheck.args.indexOf("--prefix") + 1], "standalone/page5/");
  for (const collision of [
    { listeners: existing + "\nLISTEN 0 4096 127.0.0.1:9475 0.0.0.0:*" },
    { listeners: existing + "\nLISTEN 0 4096 127.0.0.1:19475 0.0.0.0:*" },
    { rules: '{"mark":67108864}' },
    { rules: '{"table":"nteract_page5"}' },
  ]) {
    const rejected = historicalInstallFixture(t, { target: "page5", fresh: true, ...collision });
    assert.throws(rejected.execute, /port is occupied|firewall namespace or mark is occupied/);
    assert.equal(
      rejected.calls.some(({ command }) => command === "useradd"),
      false,
    );
  }
});

test("page6 requires its own manifest and stage and freezes every prior deployment", () => {
  const target = "page6",
    profile = profiles.deploymentProfile(target);
  assert.deepEqual(profiles.selectTarget(["--target", target, "plan"]), { target, args: ["plan"] });
  assert.equal(profile.deployment.hostname, "page6.runtimed.run");
  assert.equal(profile.deployment.listen, "127.0.0.1:9476");
  assert.equal(profile.deployment.internalListen, "127.0.0.1:19476");
  assert.equal(profile.deployment.prefix, "standalone/page6");
  assert.equal(profile.editor, "wordgard");
  assert.equal(profile.asyncPersistence, true);
  assert.equal(profile.tunnelService, "cloudflared-page6.service");
  assert.deepEqual(profile.frozenTargets, ["pages-next", "page3", "page4", "page5"]);
  assert.equal(profiles.stageTarget("/tmp/nteract-page6-stage-abcd1234"), target);
  assert.throws(
    () =>
      insertRoutes(
        'tunnel: test\ningress:\n  - hostname: "*.runtimed.run"\n    service: http_status:404\n',
        target,
      ),
    /dedicated tunnel publisher/,
  );
  for (const other of profile.frozenTargets) {
    const previous = profiles.deploymentProfile(other);
    for (const key of ["hostname", "service", "prefix", "listen", "internalListen"])
      assert.notEqual(profile.deployment[key], previous.deployment[key], `${other}: ${key}`);
    for (const key of ["firewallTable", "firewallMark"])
      assert.notEqual(profile[key], previous[key], `${other}: ${key}`);
    assert.equal(profiles.stagePattern(other).test("/tmp/nteract-page6-stage-abcd1234"), false);
    assert.throws(() =>
      profiles.verifyDeployment(
        { source_sha: "a".repeat(40), deployment: previous.deployment },
        target,
      ),
    );
    assert.throws(() =>
      profiles.verifyDeployment(
        { source_sha: "a".repeat(40), deployment: profile.deployment },
        other,
      ),
    );
  }
});

test("page6 firewall and DNS cannot adopt any frozen namespace", async () => {
  const profile = profiles.deploymentProfile("page6");
  const rules = pagesFirewall(999, true, "page6");
  assert.match(rules, /^delete table inet nteract_page6\n/);
  assert.match(rules, /system.slice\/nteract-page6.service/);
  assert.match(rules, /0x02000000/);
  for (const target of profile.frozenTargets) {
    const frozen = profiles.deploymentProfile(target);
    assert.ok(!rules.includes(frozen.firewallTable));
    assert.ok(!rules.includes(frozen.firewallMark));
    assert.ok(!rules.includes(frozen.deployment.service));
  }
  const fixture = dnsFixture();
  const args = { token: "fixture", tunnelId, target: "page6", fetchImpl: fixture.fetchImpl };
  assert.equal((await configureDns(args)).present, false);
  assert.ok(fixture.calls.every(({ method }) => method === "GET"));
  assert.equal((await configureDns({ ...args, apply: true })).name, "page6.runtimed.run");
  assert.equal((await configureDns({ ...args, apply: true })).changed, false);
  for (const other of profile.frozenTargets) {
    const foreign = dnsFixture([
      {
        id: "b".repeat(32),
        name: "page6.runtimed.run",
        type: "CNAME",
        content: `${tunnelId}.cfargotunnel.com`,
        proxied: true,
        ttl: 1,
        comment: "nteract/pages:experiment:" + other,
      },
    ]);
    await assert.rejects(
      configureDns({ ...args, apply: true, fetchImpl: foreign.fetchImpl }),
      /conflicts/,
    );
    assert.ok(foreign.calls.every(({ method }) => method === "GET"));
  }
});

test("new page6 setup tolerates frozen resources but rejects its own ports and firewall collisions", (t) => {
  const target = "page6",
    profile = profiles.deploymentProfile(target);
  const frozen = profile.frozenTargets.map((name) => profiles.deploymentProfile(name));
  const existing = frozen
    .flatMap((p) => [p.deployment.listen, p.deployment.internalListen])
    .map((listen) => `LISTEN 0 4096 ${listen} 0.0.0.0:*`)
    .join("\n");
  const fixture = historicalInstallFixture(t, {
    target,
    fresh: true,
    listeners: existing,
    rules: JSON.stringify(
      frozen.map((p) => ({ name: p.firewallTable, mark: Number(p.firewallMark) })),
    ),
  });
  fixture.execute();
  assert.equal(
    JSON.parse(fixture.read(fixture.configDir + "/ownership.json")).hostname,
    "page6.runtimed.run",
  );
  const prefixCheck = fixture.calls.find(({ command }) => command === "/usr/local/bin/aws");
  assert.equal(prefixCheck.args[prefixCheck.args.indexOf("--prefix") + 1], "standalone/page6/");
  for (const collision of [
    { listeners: existing + "\nLISTEN 0 4096 127.0.0.1:9476 0.0.0.0:*" },
    { listeners: existing + "\nLISTEN 0 4096 127.0.0.1:19476 0.0.0.0:*" },
    { rules: '{"mark":33554432}' },
    { rules: '{"table":"nteract_page6"}' },
  ]) {
    const rejected = historicalInstallFixture(t, { target, fresh: true, ...collision });
    assert.throws(rejected.execute, /port is occupied|firewall namespace or mark is occupied/);
    assert.equal(
      rejected.calls.some(({ command }) => command === "useradd"),
      false,
    );
  }
  for (const other of profile.frozenTargets) {
    const rejected = historicalInstallFixture(t, { target });
    rejected.write(
      rejected.stage + "/manifest.json",
      JSON.stringify({
        ...rejected.manifest,
        deployment: profiles.deploymentProfile(other).deployment,
      }),
    );
    assert.throws(rejected.execute, /Unexpected deployment target/);
    assert.equal(rejected.calls.length, 0);
  }
});

const frozenBy = {
  page7: ["pages-next", "page3", "page4", "page5", "page6"],
  page8: ["pages-next", "page3", "page4", "page5", "page6", "page7"],
  page9: ["page7", "page8"],
  page10: ["page7", "page8", "page9"],
};
test("every deploy profile owns distinct hosts, ports, prefixes and firewall resources", () => {
  const targets = [
    "pages-next",
    "page3",
    "page4",
    "page5",
    "page6",
    "page7",
    "page8",
    "page9",
    "page10",
  ];
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
  }
});

for (const target of ["page7", "page8", "page9", "page10"])
  test(`${target} rejects frozen manifests, DNS ownership and occupied resources`, async (t) => {
    const profile = profiles.deploymentProfile(target);
    assert.deepEqual(profile.frozenTargets, frozenBy[target]);
    const stage = `/tmp/nteract-${target}-stage-abcd1234`;
    assert.equal(profiles.stageTarget(stage), target);
    for (const other of profile.frozenTargets) {
      const previous = profiles.deploymentProfile(other);
      for (const key of ["hostname", "service", "prefix", "listen", "internalListen"])
        assert.notEqual(profile.deployment[key], previous.deployment[key], `${other}: ${key}`);
      for (const key of ["firewallTable", "firewallMark", "tunnelService"])
        assert.notEqual(profile[key], previous[key], `${other}: ${key}`);
      assert.equal(profiles.stagePattern(other).test(stage), false);
      const rejected = historicalInstallFixture(t, { target });
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
      const rejected = historicalInstallFixture(t, { target, fresh: true, ...collision });
      assert.throws(rejected.execute, /port is occupied|firewall namespace or mark is occupied/);
      assert.equal(
        rejected.calls.some(({ command }) => command === "useradd"),
        false,
      );
    }
  });

test("compaction maintenance and company viewing are enabled for Page7 through Page10", (t) => {
  for (const target of ["page6", "page7", "page8", "page9", "page10"]) {
    const f = historicalInstallFixture(t, { target });
    f.execute();
    const config = JSON.parse(f.read(f.release + "/wrangler.json"));
    assert.equal(config.vars.PAGES_ASYNC_PERSISTENCE, "true");
    assert.equal(config.vars.PAGES_COMPACT_RECORDS, target !== "page6" ? "true" : undefined);
    assert.equal(
      config.vars.PAGES_COMPANY_VIEW_DOMAINS,
      target !== "page6" ? "anaconda.com" : undefined,
    );
    assert.equal(
      config.vars.PAGES_CATALOG_INDEX,
      ["page8", "page9", "page10"].includes(target) ? "1" : undefined,
    );
  }
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
  assert.equal(config.vars.PAGES_EDITOR, "wordgard");
  assert.equal(config.vars.PAGES_ASYNC_PERSISTENCE, "true");
  assert.equal(config.vars.PAGES_COMPACT_RECORDS, "true");
  assert.equal(config.vars.PAGES_COMPANY_VIEW_DOMAINS, "anaconda.com");
  assert.equal(config.vars.PAGES_CATALOG_INDEX, "1");
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
  // profiles, so frozen Page9 keeps the copy that qualified it.
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
  for (const frozen of profile.frozenTargets) {
    const prior = profiles.deploymentProfile(frozen).deployment;
    assert.equal(
      fs.existsSync(f.local("/etc/systemd/system/" + prior.service + ".service")),
      false,
    );
    assert.equal(fs.existsSync(f.local("/opt/" + prior.service)), false);
  }
});
