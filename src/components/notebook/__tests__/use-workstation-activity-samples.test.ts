import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  useWorkstationActivitySamples,
  WORKSTATION_ACTIVITY_SAMPLE_INTERVAL_MS,
} from "../use-workstation-activity-samples";

// The hook is a clock-driven recorder, so every test drives time explicitly
// rather than waiting on the real interval.
beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const START_MS = Date.parse("2026-07-30T12:00:00.000Z");

describe("useWorkstationActivitySamples", () => {
  it("records nothing until the runtime is running on a known workstation", () => {
    const { result } = renderHook(() =>
      useWorkstationActivitySamples({
        workstationId: null,
        busy: true,
        running: true,
        now: () => START_MS,
      }),
    );
    expect(result.current).toEqual({});

    const { result: notRunning } = renderHook(() =>
      useWorkstationActivitySamples({
        workstationId: "ws-1",
        busy: false,
        running: false,
        now: () => START_MS,
      }),
    );
    // "Not running" is a different claim from "running and idle", so no sample.
    expect(notRunning.current).toEqual({});
  });

  it("traces an attached workstation before any cell has run", () => {
    // Gating on a launched kernel would leave the rail blank for the whole
    // pre-execution life of a notebook, which is most of it.
    let currentMs = START_MS;
    const { result } = renderHook(() =>
      useWorkstationActivitySamples({
        workstationId: "ws-1",
        busy: false,
        running: true,
        now: () => currentMs,
      }),
    );

    currentMs += WORKSTATION_ACTIVITY_SAMPLE_INTERVAL_MS;
    act(() => {
      vi.advanceTimersByTime(WORKSTATION_ACTIVITY_SAMPLE_INTERVAL_MS);
    });

    // Two idle samples are enough for the projection to draw a series.
    expect(result.current["ws-1"]!.map((sample) => sample.activityFraction)).toEqual([0, 0]);
  });

  it("samples immediately on attach so the chart starts filling right away", () => {
    const { result } = renderHook(() =>
      useWorkstationActivitySamples({
        workstationId: "ws-1",
        busy: true,
        running: true,
        now: () => START_MS,
      }),
    );

    expect(result.current["ws-1"]).toHaveLength(1);
    expect(result.current["ws-1"]![0]).toEqual({
      at: new Date(START_MS).toISOString(),
      activityFraction: 1,
    });
  });

  it("traces busy and idle levels over successive ticks", () => {
    let currentMs = START_MS;
    let busy = true;
    const { result, rerender } = renderHook(() =>
      useWorkstationActivitySamples({
        workstationId: "ws-1",
        busy,
        running: true,
        now: () => currentMs,
      }),
    );

    currentMs += WORKSTATION_ACTIVITY_SAMPLE_INTERVAL_MS;
    act(() => {
      vi.advanceTimersByTime(WORKSTATION_ACTIVITY_SAMPLE_INTERVAL_MS);
    });

    busy = false;
    rerender();
    currentMs += WORKSTATION_ACTIVITY_SAMPLE_INTERVAL_MS;
    act(() => {
      vi.advanceTimersByTime(WORKSTATION_ACTIVITY_SAMPLE_INTERVAL_MS);
    });

    expect(result.current["ws-1"]!.map((sample) => sample.activityFraction)).toEqual([1, 1, 0]);
  });

  it("caps history so the trace stays a moving window", () => {
    let currentMs = START_MS;
    const { result } = renderHook(() =>
      useWorkstationActivitySamples({
        workstationId: "ws-1",
        busy: true,
        running: true,
        limit: 3,
        now: () => currentMs,
      }),
    );

    for (let tick = 0; tick < 5; tick += 1) {
      currentMs += WORKSTATION_ACTIVITY_SAMPLE_INTERVAL_MS;
      act(() => {
        vi.advanceTimersByTime(WORKSTATION_ACTIVITY_SAMPLE_INTERVAL_MS);
      });
    }

    const samples = result.current["ws-1"]!;
    expect(samples).toHaveLength(3);
    // The newest three, so the oldest fell off the left edge.
    expect(samples.at(-1)!.at).toBe(new Date(currentMs).toISOString());
  });

  it("drops history when the workstation changes, so no trace is misattributed", () => {
    let workstationId = "ws-1";
    const { result, rerender } = renderHook(() =>
      useWorkstationActivitySamples({
        workstationId,
        busy: true,
        running: true,
        now: () => START_MS,
      }),
    );
    expect(result.current["ws-1"]).toHaveLength(1);

    workstationId = "ws-2";
    rerender();

    expect(result.current["ws-1"]).toBeUndefined();
    expect(result.current["ws-2"]).toHaveLength(1);
  });

  it("stops recording and clears the trace when the runtime goes away", () => {
    let running = true;
    const { result, rerender } = renderHook(() =>
      useWorkstationActivitySamples({
        workstationId: "ws-1",
        busy: true,
        running,
        now: () => START_MS,
      }),
    );
    expect(result.current["ws-1"]).toHaveLength(1);

    running = false;
    rerender();

    // A stale trace next to a dead runtime would read as current activity.
    expect(result.current).toEqual({});
  });

  it("keeps a stable object identity between ticks so projections stay cached", () => {
    const { result, rerender } = renderHook(() =>
      useWorkstationActivitySamples({
        workstationId: "ws-1",
        busy: true,
        running: true,
        now: () => START_MS,
      }),
    );

    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});
