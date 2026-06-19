import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { ConnectionStatus } from "runtimed";
import {
  SustainedReconnectAccessDiagnosticTracker,
  useSustainedReconnecting,
  type ReconnectingStatusSource,
} from "../use-sustained-reconnecting";

// The tracker has thorough unit coverage; these tests render the REAL hook
// so the React wiring is pinned too: subscription on mount, debounce timers
// driving state, unsubscribe + timer disposal on unmount, and the intended
// behavior when the source object identity changes mid-outage.

class FakeStatusSource implements ReconnectingStatusSource {
  listeners = new Set<(status: ConnectionStatus) => void>();
  current: ConnectionStatus = "connecting";

  subscribe(next: (status: ConnectionStatus) => void): { unsubscribe(): void } {
    this.listeners.add(next);
    // BehaviorSubject contract (CloudConnectionStatusBridge): replay the
    // current status to new subscribers.
    next(this.current);
    return { unsubscribe: () => this.listeners.delete(next) };
  }

  emit(status: ConnectionStatus): void {
    this.current = status;
    for (const listener of this.listeners) {
      listener(status);
    }
  }
}

describe("useSustainedReconnecting", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("flips true only after reconnecting outlives the debounce, and clears on online", () => {
    const source = new FakeStatusSource();
    const { result } = renderHook(() => useSustainedReconnecting(source, 3_000));
    expect(result.current).toBe(false);

    act(() => {
      source.emit("reconnecting");
      vi.advanceTimersByTime(2_999);
    });
    expect(result.current).toBe(false);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe(true);

    act(() => {
      source.emit("online");
    });
    expect(result.current).toBe(false);
  });

  it("stays silent across sub-debounce flaps", () => {
    const source = new FakeStatusSource();
    const { result } = renderHook(() => useSustainedReconnecting(source, 3_000));

    act(() => {
      for (let i = 0; i < 5; i += 1) {
        source.emit("reconnecting");
        vi.advanceTimersByTime(1_000);
        source.emit("online");
        vi.advanceTimersByTime(1_000);
      }
      vi.advanceTimersByTime(60_000);
    });
    expect(result.current).toBe(false);
  });

  it("unsubscribes and disposes the pending timer on unmount", () => {
    const source = new FakeStatusSource();
    const { unmount } = renderHook(() => useSustainedReconnecting(source, 3_000));
    expect(source.listeners.size).toBe(1);

    act(() => {
      source.emit("reconnecting");
    });
    unmount();
    expect(source.listeners.size).toBe(0);

    // The armed debounce timer must be gone: advancing past it neither
    // throws nor updates state on an unmounted component.
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears then re-arms via replay when the source object changes mid-outage", () => {
    const first = new FakeStatusSource();
    first.current = "reconnecting";
    const { result, rerender } = renderHook(
      ({ source }: { source: ReconnectingStatusSource }) => useSustainedReconnecting(source, 3_000),
      { initialProps: { source: first as ReconnectingStatusSource } },
    );

    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(result.current).toBe(true);

    // A new source identity remounts the subscription: the flag clears
    // (the old tracker is disposed), and the replacement source's replayed
    // "reconnecting" re-arms a FRESH debounce window.
    const second = new FakeStatusSource();
    second.current = "reconnecting";
    rerender({ source: second });
    expect(result.current).toBe(false);
    expect(first.listeners.size).toBe(0);
    expect(second.listeners.size).toBe(1);

    act(() => {
      vi.advanceTimersByTime(2_999);
    });
    expect(result.current).toBe(false);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe(true);
  });
});

describe("SustainedReconnectAccessDiagnosticTracker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs one access diagnostic after reconnecting outlives the debounce", async () => {
    const diagnose = vi.fn(async () => "Sign in again to open this notebook.");
    const onDiagnostic = vi.fn();
    const tracker = new SustainedReconnectAccessDiagnosticTracker({
      debounceMs: 1_000,
      diagnose,
      onDiagnostic,
    });

    act(() => {
      tracker.next("reconnecting");
      vi.advanceTimersByTime(999);
    });
    expect(diagnose).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
    });
    expect(diagnose).toHaveBeenCalledTimes(1);
    expect(onDiagnostic).toHaveBeenCalledWith("Sign in again to open this notebook.");

    act(() => {
      tracker.next("reconnecting");
      vi.advanceTimersByTime(10_000);
    });
    expect(diagnose).toHaveBeenCalledTimes(1);

    tracker.dispose();
  });

  it("keeps plain outages calm when the access probe has no diagnostic", async () => {
    const diagnose = vi.fn(async () => null);
    const onDiagnostic = vi.fn();
    const tracker = new SustainedReconnectAccessDiagnosticTracker({
      debounceMs: 1_000,
      diagnose,
      onDiagnostic,
    });

    await act(async () => {
      tracker.next("reconnecting");
      vi.advanceTimersByTime(1_000);
      await Promise.resolve();
    });

    expect(diagnose).toHaveBeenCalledTimes(1);
    expect(onDiagnostic).not.toHaveBeenCalled();
    tracker.dispose();
  });

  it("ignores stale diagnostics after reconnect recovery", async () => {
    let resolveDiagnostic: (diagnostic: string | null) => void = () => {};
    const pendingDiagnostic = new Promise<string | null>((resolve) => {
      resolveDiagnostic = resolve;
    });
    const diagnose = vi.fn(() => pendingDiagnostic);
    const onDiagnostic = vi.fn();
    const tracker = new SustainedReconnectAccessDiagnosticTracker({
      debounceMs: 1_000,
      diagnose,
      onDiagnostic,
    });

    act(() => {
      tracker.next("reconnecting");
      vi.advanceTimersByTime(1_000);
    });
    expect(diagnose).toHaveBeenCalledTimes(1);

    act(() => {
      tracker.next("online");
    });
    await act(async () => {
      resolveDiagnostic("Sign in again to open this notebook.");
      await pendingDiagnostic;
      await Promise.resolve();
    });

    expect(onDiagnostic).not.toHaveBeenCalled();
    tracker.dispose();
  });

  it("allows a fresh diagnostic after recovery starts a new reconnect cycle", async () => {
    const diagnose = vi
      .fn<() => Promise<string | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("This account does not have access to this notebook.");
    const onDiagnostic = vi.fn();
    const tracker = new SustainedReconnectAccessDiagnosticTracker({
      debounceMs: 1_000,
      diagnose,
      onDiagnostic,
    });

    await act(async () => {
      tracker.next("reconnecting");
      vi.advanceTimersByTime(1_000);
      await Promise.resolve();
    });
    expect(diagnose).toHaveBeenCalledTimes(1);

    act(() => {
      tracker.next("online");
      tracker.next("reconnecting");
    });
    await act(async () => {
      vi.advanceTimersByTime(1_000);
      await Promise.resolve();
    });

    expect(diagnose).toHaveBeenCalledTimes(2);
    expect(onDiagnostic).toHaveBeenCalledWith(
      "This account does not have access to this notebook.",
    );
    tracker.dispose();
  });
});
