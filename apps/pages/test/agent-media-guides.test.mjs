import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "../worker/index.mjs";
import { MEDIA_GUIDES, mediaGuide } from "../agent-media-guides.mjs";
import { validateSourceOperation } from "../model/sources-doc.mjs";
import { validateViewOperation } from "../model/view-doc.mjs";
import { compileAnywidgetSpec } from "../shared/anywidget-spec.mjs";
import { widgetState } from "@nteract/output-frame/schema";
import { tools } from "../mcp.mjs";

const origin = "https://pages.example";
const env = {
  NOTEBOOK_CLOUD_PUBLIC_ORIGIN: origin,
  get DB() {
    throw Error("Public documentation must not access account storage");
  },
  get ASSETS() {
    throw Error("Documentation must not fall through to the app shell");
  },
};

// Follow links from the index without authentication or an editor deployment.
test("media guides are discoverable, public, and use the configured origin", async (t) => {
  t.mock.method(globalThis, "fetch", () => {
    throw Error("No credential verification or external fetch");
  });
  const indexText = await (await worker.fetch(new Request(origin + "/llms.txt"), env)).text();
  for (const { path, title } of MEDIA_GUIDES) {
    assert.ok(indexText.includes(`](${origin}${path})`), path);
    const response = await worker.fetch(
      new Request(`https://untrusted.example${path}?secret=ignore`, {
        headers: { "X-Forwarded-Host": "untrusted.example" },
      }),
      env,
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/plain; charset=utf-8");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("cache-control"), "public, max-age=300");
    assert.equal(response.headers.get("set-cookie"), null);
    assert.equal(
      response.headers.get("link"),
      `<${path}>; rel="self"; type="text/plain", </llms.txt>; rel="index"; type="text/plain"`,
    );
    const body = await response.text();
    assert.ok(body.startsWith(`# Pages: ${title}\n`));
    assert.ok(body.includes(`${origin}/llms.txt`));
    assert.doesNotMatch(body, /untrusted\.example|secret=ignore/);
    for (const [, url] of body.matchAll(/\]\((https:\/\/pages\.example\/llms[^)]*)\)/g)) {
      assert.equal(
        (await worker.fetch(new Request(url, { method: "HEAD" }), env)).status,
        200,
        url,
      );
    }
    const head = await worker.fetch(new Request(origin + path, { method: "HEAD" }), env);
    assert.equal(await head.text(), "");
    for (const name of ["content-type", "cache-control", "link", "x-content-type-options"])
      assert.equal(head.headers.get(name), response.headers.get(name));
    const post = await worker.fetch(
      new Request(origin + path, { method: "POST", body: "ignored" }),
      env,
    );
    assert.equal(post.status, 405);
    assert.equal(post.headers.get("allow"), "GET, HEAD");
  }
});

test("a Page author can discover the same catalog setup through MCP and the public guides", async () => {
  const hosted = "https://output.example/frame/v2/";
  const local = "http://localhost:9917";
  const loopback = "http://127.0.0.1:9447/frame/v2/";
  const pin = "a".repeat(64);
  for (const [site, frame, revision, enabled] of [
    [origin, hosted, pin, true],
    [local, loopback, pin, true],
    [origin, hosted, undefined, false],
    [local, loopback, undefined, false],
    [origin, origin + "/frame/", pin, false],
  ]) {
    const config = {
      NOTEBOOK_CLOUD_PUBLIC_ORIGIN: site,
      PAGES_OUTPUT_FRAME_URL: frame,
      PAGES_WIDGET_CATALOG_REVISION: revision,
    };
    const guide = await (await worker.fetch(new Request(site + "/llms/views.txt"), config)).text();
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const response = await worker.fetch(
      new Request(site + "/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "Content-Length": String(body.length),
        },
        body,
      }),
      config,
    );
    assert.equal(response.status, 200, await response.clone().text());
    const catalog = (await response.json()).result.tools;
    const editTool = catalog.find((tool) => tool.name === "edit_page");
    const ops = editTool.inputSchema.properties.operations.items.properties.op.enum;
    assert.ok(!ops.includes("set_widget_imports"));
    assert.deepEqual(
      editTool.inputSchema.properties.operations.items.properties.view_type.enum.sort(),
      ["anywidget", "module", "vega-lite"],
    );
    assert.ok(guide.includes('"view_type": "module"'));
    assert.ok(guide.includes('"activity-controls"'));
    assert.equal(guide.includes("read_page.libraries"), enabled);
    assert.equal(guide.includes("view.catalog_revision"), enabled);
    // What a view can import, and what set_view does when it can't.
    assert.ok(guide.includes("data/<alias> for a file bound in data, or an https: URL."));
    assert.equal(guide.includes("This host offers no libraries."), !enabled);
    assert.ok(guide.includes("refuses the view with invalid_view when a static import can't load"));
  }
});

