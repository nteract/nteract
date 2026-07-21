import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { installStaleDeploymentRecovery } from "../viewer/stale-deployment-recovery.ts";

describe("stale deployment recovery", () => {
  it("reloads once when Vite reports a missing lazy asset", () => {
    const target = new EventTarget();
    const storage = new MemoryStorage();
    const warnings: Array<[string, unknown]> = [];
    let reloads = 0;
    const dispose = installStaleDeploymentRecovery({
      target,
      storage,
      reload: () => {
        reloads += 1;
      },
      now: () => 1_000,
      warn: (message, error) => warnings.push([message, error]),
    });
    const error = new Error(
      "Failed to fetch dynamically imported module: /assets/notebook-route-old.js",
    );
    const event = preloadErrorEvent(error);

    target.dispatchEvent(event);

    assert.equal(event.defaultPrevented, true);
    assert.equal(reloads, 1);
    assert.deepEqual(warnings, [
      ["[notebook-cloud] stale deployment asset detected; reloading viewer", error],
    ]);
    dispose();
  });

  it("lets a repeated failure reach the error boundary instead of reloading in a loop", () => {
    const target = new EventTarget();
    const storage = new MemoryStorage();
    let reloads = 0;
    let now = 1_000;
    installStaleDeploymentRecovery({
      target,
      storage,
      reload: () => {
        reloads += 1;
      },
      now: () => now,
      warn: () => {},
    });

    const first = preloadErrorEvent(new Error("missing old chunk"));
    target.dispatchEvent(first);
    now += 30_000;
    const repeated = preloadErrorEvent(new Error("deployment is still broken"));
    target.dispatchEvent(repeated);

    assert.equal(first.defaultPrevented, true);
    assert.equal(repeated.defaultPrevented, false);
    assert.equal(reloads, 1);
  });

  it("suppresses recovery inside the cooldown and allows it at the boundary", () => {
    const target = new EventTarget();
    const storage = new MemoryStorage();
    let reloads = 0;
    let now = 1_000;
    installStaleDeploymentRecovery({
      target,
      storage,
      reload: () => {
        reloads += 1;
      },
      now: () => now,
      warn: () => {},
    });

    target.dispatchEvent(preloadErrorEvent(new Error("first stale deployment")));
    now += 59_999;
    const insideCooldown = preloadErrorEvent(new Error("still inside cooldown"));
    target.dispatchEvent(insideCooldown);
    now += 1;
    const atBoundary = preloadErrorEvent(new Error("later stale deployment"));
    target.dispatchEvent(atBoundary);

    assert.equal(insideCooldown.defaultPrevented, false);
    assert.equal(atBoundary.defaultPrevented, true);
    assert.equal(reloads, 2);
  });

  it("does not risk a reload loop when session storage is unavailable", () => {
    const target = new EventTarget();
    let reloads = 0;
    installStaleDeploymentRecovery({
      target,
      storage: {
        getItem: () => {
          throw new DOMException("blocked", "SecurityError");
        },
        setItem: () => {
          throw new DOMException("blocked", "SecurityError");
        },
      },
      reload: () => {
        reloads += 1;
      },
      now: () => 1_000,
      warn: () => {},
    });
    const event = preloadErrorEvent(new Error("missing chunk"));

    target.dispatchEvent(event);

    assert.equal(event.defaultPrevented, false);
    assert.equal(reloads, 0);
  });

  it("removes the listener when disposed", () => {
    const target = new EventTarget();
    const storage = new MemoryStorage();
    let reloads = 0;
    const dispose = installStaleDeploymentRecovery({
      target,
      storage,
      reload: () => {
        reloads += 1;
      },
      now: () => 1_000,
      warn: () => {},
    });

    dispose();
    target.dispatchEvent(preloadErrorEvent(new Error("missing chunk")));

    assert.equal(reloads, 0);
  });
});

function preloadErrorEvent(error: Error): Event {
  const event = new Event("vite:preloadError", { cancelable: true });
  Object.defineProperty(event, "payload", { value: error });
  return event;
}

class MemoryStorage implements Pick<Storage, "getItem" | "setItem"> {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}
