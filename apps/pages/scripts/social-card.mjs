// Draws the link-preview card for the product's own pages (`/`, `/connect`
// and every Page link with no published preview) and writes it to
// shared/social-card.mjs, which the Worker serves (worker/site-tags.mjs).
//
//   node scripts/social-card.mjs                      # the card in the repo
//   node scripts/social-card.mjs --logo logo.png --png card.png
//
// The card is one fixed layout, 1200x630, in three columns. The middle one
// holds the deployment's logo, the product's name and its line. The content
// of a Page, with no frame, runs off each side at a slight tilt. Services
// that show a link's image as a square cut it from the middle (CROP), so the
// middle column is drawn inside that square and the Pages outside it.
// `--logo` (a PNG, JPEG, WebP or SVG file) and `--name` are the only parts a
// deployment changes. `--png` writes the image to a file instead of the
// module, for a deployment that serves its own card.
//
// It needs Chromium (`npx playwright install chromium`) and the fonts of the
// machine it runs on, so it is run by hand and its output is committed. The
// build never runs it. scripts/social-card.test.mjs checks the committed
// module against its own digest and size.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deflateSync } from "node:zlib";
import { PRODUCT_NAME } from "../shared/product.mjs";

export const CARD_WIDTH = 1200;
export const CARD_HEIGHT = 630;

const app = fileURLToPath(new URL("..", import.meta.url));
/** The nteract logo drawn for dark backgrounds, in a full checkout. A
 * Pages-only checkout passes `--logo`. */
const DEFAULT_LOGO = path.join(app, "../../logo-dark.svg");
const DEFAULT_MODULE = path.join(app, "shared/social-card.mjs");

const LOGO_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

const escapeHtml = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );

/** `file` as a data URL the card's page can show without a request. */
export function logoDataUrl(file) {
  const type = LOGO_TYPES[path.extname(file).toLowerCase()];
  if (!type) throw new Error(`Use a PNG, JPEG, WebP or SVG logo, not ${path.basename(file)}`);
  return `data:${type};base64,${readFileSync(file).toString("base64")}`;
}

/** The middle square a service such as Slack keeps when it shows the card
 * as a thumbnail: the card's full height, centred. */
export const CROP = Object.freeze({
  left: (CARD_WIDTH - CARD_HEIGHT) / 2,
  right: (CARD_WIDTH + CARD_HEIGHT) / 2,
});
/** The margin the words keep inside that square. */
const WORDS_MARGIN = 22;
/** How far outside that square each drawn Page's content starts, at the top
 * corner nearest the middle. */
const PAGE_GAP = 13;
/** How far each Page turns about that corner, in degrees: the left one
 * clockwise and the right one anticlockwise. The space between them widens
 * downward, where the line is, and the card's edges cut more of each Page. */
const PAGE_TILT = 5;

const n = (value) => value.toFixed(1);

// The drawn Pages are about themselves: who wrote this Page this week. The
// right one charts the edits, stacked by writer, and the left one tables them.
// Heights are in pixels, bottom series first; the third series is the agents,
// in the green the card's line gives "your agents".
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const EDITS = [
  { color: "#3d9bff", values: [21, 21, 23, 15, 15, 42, 36] },
  { color: "#ff6fae", values: [15, 17, 21, 10, 17, 57, 44] },
  { color: "#1cc48a", values: [25, 23, 19, 10, 13, 103, 124] },
  { color: "#f2a90f", values: [40, 40, 40, 29, 29, 50, 52] },
];

/** Stacked bars with no frame, axis labels or legend: the Page is cut by the
 * card's edge, and every pixel of its width goes to the bars. */
