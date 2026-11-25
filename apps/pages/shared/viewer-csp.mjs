import { OUTPUT_FRAME_URL } from "./anywidget-view.mjs";

// Build-time default and deployment-time shell use the same policy. A
// deployment that names a library origin reads catalog manifests from it.
export const viewerCsp = (frameUrl = OUTPUT_FRAME_URL, libraryOrigin) =>
  `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; media-src 'self' blob:; connect-src 'self'${libraryOrigin ? " " + libraryOrigin : ""}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; frame-src ${new URL(frameUrl).origin}`;
