import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { readOnlyNotebookShellCapabilities, type NotebookShellCapabilities } from "runtimed";

import type { CloudPrototypeAuthState } from "../collaborator-auth";

// The pairing state machine lives in React wiring — mint, a 2s status poll
// with abort/dispose interplay, a client-driven expiry flip, and display-name
// resolution against the registry. These tests render the REAL hook with the
// workstations client mocked, following use-sustained-reconnecting.test.tsx.
const clientMocks = vi.hoisted(() => ({
  fetchCloudWorkstations: vi.fn(),
  fetchCloudWorkstationPairingStatus: vi.fn(),
  mintCloudWorkstationPairingCode: vi.fn(),
  requestCloudWorkstationAttachment: vi.fn(),
  setCloudDefaultWorkstation: vi.fn(),
}));

vi.mock("../workstations-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../workstations-client")>();
  return { ...actual, ...clientMocks };
});

import { useCloudWorkstationManager } from "../use-cloud-workstations";

const ownerCloudCapabilities: NotebookShellCapabilities = {
  ...readOnlyNotebookShellCapabilities,
  access: {
    ...readOnlyNotebookShellCapabilities.access,
    level: "owner",
    source: "cloud",
  },
  auth: {
    ...readOnlyNotebookShellCapabilities.auth,
    canUseAuthenticatedIdentity: true,
  },
};

const devAuth: CloudPrototypeAuthState = {
  mode: "dev",
  token: "dev-secret",
  user: "alice",
  oidcClaims: null,
  requestedScope: "owner",
  problem: null,
};

const config = {
  workstationsEndpoint: "/api/workstations",
  workstationDefaultEndpoint: "/api/workstations/default",
  workstationAttachEndpoint: "/api/n/nb-1/workstation-attachments",
};

function renderManager() {
  return renderHook(() =>
    useCloudWorkstationManager({
      config,
      authState: devAuth,
      capabilities: ownerCloudCapabilities,
      canLoadCloudWorkstations: true,
      workstationAttachment: null,
      panelIsOpen: false,
      onOpenWorkstationsRail: vi.fn(),
    }),
  );
}

const lab2Workstation = {
  id: "ws-lab2",
  displayName: "Lab2",
  provider: "runtime_peer",
  providerLabel: null,
  status: "online" as const,
  statusMessage: null,
  defaultEnvironmentLabel: "Current Python",
  environmentPolicy: "current_python",
  workingDirectory: "/home/ubuntu/project",
  cpuCount: 8,
  memoryBytes: 16_000_000_000,
  updatedAt: null,
  environments: [],
};

const futureIso = (ms: number) => new Date(Date.now() + ms).toISOString();

