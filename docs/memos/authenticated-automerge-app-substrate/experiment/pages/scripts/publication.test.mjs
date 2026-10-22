import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  applyPublication,
  backupRoutes,
  insertRoutes,
  legacyRoutes,
  resumePublication,
  routes,
  routesFor,
} from "./deployment/publish.mjs";

const prefix =
  "tunnel: fixture\ningress:\n  - hostname: m.runtimed.run\n    service: http://127.0.0.1:9471\n";
const suffix =
  '  - hostname: "*.runtimed.run"\n    service: http://127.0.0.1:29999\n  - service: http_status:404\n';

test("publication upgrades exactly the deployed Pages stanza and preserves other bytes", () => {
  const before = prefix + legacyRoutes + suffix;
  const expected = prefix + routes + suffix;
  assert.equal(insertRoutes(before), expected);
  assert.equal(insertRoutes(expected), expected);
  assert.equal(insertRoutes(prefix + suffix), expected);
  assert.equal(insertRoutes(legacyRoutes), routes);
});

test("publication refuses altered, duplicate, or competing Pages rules", () => {
  for (const owned of [legacyRoutes, routes]) {
    for (const conflicting of [
      owned.replace("127.0.0.1:9472", "127.0.0.1:1234"),
      owned.replace("http_status:404", "http_status:403"),
      owned.replace("    path:", "    originRequest: {}\n    path:"),
      owned + "    originRequest: {}\n",
      owned + owned,
      owned + "# foreign pages-next.runtimed.run configuration\n",
      owned + "  - hostname: pages-next.runtimed.run\n    service: http://elsewhere\n",
      "#" + owned,
    ])
      assert.throws(() => insertRoutes(prefix + conflicting + suffix), /Conflicting/);
  }
  assert.throws(() => insertRoutes(prefix + legacyRoutes + routes + suffix), /Conflicting/);
});

test("published route pattern allows guide, canonical Pages, and registration without broadening private routes", () => {
  const pattern = new RegExp(/^    path: (.+)$/m.exec(routes)[1]);
  const page = "/p/12345678-1234-4123-8123-123456789abc";
  for (const pathname of [
    "/",
    "/index.html",
    "/app.js",
    "/app.css",
    "/automerge.wasm",
    "/subduction.wasm",
    "/health",
    "/mcp",
    "/api/tools",
    "/api/connect",
    "/api/sync",
    "/api/saved",
    "/api/auth/login",
    "/api/auth/logout",
    "/api/auth/session",
    "/oidc",
    "/llms.txt",
    page,
    page + "/",
    "/api/pages/register",
  ])
    assert.equal(pattern.test(pathname), true, pathname);
  for (const pathname of [
    "/state",
    "/internal/create",
    "/internal/register",
    "/dev/oidc/authorize",
    "/api/pages",
    "/api/pages/register/extra",
    "/api/other",
    "/api/auth/other",
    "/llms.txt/extra",
    "/llmsXtxt",
    "/p/not-a-page",
    page + "/private",
    page + "x",
    page.replace("-4123-", "-5123-"),
    page.replace("-8123-", "-7123-"),
  ])
    assert.equal(pattern.test(pathname), false, pathname);
});

function backupFixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), "pages-publication-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("publication preserves old backups and safely retries its own exact backup", (t) => {
  const directory = backupFixture(t);
  const old = path.join(directory, "cloudflared.before.yml");
  writeFileSync(old, "original publication");
  const before = prefix + legacyRoutes + suffix;
  const backup = backupRoutes(before, "a".repeat(40), directory);
  assert.equal(readFileSync(backup, "utf8"), before);
  assert.equal(statSync(backup).mode & 0o777, 0o600);
  assert.equal(backupRoutes(before, "a".repeat(40), directory), backup);
  assert.equal(readFileSync(old, "utf8"), "original publication");
  assert.notEqual(backupRoutes(before, "b".repeat(40), directory), backup);
  assert.notEqual(backupRoutes(before + "# next snapshot\n", "a".repeat(40), directory), backup);
});

