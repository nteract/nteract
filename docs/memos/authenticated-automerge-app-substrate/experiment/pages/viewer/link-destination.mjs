import { safeUrl } from "../model/richtext.mjs";

// Opening is stricter than markup parsing: resolve relative links first and
// never let a generic document writer navigate to an executable scheme.
export function linkDestination(href, base) {
  if (!href || !safeUrl(href)) return null;
  try {
    const url = new URL(href, base);
    return ["https:", "http:", "mailto:", "tel:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}
