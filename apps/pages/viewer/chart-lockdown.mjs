// What a chart Worker gives up before it reads a message. The Worker runs
// with the reader's origin, so a spec that ever found a way to run code there
// would hold the reader's cookies against authenticated Pages endpoints, and
// their storage. `lockDown` removes every network, storage, channel and
// child-Worker capability from the Worker's global object and its prototype
// chain; `freezeScope` then freezes the global, its prototypes and its
// navigator, so nothing can be put back. The Worker's own CSP
// (shared/chart-worker-csp.mjs) closes the network and code from strings a
// second time. scripts/chart-smoke.mjs tries every way out directly, in each
// engine, with each layer alone and both together. No DOM.

/** Globals a chart never needs that reach the network, storage, another
 * context or a child Worker. */
export const WORKER_CAPABILITIES = Object.freeze([
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "WebSocketStream",
  "WebTransport",
  "EventSource",
  "importScripts",
  "Worker",
  "SharedWorker",
  "BroadcastChannel",
  "indexedDB",
  "IDBFactory",
  "caches",
  "CacheStorage",
  "cookieStore",
  "CookieStore",
  "FontFace",
  "fonts",
  "Notification",
  "RTCPeerConnection",
  "RTCDataChannel",
  "webkitRTCPeerConnection",
]);

/** The same for the Worker's navigator. */
export const NAVIGATOR_CAPABILITIES = Object.freeze([
  "storage",
  "locks",
  "serviceWorker",
  "permissions",
  "sendBeacon",
]);

/** Every object from `target` up its prototype chain, Object.prototype
 * excluded. */
function chain(target) {
  const objects = [];
  for (
    let object = target;
    object && object !== Object.prototype;
    object = Object.getPrototypeOf(object)
  )
    objects.push(object);
  return objects;
}

/** Remove `name` from every object on `target`'s chain that defines it, and
 * throw unless `target[name]` then reads as undefined. */
function remove(target, name) {
  for (const object of chain(target)) {
    const descriptor = Object.getOwnPropertyDescriptor(object, name);
    if (!descriptor) continue;
    if (descriptor.configurable) delete object[name];
    else if (descriptor.writable) object[name] = undefined;
  }
  if (target[name] !== undefined) throw new Error(`The chart Worker couldn't remove ${name}.`);
}

/** Remove the network, storage, channel and child-Worker capabilities from
 * `scope` (the Worker's global) and its navigator. Throws, so the Worker
 * never answers, if one can't be removed. */
export function lockDown(scope) {
  for (const name of WORKER_CAPABILITIES) remove(scope, name);
  const navigator = scope.navigator;
  if (navigator) for (const name of NAVIGATOR_CAPABILITIES) remove(navigator, name);
}

/** Freeze `scope`, its prototypes and its navigator, so a removed capability
 * can't be put back on them. */
export function freezeScope(scope) {
  const navigator = scope.navigator;
  for (const object of [...chain(scope), ...(navigator ? chain(navigator) : [])])
    Object.freeze(object);
}
