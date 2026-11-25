import { OUTPUT_FRAME_URL } from "../shared/anywidget-view.mjs";
import { outputFrameUrl } from "../shared/output-frame-config.mjs";
import { viewerCsp } from "../shared/viewer-csp.mjs";

const escapeAttribute = (value) =>
  value.replace(/[&"<>]/g, (c) => ({ "&": "&amp;", '"': "&quot;", "<": "&lt;", ">": "&gt;" })[c]);

/** PAGES_OUTPUT_FRAME_LOCAL_NETWORK: `true` when the deployment is on a
 * private address and its output host is public, so views must ask for
 * Chrome's local-network permission to import this host's libraries.
 * Unset, empty or `false` is off; any other value is a misconfiguration. */
export function outputFrameLocalNetwork(value) {
  if (value === undefined || value === "" || value === "false") return false;
  if (value === "true") return true;
  throw Error("PAGES_OUTPUT_FRAME_LOCAL_NETWORK must be true or false");
}

/** Configure the app shell at delivery, including shells used by link previews.
 * A configured shell names the output frame URL (`value`, or the build's
 * default), with the CSP that admits it, and with `localNetwork` it marks
 * views to delegate the local-network permission to their frames
 * (viewer/anywidget-view.mjs). Without either setting the shell is the
 * build's own. Asset bytes stay immutable; configured HTML has no build-time
 * validator. */
export function outputFrameAssets(assets, value, pageOrigin, localNetwork = false) {
  if (value === undefined && !localNetwork) return assets;
  const frameUrl = outputFrameUrl(value ?? OUTPUT_FRAME_URL, pageOrigin);
  const meta =
    `<meta name="pages-output-frame-url" content="${escapeAttribute(frameUrl)}" />` +
    (localNetwork ? `<meta name="pages-output-frame-local-network" content="true" />` : "");
  return {
    async fetch(request) {
      if (!["GET", "HEAD"].includes(request.method)) return assets.fetch(request);
      // Hashed JS/CSS/WASM and other files keep their normal cache behavior.
      const path = new URL(request.url).pathname;
      if (/\.[a-z0-9]+$/i.test(path) && !path.endsWith(".html")) return assets.fetch(request);
      const headers = new Headers(request.headers);
      for (const key of [
        "if-none-match",
        "if-modified-since",
        "if-match",
        "if-unmodified-since",
        "if-range",
        "range",
      ])
        headers.delete(key);
      const response = await assets.fetch(new Request(request, { method: "GET", headers }));
      if (response.status !== 200 || !response.headers.get("content-type")?.startsWith("text/html"))
        return request.method === "HEAD" ? new Response(null, response) : response;
      const html = await response.text();
      const body = html.replace("</head>", () => `${meta}</head>`);
      const out = new Headers(response.headers);
      // Set this here even when the host's asset binding omits _headers.
      out.set("content-security-policy", viewerCsp(frameUrl));
      for (const key of ["etag", "last-modified", "content-length", "content-encoding"])
        out.delete(key);
      out.set("cache-control", "no-store");
      return new Response(request.method === "HEAD" ? null : body, { status: 200, headers: out });
    },
  };
}
