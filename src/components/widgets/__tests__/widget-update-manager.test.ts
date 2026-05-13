/**
 * Tests for WidgetUpdateManager — debounced CRDT persistence + echo suppression.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createWidgetStore } from "../widget-store";
import { type BlobUploader, type ContentRef, WidgetUpdateManager } from "../widget-update-manager";

// ── Helpers ──────────────────────────────────────────────────────────

function setup(opts?: { writerAvailable?: boolean; blobUploader?: BlobUploader }) {
  const store = createWidgetStore();
  const writerCalls: Array<{ commId: string; patch: Record<string, unknown> }> = [];
  const writer = (commId: string, patch: Record<string, unknown>) => {
    writerCalls.push({ commId, patch });
  };

  const writerAvailable = opts?.writerAvailable ?? true;
  const manager = new WidgetUpdateManager({
    getStore: () => store,
    getCrdtWriter: () => (writerAvailable ? writer : null),
    getBlobUploader: () => opts?.blobUploader ?? null,
  });

  // Pre-create a model so updateModel works
  store.createModel("comm-1", { value: 0, description: "test" });

  return { store, manager, writerCalls };
}

// ── Tests ────────────────────────────────────────────────────────────

describe("WidgetUpdateManager", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Debouncing ──────────────────────────────────────────────────

  describe("debouncing", () => {
    it("updates store immediately", () => {
      const { store, manager } = setup();

      manager.updateAndPersist("comm-1", { value: 42 });

      expect(store.getModel("comm-1")?.state.value).toBe(42);
    });

    it("debounces CRDT writes at 50ms", () => {
      const { manager, writerCalls } = setup();

      manager.updateAndPersist("comm-1", { value: 10 });
      manager.updateAndPersist("comm-1", { value: 20 });
      manager.updateAndPersist("comm-1", { value: 30 });

      // No CRDT writes yet
      expect(writerCalls).toHaveLength(0);

      // Advance past debounce
      vi.advanceTimersByTime(50);

      // Single merged write
      expect(writerCalls).toHaveLength(1);
      expect(writerCalls[0]).toEqual({
        commId: "comm-1",
        patch: { value: 30 },
      });
    });

    it("merges multiple keys in debounce window", () => {
      const { manager, writerCalls } = setup();

      manager.updateAndPersist("comm-1", { value: 42 });
      manager.updateAndPersist("comm-1", { description: "updated" });

      vi.advanceTimersByTime(50);

      expect(writerCalls).toHaveLength(1);
      expect(writerCalls[0].patch).toEqual({
        value: 42,
        description: "updated",
      });
    });

    it("debounces independently per comm", () => {
      const { store, manager, writerCalls } = setup();
      store.createModel("comm-2", { value: 0 });

      manager.updateAndPersist("comm-1", { value: 10 });

      vi.advanceTimersByTime(30);

      manager.updateAndPersist("comm-2", { value: 20 });

      vi.advanceTimersByTime(20);

      // comm-1 flushed at t=50, comm-2 still pending
      expect(writerCalls).toHaveLength(1);
      expect(writerCalls[0].commId).toBe("comm-1");

      vi.advanceTimersByTime(30);

      // comm-2 flushed at t=80
      expect(writerCalls).toHaveLength(2);
      expect(writerCalls[1].commId).toBe("comm-2");
    });

    it("resets debounce timer on new update", () => {
      const { manager, writerCalls } = setup();

      manager.updateAndPersist("comm-1", { value: 10 });
      vi.advanceTimersByTime(40);

      // Another update before 50ms — resets the timer
      manager.updateAndPersist("comm-1", { value: 20 });
      vi.advanceTimersByTime(40);

      // Still no flush (only 40ms since last update)
      expect(writerCalls).toHaveLength(0);

      vi.advanceTimersByTime(10);

      // Now flushed with the latest value
      expect(writerCalls).toHaveLength(1);
      expect(writerCalls[0].patch).toEqual({ value: 20 });
    });

    it("uploads extracted binary leaves before writing ContentRefs to CRDT", async () => {
      const uploadCalls: Array<{ bytes: number[]; mediaType: string; durability?: string }> = [];
      const contentRef: ContentRef = {
        blob: "sha256:abc",
        size: 4,
        media_type: "application/octet-stream",
      };
      const { manager, writerCalls } = setup({
        blobUploader: async (bytes, mediaType, durability) => {
          uploadCalls.push({ bytes: Array.from(bytes), mediaType, durability });
          return contentRef;
        },
      });

      await manager.updateAndPersist("comm-1", {
        selection: {
          view: new DataView(new Uint8Array([1, 2, 3, 4]).buffer),
          dtype: "uint32",
          shape: [1],
        },
      });

      expect(uploadCalls).toEqual([
        { bytes: [1, 2, 3, 4], mediaType: "application/octet-stream", durability: "ephemeral" },
      ]);
      expect(writerCalls).toHaveLength(1);
      expect(writerCalls[0].patch).toEqual({
        selection: {
          view: contentRef,
          dtype: "uint32",
          shape: [1],
        },
      });
    });

    it("retries too_many_in_flight blob uploads", async () => {
      const contentRef: ContentRef = {
        blob: "sha256:retry",
        size: 1,
        media_type: "application/octet-stream",
      };
      let attempts = 0;
      const { manager, writerCalls } = setup({
        blobUploader: async () => {
          attempts += 1;
          if (attempts === 1) {
            throw { reason: { kind: "too_many_in_flight" } };
          }
          return contentRef;
        },
      });

      const pending = manager.updateAndPersist("comm-1", {
        selection: new Uint8Array([1]),
      });
      await vi.advanceTimersByTimeAsync(100);
      await pending;

      expect(attempts).toBe(2);
      expect(writerCalls).toHaveLength(1);
      expect(writerCalls[0].patch).toEqual({ selection: contentRef });
    });

    it("aborts CRDT writes when blob upload fails permanently", async () => {
      const error = new Error("blob store unavailable");
      const { manager, writerCalls } = setup({
        blobUploader: async () => {
          throw error;
        },
      });

      await expect(
        manager.updateAndPersist("comm-1", { selection: new Uint8Array([1]) }),
      ).rejects.toThrow("blob store unavailable");

      expect(writerCalls).toHaveLength(0);
    });

    it("does not upload pure JSON patches", () => {
      const blobUploader = vi.fn<BlobUploader>(async () => ({
        blob: "unused",
        size: 0,
        media_type: "application/octet-stream",
      }));
      const { manager, writerCalls } = setup({ blobUploader });

      manager.updateAndPersist("comm-1", { value: 42 });
      vi.advanceTimersByTime(50);

      expect(blobUploader).not.toHaveBeenCalled();
      expect(writerCalls).toHaveLength(1);
      expect(writerCalls[0].patch).toEqual({ value: 42 });
    });
  });

  // ── Echo suppression ────────────────────────────────────────────

  describe("echo suppression", () => {
    it("suppresses echoes that match the last-written value", () => {
      const { manager } = setup();

      manager.updateAndPersist("comm-1", { value: 42 });

      // Kernel bounces back the same value — pure echo.
      const result = manager.shouldSuppressEcho("comm-1", { value: 42 });
      expect(result).toBeNull();
    });

    it("lets kernel corrections pass through even for optimistic keys", () => {
      const { manager } = setup();

      // Frontend sends 5.1 (out of bounds for a max-5.0 slider).
      manager.updateAndPersist("comm-1", { value: 5.1 });

      // Kernel clamps to 5.0 and echoes the corrected value.
      const result = manager.shouldSuppressEcho("comm-1", { value: 5.0 });
      expect(result).toEqual({ value: 5.0 });
    });

    it("uses structural equality for array/object values", () => {
      const { manager } = setup();

      manager.updateAndPersist("comm-1", { value: [1, 2, 3] });
      expect(manager.shouldSuppressEcho("comm-1", { value: [1, 2, 3] })).toBeNull();
      expect(manager.shouldSuppressEcho("comm-1", { value: [1, 2] })).toEqual({
        value: [1, 2],
      });
    });

    it("passes through non-optimistic keys", () => {
      const { manager } = setup();

      manager.updateAndPersist("comm-1", { value: 42 });

      // value matches last-written and is suppressed; description is
      // not an optimistic key so passes through.
      const result = manager.shouldSuppressEcho("comm-1", {
        value: 42,
        description: "from kernel",
      });
      expect(result).toEqual({ description: "from kernel" });
    });

    it("passes everything when no optimistic keys", () => {
      const { manager } = setup();

      const result = manager.shouldSuppressEcho("comm-1", {
        value: 10,
        description: "from kernel",
      });
      expect(result).toEqual({ value: 10, description: "from kernel" });
    });

    it("keeps optimistic values for a grace period after flush, then clears", () => {
      const { manager } = setup();

      manager.updateAndPersist("comm-1", { value: 42 });

      // During debounce window — echo of the written value is suppressed.
      expect(manager.shouldSuppressEcho("comm-1", { value: 42 })).toBeNull();

      // Flush — CRDT write happens, but optimistic values stay alive
      // for a grace period so in-flight echoes of what we just wrote
      // don't flicker the user's state while the round trip completes.
      vi.advanceTimersByTime(50);
      expect(manager.shouldSuppressEcho("comm-1", { value: 42 })).toBeNull();

      // After the grace period — echoes pass through.
      vi.advanceTimersByTime(500);
      expect(manager.shouldSuppressEcho("comm-1", { value: 42 })).toEqual({
        value: 42,
      });
    });

    it("suppresses echoes of any recent write during continuous drag", () => {
      const { manager } = setup();

      // Continuous slider drag: every intermediate value is remembered.
      manager.updateAndPersist("comm-1", { value: 10 });
      vi.advanceTimersByTime(16);
      manager.updateAndPersist("comm-1", { value: 15 });
      vi.advanceTimersByTime(16);
      manager.updateAndPersist("comm-1", { value: 20 });

      // Kernel echoes arrive in the order we sent, potentially behind
      // our current drag position. All of them must be suppressed so
      // the UI doesn't snap backward to a stale value.
      expect(manager.shouldSuppressEcho("comm-1", { value: 10 })).toBeNull();
      expect(manager.shouldSuppressEcho("comm-1", { value: 15 })).toBeNull();
      expect(manager.shouldSuppressEcho("comm-1", { value: 20 })).toBeNull();

      // A value we never wrote (e.g., kernel clamp or external change)
      // still passes through.
      expect(manager.shouldSuppressEcho("comm-1", { value: 5 })).toEqual({
        value: 5,
      });

      // Non-value keys still pass through
      expect(manager.shouldSuppressEcho("comm-1", { value: 20, _view_name: "x" })).toEqual({
        _view_name: "x",
      });
    });
  });

  // ── clearComm ──────────────────────────────────────────────────

  describe("clearComm", () => {
    it("cancels pending flush", () => {
      const { manager, writerCalls } = setup();

      manager.updateAndPersist("comm-1", { value: 42 });
      manager.clearComm("comm-1");

      vi.advanceTimersByTime(50);

      expect(writerCalls).toHaveLength(0);
    });

    it("clears optimistic keys", () => {
      const { manager } = setup();

      manager.updateAndPersist("comm-1", { value: 42 });
      manager.clearComm("comm-1");

      // Echo passes through after clearComm
      const result = manager.shouldSuppressEcho("comm-1", { value: 10 });
      expect(result).toEqual({ value: 10 });
    });
  });

  // ── reset ──────────────────────────────────────────────────────

  describe("reset", () => {
    it("cancels all pending flushes", () => {
      const { store, manager, writerCalls } = setup();
      store.createModel("comm-2", { value: 0 });

      manager.updateAndPersist("comm-1", { value: 10 });
      manager.updateAndPersist("comm-2", { value: 20 });
      manager.reset();

      vi.advanceTimersByTime(50);

      expect(writerCalls).toHaveLength(0);
    });

    it("clears all optimistic keys", () => {
      const { manager } = setup();

      manager.updateAndPersist("comm-1", { value: 42 });
      manager.reset();

      const result = manager.shouldSuppressEcho("comm-1", { value: 10 });
      expect(result).toEqual({ value: 10 });
    });
  });

  // ── Writer unavailable ─────────────────────────────────────────

  describe("writer unavailable", () => {
    it("retries flush when CRDT writer is null", () => {
      let writerAvailable = false;
      const writerCalls: Array<{
        commId: string;
        patch: Record<string, unknown>;
      }> = [];
      const store = createWidgetStore();
      store.createModel("comm-1", { value: 0 });

      const manager = new WidgetUpdateManager({
        getStore: () => store,
        getCrdtWriter: () =>
          writerAvailable
            ? (commId: string, patch: Record<string, unknown>) => {
                writerCalls.push({ commId, patch });
              }
            : null,
      });

      manager.updateAndPersist("comm-1", { value: 42 });

      // First flush attempt — writer not available, retries
      vi.advanceTimersByTime(50);
      expect(writerCalls).toHaveLength(0);

      // Make writer available
      writerAvailable = true;

      // Retry fires after another 50ms
      vi.advanceTimersByTime(50);
      expect(writerCalls).toHaveLength(1);
      expect(writerCalls[0].patch).toEqual({ value: 42 });
    });

    it("keeps optimistic keys while retrying", () => {
      const store = createWidgetStore();
      store.createModel("comm-1", { value: 0 });

      const manager = new WidgetUpdateManager({
        getStore: () => store,
        getCrdtWriter: () => null,
      });

      manager.updateAndPersist("comm-1", { value: 42 });
      vi.advanceTimersByTime(50);

      // Still optimistic since flush failed — echo of last-written suppressed
      expect(manager.shouldSuppressEcho("comm-1", { value: 42 })).toBeNull();
    });
  });
});
