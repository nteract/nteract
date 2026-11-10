// Grid card image limits shared by the viewer that draws images
// (viewer/card-shell.mjs) and the Worker that accepts them
// (worker/card-images.mjs).

/** The largest upload, in bytes. A 1280×960 WebP card is about 15–60 KB;
 * PNG from Safari runs larger. */
export const CARD_IMAGE_MAX_BYTES = 300 * 1024;
