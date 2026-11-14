import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

const require = createRequire(import.meta.url);
const bundle = await build({
  entryPoints: [fileURLToPath(new URL("./PublishedPreview.jsx", import.meta.url))],
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  jsx: "automatic",
  plugins: [
    {
      name: "preview-component-test",
      setup(build) {
        build.onResolve({ filter: /^[^./]/ }, ({ path }) => ({
          path: pathToFileURL(require.resolve(path)).href,
          external: true,
        }));
        build.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "empty" }));
        build.onLoad({ filter: /published-preview-image\.mjs$/ }, () => ({
          contents:
            'export const previewVisuals = () => []; export const renderPublishedPreview = async () => new Blob(["test raster"], {type:"image/png"});',
        }));
      },
    },
  ],
});
const { PublishedPreview } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`
);

test("owner must prepare and approve exact image bytes; publishing and removal use the server revision", async (t) => {
  const dom = new JSDOM("<div id='root'></div>", { url: "https://pages.invalid" });
  const saved = new Map();
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const calls = [];
  const id = "12345678-1234-4123-8123-123456789abc";
  const asset = "a".repeat(64);
  t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith("/assets")) {
      assert.equal(await options.body.text(), "test raster");
      return Response.json({
        asset_id: asset,
        url: `/api/pages/${id}/assets/${asset}`,
        mime_type: "image/png",
      });
    }
    const command = options.body ? JSON.parse(options.body) : null;
    if (!command) return Response.json({ revision: 0, snapshot: null });
    if (command.action === "publish") {
      assert.equal(command.expected_revision, 0);
      assert.equal(command.asset_id, asset);
      assert.equal(command.title, "Text-only Page");
      return Response.json({
        revision: 1,
        snapshot: {
          title: command.title,
          description: "",
          asset_id: asset,
          published_at: "2026-11-14T12:00:00Z",
        },
      });
    }
    assert.equal(command.action, "unpublish");
    assert.equal(command.expected_revision, 1);
    return Response.json({ revision: 2, snapshot: null });
  });
  const root = createRoot(document.getElementById("root"));
  const settle = async (fn = () => {}) =>
    act(async () => {
      fn();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  const button = (text) =>
    [...document.querySelectorAll("button")].find((node) => node.textContent === text);
  try {
    await settle(() =>
      root.render(
        createElement(PublishedPreview, {
          session: { pageId: id, snapshot: () => ({ title: "Text-only Page" }) },
        }),
      ),
    );
    assert.equal(button("Publish preview").disabled, true);
    assert.equal(calls.length, 1);
    await settle(() => button("Prepare preview").click());
    assert.ok(document.querySelector("img[alt='Exact image that will be published']"));
    assert.equal(calls.length, 1, "preparing is local, not a publication or upload");
    await settle(() => button("Publish preview").click());
    assert.equal(calls.length, 3);
    assert.ok(document.body.textContent.includes("Preview published."));
    await settle(() => button("Remove preview").click());
    assert.equal(calls.length, 4);
    assert.ok(document.body.textContent.includes("Preview removed."));
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});
