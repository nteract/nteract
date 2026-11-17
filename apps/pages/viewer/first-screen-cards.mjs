// The library grid's first-screen cards: the ones whose images load eagerly
// at high priority (Library.jsx), and that the editor start waits on before
// it shares the link with them (editor-start.mjs).

// The grid is at most 1200px wide with 200px columns and 1rem gaps
// (style.css, .index-grid), so its widest layout has 5 columns: this is its
// first row. One row, not the whole first screen: the largest paint is the
// first image to finish, and on a throttled HTTP/2 link every high-priority
// image shares the bandwidth, so fewer of them finish the first one sooner.
// scripts/library-lcp-benchmark.mjs on Fast 4G put LCP at 2.4 s with 5,
// 3.2 s with 10 and 2.8 s with 20. Measure again before raising it.
export const FIRST_SCREEN_CARDS = 5;

/** A held placeholder for a row the device remembers but the server hasn't
 * answered for: no title, link, card or image. It is neither a drawn row nor
 * something to wait on. */
export const HELD = ".index-row-held, .index-card-held";

/** The grid cards the editor start waits on: the first FIRST_SCREEN_CARDS
 * drawn cards that start inside the viewport. None in list mode. */
export function firstScreenCards(page, win) {
  const height = win.innerHeight;
  return [...page.querySelectorAll(".index-card")]
    .filter((card) => !card.closest(HELD) && !card.querySelector(HELD))
    .slice(0, FIRST_SCREEN_CARDS)
    .filter((card) => card.getBoundingClientRect().top < height);
}

/** Whether a card's image is done: its card drew and the shown theme's image
 * loaded or failed (a failed one is removed), or it has no image. A card
 * still showing its placeholder isn't done. */
export function cardSettled(card, win) {
  if (!card.isConnected) return true;
  if (!card.querySelector(".page-card-preview")) return false;
  return [...card.querySelectorAll("img.page-card-image")]
    .filter((image) => win.getComputedStyle(image).display !== "none")
    .every((image) => image.complete);
}
