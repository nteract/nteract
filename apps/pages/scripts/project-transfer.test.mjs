import assert from "node:assert/strict";
import { mkdtemp, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { generateKeyBetween } from "fractional-indexing";
import { inspectAsset } from "../worker/image-assets.mjs";
import { createHash } from "node:crypto";
import { imageAssetUrl as assetPath } from "../shared/image-assets.mjs";
import {
  BUNDLE_FORMAT,
  EDIT_BATCH,
  RECEIPT_WINDOW_MS,
  STATE_VERSION,
  TransferError,
  bodyOperations,
  bodyUnits,
  exportProject,
  fileStore,
  importBundle,
  imageInventory,
  remapImages,
  memoryStore,
  pagesClient,
  planImport,
  rewriteLinks,
  targetPlacement,
  themeBodyTransition,
  validateBundle,
} from "./project-transfer.mjs";

const SOURCE = "https://source.example";
const TARGET = "https://target.example";
const KEY = "pages-test-key-0123456789";
const quick = { sleep: async () => {}, now: () => Date.parse("2026-11-01T00:00:00Z") };
// A rerun once the target may have collected the first run's receipts.
const expired = { ...quick, now: () => quick.now() + RECEIPT_WINDOW_MS };
const MUTATIONS = new Set(["create_project", "create_page", "edit_page"]);
test("theme body lifecycle transition table persists batch progress and rejects invalid events", () => {
  const operations = Array(EDIT_BATCH + 1).fill({ op: "set_image" });
  const installing = themeBodyTransition(null, { type: "plan", operations, revision: "r1" });
  const partial = themeBodyTransition(installing, { type: "receipt", revision: "r2" });
  assert.equal(partial.next, EDIT_BATCH);
  const installed = themeBodyTransition(partial, { type: "receipt", revision: "r3" });
  const variants = themeBodyTransition(installed, { type: "discover", operations });
  const remaining = themeBodyTransition(variants, { type: "receipt", revision: "r4" });
  const done = themeBodyTransition(remaining, { type: "receipt", revision: "r5" });
  assert.deepEqual(done, { phase: "done", revision: "r5" });
  for (const state of [null, installing, installed, variants, done])
    for (const type of ["plan", "discover", "receipt", "unknown"]) {
      const allowed =
        (type === "plan" && state === null) ||
        (type === "discover" && state === installed) ||
        (type === "receipt" && [installing, variants].includes(state));
      if (!allowed) assert.throws(() => themeBodyTransition(state, { type }), /Invalid persisted/);
    }
});
const PARQUET = "application/vnd.apache.parquet";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAFElEQVR4nGP07NrPAAZMEIqBgQEAHAoBlkMvCokAAAAASUVORK5CYII=",
  "base64",
);

/**
 * An in-memory Pages target behind a fetch function that speaks the same
 * stateless JSON-RPC tools/call as /mcp. It enforces the retry contract the
 * importer depends on: a nonce is the caller's own, and replays its receipt
 * only for the identical payload. A Project's content
 * is a document in `pages` flagged `content`: never listed, addressed by the
 * Page tools through project_id, named by get_project as document_id.
 */