test("unknown guide paths return 404 rather than an app shell or login", async () => {
  for (const path of [
    "/llms/",
    "/llms/missing.txt",
    "/llms/__proto__",
    "/llms/anywidget.txt/extra",
  ]) {
    const response = await worker.fetch(new Request(origin + path), env);
    assert.equal(response.status, 404, path);
    assert.match(await response.text(), /Start at \/llms.txt/);
    const head = await worker.fetch(new Request(origin + path, { method: "HEAD" }), env);
    assert.equal(head.status, 404);
    assert.equal(await head.text(), "");
  }
});

test("published tool examples pass current source and view validators", () => {
  let sources = 0,
    views = 0,
    placements = 0;
  for (const { path } of MEDIA_GUIDES) {
    for (const [, snippet] of mediaGuide(path, origin).matchAll(/```json\n([\s\S]*?)\n```/g)) {
      const { operation, arguments: args } = JSON.parse(snippet);
      const tool = tools.find(({ name }) => name === operation);
      assert.ok(tool, operation);
      for (const key of tool.inputSchema.required)
        assert.ok(Object.hasOwn(args, key), `${operation}.${key}`);
      for (const op of args.operations ?? []) {
        if (op.op === "set_source") {
          // The gateway takes asset_from off the operation (dataset-copies.mjs);
          // the host validates the rest.
          const { asset_from, ...hostOp } = op;
          if (asset_from !== undefined)
            assert.ok(
              Object.hasOwn(tool.inputSchema.properties.operations.items.properties, "asset_from"),
            );
          validateSourceOperation({ ...hostOp, asset_id: "a".repeat(64) });
          sources++;
        } else if (op.op === "set_view") {
          validateViewOperation(op);
          views++;
          if (op.view_type === "anywidget") {
            const compiled = compileAnywidgetSpec(op.spec);
            const assets = Object.fromEntries(
              compiled.dependencies.map(({ name }) => [name, { bytes: new Uint8Array([1, 2, 3]) }]),
            );
            const state = widgetState(compiled.spec, assets);
            if (op.view_id === "audio") assert.ok(state.audio.bytes instanceof DataView);
            if (op.view_id === "counter") assert.equal(state.count, 0);
          }
        } else {
          assert.equal(op.op, "insert_node");
          assert.equal(op.node.type, "view");
          assert.ok(op.node.attrs.view_id);
          placements++;
        }
      }
    }
  }
  assert.ok(sources > 0 && views >= 3 && placements >= 3);
});

test("the views guide leads with the model and keeps the data import as the low-level path", () => {
  const guide = mediaGuide("/llms/views.txt", origin);
  for (const sentence of [
    "Each name in data is a key on the model.",
    "A Parquet source arrives as a file handle with byteLength and read(offset, length, signal).",
    "Any other source arrives as a DataView of the whole file: at most 5 MiB, and it counts toward the view's 32 MiB input total.",
    "A Parquet file is read in ranges and does not count.",
    'model.on("change:activity", show);',
    "That import names the file the view was mounted with; after a change its reads fail as aborted",
    "reaches the mounted view as a change event and keeps its local state when the view listens for that change",
    'Listen with model.on("change:<name>", …) to update in place and keep the reader\'s state.',
    "A view that does not listen is mounted again when its data changes.",
    "A title change relabels the view in place.",
  ])
    assert.ok(guide.includes(sentence), sentence);
  assert.ok(guide.indexOf("model.get") < guide.indexOf("## Read part of a file"));
  assert.doesNotMatch(guide, /code or input changes remount/);
  const module = tools.find(({ name }) => name === "edit_page").inputSchema.properties.operations
    .items.properties.module;
  assert.match(module.description, /render\(\{model, el, signal\}\)/);
});

test("media tools point to scoped documentation", () => {
  assert.ok(tools.find(({ name }) => name === "edit_page").description.includes("/llms/views.txt"));
  assert.ok(
    tools
      .find(({ name }) => name === "create_page_asset_upload")
      .description.includes("/llms/assets-and-sources.txt"),
  );
});
