import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { OfflineMergeNoticeData } from "../offline-merge-tracker";
import {
  OFFLINE_MERGE_NOTICE_TIMEOUT_MS,
  useOfflineMergeNoticeAutoClear,
} from "../use-offline-merge-notice";

// The tracker fires the notice; this hook owns its retirement. A merge
// confirmation must clear itself — on the next user action (the user has
// moved on) or a short timeout — and never demand a dismissal.

const NOTICE: OfflineMergeNoticeData = { mergedRemoteCellCount: 1, removedEditedCellCount: 0 };

describe("useOfflineMergeNoticeAutoClear", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("clears after the timeout", () => {
    const clear = vi.fn();
    renderHook(() => useOfflineMergeNoticeAutoClear(NOTICE, clear));

    vi.advanceTimersByTime(OFFLINE_MERGE_NOTICE_TIMEOUT_MS - 1);
    expect(clear).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it("clears on the next pointer interaction", () => {
    const clear = vi.fn();
    renderHook(() => useOfflineMergeNoticeAutoClear(NOTICE, clear));

    window.dispatchEvent(new Event("pointerdown"));
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it("clears on the next key press", () => {
    const clear = vi.fn();
    renderHook(() => useOfflineMergeNoticeAutoClear(NOTICE, clear));

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it("does nothing while no notice is shown", () => {
    const clear = vi.fn();
    renderHook(() => useOfflineMergeNoticeAutoClear(null, clear));

    window.dispatchEvent(new Event("pointerdown"));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    vi.advanceTimersByTime(OFFLINE_MERGE_NOTICE_TIMEOUT_MS * 2);
    expect(clear).not.toHaveBeenCalled();
  });

  it("tears listeners and the timer down once the notice clears", () => {
    const clear = vi.fn();
    const { rerender } = renderHook(
      ({ notice }: { notice: OfflineMergeNoticeData | null }) =>
        useOfflineMergeNoticeAutoClear(notice, clear),
      { initialProps: { notice: NOTICE as OfflineMergeNoticeData | null } },
    );

    rerender({ notice: null });
    window.dispatchEvent(new Event("pointerdown"));
    vi.advanceTimersByTime(OFFLINE_MERGE_NOTICE_TIMEOUT_MS * 2);
    expect(clear).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("tears everything down on unmount", () => {
    const clear = vi.fn();
    const { unmount } = renderHook(() => useOfflineMergeNoticeAutoClear(NOTICE, clear));

    unmount();
    window.dispatchEvent(new Event("pointerdown"));
    vi.advanceTimersByTime(OFFLINE_MERGE_NOTICE_TIMEOUT_MS * 2);
    expect(clear).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a fresh notice restarts the timeout window", () => {
    const clear = vi.fn();
    const { rerender } = renderHook(
      ({ notice }: { notice: OfflineMergeNoticeData | null }) =>
        useOfflineMergeNoticeAutoClear(notice, clear),
      { initialProps: { notice: NOTICE as OfflineMergeNoticeData | null } },
    );

    vi.advanceTimersByTime(OFFLINE_MERGE_NOTICE_TIMEOUT_MS - 1);
    // A new outage produced a new notice object just before the old timer
    // would have fired.
    rerender({ notice: { mergedRemoteCellCount: null, removedEditedCellCount: 1 } });
    vi.advanceTimersByTime(OFFLINE_MERGE_NOTICE_TIMEOUT_MS - 1);
    expect(clear).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(clear).toHaveBeenCalledTimes(1);
  });
});
