import { OUTPUT_FRAME_URL } from "./anywidget-view.mjs";

// The shell and its CSP must agree. This is deployment configuration, never
// Page content; a Page cannot choose which host receives its widget inputs.
export function outputFrameUrl(value = OUTPUT_FRAME_URL, pageOrigin) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw Error("PAGES_OUTPUT_FRAME_URL must be an absolute HTTPS URL");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.origin === new URL(pageOrigin).origin
  )
    throw Error(
      "PAGES_OUTPUT_FRAME_URL must be HTTPS on a separate origin, without credentials, query or fragment",
    );
  return url.href;
}
