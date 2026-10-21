import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";
import { KERNEL_STATUS, type EnvSyncState, type NotebookResponse } from "runtimed";
import {
  getPendingTrustActionDialogCopy,
  isLaunchErrorHandledByRuntimeBanner,
  isTrustedForRuntimeAction,
  shouldAttemptHotSyncDependencies,
  useNotebookActionPolicy,
} from "../notebook-action-policy";

function response(result: NotebookResponse["result"]): NotebookResponse {
  return { result } as NotebookResponse;
}

function createPolicyOptions(
  overrides: Partial<Parameters<typeof useNotebookActionPolicy>[0]> = {},
): Parameters<typeof useNotebookActionPolicy>[0] {
  return {
    canExecute: true,
    sessionReady: true,
    kernelStatus: KERNEL_STATUS.NOT_STARTED,
    envSource: "uv:inline",
    envSyncState: {
      inSync: false,
      diff: { added: ["requests"], removed: [], channelsChanged: false, denoChanged: false },
    },
    getObservedHeads: () => ["head-1"],
    getNotebookCellsSnapshot: () => [{ id: "cell-1", cell_type: "code" }],
    resetEnvProgress: vi.fn(),
    flushSync: vi.fn().mockResolvedValue(true),
    checkTrust: vi.fn().mockResolvedValue({ status: "trusted" }),
    approveTrust: vi.fn().mockResolvedValue(true),
    launchKernel: vi.fn().mockResolvedValue(response("kernel_already_running")),
    executeCell: vi.fn().mockResolvedValue(response("cell_queued")),
    executeCellGuarded: vi.fn().mockResolvedValue(response("cell_queued")),
    shutdownKernel: vi.fn().mockResolvedValue(response("kernel_shutting_down")),
    syncEnvironment: vi.fn().mockResolvedValue({
      result: "sync_environment_complete",
      synced_packages: ["requests"],
    } satisfies NotebookResponse),
    approveProjectEnvironment: vi.fn().mockResolvedValue(response("ok")),
    runAllCells: vi.fn().mockResolvedValue({
      result: "all_cells_queued",
      queued: [],
    } satisfies NotebookResponse),
    runAllCellsGuarded: vi.fn().mockResolvedValue({
      result: "all_cells_queued",
      queued: [],
    } satisfies NotebookResponse),
    getProjectEnvironmentFilePath: () => undefined,
    resetDismissedEnvBuildDetails: vi.fn(),
    showEnvBuildDialog: vi.fn(),
    ...overrides,
  };
}

describe("notebook action policy helpers", () => {
  it("fails closed unless trust state is explicitly trusted or dependency-free", () => {
    expect(isTrustedForRuntimeAction(null)).toBe(false);
    expect(isTrustedForRuntimeAction({ status: "untrusted" })).toBe(false);
    expect(isTrustedForRuntimeAction({ status: "trusted" })).toBe(true);
    expect(isTrustedForRuntimeAction({ status: "no_dependencies" })).toBe(true);
  });

  it("only hot-syncs inline uv/conda dependency additions", () => {
    const additionsOnly: EnvSyncState = {
      inSync: false,
      diff: { added: ["numpy"], removed: [], channelsChanged: false, denoChanged: false },
    };
    const withRemoval: EnvSyncState = {
      inSync: false,
      diff: { added: ["numpy"], removed: ["pandas"], channelsChanged: false, denoChanged: false },
    };

    expect(shouldAttemptHotSyncDependencies("uv:inline", additionsOnly)).toBe(true);
    expect(shouldAttemptHotSyncDependencies("conda:inline", additionsOnly)).toBe(true);
    expect(shouldAttemptHotSyncDependencies("pixi:inline", additionsOnly)).toBe(false);
    expect(shouldAttemptHotSyncDependencies("uv:inline", withRemoval)).toBe(false);
    expect(shouldAttemptHotSyncDependencies("uv:inline", null)).toBe(false);
  });

  it("keeps approval-dialog copy tied to pending action kind", () => {
    expect(getPendingTrustActionDialogCopy(null)).toEqual({
      approveLabel: undefined,
      approveOnlyLabel: "Trust & Start",
      description: undefined,
    });
    expect(
      getPendingTrustActionDialogCopy({
        kind: "execute_cell",
        cellId: "cell-1",
        provenance: { observed_heads: ["head-1"] },
      }),
    ).toMatchObject({
      approveLabel: "Trust and Run Cell",
      approveOnlyLabel: "Trust & Start",
    });
    expect(
      getPendingTrustActionDialogCopy({
        kind: "sync_deps",
        provenance: { observed_heads: ["head-1"] },
      }),
    ).toMatchObject({
      approveLabel: "Trust and Sync",
      approveOnlyLabel: "Trust Notebook",
    });
  });

  it("recognizes launch errors rendered by the runtime banner", () => {
    expect(isLaunchErrorHandledByRuntimeBanner("ipykernel not found in pixi.toml")).toBe(true);
    expect(isLaunchErrorHandledByRuntimeBanner("ipykernel not found in prepared env")).toBe(true);
    expect(isLaunchErrorHandledByRuntimeBanner("environment.yml declares conda env named x")).toBe(
      true,
    );
    expect(isLaunchErrorHandledByRuntimeBanner("kernel crashed")).toBe(false);
  });
});

