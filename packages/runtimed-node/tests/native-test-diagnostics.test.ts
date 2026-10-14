// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
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
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true });
});

describe("native test diagnostics (no native runtime)", () => {
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
