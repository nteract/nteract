import { act, renderHook } from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  useCloudRuntimeCommands,
  type CloudRuntimeCommandTarget,
  type CloudStartWorkstationOptions,
} from "../use-cloud-runtime-commands";

// These tests render the REAL hook that notebook-viewer.tsx wires into the
// toolbar and cells. Every network boundary (document sync, workstation attach,
// room requests) is a held promise the test releases explicitly, so the
// Restart-and-run-all / Interrupt race is deterministic.

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });
}

interface Harness {
  events: string[];
  flushes: Deferred<boolean>[];
  starts: Deferred<boolean>[];
  startOptions: (CloudStartWorkstationOptions | undefined)[];
  holdFlush: boolean;
  holdStart: boolean;
  lastAction: string;
  /** Stands in for liveRuntimeRef.current: one object per room connection. */
  runtime: CloudRuntimeCommandTarget["liveRuntime"] | null;
}

function connectRuntime(harness: Harness): CloudRuntimeCommandTarget["liveRuntime"] {
  return {
    engine: {
      flushAndWait: () => {
        harness.events.push(`flush:${harness.lastAction}`);
        if (!harness.holdFlush) return Promise.resolve(true);
        const held = deferred<boolean>();
        harness.flushes.push(held);
        return held.promise;
      },
    },
  };
}

function createHarness(): Harness {
  const harness: Harness = {
    events: [],
    flushes: [],
    starts: [],
    startOptions: [],
    holdFlush: false,
    holdStart: true,
    lastAction: "",
    runtime: null,
  };
  harness.runtime = connectRuntime(harness);
  return harness;
}

function renderCommands(harness: Harness, options: { canStart?: boolean; strict?: boolean } = {}) {
  // Mirrors notebook-viewer.tsx createCloudNotebookClient: the client is bound
  // to the connection that is live when the command is issued.
  const createClient = (action: string): CloudRuntimeCommandTarget | null => {
    if (!harness.runtime) return null;
    harness.lastAction = action;
    return {
      liveRuntime: harness.runtime,
      client: {
        executeCell: async (cellId: string) => {
          harness.events.push(`execute_cell:${cellId}`);
        },
        runAllCells: async () => {
          harness.events.push("run_all_cells");
        },
        interruptKernel: async () => {
          harness.events.push("interrupt_execution");
        },
      },
    };
  };
  const onStartSelectedWorkstation = (options?: CloudStartWorkstationOptions) => {
    harness.events.push(options?.replaceExisting ? "attach:restart" : "attach");
    harness.startOptions.push(options);
    if (!harness.holdStart) return Promise.resolve(true);
    const held = deferred<boolean>();
    harness.starts.push(held);
    return held.promise;
  };
  return renderHook(
    ({ roomKey }: { roomKey: string }) =>
      useCloudRuntimeCommands({
        createClient,
        getCurrentRuntime: () => harness.runtime,
        onStartSelectedWorkstation:
          options.canStart === false ? undefined : onStartSelectedWorkstation,
        canRequestCellExecution: true,
        roomKey,
      }),
    {
      initialProps: { roomKey: "nb-1" },
      wrapper: options.strict
        ? ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>
        : undefined,
    },
  );
}

const executionEvents = (events: string[]) =>
  events.filter((event) => event === "run_all_cells" || event.startsWith("execute_cell:"));

