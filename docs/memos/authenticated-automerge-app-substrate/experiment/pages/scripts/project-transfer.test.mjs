import assert from "node:assert/strict";
import { mkdtemp, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { generateKeyBetween } from "fractional-indexing";
import { retryKeyPrefix } from "../model/retry-key.mjs";
import {
  BUNDLE_FORMAT,
  EDIT_BATCH,
  TransferError,
  exportProject,
  fileStore,
  importBundle,
  memoryStore,
  pagesClient,
  planImport,
  rewriteLinks,
  targetPlacement,
  validateBundle,
} from "./project-transfer.mjs";

const SOURCE = "https://source.example";
const TARGET = "https://target.example";
const KEY = "pages-test-key-0123456789";
const quick = { sleep: async () => {}, now: () => Date.parse("2026-11-01T00:00:00Z") };
const MUTATIONS = new Set(["create_project", "create_page", "edit_page"]);

/**
 * An in-memory Pages target behind a fetch function that speaks the same
 * stateless JSON-RPC tools/call as /mcp. It enforces the retry contract the
 * importer depends on: v1_ keys need their retry_token and its prefix, and a
 * key replays its receipt only for the identical payload. `placement` picks
 * what project_id alone means: "page9" puts the Page at the Project's top
 * level, "page10" under the home Page.
 */
function fakePages(origin, { placement = "page10", outlinePage = 100 } = {}) {
  const pages = new Map();
  const projects = new Map();
  const receipts = new Map();
  const tokens = new Map();
  const calls = [];
  const counts = new Map();
  // Pages whose explicit reads exceed the response budget.
  const oversize = new Set();
  let clock = 0;
  // Server time for created_at, a second per creation from the importer's
  // fixed clock (quick.now), so everything the fake makes is newer.
  let serverTime = Date.parse("2026-11-01T00:00:00Z");
  const createdAt = () => new Date((serverTime += 1000)).toISOString();
  let tokenCount = 0;
  // dropResponse: apply, then lose the response. before: answer without
  // applying ("lost" loses the request; an object is the tool's result).
  const hooks = { dropResponse: null, before: null };
  const fail = (code, error = code) => ({ ok: false, body: { error, code } });
  const head = (page) => page.revision.toString(16).padStart(64, "0");
  async function authority() {
    const token = `retry-${++tokenCount}.signature`;
    const retry_until = new Date(Date.UTC(2026, 10, 8)).toISOString();
    tokens.set(token, retry_until);
    return { retry_token: token, retry_key_prefix: await retryKeyPrefix(token), retry_until };
  }
  const siblings = (projectId, parentId) =>
    [...pages.values()].filter(
      (page) => page.project_id === projectId && page.parent_id === parentId,
    );
  function insert({ title, blocks, project_id = null, parent_id = null, home = false, position }) {
    const last = siblings(project_id, parent_id)
      .map((page) => page.position)
      .sort()
      .at(-1);
    const page = {
      page_id: crypto.randomUUID(),
      title,
      project_id,
      parent_id,
      home,
      position: position ?? generateKeyBetween(last ?? null, null),
      blocks: blocks.map((block) =>
        typeof block === "string"
          ? { id: crypto.randomUUID(), kind: "markdown", markdown: block }
          : { id: crypto.randomUUID(), kind: "markdown", ...block },
      ),
      comments: [],
      revision: 1,
      changed: ++clock,
      created_at: createdAt(),
    };
    pages.set(page.page_id, page);
    return page;
  }
  function seedProject({ title, description = "" }) {
    const project_id = `prj_${crypto.randomUUID()}`;
    const home = insert({
      title,
      blocks: [`${description || "Describe it."}\n\n## Guidance\n\nThe home Page.`],
      project_id,
      home: true,
    });
    projects.set(project_id, {
      project_id,
      title,
      description,
      home_page_id: home.page_id,
      created_at: home.created_at,
    });
    return { project_id, home };
  }
  const row = (page) => ({
    page_id: page.page_id,
    title: page.title,
    created_at: page.created_at,
    ...(page.project_id && {
      project_id: page.project_id,
      parent_id: page.parent_id,
      position: page.position,
      ...(page.home && { home: true }),
    }),
  });
  const outline = (page) =>
    page.blocks.map((block) => ({
      block_id: block.id,
      node_index: 0,
      type: block.type ?? "paragraph",
    }));
  async function idempotent(name, args, apply) {
    const key = args.idempotency_key;
    if (typeof key !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(key))
      return fail("invalid_idempotency_key", "idempotency_key must contain 8–128 characters");
    const versioned = key.startsWith("v1_");
    if (versioned !== (args.retry_token !== undefined))
      return fail(
        "invalid_retry_token",
        "A v1_ idempotency_key and retry_token must be used together",
      );
    if (versioned) {
      if (!tokens.has(args.retry_token)) return fail("invalid_retry_token");
      if (!key.startsWith(await retryKeyPrefix(args.retry_token)))
        return fail("invalid_retry_token", "Use retry_key_prefix plus a unique nonce");
    }
    const fingerprint = JSON.stringify([name, args]);
    const stored = receipts.get(key);
    if (stored)
      return stored.fingerprint === fingerprint
        ? { ok: true, body: stored.body, replayed: true }
        : fail("idempotency_conflict");
    const result = apply();
    if (result.ok) receipts.set(key, { fingerprint, body: result.body });
    return result;
  }
  const tools = {
    async list_pages(args) {
      let rows = [...pages.values()].sort((a, b) => b.changed - a.changed);
      if (args.project_id) rows = rows.filter((page) => page.project_id === args.project_id);
      if (args.parent_id !== undefined)
        rows = rows.filter((page) => page.parent_id === args.parent_id);
      const offset = Number(args.cursor ?? 0);
      const limit = Math.min(args.limit ?? 50, 2);
      const slice = rows.slice(offset, offset + limit);
      return {
        ok: true,
        body: {
          pages: slice.map(row),
          next_cursor: offset + limit < rows.length ? String(offset + limit) : null,
          ...(await authority()),
        },
      };
    },
    async list_projects() {
      return {
        ok: true,
        body: {
          projects: [...projects.values()].map(({ project_id, title }) => ({ project_id, title })),
          next_cursor: null,
          ...(await authority()),
        },
      };
    },
    async get_project(args) {
      const project = projects.get(args.project_id);
      return project ? { ok: true, body: { ...project, revision: 0 } } : fail("project_not_found");
    },
    create_project: (args) =>
      idempotent("create_project", args, () => {
        const { project_id, home } = seedProject(args);
        return { ok: true, body: { project_id, home_page_id: home.page_id, revision: 0 } };
      }),
    create_page: (args) =>
      idempotent("create_page", args, () => {
        let project_id = args.project_id ?? null;
        let parent_id = args.parent_id ?? null;
        if (parent_id) {
          const parent = pages.get(parent_id);
          if (!parent) return fail("parent_not_found");
          project_id = parent.project_id;
        } else if (project_id && placement === "page10")
          parent_id = projects.get(project_id).home_page_id;
        const page = insert({
          title: args.title,
          blocks: [args.markdown ?? ""],
          project_id,
          parent_id,
        });
        return { ok: true, body: { page_id: page.page_id, project_id, parent_id } };
      }),
    async read_page(args) {
      const page = pages.get(args.page_id);
      if (!page) return fail("page_not_found");
      const common = { page_id: page.page_id, title: page.title, heads: [head(page)] };
      const blocks = page.blocks.map(({ id, kind, markdown }) => ({ id, kind, markdown }));
      if (Object.keys(args).length === 1)
        return {
          ok: true,
          body: { ...common, blocks, comments: page.comments, ...(await authority()) },
        };
      const offset = args.outline_offset ?? 0;
      if (offset > 0 && !args.expected_heads) return fail("invalid_read_selector");
      if (args.expected_heads && args.expected_heads[0] !== head(page))
        return fail("read_revision_changed");
      if (args.include_content !== false && oversize.has(page.page_id))
        return fail("read_budget_exceeded");
      const entries = outline(page);
      const limit = Math.min(args.outline_limit ?? 100, outlinePage);
      const slice = entries.slice(offset, offset + limit);
      return {
        ok: true,
        body: {
          ...common,
          blocks: args.include_content === false ? [] : blocks,
          outline: {
            entries: slice,
            total: entries.length,
            offset,
            next_offset: offset + slice.length < entries.length ? offset + slice.length : null,
          },
          comments: args.comments === "none" ? [] : page.comments.map(({ id }) => ({ id })),
          ...(await authority()),
        },
      };
    },
    edit_page: (args) =>
      idempotent("edit_page", args, () => {
        const page = pages.get(args.page_id);
        if (!page) return fail("page_not_found");
        if (JSON.stringify(args.base_heads) !== JSON.stringify([head(page)]))
          return fail("edit_conflict");
        for (const op of args.operations) {
          if (op.op === "set_title") page.title = op.title;
          else if (op.op === "insert_markdown")
            page.blocks.push({ id: crypto.randomUUID(), kind: "markdown", markdown: op.markdown });
          else {
            const index = page.blocks.findIndex((block) => block.id === op.block_id);
            if (index < 0) return fail("block_not_found");
            if (op.op === "delete_block") page.blocks.splice(index, 1);
            else if (op.op === "replace_block_markdown") page.blocks[index].markdown = op.markdown;
            else return fail("unsupported_operation");
          }
        }
        page.revision++;
        page.changed = ++clock;
        return { ok: true, body: { page_id: page.page_id, heads: [head(page)] } };
      }),
  };
  async function fetch(url, init) {
    assert.equal(url, `${origin}/mcp`);
    assert.equal(init.headers["X-Pages-Driver"], "Pages project transfer");
    if (init.headers.Authorization !== `Bearer ${KEY}`)
      return Response.json({ error: "invalid_token" }, { status: 401 });
    const message = JSON.parse(init.body);
    assert.equal(message.method, "tools/call");
    const { name, arguments: args } = message.params;
    const count = (counts.get(name) ?? 0) + 1;
    counts.set(name, count);
    const early = hooks.before?.(name, args, count);
    if (early === "lost") throw new TypeError("fetch failed");
    const result = early ?? (await tools[name](args));
    calls.push({ name, args, ok: result.ok, replayed: result.replayed === true });
    // The server applied the request, but the caller never hears back.
    if (hooks.dropResponse?.(name, args, count)) throw new TypeError("fetch failed");
    const body =
      result.ok && result.body.page_id
        ? { ...result.body, url: `${origin}/p/${result.body.page_id}` }
        : result.body;
    return Response.json({
      jsonrpc: "2.0",
      id: message.id,
      result: result.ok
        ? { structuredContent: body, content: [{ type: "text", text: JSON.stringify(body) }] }
        : { isError: true, content: [{ type: "text", text: JSON.stringify(body) }] },
    });
  }
  const children = (parentId) =>
    [...pages.values()]
      .filter((page) => page.parent_id === parentId)
      .sort((a, b) => (a.position < b.position ? -1 : 1));
  return { fetch, pages, projects, calls, hooks, insert, seedProject, children, oversize };
}

const client = (fake, origin) => pagesClient({ origin, token: KEY, fetch: fake.fetch });

/** A page9-shaped source: top-level Pages are the home Page's siblings. */
function guideSource(options) {
  const source = fakePages(SOURCE, { placement: "page9", ...options });
  const { project_id, home } = source.seedProject({
    title: "Pages engineering guide",
    description: "How Pages is built.",
  });
  home.position = "a1";
  const at = (title, blocks, position, parent = null) =>
    source.insert({ title, blocks, project_id, parent_id: parent?.page_id ?? null, position });
  const before = at("Before home", ["Sorted before the home Page."], "a0");
  const zeta = at("Zeta", ["Last at the top level."], "a3");
  const alpha = at("Alpha", ["First section.", { markdown: "$$x$$", type: "raw" }], "a2");
  const two = at("Alpha two", ["Second child."], "a1", alpha);
  const one = at(
    "Alpha one",
    [
      "![diagram](/api/pages/" +
        "1".repeat(8) +
        "-1111-4111-8111-" +
        "1".repeat(12) +
        "/assets/" +
        "a".repeat(64) +
        ")",
    ],
    "a0",
    alpha,
  );
  const deep = at("Alpha one deep", ["Grandchild."], "a0", one);
  one.comments = [{ id: "thread-1" }, { id: "thread-2" }];
  // Listing is newest first: make it disagree with tree order.
  for (const [index, page] of [deep, zeta, one, home, before, two, alpha].entries())
    page.changed = 100 - index;
  return { source, project_id, home, before, zeta, alpha, two, one, deep };
}

async function exportGuide(options) {
  const fixture = guideSource(options);
  const { bundle, report } = await exportProject(client(fixture.source, SOURCE), {
    projectId: fixture.project_id,
    ...quick,
    uuid: () => "3f0d6c2e-1f7b-4b8e-9a51-0c2d5e7f8a90",
  });
  return { ...fixture, bundle, report };
}

test("export lists Pages in tree order: home first, parents before children, siblings by position", async () => {
  const { bundle, report, home, before, zeta, alpha, two, one, deep, project_id } =
    await exportGuide({ outlinePage: 1 });
  assert.equal(bundle.format, BUNDLE_FORMAT);
  assert.equal(bundle.version, 1);
  assert.equal(bundle.bundle_id, "3f0d6c2e-1f7b-4b8e-9a51-0c2d5e7f8a90");
  assert.deepEqual(bundle.source, { origin: SOURCE, project_id, home_page_id: home.page_id });
  assert.equal(bundle.exported_at, "2026-11-01T00:00:00.000Z");
  assert.deepEqual(bundle.project, {
    title: "Pages engineering guide",
    description: "How Pages is built.",
  });
  assert.deepEqual(
    bundle.pages.map((page) => [page.title, page.parent_source_id, page.position]),
    [
      ["Pages engineering guide", null, "a1"],
      ["Before home", null, "a0"],
      ["Alpha", null, "a2"],
      ["Alpha one", alpha.page_id, "a0"],
      ["Alpha one deep", one.page_id, "a0"],
      ["Alpha two", alpha.page_id, "a1"],
      ["Zeta", null, "a3"],
    ],
  );
  assert.deepEqual(
    bundle.pages.map((page) => page.source_page_id),
    [home, before, alpha, one, deep, two, zeta].map((page) => page.page_id),
  );
  assert.equal(bundle.pages[0].home, true);
  assert.equal(bundle.pages.filter((page) => page.home).length, 1);
  validateBundle(bundle);

  const alphaEntry = bundle.pages[2];
  assert.deepEqual(alphaEntry.blocks, ["First section.", "$$x$$"]);
  assert.equal(alphaEntry.markdown, "First section.\n\n$$x$$");
  // The raw node is on the second outline page; only paging finds it.
  assert.equal(alphaEntry.preserved_markdown, true);
  assert.equal(bundle.pages[1].blocks, undefined, "a single block needs no blocks array");
  assert.equal(bundle.pages[3].private_images.length, 1);
  assert.equal(bundle.pages[3].comment_threads, 2);
  assert.deepEqual(
    report.preserved_markdown.map((page) => page.title),
    ["Alpha"],
  );
  assert.deepEqual(
    report.private_images.map((page) => page.title),
    ["Alpha one"],
  );
  assert.equal(report.comment_threads, 2);
});

test("export reads an oversized Page through the unbounded read", async () => {
  const { source, project_id, alpha } = guideSource();
  source.oversize.add(alpha.page_id);
  const { bundle } = await exportProject(client(source, SOURCE), {
    projectId: project_id,
    ...quick,
  });
  const entry = bundle.pages.find((page) => page.title === "Alpha");
  assert.equal(entry.markdown, "First section.\n\n$$x$$");
  assert.equal(entry.preserved_markdown, true);
  assert.ok(
    source.calls.some((call) => call.name === "read_page" && Object.keys(call.args).length === 1),
  );
});

test("import fills the home Page, nests the top level under it and keeps sibling order", async () => {
  const { bundle } = await exportGuide();
  const target = fakePages(TARGET);
  const store = memoryStore();
  const report = await importBundle(client(target, TARGET), bundle, { store, ...quick });

  assert.equal(target.projects.size, 1);
  const [project] = target.projects.values();
  assert.equal(project.title, "Pages engineering guide");
  assert.equal(project.description, "How Pages is built.");
  assert.equal(target.pages.size, bundle.pages.length, "no extra Page beside the home Page");

  const state = store.peek();
  const id = (title) =>
    state.pages[bundle.pages.find((page) => page.title === title).source_page_id];
  const home = target.pages.get(project.home_page_id);
  assert.equal(id("Pages engineering guide"), home.page_id);
  assert.equal(home.home, true);
  assert.deepEqual(
    home.blocks.map((block) => block.markdown),
    [bundle.pages[0].markdown],
  );
  assert.deepEqual(
    target.children(home.page_id).map((page) => page.title),
    ["Before home", "Alpha", "Zeta"],
  );
  assert.deepEqual(
    target.children(id("Alpha")).map((page) => page.title),
    ["Alpha one", "Alpha two"],
  );
  assert.deepEqual(
    target.children(id("Alpha one")).map((page) => page.title),
    ["Alpha one deep"],
  );
  assert.deepEqual(
    target.pages.get(id("Alpha")).blocks.map((block) => block.markdown),
    ["First section.", "$$x$$"],
  );
  assert.ok(target.calls.every((call) => call.name !== "create_page" || call.args.parent_id));
  for (const call of target.calls.filter((call) => MUTATIONS.has(call.name))) {
    assert.match(call.args.idempotency_key, /^v1_[a-f0-9]{64}_[a-f0-9]{40}$/);
    assert.ok(call.args.retry_token);
  }

  assert.equal(report.verification.ok, true, report.verification.problems.join("\n"));
  assert.equal(report.pages, 7);
  assert.equal(report.created, 6);
  assert.equal(report.comment_threads_not_migrated, 2);
  assert.deepEqual(
    report.preserved_markdown.map((page) => page.title),
    ["Alpha"],
  );
  assert.deepEqual(
    report.private_images.map((page) => page.title),
    ["Alpha one"],
  );
  assert.equal(report.url, `${TARGET}/project/${project.project_id}`);
});

test("a rerun after a lost response replays the same requests and duplicates nothing", async () => {
  const { bundle } = await exportGuide();
  const target = fakePages(TARGET);
  const store = memoryStore();
  target.hooks.dropResponse = (name, _args, count) => name === "create_page" && count === 3;
  await assert.rejects(
    importBundle(client(target, TARGET), bundle, { store, attempts: 1, ...quick }),
    (error) => error instanceof TransferError && error.uncertain,
  );
  const lost = target.calls.filter((call) => call.name === "create_page").at(-1);
  assert.equal(store.peek().pending.operation, "create_page");
  assert.equal(target.pages.size, 4, "the lost create was applied");

  target.hooks.dropResponse = null;
  const report = await importBundle(client(target, TARGET), bundle, { store, ...quick });
  const replay = target.calls.find((call) => call.replayed);
  assert.deepEqual(replay.args, lost.args, "identical token, key and payload");
  assert.equal(target.pages.size, bundle.pages.length);
  assert.equal(new Set([...target.pages.values()].map((page) => page.title)).size, 7);
  assert.equal(report.verification.ok, true);
  assert.equal(store.peek().pending, null);

  const before = target.calls.length;
  const again = await importBundle(client(target, TARGET), bundle, { store, ...quick });
  const mutations = target.calls.slice(before).filter((call) => MUTATIONS.has(call.name));
  assert.deepEqual(mutations, [], "a finished import sends no writes");
  assert.equal(again.created, 0);
  assert.equal(again.verification.ok, true);
});

test("a lost Project creation resumes the same Project", async () => {
  const { bundle } = await exportGuide();
  const target = fakePages(TARGET);
  const store = memoryStore();
  target.hooks.dropResponse = (name) => name === "create_project";
  await assert.rejects(
    importBundle(client(target, TARGET), bundle, { store, attempts: 1, ...quick }),
    (error) => error.uncertain,
  );
  target.hooks.dropResponse = null;
  // The Project now exists under the bundle's title; the saved request, not a
  // fresh create, finishes it, so the duplicate-title guard doesn't fire.
  const report = await importBundle(client(target, TARGET), bundle, { store, ...quick });
  assert.equal(target.projects.size, 1);
  assert.equal(report.verification.ok, true);
});

function linkBundle() {
  const ids = {
    home: "11111111-1111-4111-8111-111111111111",
    child: "22222222-2222-4222-8222-222222222222",
    sibling: "33333333-3333-4333-8333-333333333333",
    outside: "44444444-4444-4444-8444-444444444444",
  };
  const project = "prj_55555555-5555-4555-8555-555555555555";
  const page = (source_page_id, title, markdown, parent_source_id = null, home = false) => ({
    source_page_id,
    parent_source_id,
    position: null,
    home,
    title,
    markdown,
    preserved_markdown: false,
    private_images: [],
    comment_threads: 0,
  });
  return {
    ids,
    project,
    bundle: {
      format: BUNDLE_FORMAT,
      version: 1,
      bundle_id: "links-0000-bundle",
      source: { origin: SOURCE, project_id: project, home_page_id: ids.home },
      exported_at: "2026-11-01T00:00:00.000Z",
      project: { title: "Linked guide", description: "" },
      pages: [
        page(
          ids.home,
          "Linked guide",
          `Start at [the child](${SOURCE}/p/${ids.child}#intro).`,
          null,
          true,
        ),
        page(
          ids.child,
          "Child",
          `Back [home](${SOURCE}/?page=${ids.home}) or the [Project](${SOURCE}/project/${project}).`,
        ),
        page(
          ids.sibling,
          "Sibling",
          `See [child](/p/${ids.child}) and ${SOURCE}/p/${ids.outside}.`,
          ids.child,
        ),
      ],
    },
  };
}

test("links point at the target after every Page exists; outside links are reported", async () => {
  const { bundle, ids } = linkBundle();
  const target = fakePages(TARGET);
  const store = memoryStore();
  const report = await importBundle(client(target, TARGET), bundle, { store, ...quick });
  const map = store.peek().pages;
  const [project] = target.projects.values();
  const body = (source) =>
    target.pages
      .get(map[source])
      .blocks.map((block) => block.markdown)
      .join("\n\n");
  assert.equal(body(ids.home), `Start at [the child](${TARGET}/p/${map[ids.child]}#intro).`);
  assert.equal(
    body(ids.child),
    `Back [home](${TARGET}/p/${map[ids.home]}) or the [Project](${TARGET}/project/${project.project_id}).`,
  );
  assert.equal(
    body(ids.sibling),
    `See [child](/p/${map[ids.child]}) and ${SOURCE}/p/${ids.outside}.`,
  );
  assert.deepEqual(report.unresolved_links, [
    { title: "Sibling", source_page_id: ids.sibling, url: `${SOURCE}/p/${ids.outside}` },
  ]);
  assert.equal(report.links_rewritten, 4);
  // Creates carry the bundle's Markdown; rewrites come in the second pass.
  const create = target.calls.find(
    (call) => call.name === "create_page" && call.args.title === "Child",
  );
  assert.match(create.args.markdown, new RegExp(`${SOURCE}/\\?page=`));

  const before = target.calls.length;
  const again = await importBundle(client(target, TARGET), bundle, { store, ...quick });
  assert.deepEqual(
    target.calls.slice(before).filter((call) => MUTATIONS.has(call.name)),
    [],
  );
  assert.deepEqual(again.unresolved_links, report.unresolved_links);
});

test("the home Page takes the source home's title and body instead of a new sibling", async () => {
  const { bundle } = linkBundle();
  bundle.pages[0].title = "Start here";
  const target = fakePages(TARGET);
  await importBundle(client(target, TARGET), bundle, { store: memoryStore(), ...quick });
  const [project] = target.projects.values();
  const home = target.pages.get(project.home_page_id);
  assert.equal(project.title, "Linked guide");
  assert.equal(home.title, "Start here");
  assert.equal(home.blocks.length, 1);
  assert.match(home.blocks[0].markdown, /^Start at \[the child\]/);
  assert.equal(target.pages.size, 3);
  assert.equal([...target.pages.values()].filter((page) => page.title === "Start here").length, 1);
});

test("a body longer than one edit batch keeps its block order", async () => {
  const { bundle } = linkBundle();
  const blocks = Array.from({ length: EDIT_BATCH + 30 }, (_, index) => `Block ${index}`);
  bundle.pages[2].blocks = blocks;
  bundle.pages[2].markdown = blocks.join("\n\n");
  const target = fakePages(TARGET);
  const store = memoryStore();
  await importBundle(client(target, TARGET), bundle, { store, ...quick });
  const sibling = target.pages.get(store.peek().pages[bundle.pages[2].source_page_id]);
  assert.deepEqual(
    sibling.blocks.map((block) => block.markdown),
    blocks,
  );
  const edits = target.calls.filter(
    (call) => call.name === "edit_page" && call.args.page_id === sibling.page_id,
  );
  assert.equal(edits.length, 2);
  assert.notEqual(edits[0].args.idempotency_key, edits[1].args.idempotency_key);
});

test("the state file is written atomically and readable only by its owner", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "project-transfer-"));
  const file = path.join(dir, "bundle.json.state.json");
  const store = fileStore(file);
  assert.equal(await store.load(), null);
  await store.save({ format: "x", pending: { args: { retry_token: "t" } } });
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual((await store.load()).pending.args, { retry_token: "t" });
  assert.deepEqual(await readdir(dir), ["bundle.json.state.json"]);
});

