import { beforeEach, describe, expect, it } from "vite-plus/test";
import {
  clearNotebookCommandRuntimeStatusCacheForTests,
  getLifecycleLabel,
  getStatusKeyLabel,
  KERNEL_ERROR_REASON,
  notebookCommandRuntimeStateForStatusKey,
  projectNotebookCommandRuntimeActions,
  projectNotebookCommandRuntimeStatus,
  projectNotebookCommandRuntimeStatusFromRuntimeState,
  RUNTIME_STATUS,
  RUNTIME_STATUS_LABELS,
  type RuntimeState,
  type RuntimeStatusKey,
} from "../src";

beforeEach(() => {
  clearNotebookCommandRuntimeStatusCacheForTests();
});

describe("notebook command runtime projection", () => {
  it("labels every expanded runtime status key", () => {
    const keys = Object.values(RUNTIME_STATUS) as RuntimeStatusKey[];
    for (const key of keys) {
      expect(getStatusKeyLabel(key, null)).toBe(RUNTIME_STATUS_LABELS[key]);
    }
  });

  it("renders typed error reasons only for error states", () => {
    expect(getStatusKeyLabel(RUNTIME_STATUS.ERROR, KERNEL_ERROR_REASON.MISSING_IPYKERNEL)).toBe(
      "error: ipykernel missing",
    );
    expect(
      getStatusKeyLabel(RUNTIME_STATUS.ERROR, KERNEL_ERROR_REASON.IPYKERNEL_SITE_PACKAGES_MISMATCH),
    ).toBe("error: Python environment mismatch");
    expect(getStatusKeyLabel(RUNTIME_STATUS.RUNNING_IDLE, "missing_ipykernel")).toBe("idle");
  });

  it("projects lifecycle labels through the same status-key table", () => {
    expect(getLifecycleLabel({ lifecycle: "Launching" }, null)).toBe("launching kernel");
    expect(getLifecycleLabel({ lifecycle: "Running", activity: "Unknown" }, null)).toBe("running");
  });

  it("maps expanded status keys to toolbar states", () => {
    expect(notebookCommandRuntimeStateForStatusKey(RUNTIME_STATUS.NOT_STARTED)).toBe("not_started");
    expect(notebookCommandRuntimeStateForStatusKey(RUNTIME_STATUS.AWAITING_TRUST)).toBe(
      "not_started",
    );
    expect(notebookCommandRuntimeStateForStatusKey(RUNTIME_STATUS.LAUNCHING)).toBe("starting");
    expect(notebookCommandRuntimeStateForStatusKey(RUNTIME_STATUS.RUNNING_IDLE)).toBe("idle");
    expect(notebookCommandRuntimeStateForStatusKey(RUNTIME_STATUS.RUNNING_UNKNOWN)).toBe("idle");
    expect(notebookCommandRuntimeStateForStatusKey(RUNTIME_STATUS.RUNNING_BUSY)).toBe("busy");
    expect(notebookCommandRuntimeStateForStatusKey(RUNTIME_STATUS.ERROR)).toBe("error");
    expect(notebookCommandRuntimeStateForStatusKey(RUNTIME_STATUS.SHUTDOWN)).toBe("shutdown");
  });

  it("returns frozen stable projections for equivalent status inputs", () => {
    const first = projectNotebookCommandRuntimeStatus({
      statusKey: RUNTIME_STATUS.RUNNING_IDLE,
      errorReason: null,
    });
    const second = projectNotebookCommandRuntimeStatus({
      statusKey: RUNTIME_STATUS.RUNNING_IDLE,
      errorReason: "",
    });

    expect(first).toBe(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(first).toEqual({
      ariaLabel: "Kernel: idle",
      label: "idle",
      state: "idle",
      statusKey: RUNTIME_STATUS.RUNNING_IDLE,
      title: "idle",
    });
  });

  it("can force error tone for host-side environment failures", () => {
    const projection = projectNotebookCommandRuntimeStatus({
      statusKey: RUNTIME_STATUS.RUNNING_IDLE,
      errorReason: null,
      forceError: true,
    });

    expect(projection).toMatchObject({
      label: "idle",
      state: "error",
    });
  });

  it("projects directly from RuntimeStateDoc snapshots", () => {
    const projection = projectNotebookCommandRuntimeStatusFromRuntimeState({
      kernel: {
        lifecycle: { lifecycle: "Running", activity: "Busy" },
        error_reason: null,
      },
    } as RuntimeState);

    expect(projection).toMatchObject({
      label: "busy",
      state: "busy",
      statusKey: RUNTIME_STATUS.RUNNING_BUSY,
    });
  });

  it("projects stable runtime command affordances from capabilities and host actions", () => {
    const runtimeStatus = projectNotebookCommandRuntimeStatus({
      statusKey: RUNTIME_STATUS.RUNNING_IDLE,
      errorReason: null,
    });
    const first = projectNotebookCommandRuntimeActions({
      capabilities: { canExecute: true },
      runtimeStatus,
      actions: {
        interruptRuntime: true,
        restartAndRunAll: true,
        restartRuntime: true,
        runAllCells: true,
        startRuntime: true,
      },
    });
    const second = projectNotebookCommandRuntimeActions({
      capabilities: { canExecute: true },
      runtimeStatus,
      actions: {
        interruptRuntime: true,
        restartAndRunAll: true,
        restartRuntime: true,
        runAllCells: true,
        startRuntime: true,
      },
    });

    expect(first).toBe(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(first).toEqual({
      hasRuntimeStatus: true,
      isRuntimeRunning: true,
      showAnyRuntimeAction: true,
      showInterrupt: true,
      showRestart: true,
      showRestartAndRunAll: true,
      showRunAll: true,
      showRuntimeStart: false,
    });
  });

  it("keeps start hidden when the host has no concrete start action", () => {
    const projection = projectNotebookCommandRuntimeActions({
      capabilities: { canExecute: true },
      runtimeStatus: projectNotebookCommandRuntimeStatus({
        statusKey: RUNTIME_STATUS.NOT_STARTED,
      }),
      actions: {
        runAllCells: true,
      },
    });

    expect(projection).toMatchObject({
      isRuntimeRunning: false,
      showRuntimeStart: false,
      showRunAll: true,
    });
  });

  it("gates all runtime actions when execution authority is absent", () => {
    const projection = projectNotebookCommandRuntimeActions({
      capabilities: { canExecute: false },
      runtimeStatus: projectNotebookCommandRuntimeStatus({
        statusKey: RUNTIME_STATUS.RUNNING_BUSY,
      }),
      actions: {
        interruptRuntime: true,
        restartRuntime: true,
        runAllCells: true,
      },
    });

    expect(projection).toMatchObject({
      hasRuntimeStatus: true,
      isRuntimeRunning: true,
      showAnyRuntimeAction: false,
      showInterrupt: false,
      showRestart: false,
      showRunAll: false,
    });
  });

  it("hides runtime actions until RuntimeStateDoc supplies a command status", () => {
    const projection = projectNotebookCommandRuntimeActions({
      capabilities: { canExecute: true },
      runtimeStatus: null,
      actions: {
        interruptRuntime: true,
        restartRuntime: true,
        runAllCells: true,
        startRuntime: true,
      },
    });

    expect(projection).toEqual({
      hasRuntimeStatus: false,
      isRuntimeRunning: false,
      showAnyRuntimeAction: false,
      showInterrupt: false,
      showRestart: false,
      showRestartAndRunAll: false,
      showRunAll: false,
      showRuntimeStart: false,
    });
  });
});
