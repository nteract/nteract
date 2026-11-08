// @vitest-environment node
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, expectTypeOf, it, vi } from "vite-plus/test";
import type { Session, SessionStatus } from "../src/index";

const require = createRequire(import.meta.url);
const { Session: SessionWrapper } = require("../src/session.cjs") as {
  Session: new (native: Record<string, unknown>) => Session;
};

it("preserves the Rust-serialized session status contract", async () => {
  // The Rust test checks this shared fixture against actual SyncStatus serialization.
  const fixture = JSON.parse(
    readFileSync(
      new URL("../../../crates/notebook-sync/tests/fixtures/session-status.json", import.meta.url),
      "utf8",
    ),
  );
  let emit: (json: string) => void = () => {};
  const dispose = vi.fn();
  const session = new SessionWrapper({
    onSessionStatus(callback: (json: string) => void) {
      emit = callback;
      return { dispose };
    },
    close: vi.fn(async () => {}),
  });
  const statuses: SessionStatus[] = [];
  const failures: string[] = [];
  let disconnected = false;
  let completed = false;
  session.sessionStatus$.subscribe({
    next(status) {
      statuses.push(status);
      if (status.connection === "Disconnected") disconnected = true;
      if (typeof status.initial_load === "object") failures.push(status.initial_load.Failed.reason);
    },
    complete() {
      completed = true;
    },
  });
  for (const status of fixture) emit(JSON.stringify(status));
  expect(statuses).toEqual(fixture);
  expect(failures).toEqual(["bootstrap rejected"]);
  expect(disconnected).toBe(true);
  await session.close();
  expect(dispose).toHaveBeenCalledOnce();
  expect(completed).toBe(true);

  expectTypeOf<SessionStatus>().toEqualTypeOf<{
    connection: "Connected" | "Disconnected";
    notebook_doc: "Pending" | "Syncing" | "Interactive";
    runtime_state: "Pending" | "Syncing" | "Ready";
    initial_load: "NotNeeded" | "Streaming" | "Ready" | { Failed: { reason: string } };
  }>();
});

it.each(["true", "false", "reject"] as const)(
  "cleans up shutdown subscriptions only after native success (%s)",
  async (outcome) => {
    const events = [
      ["onRuntimeState", "runtimeState$"],
      ["onExecutionTransition", "executionTransitions$"],
      ["onExecutionViewChange", "executionViewChanges$"],
      ["onCellChange", "cellChanges$"],
      ["onBroadcast", "broadcasts$"],
      ["onSessionStatus", "sessionStatus$"],
    ] as const;
    const disposers = events.map(() => vi.fn());
    const completions = events.map(() => vi.fn());
    let resolveShutdown!: (removed: boolean) => void;
    let rejectShutdown!: (error: Error) => void;
    const shutdown = new Promise<boolean>((resolve, reject) => {
      resolveShutdown = resolve;
      rejectShutdown = reject;
    });
    let resolveClose!: () => void;
    const closing = new Promise<void>((resolve) => {
      resolveClose = resolve;
    });
    const native = {
      ...Object.fromEntries(
        events.map(([method], index) => [method, () => ({ dispose: disposers[index] })]),
      ),
      shutdownNotebook: vi.fn(() => shutdown),
      close: vi.fn(() => {
        for (const dispose of disposers) expect(dispose).toHaveBeenCalledOnce();
        for (const complete of completions) expect(complete).toHaveBeenCalledOnce();
        return closing;
      }),
    };
    const session = new SessionWrapper(native);
    const subscriptions = events.map(([, stream], index) =>
      session[stream].subscribe({ complete: completions[index] }),
    );
    const result = session.shutdownNotebook();
    const settled = vi.fn();
    void result.then(settled, settled);

    expect(native.shutdownNotebook).toHaveBeenCalledOnce();
    expect(native.close).not.toHaveBeenCalled();
    for (const dispose of disposers) expect(dispose).not.toHaveBeenCalled();
    for (const complete of completions) expect(complete).not.toHaveBeenCalled();

    if (outcome === "true") {
      resolveShutdown(true);
      await Promise.resolve();
      expect(native.close).toHaveBeenCalledOnce();
      // Drain result reactions while native close is still pending.
      await Promise.resolve();
      expect(settled).not.toHaveBeenCalled();
      resolveClose();
      await expect(result).resolves.toBe(true);
    } else {
      if (outcome === "false") {
        resolveShutdown(false);
        await expect(result).resolves.toBe(false);
      } else {
        const error = new Error("native shutdown failed");
        rejectShutdown(error);
        await expect(result).rejects.toBe(error);
      }
      expect(native.close).not.toHaveBeenCalled();
      for (const dispose of disposers) expect(dispose).not.toHaveBeenCalled();
      for (const complete of completions) expect(complete).not.toHaveBeenCalled();
      for (const subscription of subscriptions) expect(subscription.closed).toBe(false);
      resolveClose();
    }

    await expect(session.close()).resolves.toBeUndefined();
    expect(native.close).toHaveBeenCalledTimes(outcome === "true" ? 2 : 1);
    for (const dispose of disposers) expect(dispose).toHaveBeenCalledOnce();
    for (const complete of completions) expect(complete).toHaveBeenCalledOnce();
    for (const subscription of subscriptions) expect(subscription.closed).toBe(true);
  },
);