function fakePages(origin, { outlinePage = 100, token = KEY, insertNode = true } = {}) {
  const pages = new Map();
  // Stored asset bytes by "<page_id>/<asset_id>", as the asset routes keep them.
  const assets = new Map();
  const assetCalls = [];
  const projects = new Map();
  const receipts = new Map();
  const calls = [];
  const counts = new Map();
  // Pages whose explicit reads exceed the response budget.
  const oversize = new Set();
  let clock = 0;
  // Server time for created_at, a second per creation from the importer's
  // fixed clock (quick.now), so everything the fake makes is newer.
  let serverTime = Date.parse("2026-11-01T00:00:00Z");
  const createdAt = () => new Date((serverTime += 1000)).toISOString();
  // dropResponse: apply, then lose the response. before: answer without
  // applying ("lost" loses the request; an object is the tool's result).
  const hooks = { dropResponse: null, before: null };
  // Answer every asset request with a refusal an API key can still get (a
  // Page trashed mid-export, say).
  let refuseAssets = false;
  const fail = (code, error = code) => ({ ok: false, body: { error, code } });
  // A Page's revision handle, as the host names it.
  const revisionOf = (page) => `r${page.revision}`;
  const siblings = (projectId, parentId) =>
    [...pages.values()].filter(
      (page) => page.project_id === projectId && page.parent_id === parentId,
    );
  function insert({
    title,
    blocks,
    project_id = null,
    parent_id = null,
    content = false,
    position,
  }) {
    const last = siblings(project_id, parent_id)
      .map((page) => page.position)
      .sort()
      .at(-1);
    const page = {
      page_id: crypto.randomUUID(),
      title,
      project_id,
      parent_id,
      content,
      position: position ?? generateKeyBetween(last ?? null, null),
      blocks: blocks.map((block) =>
        typeof block === "string"
          ? { id: crypto.randomUUID(), markdown: block }
          : { id: crypto.randomUUID(), ...block },
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
    const content = insert({
      title,
      blocks: [`${description || "Describe it."}\n\n## Guidance\n\nThe Project's content.`],
      project_id,
      content: true,
    });
    projects.set(project_id, {
      project_id,
      title,
      description,
      document_id: content.page_id,
      created_at: content.created_at,
    });
    return { project_id, content };
  }
  const row = (page) => ({
    page_id: page.page_id,
    title: page.title,
    created_at: page.created_at,
    ...(page.project_id && {
      project_id: page.project_id,
      parent_id: page.parent_id,
      position: page.position,
    }),
  });
  /** The document a Page tool addresses: page_id, or project_id for content. */
  function resolve(args) {
    if (args.page_id !== undefined && args.project_id !== undefined)
      return { error: fail("invalid_arguments", "Give page_id or project_id, not both") };
    if (args.project_id !== undefined) {
      const project = projects.get(args.project_id);
      if (!project) return { error: fail("project_not_found") };
      const { project_id: _project, page_id: _page, ...rest } = args;
      return {
        page: pages.get(project.document_id),
        rest,
        extra: { kind: "project", project_id: project.project_id },
      };
    }
    const page = pages.get(args.page_id);
    if (!page) return { error: fail("page_not_found") };
    const { page_id: _selector, ...rest } = args;
    return { page, rest, extra: { kind: "page" } };
  }
  const outline = (page) =>
    page.blocks.map((block) => ({
      node_id: block.id,
      block: block.id,
      type: block.type ?? "paragraph",
      ...(block.attrs && { attrs: block.attrs }),
      ...(imageInventory([block.markdown ?? ""]).length && {
        summary: {
          images: imageInventory([block.markdown]).map((image, index) => ({
            ...image,
            node_id: `${index}@${block.id}`,
            ...block.variants?.[index],
          })),
        },
      }),
    }));
  // A block may list its own outline entries, for a dataframe inside it.
  const entriesOf = (page) =>
    page.blocks.flatMap((block) =>
      block.outline
        ? block.outline.map((entry) => ({ node_id: block.id, block: block.id, ...entry }))
        : [outline({ blocks: [block] })[0]],
    );
  const assetPath = (pageId, assetId) => `/api/pages/${pageId}/assets/${assetId}`;
  /** A block holding one dataframe, read back as the server does. */
  const dataframeBlock = (pageId, { asset_id, media_type, title }) => ({
    id: crypto.randomUUID(),
    type: "dataframe",
    markdown: `[Dataframe${title ? `: ${title}` : ""}](${assetPath(pageId, asset_id)})`,
    attrs: { asset_id, src: assetPath(pageId, asset_id), media_type, ...(title && { title }) },
  });
  async function idempotent(name, args, apply) {
    const key = args.nonce;
    if (typeof key !== "string" || !/^[A-Za-z0-9_-]{6,64}$/.test(key))
      return fail(
        "invalid_nonce",
        "nonce must contain 6–64 letters, digits, underscores or hyphens",
      );
    const receiptKey = key;
    const fingerprint = JSON.stringify([name, args]);
    const stored = receipts.get(receiptKey);
    if (stored)
      return stored.fingerprint === fingerprint
        ? { ok: true, body: stored.body, replayed: true }
        : fail("nonce_conflict");
    const result = apply();
    if (result.ok) receipts.set(receiptKey, { fingerprint, body: result.body });
    return result;
  }
  const tools = {
    async list_pages(args) {
      // The content document is the Project's, never a listed Page.
      let rows = [...pages.values()]
        .filter((page) => !page.content)
        .sort((a, b) => b.changed - a.changed);
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
        },
      };
    },
    async list_projects() {
      return {
        ok: true,
        body: {
          projects: [...projects.values()].map(({ project_id, title, document_id }) => ({
            project_id,
            title,
            document_id,
            role: "owner",
          })),
          next_cursor: null,
        },
      };
    },
    async get_project(args) {
      const project = projects.get(args.project_id);
      return project
        ? { ok: true, body: { ...project, revision: 0, role: "owner", owner: "anaconda:owner" } }
        : fail("project_not_found");
    },
    create_project: (args) =>
      idempotent("create_project", args, () => {
        const { project_id, content } = seedProject(args);
        return {
          ok: true,
          body: {
            project_id,
            title: args.title,
            description: args.description ?? "",
            document_id: content.page_id,
            revision: 0,
            role: "owner",
          },
        };
      }),
    create_page: (args) =>
      idempotent("create_page", args, () => {
        let project_id = args.project_id ?? null;
        let parent_id = args.parent_id ?? null;
        if (parent_id) {
          const parent = pages.get(parent_id);
          if (!parent || parent.content) return fail("parent_unavailable");
          project_id = parent.project_id;
        } else if (project_id && !projects.has(project_id)) return fail("project_not_found");
        const page = insert({
          title: args.title,
          blocks: [args.markdown ?? ""],
          project_id,
          parent_id,
        });
        return { ok: true, body: { page_id: page.page_id, project_id, parent_id } };
      }),
    async read_page(args) {
      const { page, rest, extra, error } = resolve(args);
      if (error) return error;
      const common = {
        ...extra,
        page_id: page.page_id,
        title: page.title,
        revision: revisionOf(page),
      };
      const blocks = page.blocks.map(({ id, kind, markdown }) => ({
        node_id: id,
        ...(kind && { kind }),
        markdown,
      }));
      args = rest;
      if (Object.keys(args).length === 0)
        return {
          ok: true,
          body: { ...common, blocks, comments: page.comments },
        };
      const offset = args.outline_offset ?? 0;
      if (offset > 0 && !args.revision) return fail("invalid_read_selector");
      if (args.revision && args.revision !== revisionOf(page)) return fail("read_revision_changed");
      if (args.include_content !== false && oversize.has(page.page_id))
        return fail("read_budget_exceeded");
      const entries = entriesOf(page);
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
        },
      };
    },
    edit_page: (args) =>
      idempotent("edit_page", args, () => {
        const { page, error } = resolve(args);
        if (error) return error;
        if (args.revision !== revisionOf(page)) return fail("edit_conflict");
        for (const op of args.operations) {
          // after_node_id null puts a new block first; omitted appends.
          const place = (block) =>
            op.after_node_id === null ? page.blocks.unshift(block) : page.blocks.push(block);
          if (op.op === "set_title") page.title = op.title;
          else if (op.op === "insert_markdown")
            place({ id: crypto.randomUUID(), markdown: op.markdown });
          else if (op.op === "insert_node") {
            const { attrs } = op.node;
            // validateNodeInsertion's shape (model/page.mjs).
            if (
              op.node.type !== "dataframe" ||
              Object.keys(attrs).some(
                (key) => !["asset_id", "media_type", "title"].includes(key),
              ) ||
              (attrs.media_type !== undefined && attrs.media_type !== PARQUET) ||
              (attrs.title !== undefined &&
                (typeof attrs.title !== "string" || attrs.title.length > 200))
            )
              return fail("invalid_node");
            const { asset_id } = attrs;
            if (!assets.has(`${page.page_id}/${asset_id}`)) return fail("dataset_not_found");
            place(dataframeBlock(page.page_id, op.node.attrs));
          } else if (op.op === "set_image") {
            // An image's id is `<index>@<block id>`, as the outline reports it.
            const [imageIndex, blockId] = op.node_id.split("@");
            const block = page.blocks.find((candidate) => candidate.id === blockId);
            if (!block || !imageInventory([block.markdown])[Number(imageIndex)])
              return fail("node_not_found");
            if (!assets.has(`${page.page_id}/${op.dark_asset_id}`)) return fail("image_not_found");
            block.variants ??= {};
            block.variants[Number(imageIndex)] = {
              dark_src: assetPath(page.page_id, op.dark_asset_id),
              dark_asset_id: op.dark_asset_id,
            };
          } else {
            const index = page.blocks.findIndex((block) => block.id === op.node_id);
            if (index < 0) return fail("block_not_found");
            if (op.op === "delete_block") page.blocks.splice(index, 1);
            else if (op.op === "replace_block_markdown") {
              // The server keeps a dataframe only when its line survives the
              // rewrite (setRichMarkdownKeepingNodes); this fake never sees
              // one survive, so it refuses, as the server does on a drop.
              if (page.blocks[index].type === "dataframe" || page.blocks[index].outline)
                return fail("markdownless_node");
              page.blocks[index].markdown = op.markdown;
            } else return fail("unsupported_operation");
          }
        }
        page.revision++;
        page.changed = ++clock;
        return { ok: true, body: { page_id: page.page_id, revision: revisionOf(page) } };
      }),
  };
  async function assetRoute(url, init) {
    const path = url.slice(origin.length);
    assetCalls.push({ method: init.method, path });
    // The server limits a pages_ token to /mcp by path (worker/auth.mjs).
    if (token.startsWith("pages_"))
      return Response.json({ error: "This credential is limited to Pages MCP" }, { status: 403 });
    if (init.headers.Authorization !== `Bearer ${token}`)
      return Response.json({ error: "unauthorized" }, { status: 401 });
    if (refuseAssets) return Response.json({ error: "Page not found" }, { status: 403 });
    const read = /^\/api\/pages\/([^/]+)\/assets\/([a-f0-9]{64})$/.exec(path);
    if (init.method === "GET" && read) {
      const bytes = assets.get(`${read[1]}/${read[2]}`);
      return bytes ? new Response(bytes) : Response.json({ error: "not found" }, { status: 404 });
    }
    const write = /^\/api\/pages\/([^/]+)\/assets$/.exec(path);
    if (init.method === "POST" && write) {
      if (!pages.has(write[1])) return Response.json({ error: "not found" }, { status: 404 });
      const bytes = new Uint8Array(init.body);
      try {
        inspectAsset(bytes);
      } catch (error) {
        return Response.json({ error: error.message }, { status: error.status ?? 415 });
      }
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
      const asset_id = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      const key = `${write[1]}/${asset_id}`;
      const existed = assets.has(key);
      assets.set(key, bytes);
      return Response.json(
        {
          asset_id,
          asset_url: assetPath(write[1], asset_id),
          mime_type: init.headers["Content-Type"],
        },
        { status: existed ? 200 : 201 },
      );
    }
    return Response.json({ error: "no route" }, { status: 404 });
  }
  async function fetch(url, init) {
    assert.equal(init.headers["X-Pages-Driver"], "Pages project transfer");
    if (url.startsWith(`${origin}/api/pages/`)) return assetRoute(url, init);
    assert.equal(url, `${origin}/mcp`);
    if (init.headers.Authorization !== `Bearer ${token}`)
      return Response.json({ error: "invalid_token" }, { status: 401 });
    const message = JSON.parse(init.body);
    if (message.method === "tools/list") {
      calls.push({ name: "tools/list", args: {}, ok: true, replayed: false });
      const ops = ["replace_block_markdown", "insert_markdown", "delete_block"];
      if (insertNode) ops.push("insert_node");
      ops.push("set_image");
      return Response.json({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          tools: [
            {
              name: "edit_page",
              inputSchema: {
                properties: {
                  operations: {
                    items: { oneOf: ops.map((op) => ({ properties: { op: { const: op } } })) },
                  },
                },
              },
            },
          ],
        },
      });
    }
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
  /** Pages under `parentId` (null: a Project's top level), in position order. */
  const children = (parentId) =>
    [...pages.values()]
      .filter((page) => !page.content && page.parent_id === parentId)
      .sort((a, b) => (a.position < b.position ? -1 : 1));
  /** Store `bytes` on `page` and append a block holding it as a dataframe. */
  async function addDataframe(page, bytes, { title, media_type = PARQUET } = {}) {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    const asset_id = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    assets.set(`${page.page_id}/${asset_id}`, bytes);
    const block = dataframeBlock(page.page_id, { asset_id, media_type, title });
    page.blocks.push(block);
    return { asset_id, line: block.markdown, src: block.attrs.src };
  }
  return {
    refuseAssets: (value) => (refuseAssets = value),
    fetch,
    pages,
    projects,
    calls,
    hooks,
    insert,
    seedProject,
    children,
    oversize,
    assets,
    assetCalls,
    addDataframe,
  };
}

const client = (fake, origin, token = KEY) => pagesClient({ origin, token, fetch: fake.fetch });

