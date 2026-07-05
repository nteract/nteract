import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { Subscription } from "rxjs";
import { cloudAuthStorage$, documentVisible$, windowFocus$ } from "../browser-signals";
import { NOTEBOOK_CLOUD_DEV_TOKEN_STORAGE_KEY } from "../collaborator-auth";

function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
}

// jsdom's StorageEvent ignores its init dict and exposes key/storageArea as
// prototype accessors that resist shadowing, so a plain Event carries the
// fields as own data properties to exercise the filter deterministically.
function storageEvent(key: string | null, storageArea: Storage): StorageEvent {
  const event = new Event("storage");
  Object.defineProperty(event, "key", { configurable: true, value: key });
  Object.defineProperty(event, "storageArea", { configurable: true, value: storageArea });
  return event as unknown as StorageEvent;
}

const subscriptions: Subscription[] = [];
function track(subscription: Subscription): Subscription {
  subscriptions.push(subscription);
  return subscription;
}

afterEach(() => {
  while (subscriptions.length > 0) {
    subscriptions.pop()?.unsubscribe();
  }
  setVisibility("visible");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// A fresh module instance isolates the lazily-started singletons from the
// static import above, so listener-count and SSR assertions do not depend on
// which test subscribed first.
async function freshBrowserSignals(): Promise<typeof import("../browser-signals")> {
  vi.resetModules();
  return import("../browser-signals");
}

describe("documentVisible$", () => {
  it("emits the current visibility synchronously on subscribe, then tracks changes", () => {
    setVisibility("visible");
    const values: boolean[] = [];
    track(documentVisible$.subscribe((value) => values.push(value)));
    // startWith fires before subscribe returns.
    expect(values).toEqual([true]);

    setVisibility("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    setVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));

    expect(values).toEqual([true, false, true]);
  });

  it("dedupes repeated visibility events at the same state", () => {
    setVisibility("visible");
    const values: boolean[] = [];
    track(documentVisible$.subscribe((value) => values.push(value)));

    document.dispatchEvent(new Event("visibilitychange"));
    document.dispatchEvent(new Event("visibilitychange"));

    expect(values).toEqual([true]);
  });
});

describe("windowFocus$", () => {
  it("emits once per focus event", () => {
    let count = 0;
    track(windowFocus$.subscribe(() => (count += 1)));

    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("focus"));

    expect(count).toBe(2);
  });
});

describe("cloudAuthStorage$", () => {
  it("passes storage events for cloud auth keys", () => {
    const events: StorageEvent[] = [];
    track(cloudAuthStorage$.subscribe((event) => events.push(event)));

    window.dispatchEvent(storageEvent(NOTEBOOK_CLOUD_DEV_TOKEN_STORAGE_KEY, window.localStorage));

    expect(events).toHaveLength(1);
    expect(events[0]?.key).toBe(NOTEBOOK_CLOUD_DEV_TOKEN_STORAGE_KEY);
  });

  it("drops storage events for unrelated keys", () => {
    const events: StorageEvent[] = [];
    track(cloudAuthStorage$.subscribe((event) => events.push(event)));

    window.dispatchEvent(storageEvent("unrelated-app-key", window.localStorage));

    expect(events).toHaveLength(0);
  });

  it("drops storage events from a foreign storage area", () => {
    const events: StorageEvent[] = [];
    track(cloudAuthStorage$.subscribe((event) => events.push(event)));

    window.dispatchEvent(storageEvent(NOTEBOOK_CLOUD_DEV_TOKEN_STORAGE_KEY, window.sessionStorage));

    expect(events).toHaveLength(0);
  });
});

describe("shared listener lifecycle", () => {
  it("attaches one DOM listener across multiple subscribers", async () => {
    const addSpy = vi.spyOn(window, "addEventListener");
    const signals = await freshBrowserSignals();

    track(signals.windowFocus$.subscribe());
    track(signals.windowFocus$.subscribe());

    const focusListeners = addSpy.mock.calls.filter(([type]) => type === "focus");
    expect(focusListeners).toHaveLength(1);
  });
});

describe("SSR safety", () => {
  it("is a no-op observable when window is undefined", async () => {
    const signals = await freshBrowserSignals();
    vi.stubGlobal("window", undefined);

    const values: unknown[] = [];
    let completed = false;
    track(
      signals.documentVisible$.subscribe({
        next: (value) => values.push(value),
        complete: () => (completed = true),
      }),
    );

    expect(values).toEqual([]);
    expect(completed).toBe(true);
  });
});
