// set_view's import check on a Page host over real plain sync: a module
// view whose static import can't resolve is refused before anything is
// written, and the other findings reach the edit receipt as warnings.
import assert from "node:assert/strict";
import test from "node:test";
import { createAuthFixture } from "../auth-fixtures.mjs";
import { configuredCatalogRevision } from "../shared/widget-imports.mjs";
import { Storage, pageId } from "./trash-fixture.mjs";
import { Page } from "./index.mjs";

const ENTRY = "e".repeat(64),
  HELPER = "f".repeat(64),
  NEXT_HELPER = "c".repeat(64),
  DATA = "d".repeat(64);
const CATALOG = {
  NOTEBOOK_CLOUD_PUBLIC_ORIGIN: "https://pages.invalid",
  PAGES_OUTPUT_FRAME_URL: "https://output.example/frame/v2/",
  PAGES_WIDGET_CATALOG_REVISION: "a".repeat(64),
};

/** A Page with three sources: `main` (asset ENTRY) and `helper` (HELPER),
 * both JavaScript, and `sales` (DATA), a dataset. `code` maps an asset id to
 * the text its object holds; an id it lacks has no object. */
async function importsHost(t, { catalog = false } = {}) {
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
    ...(catalog && CATALOG),
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
  assert.equal(!!configuredCatalogRevision(env), catalog);
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
    `This view's imports can't load in its frame: "lodash" in the module, "./util.js" in the module. A view can import a name bound under imports, data/<alias> for a file bound under data, or an https: URL. This host offers no libraries. Relative paths and subpaths the view doesn't name don't load. Bind JavaScript under imports and import it by that name, or change the import.`,
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
    /^This view's imports can't load in its frame: "\.\/sibling\.js" in import "helper"\. A view can import a name bound under imports \(helper\), data\/<alias> for a file bound under data \(data\/sales\), or an https: URL\./,
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

for (const catalog of [true, false])
  test(`react ${catalog ? "is accepted on a host with a catalog" : "is refused on a host without one"}`, async (t) => {
    const h = await importsHost(t, { catalog });
    h.code.set(
      ENTRY,
      `import React from "react";\nimport { createRoot } from "react-dom/client";\n${render}`,
    );
    const written = await h.edit([moduleView()]);
    if (catalog) {
      assert.equal(written.status, 200, JSON.stringify(written.body));
      assert.equal(
        written.body.result.edits[0].catalog_revision,
        CATALOG.PAGES_WIDGET_CATALOG_REVISION,
      );
      // A subpath the catalog doesn't list is still refused.
      h.code.set(ENTRY, `import { renderToString } from "react-dom/server";\n${render}`);
      const subpath = await h.edit([moduleView({ view_revision: "1" })]);
      assert.equal(subpath.status, 400);
      assert.match(
        subpath.body.error,
        /"react-dom\/server" in the module\. A view can import one of the host's libraries \(react, react-dom, react-dom\/client, react\/jsx-runtime, d3, @observablehq\/plot, @nteract\/sift\/parquet\), /,
      );
    } else {
      assert.equal(written.status, 400, JSON.stringify(written.body));
      assert.match(
        written.body.error,
        /"react" in the module, "react-dom\/client" in the module\./,
      );
      assert.match(written.body.error, /This host offers no libraries\./);
      assert.deepEqual(await h.views(), []);
    }
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
    suggested_action:
      "import(\"lodash\") in the module can't load in this view's frame, so the view fails when it runs that import. A view can import a name bound under imports, data/<alias> for a file bound under data, or an https: URL. This host offers no libraries. Relative paths and subpaths the view doesn't name don't load. The view was saved.",
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

test("a module whose bytes can't be read is not checked", async (t) => {
  const h = await importsHost(t);
  const written = await h.edit([moduleView()]);
  assert.equal(written.status, 200, JSON.stringify(written.body));
  assert.equal(written.body.warnings, undefined);
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
    /The source was saved; the view fails until the import resolves\.$/,
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
    /A view can import an https: URL\. This host offers no libraries\./,
  );
  assert.equal((await h.views()).length, 1);
});
