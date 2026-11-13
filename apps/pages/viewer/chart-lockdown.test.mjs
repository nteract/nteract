import assert from "node:assert/strict";
import { test } from "node:test";
import {
  NAVIGATOR_CAPABILITIES,
  WORKER_CAPABILITIES,
  freezeScope,
  lockDown,
} from "./chart-lockdown.mjs";

/** A stand-in Worker global: capabilities on the object, on its prototype
 * (as WorkerGlobalScope.prototype holds fetch), and on the navigator's. */
function workerScope() {
  const prototype = { fetch() {}, importScripts() {}, indexedDB: {}, caches: {} };
  const scope = Object.create(prototype);
  for (const name of ["XMLHttpRequest", "WebSocket", "EventSource", "Worker", "BroadcastChannel"])
    scope[name] = function () {};
  const navigatorPrototype = { storage: {}, locks: {} };
  scope.navigator = Object.create(navigatorPrototype);
  scope.navigator.userAgent = "test";
  scope.postMessage = () => {};
  return { scope, prototype, navigatorPrototype };
}

test("lockDown removes every capability from the global, its prototypes and its navigator", () => {
  const { scope, prototype, navigatorPrototype } = workerScope();
  lockDown(scope);
  for (const name of WORKER_CAPABILITIES) assert.equal(scope[name], undefined, name);
  for (const name of NAVIGATOR_CAPABILITIES) assert.equal(scope.navigator[name], undefined, name);
  assert.equal(Object.hasOwn(prototype, "fetch"), false);
  assert.equal(Object.hasOwn(navigatorPrototype, "storage"), false);
  assert.equal(typeof scope.postMessage, "function", "what a chart needs stays");
  assert.equal(scope.navigator.userAgent, "test");
});

test("a capability that can only be overwritten is overwritten; one that can't be removed stops the Worker", () => {
  const { scope } = workerScope();
  Object.defineProperty(scope, "WebSocket", { value() {}, writable: true, configurable: false });
  lockDown(scope);
  assert.equal(scope.WebSocket, undefined);
  const stuck = workerScope().scope;
  Object.defineProperty(stuck, "fetch", { value() {}, writable: false, configurable: false });
  assert.throws(() => lockDown(stuck), /couldn't remove fetch/);
});

test("freezeScope freezes the global, its prototypes and its navigator", () => {
  const { scope, prototype } = workerScope();
  lockDown(scope);
  freezeScope(scope);
  assert.ok(
    Object.isFrozen(scope) && Object.isFrozen(prototype) && Object.isFrozen(scope.navigator),
  );
  assert.throws(() => {
    "use strict";
    prototype.fetch = () => {};
  }, TypeError);
  assert.equal(scope.fetch, undefined);
});
