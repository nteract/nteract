import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";

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
            "export const previewVisuals = () => []; export const renderPublishedPreview = async (draft, visuals, signal) => globalThis.renderPreviewForTest(draft, signal);",
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
  const pending = [];
  let holdRenders = false;
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
    renderPreviewForTest: (draft, signal) => {
      const blob = new Blob(
        [draft.file ? `cover:${draft.file.name}${draft.description}` : "test raster"],
        { type: "image/png" },
      );
      return holdRenders
        ? new Promise((resolve) => pending.push({ draft, signal, resolve: () => resolve(blob) }))
        : blob;
    },
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
  const { createRoot } = await import("react-dom/client");
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
    assert.equal(button("Publish preview"), undefined);
    assert.equal(calls.length, 1);
    await settle(() => button("Prepare preview").click());
    const preparedImage = document.querySelector("img[alt='Exact image that will be published']");
    assert.ok(preparedImage);
    assert.equal(
      preparedImage.getAttribute("src"),
      `data:image/png;base64,${Buffer.from("test raster").toString("base64")}`,
      "the viewer CSP allows the exact prepared bytes as a data image",
    );
    assert.equal(calls.length, 1, "preparing is local, not a publication or upload");
    await settle(() => button("Publish preview").click());
    assert.equal(calls.length, 3);
    assert.ok(document.body.textContent.includes("Preview published."));
    assert.equal(
      document.querySelector("img[alt='Currently published preview']").getAttribute("src"),
      `/p/${id}/preview.png?v=1`,
    );
    assert.equal(
      button("Update public preview"),
      undefined,
      "publishing again requires preparing a fresh image",
    );
    await settle(() => button("Remove preview").click());
    assert.equal(calls.length, 4);
    assert.ok(document.body.textContent.includes("Preview removed."));
    assert.equal(document.querySelector("img[alt='Currently published preview']"), null);
    assert.equal(
      document.querySelector("select"),
      null,
      "a cover is optional, not a separate template",
    );
    await settle(() => {
      const input = document.querySelector("input[type='file']");
      Object.defineProperty(input, "files", {
        value: [new dom.window.File(["cover"], "cover.png", { type: "image/png" })],
      });
      input.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
    assert.equal(
      document.querySelector("img[alt='Exact image that will be published']").getAttribute("src"),
      `data:image/png;base64,${Buffer.from("cover:cover.png").toString("base64")}`,
    );
    assert.equal(
      calls.length,
      4,
      "choosing a cover previews it locally without uploading or publishing",
    );
    assert.equal(button("Publish preview").disabled, false);
    assert.equal(document.querySelector(".preview-upload small").textContent, "cover.png");
    const coverSrc = document.querySelector(".published-preview-image").src;
    const description = document.querySelector("textarea");
    const setDescription = (value) => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value").set.call(
        description,
        value,
      );
      description.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    };
    holdRenders = true;
    await settle(() => setDescription("First edit"));
    assert.equal(pending.length, 1);
    assert.equal(description.disabled, false, "typing continues during rendering");
    assert.equal(document.querySelector(".published-preview-image").src, coverSrc);
    assert.equal(
      button("Publish preview").disabled,
      true,
      "the old render cannot be published with new text",
    );
    await settle(() => setDescription(""));
    assert.equal(pending.length, 2);
    assert.equal(pending[0].signal.aborted, true);
    assert.equal(pending[1].draft.description, "");
    await settle(() => pending[1].resolve());
    assert.equal(button("Publish preview").disabled, false);
    assert.equal(document.querySelector(".published-preview-image").src, coverSrc);
    await settle(() => pending[0].resolve());
    assert.equal(
      document.querySelector(".published-preview-image").src,
      coverSrc,
      "late renders cannot restore the removed description",
    );
    assert.equal(document.querySelector(".preview-upload small").textContent, "cover.png");
    assert.equal(calls.length, 4, "text edits stay local");
    holdRenders = false;
    await settle(() => document.querySelector("button[aria-label='Remove cover']").click());
    assert.equal(
      document.querySelector("img[alt='Exact image that will be published']").getAttribute("src"),
      `data:image/png;base64,${Buffer.from("test raster").toString("base64")}`,
    );
    assert.equal(calls.length, 4, "removing the cover also stays a local preview");
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});
