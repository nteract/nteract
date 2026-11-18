// The library's side of the card image shrink pass (card-shrink.mjs).
//
// A grid card whose row says the account owns the Page reports the natural
// size of each card image it loaded. One wider or taller than a capture
// (card-raster.mjs) is offered to the pass, which loads on the first offer:
// a library whose images are all capture-sized never downloads it. Save-Data
// and low-memory devices offer nothing. One pass runs per connection, so
// leaving the library stops it and the next visit starts a new one.
import { CARD_PIXEL_HEIGHT, CARD_PIXEL_WIDTH, captureAllowed } from "./card-raster.mjs";

/** Whether a loaded image of `width`×`height` pixels is larger than a capture. */
export const largerThanCapture = (width, height) =>
  width > CARD_PIXEL_WIDTH || height > CARD_PIXEL_HEIGHT;

/**
 * - `load()`: imports card-shrink.mjs.
 * - `allowed()`: whether this device draws card images (captureAllowed).
 */
export class CardShrinkOffers {
  /** Offers made before the first connection. */
  #early = [];
  #visit = null;
  constructor({
    load = () => import("./card-shrink.mjs"),
    allowed = () => captureAllowed(globalThis.navigator),
  } = {}) {
    this.load = load;
    this.allowed = allowed;
  }

  /** Start a visit's pass; returns the stop function (useConnected). React
   * may connect, stop and connect the same instance again. */
  connect() {
    const visit = { pass: null, stopped: false };
    this.#visit = visit;
    for (const candidate of this.#early.splice(0)) this.#send(visit, candidate);
    return () => {
      visit.stopped = true;
      visit.ready?.then((pass) => pass?.stop());
      if (this.#visit === visit) this.#visit = null;
    };
  }

  /** A grid card loaded `image` (`{ card_hash, light, dark }`) of the Page
   * `pageId` at `width`×`height` pixels. */
  offer(pageId, image, width, height) {
    if (!largerThanCapture(width, height)) return;
    const candidate = {
      page_id: pageId,
      card_hash: image.card_hash,
      light: image.light,
      dark: image.dark,
    };
    if (this.#visit) this.#send(this.#visit, candidate);
    else this.#early.push(candidate);
  }

  #send(visit, candidate) {
    if (!this.allowed()) return;
    visit.ready ??= Promise.resolve()
      .then(this.load)
      .then((module) => (visit.stopped ? null : module.startCardShrink()))
      .catch(() => null);
    visit.ready
      .then((pass) => {
        if (!visit.stopped) pass?.offer(candidate);
      })
      .catch(() => {});
  }
}
