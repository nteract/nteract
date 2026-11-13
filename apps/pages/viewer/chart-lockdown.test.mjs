import assert from "node:assert/strict";
import { test } from "node:test";
import { NEUTERED, WORKER_GLOBALS, freezeScope, lockDown } from "./chart-lockdown.mjs";

/** A stand-in Worker global, shaped as the engines shape it: interfaces and
 * namespaces on the object, network and storage on its prototype (as
 * WorkerGlobalScope.prototype holds fetch and navigator), events on the
 * prototype's prototype (as EventTarget.prototype holds addEventListener). */
function workerScope() {
  const events = { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };
  const prototype = Object.create(events);
  Object.assign(prototype, { fetch() {}, importScripts() {}, postMessage() {}, caches: {} });
  Object.defineProperty(prototype, "navigator", {
    get: () => ({ storage: {}, storageBuckets: {} }),
    configurable: true,
  });
  Object.defineProperty(prototype, "self", {
    get() {
      return this;
    },
    configurable: true,
  });
  const scope = Object.create(prototype);
  for (const name of ["XMLHttpRequest", "WebSocket", "EventSource", "Worker", "BroadcastChannel"])
    scope[name] = function () {};
  Object.assign(scope, {
    Array,
    JSON,
    console: {},
    setTimeout() {},
    OffscreenCanvas: function () {},
    eval: () => "evaluated",
    indexedDB: {},
  });
  scope[Symbol.toStringTag] = "DedicatedWorkerGlobalScope";
  return { scope, prototype, events };
}

/** Every own key left on `scope` and its prototypes. */
const left = (scope) => {
  const keys = [];
  for (let object = scope; object; object = Object.getPrototypeOf(object))
    keys.push(...Reflect.ownKeys(object));
  return keys;
};

test("lockDown keeps the allowlist and removes everything else up the chain", () => {
  const { scope, prototype, events } = workerScope();
  lockDown(scope);
  for (const name of [
    "fetch",
    "importScripts",
    "caches",
    "navigator",
    "XMLHttpRequest",
    "WebSocket",
  ])
    assert.equal(scope[name], undefined, name);
  for (const name of ["indexedDB", "BroadcastChannel", "removeEventListener", "dispatchEvent"])
    assert.equal(scope[name], undefined, name);
  assert.equal(Object.hasOwn(prototype, "navigator"), false);
  assert.equal(Object.hasOwn(events, "dispatchEvent"), false);
  assert.equal(scope[Symbol.toStringTag], undefined);
  assert.equal(scope.self, scope, "what a chart needs stays");
  for (const name of ["addEventListener", "postMessage", "setTimeout", "OffscreenCanvas"])
    assert.equal(typeof scope[name], "function", name);
  assert.equal(scope.Array, Array);
  const allowed = new Set(["constructor", ...WORKER_GLOBALS, ...NEUTERED, "Array", "JSON"]);
  assert.deepEqual(
    left(scope).filter((key) => !allowed.has(key) && !Object.hasOwn(Object.prototype, key)),
    [],
  );
});

test("a global a later browser adds, anywhere up the chain, is removed without being named", () => {
  const { scope, prototype, events } = workerScope();
  scope.SomeFutureStorage = { open() {} };
  prototype.someFutureFetch = () => {};
  Object.defineProperty(events, "futureChannel", { get: () => ({}), configurable: true });
  lockDown(scope);
  for (const name of ["SomeFutureStorage", "someFutureFetch", "futureChannel"])
    assert.equal(scope[name], undefined, name);
});

test("lockDown replaces eval with a function that throws", () => {
  const { scope } = workerScope();
  lockDown(scope);
  assert.equal(typeof scope.eval, "function");
  assert.throws(() => scope.eval("1 + 1"), EvalError);
});

test("a name that can only be overwritten is overwritten; one that can't be removed stops the Worker", () => {
  const { scope } = workerScope();
  Object.defineProperty(scope, "WebSocket", { value() {}, writable: true, configurable: false });
  lockDown(scope);
  assert.equal(scope.WebSocket, undefined);
  const stuck = workerScope().scope;
  Object.defineProperty(stuck, "SomeFutureFetch", {
    value() {},
    writable: false,
    configurable: false,
  });
  assert.throws(() => lockDown(stuck), /couldn't remove SomeFutureFetch/);
  const accessor = workerScope().scope;
  Object.defineProperty(accessor, "futureBuckets", { get: () => ({}), configurable: false });
  assert.throws(() => lockDown(accessor), /couldn't remove futureBuckets/);
});

test("Chromium's numeric constants stay only while they hold numbers", () => {
  const { scope, prototype } = workerScope();
  Object.defineProperty(prototype, "TEMPORARY", { value: 0, writable: false, configurable: false });
  lockDown(scope);
  assert.equal(scope.TEMPORARY, 0);
  const swapped = workerScope();
  Object.defineProperty(swapped.prototype, "PERSISTENT", {
    value: {},
    writable: false,
    configurable: false,
  });
  assert.throws(() => lockDown(swapped.scope), /couldn't remove PERSISTENT/);
});

test("freezeScope freezes the global and its prototypes", () => {
  const { scope, prototype, events } = workerScope();
  lockDown(scope);
  freezeScope(scope);
  assert.ok(Object.isFrozen(scope) && Object.isFrozen(prototype) && Object.isFrozen(events));
  assert.throws(() => {
    "use strict";
    prototype.fetch = () => {};
  }, TypeError);
  assert.equal(scope.fetch, undefined);
});
