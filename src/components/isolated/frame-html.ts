import frameHtml from "./frame.html?raw";

export const FRAME_HTML = frameHtml;

/**
 * Generate the HTML template for an isolated output frame.
 *
 * Tauri serves the same physical HTML file from the `nteract-frame://`
 * URI scheme; browser-only dev mounts it via `srcDoc`.
 */
export function generateFrameHtml(): string {
  return FRAME_HTML;
}
