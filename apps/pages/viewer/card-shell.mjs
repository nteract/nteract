// The card shell: a Page's first screen drawn read-only with the editor's
// own widgets (wordgard-page-config.mjs), offscreen, then rasterized into
// one image per theme for the library grid (card-capture.mjs uploads them).
//
// The shell never copies the live editor, so no caret, selection, presence,
// comment highlight or toolbar can reach an image. It renders the blocks the
// JSON card holds (model/page-card.mjs cardContent), cut to their first
// top-level nodes, in a same-origin iframe sized to the card. The iframe has
// the app's own stylesheets and its own root, so it can draw light and dark
// whatever this tab shows. It sits fixed at the viewport's corner with
// opacity 0 and no pointer events, so widgets that wait for the viewport
// still draw; dataframes load eagerly regardless. Charts draw from the
// session's view replicas and source store, the ones the live editor uses,
// so a chart the editor already holds costs the shell no new lookup.
//
// The rasterizer (modern-screenshot) loads with this module, which loads on
// the first capture, so neither grows the app's first download. Images are
// drawn at card size before they are inlined, and a cross-origin image is
// never drawn onto a canvas: it becomes a transparent pixel.
import * as A from "@automerge/automerge/slim";
import { Wordgard } from "wordgard/editor";
import { filter, firstValueFrom, interval, race, take, timer } from "rxjs";
import { cardContent } from "../model/page-card.mjs";
import { textPath } from "../model/richtext-format.mjs";
import { decode } from "./wordgard-model.mjs";
import { readOnlyPageConfig } from "./wordgard-page-config.mjs";
import { VIEW_EMBED_UNAVAILABLE } from "./wordgard-views.mjs";
import { CARD_IMAGE_MAX_BYTES } from "../shared/card-images.mjs";

/** The card's first screen in CSS pixels: the grid card's 4:3 body. */
export const CARD_WIDTH = 640;
export const CARD_HEIGHT = 480;
/** Device pixels per CSS pixel in the image: 1280×960. */
export const CARD_SCALE = 2;
/** Top-level nodes and text the shell renders: well past one screen. */
const MAX_NODES = 24;
const MAX_TEXT = 4_000;
/** How long the shell waits for its diagrams, tables and images. */
const READY_MS = 10_000;
const TRANSPARENT =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

// Card mode: no diagram or zoom controls, no scrollbars, no motion. The
// shell paints the grid card's background (`--card`) where the Page paints
// its own (`--surface`), so an image matches the JSON card it replaces.
const CARD_CSS = `
:root { --surface: var(--card); --canvas: var(--card); }
html, body { margin: 0; background: var(--card); }
.card-shell { box-sizing: border-box; width: ${CARD_WIDTH}px; height: ${CARD_HEIGHT}px;
  max-width: none; margin: 0; padding: 22px 30px; overflow: hidden; background: var(--card);
  color: var(--foreground); }
.card-shell article { max-width: none; margin: 0; padding: 0; background: transparent; }
.card-shell .page-block { margin: 0; }
.card-shell .wordgard-diagram-actions, .card-shell .pele-zoom,
.card-shell .wordgard-code-actions, .card-shell .wg-code-language { display: none !important; }
.card-shell .wordgard-diagram-canvas { padding-inline-end: 0 !important; overflow: hidden; }
.card-shell * { scrollbar-width: none; animation: none !important; transition: none !important; }
.card-shell ::-webkit-scrollbar { display: none; }
`;

/**
 * A block's spans, cut at a top-level node boundary once the shell has
 * `nodes` nodes or `text` characters, whichever comes first. A cut always
 * falls before a top-level block marker, so the prefix decodes as a valid
 * document; one long node is cut in its text at three times the budget.
 */
export function firstScreenSpans(spans, budget = { nodes: MAX_NODES, text: MAX_TEXT }) {
  const kept = [];
  const topLevelBlock = (span) => span?.type === "block" && !(span.value?.parents?.length > 0);
  // A block a merge left opening with unmarked text has a paragraph there.
  if (spans.length && !topLevelBlock(spans[0])) budget.nodes--;
  for (const span of spans) {
    const topLevel = topLevelBlock(span);
    if (topLevel) {
      if (budget.nodes <= 0 || budget.text <= 0) break;
      budget.nodes--;
    }
    if (span.type === "text") {
      const value = String(span.value);
      if (budget.text < -2 * MAX_TEXT) break;
      const room = Math.max(0, budget.text + 2 * MAX_TEXT);
      kept.push(value.length > room ? { ...span, value: value.slice(0, room) } : span);
      budget.text -= value.length;
      continue;
    }
    kept.push(span);
  }
  return kept;
}

/** The blocks the card shows, as spans for the shell, in card order. */
export function shellBlocks(doc) {
  const budget = { nodes: MAX_NODES, text: MAX_TEXT };
  const blocks = [];
  for (const { id } of cardContent(doc).blocks) {
    if (budget.nodes <= 0 || budget.text <= 0) break;
    blocks.push({ id, spans: firstScreenSpans(A.spans(doc, textPath(id)), budget) });
  }
  return blocks;
}