test("a fresh import refuses a target that already has a Project with that title", async () => {
  const { bundle } = linkBundle();
  const target = fakePages(TARGET);
  target.seedProject({ title: "Linked guide" });
  await assert.rejects(
    importBundle(client(target, TARGET), bundle, { store: memoryStore(), ...quick }),
    /already has a Project titled "Linked guide"/,
  );
  assert.equal(target.calls.filter((call) => MUTATIONS.has(call.name)).length, 0);
  const report = await importBundle(client(target, TARGET), bundle, {
    store: memoryStore(),
    allowExistingTitle: true,
    ...quick,
  });
  assert.equal(report.verification.ok, true);
  assert.equal(target.projects.size, 2);
});

test("import refuses the bundle's own source and a state file from another bundle", async () => {
  const { bundle } = linkBundle();
  const source = fakePages(SOURCE);
  await assert.rejects(
    importBundle(client(source, SOURCE), bundle, { store: memoryStore(), ...quick }),
    /different target/,
  );
  const target = fakePages(TARGET);
  const store = memoryStore({
    format: "nteract-pages-project-import-state",
    version: 1,
    bundle_id: "another-bundle",
    target_origin: TARGET,
  });
  await assert.rejects(
    importBundle(client(target, TARGET), bundle, { store, ...quick }),
    /different bundle/,
  );
});

