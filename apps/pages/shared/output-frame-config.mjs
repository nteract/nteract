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
  const page = new URL(pageOrigin);
  // Local celld and its credential-free output server use distinct loopback
  // hostnames. Cookies ignore port numbers, so a second port alone won't do.
  const localPair =
    page.protocol === "http:" &&
    page.hostname === "localhost" &&
    url.protocol === "http:" &&
    url.hostname === "127.0.0.1";
  if (
    (url.protocol !== "https:" && !localPair) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.origin === page.origin
  )
    throw Error(
      "PAGES_OUTPUT_FRAME_URL must be HTTPS on a separate origin, without credentials, query or fragment",
    );
  return url.href;
}
