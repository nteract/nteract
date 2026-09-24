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