test("targetPlacement maps the home, the top level and nested Pages", () => {
  const context = {
    homeSourceId: "home",
    targetHomeId: "new-home",
    pageIds: new Map([["parent", "new-parent"]]),
  };
  assert.deepEqual(targetPlacement({ source_page_id: "home", parent_source_id: null }, context), {
    home: true,
  });
  assert.deepEqual(targetPlacement({ source_page_id: "a", parent_source_id: null }, context), {
    parent_id: "new-home",
  });
  assert.deepEqual(targetPlacement({ source_page_id: "b", parent_source_id: "home" }, context), {
    parent_id: "new-home",
  });
  assert.deepEqual(targetPlacement({ source_page_id: "c", parent_source_id: "parent" }, context), {
    parent_id: "new-parent",
  });
  assert.throws(
    () =>
      targetPlacement({ source_page_id: "d", parent_source_id: "missing", title: "D" }, context),
    /needs its parent/,
  );
});

test("rewriteLinks leaves other origins and unknown Pages alone", () => {
  const id = "66666666-6666-4666-8666-666666666666";
  const result = rewriteLinks(
    `[a](${SOURCE}/p/${id}) [b](https://elsewhere.example/p/${id}) [c](${SOURCE}/p/77777777-7777-4777-8777-777777777777)`,
    { sourceOrigin: SOURCE, targetOrigin: TARGET, pages: new Map([[id, "new"]]) },
  );
  assert.equal(
    result.markdown,
    `[a](${TARGET}/p/new) [b](https://elsewhere.example/p/${id}) [c](${SOURCE}/p/77777777-7777-4777-8777-777777777777)`,
  );
  assert.equal(result.rewritten, 1);
  assert.deepEqual(result.unresolved, [`${SOURCE}/p/77777777-7777-4777-8777-777777777777`]);
});

