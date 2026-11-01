import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const bundled = await build({
  entryPoints: [fileURLToPath(new URL("./PagePreview.jsx", import.meta.url))],
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  jsx: "automatic",
  plugins: [
    {
      name: "test-component",
      setup(build) {
        build.onResolve({ filter: /^[^./]/ }, ({ path }) => ({
          path: pathToFileURL(require.resolve(path)).href,
          external: true,
        }));
      },
    },
  ],
});
const { PagePreview, isPagePreview, previewHref, previewSrc } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].contents).toString("base64")}`
);
const asset = `/api/pages/5f0c4a5e-6c1e-4b0e-9a8f-0d0d4c5e6f70/assets/${"a".repeat(64)}`;
const render = (blocks, title = "Roadmap") =>
  renderToStaticMarkup(
    createElement(PagePreview, { preview: { title, blocks, truncated: false } }),
  );

test("the preview renders allowed elements in the editor's markup", () => {
  const html = render([
    {
      id: "b1",
      content: [
        ["h1", {}, "Plan"],
        [
          "p",
          {},
          "A ",
          ["strong", {}, "bold"],
          " ",
          ["a", { href: "https://x.example", title: "" }, "link"],
        ],
        [
          "ul",
          { "data-task-list": "true" },
          [
            "li",
            { "data-task-checked": "true" },
            ["input", { type: "checkbox", checked: "" }],
            ["div", {}, ["p", {}, "done"]],
          ],
        ],
        ["p", {}, ["img", { src: asset, alt: "Figure" }]],
      ],
    },
  ]);
  assert.match(html, /<main class="workspace document page-preview" aria-busy="true">/);
  assert.match(html, /<h1 class="document-title document-preview-title">Roadmap<\/h1>/);
  assert.match(
    html,
    /<section class="page-block" data-preview-block="b1"><div class="rich-editor wordgard-editor"><div class="wordgard-document"><div class="preview-content"><h1>Plan<\/h1>/,
  );
  assert.match(html, /<a href="https:\/\/x.example" title="">link<\/a>/);
  assert.match(
    html,
    /<ul data-task-list="true"><li data-task-checked="true"><input type="checkbox" disabled="" tabindex="-1" checked=""\/>/,
  );
  assert.match(html, new RegExp(`<img src="${asset}" alt="Figure" loading="lazy"/>`));
  assert.match(html, /role="status">Opening…</);
  assert.equal(html.includes("wg-content"), false, "editor locators never match the preview");
});

test("the preview keeps only text from anything outside its allowlist", () => {
  const html = render(
    [
      {
        id: "b1",
        content: [
          ["script", {}, "alert(1)"],
          ["p", { onclick: "alert(1)", style: "x", class: "y" }, "safe"],
          ["a", { href: "javascript:alert(1)" }, "bad link"],
          ["a", { href: "//evil.example/x" }, "protocol-relative"],
          ["img", { src: "https://evil.example/x.png\u0000", alt: "bad" }],
          ["img", { src: "data:image/png;base64,AAAA", alt: "inline" }],
          ["iframe", { src: "https://evil.example" }, "framed"],
          { not: "a node" },
          ["p", {}, "<b>escaped</b>"],
        ],
      },
    ],
    "<img src=x onerror=alert(1)>",
  );
  assert.equal(
    /<script|<iframe|onclick|style=|class="y"|javascript:|evil\.example|data:image/.test(html),
    false,
  );
  assert.match(
    html,
    /alert\(1\)<p>safe<\/p><a>bad link<\/a><a>protocol-relative<\/a>framed<p>&lt;b&gt;escaped&lt;\/b&gt;<\/p>/,
  );
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;<\/h1>/);
});

test("preview link and image rules", () => {
  assert.equal(previewHref("/p/x"), "/p/x");
  assert.equal(previewHref("#h"), "#h");
  assert.equal(previewHref("mailto:a@b.c"), "mailto:a@b.c");
  for (const bad of ["javascript:x", "//evil", "data:x", " https://x", 1])
    assert.equal(previewHref(bad), null);
  assert.equal(previewSrc(asset), asset);
  assert.equal(previewSrc("https://cdn.example/a.png"), "https://cdn.example/a.png");
  for (const bad of ["http://x/a.png", "/api/pages/x/assets/y", "data:image/png;base64,AA"])
    assert.equal(previewSrc(bad), null);
});

test("only the projection's shape counts as a preview", () => {
  assert.equal(
    isPagePreview({ title: "x", blocks: [{ id: "b", content: [] }], truncated: false }),
    true,
  );
  for (const bad of [
    null,
    "x",
    { title: 1, blocks: [] },
    { title: "x" },
    { title: "x", blocks: [{ id: 1, content: [] }] },
  ])
    assert.equal(isPagePreview(bad), false);
});
