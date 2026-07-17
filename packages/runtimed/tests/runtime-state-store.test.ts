import {
  BUSY_THROTTLE_MS,
  DEFAULT_RUNTIME_STATE,
  RUNTIME_STATUS,
  RuntimeStateStore,
  throttleBusyStatus,
  type RuntimeState,
  type RuntimeStatusKey,
} from "runtimed";
import { Subject } from "rxjs";
import { TestScheduler } from "rxjs/testing";
import { describe, expect, it } from "vite-plus/test";

function stateWith(overrides: Partial<RuntimeState>): RuntimeState {
  return { ...DEFAULT_RUNTIME_STATE, ...overrides };
}

function runningState(activity: "Idle" | "Busy" | "Unknown"): RuntimeState {
  return stateWith({
    kernel: {
      ...DEFAULT_RUNTIME_STATE.kernel,
      lifecycle: { lifecycle: "Running", activity },
    },
  });
}

function collect<T>(observable: { subscribe: (next: (value: T) => void) => unknown }): T[] {
  const values: T[] = [];
  observable.subscribe((value) => values.push(value));
  return values;
}

describe("RuntimeStateStore", () => {
  it("starts unloaded with the default snapshot", () => {
    const store = new RuntimeStateStore();
    expect(store.isLoaded).toBe(false);
    expect(store.snapshot).toBe(DEFAULT_RUNTIME_STATE);
  });

  it("set() marks loaded and emits; reset() returns to default", () => {
    const store = new RuntimeStateStore();
    const loaded = collect(store.loaded$);
    store.set(runningState("Idle"));
    expect(store.isLoaded).toBe(true);
    store.reset();
    expect(store.isLoaded).toBe(false);
    expect(store.snapshot).toBe(DEFAULT_RUNTIME_STATE);
    expect(loaded).toEqual([false, true, false]);
  });

  it("select() dedups with the provided equality", () => {
    const store = new RuntimeStateStore();
    const seen = collect(store.select((state) => state.kernel.lifecycle.lifecycle));
    store.set(runningState("Idle"));
    store.set(runningState("Busy"));
    expect(seen).toEqual(["NotStarted", "Running"]);
  });

  it("keeps the pill status while reconnect resets the store", () => {
    const store = new RuntimeStateStore();
    const seen = collect(store.throttledStatusKey$);

    store.set(runningState("Idle"));
    store.reset();

    expect(store.isLoaded).toBe(false);
    expect(store.snapshot).toBe(DEFAULT_RUNTIME_STATE);
    expect(seen).toEqual([RUNTIME_STATUS.CONNECTING, RUNTIME_STATUS.RUNNING_IDLE]);
  });

  it("updates the pill status when the loaded gate reopens with fresh data", () => {
    const store = new RuntimeStateStore();
    const seen = collect(store.throttledStatusKey$);

    store.set(runningState("Idle"));
    store.reset();
    store.set(
      stateWith({
        kernel: {
          ...DEFAULT_RUNTIME_STATE.kernel,
          lifecycle: { lifecycle: "Launching" },
        },
      }),
    );

    expect(seen).toEqual([
      RUNTIME_STATUS.CONNECTING,
      RUNTIME_STATUS.RUNNING_IDLE,
      RUNTIME_STATUS.LAUNCHING,
    ]);
  });

  it("shows a fresh session's real initial pill status once loaded", () => {
    const store = new RuntimeStateStore();
    const seen = collect(store.throttledStatusKey$);

    store.set(DEFAULT_RUNTIME_STATE);

    expect(store.isLoaded).toBe(true);
    expect(seen).toEqual([RUNTIME_STATUS.CONNECTING, RUNTIME_STATUS.NOT_STARTED]);
  });

  it("kernelInfo$ emits only when kernel type or env source changes", () => {
    const store = new RuntimeStateStore();
    const seen = collect(store.kernelInfo$);
    store.set(runningState("Idle"));
    store.set(runningState("Busy"));
    store.set(
      stateWith({
        kernel: {
          ...runningState("Busy").kernel,
          language: "python",
          env_source: "uv:prewarmed",
        },
      }),
    );
    expect(seen).toEqual([
      { kernelType: undefined, envSource: undefined },
      { kernelType: "python", envSource: "uv:prewarmed" },
    ]);
  });

  it("queueState$ dedups on queue membership, not snapshot identity", () => {
    const store = new RuntimeStateStore();
    const seen = collect(store.queueState$);
    const queued = stateWith({
      queue: { executing: { execution_id: "e1" }, queued: [{ execution_id: "e2" }] },
    });
    store.set(queued);
    // Same queue content, new snapshot object — must not re-emit.
    store.set(stateWith({ queue: { ...queued.queue } }));
    store.set(stateWith({ queue: { executing: null, queued: [] } }));
    expect(seen.map((q) => q.executing?.execution_id ?? null)).toEqual([null, "e1", null]);
  });

  it("workstation$ dedups by attachment cache key across daemon ticks", () => {
    const store = new RuntimeStateStore();
    const attachment = {
      workstation_id: "w1",
      display_name: "Lab box",
      provider: "outerbounds",
      default_environment_label: "py311",
      environment_policy: "current_python",
      status: "connected",
      accelerators: [
        {
          kind: "gpu",
          vendor: "NVIDIA",
          model: "A100",
          count: 1,
          readiness: "ready" as const,
        },
      ],
    };
    const seen = collect(store.workstation$);
    store.set(stateWith({ workstation: attachment }));
    // New object, same facts — a runtime tick that didn't change attachment.
    store.set(
      stateWith({
        workstation: {
          ...attachment,
          accelerators: attachment.accelerators.map((accelerator) => ({ ...accelerator })),
        },
      }),
    );
    store.set(
      stateWith({
        workstation: {
          ...attachment,
          accelerators: attachment.accelerators.map((accelerator) => ({
            ...accelerator,
            readiness: "unknown" as const,
          })),
        },
      }),
    );
    store.set(stateWith({ workstation: { ...attachment, status: "disconnected" } }));
    store.set(stateWith({ workstation: undefined }));
    expect(
      seen.map((workstation) =>
        workstation
          ? `${workstation.status}:${workstation.accelerators?.[0]?.readiness ?? "none"}`
          : null,
      ),
    ).toEqual([null, "connected:ready", "connected:unknown", "disconnected:ready", null]);
  });
});