function barsSvg() {
  const width = 330;
  const baseline = 268;
  const step = width / DAYS.length;
  const bar = step * 0.8;
  const rules = [28, 88, 148, 208].map(
    (y) => `<line x1="0" x2="${width}" y1="${y}" y2="${y}" stroke="#26262a" />`,
  );
  const bars = DAYS.map((day, index) => {
    const x = index * step + (step - bar) / 2;
    let y = baseline;
    const segments = EDITS.map(({ color, values }) => {
      y -= values[index];
      // Half a pixel of overlap hides the seam between two segments.
      return `<rect x="${n(x)}" y="${n(y)}" width="${n(bar)}" height="${n(values[index] + 0.5)}" fill="${color}" />`;
    });
    // One clip per bar rounds the top of the stack, not each segment. It
    // runs past the baseline, so the foot stays square.
    return (
      `<clipPath id="bar${index}"><rect x="${n(x)}" y="${n(y)}" width="${n(bar)}" height="${n(baseline - y + 8)}" rx="5" /></clipPath>` +
      `<g clip-path="url(#bar${index})">${segments.join("")}</g>` +
      `<text x="${n(x + bar / 2)}" y="${baseline + 24}" text-anchor="middle" class="axis">${day}</text>`
    );
  });
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} 300" width="${width}" height="300">` +
    rules.join("") +
    bars.join("") +
    `<line x1="0" x2="${width}" y1="${baseline}" y2="${baseline}" stroke="#3a3a40" />` +
    `</svg>`
  );
}

// The left Page's table: the same week, by writer. The rows add up to the
// total. The highlighted line above each drawing says what it is; the card's
// edges cut both lines, and what is left is enough to read.
const WRITERS = [
  ["Agents", "760", "+98%"],
  ["Maya", "410", "+21%"],
  ["Sam", "370", "+6%"],
  ["You", "310", "\u22123%"],
  ["Total", "1,850", "+38%"],
];

function writersTable() {
  const rows = WRITERS.map(
    ([item, sold, change]) =>
      `<tr><td>${item}</td><td>${sold}</td><td${change.startsWith("+") ? ' class="up"' : ""}>${change}</td></tr>`,
  );
  return `<table class="grid"><tr><th>Writer</th><th>Edits</th><th>Change</th></tr>${rows.join("")}</table>`;
}

/** The card as a page: fixed text and drawing, `name` and `logo` (a data
 * URL) escaped into it. It loads nothing. */