test("publication backup refuses unsafe source IDs and changed existing snapshots", (t) => {
  const directory = backupFixture(t);
  for (const source of [undefined, "", "../other", "A".repeat(40)])
    assert.throws(() => backupRoutes("before", source, directory), /Invalid prepared source/);
  const backup = backupRoutes("before", "a".repeat(40), directory);
  writeFileSync(backup, "changed");
  assert.throws(() => backupRoutes("before", "a".repeat(40), directory), /backup differs/);
  assert.equal(readFileSync(backup, "utf8"), "changed");
});

test("publication backup never follows an existing symlink", (t) => {
  const directory = backupFixture(t);
  const backup = backupRoutes("before", "a".repeat(40), directory);
  const target = path.join(directory, "unrelated.yml");
  writeFileSync(target, "before");
  rmSync(backup);
  symlinkSync(target, backup);
  assert.throws(() => backupRoutes("before", "a".repeat(40), directory), /backup differs/);
  assert.equal(readFileSync(target, "utf8"), "before");
});

function publicationFixture(t) {
  const directory = backupFixture(t);
  const fixture = {
    directory,
    config: path.join(directory, "config.yml"),
    candidate: path.join(directory, "candidate.yml"),
    sourceSha: "a".repeat(40),
    before: prefix + legacyRoutes + suffix,
    updated: prefix + routes + suffix,
  };
  writeFileSync(fixture.config, fixture.before);
  writeFileSync(fixture.candidate, fixture.updated);
  return { ...fixture, pending: path.join(directory, "cloudflared.pending.json") };
}