/** A hidden, same-origin iframe the size of the card, with the app's
 * stylesheets and the card's own. */
async function createFrame(document, signal) {
  const frame = document.createElement("iframe");
  // Out of focus, find-in-page and the accessibility tree, whatever loads in it.
  frame.inert = true;
  frame.setAttribute("aria-hidden", "true");
  frame.setAttribute("tabindex", "-1");
  frame.setAttribute("title", "");
  frame.style.cssText = [
    "position:fixed",
    "left:0",
    "top:0",
    `width:${CARD_WIDTH}px`,
    `height:${CARD_HEIGHT}px`,
    "border:0",
    "opacity:0",
    "pointer-events:none",
    "z-index:-1",
    "contain:strict",
  ].join(";");
  document.body.append(frame);
  const inner = frame.contentDocument;
  const links = [];
  for (const node of document.querySelectorAll('link[rel="stylesheet"], style')) {
    const copy = inner.importNode(node, true);
    if (copy.localName === "link") links.push(copy);
    inner.head.append(copy);
  }
  const style = inner.createElement("style");
  style.textContent = CARD_CSS;
  inner.head.append(style);
  await Promise.all(
    links.map(
      (link) =>
        new Promise((resolve) => {
          link.addEventListener("load", resolve, { once: true });
          link.addEventListener("error", resolve, { once: true });
          setTimeout(resolve, 3_000);
        }),
    ),
  );
  signal.throwIfAborted();
  return frame;
}

/**
 * Wordgard editors have no destroy: a widget lets go of what it holds (a
 * view, a chart, a download) only when its editor element disconnects.
 * Removing the iframe doesn't disconnect the elements inside it, so the
 * shell empties the body itself before each theme and before it goes.
 */
function unmountShell(frame) {
  frame.contentDocument?.body?.replaceChildren();
}

/** Draw `blocks` in `frame` under `theme`; returns the shell. The previous
 * theme's widgets disconnect before the root changes theme, so they don't
 * redraw for it. */
function mountShell(frame, { blocks, pageId, theme, views, sources }) {
  const inner = frame.contentDocument;
  unmountShell(frame);
  const root = inner.documentElement;
  root.classList.toggle("dark", theme === "dark");
  root.classList.toggle("light", theme !== "dark");
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  const shell = inner.body.appendChild(inner.createElement("main"));
  shell.className = "workspace document card-shell";
  const article = shell.appendChild(inner.createElement("article"));
  for (const block of blocks) {
    const section = article.appendChild(inner.createElement("section"));
    section.className = "page-block";
    const wrap = section.appendChild(inner.createElement("div"));
    wrap.className = "rich-editor wordgard-editor";
    Wordgard.create({
      parent: wrap,
      doc: decode(block.spans).doc,
      config: [
        readOnlyPageConfig({ pageId, eagerDataframes: true, views, sources }),
        Wordgard.editorAttributes.of({ class: "wordgard-document" }),
      ],
    });
  }
  return shell;
}

const onScreen = (element) => element.getBoundingClientRect().top < CARD_HEIGHT;

/**
 * Whether a view embed (wordgard-views.mjs) is done: its chart finished
 * (vega-chart.mjs `data-chart-status` past "drawing", drawn or in its error
 * state), or it shows a sentence that stays: a blocked view or data that
 * couldn't load (view-draw.mjs), or a chart chunk that didn't load.
 */
export function viewSettled(embed) {
  const view = embed.querySelector(".pages-view");
  const state = view?.dataset.viewState;
  if (state === "blocked" || state === "failed") return true;
  if (state === "drawn") {
    const chart = view.querySelector(".pages-view-chart:not([hidden]) .pages-chart");
    return !!chart && chart.dataset.chartStatus !== "drawing";
  }
  const status = embed.querySelector(":scope > .wordgard-view-status");
  return status?.textContent === VIEW_EMBED_UNAVAILABLE;
}

/** Whether every widget on the first screen has drawn or given up. */
function widgetsDrawn(shell) {
  for (const embed of shell.querySelectorAll(".wordgard-view-embed"))
    if (onScreen(embed) && !viewSettled(embed)) return false;
  for (const diagram of shell.querySelectorAll(".wordgard-diagram")) {
    if (!onScreen(diagram)) continue;
    const status = diagram.querySelector(":scope > p[role=status]");
    if (
      !diagram.querySelector(".wordgard-diagram-canvas > svg") &&
      !/unavailable/i.test(status?.textContent ?? "")
    )
      return false;
  }
  for (const table of shell.querySelectorAll(".wordgard-dataframe-table")) {
    if (!onScreen(table)) continue;
    const canvas = table.querySelector(".wordgard-dataframe-canvas");
    const status = table.querySelector(".wordgard-dataframe-body > p");
    const failed = status && !status.hidden && /unavailable|can't show/i.test(status.textContent);
    if (!failed && !canvas?.querySelector(".sift-row, [role=row]")) return false;
  }
  return true;
}

