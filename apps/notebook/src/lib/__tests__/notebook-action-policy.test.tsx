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
    expect(
      isLaunchErrorHandledByRuntimeBanner("environment.yml declares conda env named x"),
    ).toBe(true);
    expect(isLaunchErrorHandledByRuntimeBanner("kernel crashed")).toBe(false);
  });
});

describe("useNotebookActionPolicy", () => {
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
});
