// The frame CSP a local output host serves. The output Worker's policy
// (output/policy.mjs) admits library modules over https: only. A local Pages
// host serves its library catalog over http on a loopback name, so a local
// frame server adds exactly that origin to script-src and style-src. Nothing
// else changes, and a deployed output host never uses this.
import { FRAME_CSP } from "../output/policy.mjs";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** FRAME_CSP that also admits scripts and styles from `pagesOrigin`, an
 * http origin on a loopback name. An https origin is already admitted, so the
 * policy comes back unchanged. Anything else throws. */
export function localFrameCsp(pagesOrigin, csp = FRAME_CSP) {
  const url = new URL(pagesOrigin);
  if (url.origin !== pagesOrigin) throw new Error(`Not an origin: ${pagesOrigin}`);
  if (url.protocol === "https:") return csp;
  if (url.protocol !== "http:" || !LOOPBACK.has(url.hostname))
    throw new Error(`A local Pages origin is http on a loopback name, not ${pagesOrigin}`);
  const directives = csp.split("; ");
  for (const name of ["script-src", "style-src"]) {
    const index = directives.findIndex((directive) => directive.startsWith(name + " "));
    if (index === -1) throw new Error(`The frame CSP has no ${name}`);
    directives[index] += " " + url.origin;
  }
  return directives.join("; ");
}