describe("throttleBusyStatus", () => {
  function withScheduler(
    run: (helpers: {
      scheduler: TestScheduler;
      source: Subject<RuntimeStatusKey>;
      emitted: RuntimeStatusKey[];
    }) => void,
  ): void {
    const scheduler = new TestScheduler((actual, expected) => {
      expect(actual).toEqual(expected);
    });
    scheduler.run(() => {
      const source = new Subject<RuntimeStatusKey>();
      const emitted: RuntimeStatusKey[] = [];
      source.pipe(throttleBusyStatus(scheduler)).subscribe((key) => emitted.push(key));
      run({ scheduler, source, emitted });
    });
  }

  it("suppresses a busy flash shorter than the throttle window", () => {
    withScheduler(({ scheduler, source, emitted }) => {
      source.next(RUNTIME_STATUS.RUNNING_IDLE);
      source.next(RUNTIME_STATUS.RUNNING_BUSY);
      // Idle arrives before the busy timer fires — busy never shows.
      scheduler.schedule(() => source.next(RUNTIME_STATUS.RUNNING_IDLE), BUSY_THROTTLE_MS - 1);
      scheduler.flush();
      expect(emitted).toEqual([RUNTIME_STATUS.RUNNING_IDLE]);
    });
  });

  it("commits busy after the throttle window elapses", () => {
    withScheduler(({ scheduler, source, emitted }) => {
      source.next(RUNTIME_STATUS.RUNNING_IDLE);
      source.next(RUNTIME_STATUS.RUNNING_BUSY);
      scheduler.schedule(() => source.next(RUNTIME_STATUS.RUNNING_IDLE), BUSY_THROTTLE_MS + 10);
      scheduler.flush();
      expect(emitted).toEqual([
        RUNTIME_STATUS.RUNNING_IDLE,
        RUNTIME_STATUS.RUNNING_BUSY,
        RUNTIME_STATUS.RUNNING_IDLE,
      ]);
    });
  });

  it("passes non-running keys through immediately, cancelling pending busy", () => {
    withScheduler(({ scheduler, source, emitted }) => {
      source.next(RUNTIME_STATUS.RUNNING_BUSY);
      source.next(RUNTIME_STATUS.ERROR);
      scheduler.flush();
      expect(emitted).toEqual([RUNTIME_STATUS.ERROR]);
    });
  });
});
