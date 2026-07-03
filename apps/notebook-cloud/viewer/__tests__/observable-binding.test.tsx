import { act, render, renderHook } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  bindingFor,
  useObservableProjection,
  type SynchronousObservable,
} from "@/components/notebook/state/observable-binding";

// The binding is generic over SynchronousObservable, so a minimal synchronous
// subject exercises its exact contract: replay-on-subscribe (BehaviorSubject
// shape) plus an optional equality gate mirroring the `select` projections'
// distinctUntilChanged. It also counts subscriptions so the leak test can
// assert the underlying source is released on unmount.
class SyncObservable<T> implements SynchronousObservable<T> {
  private readonly listeners = new Set<(value: T) => void>();
  totalSubscribes = 0;
  activeSubscribers = 0;

  constructor(
    private value: T,
    private readonly equals?: (a: T, b: T) => boolean,
  ) {}

  get current(): T {
    return this.value;
  }

  subscribe(callback: (value: T) => void): { unsubscribe(): void } {
    this.totalSubscribes += 1;
    this.activeSubscribers += 1;
    this.listeners.add(callback);
    callback(this.value);
    let closed = false;
    return {
      unsubscribe: () => {
        if (closed) return;
        closed = true;
        this.activeSubscribers -= 1;
        this.listeners.delete(callback);
      },
    };
  }

  /** Push a new value. Returns false when the equality gate swallows it. */
  next(value: T): boolean {
    if (this.equals && this.equals(this.value, value)) return false;
    this.value = value;
    for (const callback of this.listeners) callback(value);
    return true;
  }
}

describe("bindingFor", () => {
  it("seeds getSnapshot synchronously and keeps it reference-stable between emissions", () => {
    const observable = new SyncObservable<{ n: number }>({ n: 1 });
    const binding = bindingFor(observable);

    // Seeded before any React subscription; no undefined "initial" window.
    expect(binding.getSnapshot()).toEqual({ n: 1 });
    expect(binding.getSnapshot()).toBe(binding.getSnapshot());

    let notifications = 0;
    const unsubscribe = binding.subscribe(() => {
      notifications += 1;
    });
    const beforeEmit = binding.getSnapshot();
    expect(binding.getSnapshot()).toBe(beforeEmit);

    const notificationsBeforeEmit = notifications;
    observable.next({ n: 2 });
    expect(notifications - notificationsBeforeEmit).toBe(1);
    expect(binding.getSnapshot()).toEqual({ n: 2 });
    const afterEmit = binding.getSnapshot();
    expect(binding.getSnapshot()).toBe(afterEmit);

    unsubscribe();
  });

  it("returns one cached binding per observable identity", () => {
    const observable = new SyncObservable(0);
    const other = new SyncObservable(0);
    expect(bindingFor(observable)).toBe(bindingFor(observable));
    expect(bindingFor(observable)).not.toBe(bindingFor(other));
  });
});

describe("useObservableProjection", () => {
  afterEach(() => {
    // No fake timers or globals to restore; kept for symmetry with sibling suites.
  });

  it("returns the seeded value on first render with no initial flash", () => {
    const observable = new SyncObservable("seed");
    const seen: string[] = [];
    const { result } = renderHook(() => {
      const value = useObservableProjection(observable);
      seen.push(value);
      return value;
    });

    expect(seen[0]).toBe("seed");
    expect(result.current).toBe("seed");
  });

  it("does not re-render on a content-equal emission past the equality gate", () => {
    const observable = new SyncObservable<{ n: number }>({ n: 1 }, (a, b) => a.n === b.n);
    let renderCount = 0;
    const { result } = renderHook(() => {
      renderCount += 1;
      return useObservableProjection(observable);
    });

    const mountedRenders = renderCount;
    const firstValue = result.current;

    // Same `n`: the gate swallows it, so no notification reaches the binding.
    act(() => {
      observable.next({ n: 1 });
    });
    expect(renderCount).toBe(mountedRenders);
    expect(result.current).toBe(firstValue);

    // Changed `n`: the emission passes and drives exactly one re-render.
    act(() => {
      observable.next({ n: 2 });
    });
    expect(renderCount).toBe(mountedRenders + 1);
    expect(result.current).toEqual({ n: 2 });
  });

  it("does not tear when the observable emits synchronously mid-render", () => {
    const observable = new SyncObservable("seed");
    const seen: string[] = [];

    function MidRenderEmitter() {
      const emitted = useRef(false);
      const value = useObservableProjection(observable);
      if (!emitted.current) {
        emitted.current = true;
        observable.next("mid");
      }
      seen.push(value);
      return <span>{value}</span>;
    }

    const { container } = render(<MidRenderEmitter />);

    // The committed value reflects the mid-render emission, and it matches the
    // binding snapshot - no stale value is left painted.
    expect(container.textContent).toBe("mid");
    expect(seen[seen.length - 1]).toBe("mid");
    expect(bindingFor(observable).getSnapshot()).toBe("mid");
  });

  it("releases the underlying subscription on unmount", () => {
    const observable = new SyncObservable(0);
    const { unmount } = renderHook(() => useObservableProjection(observable));
    expect(observable.activeSubscribers).toBe(1);

    unmount();
    expect(observable.activeSubscribers).toBe(0);
  });
});