test("validateBundle names edits that would import something else", () => {
  const { bundle } = linkBundle();
  const edited = structuredClone(bundle);
  edited.pages[1].blocks = ["Two", "blocks"];
  assert.throws(() => validateBundle(edited), /markdown and blocks disagree/);
  const reordered = structuredClone(bundle);
  reordered.pages = [reordered.pages[0], reordered.pages[2], reordered.pages[1]];
  assert.throws(() => validateBundle(reordered), /parents come before children/);
  const twoHomes = structuredClone(bundle);
  twoHomes.pages[1].home = true;
  assert.throws(() => validateBundle(twoHomes), /exactly one Page/);
  assert.deepEqual(
    planImport(bundle).map((step) => [step.title, step.action, step.under]),
    [
      ["Linked guide", "fill the target Project's home Page", null],
      ["Child", "create", "Linked guide"],
      ["Sibling", "create", "Child"],
    ],
  );
});

test("the client never puts the token in an error, and sorts errors by certainty", async () => {
  const secret = "do-not-print-this-key";
  const refusing = pagesClient({
    origin: TARGET,
    token: secret,
    fetch: async () => Response.json({ error: "invalid_token" }, { status: 401 }),
  });
  await assert.rejects(refusing.call("list_pages"), (error) => {
    assert.equal(error.code, "unauthorized");
    assert.ok(!error.message.includes(secret));
    return true;
  });
  const answer = (result) =>
    pagesClient({
      origin: TARGET,
      token: secret,
      fetch: async () => Response.json({ jsonrpc: "2.0", id: 1, result }),
    });
  const toolError = (body) => ({
    isError: true,
    content: [{ type: "text", text: JSON.stringify(body) }],
  });
  await assert.rejects(
    answer(toolError({ error: "Page changed", code: "edit_conflict" })).call("edit_page"),
    (error) => !error.uncertain && error.code === "edit_conflict",
  );
  await assert.rejects(
    answer(toolError({ error: "Busy", code: "lifecycle_unsettled", retryable: true })).call(
      "create_page",
    ),
    (error) => error.uncertain,
  );
  await assert.rejects(
    answer(toolError({ error: "Pages request failed" })).call("create_page"),
    (error) => error.uncertain,
  );
  await assert.rejects(
    answer({
      isError: true,
      content: [{ type: "text", text: "Request failed; outcome may be unknown." }],
    }).call("create_page"),
    (error) => error.uncertain,
  );
  await assert.rejects(
    pagesClient({
      origin: TARGET,
      token: secret,
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    }).call("create_page"),
    (error) => error.uncertain,
  );
  assert.throws(() => pagesClient({ origin: "http://target.example", token: secret }), /https/);
  assert.throws(() => pagesClient({ origin: `${TARGET}/mcp`, token: secret }), /only the origin/);
});