/** Wait (bounded) for the first screen's widgets and images. A widget still
 * drawing at the deadline is captured as it is. */
async function widgetsReady(shell, signal) {
  await firstValueFrom(
    race(
      interval(50).pipe(filter(() => signal.aborted || widgetsDrawn(shell))),
      timer(READY_MS),
    ).pipe(take(1)),
  );
  signal.throwIfAborted();
  await Promise.all(
    [...shell.querySelectorAll("img")].filter(onScreen).map((img) => img.decode().catch(() => {})),
  );
  // Two frames, so the last layout (a table's rows, a diagram's fit) lands.
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  signal.throwIfAborted();
}

/**
 * Inline an image at the size the card draws it. modern-screenshot asks this
 * for each image URL it embeds; a cross-origin URL gets a transparent pixel,
 * and so does an image below the first screen.
 */
function cardImageFetch(shell, origin) {
  return async (url) => {
    let target;
    try {
      target = new URL(url, origin);
    } catch {
      return TRANSPARENT;
    }
    if (target.protocol === "data:") return false;
    if (target.origin !== origin) return TRANSPARENT;
    const img = [...shell.querySelectorAll("img")].find(
      (candidate) => candidate.currentSrc === target.href || candidate.src === target.href,
    );
    if (!img) return TRANSPARENT;
    if (!onScreen(img) || !img.naturalWidth) return TRANSPARENT;
    const rect = img.getBoundingClientRect();
    const canvas = shell.ownerDocument.createElement("canvas");
    canvas.width = Math.max(1, Math.min(img.naturalWidth, Math.round(rect.width * CARD_SCALE)));
    canvas.height = Math.max(1, Math.min(img.naturalHeight, Math.round(rect.height * CARD_SCALE)));
    const context = canvas.getContext("2d");
    context.imageSmoothingQuality = "high";
    context.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png");
  };
}

const toBlob = (canvas, type, quality) =>
  new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), type, quality));

/** WebP where the browser encodes it (Safari doesn't: it answers PNG),
 * then PNG, then JPEG if PNG is over the upload limit. */
export async function encodeCard(canvas) {
  const webp = await toBlob(canvas, "image/webp", 0.86);
  if (webp?.type === "image/webp" && webp.size <= CARD_IMAGE_MAX_BYTES) return webp;
  const png = webp?.type === "image/png" ? webp : await toBlob(canvas, "image/png");
  if (png && png.size <= CARD_IMAGE_MAX_BYTES) return png;
  const jpeg = await toBlob(canvas, "image/jpeg", 0.85);
  if (jpeg?.type === "image/jpeg" && jpeg.size <= CARD_IMAGE_MAX_BYTES) return jpeg;
  throw Error("The card image is larger than the upload limit");
}

/** Run `work` when the main thread is idle, or after `ms` at the latest. */
function whenIdle(ms = 2_000) {
  return new Promise((resolve) => {
    if (typeof requestIdleCallback === "function")
      requestIdleCallback(() => resolve(), { timeout: ms });
    else setTimeout(resolve, 0);
  });
}

/**
 * Light and dark images of `doc`'s first screen: `[{ theme, blob }]`, each
 * CARD_WIDTH×CARD_HEIGHT CSS pixels at CARD_SCALE. Stops when `signal`
 * aborts. Each rasterization is measured as `pages-card-capture`. `views`
 * and `sources` are the session's (session.mjs `views`, `pageSources`);
 * without them a view node draws as its inert figure.
 */
export async function renderCardImages({
  doc,
  pageId,
  signal,
  views = null,
  sources = null,
  themes = ["light", "dark"],
}) {
  const blocks = shellBlocks(doc);
  if (!blocks.length) throw Error("The Page has no first screen to draw");
  const { domToCanvas } = await import("modern-screenshot");
  const document = globalThis.document;
  await whenIdle();
  signal.throwIfAborted();
  const frame = await createFrame(document, signal);
  try {
    const images = [];
    for (const theme of themes) {
      const shell = mountShell(frame, { blocks, pageId, theme, views, sources });
      await widgetsReady(shell, signal);
      await whenIdle();
      signal.throwIfAborted();
      const start = performance.now();
      const canvas = await domToCanvas(shell, {
        width: CARD_WIDTH,
        height: CARD_HEIGHT,
        scale: CARD_SCALE,
        backgroundColor: frame.contentWindow.getComputedStyle(shell).backgroundColor,
        font: false,
        timeout: 5_000,
        fetchFn: cardImageFetch(shell, globalThis.location.origin),
        filter: (node) => node.nodeType !== 1 || node.getBoundingClientRect().top < CARD_HEIGHT,
      });
      const blob = await encodeCard(canvas);
      performance.measure?.("pages-card-capture", {
        start,
        end: performance.now(),
        detail: { theme, type: blob.type, bytes: blob.size },
      });
      signal.throwIfAborted();
      images.push({ theme, blob });
    }
    return images;
  } finally {
    unmountShell(frame);
    frame.remove();
  }
}
