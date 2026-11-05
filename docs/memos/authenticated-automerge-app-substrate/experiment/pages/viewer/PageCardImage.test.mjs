import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const bundled = await build({
  entryPoints: [fileURLToPath(new URL("./PageCardPreview.jsx", import.meta.url))],
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
const { PageCardPreview } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].contents).toString("base64")}`
);

const pageId = "5f0c4a5e-6c1e-4b0e-9a8f-0d0d4c5e6f70";
const hash = "a".repeat(64);
const card = {
  v: 1,
  card_hash: hash,
  blocks: [{ id: "b", content: [["h1", {}, "Goals"]] }],
};
const image = {
  card_hash: hash,
  light: `/api/pages/${pageId}/card-image/${hash}-light.webp`,
  dark: `/api/pages/${pageId}/card-image/${hash}-dark.png`,
};
const render = (value) => renderToStaticMarkup(createElement(PageCardPreview, { card: value }));

test("a card with images draws both themes over the JSON card", () => {
  const html = render({ ...card, image });
  assert.match(html, /<h1>Goals<\/h1>/, "the JSON card stays underneath");
  assert.match(
    html,
    new RegExp(`<img class="page-card-image" data-theme="light" src="${image.light}"`),
  );
  assert.match(
    html,
    new RegExp(`<img class="page-card-image" data-theme="dark" src="${image.dark}"`),
  );
  assert.match(html, /loading="lazy"/);
  assert.match(html, /alt=""/);
});

test("a card without images, or with references that aren't the image route, draws the JSON only", () => {
  for (const value of [
    card,
    { ...card, image: { ...image, light: "https://example.com/x.webp" } },
    { ...card, image: { ...image, dark: `/api/pages/${pageId}/assets/${hash}` } },
    { ...card, image: { light: image.light, dark: image.dark } },
  ]) {
    const html = render(value);
    assert.match(html, /<h1>Goals<\/h1>/);
    assert.equal(html.includes("<img"), false, JSON.stringify(value.image));
  }
});