export function cardHtml({ name = PRODUCT_NAME, logo }) {
  if (!/^data:image\/(png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(logo ?? ""))
    throw new Error("The card's logo must be an image data URL");
  const product = escapeHtml(name);
  // The edge of each Page's content nearest the middle.
  const leftEdge = CROP.left - PAGE_GAP;
  const rightEdge = CROP.right + PAGE_GAP;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<style>
  * { box-sizing: border-box; margin: 0; }
  html, body { width: ${CARD_WIDTH}px; height: ${CARD_HEIGHT}px; overflow: hidden; }
  body {
    position: relative;
    background: #09090b;
    color: #fafafa;
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .words { position: absolute; left: ${CROP.left + WORDS_MARGIN}px; width: ${CROP.right - CROP.left - 2 * WORDS_MARGIN}px; top: 0; height: 100%; display: flex; align-items: center; justify-content: center; }
  /* As wide as its widest line and centred in the column, with every line starting at its left edge. */
  .block { display: flex; flex-direction: column; align-items: flex-start; }
  .logo { height: 104px; max-width: 300px; object-fit: contain; object-position: left center; }
  h1 { margin-top: 30px; font-size: 76px; line-height: 1; font-weight: 800; letter-spacing: -0.035em; white-space: nowrap; }
  .line { margin-top: 26px; font-size: 52px; line-height: 1.34; font-weight: 700; letter-spacing: -0.025em; white-space: nowrap; }
  .line mark { display: inline-block; padding: 0 12px; margin-left: -12px; border-radius: 6px; background: #86efac; color: #052e16; line-height: 1.22; }
  /* A Page has no frame: only its content is drawn, turned about its top corner nearest the middle. */
  .page { position: absolute; top: 92px; }
  .page.left { left: -240px; width: ${leftEdge + 240}px; transform-origin: top right; transform: rotate(${PAGE_TILT}deg); }
  .page.right { left: ${rightEdge}px; width: 600px; transform-origin: top left; transform: rotate(${-PAGE_TILT}deg); }
  /* The left Page's content keeps its own width against the inner edge, so the card's edge cuts its start. */
  .sheet { width: 304px; margin-left: auto; }
  .title { display: flex; align-items: center; font-size: 38px; line-height: 1.1; font-weight: 800; letter-spacing: -0.03em; white-space: nowrap; }
  .caret { display: inline-block; flex: none; width: 4px; height: 1.15em; margin-left: 5px; border-radius: 2px; }
  /* One highlighted line with a writer's caret after it. It keeps its length: the card's edge cuts it. */
  .note { display: flex; align-items: center; margin-top: 18px; font-size: 26px; line-height: 1; font-weight: 500; white-space: nowrap; }
  .note mark { padding: 5px 6px 6px; border-radius: 3px; color: #18181b; }
  .note .caret { height: 1.5em; margin-left: 2px; }
  /* The left line ends at its Page's inner edge, so its start is what the card cuts. */
  .page.left .note { justify-content: flex-end; }
  .chart { margin-top: 26px; }
  .chart .axis { font-size: 15px; fill: #a1a1aa; font-family: inherit; }
  .grid { margin-top: 24px; width: 304px; border-collapse: collapse; font-size: 20px; }
  .grid th { padding: 0 0 10px; border-bottom: 2px solid #3f3f46; text-align: left; font-size: 15px; font-weight: 600; color: #a1a1aa; }
  .grid td { padding: 13px 0; border-bottom: 1px solid #27272a; color: #e4e4e7; white-space: nowrap; }
  .grid th:nth-child(n + 2), .grid td:nth-child(n + 2) { text-align: right; }
  .grid tr:last-child td { border-bottom: 0; font-weight: 700; color: #fafafa; }
  .grid .up { color: #86efac; font-weight: 600; }
</style></head>
<body>
  <div class="page left"><div class="sheet">
    <div class="title">Who's writing</div>
    <div class="note"><mark style="background:#8fcfff">Everyone edits this live table.</mark><span class="caret" style="background:#f2a90f"></span></div>
    ${writersTable()}
  </div></div>
  <div class="page right">
    <div class="title">Edits this week<span class="caret" style="background:#3d9bff"></span></div>
    <div class="note"><mark style="background:#fbd452">We let the agent plot this data.</mark><span class="caret" style="background:#ff6fae"></span></div>
    <div class="chart">${barsSvg()}</div>
  </div>
  <div class="words"><div class="block">
    <img class="logo" alt="" src="${logo}">
    <h1>Meet ${product}</h1>
    <p class="line">Your team and<br><mark>your agents</mark><br>write together.</p>
  </div></div>
</body></html>`;
}

// PNG, written here so the bytes depend only on the pixels: Chromium's own
// encoder favours speed, and its output differs between versions.
const CRC = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  data.copy(out, 8);
  let crc = 0xffffffff;
  for (let i = 4; i < 8 + data.length; i++) crc = CRC[(crc ^ out[i]) & 0xff] ^ (crc >>> 8);
  out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 8 + data.length);
  return out;
}

/**
 * An opaque image as an 8-bit palette PNG. `rgba` is `width * height * 4`
 * bytes; alpha is ignored. Colours are reduced to at most 256 by median cut
 * over the colours present, with no dithering: the card is flat colour and
 * antialiased edges, where dither noise costs bytes and shows.
 */
export function encodePalettePng(rgba, width, height) {
  const counts = new Map();
  for (let i = 0; i < rgba.length; i += 4) {
    const key = (rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2];
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let boxes = [[...counts].map(([key, count]) => [key >> 16, (key >> 8) & 255, key & 255, count])];
  const spread = (box) => {
    let best = { channel: 0, range: -1 };
    for (let channel = 0; channel < 3; channel++) {
      let low = 255;
      let high = 0;
      for (const colour of box) {
        if (colour[channel] < low) low = colour[channel];
        if (colour[channel] > high) high = colour[channel];
      }
      if (high - low > best.range) best = { channel, range: high - low };
    }
    return best;
  };
  while (boxes.length < 256) {
    // Split the box with the widest channel, at its pixel-weighted median.
    let pick = -1;
    let widest = { range: 0 };
    boxes.forEach((box, index) => {
      if (box.length < 2) return;
      const candidate = spread(box);
      if (candidate.range > widest.range) {
        widest = candidate;
        pick = index;
      }
    });
    if (pick < 0) break;
    const box = boxes[pick].sort((a, b) => a[widest.channel] - b[widest.channel]);
    const half = box.reduce((sum, colour) => sum + colour[3], 0) / 2;
    let seen = 0;
    let cut = 0;
    while (cut < box.length - 1 && seen + box[cut][3] <= half) seen += box[cut++][3];
    cut = Math.max(1, cut);
    boxes.splice(pick, 1, box.slice(0, cut), box.slice(cut));
  }
  const palette = Buffer.alloc(boxes.length * 3);
  const indexOf = new Map();
  boxes.forEach((box, index) => {
    const total = box.reduce((sum, colour) => sum + colour[3], 0);
    for (let channel = 0; channel < 3; channel++)
      palette[index * 3 + channel] = Math.round(
        box.reduce((sum, colour) => sum + colour[channel] * colour[3], 0) / total,
      );
    for (const [r, g, b] of box) indexOf.set((r << 16) | (g << 8) | b, index);
  });
  // Filter 0 on every row: indexed rows of flat colour deflate best unfiltered.
  const rows = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      rows[y * (width + 1) + 1 + x] = indexOf.get(
        (rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2],
      );
    }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 3, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("PLTE", palette),
    chunk("IDAT", deflateSync(rows, { level: 9, memLevel: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** The card's pixels, drawn by Chromium at one device pixel per CSS pixel. */
async function renderCard(html) {
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: CARD_WIDTH, height: CARD_HEIGHT },
      deviceScaleFactor: 1,
      // The card's page is fixed text and a data URL: nothing to fetch.
      offline: true,
      javaScriptEnabled: true,
    });
    await page.setContent(html, { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready);
    // A long product name shrinks to the column instead of running under the
    // drawn Page.
    await page.evaluate(() => {
      const heading = document.querySelector("h1");
      const room = heading.closest(".words").clientWidth;
      const size = parseFloat(getComputedStyle(heading).fontSize);
      if (heading.scrollWidth > room)
        heading.style.fontSize = `${Math.floor((size * room) / heading.scrollWidth)}px`;
    });
    const shot = await page.screenshot({ type: "png" });
    // Read the pixels back through a canvas: the screenshot is the only view
    // of the page's own rendering, and the PNG is re-encoded above.
    const pixels = await page.evaluate(async (base64) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext("2d");
      context.drawImage(bitmap, 0, 0);
      const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
      let text = "";
      for (let i = 0; i < data.length; i += 0x8000)
        text += String.fromCharCode(...data.subarray(i, i + 0x8000));
      return btoa(text);
    }, shot.toString("base64"));
    return Buffer.from(pixels, "base64");
  } finally {
    await browser.close();
  }
}

/** The module the Worker imports: the card's bytes, their digest for the
 * URL, and the size the tags state. */
export function cardModule(png) {
  const digest = createHash("sha256").update(png).digest("hex");
  return `// The link-preview card for the product's own pages: ${CARD_WIDTH}x${CARD_HEIGHT}, served at
// SOCIAL_CARD_PATH by the Worker (worker/site-tags.mjs). Link unfurlers fetch
// it by absolute URL, so it needs a route; inlining the bytes keeps it out of
// the asset build and the release file lists.
//
// Generated by scripts/social-card.mjs. Don't edit it: run that script, look
// at the image, and commit the result. SOCIAL_CARD_VERSION is the start of
// the bytes' sha256 and goes in the image URL, so a new card is a new URL to
// every service that kept the old one.
export const SOCIAL_CARD_PATH = "/social-card.png";
export const SOCIAL_CARD_WIDTH = ${CARD_WIDTH};
export const SOCIAL_CARD_HEIGHT = ${CARD_HEIGHT};
export const SOCIAL_CARD_VERSION = "${digest.slice(0, 12)}";
export const SOCIAL_CARD_BASE64 =
  "${png.toString("base64")}";
`;
}

function readArguments(argv) {
  const options = { logo: DEFAULT_LOGO, name: PRODUCT_NAME, png: null };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!["--logo", "--name", "--png"].includes(flag) || argv[i + 1] === undefined)
      throw new Error("Usage: social-card.mjs [--logo FILE] [--name NAME] [--png FILE]");
    options[flag.slice(2)] = argv[++i];
  }
  return options;
}

async function main() {
  const options = readArguments(process.argv.slice(2));
  const html = cardHtml({ name: options.name, logo: logoDataUrl(options.logo) });
  const png = encodePalettePng(await renderCard(html), CARD_WIDTH, CARD_HEIGHT);
  const target = options.png ?? DEFAULT_MODULE;
  writeFileSync(target, options.png ? png : cardModule(png));
  console.log(`Wrote ${path.relative(process.cwd(), target)}: ${png.length} bytes of PNG`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
