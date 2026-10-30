// Rollback qualification on local celld with one persistent data directory.
// The previous build (one that still calls Projects Spaces, such as 3548b9750)
// writes a Space first, as a deployment upgrading from it holds. This build
// serves it as a Project, updates it and writes a Project; the previous build
// serves the same data, updates the Space again and writes another Space; then
// this build serves all three with both updates. Storage keeps the Space names,
// so no step moves a record. The previous build must already be built:
//   node scripts/rollback-qualification.mjs --previous <previous pages dir>
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
import { CELLD_RELEASE, parseRuntimeVersion } from "./deployment/profiles.mjs";
import { fixtureWhoamiUrl, generateFixtureKeys } from "./fixtures/local-api-keys.mjs";

const current = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const flag = process.argv.indexOf("--previous");
if (flag < 0 || !process.argv[flag + 1]) throw new Error("Pass --previous <pages dir>");
const previous = path.resolve(process.argv[flag + 1]);
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
const report = { origin, celld: version, previous, phases: [] };
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

  // 0. The previous build writes a Space and lists it, so the D1 index holds
  // Space rows at schema 4 before this build first runs.
  const seeder = await install(previous);
  await boot();
  const seeded = await mcp("create_space", { title: "Existing Space", idempotency_key: key() });
  const seededPage = await mcp("create_page", {
    title: "Existing Page",
    space_id: seeded.space_id,
    idempotency_key: key(),
  });
  assert.equal((await mcp("list_spaces")).spaces.length, 1);
  assert.equal(ids(await mcp("list_pages", { space_id: seeded.space_id })).length, 2);
  report.phases.push({ build: "previous", ...seeder, wrote: { seeded, seededPage } });
  await stop();

  // 1. This build serves the Space as a Project and updates it, then writes a
  // Project, its home Page and nested Pages.
  const writer = await install(current);
  await boot();
  const takenOver = await mcp("list_projects");
  assert.deepEqual(
    takenOver.projects.map((entry) => entry.project_id),
    [seeded.space_id],
  );
  assert.deepEqual(
    ids(await mcp("list_pages", { project_id: seeded.space_id })).sort(),
    [seeded.home_page_id, seededPage.page_id].sort(),
  );
  const newUpdate = await mcp("update_project", {
    project_id: seeded.space_id,
    title: "Updated by this build",
    expected_revision: 0,
    idempotency_key: key(),
  });
  assert.equal(newUpdate.revision, 1);
  assert.equal(newUpdate.org, null);
  const project = await mcp("create_project", {
    title: "Rollback Project",
    idempotency_key: key(),
  });
  assert.match(project.project_id, /^prj_/);
  const roadmap = await mcp("create_page", {
    title: "Roadmap",
    markdown: "Written by the Projects build.",
    project_id: project.project_id,
    idempotency_key: key(),
  });
  const plan = await mcp("create_page", {
    title: "Plan",
    markdown: "Child written by the Projects build.",
    parent_id: roadmap.page_id,
    idempotency_key: key(),
  });
  const notes = await mcp("create_page", {
    title: "Notes",
    markdown: "Second child.",
    parent_id: roadmap.page_id,
    idempotency_key: key(),
  });
  const inProject = await mcp("list_pages", { project_id: project.project_id });
  assert.deepEqual(
    ids(inProject).sort(),
    [project.home_page_id, roadmap.page_id, plan.page_id, notes.page_id].sort(),
  );
  report.phases.push({ build: "current", ...writer, wrote: { project, roadmap, plan, notes } });
  await stop();

  // 2. The previous build serves the same data. It reads and edits Pages in
  // the Project, cannot address the Project itself (prj_ IDs and project/
  // entries are new to it), and writes a Space of its own.
  const reader = await install(previous);
  await boot();
  const listed = await mcp("list_pages");
  for (const pageId of [project.home_page_id, roadmap.page_id, plan.page_id])
    assert.ok(ids(listed).includes(pageId), `previous build lists ${pageId}`);
  const read = await mcp("read_page", { page_id: plan.page_id, comments: "none" });
  assert.match(read.blocks.map((block) => block.markdown).join("\n"), /Child written/);
  const edited = await mcp("edit_page", {
    page_id: plan.page_id,
    base_heads: read.heads,
    idempotency_key: key(),
    operations: [{ op: "insert_markdown", markdown: "Edited by the previous build." }],
  });
  const unseen = await call("get_space", { space_id: project.project_id });
  assert.equal(unseen.isError, true, "the previous build cannot address a prj_ Project");
  // The Space this build updated reads with that update, and takes another.
  const seenUpdate = await mcp("get_space", { space_id: seeded.space_id });
  assert.equal(seenUpdate.title, "Updated by this build");
  assert.equal(seenUpdate.revision, 1);
  const oldUpdate = await mcp("update_space", {
    space_id: seeded.space_id,
    title: "Updated by the previous build",
    expected_revision: 1,
    idempotency_key: key(),
  });
  assert.equal(oldUpdate.revision, 2);
  const oldSpaces = await mcp("list_spaces");
  assert.ok(
    oldSpaces.spaces.some((entry) => entry.space_id === seeded.space_id),
    "the previous build lists the Space this build served",
  );
  // A child under a Page in a prj_ Project is refused: the previous build
  // cannot read a prj_ Project record, so it never files the child elsewhere.
  const strayChild = await call("create_page", {
    title: "Stray",
    parent_id: roadmap.page_id,
    idempotency_key: key(),
  });
  assert.equal(strayChild.isError, true);
  const trashWith = async (pageId) =>
    mcp("delete_page", {
      page_id: pageId,
      base_heads: (await mcp("read_page", { page_id: pageId, include_content: false })).heads,
      idempotency_key: key(),
    });
  const trashedChild = await trashWith(notes.page_id);
  const space = await mcp("create_space", { title: "Rollback Space", idempotency_key: key() });
  assert.match(space.space_id, /^sp_/);
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
  report.phases.push({
    build: "previous",
    ...reader,
    listed: listed.pages.length,
    edited_heads: edited.heads,
    project_lookup_error: unseen.body.code ?? unseen.body.error,
    listed_spaces: oldSpaces.spaces.map((entry) => entry.space_id),
    space_update: { read: seenUpdate.title, wrote: oldUpdate.title, revision: oldUpdate.revision },
    stray_child: strayChild.body.code ?? strayChild.body.error,
    trashed_child: trashedChild.state,
    wrote: { space, brief, detail },
  });
  await stop();

  // 3. This build again: its Project is intact, and the previous build's
  // Spaces are Projects with their sp_ IDs.
  const again = await install(current);
  await boot();
  const projects = await mcp("list_projects");
  assert.deepEqual(
    projects.projects.map((entry) => entry.project_id).sort(),
    [seeded.space_id, project.project_id, space.space_id].sort(),
  );
  // Updates from both builds are there, and the next one applies.
  const bothUpdates = await mcp("get_project", { project_id: seeded.space_id });
  assert.equal(bothUpdates.home_page_id, seeded.home_page_id);
  assert.equal(bothUpdates.title, "Updated by the previous build");
  assert.equal(bothUpdates.revision, 2);
  const nextUpdate = await mcp("update_project", {
    project_id: seeded.space_id,
    description: "Updated again by this build",
    expected_revision: 2,
    idempotency_key: key(),
  });
  assert.equal(nextUpdate.revision, 3);
  assert.ok(
    !(await mcp("list_pages")).pages.some((page) => page.title === "Stray"),
    "the refused child exists nowhere",
  );
  const restoredProject = await mcp("get_project", { project_id: project.project_id });
  assert.equal(restoredProject.home_page_id, project.home_page_id);
  const migrated = await mcp("get_project", { project_id: space.space_id });
  assert.equal(migrated.home_page_id, space.home_page_id);
  assert.equal(migrated.title, "Rollback Space");
  assert.equal(migrated.org, null);
  const fromSpace = await mcp("list_pages", { project_id: space.space_id });
  assert.deepEqual(
    ids(fromSpace).sort(),
    [space.home_page_id, brief.page_id, detail.page_id].sort(),
  );
  const detailRead = await mcp("read_page", { page_id: detail.page_id, comments: "none" });
  assert.equal(detailRead.project_id, space.space_id);
  assert.deepEqual(
    detailRead.breadcrumbs.map((crumb) => crumb.title),
    ["Rollback Space", "Brief"],
  );
  const addedToSpace = await mcp("create_page", {
    title: "Added after roll forward",
    project_id: space.space_id,
    idempotency_key: key(),
  });
  assert.equal(addedToSpace.project_id, space.space_id);
  const after = await mcp("list_pages", { project_id: project.project_id });
  assert.deepEqual(ids(after).sort(), [project.home_page_id, roadmap.page_id, plan.page_id].sort());
  const planAgain = await mcp("read_page", { page_id: plan.page_id, comments: "none" });
  assert.match(
    planAgain.blocks.map((block) => block.markdown).join("\n"),
    /Edited by the previous build/,
  );
  assert.deepEqual(
    planAgain.breadcrumbs.map((crumb) => crumb.title),
    ["Rollback Project", "Roadmap"],
  );
  // The child the previous build trashed restores under its parent.
  const authority = await mcp("list_pages");
  const restoredChild = await mcp("restore_page", {
    page_id: notes.page_id,
    retry_token: authority.retry_token,
    idempotency_key: authority.retry_key_prefix + key(),
  });
  assert.equal(restoredChild.parent_id, roadmap.page_id);
  assert.equal(restoredChild.project_id, project.project_id);
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
    projects: projects.projects.map((entry) => entry.project_id),
    migrated_space: migrated.project_id,
    pages_in_migrated_space: fromSpace.pages.length,
    migrated_breadcrumbs: detailRead.breadcrumbs.map((crumb) => crumb.title),
    breadcrumbs: planAgain.breadcrumbs.map((crumb) => crumb.title),
    restored_child_parent: restoredChild.parent_id,
    seeded_after_both_updates: { title: bothUpdates.title, revision: bothUpdates.revision },
  });
  await stop();
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
