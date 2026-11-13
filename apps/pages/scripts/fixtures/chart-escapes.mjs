// Every way out of a chart Worker that its lockdown (viewer/chart-lockdown.mjs)
// and its own Content-Security-Policy (shared/chart-worker-csp.mjs) close,
// tried directly, as code that gained execution in the Worker would. Network
// attempts request /escape/<variant>/<path>, and scripts/chart-smoke.mjs
// judges them by whether its server received that request, whatever the
// promise did. Storage and code attempts are judged by their outcome. Every
// attempt has a positive control: the same Worker with no lockdown and no
// CSP must get out, or the API is absent in that engine. Built into the
// smoke's escape Workers; never part of the viewer.

/** Ways out over the network, by the path each requests. */
export const NETWORK = {
  fetch: ["fetch", (s, url) => s.fetch(url)],
  "fetch from the global's prototype": [
    "proto-fetch",
    (s, url) => Object.getPrototypeOf(s).fetch.call(s, url),
  ],
  "fetch from WorkerGlobalScope": [
    "scope-fetch",
    (s, url) => s.WorkerGlobalScope.prototype.fetch.call(s, url),
  ],
  XMLHttpRequest: [
    "xhr",
    (s, url) =>
      new Promise((resolve, reject) => {
        const request = new s.XMLHttpRequest();
        request.onload = resolve;
        request.onerror = reject;
        request.open("GET", url);
        request.send();
      }),
  ],
  WebSocket: [
    "socket",
    (s, url) =>
      new Promise((resolve, reject) => {
        const socket = new s.WebSocket(`ws://${s.location.host}${url}`);
        socket.onopen = resolve;
        socket.onerror = reject;
      }),
  ],
  EventSource: [
    "events",
    (s, url) =>
      new Promise((resolve, reject) => {
        const source = new s.EventSource(url);
        source.onopen = resolve;
        source.onerror = reject;
      }),
  ],
  importScripts: ["import.js", (s, url) => s.importScripts(url)],
  Worker: [
    "worker.js",
    (s, url) =>
      new Promise((resolve, reject) => {
        const worker = new s.Worker(url);
        worker.onmessage = resolve;
        worker.onerror = reject;
      }),
  ],
  FontFace: ["font.woff", (s, url) => new s.FontFace("escape", `url(${url})`).load()],
};

/** Ways to code from a string. */
export const CODE = {
  eval: (s) => (0, s.eval)("1 + 1"),
  Function: (s) => (() => {}).constructor("return 1")(),
};

/** Storage and channels the CSP doesn't govern, each with the check that
 * says whether the engine has it at all. */
export const STORAGE = {
  indexedDB: [
    (s) => s.indexedDB,
    (s) =>
      new Promise((resolve, reject) => {
        const request = s.indexedDB.open("escape");
        request.onsuccess = resolve;
        request.onerror = reject;
      }),
  ],
  caches: [(s) => s.caches, (s) => s.caches.open("escape")],
  BroadcastChannel: [
    (s) => s.BroadcastChannel,
    (s) => new s.BroadcastChannel("escape").postMessage("out"),
  ],
  "navigator.storage": [
    (s) => s.navigator?.storage,
    // WebKit refuses the origin private file system to an ephemeral
    // session; the quota estimate still reaches the storage manager.
    (s) => Promise.any([s.navigator.storage.getDirectory(), s.navigator.storage.estimate()]),
  ],
  "navigator.storageBuckets": [
    (s) => s.navigator?.storageBuckets,
    (s) => s.navigator.storageBuckets.open("escape").then((bucket) => bucket.indexedDB),
  ],
};

const settle = (attempt) =>
  Promise.race([
    Promise.resolve().then(attempt),
    new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), 2000)),
  ]).then(
    () => "open",
    () => "blocked",
  );

/** Try every way out from `scope`, all at once: name → "open", "blocked"
 * or (storage only) "absent" when the engine has no such API here.
 * Network outcomes are reported, but the smoke judges them by its server. */
export async function tryEscapes(scope, variant) {
  const url = (path) => `/escape/${variant}/${path}`;
  const attempts = [
    ...Object.entries(NETWORK).map(([name, [path, attempt]]) => [
      name,
      () => attempt(scope, url(path)),
    ]),
    ...Object.entries(CODE).map(([name, attempt]) => [name, () => attempt(scope)]),
    ...Object.entries(STORAGE).map(([name, [exists, attempt]]) => {
      let present = false;
      try {
        present = !!exists(scope);
      } catch {}
      return [name, present ? () => attempt(scope) : null];
    }),
  ];
  const results = await Promise.all(
    attempts.map(([, attempt]) => (attempt ? settle(attempt) : "absent")),
  );
  return Object.fromEntries(attempts.map(([name], index) => [name, results[index]]));
}

/** The string-keyed own properties left on `scope`, its prototypes and its
 * navigator, `constructor` aside. */
export function remaining(scope) {
  const names = new Set();
  for (const [prefix, target] of [
    ["", scope],
    ["navigator.", scope.navigator],
  ])
    for (
      let object = target;
      object && object !== Object.prototype;
      object = Object.getPrototypeOf(object)
    )
      for (const key of Object.getOwnPropertyNames(object))
        if (key !== "constructor") names.add(`${prefix}${key}`);
  return [...names].sort();
}

/** Answer `{ type: "escape", variant }` in `scope` with `{ type: "escaped",
 * results, remaining }`. */
export function answerEscapes(scope) {
  const left = remaining(scope);
  scope.addEventListener("message", async ({ data }) => {
    if (data?.type === "escape")
      scope.postMessage({
        type: "escaped",
        results: await tryEscapes(scope, data.variant),
        remaining: left,
      });
  });
}