describe("useNotebookActionPolicy", () => {
  it("reports a rejected environment selection as a failed kernel start with recovery guidance", async () => {
    const options = createPolicyOptions({
      launchKernel: vi.fn().mockResolvedValue({
        result: "environment_selection_rejected",
        error: "Conda environment directory does not exist or is inaccessible",
      } satisfies NotebookResponse),
    });
    const { result } = renderHook(() => useNotebookActionPolicy(options));

    await act(async () => {
      expect(await result.current.tryStartKernel()).toBe(false);
    });

    expect(result.current.trustActionNotice).toContain(
      "Conda environment directory does not exist or is inaccessible",
    );
    expect(result.current.trustActionNotice).toMatch(/review.*environment selection.*apply/i);
    expect(options.resetEnvProgress).not.toHaveBeenCalled();
  });

  it.each(["run_cell", "run_all", "restart_and_run_all"] as const)(
    "does not execute %s after kernel launch rejects the environment selection",
    async (action) => {
      const options = createPolicyOptions({
        launchKernel: vi.fn().mockResolvedValue({
          result: "environment_selection_rejected",
          error: "Conda environment has no accessible Python interpreter",
        } satisfies NotebookResponse),
      });
      const { result } = renderHook(() => useNotebookActionPolicy(options));

      await act(async () => {
        if (action === "run_cell") await result.current.handleExecuteCell("cell-1");
        else if (action === "run_all") await result.current.handleRunAllCells();
        else await result.current.handleRestartAndRunAll();
      });

      expect(options.launchKernel).toHaveBeenCalledTimes(1);
      expect(options.executeCell).not.toHaveBeenCalled();
      expect(options.runAllCells).not.toHaveBeenCalled();
      expect(result.current.trustActionNotice).toContain(
        "Conda environment has no accessible Python interpreter",
      );
    },
  );

  it.each(["start_kernel", "run_cell", "run_all", "approve_only"] as const)(
    "reports a rejected environment and stops the trust-approved %s launch handoff",
    async (action) => {
      const options = createPolicyOptions({
        checkTrust: vi.fn().mockResolvedValue({ status: "untrusted" }),
        launchKernel: vi.fn().mockResolvedValue({
          result: "environment_selection_rejected",
          error: "The directory is not a Conda environment (missing conda-meta)",
        } satisfies NotebookResponse),
      });
      const { result } = renderHook(() => useNotebookActionPolicy(options));

      await act(async () => {
        if (action === "run_cell") await result.current.handleExecuteCell("cell-1");
        else if (action === "run_all") await result.current.handleRunAllCells();
        else result.current.openTrustDialogForKernelStart();
      });
      await act(async () => {
        if (action === "approve_only") await result.current.handleTrustApproveOnly();
        else await result.current.handleTrustApprove();
      });

      expect(options.approveTrust).toHaveBeenCalledTimes(1);
      expect(options.launchKernel).toHaveBeenCalledTimes(1);
      expect(options.executeCellGuarded).not.toHaveBeenCalled();
      expect(options.runAllCellsGuarded).not.toHaveBeenCalled();
      expect(result.current.trustApprovalHandoffPending).toBe(false);
      expect(result.current.trustActionNotice).toContain(
        "The directory is not a Conda environment (missing conda-meta)",
      );
      expect(result.current.trustActionNotice).toMatch(/review.*environment selection.*apply/i);
    },
  );

  it.each([false, true])(
    "reports a rejected project-environment launch (joined auto-launch: %s)",
    async (joinedAutoLaunch) => {
      const launchKernel = vi.fn();
      if (joinedAutoLaunch) {
        launchKernel.mockResolvedValueOnce({
          result: "kernel_already_running",
          kernel_type: "python",
          env_source: "uv:prewarmed",
          launched_config: {},
        } satisfies NotebookResponse);
      }
      launchKernel.mockResolvedValue({
        result: "environment_selection_rejected",
        error: "Notebook runtime changed; review the Python environment selection again",
      } satisfies NotebookResponse);
      const options = createPolicyOptions({ launchKernel });
      const { result } = renderHook(() => useNotebookActionPolicy(options));

      await act(async () => {
        await result.current.handleStartKernelWithPyproject();
      });

      expect(launchKernel).toHaveBeenCalledTimes(joinedAutoLaunch ? 2 : 1);
      expect(result.current.trustActionNotice).toContain(
        "Notebook runtime changed; review the Python environment selection again",
      );
      expect(result.current.trustActionNotice).toMatch(/review.*environment selection.*apply/i);
    },
  );

  it("clears the trust-approved dependency-sync handoff when fallback launch rejects the selection", async () => {
    const options = createPolicyOptions({
      envSource: "uv:pyproject",
      checkTrust: vi
        .fn()
        .mockResolvedValueOnce({ status: "untrusted" })
        .mockResolvedValue({ status: "trusted" }),
      launchKernel: vi.fn().mockResolvedValue({
        result: "environment_selection_rejected",
        error: "Conda environment directory does not exist or is inaccessible",
      } satisfies NotebookResponse),
    });
    const { result } = renderHook(() => useNotebookActionPolicy(options));

    await act(async () => {
      await result.current.handleSyncDeps();
    });
    await act(async () => {
      await result.current.handleTrustApprove();
    });

    expect(options.launchKernel).toHaveBeenCalledTimes(1);
    expect(result.current.justSynced).toBe(false);
    expect(result.current.trustApprovalHandoffPending).toBe(false);
    expect(result.current.trustActionNotice).toContain(
      "Conda environment directory does not exist or is inaccessible",
    );
  });

  it("does not approve captured Apply trust against a replacement notebook connection", async () => {
    let generation = 1;
    const options = createPolicyOptions({
      applyEnvironmentSelection: vi.fn(),
      getEnvironmentConnectionGeneration: () => generation,
      checkTrust: vi.fn().mockResolvedValue({ status: "untrusted" }),
    });
    const { result } = renderHook(() => useNotebookActionPolicy(options));
    await act(async () => {
      await result.current.handleApplyEnvironment(2);
    });
    generation = 2;
    await act(async () => {
      expect(await result.current.handleTrustApprove()).toBe(false);
    });
    expect(options.approveTrust).not.toHaveBeenCalled();
    expect(options.applyEnvironmentSelection).not.toHaveBeenCalled();
    expect(result.current.trustActionNotice).toMatch(/connection changed/i);
  });

  it("opens captured review if trust changes between precheck and daemon Apply admission", async () => {
    const options = createPolicyOptions({
      applyEnvironmentSelection: vi.fn().mockResolvedValue({
        result: "guard_rejected",
        reason: "Notebook dependencies need approval",
      }),
      getEnvironmentConnectionGeneration: () => 5,
      checkTrust: vi
        .fn()
        .mockResolvedValueOnce({ status: "trusted" })
        .mockResolvedValue({ status: "untrusted" }),
    });
    const { result } = renderHook(() => useNotebookActionPolicy(options));
    await act(async () => {
      await result.current.handleApplyEnvironment(3);
    });
    expect(result.current.trustDialogOpen).toBe(true);
    expect(result.current.pendingTrustAction).toMatchObject({
      kind: "apply_environment",
      expectedRevision: 3,
      connectionGeneration: 5,
      provenance: { observed_heads: ["head-1"] },
    });
    expect(options.shutdownKernel).not.toHaveBeenCalled();
  });

  it("captures Apply revision and source heads through trust review without generic restart", async () => {
    const applyEnvironmentSelection = vi.fn().mockResolvedValue({
      result: "environment_selection",
      selection: { revision: 8, selected: null, applied: null, applying: false },
    });
    let heads = ["head-1"];
    const options = createPolicyOptions({
      getObservedHeads: () => heads,
      getEnvironmentConnectionGeneration: () => 10,
      applyEnvironmentSelection,
      checkTrust: vi.fn().mockResolvedValue({ status: "untrusted" }),
    });
    const { result } = renderHook(() => useNotebookActionPolicy(options));
    await act(async () => {
      await result.current.handleApplyEnvironment(6);
    });
    expect(applyEnvironmentSelection).not.toHaveBeenCalled();
    expect(result.current.pendingTrustAction).toMatchObject({
      kind: "apply_environment",
      expectedRevision: 6,
      connectionGeneration: 10,
      provenance: { observed_heads: ["head-1"] },
    });
    expect(result.current.trustApproveLabel).toBe("Trust and Apply");
    heads = ["head-2"];
    await act(async () => {
      await result.current.handleTrustApprove();
    });
    expect(options.approveTrust).toHaveBeenCalledWith({ observedHeads: ["head-1"] });
    expect(applyEnvironmentSelection).toHaveBeenCalledWith(6, ["head-1"], 10);
    expect(options.shutdownKernel).not.toHaveBeenCalled();
    expect(options.launchKernel).not.toHaveBeenCalled();
  });

  it("trust-only approval never applies an environment or launches a replacement kernel", async () => {
    const options = createPolicyOptions({
      applyEnvironmentSelection: vi.fn(),
      getEnvironmentConnectionGeneration: () => 1,
      checkTrust: vi.fn().mockResolvedValue({ status: "untrusted" }),
    });
    const { result } = renderHook(() => useNotebookActionPolicy(options));
    await act(async () => {
      await result.current.handleApplyEnvironment(2);
    });
    await act(async () => {
      await result.current.handleTrustApproveOnly();
    });
    expect(options.applyEnvironmentSelection).not.toHaveBeenCalled();
    expect(options.launchKernel).not.toHaveBeenCalled();
  });

  it("does not turn borrowed-environment dependency sync into a restart or installation", async () => {
    const options = createPolicyOptions({ envSource: "conda:existing:local" });
    const { result } = renderHook(() => useNotebookActionPolicy(options));
    await act(async () => {
      expect(await result.current.handleSyncDeps()).toBe(false);
    });
    expect(options.syncEnvironment).not.toHaveBeenCalled();
    expect(options.shutdownKernel).not.toHaveBeenCalled();
    expect(options.launchKernel).not.toHaveBeenCalled();
  });

  it("accepts another cell run as soon as the previous request settles", async () => {
    vi.useFakeTimers();
    try {
      const options = createPolicyOptions({ kernelStatus: KERNEL_STATUS.IDLE });
      const { result, unmount } = renderHook(() => useNotebookActionPolicy(options));

      await act(async () => {
        await result.current.handleExecuteCell("cell-1");
        await result.current.handleExecuteCell("cell-1");
        await result.current.handleExecuteCell("cell-1");
      });

      expect(options.executeCell).toHaveBeenCalledTimes(3);
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("suppresses overlapping requests for the same cell and releases the guard on failure", async () => {
    let rejectExecution!: (error: Error) => void;
    const execution = new Promise<NotebookResponse>((_resolve, reject) => {
      rejectExecution = reject;
    });
    const options = createPolicyOptions({
      kernelStatus: KERNEL_STATUS.IDLE,
      executeCell: vi
        .fn()
        .mockReturnValueOnce(execution)
        .mockResolvedValue(response("cell_queued")),
    });
    const { result } = renderHook(() => useNotebookActionPolicy(options));

    await act(async () => {
      const first = result.current.handleExecuteCell("cell-1");
      const failure = expect(first).rejects.toThrow("transport disconnected");
      await result.current.handleExecuteCell("cell-1");
      expect(options.executeCell).toHaveBeenCalledTimes(1);

      rejectExecution(new Error("transport disconnected"));
      await failure;
      await result.current.handleExecuteCell("cell-1");
    });

    expect(options.executeCell).toHaveBeenCalledTimes(2);
  });

  it("opens trust review instead of launching or executing when a cell run is untrusted", async () => {
    const options = createPolicyOptions({
      checkTrust: vi.fn().mockResolvedValue({ status: "untrusted" }),
    });
    const { result } = renderHook(() => useNotebookActionPolicy(options));

    await act(async () => {
      await result.current.handleExecuteCell("cell-1");
    });

    expect(options.launchKernel).not.toHaveBeenCalled();
    expect(options.executeCell).not.toHaveBeenCalled();
    expect(result.current.trustDialogOpen).toBe(true);
    expect(result.current.pendingTrustAction).toMatchObject({
      kind: "execute_cell",
      cellId: "cell-1",
      provenance: { observed_heads: ["head-1"] },
    });
    expect(result.current.trustApproveLabel).toBe("Trust and Run Cell");
  });

  it("keeps sync-deps blocked until trust approval supplies the captured guard", async () => {
    const options = createPolicyOptions({
      checkTrust: vi.fn().mockResolvedValue({ status: "untrusted" }),
    });
    const { result } = renderHook(() => useNotebookActionPolicy(options));

    await act(async () => {
      await result.current.handleSyncDeps();
    });

    expect(options.syncEnvironment).not.toHaveBeenCalled();
    expect(result.current.pendingTrustAction).toMatchObject({
      kind: "sync_deps",
      provenance: { observed_heads: ["head-1"] },
    });

    await act(async () => {
      await result.current.handleTrustApprove();
    });

    expect(options.approveTrust).toHaveBeenCalledWith({ observedHeads: ["head-1"] });
    expect(options.syncEnvironment).toHaveBeenCalledWith({ observed_heads: ["head-1"] });
  });

  it("clears dismissed env-build details before creating an environment", async () => {
    const events: string[] = [];
    const options = createPolicyOptions({
      resetDismissedEnvBuildDetails: vi.fn(() => events.push("reset-dismissed")),
      approveProjectEnvironment: vi.fn(async () => {
        events.push("approve-environment");
        return response("ok");
      }),
    });
    const { result } = renderHook(() => useNotebookActionPolicy(options));

    await act(async () => {
      await result.current.handleEnvBuildCreate();
    });

    expect(options.resetDismissedEnvBuildDetails).toHaveBeenCalledTimes(1);
    expect(events.slice(0, 2)).toEqual(["reset-dismissed", "approve-environment"]);
    expect(options.showEnvBuildDialog).not.toHaveBeenCalled();
  });

  it("shuts down before switching a running kernel to the project environment", async () => {
    const events: string[] = [];
    const options = createPolicyOptions({
      shutdownKernel: vi.fn(async () => {
        events.push("shutdown");
        return response("kernel_shutting_down");
      }),
      launchKernel: vi.fn(async () => {
        events.push("launch-project");
        return response("kernel_launched");
      }),
    });
    const { result } = renderHook(() => useNotebookActionPolicy(options));

    await act(async () => {
      await result.current.handleStartKernelWithPyproject();
    });

    expect(events).toEqual(["shutdown", "launch-project"]);
    expect(options.launchKernel).toHaveBeenCalledWith("python", "uv:pyproject");
  });

  it("retries the project switch when it first joins a different auto-launched environment", async () => {
    const events: string[] = [];
    const options = createPolicyOptions({
      shutdownKernel: vi.fn(async () => {
        events.push("shutdown");
        return response("kernel_shutting_down");
      }),
      launchKernel: vi
        .fn()
        .mockImplementationOnce(async () => {
          events.push("join-auto");
          return {
            result: "kernel_already_running",
            kernel_type: "python",
            env_source: "uv:prewarmed",
            launched_config: {},
          } as NotebookResponse;
        })
        .mockImplementationOnce(async () => {
          events.push("launch-project");
          return response("kernel_launched");
        }),
    });
    const { result } = renderHook(() => useNotebookActionPolicy(options));

    await act(async () => {
      await result.current.handleStartKernelWithPyproject();
    });

    expect(events).toEqual(["shutdown", "join-auto", "shutdown", "launch-project"]);
  });
});
