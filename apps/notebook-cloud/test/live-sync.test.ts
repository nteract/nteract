import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeConnectionScope, withReadyTimeout } from "../viewer/live-sync.ts";

describe("cloud live sync", () => {
  it("accepts known connection scopes", () => {
    assert.equal(normalizeConnectionScope("viewer"), "viewer");
    assert.equal(normalizeConnectionScope("editor"), "editor");
    assert.equal(normalizeConnectionScope("runtime_peer"), "runtime_peer");
    assert.equal(normalizeConnectionScope("owner"), "owner");
  });

  it("falls back to viewer for unknown connection scopes", () => {
    const originalWarn = console.warn;
    const warnings: unknown[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };
    try {
      assert.equal(normalizeConnectionScope("admin"), "viewer");
    } finally {
      console.warn = originalWarn;
    }

    assert.equal(warnings.length, 1);
  });

  it("times out a silent ready promise", async () => {
    await assert.rejects(
      withReadyTimeout(new Promise(() => undefined), 1, "silent socket"),
      /silent socket/,
    );
  });

  it("returns a ready value before the timeout", async () => {
    await assert.doesNotReject(
      withReadyTimeout(Promise.resolve("ready"), 1_000, "should not fire"),
    );
  });
});
