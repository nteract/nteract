// set_view's import check on a Page host over real plain sync: a module
// view whose static import can't resolve is refused before anything is
// written, and the other findings reach the edit receipt as warnings.
import assert from "node:assert/strict";
import test from "node:test";
import { createAuthFixture } from "../auth-fixtures.mjs";
import { LIBRARY_CATALOG_REVISION } from "../shared/library-catalog.mjs";
import { lexModuleImports } from "../shared/module-imports.mjs";
import { validateViewOperation } from "../model/view-doc.mjs";
import { Storage, pageId } from "./trash-fixture.mjs";
import { Page } from "./index.mjs";
import { createModuleReader, sourceImportWarnings, viewImportCheck } from "./view-imports.mjs";

const ENTRY = "e".repeat(64),
  HELPER = "f".repeat(64),
  NEXT_HELPER = "c".repeat(64),
  DATA = "d".repeat(64);
// What every host's views can import from its library catalog.
const LIBRARIES =
  "one of the host's libraries (react, react-dom, react-dom/client, react/jsx-runtime, d3, @observablehq/plot, @nteract/sift/parquet)";

/** A Page with three sources: `main` (asset ENTRY) and `helper` (HELPER),
 * both JavaScript, and `sales` (DATA), a dataset. `code` maps an asset id to
 * the text its object holds; an id it lacks has no object. The host has no
 * catalog or frame configuration: its libraries come with its build. */