describe("useCloudWorkstationManager pairing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clientMocks.fetchCloudWorkstations.mockResolvedValue({
      defaultWorkstationId: null,
      workstations: [],
    });
    clientMocks.fetchCloudWorkstationPairingStatus.mockResolvedValue({
      status: "pending",
      expiresAt: null,
      workstationId: null,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("starts a pending pairing with the connect command built from the origin", async () => {
    clientMocks.mintCloudWorkstationPairingCode.mockResolvedValue({
      id: "pair-1",
      code: "ABCD-EFGH-JKMN",
      expiresAt: futureIso(10 * 60_000),
    });
    const { result } = renderManager();

    await act(async () => {
      await result.current.onStartPairing?.();
    });

    const pairing = result.current.workstationPairing;
    expect(pairing?.status).toBe("pending");
    expect(pairing?.code).toBe("ABCD-EFGH-JKMN");
    expect(pairing?.connectCommand).toBe(
      `runt workstation connect ${window.location.origin} --code ABCD-EFGH-JKMN && runt workstation run`,
    );
  });

  it("surfaces mint failure as an expired pairing and never polls", async () => {
    clientMocks.mintCloudWorkstationPairingCode.mockRejectedValue(
      new Error("sign in to add a workstation"),
    );
    const { result } = renderManager();

    await act(async () => {
      await result.current.onStartPairing?.();
    });

    expect(result.current.workstationPairing?.status).toBe("expired");
    expect(result.current.workstationPairing?.error).toBe("sign in to add a workstation");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(clientMocks.fetchCloudWorkstationPairingStatus).not.toHaveBeenCalled();
  });

  it("polls through redeemed to registered, refreshes the registry, and stops", async () => {
    clientMocks.mintCloudWorkstationPairingCode.mockResolvedValue({
      id: "pair-1",
      code: "ABCD-EFGH-JKMN",
      expiresAt: futureIso(10 * 60_000),
    });
    clientMocks.fetchCloudWorkstationPairingStatus
      .mockResolvedValueOnce({ status: "redeemed", expiresAt: null, workstationId: null })
      .mockResolvedValueOnce({ status: "registered", expiresAt: null, workstationId: "ws-hub" });
    const { result } = renderManager();

    await act(async () => {
      await result.current.onStartPairing?.();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(result.current.workstationPairing?.status).toBe("redeemed");

    const refreshesBeforeRegistered = clientMocks.fetchCloudWorkstations.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(result.current.workstationPairing?.status).toBe("registered");
    expect(result.current.workstationPairing?.workstationId).toBe("ws-hub");
    expect(clientMocks.fetchCloudWorkstations.mock.calls.length).toBeGreaterThan(
      refreshesBeforeRegistered,
    );

    // Terminal status: no further status polls get scheduled (stay under the
    // 10s registry-refresh interval so it cannot confound the count).
    const statusCalls = clientMocks.fetchCloudWorkstationPairingStatus.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });
    expect(clientMocks.fetchCloudWorkstationPairingStatus.mock.calls.length).toBe(statusCalls);
  });

  it("aborts the in-flight status poll on unmount", async () => {
    clientMocks.mintCloudWorkstationPairingCode.mockResolvedValue({
      id: "pair-1",
      code: "ABCD-EFGH-JKMN",
      expiresAt: futureIso(10 * 60_000),
    });
    let capturedSignal: AbortSignal | undefined;
    clientMocks.fetchCloudWorkstationPairingStatus.mockImplementation(
      (_endpoint: string, _auth: unknown, _id: string, signal?: AbortSignal) => {
        capturedSignal = signal;
        return new Promise(() => {});
      },
    );
    const { result, unmount } = renderManager();

    await act(async () => {
      await result.current.onStartPairing?.();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal?.aborted).toBe(false);

    unmount();
    expect(capturedSignal?.aborted).toBe(true);
  });

  it("flips a pending pairing to expired when the deadline passes without a poll result", async () => {
    clientMocks.mintCloudWorkstationPairingCode.mockResolvedValue({
      id: "pair-1",
      code: "ABCD-EFGH-JKMN",
      expiresAt: futureIso(5_000),
    });
    const { result } = renderManager();

    await act(async () => {
      await result.current.onStartPairing?.();
    });
    expect(result.current.workstationPairing?.status).toBe("pending");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_100);
    });
    expect(result.current.workstationPairing?.status).toBe("expired");
  });

  it("resolves the registered workstation's display name from the registry", async () => {
    clientMocks.mintCloudWorkstationPairingCode.mockResolvedValue({
      id: "pair-1",
      code: "ABCD-EFGH-JKMN",
      expiresAt: futureIso(10 * 60_000),
    });
    clientMocks.fetchCloudWorkstationPairingStatus.mockResolvedValue({
      status: "registered",
      expiresAt: null,
      workstationId: "ws-hub",
    });
    clientMocks.fetchCloudWorkstations.mockResolvedValue({
      defaultWorkstationId: "ws-hub",
      workstations: [
        {
          id: "ws-hub",
          displayName: "Hub devbox",
          provider: "runtime_peer",
          providerLabel: null,
          status: "online",
          statusMessage: null,
          defaultEnvironmentLabel: "Current Python",
          environmentPolicy: "current_python",
          workingDirectory: null,
          cpuCount: null,
          memoryBytes: null,
          updatedAt: null,
          environments: [],
        },
      ],
    });
    const { result } = renderManager();

    await act(async () => {
      await result.current.onStartPairing?.();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });

    expect(result.current.workstationPairing?.status).toBe("registered");
    expect(result.current.workstationPairing?.workstationName).toBe("Hub devbox");
  });

  it("starts the launch candidate from toolbar wiring", async () => {
    clientMocks.fetchCloudWorkstations.mockResolvedValue({
      defaultWorkstationId: "ws-lab2",
      workstations: [lab2Workstation],
    });
    clientMocks.requestCloudWorkstationAttachment.mockResolvedValue({
      jobId: "job-1",
      status: "pending",
    });
    const { result } = renderManager();

    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      await result.current.onStartSelectedWorkstation?.();
    });

    expect(clientMocks.requestCloudWorkstationAttachment).toHaveBeenCalledWith(
      "/api/n/nb-1/workstation-attachments",
      devAuth,
      "ws-lab2",
      { replaceExisting: false },
    );
  });

  it("requests a replacement attach job for toolbar restart", async () => {
    clientMocks.fetchCloudWorkstations.mockResolvedValue({
      defaultWorkstationId: "ws-lab2",
      workstations: [lab2Workstation],
    });
    clientMocks.requestCloudWorkstationAttachment.mockResolvedValue({
      jobId: "job-restart",
      status: "pending",
    });
    const { result } = renderManager();

    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      await result.current.onStartSelectedWorkstation?.({ replaceExisting: true });
    });

    expect(clientMocks.requestCloudWorkstationAttachment).toHaveBeenCalledWith(
      "/api/n/nb-1/workstation-attachments",
      devAuth,
      "ws-lab2",
      { replaceExisting: true },
    );
  });
});