describe("useCloudRuntimeCommands", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  let info: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    info = vi.spyOn(console, "info").mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
    info.mockRestore();
  });

  it("Interrupt during a held restart attachment never runs cells when the runtime attaches", async () => {
    const harness = createHarness();
    const { result } = renderCommands(harness);

    act(() => result.current.restartAndRunAll());
    await settle();
    expect(harness.events).toEqual(["flush:restart kernel and run all cells", "attach:restart"]);

    act(() => result.current.interruptRuntime());
    // The replacement runtime attaches after the user already interrupted.
    harness.starts[0].resolve(true);
    await settle();

    expect(harness.events).toEqual([
      "flush:restart kernel and run all cells",
      "attach:restart",
      "interrupt_execution",
    ]);
    expect(executionEvents(harness.events)).toEqual([]);
    expect(harness.startOptions[0]).toEqual({
      message: "Restarting compute. Run all is queued for the replacement runtime.",
      replaceExisting: true,
    });
    expect(info).toHaveBeenCalledWith(
      "[notebook-cloud] restart kernel and run all cells request cancelled before it reached the room",
    );

    // A fresh explicit action still works, exactly once (no replay).
    act(() => result.current.runAllCells());
    await settle();
    expect(executionEvents(harness.events)).toEqual(["run_all_cells"]);
  });

  it("Interrupt during held document sync drops the restart and its run all", async () => {
    const harness = createHarness();
    harness.holdFlush = true;
    const { result } = renderCommands(harness);

    act(() => result.current.restartAndRunAll());
    act(() => result.current.interruptRuntime());
    harness.flushes[0].resolve(true);
    await settle();

    expect(harness.events).toEqual([
      "flush:restart kernel and run all cells",
      "interrupt_execution",
    ]);

    harness.holdFlush = false;
    harness.holdStart = false;
    act(() => result.current.restartAndRunAll());
    await settle();
    expect(harness.events.slice(2)).toEqual([
      "flush:restart kernel and run all cells",
      "attach:restart",
      "run_all_cells",
    ]);
  });

  it("Interrupt cancels a Run that is waiting on compute start, and a new Run starts fresh", async () => {
    const harness = createHarness();
    const { result } = renderCommands(harness);

    act(() => result.current.requestExecuteCell("cell-a"));
    await settle();
    expect(harness.starts).toHaveLength(1);

    act(() => result.current.interruptRuntime());
    act(() => result.current.requestExecuteCell("cell-b"));
    await settle();
    // The cancelled start is not joined; the explicit new Run issues its own.
    expect(harness.starts).toHaveLength(2);

    // The stale start settling must not clear the newer shared start promise.
    harness.starts[0].resolve(true);
    await settle();
    act(() => result.current.requestExecuteCell("cell-c"));
    await settle();
    expect(harness.starts).toHaveLength(2);

    harness.starts[1].resolve(true);
    await settle();
    expect(executionEvents(harness.events)).toEqual(["execute_cell:cell-b", "execute_cell:cell-c"]);
    expect(harness.startOptions[1]).toEqual({
      message: "Starting compute. Run is queued for the selected workstation.",
    });
  });

  it("StrictMode's mount-time effect cleanup does not cancel later commands", async () => {
    const harness = createHarness();
    harness.holdStart = false;
    const { result } = renderCommands(harness, { strict: true });

    act(() => result.current.restartAndRunAll());
    await settle();
    expect(executionEvents(harness.events)).toEqual(["run_all_cells"]);
  });

  it("concurrent Runs share one compute start", async () => {
    const harness = createHarness();
    const { result } = renderCommands(harness);

    act(() => {
      result.current.requestExecuteCell("cell-a");
      result.current.requestExecuteCell("cell-b");
    });
    await settle();
    expect(harness.starts).toHaveLength(1);
    harness.starts[0].resolve(true);
    await settle();
    expect(executionEvents(harness.events)).toEqual(["execute_cell:cell-a", "execute_cell:cell-b"]);
  });

  it("a replaced room connection drops a delayed run", async () => {
    const harness = createHarness();
    harness.holdFlush = true;
    const { result } = renderCommands(harness);

    act(() => result.current.runAllCells());
    harness.runtime = connectRuntime(harness);
    harness.flushes[0].resolve(true);
    await settle();
    expect(executionEvents(harness.events)).toEqual([]);
  });

  it("a room change cancels a pending restart and run all", async () => {
    const harness = createHarness();
    const { result, rerender } = renderCommands(harness);

    act(() => result.current.restartAndRunAll());
    await settle();
    rerender({ roomKey: "nb-2" });
    harness.starts[0].resolve(true);
    await settle();
    expect(executionEvents(harness.events)).toEqual([]);
  });

  it("unmount cancels a pending restart and run all", async () => {
    const harness = createHarness();
    const { result, unmount } = renderCommands(harness);

    act(() => result.current.restartAndRunAll());
    await settle();
    unmount();
    harness.starts[0].resolve(true);
    await settle();
    expect(executionEvents(harness.events)).toEqual([]);
  });

  it("failed document sync never attaches or executes", async () => {
    const harness = createHarness();
    harness.holdFlush = true;
    const { result } = renderCommands(harness);

    act(() => result.current.restartAndRunAll());
    harness.flushes[0].resolve(false);
    await settle();
    expect(harness.events).toEqual(["flush:restart kernel and run all cells"]);
    expect(warn).toHaveBeenCalledWith(
      "[notebook-cloud] restart kernel and run all cells request skipped; notebook sync failed",
    );
  });

  it("failed restart attachment never runs all cells", async () => {
    const harness = createHarness();
    const { result } = renderCommands(harness);

    act(() => result.current.restartAndRunAll());
    await settle();
    harness.starts[0].resolve(false);
    await settle();
    expect(executionEvents(harness.events)).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      "[notebook-cloud] restart kernel and run all cells request skipped; compute did not start",
    );
  });

  it("Restart and run all without a startable workstation does not run all on the old runtime", async () => {
    const harness = createHarness();
    const { result } = renderCommands(harness, { canStart: false });

    act(() => result.current.restartAndRunAll());
    await settle();
    expect(harness.events).toEqual(["flush:restart kernel and run all cells"]);
    expect(warn).toHaveBeenCalledWith(
      "[notebook-cloud] restart kernel and run all cells request skipped; compute did not start",
    );
  });

  it("Restart supersedes a pending Run all from before the restart", async () => {
    const harness = createHarness();
    harness.holdFlush = true;
    const { result } = renderCommands(harness);

    act(() => result.current.runAllCells());
    act(() => result.current.restartRuntime());
    harness.flushes[0].resolve(true);
    await settle();
    expect(executionEvents(harness.events)).toEqual([]);
    expect(harness.startOptions[0]).toEqual({
      message: "Restarting compute. Waiting for the workstation to replace the runtime peer.",
      replaceExisting: true,
    });
  });

  it("Start does not cancel a Run that is waiting on compute", async () => {
    const harness = createHarness();
    const { result } = renderCommands(harness);

    act(() => result.current.requestExecuteCell("cell-a"));
    await settle();
    act(() => result.current.startRuntime());
    harness.starts[0].resolve(true);
    harness.starts[1].resolve(true);
    await settle();
    expect(executionEvents(harness.events)).toEqual(["execute_cell:cell-a"]);
  });

  it("Interrupt after execution intent was sent leaves the server-owned queue to the room", async () => {
    const harness = createHarness();
    harness.holdStart = false;
    const { result } = renderCommands(harness);

    act(() => result.current.restartAndRunAll());
    await settle();
    act(() => result.current.interruptRuntime());
    await settle();
    expect(harness.events).toEqual([
      "flush:restart kernel and run all cells",
      "attach:restart",
      "run_all_cells",
      "interrupt_execution",
    ]);
  });
});
