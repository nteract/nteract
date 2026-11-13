// Every way out of a chart Worker that its lockdown (viewer/chart-lockdown.mjs)
// and its own Content-Security-Policy (shared/chart-worker-csp.mjs) close,
// tried directly, as code that gained execution in the Worker would. Each
// resolves when the way out worked and rejects or times out when it didn't.
// Requests go to /escape/<variant>/ paths, which the smoke's server records. Built into the smoke's escape Workers; never part of the viewer.

/** Ways out over the network: the Worker's CSP alone closes these. */
export const NETWORK = {
  fetch: (s, url) => s.fetch(url("fetch")),
  "fetch from the global's prototype": (s, url) =>
    Object.getPrototypeOf(s).fetch.call(s, url("proto-fetch")),
  "fetch from WorkerGlobalScope": (s, url) =>
    s.WorkerGlobalScope.prototype.fetch.call(s, url("scope-fetch")),
  XMLHttpRequest: (s, url) =>
    new Promise((resolve, reject) => {
      const request = new s.XMLHttpRequest();
      request.onload = resolve;
      request.onerror = reject;
      request.open("GET", url("xhr"));
      request.send();
    }),
  WebSocket: (s, url) =>
    new Promise((resolve, reject) => {
      const socket = new s.WebSocket(`ws://${s.location.host}${url("socket")}`);
      socket.onopen = resolve;
      socket.onerror = reject;
    }),
  EventSource: (s, url) =>
    new Promise((resolve, reject) => {
      const source = new s.EventSource(url("events"));
      source.onopen = resolve;
      source.onerror = reject;
    }),
  importScripts: (s, url) => s.importScripts(url("import.js")),
  Worker: (s, url) =>
    new Promise((resolve, reject) => {
      const worker = new s.Worker(url("worker.js"));
      worker.onmessage = resolve;
      worker.onerror = reject;
    }),
  FontFace: (s, url) => new s.FontFace("escape", `url(${url("font.woff")})`).load(),
};

/** Ways to code from a string: the CSP closes these. */
export const CODE = {
  eval: (s) => (0, s.eval)("1 + 1"),
  Function: (s) => s.Function("return 1")(),
};

/** Storage and channels the CSP doesn't govern: the lockdown closes these. */
export const STORAGE = {
  indexedDB: (s) =>
    new Promise((resolve, reject) => {
      const request = s.indexedDB.open("escape");
      request.onsuccess = resolve;
      request.onerror = reject;
    }),
  caches: (s) => s.caches.open("escape"),
  BroadcastChannel: (s) => new s.BroadcastChannel("escape").postMessage("out"),
  "navigator.storage": (s) => s.navigator.storage.getDirectory(),
};

/** Try every way out from `scope`, all at once, with requests under
 * `/escape/<variant>/`: name → "open" or
 * "blocked". An attempt that neither works nor fails in two seconds counts
 * as blocked. */
export async function tryEscapes(scope, variant) {
  const url = (name) => `/escape/${variant}/${name}`;
  const attempts = Object.entries({ ...NETWORK, ...CODE, ...STORAGE });
  const settled = await Promise.allSettled(
    attempts.map(([, attempt]) =>
      Promise.race([
        Promise.resolve().then(() => attempt(scope, url)),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), 2000)),
      ]),
    ),
  );
  return Object.fromEntries(
    attempts.map(([name], index) => [
      name,
      settled[index].status === "fulfilled" ? "open" : "blocked",
    ]),
  );
}

/** Answer `{ type: "escape", variant }` in `scope` with `{ type: "escaped",
 * results }`. */
export function answerEscapes(scope) {
  scope.addEventListener("message", async ({ data }) => {
    if (data?.type === "escape")
      scope.postMessage({ type: "escaped", results: await tryEscapes(scope, data.variant) });
  });
}
