/** The page a browser gets when Pages is starting.
 *
 * A request that waits too long for a fresh isolate's one-time setup is
 * refused with a retryable 503 (isolate-setup.mjs). API clients read that
 * refusal as JSON. A person whose browser opened a sign-in route instead gets
 * this page: it says Pages is starting and loads the same address again on its
 * own.
 *
 * The reload is the `Refresh` header and a matching `<meta http-equiv>`, with
 * no URL: a browser then reloads the document's own address, so nothing from
 * the request is written into the page. The page loads only the shell's theme
 * script and stylesheet, the files the OAuth and /connect pages load, and runs
 * under the same CSP.
 *
 * Reloading is safe only where the refusal comes before the route takes a
 * one-time value. The sign-in callbacks (`/oidc`, the Kilo callback) wait for
 * their setup before they take their `state`; a refusal after that is caught
 * by the route and answered with its own sign-in failure page. A new route
 * that takes a one-time value before an `isolateSetup` wait must catch the
 * refusal itself, or this page would send the spent value again.
 *
 * Reloads are bounded by a short-lived cookie that counts them
 * (`startingRetry`). After the last one the page stays, says Pages is taking
 * longer than usual, and offers a link that loads the address again and
 * starts a new count. */
import { FAVICON_LINK } from "../shared/favicon.mjs";
import { PRODUCT_NAME, tabTitle } from "../shared/product.mjs";
import { STYLESHEET, THEME_SCRIPT } from "../shared/shell-assets.mjs";
import { isStartingRefusal } from "./isolate-setup.mjs";

/** The count cookie. `__Host-` pins it to this origin with `Path=/`. */
export const STARTING_COOKIE = "__Host-pages_starting";

/** Seconds before each reload: about 30 s in all, the length of one setup
 * attempt (`isolateSetupTimeouts.attempt`). Each request also waits for the
 * setup before it is refused, so the whole sequence runs longer. */
export const STARTING_REFRESH_SECONDS = Object.freeze([2, 3, 5, 8, 12]);

/** How long the count lasts. It outlives the longest gap between two
 * starting pages: the longest delay plus a starter's 30 s wait. */
const COUNT_SECONDS = 60;

/** `Retry-After` on the page that no longer reloads. */
const FINAL_RETRY_SECONDS = 30;

/**
 * The retry after `count` starting pages in a row. Returns the delay before
 * the next reload, or null when the page should stop reloading, and the count
 * the page's cookie carries. The page that stops resets the count, so its
 * "Try again" link starts a new sequence.
 */
export function startingRetry(count) {
  const done = Number.isSafeInteger(count) && count >= 0 ? count : 0;
  if (done < STARTING_REFRESH_SECONDS.length)
    return { refreshSeconds: STARTING_REFRESH_SECONDS[done], nextCount: done + 1 };
  return { refreshSeconds: null, nextCount: 0 };
}

/** The count this browser's cookie holds, or 0. A repeated or malformed
 * cookie holds nothing. */
export function startingCount(request) {
  const values = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${STARTING_COOKIE}=`))
    .map((part) => part.slice(STARTING_COOKIE.length + 1));
  if (values.length !== 1 || !/^[0-9]$/.test(values[0])) return 0;
  return Math.min(Number(values[0]), STARTING_REFRESH_SECONDS.length);
}

/** Paths a person opens in a browser tab. Everything under /api/ except the
 * sign-in routes is for programs, as are /mcp, /internal/, the OAuth endpoints
 * other than authorize, and OAuth metadata. */
function browserPath(pathname) {
  if (pathname === "/mcp" || pathname.startsWith("/internal/")) return false;
  if (pathname.startsWith("/.well-known/")) return false;
  if (pathname.startsWith("/api/")) return pathname.startsWith("/api/auth/");
  if (pathname.startsWith("/oauth/")) return pathname === "/oauth/authorize";
  return true;
}

/** Whether `accept` ranks text/html at least as high as any other type. */
function prefersHtml(accept) {
  let html = 0;
  let other = 0;
  for (const range of accept.toLowerCase().split(",")) {
    const [type, ...params] = range.split(";").map((part) => part.trim());
    const q = params.find((param) => param.startsWith("q="));
    const weight = q === undefined ? 1 : Number(q.slice(2));
    if (!Number.isFinite(weight)) continue;
    if (type === "text/html") html = Math.max(html, weight);
    else if (type) other = Math.max(other, weight);
  }
  return html > 0 && html >= other;
}

/** Whether `request` is a person's browser opening a page: a GET or HEAD
 * navigation with no Authorization header, to a path people open. Without
 * `Sec-Fetch-Mode`, an Accept that prefers HTML stands in for it. */
export function isBrowserNavigation(request) {
  if (!["GET", "HEAD"].includes(request.method)) return false;
  if (request.headers.has("authorization")) return false;
  if (!browserPath(new URL(request.url).pathname)) return false;
  const mode = request.headers.get("sec-fetch-mode");
  if (mode !== null) return mode === "navigate";
  return prefersHtml(request.headers.get("accept") ?? "");
}

const CONTENT = {
  reloading: {
    title: "Pages is starting",
    body: `<p class="setup-intro" role="status">This page will continue on its own in a moment.</p><div class="starting-progress" aria-hidden="true"></div>`,
  },
  stopped: {
    title: "Pages is taking longer than usual",
    body: `<p class="setup-intro" role="status">It hasn't finished starting yet.</p><p class="setup-actions"><a class="primary setup-action" href="">Try again</a></p>`,
  },
};

/** The page for the retry `startingRetry` chose. `href=""` and a bare
 * `Refresh` both resolve to the document's own address; `base-uri 'none'`
 * keeps it that way. */
function startingDocument(refreshSeconds) {
  const { title, body } = CONTENT[refreshSeconds === null ? "stopped" : "reloading"];
  const refresh =
    refreshSeconds === null ? "" : `<meta http-equiv="refresh" content="${refreshSeconds}">`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${refresh}<title>${tabTitle(title)}</title>${FAVICON_LINK}<script src="${THEME_SCRIPT}"></script><link rel="stylesheet" href="${STYLESHEET}"></head><body><header class="app-header"><a class="brand" href="/">${PRODUCT_NAME}</a></header><main class="agent-setup"><h1>${title}</h1>${body}</main></body></html>`;
}

/**
 * The starting page for `request`, or null when `error` isn't the starting
 * refusal or `request` isn't a browser navigation. The caller answers null
 * with its usual JSON error.
 */
export function startingPage(request, error) {
  if (!isStartingRefusal(error) || !isBrowserNavigation(request)) return null;
  const { refreshSeconds, nextCount } = startingRetry(startingCount(request));
  const headers = new Headers({
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    Pragma: "no-cache",
    "Retry-After": String(refreshSeconds ?? FINAL_RETRY_SECONDS),
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    // The address may hold a sign-in code: no request from this page names it.
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy":
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "Set-Cookie": `${STARTING_COOKIE}=${nextCount}; Path=/; Max-Age=${nextCount ? COUNT_SECONDS : 0}; HttpOnly; Secure; SameSite=Lax`,
  });
  if (refreshSeconds !== null) headers.set("Refresh", String(refreshSeconds));
  return new Response(request.method === "HEAD" ? null : startingDocument(refreshSeconds), {
    status: 503,
    headers,
  });
}