async function imageBundle() {
  const source = fakePages(SOURCE);
  const { project_id, content } = source.seedProject({ title: "Images" });
  const id = createHash("sha256").update(PNG).digest("hex");
  const src = assetPath(content.page_id, id);
  const markdown = `> ![quote](${src} "Caption")\n\n- ![list](${src})\n\n| image |\n| --- |\n| ![table](${src}) |\n\n[link](${src})\n\n\`![code](${src})\`\n\n\`\`\`md\n![fenced](${src})\n\`\`\``;
  content.blocks = [{ id: crypto.randomUUID(), markdown }];
  source.assets.set(`${content.page_id}/${id}`, PNG);
  const result = await exportProject(client(source, SOURCE), { projectId: project_id, ...quick });
  return { ...result, source, content, id, src, project_id };
}

test("nested image inventory excludes links/code and remaps only image attrs", async () => {
  const { bundle, source, id, src } = await imageBundle();
  const page = bundle.project.content;
  assert.deepEqual(bundle.pages, [], "the content is not a Page");
  assert.equal(page.images.length, 3);
  assert.equal(Object.keys(bundle.assets).length, 1);
  assert.equal(source.assetCalls.length, 1);
  const target = fakePages(TARGET);
  const store = memoryStore();
  const result = await importBundle(client(target, TARGET), bundle, { store, ...quick });
  const body = target.pages
    .get(result.document_id)
    .blocks.map((block) => block.markdown)
    .join("\n\n");
  assert.deepEqual(
    imageInventory([body]).map((image) => image.src),
    Array(3).fill(assetPath(result.document_id, id)),
  );
  // Content edits went through the Project, not a Page ID.
  const edits = target.calls.filter((call) => call.name === "edit_page");
  assert.ok(edits.length >= 1);
  assert.ok(edits.every((call) => call.args.project_id === result.project_id));
  assert.ok(edits.every((call) => call.args.page_id === undefined));
  assert.ok(body.includes(`[link](${src})`));
  assert.ok(body.includes(`![code](${src})`));
  assert.ok(body.includes(`![fenced](${src})`));
  assert.equal(target.assetCalls.length, 1);
  await importBundle(client(target, TARGET), bundle, { store, ...quick });
  assert.equal(target.assetCalls.length, 1, "completed bodies do not upload again");
  assert.equal(remapImages("unchanged", page.images, result.document_id), "unchanged");
});

test("export discovers dark assets from structured occurrences and refuses truncated facts", async () => {
  const { source, content, id, src, project_id } = await imageBundle();
  content.blocks[0].outline = [
    {
      type: "blockquote",
      summary: {
        images: [
          { node_id: "cursor", path: [0, 0], src, asset_id: id, dark_src: src, dark_asset_id: id },
          { node_id: "second", path: [1, 0], src, asset_id: id },
          { node_id: "third", path: [2, 0], src, asset_id: id },
        ],
      },
    },
  ];
  const { bundle } = await exportProject(client(source, SOURCE), {
    projectId: project_id,
    ...quick,
  });
  assert.deepEqual(bundle.project.content.image_variants, [
    { ordinal: 0, src, dark_src: src, dark_asset_id: id },
  ]);
  assert.equal(Object.keys(bundle.assets).length, 1);
  const target = fakePages(TARGET),
    store = memoryStore();
  const result = await importBundle(client(target, TARGET), bundle, { store, ...quick });
  const targetImage = target.pages.get(result.document_id).blocks[0].variants[0];
  assert.equal(targetImage.dark_src, assetPath(result.document_id, id));
  assert.equal(target.assetCalls.length, 1, "shared light and dark asset uploads once");
  await importBundle(client(target, TARGET), bundle, { store, ...quick });
  assert.equal(target.assetCalls.length, 1);
  content.blocks[0].outline[0].summary.images_truncated = true;
  await assert.rejects(
    exportProject(client(source, SOURCE), { projectId: project_id, ...quick }),
    /truncated/,
  );
});

test("private images require source/target asset credentials and missing bytes fail before writes", async () => {
  const { bundle, source, project_id } = await imageBundle();
  await assert.rejects(
    exportProject(
      { ...client(source, SOURCE), assets: false },
      { projectId: project_id, ...quick },
    ),
    { code: "assets_unauthorized" },
  );
  const target = fakePages(TARGET);
  await assert.rejects(
    importBundle({ ...client(target, TARGET), assets: false }, bundle, {
      store: memoryStore(),
      ...quick,
    }),
    { code: "assets_unauthorized" },
  );
  const missing = structuredClone(bundle);
  missing.assets = {};
  await assert.rejects(
    importBundle(client(target, TARGET), missing, { store: memoryStore(), ...quick }),
    /missing bytes/,
  );
  assert.equal(target.calls.length, 0);
  source.assets.clear();
  await assert.rejects(exportProject(client(source, SOURCE), { projectId: project_id, ...quick }), {
    status: 404,
  });
});

test("image upload uncertainty resumes before remapping without duplicate stored assets", async () => {
  const { bundle } = await imageBundle();
  const target = fakePages(TARGET);
  const normal = client(target, TARGET);
  let lose = true;
  const flaky = {
    ...normal,
    upload: async (...args) => {
      const result = await normal.upload(...args);
      if (lose) {
        lose = false;
        throw new TransferError("lost upload response", { uncertain: true });
      }
      return result;
    },
  };
  const store = memoryStore();
  await assert.rejects(
    importBundle(flaky, bundle, { store, attempts: 1, ...quick }),
    /lost upload/,
  );
  assert.equal(target.assets.size, 1);
  const result = await importBundle(flaky, bundle, { store, ...quick });
  assert.equal(target.assets.size, 1);
  assert.equal(result.verification.ok, true);
});

test("interrupted duplicate-image variant import replays without rewriting its installed body", async () => {
  const { bundle, id, src } = await imageBundle();
  const entry = bundle.project.content;
  entry.markdown = `![same](${src}) ![same](${src})`;
  entry.images = imageInventory([entry.markdown]);
  entry.image_variants = [{ ordinal: 0, src, dark_src: src, dark_asset_id: id }];
  const target = fakePages(TARGET),
    normal = client(target, TARGET),
    store = memoryStore();
  let lose = true,
    installed = false;
  const flaky = {
    ...normal,
    call: async (name, args) => {
      if (
        installed &&
        name === "edit_page" &&
        args.operations.some((op) => op.op === "replace_block_markdown")
      )
        assert.fail("rewrote installed duplicate images with hidden attrs");
      const result = await normal.call(name, args);
      if (name === "edit_page" && args.operations.some((op) => op.op === "set_image")) {
        installed = true;
        if (lose) {
          lose = false;
          throw new TransferError("lost variant response", { uncertain: true });
        }
      }
      return result;
    },
  };
  await assert.rejects(
    importBundle(flaky, bundle, { store, ...quick, attempts: 1 }),
    /lost variant/,
  );
  const result = await importBundle(flaky, bundle, { store, ...quick });
  assert.equal(result.verification.ok, true);
  assert.equal(target.pages.get(result.document_id).blocks[0].variants[0].dark_asset_id, id);
});

for (const stage of ["discovery", "between batches"])
  test(`same-src peer insertion ${stage} fails instead of rebasing variant ordinals`, async () => {
    const { bundle, id, src } = await imageBundle();
    const count = stage === "discovery" ? 2 : 101;
    const markdown = Array(count).fill(`![same](${src})`).join(" ");
    const entry = bundle.project.content;
    entry.markdown = markdown;
    entry.images = imageInventory([markdown]);
    entry.image_variants = Array.from({ length: count }, (_, ordinal) => ({
      ordinal,
      src,
      dark_src: src,
      dark_asset_id: id,
    }));
    const target = fakePages(TARGET),
      normal = client(target, TARGET),
      store = memoryStore();
    let changed = false,
      variantWrites = 0;
    const peer = {
      ...normal,
      call: async (name, args) => {
        const result = await normal.call(name, args);
        if (name === "edit_page") {
          const variants = args.operations.some((op) => op.op === "set_image");
          if (variants) variantWrites++;
          if (!changed && (stage === "discovery" ? !variants : variants)) {
            changed = true;
            // The content edit is addressed by project_id; find its document.
            const page = target.pages.get(target.projects.get(args.project_id).document_id);
            page.blocks[0].markdown =
              `![same](${assetPath(page.page_id, id)}) ` + page.blocks[0].markdown;
            page.revision++;
          }
        }
        return result;
      },
    };
    await assert.rejects(importBundle(peer, bundle, { store, ...quick }), {
      code: "transfer_revision_changed",
    });
    assert.equal(variantWrites, stage === "discovery" ? 0 : 1);
    await assert.rejects(importBundle(normal, bundle, { store, ...quick }), {
      code: "transfer_revision_changed",
    });
  });

