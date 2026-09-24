import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isRouteAssetLoadError, loadRouteWithRecovery } from "../viewer/route-load-recovery.ts";

const downloadError = new TypeError(
  "Failed to fetch dynamically imported module: /assets/route.js",
);
const fail = () => Promise.reject(downloadError);

describe("route load recovery", () => {
  it("recognizes browser module download errors without hiding application errors", () => {
    for (const message of [
      "Failed to fetch dynamically imported module: https://example.test/route.js",
      "error loading dynamically imported module: https://example.test/route.js",
      "Importing a module script failed.",
    ]) {
      assert.equal(isRouteAssetLoadError(new TypeError(message)), true);
    }
    for (const error of [
      new Error(downloadError.message),
      new TypeError("Failed to fetch"),
      new TypeError("Cannot read properties of undefined"),
      new SyntaxError("Unexpected token"),
      null,
    ]) {
      assert.equal(isRouteAssetLoadError(error), false);
    }
  });

  it("reloads only once across page loads until a route successfully imports", async () => {
    const storage = new MemoryStorage();
    let reloads = 0;
    const options = {
      storage,
      reload: () => {
        reloads += 1;
      },
      warn: () => {},
    };
    await assert.rejects(loadRouteWithRecovery(fail, options), (error) => error === downloadError);
    assert.equal(reloads, 1);
    // A fresh invocation models a new document. There is no timer that can
    // re-arm automatic reloads during a long-running failed request.
    await assert.rejects(loadRouteWithRecovery(fail, options), (error) => error === downloadError);
    assert.equal(reloads, 1);
    const module = { loaded: true };
    assert.equal(await loadRouteWithRecovery(() => Promise.resolve(module), options), module);
    await assert.rejects(loadRouteWithRecovery(fail, options));
    assert.equal(reloads, 2);
  });

  it("preserves ordinary module evaluation errors without reloading", async () => {
    let reloads = 0;
    const error = new TypeError("Application initialization failed");
    await assert.rejects(
      loadRouteWithRecovery(() => Promise.reject(error), {
        storage: new MemoryStorage(),
        reload: () => {
          reloads += 1;
        },
      }),
      (actual) => actual === error,
    );
    assert.equal(reloads, 0);
  });

  it("leaves manual recovery available when storage access or persistence fails", async () => {
    for (const method of ["getItem", "setItem"] as const) {
      const storage = new MemoryStorage();
      storage[method] = () => {
        throw new DOMException("blocked", "SecurityError");
      };
      let reloads = 0;
      await assert.rejects(
        loadRouteWithRecovery(fail, {
          storage,
          reload: () => {
            reloads += 1;
          },
          warn: () => {},
        }),
        (error) => error === downloadError,
      );
      assert.equal(reloads, 0);
    }
  });

  it("preserves the original error when the sessionStorage getter throws", async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        get sessionStorage() {
          throw new DOMException("blocked", "SecurityError");
        },
      },
    });
    try {
      await assert.rejects(loadRouteWithRecovery(fail), (error) => error === downloadError);
      assert.equal(await loadRouteWithRecovery(() => Promise.resolve("loaded")), "loaded");
    } finally {
      if (original) Object.defineProperty(globalThis, "window", original);
      else Reflect.deleteProperty(globalThis, "window");
    }
  });
});

class MemoryStorage {
  private readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
}