test("import refuses a bundle whose source is the target in any spelling", async () => {
  const { bundle } = linkBundle();
  for (const spelling of [`${TARGET}/`, "https://TARGET.example", "https://target.example:443"]) {
    const edited = structuredClone(bundle);
    edited.source.origin = spelling;
    const target = fakePages(TARGET);
    await assert.rejects(
      importBundle(client(target, TARGET), edited, { store: memoryStore(), ...quick }),
      /bundle's source/,
      spelling,
    );
    assert.deepEqual(target.calls, [], `${spelling} sent a request`);
  }
});

test("a source origin with a trailing slash still rewrites its links", async () => {
  const { bundle, ids } = linkBundle();
  bundle.source.origin = `${SOURCE}/`;
  const target = fakePages(TARGET);
  const store = memoryStore();
  await importBundle(client(target, TARGET), bundle, { store, ...quick });
  const home = target.pages.get(store.peek().pages[ids.home]);
  assert.equal(
    home.blocks[0].markdown,
    `Start at [the child](${TARGET}/p/${store.peek().pages[ids.child]}#intro).`,
  );
});

test("rewriteLinks rewrites only complete source links", () => {
  const id = "66666666-6666-4666-8666-666666666666";
  const options = { sourceOrigin: SOURCE, targetOrigin: TARGET, pages: new Map([[id, "new"]]) };
  const rewrite = (text) => rewriteLinks(text, options).markdown;
  // Partial IDs and URLs embedded in another URL are not links to the source.
  for (const text of [
    `${SOURCE}/p/${id}extra`,
    `${SOURCE}/p/${id}-0`,
    `https://elsewhere.example/${SOURCE}/p/${id}`,
    `https://elsewhere.example/go?to=${SOURCE}/p/${id}`,
    `x${SOURCE}/p/${id}`,
    `${SOURCE}.evil.example/p/${id}`,
    `[a](/p/${id}extra)`,
    `${SOURCE}/?page=${id}x`,
    `${SOURCE}/p/${id}.json`,
    // A source URL nested in another URL after "(" belongs to that URL.
    `https://other.example/go?(${SOURCE}/p/${id})`,
    `see https://other.example/go?(${SOURCE}/p/${id}).`,
    `[a](https://other.example/go?(${SOURCE}/p/${id}))`,
    `[a](https://other.example/go(x)?(${SOURCE}/p/${id}))`,
    `[a](https://other.example/go(x(y))?(${SOURCE}/p/${id}))`,
    `[a](https://other.example/go\\(?(${SOURCE}/p/${id}))`,
    `[a](https://other.example/go((${SOURCE}/p/${id})`,
    `<https://other.example/go?u=${SOURCE}/p/${id}>`,
    `[a](https://other.example/${SOURCE}/p/${id})`,
  ])
    assert.equal(rewrite(text), text, text);
  // Queries, fragments and paths after the ID are kept.
  assert.equal(rewrite(`${SOURCE}/p/${id}?x=1#y`), `${TARGET}/p/new?x=1#y`);
  assert.equal(rewrite(`[a](${SOURCE}/p/${id}/)`), `[a](${TARGET}/p/new/)`);
  assert.equal(rewrite(`${SOURCE}/?page=${id}&x=1#y`), `${TARGET}/p/new?x=1#y`);
  assert.equal(rewrite(`${SOURCE}/?page=${id}#y`), `${TARGET}/p/new#y`);
  // Every boundary a Markdown link can put around a URL.
  assert.equal(rewrite(`<${SOURCE}/p/${id}>`), `<${TARGET}/p/new>`);
  assert.equal(
    rewrite(`[${SOURCE}/p/${id}](${SOURCE}/p/${id})`),
    `[${TARGET}/p/new](${TARGET}/p/new)`,
  );
  assert.equal(rewrite(`"${SOURCE}/p/${id}"`), `"${TARGET}/p/new"`);
  assert.equal(rewrite(`line\n${SOURCE}/p/${id}\nnext`), `line\n${TARGET}/p/new\nnext`);
  assert.equal(rewrite(`[a](/p/${id})`), `[a](/p/new)`);
  assert.equal(rewrite(`[a](/p/${id}#top)`), `[a](/p/new#top)`);
  assert.equal(rewrite(`See ${SOURCE}/p/${id}. Then`), `See ${TARGET}/p/new. Then`);
  assert.equal(rewrite(`(${SOURCE}/p/${id}),`), `(${TARGET}/p/new),`);
  assert.equal(rewrite(`(see ${SOURCE}/p/${id})`), `(see ${TARGET}/p/new)`);
  assert.equal(rewrite(`[a](<${SOURCE}/p/${id}>)`), `[a](<${TARGET}/p/new>)`);
  assert.equal(rewrite(`[x](${SOURCE}/p/${id}?q=(a))`), `[x](${TARGET}/p/new?q=(a))`);
  assert.equal(rewrite(`[x](${SOURCE}/p/${id}?q=\\()`), `[x](${TARGET}/p/new?q=\\()`);
  assert.equal(
    rewrite(`[x](${SOURCE}/p/${id}) and ${SOURCE}/p/${id}`),
    `[x](${TARGET}/p/new) and ${TARGET}/p/new`,
  );
  assert.equal(rewrite(`[a](${SOURCE}/p/${id} "Title")`), `[a](${TARGET}/p/new "Title")`);
  assert.equal(rewrite(`see /p/${id}`), `see /p/${id}`, "only a link destination is relative");
});

