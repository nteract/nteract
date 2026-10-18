import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { sourceFingerprint } from "./source-fingerprint.mjs";
import { insertRoutes, routes } from "./deployment/publish.mjs";
import { configureDns } from "./deployment/dns.mjs";
import { pagesFirewall } from "./deployment/firewall.mjs";

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
  try {
    for (const artifact of releaseArtifacts) write(artifact, "artifact:" + artifact);
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
    assert.deepEqual(files(destination).sort(), [...releaseArtifacts].sort());
    for (const artifact of releaseArtifacts)
      assert.equal(readFileSync(path.join(destination, artifact), "utf8"), "artifact:" + artifact);
    rmSync(path.join(dist, "index.js"));
    symlinkSync(path.join(dist, ".dev.vars"), path.join(dist, "index.js"));
    assert.throws(() => stageArtifacts(dist, path.join(root, "rejected")), /regular file/);
    assert.throws(() => readdirSync(path.join(root, "rejected")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
