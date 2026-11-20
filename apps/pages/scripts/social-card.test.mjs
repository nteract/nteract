// The link-preview card: the committed module agrees with itself, and the
// parts of its generator that need no browser do what they say.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { inflateSync } from "node:zlib";
import {
  CARD_HEIGHT,
  CARD_WIDTH,
  CROP,
  cardHtml,
  cardModule,
  encodePalettePng,
} from "./social-card.mjs";
import {
  SOCIAL_CARD_BASE64,
  SOCIAL_CARD_HEIGHT,
  SOCIAL_CARD_VERSION,
  SOCIAL_CARD_WIDTH,
} from "../shared/social-card.mjs";

const LOGO = "data:image/png;base64,AAAA";

/** A PNG's chunks, by type, with each chunk's data. */
function chunks(png) {
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const out = [];
  for (let at = 8; at < png.length; ) {
    const length = png.readUInt32BE(at);
    out.push({
      type: png.toString("latin1", at + 4, at + 8),
      data: png.subarray(at + 8, at + 8 + length),
    });
    at += 12 + length;
  }
  return out;
}

/** An indexed PNG back to `[r, g, b]` per pixel. */
function decode(png) {
  const parts = chunks(png);
  const header = parts.find(({ type }) => type === "IHDR").data;
  const palette = parts.find(({ type }) => type === "PLTE").data;
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  const rows = inflateSync(parts.find(({ type }) => type === "IDAT").data);
  const pixels = [];
  for (let y = 0; y < height; y++) {
    assert.equal(rows[y * (width + 1)], 0, "every row is unfiltered");
    for (let x = 0; x < width; x++) {
      const index = rows[y * (width + 1) + 1 + x];
      pixels.push([...palette.subarray(index * 3, index * 3 + 3)]);
    }
  }
  return { width, height, depth: header[8], colourType: header[9], pixels, palette };
}

test("the committed card is a 1200x630 palette PNG whose version is its digest", () => {
  const png = Buffer.from(SOCIAL_CARD_BASE64, "base64");
  assert.equal(
    SOCIAL_CARD_VERSION,
    createHash("sha256").update(png).digest("hex").slice(0, 12),
    "run scripts/social-card.mjs instead of editing shared/social-card.mjs",
  );
  const image = decode(png);
  assert.deepEqual([image.width, image.height], [SOCIAL_CARD_WIDTH, SOCIAL_CARD_HEIGHT]);
  assert.deepEqual([CARD_WIDTH, CARD_HEIGHT], [1200, 630]);
  assert.deepEqual([SOCIAL_CARD_WIDTH, SOCIAL_CARD_HEIGHT], [CARD_WIDTH, CARD_HEIGHT]);
  assert.deepEqual([image.depth, image.colourType], [8, 3]);
  assert.equal(chunks(png).at(-1).type, "IEND");
  // The Worker inlines it: keep it small. A card over this is a design that
  // stopped being flat colour.
  assert.ok(png.length < 64 * 1024, `${png.length} bytes`);
  // The module is exactly what the generator writes for these bytes.
  assert.ok(cardModule(png).includes(`SOCIAL_CARD_VERSION = "${SOCIAL_CARD_VERSION}"`));
  assert.ok(cardModule(png).includes(SOCIAL_CARD_BASE64));
});

test("an image of few colours encodes without loss", () => {
  const colours = [
    [9, 9, 11],
    [250, 250, 250],
    [134, 239, 172],
    [61, 155, 255],
  ];
  const width = 5;
  const height = 3;
  const rgba = Buffer.alloc(width * height * 4);
  const expected = [];
  for (let i = 0; i < width * height; i++) {
    const colour = colours[(i * 7) % colours.length];
    expected.push(colour);
    // Alpha is ignored: the card is opaque.
    rgba.set([...colour, i % 2 ? 255 : 0], i * 4);
  }
  const image = decode(encodePalettePng(rgba, width, height));
  assert.deepEqual([image.width, image.height], [width, height]);
  assert.deepEqual(image.pixels, expected);
  assert.equal(image.palette.length, colours.length * 3);
});

test("an image of many colours is reduced to 256, each pixel near its own", () => {
  const width = 64;
  const height = 64;
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) rgba.set([x * 4, y * 4, (x + y) * 2, 255], (y * width + x) * 4);
  const image = decode(encodePalettePng(rgba, width, height));
  assert.equal(image.palette.length, 256 * 3);
  image.pixels.forEach((pixel, i) => {
    for (let channel = 0; channel < 3; channel++)
      assert.ok(Math.abs(pixel[channel] - rgba[i * 4 + channel]) <= 24, `pixel ${i}`);
  });
  // The same pixels give the same bytes.
  assert.deepEqual(
    encodePalettePng(rgba, width, height),
    encodePalettePng(Buffer.from(rgba), width, height),
  );
});

test("the card's page escapes the product name and takes only an inline logo", () => {
  const html = cardHtml({ name: `A&B <i>"x"</i>`, logo: LOGO });
  assert.ok(html.includes("<h1>Meet A&amp;B &lt;i&gt;&quot;x&quot;&lt;/i&gt;</h1>"));
  assert.equal(html.includes("<i>"), false);
  assert.ok(html.includes(`<img class="logo" alt="" src="${LOGO}">`));
  // Nothing on the page is fetched or run.
  assert.equal(/<script|<link|https?:\/\/(?!www\.w3\.org\/2000\/svg)/.test(html), false);
  for (const logo of [
    undefined,
    "https://example.com/logo.png",
    "/logo.png",
    `data:image/png;base64,AAAA"><script>`,
    "data:text/html;base64,AAAA",
  ])
    assert.throws(() => cardHtml({ logo }), /image data URL/, String(logo));
});

test("the logo, name and line sit inside the square a thumbnail keeps", () => {
  assert.deepEqual(CROP, { left: 285, right: 915 });
  const html = cardHtml({ logo: LOGO });
  /** A rule's `left` and `width`, as its left and right edges on the card. */
  const edges = (selector) => {
    const rule = html.slice(html.indexOf(`${selector} {`));
    const [, left, width] = /left: (-?\d+)px; width: (\d+)px;/.exec(rule);
    return { left: Number(left), right: Number(left) + Number(width) };
  };
  const words = edges(".words");
  assert.ok(words.left > CROP.left && words.right < CROP.right);
  // The column is centred on the card, so it is centred in the square too.
  assert.equal((words.left + words.right) / 2, CARD_WIDTH / 2);
  // The logo and the words are in that column; the drawn Pages are not.
  const column = html.slice(html.indexOf('<div class="words">'));
  for (const part of ['class="logo"', "<h1>Meet Pages</h1>", "write together."])
    assert.ok(column.includes(part), part);
  assert.equal(column.includes('class="page'), false);
  // The drawn Pages start outside the square, so a thumbnail is the words alone.
  const left = edges(".page.left").right;
  const right = edges(".page.right").left;
  assert.ok(left > 0 && left < CROP.left, `left Page ends at ${left}`);
  assert.ok(right > CROP.right && right < CARD_WIDTH, `right Page starts at ${right}`);
});