/** The second create's window closes while its outcome is unknown. */
async function expiredCreate({ applied }) {
  const { bundle } = linkBundle();
  const target = fakePages(TARGET);
  const store = memoryStore();
  if (applied)
    target.hooks.dropResponse = (name, _args, count) => name === "create_page" && count === 2;
  else
    target.hooks.before = (name, _args, count) =>
      name === "create_page" && count === 2 ? "lost" : undefined;
  await assert.rejects(
    importBundle(client(target, TARGET), bundle, { store, attempts: 1, ...quick }),
    (error) => error.uncertain,
  );
  target.hooks.dropResponse = null;
  target.hooks.before = (name) =>
    name === "create_page"
      ? { ok: false, body: { error: "Retry window expired", code: "retry_expired" } }
      : undefined;
  await assert.rejects(
    importBundle(client(target, TARGET), bundle, { store, ...quick }),
    (error) => error.code === "reconciliation_required" && /--reconcile/.test(error.message),
  );
  target.hooks.before = null;
  const record = store.peek().reconciliation_required;
  return { bundle, target, store, record, sibling: bundle.pages[2] };
}
const writes = (target, from) =>
  target.calls.slice(from).filter((call) => MUTATIONS.has(call.name));

test("an expired create blocks writes; --reconcile lists candidates and --adopt records one", async () => {
  const { bundle, target, store, record, sibling } = await expiredCreate({ applied: true });
  assert.equal(record.step, `page:${sibling.source_page_id}`);
  assert.equal(record.operation, "create_page");
  assert.equal(record.args.title, "Sibling");
  assert.equal(record.requested_at, "2026-11-01T00:00:00.000Z", "kept from the first send");
  assert.match(record.idempotency_key, /^v1_/);
  assert.equal(store.peek().pending, null);

  let before = target.calls.length;
  await assert.rejects(
    importBundle(client(target, TARGET), bundle, { store, ...quick }),
    /--reconcile/,
  );
  assert.deepEqual(target.calls.slice(before), [], "a refused rerun sends nothing");

  before = target.calls.length;
  const listed = await importBundle(client(target, TARGET), bundle, {
    store,
    reconcile: true,
    ...quick,
  });
  const made = [...target.pages.values()].find((page) => page.title === "Sibling");
  assert.deepEqual(listed.reconciliation.candidates, [
    {
      page_id: made.page_id,
      title: "Sibling",
      created_at: made.created_at,
      created_after_request: true,
      url: `${TARGET}/p/${made.page_id}`,
    },
  ]);
  assert.equal(listed.reconciliation.record.args.retry_token, undefined);
  assert.deepEqual(writes(target, before), [], "listing candidates writes nothing");
  assert.ok(store.peek().reconciliation_required, "even a single candidate is not adopted");
  assert.equal(store.peek().pages[sibling.source_page_id], undefined);

  const report = await importBundle(client(target, TARGET), bundle, {
    store,
    adopt: made.page_id,
    ...quick,
  });
  assert.equal(target.pages.size, 3, "the Page the expired create made is reused");
  assert.equal(store.peek().reconciliation_required, null);
  assert.equal(store.peek().pages[sibling.source_page_id], made.page_id);
  assert.equal(report.verification.ok, true);
});