test("asset download enforces declared and streamed byte limits and never redirects", async () => {
  const path = assetPath(crypto.randomUUID(), "a".repeat(64));
  for (const headers of [{ "content-length": "10" }, {}]) {
    const c = pagesClient({
      origin: SOURCE,
      token: KEY,
      fetch: async (_url, init) => {
        assert.equal(init.redirect, "error");
        return new Response(new Uint8Array(10), { headers });
      },
    });
    await assert.rejects(c.download(path, 5), /byte limit/);
  }
});

test("duplicate images upload once per destination document and keep titles", async () => {
  const { bundle, id } = await imageBundle();
  const { source_document_id: _content, ...body } = bundle.project.content;
  const child = {
    source_page_id: crypto.randomUUID(),
    parent_source_id: null,
    position: null,
    ...structuredClone(body),
    title: "Child",
  };
  bundle.pages.push(child);
  const target = fakePages(TARGET);
  const report = await importBundle(client(target, TARGET), bundle, {
    store: memoryStore(),
    ...quick,
  });
  assert.equal(report.verification.ok, true);
  assert.equal(target.assets.size, 2);
  assert.equal(target.assetCalls.length, 2);
  for (const page of target.pages.values()) {
    const markdown = page.blocks.map((block) => block.markdown).join("\n\n");
    assert.ok(markdown.includes('"Caption"'));
    assert.deepEqual(
      imageInventory([markdown]).map((image) => image.src),
      Array(3).fill(assetPath(page.page_id, id)),
    );
  }
  const creation = target.calls.find((call) => call.name === "create_page");
  assert.equal(creation.args.markdown, "", "never install source image references before upload");
});

test("image bundle validation rejects invalid inventory, media and corrupt containers before writes", async () => {
  const { bundle, id } = await imageBundle();
  const target = fakePages(TARGET);
  for (const mutate of [
    (value) => {
      value.project.content.images.pop();
    },
    (value) => {
      value.assets[id].media_type = PARQUET;
    },
    (value) => {
      value.assets[id].data = Buffer.from("invalid PNG").toString("base64");
    },
  ]) {
    const broken = structuredClone(bundle);
    mutate(broken);
    await assert.rejects(
      importBundle(client(target, TARGET), broken, { store: memoryStore(), ...quick }),
    );
  }
  assert.equal(target.calls.length, 0);
  // Bundles from before the content model are refused, never read.
  for (const version of [1, 2, 3, 4]) {
    const legacy = structuredClone(bundle);
    legacy.version = version;
    assert.throws(
      () => validateBundle(legacy),
      (error) =>
        error.code === "bundle_version_unsupported" &&
        /Export the Project again/.test(error.message),
      String(version),
    );
    await assert.rejects(
      importBundle(client(target, TARGET), legacy, { store: memoryStore(), ...quick }),
      { code: "bundle_version_unsupported" },
    );
  }
  assert.equal(target.calls.length, 0);
});

test("an unreadable upload receipt is retryable, without exposing credentials", async () => {
  const c = pagesClient({
    origin: SOURCE,
    token: KEY,
    fetch: async () => new Response("not JSON"),
  });
  await assert.rejects(
    c.upload(crypto.randomUUID(), PNG, "image/png"),
    (error) => error.uncertain && !error.message.includes(KEY),
  );
});

