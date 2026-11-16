import { OUTPUT_FRAME_URL } from "./anywidget-view.mjs";

// Build-time default and deployment-time shell use the same policy.
export const viewerCsp = (frameUrl = OUTPUT_FRAME_URL) =>
  `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; frame-src ${new URL(frameUrl).origin}`;