function interruptAfterRename(fixture) {
  const helper = new URL("./deployment/publish.mjs", import.meta.url).href;
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { applyPublication } from ${JSON.stringify(helper)};
     applyPublication({ ...${JSON.stringify(fixture)}, restart: () => process.exit(73) });`,
    ],
    { encoding: "utf8" },
  );
  assert.equal(child.status, 73, child.stderr);
  assert.equal(readFileSync(fixture.config, "utf8"), fixture.updated);
  assert.equal(existsSync(fixture.pending), true);
}

test("publication records reload before switching config and clears it only after active restart", (t) => {
  const fixture = publicationFixture(t);
  let restarts = 0;
  applyPublication({
    ...fixture,
    restart: () => {
      restarts++;
      assert.equal(existsSync(fixture.pending), true);
      assert.equal(readFileSync(fixture.config, "utf8"), fixture.updated);
      return "active";
    },
  });
  assert.equal(restarts, 1);
  assert.equal(existsSync(fixture.pending), false);
  assert.equal(
    resumePublication({
      ...fixture,
      restart: () => {
        restarts++;
        return "active";
      },
    }),
    false,
  );
  assert.equal(insertRoutes(readFileSync(fixture.config, "utf8")), fixture.updated);
  assert.equal(restarts, 1, "ordinary unchanged rerun does not restart the shared tunnel");
});

test("publication resumes an actual process interruption after rename instead of claiming unchanged success", (t) => {
  const fixture = publicationFixture(t);
  interruptAfterRename(fixture);
  let restarts = 0;
  assert.equal(
    resumePublication({
      ...fixture,
      restart: () => {
        restarts++;
        return "active";
      },
    }),
    true,
  );
  assert.equal(restarts, 1);
  assert.equal(existsSync(fixture.pending), false);
});

test("publication resumes before-rename state by revalidating the same candidate", (t) => {
  const fixture = publicationFixture(t);
  interruptAfterRename(fixture);
  writeFileSync(fixture.config, fixture.before);
  writeFileSync(fixture.candidate, fixture.updated);
  assert.equal(
    resumePublication({ ...fixture, restart: () => assert.fail("not yet renamed") }),
    false,
  );
  assert.equal(existsSync(fixture.pending), false);
  assert.equal(existsSync(fixture.candidate), false);
  assert.equal(insertRoutes(readFileSync(fixture.config, "utf8")), fixture.updated);
});

test("publication rollback clears receipt only after restoring active old configuration", (t) => {
  const fixture = publicationFixture(t);
  let restarts = 0;
  assert.throws(
    () =>
      applyPublication({
        ...fixture,
        restart: () => {
          restarts++;
          if (restarts === 1) return "failed";
          assert.equal(readFileSync(fixture.config, "utf8"), fixture.before);
          assert.equal(existsSync(fixture.pending), true);
          return "active";
        },
      }),
    /not active/,
  );
  assert.equal(restarts, 2);
  assert.equal(existsSync(fixture.pending), false);
});

test("failed rollback retains pending receipt for a later validated retry", (t) => {
  const fixture = publicationFixture(t);
  assert.throws(
    () =>
      applyPublication({
        ...fixture,
        restart: () => {
          throw Error("restart failed");
        },
      }),
    /restart failed/,
  );
  assert.equal(existsSync(fixture.pending), true);
  assert.equal(readFileSync(fixture.config, "utf8"), fixture.before);
  assert.equal(
    resumePublication({ ...fixture, restart: () => assert.fail("not yet renamed") }),
    false,
  );
  writeFileSync(fixture.candidate, fixture.updated);
  applyPublication({ ...fixture, restart: () => "active" });
  assert.equal(readFileSync(fixture.config, "utf8"), fixture.updated);
  assert.equal(existsSync(fixture.pending), false);
});

test("pending reload refuses changed configuration and other prepared sources", (t) => {
  const fixture = publicationFixture(t);
  interruptAfterRename(fixture);
  const restart = () => assert.fail("must not reload conflicting configuration");
  assert.throws(
    () => resumePublication({ ...fixture, sourceSha: "b".repeat(40), restart }),
    /Conflicting pending/,
  );
  writeFileSync(fixture.config, "foreign configuration");
  assert.throws(() => resumePublication({ ...fixture, restart }), /Concurrent tunnel update/);
  assert.equal(readFileSync(fixture.config, "utf8"), "foreign configuration");
  assert.equal(existsSync(fixture.pending), true);
});

test("pending reload keeps its receipt if restart is inactive or configuration changes during restart", (t) => {
  const fixture = publicationFixture(t);
  interruptAfterRename(fixture);
  assert.throws(() => resumePublication({ ...fixture, restart: () => "inactive" }), /not active/);
  assert.equal(existsSync(fixture.pending), true);
  assert.throws(
    () =>
      resumePublication({
        ...fixture,
        restart: () => {
          writeFileSync(fixture.config, "concurrent configuration");
          return "active";
        },
      }),
    /Concurrent tunnel update/,
  );
  assert.equal(existsSync(fixture.pending), true);
});

test("page3 publication coexists with pages-next and migrates only its own routes", () => {
  const original = prefix + routes + suffix;
  const updated = insertRoutes(original, "page3");
  assert.equal(updated, prefix + routes + routesFor("page3") + suffix);
  assert.equal(insertRoutes(updated, "page3"), updated);
  assert.equal(insertRoutes(updated), updated);
  assert.equal(
    insertRoutes(prefix + routesFor("page3") + suffix),
    prefix + routesFor("page3") + routes + suffix,
  );
  assert.equal(insertRoutes(prefix + routes + routesFor("page3", true) + suffix, "page3"), updated);
  assert.throws(
    () => insertRoutes(updated + "# foreign page3.runtimed.run rules", "page3"),
    /Conflicting/,
  );
  const pattern = new RegExp(/^    path: (.+)$/m.exec(routesFor("page3"))[1]);
  assert.equal(pattern.test("/mcp"), true);
  assert.equal(pattern.test("/api/sync"), true);
  assert.equal(pattern.test("/oidc"), true);
  assert.equal(pattern.test("/state"), false);
  assert.equal(pattern.test("/internal/create"), false);
});

test("interrupted page3 publication resumes without changing pages-next routes", (t) => {
  const fixture = publicationFixture(t);
  fixture.target = "page3";
  fixture.before = prefix + routes + suffix;
  fixture.updated = insertRoutes(fixture.before, fixture.target);
  writeFileSync(fixture.config, fixture.before);
  writeFileSync(fixture.candidate, fixture.updated);
  interruptAfterRename(fixture);
  let restarts = 0;
  assert.equal(
    resumePublication({
      ...fixture,
      restart: () => {
        restarts++;
        return "active";
      },
    }),
    true,
  );
  assert.equal(restarts, 1);
  assert.equal(readFileSync(fixture.config, "utf8"), fixture.updated);
  assert.equal(
    readFileSync(fixture.config, "utf8").replace(routesFor("page3"), ""),
    fixture.before,
  );
  assert.equal(existsSync(fixture.pending), false);
});