/** A source Project: content plus top-level Pages with parent_id null. */
function guideSource({ preservedType = "pages-opaque", ...options } = {}) {
  const source = fakePages(SOURCE, options);
  const { project_id, content } = source.seedProject({
    title: "Pages engineering guide",
    description: "How Pages is built.",
  });
  const at = (title, blocks, position, parent = null) =>
    source.insert({ title, blocks, project_id, parent_id: parent?.page_id ?? null, position });
  const before = at("Before", ["Sorted first at the top level."], "a0");
  const zeta = at("Zeta", ["Last at the top level."], "a3");
  const alpha = at("Alpha", ["First section.", { markdown: "$$x$$", type: preservedType }], "a2");
  const two = at("Alpha two", ["Second child."], "a1", alpha);
  const one = at(
    "Alpha one",
    [
      "[diagram](/api/pages/" +
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
  for (const [index, page] of [deep, zeta, one, content, before, two, alpha].entries())
    page.changed = 100 - index;
  return { source, project_id, content, before, zeta, alpha, two, one, deep };
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

test("export carries the content by document_id and Pages in tree order, siblings by position", async () => {
  const { bundle, report, source, content, before, zeta, alpha, two, one, deep, project_id } =
    await exportGuide({ outlinePage: 1 });
  assert.equal(bundle.format, BUNDLE_FORMAT);
  assert.equal(bundle.version, 5);
  assert.equal(bundle.bundle_id, "3f0d6c2e-1f7b-4b8e-9a51-0c2d5e7f8a90");
  assert.deepEqual(bundle.source, { origin: SOURCE, project_id, document_id: content.page_id });
  assert.equal(bundle.exported_at, "2026-11-01T00:00:00.000Z");
  assert.equal(bundle.project.title, "Pages engineering guide");
  assert.equal(bundle.project.description, "How Pages is built.");
  assert.equal(bundle.project.content.source_document_id, content.page_id);
  assert.equal(bundle.project.content.title, "Pages engineering guide");
  assert.match(bundle.project.content.markdown, /The Project's content\.$/);
  for (const key of ["source_page_id", "parent_source_id", "position"])
    assert.equal(Object.hasOwn(bundle.project.content, key), false, key);
  // The content was read through its Project, never by a Page ID.
  const contentReads = source.calls.filter(
    (call) => call.name === "read_page" && call.args.project_id === project_id,
  );
  assert.ok(contentReads.length >= 1);
  assert.ok(contentReads.every((call) => call.args.page_id === undefined));
  assert.ok(
    source.calls.every(
      (call) => call.name !== "read_page" || call.args.page_id !== content.page_id,
    ),
  );
  assert.deepEqual(
    bundle.pages.map((page) => [page.title, page.parent_source_id, page.position]),
    [
      ["Before", null, "a0"],
      ["Alpha", null, "a2"],
      ["Alpha one", alpha.page_id, "a0"],
      ["Alpha one deep", one.page_id, "a0"],
      ["Alpha two", alpha.page_id, "a1"],
      ["Zeta", null, "a3"],
    ],
  );
  assert.deepEqual(
    bundle.pages.map((page) => page.source_page_id),
    [before, alpha, one, deep, two, zeta].map((page) => page.page_id),
  );
  validateBundle(bundle);

  const alphaEntry = bundle.pages[1];
  assert.deepEqual(alphaEntry.blocks, ["First section.", "$$x$$"]);
  assert.equal(alphaEntry.markdown, "First section.\n\n$$x$$");
  // The preserved node is on the second outline page; only paging finds it.
  assert.equal(alphaEntry.preserved_markdown, true);
  assert.equal(bundle.pages[0].blocks, undefined, "a single block needs no blocks array");
  assert.equal(bundle.pages[2].private_images.length, 0);
  assert.equal(bundle.pages[2].comment_threads, 2);
  assert.deepEqual(
    report.preserved_markdown.map((page) => page.title),
    ["Alpha"],
  );
  assert.deepEqual(
    report.private_images.map((page) => page.title),
    [],
  );
  assert.equal(report.comment_threads, 2);
});

test("export flags preserved Markdown from a source that still reports raw", async () => {
  const { report, bundle } = await exportGuide({ outlinePage: 1, preservedType: "raw" });
  assert.equal(bundle.pages.find((page) => page.title === "Alpha").preserved_markdown, true);
  assert.deepEqual(
    report.preserved_markdown.map((page) => page.title),
    ["Alpha"],
  );
});

test("export reads a format 2 source, whose blocks carry no kind, as Markdown", async () => {
  const source = fakePages(SOURCE);
  const { project_id, content } = source.seedProject({ title: "Format 2" });
  content.blocks = [{ id: crypto.randomUUID(), markdown: "Plain block." }];
  const { bundle } = await exportProject(client(source, SOURCE), {
    projectId: project_id,
    ...quick,
  });
  assert.equal(bundle.project.content.preserved_markdown, false);
  assert.equal(bundle.project.content.markdown, "Plain block.");
});

test("export reads a format 1 source: kind markdown is plain, any other kind is preserved", async () => {
  for (const [kind, preserved] of [
    ["markdown", false],
    ["html", true],
  ]) {
    const source = fakePages(SOURCE);
    const { project_id, content } = source.seedProject({ title: "Format 1" });
    content.blocks = [{ id: crypto.randomUUID(), kind, markdown: "Block." }];
    const { bundle } = await exportProject(client(source, SOURCE), {
      projectId: project_id,
      ...quick,
    });
    assert.equal(bundle.project.content.preserved_markdown, preserved, kind);
  }
});

test("export does not flag a Page whose outline has only rich nodes", async () => {
  const { bundle } = await exportGuide({ outlinePage: 1, preservedType: "code-block" });
  assert.equal(bundle.pages.find((page) => page.title === "Alpha").preserved_markdown, false);
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

test("import fills the content through project_id, puts the top level at parent null and keeps order", async () => {
  const { bundle } = await exportGuide();
  const target = fakePages(TARGET);
  const store = memoryStore();
  const report = await importBundle(client(target, TARGET), bundle, { store, ...quick });

  assert.equal(target.projects.size, 1);
  const [project] = target.projects.values();
  assert.equal(project.title, "Pages engineering guide");
  assert.equal(project.description, "How Pages is built.");
  assert.equal(
    target.pages.size,
    bundle.pages.length + 1,
    "the content document and the Pages, nothing more",
  );

  const state = store.peek();
  const id = (title) =>
    state.pages[bundle.pages.find((page) => page.title === title).source_page_id];
  const content = target.pages.get(project.document_id);
  assert.equal(state.pages[bundle.project.content.source_document_id], content.page_id);
  assert.equal(content.content, true);
  assert.deepEqual(
    content.blocks.map((block) => block.markdown),
    [bundle.project.content.markdown],
  );
  const contentEdits = target.calls.filter(
    (call) => call.name === "edit_page" && call.args.project_id === project.project_id,
  );
  assert.ok(contentEdits.length >= 1, "the content was written through its Project");
  assert.ok(
    target.calls.every((call) => call.args?.page_id !== content.page_id),
    "the content document was never addressed by page_id",
  );
  assert.deepEqual(
    target.children(null).map((page) => page.title),
    ["Before", "Alpha", "Zeta"],
  );
  // Top-level creates name the Project and nothing else as placement.
  const roots = target.calls.filter(
    (call) => call.name === "create_page" && call.args.parent_id === undefined,
  );
  assert.deepEqual(
    roots.map((call) => [call.args.title, call.args.project_id]),
    [
      ["Before", project.project_id],
      ["Alpha", project.project_id],
      ["Zeta", project.project_id],
    ],
  );
  assert.ok(
    target.calls.every(
      (call) =>
        call.name !== "create_page" ||
        (call.args.parent_id === undefined) !== (call.args.project_id === undefined),
    ),
    "a create names a parent or the Project, never both",
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
    // Math becomes the literal text Page10 accepts.
    ["First section.", "\\$\\$x\\$\\$"],
  );
  for (const call of target.calls.filter((call) => MUTATIONS.has(call.name))) {
    assert.match(call.args.nonce, /^[a-f0-9]{40}$/);
    assert.equal(call.args.retry_token, undefined);
  }

  assert.equal(report.verification.ok, true, report.verification.problems.join("\n"));
  assert.equal(report.pages, 6);
  assert.equal(report.created, 6);
  assert.equal(report.document_id, project.document_id);
  assert.equal(report.comment_threads_not_migrated, 2);
  assert.deepEqual(
    report.preserved_markdown.map((page) => page.title),
    ["Alpha"],
  );
  assert.deepEqual(
    report.private_images.map((page) => page.title),
    [],
  );
  assert.equal(report.url, `${TARGET}/project/${project.project_id}`);
  // Nothing in the report, the state or the bundle names the removed concept.
  assert.doesNotMatch(JSON.stringify([report, store.peek(), bundle]), /home/i);
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
  assert.equal(target.pages.size, bundle.pages.length + 1);
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
    content: "11111111-1111-4111-8111-111111111111",
    child: "22222222-2222-4222-8222-222222222222",
    sibling: "33333333-3333-4333-8333-333333333333",
    outside: "44444444-4444-4444-8444-444444444444",
  };
  const project = "prj_55555555-5555-4555-8555-555555555555";
  const body = (title, markdown) => ({
    title,
    markdown,
    preserved_markdown: false,
    private_images: [],
    images: [],
    comment_threads: 0,
  });
  const page = (source_page_id, title, markdown, parent_source_id = null) => ({
    source_page_id,
    parent_source_id,
    position: null,
    ...body(title, markdown),
  });
  return {
    ids,
    project,
    bundle: {
      format: BUNDLE_FORMAT,
      version: 5,
      bundle_id: "links-0000-bundle",
      source: { origin: SOURCE, project_id: project, document_id: ids.content },
      exported_at: "2026-11-01T00:00:00.000Z",
      project: {
        title: "Linked guide",
        description: "",
        content: {
          source_document_id: ids.content,
          ...body("Linked guide", `Start at [the child](${SOURCE}/p/${ids.child}#intro).`),
        },
      },
      pages: [
        page(
          ids.child,
          "Child",
          `Back [to the content](${SOURCE}/?page=${ids.content}) or the [Project](${SOURCE}/project/${project}).`,
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
  assert.equal(body(ids.content), `Start at [the child](${TARGET}/p/${map[ids.child]}#intro).`);
  assert.equal(map[ids.content], project.document_id, "the content maps to the target document");
  assert.equal(
    body(ids.child),
    `Back [to the content](${TARGET}/p/${map[ids.content]}) or the [Project](${TARGET}/project/${project.project_id}).`,
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

test("the content document takes the source content's title and body; no Page is created for it", async () => {
  const { bundle } = linkBundle();
  bundle.project.content.title = "Start here";
  const target = fakePages(TARGET);
  await importBundle(client(target, TARGET), bundle, { store: memoryStore(), ...quick });
  const [project] = target.projects.values();
  const content = target.pages.get(project.document_id);
  assert.equal(project.title, "Linked guide");
  assert.equal(content.title, "Start here");
  assert.equal(content.blocks.length, 1);
  assert.match(content.blocks[0].markdown, /^Start at \[the child\]/);
  assert.equal(target.pages.size, 3);
  assert.equal([...target.pages.values()].filter((page) => page.title === "Start here").length, 1);
  assert.equal(target.children(null).length, 1, "Child is the only top-level Page");
});

test("a body longer than one edit batch keeps its block order", async () => {
  const { bundle } = linkBundle();
  const blocks = Array.from({ length: EDIT_BATCH + 30 }, (_, index) => `Block ${index}`);
  bundle.pages[1].blocks = blocks;
  bundle.pages[1].markdown = blocks.join("\n\n");
  const target = fakePages(TARGET);
  const store = memoryStore();
  await importBundle(client(target, TARGET), bundle, { store, ...quick });
  const sibling = target.pages.get(store.peek().pages[bundle.pages[1].source_page_id]);
  assert.deepEqual(
    sibling.blocks.map((block) => block.markdown),
    blocks,
  );
  const edits = target.calls.filter(
    (call) => call.name === "edit_page" && call.args.page_id === sibling.page_id,
  );
  assert.equal(edits.length, 2);
  assert.notEqual(edits[0].args.nonce, edits[1].args.nonce);
});

test("the state file is written atomically and readable only by its owner", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "project-transfer-"));
  const file = path.join(dir, "bundle.json.state.json");
  const store = fileStore(file);
  assert.equal(await store.load(), null);
  await store.save({ format: "x", pending: { args: { nonce: "t" } } });
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual((await store.load()).pending.args, { nonce: "t" });
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
    version: STATE_VERSION,
    bundle_id: "another-bundle",
    target_origin: TARGET,
  });
  await assert.rejects(
    importBundle(client(target, TARGET), bundle, { store, ...quick }),
    /different bundle/,
  );
});

test("import refuses a version 1 state file, whose keys carry a retry_key_prefix, before any write", async () => {
  const { bundle } = linkBundle();
  const target = fakePages(TARGET);
  const pending = {
    step: `page:${bundle.pages[0].source_page_id}`,
    operation: "create_page",
    args: {
      title: bundle.pages[0].title,
      nonce: `v1_${"a".repeat(64)}_${"b".repeat(40)}`,
    },
  };
  const store = memoryStore({
    format: "nteract-pages-project-import-state",
    version: 1,
    bundle_id: bundle.bundle_id,
    target_origin: TARGET,
    pending,
  });
  await assert.rejects(
    importBundle(client(target, TARGET), bundle, { store, ...quick }),
    (error) =>
      error instanceof TransferError &&
      /version 1; this importer resumes only version 3/.test(error.message) &&
      /Start a new transfer/.test(error.message) &&
      /reconcile the target by hand/.test(error.message),
  );
  assert.equal(target.calls.length, 0);
  assert.deepEqual(store.peek().pending, pending, "the state file is left as it was");
});

test("targetPlacement maps the top level to project_id and nested Pages to their parent", () => {
  const context = {
    projectId: "prj_new",
    pageIds: new Map([["parent", "new-parent"]]),
  };
  assert.deepEqual(targetPlacement({ source_page_id: "a", parent_source_id: null }, context), {
    project_id: "prj_new",
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
  reordered.pages = [reordered.pages[1], reordered.pages[0]];
  assert.throws(() => validateBundle(reordered), /parents come before children/);
  // The content is not a Page: it carries no placement, and no Page is it.
  const placed = structuredClone(bundle);
  placed.project.content.parent_source_id = null;
  assert.throws(
    () => validateBundle(placed),
    /project\.content is not a Page; drop parent_source_id/,
  );
  const asPage = structuredClone(bundle);
  asPage.pages.unshift({
    source_page_id: asPage.source.document_id,
    parent_source_id: null,
    position: null,
    title: "Linked guide",
    markdown: "",
    preserved_markdown: false,
    private_images: [],
    images: [],
    comment_threads: 0,
  });
  assert.throws(() => validateBundle(asPage), /belongs in project\.content/);
  const mismatched = structuredClone(bundle);
  mismatched.project.content.source_document_id = mismatched.pages[0].source_page_id;
  assert.throws(() => validateBundle(mismatched), /must equal source\.document_id/);
  const noContent = structuredClone(bundle);
  delete noContent.project.content;
  assert.throws(() => validateBundle(noContent), /project\.content must describe/);
  assert.deepEqual(
    planImport(bundle).map((step) => [step.title, step.action, step.under]),
    [
      ["Linked guide", "fill the target Project's content", null],
      ["Child", "create", null],
      ["Sibling", "create", "Child"],
    ],
  );
  assert.equal(planImport(bundle)[0].source_document_id, bundle.source.document_id);
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
  const content = target.pages.get(store.peek().pages[ids.content]);
  assert.equal(
    content.blocks[0].markdown,
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

/** The second create's outcome is unknown, and the rerun comes after the
 * target may have collected its receipt. */
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
  target.hooks.before = null;
  const sent = target.calls.length;
  await assert.rejects(
    importBundle(client(target, TARGET), bundle, { store, ...expired }),
    (error) => error.code === "reconciliation_required" && /--reconcile/.test(error.message),
  );
  assert.deepEqual(writes(target, sent), [], "the uncertain create is not sent again");
  const record = store.peek().reconciliation_required;
  return { bundle, target, store, record, sibling: bundle.pages[1] };
}
const writes = (target, from) =>
  target.calls.slice(from).filter((call) => MUTATIONS.has(call.name));

test("an expired create blocks writes; --reconcile lists candidates and --adopt records one", async () => {
  const { bundle, target, store, record, sibling } = await expiredCreate({ applied: true });
  assert.equal(record.step, `page:${sibling.source_page_id}`);
  assert.equal(record.operation, "create_page");
  assert.equal(record.args.title, "Sibling");
  assert.equal(record.requested_at, "2026-11-01T00:00:00.000Z", "kept from the first send");
  assert.match(record.nonce, /^[a-f0-9]{40}$/);
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
  const elsewhere = seed("Sibling", null);
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
  await assert.rejects(
    importBundle(client(target, TARGET), bundle, { store, ...expired }),
    /reconcile/,
  );
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
    bundle.pages[1].blocks = blocks;
    bundle.pages[1].markdown = blocks.join("\n\n");
    const target = fakePages(TARGET);
    const store = memoryStore();
    // The Sibling's second batch is the fourth edit_page: content, Child, batch one.
    const second = (name, _args, count) => name === "edit_page" && count === 4;
    if (applied) target.hooks.dropResponse = second;
    else target.hooks.before = (...args) => (second(...args) ? "lost" : undefined);
    await assert.rejects(
      importBundle(client(target, TARGET), bundle, { store, attempts: 1, ...quick }),
      (error) => error.uncertain,
    );
    assert.equal(store.peek().pending.operation, "edit_page");
    target.hooks.dropResponse = null;
    // The target no longer holds the batch's receipt, so the replay is
    // refused. A batch from a fresh read names a new revision, and so a new
    // nonce.
    const lost = store.peek().pending.args;
    target.hooks.before = (name, args) =>
      name === "edit_page" && args.nonce === lost.nonce
        ? { ok: false, body: { error: "Revision too old to retry", code: "resync_required" } }
        : undefined;
    const report = await importBundle(client(target, TARGET), bundle, { store, ...quick });
    const page = target.pages.get(store.peek().pages[bundle.pages[1].source_page_id]);
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

/** Bytes with a valid Parquet container (worker/image-assets.mjs
 * inspectParquet): PAR1, a body, its length as the footer, PAR1. */
function frameBytes(label) {
  const body = new TextEncoder().encode(label);
  const bytes = new Uint8Array(body.length + 12);
  bytes.set(new TextEncoder().encode("PAR1"), 0);
  bytes.set(body, 4);
  new DataView(bytes.buffer).setUint32(4 + body.length, body.length, true);
  bytes.set(new TextEncoder().encode("PAR1"), body.length + 8);
  return bytes;
}
const base64 = (bytes) => Buffer.from(bytes).toString("base64");

/** A source Project whose content holds two dataframes: one in its own
 * block between prose blocks, and one inside a prose block. */
async function dataframeSource({ token = KEY, ...options } = {}) {
  const source = fakePages(SOURCE, { token, ...options });
  const { project_id, content } = source.seedProject({ title: "Usage report" });
  content.blocks = [{ id: crypto.randomUUID(), markdown: "Intro prose." }];
  const daily = await source.addDataframe(content, frameBytes("daily"), { title: "Usage by day" });
  content.blocks.push({ id: crypto.randomUUID(), markdown: "Between." });
  // A browser drop leaves a dataframe inside a prose block.
  const weekly = await source.addDataframe(content, frameBytes("weekly"), { title: "By week" });
  const dropped = content.blocks.pop();
  content.blocks.push({
    id: crypto.randomUUID(),
    markdown: `Before the drop.\n\n${dropped.markdown}\n\nAfter the drop.`,
    outline: [
      { type: "paragraph" },
      { type: "dataframe", attrs: dropped.attrs },
      { type: "paragraph" },
    ],
  });
  const exporting = () =>
    exportProject(client(source, SOURCE, token), {
      projectId: project_id,
      ...quick,
      uuid: () => "8c1d6c2e-1f7b-4b8e-9a51-0c2d5e7f8a90",
    });
  const { bundle, report } = await exporting();
  return { source, content, daily, weekly, bundle, report, exporting };
}

test("export carries each dataframe's bytes, checked against its asset_id", async () => {
  const { bundle, report, daily, weekly } = await dataframeSource();
  validateBundle(bundle);
  const page = bundle.project.content;
  assert.deepEqual(
    page.dataframes.map((frame) => [frame.asset_id, frame.title]),
    [
      [daily.asset_id, "Usage by day"],
      [weekly.asset_id, "By week"],
    ],
  );
  assert.deepEqual(Object.keys(bundle.assets).sort(), [daily.asset_id, weekly.asset_id].sort());
  assert.equal(bundle.assets[daily.asset_id].data, base64(frameBytes("daily")));
  assert.equal(bundle.assets[daily.asset_id].media_type, PARQUET);
  // A dataframe's asset path isn't a private image.
  assert.deepEqual(page.private_images, []);
  assert.equal(report.dataframes, 2);
  assert.deepEqual(report.dataframes_not_copied, []);
});

test("import stores each dataframe on its target Page and writes it as a node", async () => {
  const { bundle, daily, weekly } = await dataframeSource();
  const target = fakePages(TARGET);
  const store = memoryStore();
  const report = await importBundle(client(target, TARGET), bundle, { store, ...quick });
  assert.equal(report.dataframes, 2);
  assert.deepEqual(report.dataframes_not_copied, []);
  const [project] = target.projects.values();
  const content = target.pages.get(project.document_id);
  const path = (assetId) => `/api/pages/${content.page_id}/assets/${assetId}`;
  // The dataframe inside a prose block splits it there.
  assert.deepEqual(
    content.blocks.map((block) => [block.type ?? "paragraph", block.markdown]),
    [
      ["paragraph", "Intro prose."],
      ["dataframe", `[Dataframe: Usage by day](${path(daily.asset_id)})`],
      ["paragraph", "Between."],
      ["paragraph", "Before the drop."],
      ["dataframe", `[Dataframe: By week](${path(weekly.asset_id)})`],
      ["paragraph", "After the drop."],
    ],
  );
  assert.deepEqual(target.assets.get(`${content.page_id}/${daily.asset_id}`), frameBytes("daily"));
  // Bytes went to the content document's asset route; the node was inserted
  // through the Project.
  assert.ok(
    target.assetCalls.every((call) => call.path.startsWith(`/api/pages/${content.page_id}/`)),
  );
  // A rerun writes nothing and uploads nothing more.
  const uploads = target.assetCalls.length;
  const edits = target.calls.filter((call) => call.name === "edit_page").length;
  await importBundle(client(target, TARGET), bundle, { store, ...quick });
  assert.equal(target.assetCalls.length, uploads);
  assert.equal(target.calls.filter((call) => call.name === "edit_page").length, edits);
});

test("a Pages OAuth token leaves dataframes as reported links", async () => {
  const { bundle, report, daily, source } = await dataframeSource({ token: "pages_oauth-token" });
  assert.equal(source.assetCalls.length, 0, "no asset request with a token the routes refuse");
  assert.deepEqual(bundle.assets, {});
  assert.equal(report.dataframes, 0);
  assert.deepEqual(
    report.dataframes_not_copied.map((page) => [page.title, page.assets.length]),
    [["Usage report", 2]],
  );
  assert.match(report.warnings.join("\n"), /Export with an Anaconda API key/);
  const target = fakePages(TARGET);
  const result = await importBundle(client(target, TARGET), bundle, {
    store: memoryStore(),
    ...quick,
  });
  assert.equal(result.dataframes, 0);
  assert.equal(result.dataframes_not_copied.length, 1);
  const [project] = target.projects.values();
  const content = target.pages.get(project.document_id);
  assert.ok(content.blocks.every((block) => block.type === undefined));
  assert.ok(content.blocks.some((block) => block.markdown === daily.line));
  assert.equal(target.assetCalls.length, 0);
});

test("import refuses a bundle whose asset bytes don't match their id, before writing", async () => {
  const { bundle, daily } = await dataframeSource();
  const edited = structuredClone(bundle);
  edited.assets[daily.asset_id].data = base64(frameBytes("tampered"));
  const target = fakePages(TARGET);
  await assert.rejects(
    importBundle(client(target, TARGET), edited, { store: memoryStore(), ...quick }),
    /data for asset .* doesn't match its id/,
  );
  assert.equal(target.calls.filter((call) => MUTATIONS.has(call.name)).length, 0);
});

test("bodyUnits takes a dataframe line only alone, outside fences, quotes and lists", () => {
  const src = `/api/pages/${"1".repeat(8)}-1111-4111-8111-${"1".repeat(12)}/assets/${"b".repeat(64)}`;
  const line = `[Dataframe: T](${src})`;
  const page = { dataframes: [{ asset_id: "b".repeat(64), src, media_type: PARQUET, title: "T" }] };
  const assets = { ["b".repeat(64)]: { media_type: PARQUET, data: "" } };
  const frame = { dataframe: page.dataframes[0] };
  assert.deepEqual(bodyUnits([`A\n\n${line}\n\nB`], page, assets), [
    { markdown: "A" },
    frame,
    { markdown: "B" },
  ]);
  assert.deepEqual(bodyUnits([line], page, assets), [frame]);
  for (const markdown of [
    `> ${line}`,
    `- ${line}`,
    `A\n${line}`,
    "```\n" + line + "\n```",
    `text ${line}`,
  ])
    assert.deepEqual(bodyUnits([markdown], page, assets), [{ markdown }], markdown);
  // Without its bytes, the line stays Markdown.
  assert.deepEqual(bodyUnits([line], page, {}), [{ markdown: line }]);
  assert.deepEqual(bodyUnits([""], page, assets), [{ markdown: "" }]);
});

test("bodyOperations puts leading dataframes first and replaces the first block", () => {
  const blocks = [{ node_id: "b1" }, { node_id: "b2" }];
  const frame = (asset_id) => ({ dataframe: { asset_id, src: "/x", media_type: PARQUET } });
  const node = (asset_id, after) => ({
    op: "insert_node",
    node: { type: "dataframe", attrs: { asset_id, media_type: PARQUET } },
    ...(after !== undefined && { after_node_id: after }),
  });
  assert.deepEqual(
    bodyOperations(blocks, [frame("f1"), frame("f2"), { markdown: "M" }, frame("f3")]),
    [
      node("f2", null),
      node("f1", null),
      { op: "replace_block_markdown", node_id: "b1", markdown: "M" },
      { op: "delete_block", node_id: "b2" },
      node("f3"),
    ],
  );
  // Only dataframes: append them all, then delete every old block.
  assert.deepEqual(bodyOperations(blocks, [frame("f1")]), [
    node("f1"),
    { op: "delete_block", node_id: "b1" },
    { op: "delete_block", node_id: "b2" },
  ]);
});

test("a rerun over a body an earlier run wrote, dataframes first, converges", async () => {
  const source = fakePages(SOURCE);
  const { project_id, content } = source.seedProject({ title: "Frames first" });
  content.blocks = [];
  await source.addDataframe(content, frameBytes("lead"), { title: "Lead" });
  content.blocks.push({ id: crypto.randomUUID(), markdown: "After the lead." });
  const { bundle } = await exportProject(client(source, SOURCE), {
    projectId: project_id,
    ...quick,
  });
  const target = fakePages(TARGET);
  const store = memoryStore();
  // The body edit applies, then its response is lost, so the state never
  // records the body as done and a rerun rewrites it from a fresh read.
  target.hooks.dropResponse = (name) => name === "edit_page";
  await assert.rejects(
    importBundle(client(target, TARGET), bundle, { store, attempts: 1, ...quick }),
  );
  target.hooks.dropResponse = null;
  const [project] = target.projects.values();
  const page = target.pages.get(project.document_id);
  assert.equal(page.blocks[0].type, "dataframe", "the first run wrote the dataframe first");
  // Forget the pending edit too: the next run must work from what's there.
  store.peek().pending = null;
  await importBundle(client(target, TARGET), bundle, { store, ...quick });
  assert.deepEqual(
    page.blocks.map((block) => [block.type ?? "paragraph", block.markdown.replace(/\(.*\)/, "")]),
    [
      ["dataframe", "[Dataframe: Lead]"],
      ["paragraph", "After the lead."],
    ],
  );
});

test("two dataframes showing one asset keep their own titles", async () => {
  const source = fakePages(SOURCE);
  const { project_id, content } = source.seedProject({ title: "Same asset" });
  content.blocks = [{ id: crypto.randomUUID(), markdown: "Two views." }];
  const bytes = frameBytes("shared");
  await source.addDataframe(content, bytes, { title: "By day" });
  await source.addDataframe(content, bytes, { title: "By week" });
  const { bundle } = await exportProject(client(source, SOURCE), {
    projectId: project_id,
    ...quick,
  });
  assert.equal(Object.keys(bundle.assets).length, 1);
  const target = fakePages(TARGET);
  await importBundle(client(target, TARGET), bundle, { store: memoryStore(), ...quick });
  const [project] = target.projects.values();
  assert.deepEqual(
    target.pages
      .get(project.document_id)
      .blocks.filter((block) => block.type === "dataframe")
      .map((block) => block.attrs.title),
    ["By day", "By week"],
  );
});

test("an asset refusal with an API key fails the export instead of dropping bytes", async () => {
  const { source, exporting } = await dataframeSource();
  source.refuseAssets(true);
  await assert.rejects(exporting(), /HTTP 403: Page not found/);
});

test("import with a Pages OAuth token refuses a bundle with bytes before any write", async () => {
  const { bundle } = await dataframeSource();
  const target = fakePages(TARGET, { token: "pages_oauth-token" });
  await assert.rejects(
    importBundle(client(target, TARGET, "pages_oauth-token"), bundle, {
      store: memoryStore(),
      ...quick,
    }),
    /Import with an Anaconda API key/,
  );
  assert.equal(target.calls.filter((call) => MUTATIONS.has(call.name)).length, 0);
});

test("validateBundle refuses a dataframe whose asset names another media type", async () => {
  const { bundle, daily } = await dataframeSource();
  const edited = structuredClone(bundle);
  edited.assets[daily.asset_id].media_type = "text/csv";
  assert.throws(() => validateBundle(edited), /disagree on media_type/);
});

test("import refuses a target without insert_node before any write", async () => {
  const { bundle } = await dataframeSource();
  const target = fakePages(TARGET, { insertNode: false });
  await assert.rejects(
    importBundle(client(target, TARGET), bundle, { store: memoryStore(), ...quick }),
    (error) => error.code === "dataframes_unsupported",
  );
  assert.equal(target.calls.filter((call) => MUTATIONS.has(call.name)).length, 0);
  // A bundle with no bytes doesn't need to ask.
  const plain = await exportGuide();
  const older = fakePages(TARGET, { insertNode: false });
  await importBundle(client(older, TARGET), plain.bundle, { store: memoryStore(), ...quick });
  assert.equal(older.calls.filter((call) => call.name === "tools/list").length, 0);
});

test("the client sends its credential only to same-origin asset paths", async () => {
  const sent = [];
  const fetch = async (url) => {
    sent.push(url);
    return new Response(new Uint8Array(0));
  };
  const transfer = pagesClient({ origin: SOURCE, token: KEY, fetch });
  for (const path of [
    "@evil.example/steal",
    "//evil.example/x",
    "https://evil.example/api/pages/x/assets/y",
    `/api/pages/${"1".repeat(8)}-1111-4111-8111-${"1".repeat(12)}/assets/${"a".repeat(64)}/../x`,
    "/mcp",
  ])
    await assert.rejects(transfer.download(path), /Not an asset path/, path);
  await assert.rejects(transfer.upload("../mcp", new Uint8Array(1), PARQUET), /Not a Page ID/);
  assert.deepEqual(sent, []);
});

test("an outline src that isn't its own asset path is never downloaded", async () => {
  const source = fakePages(SOURCE);
  const { project_id, content } = source.seedProject({ title: "Hostile src" });
  content.blocks = [{ id: crypto.randomUUID(), markdown: "Intro." }];
  const frame = await source.addDataframe(content, frameBytes("x"), { title: "X" });
  content.blocks.at(-1).attrs.src = "@evil.example/steal";
  const { bundle } = await exportProject(client(source, SOURCE), {
    projectId: project_id,
    ...quick,
  });
  assert.equal(bundle.project.content.dataframes, undefined);
  assert.deepEqual(bundle.assets, {});
  assert.equal(source.assetCalls.length, 0);
  // The line itself still reads as a dataframe link, reported as not copied.
  assert.deepEqual(bundle.project.content.unlisted_dataframes, [frame.src]);
  // A bundle edited to point a src elsewhere is refused.
  const { bundle: good, daily } = await dataframeSource();
  const edited = structuredClone(good);
  edited.project.content.dataframes[0].src = "@evil.example/steal";
  assert.throws(() => validateBundle(edited), /a src naming it/);
  assert.ok(daily);
});

test("a dataframe whose asset is missing on the source imports as a reported link", async () => {
  const source = fakePages(SOURCE);
  const { project_id, content } = source.seedProject({ title: "Missing asset" });
  content.blocks = [{ id: crypto.randomUUID(), markdown: "Intro." }];
  const kept = await source.addDataframe(content, frameBytes("kept"), { title: "Kept" });
  const gone = await source.addDataframe(content, frameBytes("gone"), { title: "Gone" });
  source.assets.delete(`${content.page_id}/${gone.asset_id}`);
  const { bundle, report } = await exportProject(client(source, SOURCE), {
    projectId: project_id,
    ...quick,
  });
  assert.deepEqual(Object.keys(bundle.assets), [kept.asset_id]);
  assert.match(report.warnings.join("\n"), /missing on the source/);
  assert.deepEqual(report.dataframes_not_copied, [
    { title: "Missing asset", source_document_id: content.page_id, assets: [gone.src] },
  ]);
});

test("a dataframe line inside a quote isn't a private image; it's reported as not copied", async () => {
  const source = fakePages(SOURCE);
  const { project_id, content } = source.seedProject({ title: "Quoted" });
  const frame = await source.addDataframe(content, frameBytes("q"), { title: "Q" });
  content.blocks = [{ id: crypto.randomUUID(), markdown: `> ${frame.line}\n>\n> Quoted.` }];
  const { bundle, report } = await exportProject(client(source, SOURCE), {
    projectId: project_id,
    ...quick,
  });
  assert.deepEqual(bundle.project.content.private_images, []);
  assert.deepEqual(bundle.project.content.unlisted_dataframes, [frame.src]);
  assert.deepEqual(report.dataframes_not_copied[0].assets, [frame.src]);
});

test("a quoted copy of a top-level dataframe is reported as not copied", async () => {
  const source = fakePages(SOURCE);
  const { project_id, content } = source.seedProject({ title: "Quoted copy" });
  content.blocks = [{ id: crypto.randomUUID(), markdown: "Intro." }];
  const frame = await source.addDataframe(content, frameBytes("q"), { title: "Q" });
  content.blocks.push({ id: crypto.randomUUID(), markdown: `> ${frame.line}` });
  const { bundle, report } = await exportProject(client(source, SOURCE), {
    projectId: project_id,
    ...quick,
  });
  assert.equal(bundle.project.content.dataframes.length, 1);
  assert.deepEqual(bundle.project.content.unlisted_dataframes, [frame.src]);
  assert.deepEqual(report.dataframes_not_copied[0].assets, [frame.src]);
});

test("asset requests never follow a redirect, and a 404 is told apart by status", async () => {
  const seen = [];
  const fetch = async (url, init) => {
    seen.push(init.redirect);
    return Response.json({ error: "Not found" }, { status: 404 });
  };
  const transfer = pagesClient({ origin: SOURCE, token: KEY, fetch });
  const path = `/api/pages/${"1".repeat(8)}-1111-4111-8111-${"1".repeat(12)}/assets/${"a".repeat(64)}`;
  const error = await transfer.download(path).catch((caught) => caught);
  assert.equal(error.status, 404);
  assert.deepEqual(seen, ["error"]);
});

test("a source path is listed once in the not-copied report", async () => {
  const source = fakePages(SOURCE, { token: "pages_oauth-token" });
  const { project_id, content } = source.seedProject({ title: "Twice" });
  content.blocks = [{ id: crypto.randomUUID(), markdown: "Intro." }];
  const frame = await source.addDataframe(content, frameBytes("t"), { title: "T" });
  content.blocks.push({ id: crypto.randomUUID(), markdown: `> ${frame.line}` });
  const { report } = await exportProject(client(source, SOURCE, "pages_oauth-token"), {
    projectId: project_id,
    ...quick,
  });
  assert.deepEqual(report.dataframes_not_copied[0].assets, [frame.src]);
});

test("a source or target whose Projects carry no document_id is refused before any write", async () => {
  const source = fakePages(SOURCE);
  const { project_id } = source.seedProject({ title: "Old shape" });
  delete source.projects.get(project_id).document_id;
  await assert.rejects(
    exportProject(client(source, SOURCE), { projectId: project_id, ...quick }),
    (error) => error.code === "source_unsupported" && /document_id/.test(error.message),
  );
  assert.ok(
    source.calls.every((call) => call.name !== "read_page"),
    "nothing was guessed",
  );

  const { bundle } = linkBundle();
  const target = fakePages(TARGET);
  target.hooks.before = (name) =>
    name === "create_project"
      ? { ok: true, body: { project_id: "prj_11111111-1111-4111-8111-111111111111", revision: 0 } }
      : undefined;
  await assert.rejects(
    importBundle(client(target, TARGET), bundle, { store: memoryStore(), ...quick }),
    { code: "target_unsupported" },
  );
  assert.equal(target.calls.filter((call) => call.name === "create_page").length, 0);
});

test("an expired top-level create reconciles against the Project's top level, not a parent", async () => {
  const { bundle } = linkBundle();
  const target = fakePages(TARGET);
  const store = memoryStore();
  // Child is the first create_page, at the top level.
  target.hooks.dropResponse = (name, _args, count) => name === "create_page" && count === 1;
  await assert.rejects(
    importBundle(client(target, TARGET), bundle, { store, attempts: 1, ...quick }),
    (error) => error.uncertain,
  );
  target.hooks.dropResponse = null;
  await assert.rejects(importBundle(client(target, TARGET), bundle, { store, ...expired }), {
    code: "reconciliation_required",
  });
  const record = store.peek().reconciliation_required;
  const [project] = target.projects.values();
  assert.equal(record.args.parent_id, undefined);
  assert.equal(record.args.project_id, project.project_id);
  const made = [...target.pages.values()].find((page) => page.title === "Child");
  const listed = await importBundle(client(target, TARGET), bundle, {
    store,
    reconcile: true,
    ...quick,
  });
  assert.deepEqual(
    listed.reconciliation.candidates.map((entry) => entry.page_id),
    [made.page_id],
  );
  // The content document is never a candidate, whatever its title.
  target.pages.get(project.document_id).title = "Child";
  const again = await importBundle(client(target, TARGET), bundle, {
    store,
    reconcile: true,
    ...quick,
  });
  assert.deepEqual(
    again.reconciliation.candidates.map((entry) => entry.page_id),
    [made.page_id],
  );
  // The content document is already the content's mapping, so it is refused
  // before placement is even checked.
  await assert.rejects(
    importBundle(client(target, TARGET), bundle, { store, adopt: project.document_id, ...quick }),
    (error) => error.code === "adopt_refused" && /already maps to it/.test(error.message),
  );
  const stray = target.insert({
    title: "Child",
    blocks: ["Elsewhere."],
    project_id: project.project_id,
    parent_id: made.page_id,
  });
  await assert.rejects(
    importBundle(client(target, TARGET), bundle, { store, adopt: stray.page_id, ...quick }),
    /not at the top level of the recorded Project/,
  );
  const report = await importBundle(client(target, TARGET), bundle, {
    store,
    adopt: made.page_id,
    ...quick,
  });
  assert.equal(report.verification.ok, true);
  assert.deepEqual(
    target.children(null).map((page) => page.page_id),
    [made.page_id],
  );
});
