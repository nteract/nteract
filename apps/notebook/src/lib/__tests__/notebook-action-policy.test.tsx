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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => { resolve = finish; });
  return { promise, resolve };
}

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
    approveProjectTrust: vi.fn().mockResolvedValue(response("ok")),
    declineProjectTrust: vi.fn().mockResolvedValue(response("ok")),
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
    showProjectTrustDialog: vi.fn(),
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
  it.each(["uv:inline", "conda:inline"])(
    "preserves the %s kernel when another client's sync is still in progress",
    async (envSource) => {
      const options = createPolicyOptions({
        envSource,
        kernelStatus: KERNEL_STATUS.IDLE,
        syncEnvironment: vi.fn().mockResolvedValue({
          result: "sync_environment_failed",
          error: "Environment sync in progress; retry after it completes",
          needs_restart: false,
        } satisfies NotebookResponse),
      });
      const { result } = renderHook(() => useNotebookActionPolicy(options));

      await act(async () => {
        expect(await result.current.handleSyncDeps()).toBe(false);
      });

      expect(options.syncEnvironment).toHaveBeenCalledTimes(1);
      expect(options.shutdownKernel).not.toHaveBeenCalled();
      expect(options.launchKernel).not.toHaveBeenCalled();
      expect(result.current.justSynced).toBe(false);
    },
  );

  it("still restarts when hot-sync explicitly requires a restart", async () => {
    const events: string[] = [];
    const options = createPolicyOptions({
      kernelStatus: KERNEL_STATUS.IDLE,
      syncEnvironment: vi.fn().mockResolvedValue({
        result: "sync_environment_failed",
        error: "Environment changes require a kernel restart",
        needs_restart: true,
      } satisfies NotebookResponse),
      shutdownKernel: vi.fn(async () => {
        events.push("shutdown");
        return response("kernel_shutting_down");
      }),
      launchKernel: vi.fn(async () => {
        events.push("launch");
        return response("kernel_launched");
      }),
    });
    const { result } = renderHook(() => useNotebookActionPolicy(options));

    await act(async () => {
      expect(await result.current.handleSyncDeps()).toBe(true);
    });

    expect(options.syncEnvironment).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["shutdown", "launch"]);
    expect(result.current.justSynced).toBe(true);
  });

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

  it("guards plain trust approval with the heads shown when the dialog opened", async () => {
    const options = createPolicyOptions();
    const { result } = renderHook(() => useNotebookActionPolicy(options));

    act(() => result.current.openTrustDialogForKernelStart());
    await act(async () => {
      await result.current.handleTrustApproveOnly();
    });

    expect(options.approveTrust).toHaveBeenCalledWith({ observedHeads: ["head-1"] });
  });

  it("guards direct kernel-start trust dialogs with the displayed heads", async () => {
    const options = createPolicyOptions({
      checkTrust: vi.fn().mockResolvedValue({ status: "untrusted" }),
    });
    const { result } = renderHook(() => useNotebookActionPolicy(options));

    await act(async () => {
      await result.current.tryStartKernel();
    });
    await act(async () => {
      await result.current.handleTrustApproveOnly();
    });

    expect(options.approveTrust).toHaveBeenCalledWith({ observedHeads: ["head-1"] });
  });

  it.each(["handleTrustApprove", "handleTrustApproveOnly"] as const)(
    "keeps missing review provenance guarded in %s",
    async (approve) => {
      let heads: string[] = [];
      const options = createPolicyOptions({
        getObservedHeads: () => heads,
        approveTrust: vi.fn().mockResolvedValue(false),
      });
      const { result } = renderHook(() => useNotebookActionPolicy(options));

      act(() => result.current.openTrustDialogForKernelStart());
      heads = ["head-arrived-after-dialog-opened"];
      await act(async () => {
        expect(await result.current[approve]()).toBe(false);
      });

      // The daemon rejects empty heads. Omitting them would instead approve
      // current dependencies without verifying the reviewed snapshot.
      expect(options.approveTrust).toHaveBeenCalledWith({ observedHeads: [] });
      expect(options.launchKernel).not.toHaveBeenCalled();
      expect(result.current.trustApprovalHandoffPending).toBe(false);
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

  it("launches the kernel after the project folder is trusted", async () => {
    const events: string[] = [];
    const options = createPolicyOptions({
      kernelStatus: KERNEL_STATUS.AWAITING_PROJECT_TRUST,
      approveProjectTrust: vi.fn(async () => {
        events.push("approve-project-trust");
        return response("ok");
      }),
      launchKernel: vi.fn(async () => {
        events.push("launch");
        return response("kernel_launched");
      }),
    });
    const { result } = renderHook(() => useNotebookActionPolicy(options));

    let approved = false;
    await act(async () => {
      approved = await result.current.handleProjectTrustApprove("/work/repo");
    });

    expect(approved).toBe(true);
    expect(options.approveProjectTrust).toHaveBeenCalledWith("/work/repo");
    expect(events).toEqual(["approve-project-trust", "launch"]);
    expect(options.launchKernel).toHaveBeenCalledWith("auto", "auto");
    expect(result.current.projectTrustError).toBeNull();
    expect(result.current.projectTrustBusy).toBe(false);
  });

  it("keeps the daemon error and skips launch when project trust is rejected", async () => {
    const options = createPolicyOptions({
      kernelStatus: KERNEL_STATUS.AWAITING_PROJECT_TRUST,
      approveProjectTrust: vi
        .fn()
        .mockResolvedValue({ result: "error", error: "directory does not exist" }),
    });
    const { result } = renderHook(() => useNotebookActionPolicy(options));

    let approved = true;
    await act(async () => {
      approved = await result.current.handleProjectTrustApprove("/work/proj");
    });

    expect(approved).toBe(false);
    expect(options.launchKernel).not.toHaveBeenCalled();
    expect(result.current.projectTrustError).toBe("directory does not exist");

    act(() => {
      result.current.clearProjectTrustError();
    });
    expect(result.current.projectTrustError).toBeNull();
  });

  it("launches the kernel after choosing the notebook environment", async () => {
    const events: string[] = [];
    const options = createPolicyOptions({
      kernelStatus: KERNEL_STATUS.AWAITING_PROJECT_TRUST,
      declineProjectTrust: vi.fn(async () => {
        events.push("decline-project-trust");
        return response("ok");
      }),
      launchKernel: vi.fn(async () => {
        events.push("launch");
        return response("kernel_launched");
      }),
    });
    const { result } = renderHook(() => useNotebookActionPolicy(options));

    await act(async () => {
      await result.current.handleProjectTrustUseNotebookEnv("/work/proj", true);
    });

    expect(options.declineProjectTrust).toHaveBeenCalledWith("/work/proj", true);
    expect(events).toEqual(["decline-project-trust", "launch"]);
  });

  it("opens project trust review instead of launching on run-all", async () => {
    const options = createPolicyOptions({ kernelStatus: KERNEL_STATUS.AWAITING_PROJECT_TRUST });
    const { result } = renderHook(() => useNotebookActionPolicy(options));

    await act(async () => {
      await result.current.handleRunAllCells();
    });

    expect(options.showProjectTrustDialog).toHaveBeenCalledTimes(1);
    expect(options.showEnvBuildDialog).not.toHaveBeenCalled();
    expect(options.launchKernel).not.toHaveBeenCalled();
    expect(options.runAllCells).not.toHaveBeenCalled();
  });

  it("reopens unchanged project review for each fresh Start, Run Cell, and Run All intent", async () => {
    const options = createPolicyOptions({ kernelStatus: KERNEL_STATUS.AWAITING_PROJECT_TRUST });
    const { result } = renderHook(() => useNotebookActionPolicy(options));

    await act(async () => {
      await result.current.handleStartKernel("python");
      result.current.clearProjectTrustError();
      await result.current.handleStartKernel("python");
      result.current.clearProjectTrustError();
      await result.current.handleExecuteCell("cell-1");
      result.current.clearProjectTrustError();
      await result.current.handleRunAllCells();
    });

    expect(options.showProjectTrustDialog).toHaveBeenCalledTimes(4);
    expect(options.launchKernel).not.toHaveBeenCalled();
    expect(options.executeCell).not.toHaveBeenCalled();
    expect(options.runAllCells).not.toHaveBeenCalled();
    await act(async () => {
      await result.current.handleProjectTrustApprove("/work/current-project");
    });
    expect(options.runAllCellsGuarded).toHaveBeenCalledExactlyOnceWith({ observed_heads: ["head-1"] });
    expect(options.executeCellGuarded).not.toHaveBeenCalled();
  });

  it("opens project trust review instead of launching or executing a cell", async () => {
    const options = createPolicyOptions({ kernelStatus: KERNEL_STATUS.AWAITING_PROJECT_TRUST });
    const { result } = renderHook(() => useNotebookActionPolicy(options));

    await act(async () => {
      await result.current.handleExecuteCell("cell-1");
    });

    expect(options.showProjectTrustDialog).toHaveBeenCalledTimes(1);
    expect(options.launchKernel).not.toHaveBeenCalled();
    expect(options.executeCell).not.toHaveBeenCalled();
  });

  it.each(["approve", "notebook"] as const)(
    "resumes a pending cell with captured heads after project %s",
    async (decision) => {
      let heads = ["reviewed-head"];
      const options = createPolicyOptions({
        kernelStatus: KERNEL_STATUS.AWAITING_PROJECT_TRUST,
        getObservedHeads: () => heads,
      });
      const { result } = renderHook(() => useNotebookActionPolicy(options));
      await act(async () => { await result.current.handleExecuteCell("cell-1"); });
      heads = ["edited-head"];
      await act(async () => {
        if (decision === "approve") await result.current.handleProjectTrustApprove("/work/proj");
        else await result.current.handleProjectTrustUseNotebookEnv("/work/proj", false);
      });
      expect(options.executeCellGuarded).toHaveBeenCalledExactlyOnceWith("cell-1", { observed_heads: ["reviewed-head"] });
      expect(options.executeCell).not.toHaveBeenCalled();
    },
  );

  it("resumes Run All through its provenance guard after project approval", async () => {
    const options = createPolicyOptions({ kernelStatus: KERNEL_STATUS.AWAITING_PROJECT_TRUST });
    const { result } = renderHook(() => useNotebookActionPolicy(options));
    await act(async () => { await result.current.handleRunAllCells(); });
    await act(async () => { await result.current.handleProjectTrustApprove("/work/proj"); });
    expect(options.runAllCellsGuarded).toHaveBeenCalledExactlyOnceWith({ observed_heads: ["head-1"] });
    expect(options.runAllCells).not.toHaveBeenCalled();
  });

  it("retains a run when the first launch discovers project trust is required", async () => {
    const options = createPolicyOptions({
      launchKernel: vi.fn()
        .mockResolvedValueOnce({ result: "error", error: "Project folder needs approval" })
        .mockResolvedValueOnce(response("kernel_launched")),
    });
    const { result } = renderHook(() => useNotebookActionPolicy(options));
    await act(async () => { await result.current.handleExecuteCell("cell-1"); });
    await act(async () => { await result.current.handleProjectTrustApprove("/work/proj"); });
    expect(options.executeCellGuarded).toHaveBeenCalledExactlyOnceWith("cell-1", { observed_heads: ["head-1"] });
    expect(options.executeCell).not.toHaveBeenCalled();
  });

  describe("launch notices after notebook and project trust review", () => {
    const projectTrustMessage =
      "The project folder is not trusted on this machine. Trust it or use the notebook environment to launch.";

    async function renderBlockedLaunch(kind: "cell" | "all" = "cell") {
      const options = createPolicyOptions({
        checkTrust: vi.fn()
          .mockResolvedValueOnce({ status: "untrusted" })
          .mockResolvedValue({ status: "trusted" }),
        launchKernel: vi.fn()
          .mockResolvedValueOnce({ result: "error", error: projectTrustMessage })
          .mockResolvedValue(response("kernel_launched")),
      });
      const hook = renderHook(() => useNotebookActionPolicy(options));
      await act(async () => {
        if (kind === "cell") await hook.result.current.handleExecuteCell("cell-1");
        else await hook.result.current.handleRunAllCells();
      });
      expect(options.launchKernel).not.toHaveBeenCalled();
      expect(hook.result.current.trustDialogOpen).toBe(true);
      await act(async () => { await hook.result.current.handleTrustApprove(); });
      expect(options.approveTrust).toHaveBeenCalledExactlyOnceWith({ observedHeads: ["head-1"] });
      expect(options.executeCellGuarded).not.toHaveBeenCalled();
      expect(options.runAllCellsGuarded).not.toHaveBeenCalled();
      expect(hook.result.current.trustActionNotice).toBe(projectTrustMessage);
      return { ...hook, options };
    }

    it.each(
      (["approve", "notebook"] as const).flatMap((decision) =>
        (["cell", "all"] as const).map((kind) => ({ decision, kind })),
      ),
    )("clears the resolved launch notice after $decision and replays $kind once", async ({ decision, kind }) => {
      const { result, options } = await renderBlockedLaunch(kind);
      await act(async () => {
        if (decision === "approve") await result.current.handleProjectTrustApprove("/work/proj");
        else await result.current.handleProjectTrustUseNotebookEnv("/work/proj", false);
      });
      expect(result.current.trustActionNotice).toBeNull();
      expect(options.launchKernel).toHaveBeenCalledTimes(2);
      if (kind === "cell") expect(options.executeCellGuarded).toHaveBeenCalledExactlyOnceWith("cell-1", { observed_heads: ["head-1"] });
      else expect(options.runAllCellsGuarded).toHaveBeenCalledExactlyOnceWith({ observed_heads: ["head-1"] });
      expect(options.executeCell).not.toHaveBeenCalled();
      expect(options.runAllCells).not.toHaveBeenCalled();
      if (decision === "notebook") {
        expect(options.declineProjectTrust).toHaveBeenCalledExactlyOnceWith("/work/proj", false);
        expect(options.approveProjectTrust).not.toHaveBeenCalled();
      }
    });

    it("preserves an unrelated notice already visible when project recovery begins", async () => {
      const { result } = await renderBlockedLaunch();
      act(() => result.current.setTrustActionNotice("Environment selection changed"));
      await act(async () => { await result.current.handleProjectTrustUseNotebookEnv("/work/proj", false); });
      expect(result.current.trustActionNotice).toBe("Environment selection changed");
    });

    it("does not clear an earlier launch's notice when a different run recovers", async () => {
      const { result, options, rerender } = await renderBlockedLaunch();
      options.kernelStatus = KERNEL_STATUS.AWAITING_PROJECT_TRUST;
      rerender();
      await act(async () => { await result.current.handleExecuteCell("cell-1"); });
      await act(async () => { await result.current.handleProjectTrustUseNotebookEnv("/work/proj", false); });
      expect(result.current.trustActionNotice).toBe(projectTrustMessage);
      expect(options.executeCellGuarded).toHaveBeenCalledTimes(1);
    });

    it.each(["New failure", projectTrustMessage])("preserves a newer notice during launch: %s", async (newMessage) => {
      const { result, options } = await renderBlockedLaunch();
      const launch = deferred<NotebookResponse>();
      const reached = deferred<void>();
      vi.mocked(options.launchKernel).mockImplementationOnce(() => { reached.resolve(); return launch.promise; });
      let operation!: Promise<boolean>;
      await act(async () => {
        operation = result.current.handleProjectTrustUseNotebookEnv("/work/proj", false);
        await reached.promise;
      });
      act(() => result.current.setTrustActionNotice(newMessage));
      await act(async () => { launch.resolve(response("kernel_launched")); await operation; });
      expect(result.current.trustActionNotice).toBe(newMessage);
    });

    it.each(["request", "launch"] as const)("keeps the blocked-launch notice when recovery fails at %s", async (stage) => {
      const { result, options } = await renderBlockedLaunch();
      vi.mocked(stage === "request" ? options.declineProjectTrust : options.launchKernel)
        .mockResolvedValueOnce({ result: "error", error: "Recovery failed" });
      await act(async () => { await result.current.handleProjectTrustUseNotebookEnv("/work/proj", false); });
      expect(result.current.trustActionNotice).toBe(projectTrustMessage);
      expect(options.executeCellGuarded).not.toHaveBeenCalled();
      if (stage === "request") expect(result.current.projectTrustError).toBe("Recovery failed");
    });

    it.each([
      { result: "guard_rejected", reason: "Cell changed during review" },
      { result: "error", error: "Execution failed" },
    ] satisfies NotebookResponse[])("preserves a new $result notice from guarded replay", async (failure) => {
      const { result, options } = await renderBlockedLaunch();
      vi.mocked(options.executeCellGuarded).mockResolvedValueOnce(failure);
      await act(async () => { await result.current.handleProjectTrustUseNotebookEnv("/work/proj", false); });
      expect(result.current.trustActionNotice).toBe("reason" in failure ? failure.reason : failure.error);
      expect(options.executeCellGuarded).toHaveBeenCalledTimes(1);
      expect(options.executeCell).not.toHaveBeenCalled();
    });
  });

  it("carries a project-blocked run through a second notebook-dependency approval", async () => {
    const options = createPolicyOptions({
      kernelStatus: KERNEL_STATUS.AWAITING_PROJECT_TRUST,
      checkTrust: vi.fn().mockResolvedValue({ status: "untrusted" }),
    });
    const { result } = renderHook(() => useNotebookActionPolicy(options));
    await act(async () => { await result.current.handleExecuteCell("cell-1"); });
    await act(async () => { await result.current.handleProjectTrustApprove("/work/proj"); });
    expect(result.current.trustDialogOpen).toBe(true);
    expect(options.executeCellGuarded).not.toHaveBeenCalled();
    await act(async () => { await result.current.handleTrustApprove(); });
    expect(options.approveTrust).toHaveBeenCalledWith({ observedHeads: ["head-1"] });
    expect(options.executeCellGuarded).toHaveBeenCalledExactlyOnceWith("cell-1", { observed_heads: ["head-1"] });
  });

  it("shows stale-run rejection without replaying unguarded code", async () => {
    const options = createPolicyOptions({
      kernelStatus: KERNEL_STATUS.AWAITING_PROJECT_TRUST,
      executeCellGuarded: vi.fn().mockResolvedValue({ result: "guard_rejected", reason: "Cell changed while reviewing trust" }),
    });
    const { result } = renderHook(() => useNotebookActionPolicy(options));
    await act(async () => { await result.current.handleExecuteCell("cell-1"); });
    await act(async () => { await result.current.handleProjectTrustApprove("/work/proj"); });
    expect(result.current.trustActionNotice).toBe("Cell changed while reviewing trust");
    expect(options.executeCell).not.toHaveBeenCalled();
  });

  it("does not submit duplicate approvals or replay the pending run twice", async () => {
    let finish!: (value: NotebookResponse) => void;
    const options = createPolicyOptions({
      kernelStatus: KERNEL_STATUS.AWAITING_PROJECT_TRUST,
      approveProjectTrust: vi.fn(() => new Promise<NotebookResponse>((resolve) => { finish = resolve; })),
    });
    const { result } = renderHook(() => useNotebookActionPolicy(options));
    await act(async () => { await result.current.handleExecuteCell("cell-1"); });
    await act(async () => {
      const first = result.current.handleProjectTrustApprove("/work/proj");
      expect(await result.current.handleProjectTrustApprove("/work/proj")).toBe(false);
      finish(response("ok"));
      await first;
    });
    expect(options.approveProjectTrust).toHaveBeenCalledTimes(1);
    expect(options.executeCellGuarded).toHaveBeenCalledTimes(1);
  });

  it("does not replay a run from a dismissed project prompt", async () => {
    const options = createPolicyOptions({ kernelStatus: KERNEL_STATUS.AWAITING_PROJECT_TRUST });
    const { result } = renderHook(() => useNotebookActionPolicy(options));
    await act(async () => { await result.current.handleExecuteCell("cell-1"); });
    act(() => result.current.clearProjectTrustError());
    await act(async () => { await result.current.handleProjectTrustApprove("/work/proj"); });
    expect(options.executeCellGuarded).not.toHaveBeenCalled();
    expect(options.executeCell).not.toHaveBeenCalled();
  });

  it.each(
    (["approve", "notebook"] as const).flatMap((decision) =>
      (["request", "check", "launch"] as const).flatMap((stage) =>
        (["cell", "all"] as const).map((kind) => ({ decision, stage, kind })),
      ),
    ),
  )("does not resume dismissed $decision $kind intent during $stage", async ({ decision, stage, kind }) => {
    const reached = deferred<void>();
    const request = deferred<NotebookResponse>();
    const check = deferred<{ status: string }>();
    const launch = deferred<NotebookResponse>();
    let heads = ["cancelled-head"];
    const options = createPolicyOptions({
      kernelStatus: KERNEL_STATUS.AWAITING_PROJECT_TRUST,
      getObservedHeads: () => heads,
    });
    const requestMock = vi.mocked(decision === "approve" ? options.approveProjectTrust : options.declineProjectTrust);
    if (stage === "request") requestMock.mockImplementationOnce(() => { reached.resolve(); return request.promise; });
    if (stage === "check") vi.mocked(options.checkTrust).mockImplementationOnce(() => { reached.resolve(); return check.promise; });
    if (stage === "launch") vi.mocked(options.launchKernel).mockImplementationOnce(() => { reached.resolve(); return launch.promise; });
    const { result } = renderHook(() => useNotebookActionPolicy(options));
    const run = () => kind === "cell" ? result.current.handleExecuteCell("cell-1") : result.current.handleRunAllCells();
    const decide = () => decision === "approve"
      ? result.current.handleProjectTrustApprove("/work/proj")
      : result.current.handleProjectTrustUseNotebookEnv("/work/proj", false);
    await act(async () => { await run(); });
    let operation!: Promise<boolean>;
    await act(async () => { operation = decide(); await reached.promise; });
    act(() => result.current.clearProjectTrustError());
    await act(async () => {
      request.resolve(response("ok"));
      check.resolve({ status: "trusted" });
      launch.resolve(response("kernel_launched"));
      expect(await operation).toBe(false);
    });
    expect(result.current.pendingTrustAction).toBeNull();
    expect(result.current.trustDialogOpen).toBe(false);
    expect(options.executeCellGuarded).not.toHaveBeenCalled();
    expect(options.runAllCellsGuarded).not.toHaveBeenCalled();
    expect(options.launchKernel).toHaveBeenCalledTimes(stage === "launch" ? 1 : 0);

    heads = ["fresh-head"];
    await act(async () => { await run(); await decide(); });
    if (kind === "cell") expect(options.executeCellGuarded).toHaveBeenCalledExactlyOnceWith("cell-1", { observed_heads: ["fresh-head"] });
    else expect(options.runAllCellsGuarded).toHaveBeenCalledExactlyOnceWith({ observed_heads: ["fresh-head"] });
    expect(options.executeCell).not.toHaveBeenCalled();
    expect(options.runAllCells).not.toHaveBeenCalled();
  });

  it("does not open package approval when a dismissed project trust check returns untrusted", async () => {
    const check = deferred<{ status: string }>();
    const reached = deferred<void>();
    const options = createPolicyOptions({
      kernelStatus: KERNEL_STATUS.AWAITING_PROJECT_TRUST,
      checkTrust: vi.fn(() => { reached.resolve(); return check.promise; }),
    });
    const { result } = renderHook(() => useNotebookActionPolicy(options));
    await act(async () => { await result.current.handleExecuteCell("cell-1"); });
    let operation!: Promise<boolean>;
    await act(async () => { operation = result.current.handleProjectTrustApprove("/work/proj"); await reached.promise; });
    act(() => result.current.clearProjectTrustError());
    await act(async () => { check.resolve({ status: "untrusted" }); await operation; });
    expect(result.current.pendingTrustAction).toBeNull();
    expect(result.current.trustDialogOpen).toBe(false);
    expect(options.launchKernel).not.toHaveBeenCalled();
  });

  it("a stale project completion cannot clear or replay a newer pending approval", async () => {
    const oldLaunch = deferred<NotebookResponse>();
    const launchReached = deferred<void>();
    const newApproval = deferred<NotebookResponse>();
    const approvalReached = deferred<void>();
    let heads = ["old-head"];
    const options = createPolicyOptions({
      kernelStatus: KERNEL_STATUS.AWAITING_PROJECT_TRUST,
      getObservedHeads: () => heads,
      launchKernel: vi.fn().mockImplementationOnce(() => { launchReached.resolve(); return oldLaunch.promise; }).mockResolvedValue(response("kernel_launched")),
      approveProjectTrust: vi.fn().mockResolvedValueOnce(response("ok")).mockImplementationOnce(() => { approvalReached.resolve(); return newApproval.promise; }),
    });
    const { result } = renderHook(() => useNotebookActionPolicy(options));
    await act(async () => { await result.current.handleExecuteCell("cell-1"); });
    let oldOperation!: Promise<boolean>;
    await act(async () => { oldOperation = result.current.handleProjectTrustApprove("/work/proj"); await launchReached.promise; });
    act(() => result.current.clearProjectTrustError());
    heads = ["new-head"];
    await act(async () => { await result.current.handleRunAllCells(); });
    let newOperation!: Promise<boolean>;
    await act(async () => {
      newOperation = result.current.handleProjectTrustApprove("/work/proj");
      // If an old in-flight request blocks fresh consent, fail instead of hanging.
      await Promise.race([approvalReached.promise, newOperation]);
    });
    expect(options.approveProjectTrust).toHaveBeenCalledTimes(2);
    await act(async () => { oldLaunch.resolve(response("kernel_launched")); expect(await oldOperation).toBe(false); });
    expect(result.current.projectTrustBusy).toBe(true);
    expect(result.current.pendingTrustAction).toMatchObject({ kind: "run_all", provenance: { observed_heads: ["new-head"] } });
    expect(options.executeCellGuarded).not.toHaveBeenCalled();
    expect(options.runAllCellsGuarded).not.toHaveBeenCalled();
    await act(async () => { newApproval.resolve(response("ok")); expect(await newOperation).toBe(true); });
    expect(options.runAllCellsGuarded).toHaveBeenCalledExactlyOnceWith({ observed_heads: ["new-head"] });
  });

  it("preserves a replacement run intent when the previous project startup finishes", async () => {
    const launch = deferred<NotebookResponse>();
    const reached = deferred<void>();
    let heads = ["old-head"];
    const options = createPolicyOptions({
      kernelStatus: KERNEL_STATUS.AWAITING_PROJECT_TRUST,
      getObservedHeads: () => heads,
      launchKernel: vi.fn().mockImplementationOnce(() => { reached.resolve(); return launch.promise; }).mockResolvedValue(response("kernel_launched")),
    });
    const { result } = renderHook(() => useNotebookActionPolicy(options));
    await act(async () => { await result.current.handleExecuteCell("cell-1"); });
    let operation!: Promise<boolean>;
    await act(async () => { operation = result.current.handleProjectTrustApprove("/work/proj"); await reached.promise; });
    heads = ["new-head"];
    await act(async () => { await result.current.handleRunAllCells(); });
    await act(async () => { launch.resolve(response("kernel_launched")); expect(await operation).toBe(false); });
    expect(result.current.pendingTrustAction).toMatchObject({ kind: "run_all", provenance: { observed_heads: ["new-head"] } });
    expect(options.executeCellGuarded).not.toHaveBeenCalled();
    expect(options.runAllCellsGuarded).not.toHaveBeenCalled();
    await act(async () => { await result.current.handleProjectTrustApprove("/work/proj"); });
    expect(options.runAllCellsGuarded).toHaveBeenCalledExactlyOnceWith({ observed_heads: ["new-head"] });
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
