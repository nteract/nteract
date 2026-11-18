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

const images = (html) =>
  [...html.matchAll(/<img [^>]*>/g)].map(([tag]) => ({
    theme: tag.match(/data-theme="(\w+)"/)[1],
    loading: tag.match(/loading="(\w+)"/)?.[1],
    priority: tag.match(/fetchPriority="(\w+)"/i)?.[1] ?? null,
    decoding: tag.match(/decoding="(\w+)"/)?.[1],
    width: tag.match(/width="(\d+)"/)?.[1],
    height: tag.match(/height="(\d+)"/)?.[1],
  }));

test("a first-screen card loads its shown theme's image eagerly at high priority", () => {
  // No window here: the theme resolves to light.
  const html = renderToStaticMarkup(
    createElement(PageCardPreview, { card: { ...card, image }, priority: true }),
  );
  assert.deepEqual(images(html), [
    {
      theme: "light",
      loading: "eager",
      priority: "high",
      decoding: "async",
      width: "640",
      height: "480",
    },
    // The hidden theme's image stays lazy, so it is never fetched while hidden.
    {
      theme: "dark",
      loading: "lazy",
      priority: null,
      decoding: "async",
      width: "640",
      height: "480",
    },
  ]);
});

test("every other card loads both images lazily, with the 4:3 ratio before CSS applies", () => {
  for (const { loading, priority, decoding, width, height } of images(render({ ...card, image }))) {
    assert.equal(loading, "lazy");
    assert.equal(priority, null);
    assert.equal(decoding, "async");
    assert.equal(Number(width) * 3, Number(height) * 4);
  }
});

test("the intrinsic size is the size cards are captured at: 640×480 pixels", async () => {
  const { CARD_HEIGHT, CARD_SCALE, CARD_WIDTH } = await import("./card-raster.mjs");
  const { CARD_IMAGE_HEIGHT, CARD_IMAGE_WIDTH } = await import("./PageCardImage.jsx");
  assert.deepEqual(
    [CARD_IMAGE_WIDTH, CARD_IMAGE_HEIGHT],
    [CARD_WIDTH * CARD_SCALE, CARD_HEIGHT * CARD_SCALE],
  );
  assert.deepEqual([CARD_IMAGE_WIDTH, CARD_IMAGE_HEIGHT], [640, 480]);
});