test("an unrelated same-title Page is never adopted, and --adopt checks parent, title and age", async () => {
  const { bundle, target, store, record, sibling } = await expiredCreate({ applied: false });
  const parent = target.pages.get(record.args.parent_id);
  const [project] = target.projects.values();
  const seed = (title, parent_id, created_at) => {
    const page = target.insert({
      title,
      blocks: ["Unrelated."],
      project_id: project.project_id,
      parent_id,
    });
    if (created_at) page.created_at = created_at;
    return page;
  };
  const old = seed("Sibling", parent.page_id, "2026-10-01T00:00:00.000Z");
  const elsewhere = seed("Sibling", project.home_page_id);
  const renamed = seed("Other", parent.page_id);
  const recent = seed("Sibling", parent.page_id);

  const listed = await importBundle(client(target, TARGET), bundle, {
    store,
    reconcile: true,
    ...quick,
  });
  assert.deepEqual(
    listed.reconciliation.candidates.map((entry) => [entry.page_id, entry.created_after_request]),
    [
      [old.page_id, false],
      [recent.page_id, true],
    ],
  );
  assert.equal(listed.reconciliation.candidates.length, 2, "duplicate titles list both");
  await assert.rejects(
    importBundle(client(target, TARGET), bundle, { store, ...quick }),
    /--reconcile/,
    "listing never adopts",
  );
  for (const [page, reason] of [
    [old, /created at 2026-10-01T00:00:00.000Z, before the create was sent/],
    [elsewhere, /not under the recorded parent/],
    [renamed, /its title is "Other"/],
  ])
    await assert.rejects(
      importBundle(client(target, TARGET), bundle, { store, adopt: page.page_id, ...quick }),
      (error) => error.code === "adopt_refused" && reason.test(error.message),
    );
  await assert.rejects(
    importBundle(client(target, TARGET), bundle, {
      store,
      adopt: project.project_id,
      ...quick,
    }),
    /pass a Page ID/,
  );
  assert.ok(store.peek().reconciliation_required, "a refused adoption keeps the record");
  assert.equal(store.peek().pages[sibling.source_page_id], undefined);
  for (const page of [old, elsewhere, renamed, recent])
    assert.deepEqual(
      target.pages.get(page.page_id).blocks.map((block) => block.markdown),
      ["Unrelated."],
      "no candidate was overwritten",
    );

  await assert.rejects(
    importBundle(client(target, TARGET), bundle, {
      store,
      reconcile: true,
      acceptMissing: true,
      ...quick,
    }),
    /Choose one of/,
  );
  const report = await importBundle(client(target, TARGET), bundle, {
    store,
    acceptMissing: true,
    ...quick,
  });
  const created = target.pages.get(store.peek().pages[sibling.source_page_id]);
  assert.ok(![old, elsewhere, renamed, recent].some((page) => page.page_id === created.page_id));
  assert.match(created.blocks[0].markdown, /^See \[child\]/);
  assert.equal(report.verification.ok, true);
});

