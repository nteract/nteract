// A grid card image's raster: its size, its encoding and the devices that
// draw one. The capture (card-shell.mjs), its scheduler (card-capture.mjs),
// the grid (PageCardImage.jsx) and the shrink pass (card-shrink.mjs) share
// it. It imports no editor, document or rasterizer code, so the library's
// first download can hold it.
import { CARD_IMAGE_MAX_BYTES } from "../shared/card-images.mjs";

/** The card's first screen in CSS pixels: the grid card's 4:3 body. */
export const CARD_WIDTH = 640;
export const CARD_HEIGHT = 480;
/** Device pixels per CSS pixel in the image. The grid draws a card at most
 * about 300 CSS pixels wide, so 640×480 covers it at 2× device pixel ratio. */
export const CARD_SCALE = 1;
/** The image's size in pixels. A stored image wider or taller than this
 * is one the shrink pass (card-shrink.mjs) redraws. */
export const CARD_PIXEL_WIDTH = CARD_WIDTH * CARD_SCALE;
export const CARD_PIXEL_HEIGHT = CARD_HEIGHT * CARD_SCALE;
/** WebP quality. The images are mostly text, which blurs below this. */
export const CARD_WEBP_QUALITY = 0.86;
/** Below this `navigator.deviceMemory` (GB), a tab never draws a card. */
export const CARD_CAPTURE_MIN_MEMORY_GB = 2;

/** Whether this device should ever draw a card image: not on Save-Data, and
 * not on a device that reports little memory. */
export function captureAllowed(browser = globalThis.navigator) {
  if (browser?.connection?.saveData === true) return false;
  const memory = browser?.deviceMemory;
  return !(typeof memory === "number" && memory < CARD_CAPTURE_MIN_MEMORY_GB);
}

const toBlob = (canvas, type, quality) =>
  new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), type, quality));

/** WebP where the browser encodes it (Safari doesn't: it answers PNG),
 * then PNG, then JPEG if PNG is over the upload limit. */
export async function encodeCard(canvas) {
  const webp = await toBlob(canvas, "image/webp", CARD_WEBP_QUALITY);
  if (webp?.type === "image/webp" && webp.size <= CARD_IMAGE_MAX_BYTES) return webp;
  const png = webp?.type === "image/png" ? webp : await toBlob(canvas, "image/png");
  if (png && png.size <= CARD_IMAGE_MAX_BYTES) return png;
  const jpeg = await toBlob(canvas, "image/jpeg", 0.85);
  if (jpeg?.type === "image/jpeg" && jpeg.size <= CARD_IMAGE_MAX_BYTES) return jpeg;
  throw Error("The card image is larger than the upload limit");
}
