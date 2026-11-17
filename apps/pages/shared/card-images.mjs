// Grid card image limits shared by the viewer that draws images
// (viewer/card-raster.mjs) and the Worker that accepts them
// (worker/card-images.mjs).

/** The largest upload, in bytes. A 640×480 WebP card is about 20–50 KB;
 * PNG from Safari runs larger. A 1280×960 image from an older capture runs
 * up to about 150 KB as PNG, and the owner's library re-uploads it at
 * 640×480 (viewer/card-shrink.mjs). */
export const CARD_IMAGE_MAX_BYTES = 300 * 1024;