test("an expired Project create is adopted only by explicit ID", async () => {
  const { bundle } = linkBundle();
  const target = fakePages(TARGET);
  const store = memoryStore();
  target.hooks.dropResponse = (name) => name === "create_project";
  await assert.rejects(
    importBundle(client(target, TARGET), bundle, { store, attempts: 1, ...quick }),
    (error) => error.uncertain,
  );
  target.hooks.dropResponse = null;
  target.hooks.before = (name) =>
    name === "create_project"
      ? { ok: false, body: { error: "Retry window expired", code: "retry_expired" } }
      : undefined;
  await assert.rejects(
    importBundle(client(target, TARGET), bundle, { store, ...quick }),
    /reconcile/,
  );
  target.hooks.before = null;
  const unrelated = target.seedProject({ title: "Linked guide" });
  target.projects.get(unrelated.project_id).created_at = "2026-10-01T00:00:00.000Z";
  const listed = await importBundle(client(target, TARGET), bundle, {
    store,
    reconcile: true,
    ...quick,
  });
  assert.equal(listed.reconciliation.candidates.length, 2);
  assert.equal(target.projects.size, 2);
  await assert.rejects(
    importBundle(client(target, TARGET), bundle, { store, adopt: unrelated.project_id, ...quick }),
    /before the create was sent/,
  );
  const made = listed.reconciliation.candidates.find((entry) => entry.created_after_request);
  const report = await importBundle(client(target, TARGET), bundle, {
    store,
    adopt: made.project_id,
    ...quick,
  });
  assert.equal(report.project_id, made.project_id);
  assert.equal(target.projects.size, 2);
  assert.equal(report.verification.ok, true);
});

test("an expired body batch is rewritten from a fresh read and converges", async () => {
  for (const applied of [false, true]) {
    const { bundle } = linkBundle();
    const blocks = Array.from({ length: EDIT_BATCH + 30 }, (_, index) => `Block ${index}`);
    bundle.pages[2].blocks = blocks;
    bundle.pages[2].markdown = blocks.join("\n\n");
    const target = fakePages(TARGET);
    const store = memoryStore();
    // The Sibling's second batch is the fourth edit_page: home, Child, batch one.
    const second = (name, _args, count) => name === "edit_page" && count === 4;
    if (applied) target.hooks.dropResponse = second;
    else target.hooks.before = (...args) => (second(...args) ? "lost" : undefined);
    await assert.rejects(
      importBundle(client(target, TARGET), bundle, { store, attempts: 1, ...quick }),
      (error) => error.uncertain,
    );
    assert.equal(store.peek().pending.operation, "edit_page");
    target.hooks.dropResponse = null;
    const expired = store.peek().pending.args.idempotency_key;
    target.hooks.before = (name, args) =>
      name === "edit_page" && args.idempotency_key === expired
        ? { ok: false, body: { error: "Retry window expired", code: "retry_expired" } }
        : undefined;
    const report = await importBundle(client(target, TARGET), bundle, { store, ...quick });
    const page = target.pages.get(store.peek().pages[bundle.pages[2].source_page_id]);
    assert.deepEqual(
      page.blocks.map((block) => block.markdown),
      blocks,
      `converged after an expired batch that was ${applied ? "" : "not "}applied`,
    );
    assert.equal(store.peek().reconciliation_required, null);
    assert.equal(store.peek().pending, null);
    assert.equal(report.verification.ok, true);
  }
});
