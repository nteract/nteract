// Rollback qualification on local celld with one persistent data directory.
// The previous build (one that still calls Projects Spaces, such as 3548b9750)
// writes a Space first, as a deployment upgrading from it holds. This build
// refuses that location shape (503 location_migration_required) until the owner
// runs the one-shot content migration, and a dry run writes nothing; the
// previous build then serves the same data again, updates the Space and writes
// another Space; then this build applies the migration over everything, checks
// a second apply is a no-op, and serves both as Projects whose content is
// addressed by project_id. Rolling back after apply is not qualified: it is
// unsupported (DEPLOYMENT.md). The previous build must already be built:
//   node scripts/rollback-qualification.mjs --target <target> --previous <previous pages dir>
// The target names the deployment the rollback is for. A previous build that
// can't open every Page record storage the target may hold is refused before
// anything starts, and the fixture creates Pages with the target's
// recordStorage, so the phases cover the storage the target writes.
// No pre-existing server, provider account or credentials; MCP calls use the
// synthetic fixture API keys.
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { build } from "esbuild";
import {
  CELLD_RELEASE,
  assertReleaseOpensTargetPages,
  deploymentProfile,
  parseRuntimeVersion,
} from "./deployment/profiles.mjs";
import { publicShellAssetDefine } from "./viewer-chunks.mjs";
import { fixtureWhoamiUrl, generateFixtureKeys } from "./fixtures/local-api-keys.mjs";

const current = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const option = (name) => {
  const flag = process.argv.indexOf(name);
  return flag < 0 ? undefined : process.argv[flag + 1];
};
const target = option("--target");
if (!target || !option("--previous"))
  throw new Error("Pass --target <deployment target> --previous <pages dir>");
const profile = deploymentProfile(target);
const previous = path.resolve(option("--previous"));
const receiptOf = async (app) =>
  JSON.parse(await readFile(path.join(app, "dist/build-receipt.json"), "utf8"));
// Both builds serve the target's data in turn, so both must open its Pages.
assertReleaseOpensTargetPages(target, await receiptOf(previous));
assertReleaseOpensTargetPages(target, await receiptOf(current));
const output = path.resolve(
  process.env.PAGES_E2E_OUTPUT || path.join(current, "test-results", `rollback-${Date.now()}`),
);
await mkdir(output, { recursive: true });
const celld = process.env.CELLD_BIN || "celld";
const hostEnv = Object.fromEntries(
  ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "SYSTEMROOT"]
    .filter((key) => process.env[key] !== undefined)
    .map((key) => [key, process.env[key]]),
);
const version = parseRuntimeVersion(
  execFileSync(celld, ["--version"], { encoding: "utf8", timeout: 5000, env: hostEnv }),
);
if (version !== CELLD_RELEASE.version)
  throw new Error(`Rollback qualification requires ${CELLD_RELEASE.version}; found ${version}`);

const scratch = await mkdtemp(path.join(tmpdir(), "pages-rollback-"));
const runtime = path.join(scratch, "runtime");
await mkdir(runtime);
const server = createServer();
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
await new Promise((resolve) => server.close(resolve));
const origin = `http://localhost:${port}`;
const { keys, responses } = generateFixtureKeys();
const log = createWriteStream(path.join(output, "celld.log"));
const report = { origin, celld: version, target, previous, phases: [] };
let host;

