// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { NativeTestDiagnostics } from "./native-test-diagnostics";

const directories: string[] = [];
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "node-diagnostics-test-"));
  directories.push(root);
  const diagnostics = new NativeTestDiagnostics(root);
  const events = () =>
    fs
      .readFileSync(path.join(diagnostics.directory!, "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  return { root, diagnostics, events };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true });
});

describe("native test diagnostics (no native runtime)", () => {
  it("preserves operation outcomes when diagnostic storage is unavailable", async () => {
    const { diagnostics } = fixture();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    fs.rmSync(diagnostics.directory!, { recursive: true });
    const result = { success: false };
    expect(await diagnostics.step("execution", async () => result)).toBe(result);
    const failure = new Error("original launch error");
    await expect(
      diagnostics.step("launch", async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(() => diagnostics.daemonOutput(Buffer.from("daemon failure"))).not.toThrow();
    await expect(
      diagnostics.capture("runtime", async () => {
        throw failure;
      }),
    ).resolves.toBeUndefined();
    expect(diagnostics.failureSummary("execution", [])).toContain("daemon failure");
    expect(warning).toHaveBeenCalledTimes(1);
  });

  it("does not replace a successful result that cannot be serialized", async () => {
    const { diagnostics } = fixture();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const result: { self?: unknown } = {};
    result.self = result;
    expect(await diagnostics.step("execution", async () => result)).toBe(result);
  });

  it("keeps late events associated with the test that started them", async () => {
    const { diagnostics, events } = fixture();
    const first = diagnostics.forTest("recovery stale=false");
    const next = diagnostics.forTest("recovery stale=true");
    let finish!: () => void;
    const pending = first.step(
      "execution",
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await next.capture("runtime", async () => ({ lifecycle: "Running" }));
    finish();
    await pending;
    first.bodyFailed(new Error("first test failed"));
    expect(events().map(({ event, details }) => [event, details.name ?? event])).toEqual([
      ["step_started", "recovery stale=false: execution"],
      ["recovery stale=true: runtime", "recovery stale=true: runtime"],
      ["step_completed", "recovery stale=false: execution"],
      ["test_body_failed", "recovery stale=false"],
    ]);
  });

  it("retains full output outside disposable fixtures and keeps runs separate", () => {
    const { root, diagnostics } = fixture();
    const second = new NativeTestDiagnostics(root);
    expect(second.directory).not.toBe(diagnostics.directory);
    const disposable = fs.mkdtempSync(path.join(root, "daemon-fixture-"));
    const output = Buffer.from(`initial launch error\n${"x".repeat(20000)}\nlast error`);
    diagnostics.daemonOutput(output);
    fs.rmSync(disposable, { recursive: true });
    expect(fs.readFileSync(path.join(diagnostics.directory!, "daemon.log"))).toEqual(output);
    const summary = diagnostics.failureSummary("execution", []);
    expect(summary).toContain("last error");
    expect(summary).not.toContain("initial launch error");
  });

  it("records stages and unsuccessful execution results without changing outcomes", async () => {
    const { diagnostics, events } = fixture();
    const result = { success: false, status: "kernel_failed" };
    expect(await diagnostics.step("first execution", async () => result)).toBe(result);
    const failure = new Error("launch rejected");
    await expect(
      diagnostics.step("environment sync", async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(events()).toEqual([
      expect.objectContaining({ event: "step_started", details: { name: "first execution" } }),
      expect.objectContaining({
        event: "step_completed",
        details: { name: "first execution", result },
      }),
      expect.objectContaining({ event: "step_started", details: { name: "environment sync" } }),
      expect.objectContaining({
        event: "step_failed",
        details: {
          name: "environment sync",
          error: expect.objectContaining({ message: failure.message }),
        },
      }),
    ]);
  });

  it("preserves a failed or stalled snapshot read as diagnostics", async () => {
    const { diagnostics, events } = fixture();
    await diagnostics.capture("runtime", async () => {
      throw new Error("session closed");
    });
    await diagnostics.capture("dependencies", () => new Promise(() => {}), 5);
    expect(events()).toEqual([
      expect.objectContaining({
        event: "runtime",
        details: { error: expect.objectContaining({ message: "session closed" }) },
      }),
      expect.objectContaining({
        event: "dependencies",
        details: { error: expect.objectContaining({ message: "Diagnostic read timed out" }) },
      }),
    ]);
  });
});