async function importsHost(t) {
  const auth = await createAuthFixture();
  t.mock.method(globalThis, "fetch", auth.fetch);
  t.mock.method(console, "error", () => {});
  const code = new Map();
  const types = {
    [ENTRY]: "text/javascript",
    [HELPER]: "text/javascript",
    [NEXT_HELPER]: "text/javascript",
    [DATA]: "application/vnd.apache.parquet",
  };
  const env = {
    ...auth.env,
    CATALOGS: { getByName: () => ({ fetch: async () => Response.json({ ok: true }) }) },
    PAGES_ASSETS: {
      head: async (key) => ({
        size: 1018,
        httpMetadata: { contentType: types[key.slice(-64)] },
        customMetadata: { page_id: pageId, hash: key.slice(-64) },
      }),
      get: async (key) => {
        const text = code.get(key.slice(-64));
        return text === undefined ? null : { size: text.length, text: async () => text };
      },
    },
  };
  assert.equal(env.PAGES_WIDGET_CATALOG_REVISION, undefined);
  assert.equal(env.PAGES_OUTPUT_FRAME_URL, undefined);
  const token = auth.apiKey();
  const hosts = [];
  t.after(async () => {
    for (const host of hosts) await host.plain?.close();
  });
  const host = new Page(
    {
      id: { name: pageId },
      storage: new Storage(),
      blockConcurrencyWhile: (fn) => fn(),
      waitUntil() {},
    },
    env,
  );
  hosts.push(host);
  const call = async (path, body) => {
    const response = await host.fetch(
      new Request(`https://pages.invalid${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { authorization: `Bearer ${token}`, "x-pages-driver": "ChatGPT" },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      }),
    );
    return { status: response.status, body: await response.json() };
  };
  const tool = (operation, args = {}) =>
    call("/internal/tool", { operation, arguments: { page_id: pageId, ...args } });
  let nonces = 0;
  const revision = async () => (await tool("read_page", { include_content: false })).body.revision;
  const edit = async (operations, nonce = `imports-${++nonces}`) =>
    tool("edit_page", { revision: await revision(), nonce, operations });
  const created = await call("/internal/create", {
    page_id: pageId,
    title: "Imports",
    markdown: "Some text",
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const sources = await edit(
    [
      ["main", ENTRY],
      ["helper", HELPER],
      ["sales", DATA],
    ].map(([source_id, asset_id]) => ({
      op: "set_source",
      source_id,
      name: source_id,
      asset_id,
      source_revision: null,
    })),
  );
  assert.equal(sources.status, 200, JSON.stringify(sources.body));
  const views = async () => (await tool("read_page", { views: true })).body.views;
  return { code, tool, edit, revision, views };
}

const moduleView = (fields = {}) => ({
  op: "set_view",
  view_type: "module",
  view_id: "chart",
  title: "Chart",
  module: { source_id: "main" },
  view_revision: null,
  ...fields,
});
const render = "export function render({ el }) { el.textContent = 'hi'; }";

test("a module view whose static import can't resolve is refused, and nothing is written", async (t) => {
  const h = await importsHost(t);
  h.code.set(ENTRY, `import _ from "lodash";\nimport "./util.js";\n${render}`);
  const refused = await h.edit([moduleView()]);
  assert.equal(refused.status, 400, JSON.stringify(refused.body));
  assert.equal(refused.body.code, "invalid_view");
  assert.equal(
    refused.body.error,
    `This view's imports can't load in its frame: "lodash" in the module, "./util.js" in the module. A view can import ${LIBRARIES}, a name bound under imports, data/<alias> for a file bound under data, or an https: URL. Relative paths and subpaths the view doesn't name don't load. Bind JavaScript under imports and import it by that name, or change the import.`,
  );
  assert.deepEqual(await h.views(), []);
  // The refusal took no slot, so the same view id still creates.
  h.code.set(ENTRY, render);
  const created = await h.edit([moduleView()]);
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal(created.body.warnings, undefined);
});

test("an import bound under imports resolves, and its own imports are checked", async (t) => {
  const h = await importsHost(t);
  h.code.set(ENTRY, `import helper from "helper";\nimport sales from "data/sales";\n${render}`);
  h.code.set(HELPER, `import "./sibling.js"; export default 1;`);
  const bound = {
    imports: { helper: { source_id: "helper" } },
    data: { sales: { source_id: "sales" } },
  };
  const refused = await h.edit([moduleView(bound)]);
  assert.equal(refused.status, 400, JSON.stringify(refused.body));
  assert.match(
    refused.body.error,
    /^This view's imports can't load in its frame: "\.\/sibling\.js" in import "helper"\. A view can import one of the host's libraries \([^)]*\), a name bound under imports \(helper\), data\/<alias> for a file bound under data \(data\/sales\), or an https: URL\./,
  );
  h.code.set(HELPER, `import "data/sales"; import x from "https://esm.sh/x"; export default 1;`);
  const accepted = await h.edit([moduleView(bound)]);
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal(accepted.body.warnings, undefined);
  // Without the binding, the same entry is refused.
  const unbound = await h.edit([moduleView({ data: bound.data, view_revision: "1" })]);
  assert.equal(unbound.status, 400);
  assert.match(unbound.body.error, /"helper" in the module/);
  assert.equal((await h.views())[0].revision, "1");
});

test("react is accepted on a host with no catalog configuration, and the save pins the build's catalog", async (t) => {
  const h = await importsHost(t);
  h.code.set(
    ENTRY,
    `import React from "react";\nimport { createRoot } from "react-dom/client";\n${render}`,
  );
  const written = await h.edit([moduleView()]);
  assert.equal(written.status, 200, JSON.stringify(written.body));
  assert.equal(written.body.result.edits[0].catalog_revision, LIBRARY_CATALOG_REVISION);
  // read_page lists the libraries the check accepted.
  const read = await h.tool("read_page", { include_content: false });
  assert.deepEqual(read.body.libraries, [
    "react",
    "react-dom",
    "react-dom/client",
    "react/jsx-runtime",
    "d3",
    "@observablehq/plot",
    "@nteract/sift/parquet",
  ]);
  // A subpath the catalog doesn't list is still refused.
  h.code.set(ENTRY, `import { renderToString } from "react-dom/server";\n${render}`);
  const subpath = await h.edit([moduleView({ view_revision: "1" })]);
  assert.equal(subpath.status, 400);
  assert.match(
    subpath.body.error,
    /"react-dom\/server" in the module\. A view can import one of the host's libraries \(react, react-dom, react-dom\/client, react\/jsx-runtime, d3, @observablehq\/plot, @nteract\/sift\/parquet\), /,
  );
});

test("a dynamic import that can't resolve is written with a warning the receipt replays", async (t) => {
  const h = await importsHost(t);
  h.code.set(
    ENTRY,
    `${render}\nexport async function later(name) { await import(name); return import("lodash"); }`,
  );
  const args = {
    revision: await h.revision(),
    nonce: "dynamic-import",
    operations: [moduleView()],
  };
  const written = await h.tool("edit_page", args);
  assert.equal(written.status, 200, JSON.stringify(written.body));
  const warning = {
    code: "unresolved_dynamic_import",
    view_id: "chart",
    specifier: "lodash",
    in: "entry",
    suggested_action: `import("lodash") in the module can't load in this view's frame, so the view fails when it runs that import. A view can import ${LIBRARIES}, a name bound under imports, data/<alias> for a file bound under data, or an https: URL. Relative paths and subpaths the view doesn't name don't load. The view was saved.`,
  };
  assert.deepEqual(written.body.warnings, [{ ...warning, edit_index: 0 }]);
  assert.deepEqual(written.body.result.edits[0].warnings, [warning]);
  assert.equal((await h.views()).length, 1);
  // The stored receipt replays, warnings and all, even after the module changed.
  h.code.set(ENTRY, render);
  const replayed = await h.tool("edit_page", args);
  assert.equal(replayed.status, 200, JSON.stringify(replayed.body));
  assert.deepEqual(replayed.body, written.body);
});

test("a module the lexer can't read is written with a warning", async (t) => {
  const h = await importsHost(t);
  h.code.set(ENTRY, `import { from "lodash"`);
  const written = await h.edit([moduleView()]);
  assert.equal(written.status, 200, JSON.stringify(written.body));
  assert.equal(written.body.warnings.length, 1);
  assert.equal(written.body.warnings[0].code, "module_unparsed");
  assert.equal(written.body.warnings[0].in, "entry");
});

test("a module whose bytes can't be read is written with a warning that it wasn't checked", async (t) => {
  const h = await importsHost(t);
  const written = await h.edit([moduleView()]);
  assert.equal(written.status, 200, JSON.stringify(written.body));
  assert.deepEqual(written.body.result.edits[0].warnings, [
    {
      code: "module_unchecked",
      view_id: "chart",
      in: "entry",
      suggested_action:
        "Pages didn't check the imports of the module: its bytes couldn't be read in time. The view was saved.",
    },
  ]);
});

/** A stored object as a bucket returns it, counting what the reader does. */
function stored(text, seen) {
  return {
    size: text.length,
    text: async () => (seen.texts++, text),
    body: { cancel: async () => void seen.cancelled++ },
  };
}

test("a module reader reads each asset once and keeps its import list", async () => {
  const seen = { gets: 0, texts: 0, cancelled: 0 };
  const read = createModuleReader({
    get: async () => (seen.gets++, stored(`import "lodash"; import("./later.js");`, seen)),
  });
  const [first, again] = await Promise.all([read(ENTRY), read(ENTRY)]);
  assert.deepEqual(first, {
    imports: [
      { specifier: "lodash", kind: "static" },
      { specifier: "./later.js", kind: "dynamic" },
    ],
  });
  assert.equal(again, first);
  assert.deepEqual(seen, { gets: 1, texts: 1, cancelled: 0 });
});

test("a module reader's reads share one deadline", async () => {
  let clock = 1_000;
  const seen = { gets: 0, texts: 0, cancelled: 0 };
  const read = createModuleReader({
    now: () => clock,
    budgetMs: 5_000,
    get: async () => (seen.gets++, stored("export default 1;", seen)),
  });
  assert.deepEqual(await read(ENTRY), { imports: [] });
  clock += 5_000;
  // The budget is spent, so the next asset is never asked for.
  assert.deepEqual(await read(HELPER), { unchecked: "unread" });
  assert.equal(seen.gets, 1);
  // An asset read in time keeps its answer.
  assert.deepEqual(await read(ENTRY), { imports: [] });
});

test("a module reader doesn't lex text that arrives after the deadline", async () => {
  let clock = 0;
  const read = createModuleReader({
    now: () => clock,
    budgetMs: 5_000,
    get: async () => ({
      size: 16,
      text: async () => ((clock = 5_000), `import { from "x"`),
    }),
  });
  // Lexed, this text would answer `unparsed`.
  assert.deepEqual(await read(ENTRY), { unchecked: "unread" });
});

test("a module reader stops at its byte bound and releases the body it won't read", async () => {
  const seen = { gets: 0, texts: 0, cancelled: 0 };
  const texts = {
    [ENTRY]: "a".repeat(60),
    [HELPER]: "b".repeat(60),
    [NEXT_HELPER]: "c".repeat(40),
  };
  const read = createModuleReader({
    maxBytes: 100,
    get: async (assetId) => (seen.gets++, stored(texts[assetId], seen)),
  });
  assert.deepEqual(await read(ENTRY), { imports: [] });
  assert.deepEqual(await read(HELPER), { unchecked: "too_large" });
  // A smaller module still fits in what is left.
  assert.deepEqual(await read(NEXT_HELPER), { imports: [] });
  assert.deepEqual(seen, { gets: 3, texts: 2, cancelled: 1 });
});

test("a module reader answers unread for a missing object, a failed read and a host with no store", async () => {
  const errors = [];
  const read = createModuleReader({
    get: async (assetId) => {
      if (assetId === ENTRY) return null;
      throw new Error("bucket down");
    },
    onError: (error) => errors.push(error.message),
  });
  assert.deepEqual(await read(ENTRY), { unchecked: "unread" });
  assert.deepEqual(await read(HELPER), { unchecked: "unread" });
  assert.deepEqual(errors, ["bucket down"]);
  assert.deepEqual(await createModuleReader({ get: null })(ENTRY), { unchecked: "unread" });
});

const checkedView = (fields) => validateViewOperation(moduleView(fields));
const assetFor = (binding) => ({ main: ENTRY, helper: HELPER })[binding.source_id];
const reader = (texts) => async (assetId) =>
  texts[assetId] === undefined ? { unchecked: "too_large" } : lexModuleImports(texts[assetId]);

test("a view's first import warning says what it can import, and the others don't repeat it", async () => {
  const warnings = await viewImportCheck(checkedView(), {
    assetFor,
    refuse: false,
    readImports: reader({ [ENTRY]: `import "lodash"; import "./util.js"; import("moment");` }),
  });
  assert.deepEqual(
    warnings.map(({ code, specifier }) => [code, specifier]),
    [
      ["unresolved_import", "lodash"],
      ["unresolved_import", "./util.js"],
      ["unresolved_dynamic_import", "moment"],
    ],
  );
  assert.match(warnings[0].suggested_action, /A view can import one of the host's libraries/);
  assert.equal(
    warnings[1].suggested_action,
    `import "./util.js" in the module can't load in this view's frame, so the view fails when it loads. The view was saved.`,
  );
  assert.doesNotMatch(warnings[2].suggested_action, /A view can import/);
});

test("a library import is the host's whether or not the stored view records a catalog", async () => {
  // A stored view saved where no catalog was recorded: this save records the
  // host's, so its libraries load.
  for (const stored of [undefined, { ...checkedView(), revision: "1" }])
    assert.deepEqual(
      await viewImportCheck(checkedView(stored ? { view_revision: "1" } : {}), {
        assetFor,
        readImports: reader({ [ENTRY]: `import React from "react";` }),
      }),
      [],
    );
});

test("a module past the byte bound is named, and the modules that were read are still checked", async () => {
  const warnings = await viewImportCheck(
    checkedView({ imports: { helper: { source_id: "helper" } } }),
    {
      assetFor,
      refuse: false,
      readImports: reader({ [ENTRY]: `import helper from "helper";` }),
    },
  );
  assert.deepEqual(warnings, [
    {
      code: "module_unchecked",
      view_id: "chart",
      in: "helper",
      suggested_action: `Pages didn't check the imports of import "helper": the modules of one write are checked up to 32 MiB. The view was saved.`,
    },
  ]);
});

test("a set_source checks only the views it is given", async () => {
  const view = { ...checkedView({ imports: { helper: { source_id: "helper" } } }), revision: "1" };
  const asked = [];
  const lists = await sourceImportWarnings({
    operations: [{ op: "set_source", source_id: "helper", asset_id: NEXT_HELPER }],
    mediaTypes: new Map([[NEXT_HELPER, "text/javascript"]]),
    // A view the host couldn't read arrives as undefined.
    views: [undefined, view],
    sourcesDoc: undefined,
    readImports: async (assetId) => {
      asked.push(assetId);
      return lexModuleImports(assetId === NEXT_HELPER ? `import "lodash";` : "");
    },
  });
  assert.deepEqual(
    lists.map((list) => list.map(({ code, view_id, in: location }) => [code, view_id, location])),
    [
      [
        ["module_unchecked", "chart", "entry"],
        ["unresolved_import", "chart", "helper"],
      ],
    ],
  );
  // The sources document can't name the entry's asset here, so only the new
  // helper is read, and the entry is reported as not checked.
  assert.deepEqual(asked, [NEXT_HELPER]);
  assert.equal(
    lists[0][0].suggested_action,
    "Pages didn't check the imports of the module: its binding names no stored version. The source was saved.",
  );
});

test("a cut list of warnings keeps the modules that weren't checked", async () => {
  const many = Array.from({ length: 20 }, (_, index) => `import("x${index}");`).join("");
  const warnings = await viewImportCheck(
    checkedView({ imports: { helper: { source_id: "helper" } } }),
    { assetFor, refuse: false, readImports: reader({ [ENTRY]: many }) },
  );
  assert.equal(warnings.length, 16);
  assert.deepEqual([warnings[0].code, warnings[0].in], ["module_unchecked", "helper"]);
  assert.match(warnings[1].suggested_action, /A view can import/);
});

test("a module reader releases a body that arrives after the deadline", async () => {
  let clock = 0;
  const seen = { gets: 0, texts: 0, cancelled: 0 };
  const read = createModuleReader({
    now: () => clock,
    budgetMs: 5_000,
    get: async () => ((clock = 5_000), stored("export default 1;", seen)),
  });
  assert.deepEqual(await read(ENTRY), { unchecked: "unread" });
  assert.deepEqual(seen, { gets: 0, texts: 0, cancelled: 1 });
});

test("a set_source that gives a followed import new code warns for each view it breaks", async (t) => {
  const h = await importsHost(t);
  h.code.set(ENTRY, `import helper from "helper";\n${render}`);
  h.code.set(HELPER, "export default 1;");
  h.code.set(NEXT_HELPER, `import "lodash"; export default 2;`);
  const imports = { helper: { source_id: "helper" } };
  assert.equal((await h.edit([moduleView({ imports })])).status, 200);
  // A view pinned to the old revision doesn't follow the change.
  const pinned = { helper: { source_id: "helper", revision: "1" } };
  assert.equal((await h.edit([moduleView({ view_id: "pinned", imports: pinned })])).status, 200);
  const changed = await h.edit([
    {
      op: "set_source",
      source_id: "helper",
      name: "helper",
      asset_id: NEXT_HELPER,
      source_revision: "1",
    },
  ]);
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.deepEqual(
    changed.body.warnings.map(({ code, view_id, specifier, in: location, edit_index }) => ({
      code,
      view_id,
      specifier,
      in: location,
      edit_index,
    })),
    [
      {
        code: "unresolved_import",
        view_id: "chart",
        specifier: "lodash",
        in: "helper",
        edit_index: 0,
      },
    ],
  );
  assert.match(
    changed.body.warnings[0].suggested_action,
    /so the view fails when it loads\. .* The source was saved\.$/,
  );
  assert.equal(changed.body.result.edits[0].source_revision, "2");
});

test("an anywidget view with an unresolved static import is written with a warning", async (t) => {
  const h = await importsHost(t);
  h.code.set(ENTRY, `import _ from "lodash";\nexport default { render() {} };`);
  const written = await h.edit([
    {
      op: "set_view",
      view_type: "anywidget",
      view_id: "widget",
      title: "Widget",
      spec: { module: { source_id: "main" } },
      view_revision: null,
    },
  ]);
  assert.equal(written.status, 200, JSON.stringify(written.body));
  assert.deepEqual(
    written.body.warnings.map(({ code, specifier, in: location }) => ({
      code,
      specifier,
      in: location,
    })),
    [{ code: "unresolved_import", specifier: "lodash", in: "spec.module" }],
  );
  assert.match(
    written.body.warnings[0].suggested_action,
    /A view can import one of the host's libraries \([^)]*\) or an https: URL\. Relative paths/,
  );
  assert.equal((await h.views()).length, 1);
});