/** Replace the deployed build in `runtime`, keeping celld state and vars. */
async function install(app) {
  for (const name of ["public", "automerge.wasm", "subduction.wasm", "wrangler.json", "index.js"])
    await rm(path.join(runtime, name), { recursive: true, force: true });
  for (const name of ["public", "automerge.wasm", "subduction.wasm", "wrangler.json"])
    await cp(path.join(app, "dist", name), path.join(runtime, name), { recursive: true });
  const receipt = JSON.parse(await readFile(path.join(app, "dist/build-receipt.json"), "utf8"));
  const { celldCborPlugin } = await import(pathToFileURL(path.join(app, "scripts/celld-cbor.mjs")));
  await build({
    entryPoints: [path.join(app, "scripts/fixtures/local-sharing-worker.mjs")],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    conditions: ["workerd"],
    tsconfig: path.join(app, "tsconfig.json"),
    external: ["node:*"],
    outfile: path.join(runtime, "index.js"),
    define: {
      PAGES_E2E_ORIGIN: JSON.stringify(origin),
      PAGES_E2E_RESPONSES: JSON.stringify(responses),
      __PAGES_BUILD__: JSON.stringify(receipt.build_id),
      ...publicShellAssetDefine(path.join(runtime, "public")),
    },
    logLevel: "warning",
    plugins: [
      celldCborPlugin(),
      {
        name: "compiled-wasm",
        setup(b) {
          b.onResolve({ filter: /\.wasm$/ }, async (args) => {
            const absolute = path.resolve(args.resolveDir, args.path);
            const name = absolute.includes("subduction") ? "subduction.wasm" : "automerge.wasm";
            await copyFile(absolute, path.join(runtime, name));
            return { path: `./${name}`, external: true };
          });
        },
      },
    ],
  });
  const config = JSON.parse(await readFile(path.join(runtime, "wrangler.json"), "utf8"));
  return {
    build_id: receipt.build_id,
    durable_objects: config.durable_objects.bindings.map((binding) => binding.class_name),
    migrations: config.migrations.map((migration) => migration.tag),
  };
}

async function boot() {
  host = spawn(
    celld,
    ["dev", runtime, "--host", "127.0.0.1", "--port", String(port), "--no-watch", "--logs"],
    { cwd: scratch, env: hostEnv, stdio: ["ignore", "pipe", "pipe"] },
  );
  host.stdout.pipe(log, { end: false });
  host.stderr.pipe(log, { end: false });
  const deadline = Date.now() + 60000;
  for (;;) {
    if (host.exitCode !== null || host.signalCode)
      throw new Error(`celld exited (${host.exitCode ?? host.signalCode}); see celld.log`);
    try {
      const response = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch {
      /* starting */
    }
    if (Date.now() >= deadline) throw new Error("celld did not become ready; see celld.log");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
async function stop() {
  if (!host || host.exitCode !== null || host.signalCode) return;
  host.kill("SIGTERM");
  const timeout = setTimeout(() => host.kill("SIGKILL"), 5000);
  await new Promise((resolve) => host.once("exit", resolve));
  clearTimeout(timeout);
  for (const deadline = Date.now() + 30000; ; ) {
    const probe = createServer();
    const free = await new Promise((resolve) => {
      probe.once("error", () => resolve(false));
      probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
    });
    if (free) return;
    if (Date.now() >= deadline) throw new Error("port stayed busy after stopping celld");
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
async function call(operation, args = {}) {
  const response = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${keys.owner}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "X-Pages-Driver": "Rollback qualification",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "tools/call",
      params: { name: operation, arguments: args },
    }),
    signal: AbortSignal.timeout(30000),
  });
  assert.equal(response.status, 200, operation);
  const result = (await response.json()).result;
  return { isError: result.isError === true, body: JSON.parse(result.content[0].text) };
}
async function mcp(operation, args = {}) {
  const { isError, body } = await call(operation, args);
  assert.equal(isError, false, `${operation}: ${JSON.stringify(body)}`);
  return body;
}
const key = () => crypto.randomUUID();
const ids = (listing) => listing.pages.map((page) => page.page_id);

try {
  await writeFile(
    path.join(runtime, ".dev.vars"),
    Object.entries({
      PAGES_E2E_ONLY: "true",
      PAGES_EDITOR: "wordgard",
      PAGES_ASYNC_PERSISTENCE: "true",
      PAGES_COMPACT_RECORDS: "true",
      PAGES_CATALOG_INDEX: "1",
      ...(profile.recordStorage && { PAGES_RECORD_STORAGE: profile.recordStorage }),
      NOTEBOOK_CLOUD_APP_SESSION_SECRET: randomBytes(32).toString("hex"),
      NOTEBOOK_CLOUD_LOCAL_OIDC: "true",
      NOTEBOOK_CLOUD_OIDC_FLOW: "server",
      NOTEBOOK_CLOUD_PUBLIC_ORIGIN: origin,
      NOTEBOOK_CLOUD_OIDC_ISSUER: `${origin}/dev/oidc`,
      NOTEBOOK_CLOUD_OIDC_CLIENT_ID: "pages-e2e",
      NOTEBOOK_CLOUD_OIDC_AUDIENCE: "pages-e2e",
      NOTEBOOK_CLOUD_OIDC_PRINCIPAL_NAMESPACE: "pages-e2e",
      NOTEBOOK_CLOUD_ANACONDA_API_KEY_PRINCIPAL_NAMESPACE: "pages-e2e",
      NOTEBOOK_CLOUD_ANACONDA_API_KEY_USERINFO_URL: fixtureWhoamiUrl,
    })
      .map(([name, value]) => `${name}=${value}`)
      .join("\n") + "\n",
    { mode: 0o600 },
  );

  // The owner-run, one-shot content migration. Its route and codes name the
  // field it removes; no other part of this build reads that field.
  const MIGRATION_ROUTE = "/api/admin/home-removal";
  const MIGRATION_REASON = "home_removal_required";
  async function migration(mode) {
    const response = await fetch(`${origin}${MIGRATION_ROUTE}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${keys.owner}`,
        "Content-Type": "application/json",
        "X-Pages-Driver": "Rollback qualification",
      },
      body: JSON.stringify({ mode }),
      signal: AbortSignal.timeout(60000),
    });
    const body = await response.json();
    assert.equal(response.status, 200, `${mode}: ${JSON.stringify(body)}`);
    assert.equal(body.mode, mode);
    return body;
  }
  /** Location reads and writes on a Catalog this build has not migrated fail
   * closed: nothing is served from, or written into, the previous shape. */
  async function assertFailsClosed(label) {
    for (const [operation, args] of [
      ["list_projects", {}],
      ["get_project", { project_id: seeded.space_id }],
      ["list_pages", { project_id: seeded.space_id }],
      ["read_page", { project_id: seeded.space_id, comments: "none" }],
      ["create_page", { title: "Refused", project_id: seeded.space_id, idempotency_key: key() }],
    ]) {
      const refused = await call(operation, args);
      assert.equal(refused.isError, true, `${label}: ${operation} must fail closed`);
      assert.equal(refused.body.code, "location_migration_required", `${label}: ${operation}`);
      assert.equal(refused.body.details?.reason ?? refused.body.reason, MIGRATION_REASON);
      assert.equal(refused.body.retryable, true, `${label}: ${operation}`);
    }
  }

  // 0. The previous build writes a Space with a Page, in the previous location
  // shape, so the D1 index holds Space rows and the Catalog the old shape
  // before this build first runs.
  const seeder = await install(previous);
  await boot();
  const seeded = await mcp("create_space", { title: "Existing Space", idempotency_key: key() });
  // The previous build's name for the Space's content document. This build
  // reports it as document_id once migrated, and never reads the old field.
  const seededContent = seeded.home_page_id;
  assert.match(seededContent, /^[0-9a-f-]{36}$/);
  const seededPage = await mcp("create_page", {
    title: "Existing Page",
    space_id: seeded.space_id,
    idempotency_key: key(),
  });
  assert.equal((await mcp("list_spaces")).spaces.length, 1);
  assert.equal(ids(await mcp("list_pages", { space_id: seeded.space_id })).length, 2);
  report.phases.push({ build: "previous", ...seeder, wrote: { seeded, seededPage } });
  await stop();

  // 1. This build serves the old shape by refusing it: every location read and
  // write answers 503 location_migration_required until the owner migrates.
  // A dry run reports the plan and writes nothing, so the refusal holds and a
  // rollback is still safe.
  const writer = await install(current);
  await boot();
  await assertFailsClosed("before dry run");
  const dryRun = await migration("dry_run");
  assert.deepEqual(
    dryRun.projects.map((entry) => [entry.project_id, entry.document_id, entry.content_found]),
    [[seeded.space_id, seededContent, true]],
  );
  assert.deepEqual(dryRun.blockers, []);
  assert.ok(dryRun.writes > 0, "a dry run plans writes");
  await assertFailsClosed("after dry run");
  // Pages outside any Project are unaffected by the pending migration.
  const loose = await mcp("create_page", { title: "Loose Page", idempotency_key: key() });
  assert.equal(loose.project_id, undefined);
  report.phases.push({
    build: "current",
    ...writer,
    fail_closed: "location_migration_required",
    dry_run: dryRun,
    wrote: { loose },
  });
  await stop();

  // 2. Rollback before apply: the previous build serves its own data untouched,
  // updates the Space, and writes another Space with nested Pages. Nothing this
  // build did changed the stored shape.
  const reader = await install(previous);
  await boot();
  const seenSpace = await mcp("get_space", { space_id: seeded.space_id });
  assert.equal(seenSpace.title, "Existing Space");
  assert.equal(seenSpace.revision, 0);
  const oldUpdate = await mcp("update_space", {
    space_id: seeded.space_id,
    title: "Updated by the previous build",
    expected_revision: 0,
    idempotency_key: key(),
  });
  assert.equal(oldUpdate.revision, 1);
  assert.ok(ids(await mcp("list_pages")).includes(loose.page_id), "the loose Page is listed");
  const space = await mcp("create_space", { title: "Rollback Space", idempotency_key: key() });
  assert.match(space.space_id, /^sp_/);
  const spaceContent = space.home_page_id;
  const brief = await mcp("create_page", {
    title: "Brief",
    markdown: "Written by the previous build in its Space.",
    space_id: space.space_id,
    idempotency_key: key(),
  });
  const detail = await mcp("create_page", {
    title: "Detail",
    markdown: "Nested by the previous build.",
    parent_id: brief.page_id,
    idempotency_key: key(),
  });
  const trashWith = async (pageId) =>
    mcp("delete_page", {
      page_id: pageId,
      base_heads: (await mcp("read_page", { page_id: pageId, include_content: false })).heads,
      idempotency_key: key(),
    });
  const trashedDetail = await trashWith(detail.page_id);
  const oldSpaces = await mcp("list_spaces");
  assert.deepEqual(
    oldSpaces.spaces.map((entry) => entry.space_id).sort(),
    [seeded.space_id, space.space_id].sort(),
  );
  report.phases.push({
    build: "previous",
    ...reader,
    space_update: { wrote: oldUpdate.title, revision: oldUpdate.revision },
    listed_spaces: oldSpaces.spaces.map((entry) => entry.space_id),
    trashed_detail: trashedDetail.state,
    wrote: { space, brief, detail },
  });
  await stop();

  // 3. Roll forward and migrate. The refusal still holds for everything the
  // previous build wrote in between; apply converts all of it, a second apply
  // writes nothing, and this build then serves Projects whose content is
  // addressed by project_id and named by document_id.
  const again = await install(current);
  await boot();
  await assertFailsClosed("after rollback");
  const applied = await migration("apply");
  assert.equal(applied.shape, "migrated");
  assert.deepEqual(applied.blockers, []);
  assert.deepEqual(
    applied.projects
      .map((entry) => [entry.project_id, entry.document_id, entry.content_found])
      .sort(),
    [
      [seeded.space_id, seededContent, true],
      [space.space_id, spaceContent, true],
    ].sort(),
  );
  const trashedMoved = applied.projects.find((entry) => entry.project_id === space.space_id);
  assert.equal(trashedMoved.reparented, 1, "Brief moves to the top level");
  assert.equal(trashedMoved.reparented_trashed, 0, "Detail stays under Brief");
  const reapplied = await migration("apply");
  assert.equal(reapplied.writes, 0, "a second apply has nothing left to do");
  assert.equal(reapplied.shape, "migrated");

  const projects = await mcp("list_projects");
  assert.deepEqual(
    projects.projects.map((entry) => [entry.project_id, entry.document_id]).sort(),
    [
      [seeded.space_id, seededContent],
      [space.space_id, spaceContent],
    ].sort(),
  );
  for (const entry of projects.projects) {
    assert.equal(entry.role, "owner");
    assert.match(entry.url, new RegExp(`/project/${entry.project_id}$`));
    assert.doesNotMatch(JSON.stringify(entry), /home/i);
  }
  // The previous build's update survived, and the next one applies.
  const bothUpdates = await mcp("get_project", { project_id: seeded.space_id });
  assert.equal(bothUpdates.document_id, seededContent);
  assert.equal(bothUpdates.title, "Updated by the previous build");
  assert.equal(bothUpdates.revision, 1);
  assert.equal(bothUpdates.org, null);
  const nextUpdate = await mcp("update_project", {
    project_id: seeded.space_id,
    description: "Updated again by this build",
    expected_revision: 1,
    idempotency_key: key(),
  });
  assert.equal(nextUpdate.revision, 2);
  // The content document is the Project's, not a listed Page; its former
  // children are top-level Pages with parent_id null.
  const fromSeeded = await mcp("list_pages", { project_id: seeded.space_id });
  assert.deepEqual(ids(fromSeeded), [seededPage.page_id]);
  assert.equal(fromSeeded.pages[0].parent_id, null);
  assert.equal(fromSeeded.pages[0].project_id, seeded.space_id);
  const fromSpace = await mcp("list_pages", { project_id: space.space_id });
  assert.deepEqual(ids(fromSpace), [brief.page_id]);
  assert.equal(fromSpace.pages[0].parent_id, null);
  const inTrash = await mcp("list_pages", { in_trash: true });
  assert.ok(ids(inTrash).includes(detail.page_id), "the trashed child is still in Trash");
  // Content reads and edits go through project_id and keep one history.
  const content = await mcp("read_page", { project_id: space.space_id, comments: "none" });
  assert.equal(content.kind, "project");
  assert.equal(content.project_id, space.space_id);
  assert.equal(content.page_id, spaceContent);
  assert.equal(content.title, "Rollback Space");
  assert.deepEqual(
    content.breadcrumbs.map((crumb) => [crumb.kind, crumb.project_id]),
    [["project", space.space_id]],
  );
  const contentEdit = await mcp("edit_page", {
    project_id: space.space_id,
    base_heads: content.heads,
    retry_token: content.retry_token,
    idempotency_key: content.retry_key_prefix + key(),
    operations: [{ op: "insert_markdown", markdown: "Written after the migration." }],
  });
  const legacyAddressed = await mcp("read_page", { page_id: spaceContent, comments: "none" });
  assert.deepEqual(legacyAddressed.heads, contentEdit.heads, "document_id reads the same history");
  assert.equal(legacyAddressed.kind, "project");
  const both = await call("read_page", { page_id: spaceContent, project_id: space.space_id });
  assert.equal(both.isError, true);
  assert.equal(both.body.code, "invalid_arguments");
  // The content document is not in the tree.
  for (const [operation, args] of [
    ["delete_page", { page_id: spaceContent, idempotency_key: key() }],
    [
      "move_page",
      {
        page_id: spaceContent,
        project_id: seeded.space_id,
        idempotency_key: fromSeeded.retry_key_prefix + key(),
        retry_token: fromSeeded.retry_token,
      },
    ],
  ]) {
    const refused = await call(operation, args);
    assert.equal(refused.isError, true, operation);
    assert.equal(refused.body.code, "project_content_protected", operation);
  }
  // New Projects and Pages take the migrated shape directly.
  const project = await mcp("create_project", {
    title: "Rollback Project",
    idempotency_key: key(),
  });
  assert.match(project.project_id, /^prj_/);
  assert.match(project.document_id, /^[0-9a-f-]{36}$/);
  assert.doesNotMatch(JSON.stringify(project), /home/i, "no retired field on a new Project");
  const roadmap = await mcp("create_page", {
    title: "Roadmap",
    markdown: "Written by this build.",
    project_id: project.project_id,
    idempotency_key: key(),
  });
  assert.equal(roadmap.parent_id, null);
  const plan = await mcp("create_page", {
    title: "Plan",
    markdown: "Child written by this build.",
    parent_id: roadmap.page_id,
    idempotency_key: key(),
  });
  const inProject = await mcp("list_pages", { project_id: project.project_id });
  assert.deepEqual(ids(inProject).sort(), [roadmap.page_id, plan.page_id].sort());
  const planRead = await mcp("read_page", { page_id: plan.page_id, comments: "none" });
  assert.equal(planRead.kind, "page");
  assert.deepEqual(
    planRead.breadcrumbs.map((crumb) => crumb.title),
    ["Rollback Project", "Roadmap"],
  );
  // The child the previous build trashed restores under its parent, which is
  // now a top-level Page.
  const authority = await mcp("list_pages");
  const restoredDetail = await mcp("restore_page", {
    page_id: detail.page_id,
    retry_token: authority.retry_token,
    idempotency_key: authority.retry_key_prefix + key(),
  });
  assert.equal(restoredDetail.parent_id, brief.page_id);
  assert.equal(restoredDetail.project_id, space.space_id);
  const detailRead = await mcp("read_page", { page_id: detail.page_id, comments: "none" });
  assert.deepEqual(
    detailRead.breadcrumbs.map((crumb) => crumb.title),
    ["Rollback Space", "Brief"],
  );
  // Parent protection holds for both Projects.
  for (const parent of [roadmap.page_id, brief.page_id]) {
    const leaf = await call("delete_page", {
      page_id: parent,
      base_heads: (await mcp("read_page", { page_id: parent, include_content: false })).heads,
      idempotency_key: key(),
    });
    assert.equal(leaf.isError, true);
    assert.equal(leaf.body.code, "page_has_children");
  }
  report.phases.push({
    build: "current",
    ...again,
    fail_closed_after_rollback: "location_migration_required",
    applied,
    reapplied_writes: reapplied.writes,
    projects: projects.projects.map((entry) => entry.project_id),
    pages_in_migrated_space: fromSpace.pages.length,
    content_read: { kind: content.kind, page_id: content.page_id },
    breadcrumbs: planRead.breadcrumbs.map((crumb) => crumb.title),
    restored_child_parent: restoredDetail.parent_id,
    seeded_after_both_updates: { title: bothUpdates.title, revision: bothUpdates.revision },
  });
  await stop();
  // Not exercised, by design: booting the previous build over a migrated
  // Catalog. Its location pass would misplace the reparented Pages, so a
  // rollback after apply is unsupported; see DEPLOYMENT.md.
  report.rollback_after_apply = "unsupported";
  report.passed = true;
  console.log(`Rollback qualification passed. Artifacts: ${output}`);
} catch (error) {
  report.failure = error.stack || error.message;
  throw error;
} finally {
  await stop().catch(() => {});
  await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  await new Promise((resolve) => log.end(resolve));
  await rm(scratch, { recursive: true, force: true });
}
