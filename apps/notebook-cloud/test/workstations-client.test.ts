import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { CloudPrototypeAuthState } from "../viewer/collaborator-auth";
import {
  CLOUD_WORKSTATION_DEBIAN_PREP_COMMAND,
  CLOUD_WORKSTATION_HEADLESS_INSTALL_COMMAND,
  CLOUD_WORKSTATION_PATH_EXPORT_COMMAND,
  CLOUD_WORKSTATIONS_ACTIVE_REFRESH_INTERVAL_MS,
  CLOUD_WORKSTATIONS_ATTACH_REFRESH_INTERVAL_MS,
  cloudWorkstationConnectCommand,
  cloudWorkstationPairingCommands,
  cloudWorkstationRefreshIntervalMs,
  cloudWorkstationRunCommand,
  cloudWorkstationServiceInstallCommand,
  fetchCloudWorkstationPairingStatus,
  fetchCloudWorkstations,
  mintCloudWorkstationPairingCode,
  requestCloudWorkstationAttachment,
  setCloudDefaultWorkstation,
} from "../viewer/workstations-client";

const devAuth: CloudPrototypeAuthState = {
  mode: "dev",
  token: "dev-secret",
  user: "alice",
  oidcClaims: null,
  requestedScope: "owner",
  problem: null,
};

describe("cloud workstations client", () => {
  it("normalizes registered workstations into shared projection input", async (t) => {
    t.mock.method(globalThis, "fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("x-notebook-cloud-dev-token"), "dev-secret");
      assert.equal(headers.get("X-User"), "alice");
      assert.equal(headers.get("X-Scope"), "owner");
      return jsonResponse({
        default_workstation_id: "ws-lab2",
        workstations: [
          {
            workstation_id: "ws-lab2",
            display_name: "Lab2",
            owner_principal: "user:dev:alice",
            provider: "runtime_peer",
            provider_label: "Runtime peer",
            status: "online",
            installed_build: "0.1.0+abc123",
            channel: "nightly",
            latest_build: "0.2.0-nightly.202607091009",
            is_outdated: true,
            default_environment_label: "Current Python",
            environment_policy: "current_python",
            working_directory: "/home/ubuntu/project",
            cpu_count: 8,
            memory_bytes: 16000000000,
            environments: [
              {
                id: "current-python",
                label: "Current Python",
                policy: "current_python",
                is_default: true,
              },
            ],
          },
        ],
      });
    });

    const state = await fetchCloudWorkstations("/api/workstations", devAuth);

    assert.equal(state.defaultWorkstationId, "ws-lab2");
    assert.equal(state.workstations.length, 1);
    assert.deepEqual(state.workstations[0], {
      id: "ws-lab2",
      displayName: "Lab2",
      provider: "runtime_peer",
      providerLabel: "Runtime peer",
      status: "online",
      statusMessage: null,
      installedBuild: "0.1.0+abc123",
      channel: "nightly",
      latestBuild: "0.2.0-nightly.202607091009",
      isOutdated: true,
      defaultEnvironmentLabel: "Current Python",
      environmentPolicy: "current_python",
      workingDirectory: "/home/ubuntu/project",
      cpuCount: 8,
      memoryBytes: 16000000000,
      accelerators: null,
      updatedAt: null,
      environments: [
        {
          id: "current-python",
          label: "Current Python",
          available: true,
          detail: null,
          health: null,
          isDefault: true,
          policy: "current_python",
        },
      ],
    });
    assert.equal(Object.hasOwn(state.workstations[0], "owner_principal"), false);
  });

  it("preserves usable, not-ready, known-none, and older-agent accelerator semantics", async (t) => {
    t.mock.method(globalThis, "fetch", async () =>
      jsonResponse({
        workstations: [
          {
            workstation_id: "ws-gpu",
            display_name: "GPU box",
            accelerators: [
              {
                kind: "gpu",
                vendor: "NVIDIA",
                model: "A100",
                count: 2,
                memory_bytes_per_device: 80 * 1024 ** 3,
                readiness: "ready",
              },
            ],
          },
          {
            workstation_id: "ws-attention",
            display_name: "Driver attention",
            accelerators: [
              {
                kind: "gpu",
                vendor: "AMD",
                model: "MI300X",
                count: 1,
                readiness: "not_ready",
                diagnostic: "ROCm runtime is not available to the workstation service.",
              },
            ],
          },
          {
            workstation_id: "ws-cpu",
            display_name: "CPU box",
            accelerators: [],
          },
          {
            workstation_id: "ws-legacy",
            display_name: "Older agent",
          },
        ],
      }),
    );

    const state = await fetchCloudWorkstations("/api/workstations", devAuth);

    assert.deepEqual(state.workstations[0]?.accelerators, [
      {
        kind: "gpu",
        vendor: "NVIDIA",
        model: "A100",
        count: 2,
        memory_bytes_per_device: 80 * 1024 ** 3,
        readiness: "ready",
        diagnostic: null,
      },
    ]);
    assert.deepEqual(state.workstations[1]?.accelerators, [
      {
        kind: "gpu",
        vendor: "AMD",
        model: "MI300X",
        count: 1,
        memory_bytes_per_device: null,
        readiness: "not_ready",
        diagnostic: "ROCm runtime is not available to the workstation service.",
      },
    ]);
    assert.deepEqual(state.workstations[2]?.accelerators, []);
    assert.equal(state.workstations[3]?.accelerators, null);
  });

  it("sends default workstation selection through the configured endpoint", async (t) => {
    t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      assert.equal(String(input), "/api/workstations/default");
      assert.equal(init?.method, "PATCH");
      assert.deepEqual(JSON.parse(String(init?.body)), { workstation_id: "ws-lab2" });
      return jsonResponse({ default_workstation_id: "ws-lab2" });
    });

    assert.equal(
      await setCloudDefaultWorkstation("/api/workstations/default", devAuth, "ws-lab2"),
      "ws-lab2",
    );
  });

  it("requests notebook attachment without optimistic readiness state", async (t) => {
    t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      assert.equal(String(input), "/api/n/nb-1/workstation-attachments");
      assert.equal(init?.method, "POST");
      assert.deepEqual(JSON.parse(String(init?.body)), { workstation_id: "ws-lab2" });
      return jsonResponse({
        job: {
          job_id: "job-1",
          workstation_id: "ws-lab2",
          status: "pending",
        },
      });
    });

    assert.deepEqual(
      await requestCloudWorkstationAttachment(
        "/api/n/nb-1/workstation-attachments",
        devAuth,
        "ws-lab2",
      ),
      { jobId: "job-1", status: "pending", workstationId: "ws-lab2" },
    );
  });

  it("requests replacement notebook attachment for hosted restarts", async (t) => {
    t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      assert.equal(String(input), "/api/n/nb-1/workstation-attachments");
      assert.equal(init?.method, "POST");
      assert.deepEqual(JSON.parse(String(init?.body)), {
        workstation_id: "ws-lab2",
        replace_existing: true,
        intent: "restart",
      });
      return jsonResponse({
        job: {
          job_id: "job-restart",
          workstation_id: "ws-lab2",
          status: "pending",
        },
      });
    });

    assert.deepEqual(
      await requestCloudWorkstationAttachment(
        "/api/n/nb-1/workstation-attachments",
        devAuth,
        "ws-lab2",
        { replaceExisting: true },
      ),
      { jobId: "job-restart", status: "pending", workstationId: "ws-lab2" },
    );
  });

  it("keeps registry refresh bounded to owner flows that can change workstation selection", () => {
    assert.equal(
      cloudWorkstationRefreshIntervalMs({
        canChooseHostedWorkstation: false,
        hasRegisteredWorkstations: false,
        mutationKind: "idle",
        panelIsOpen: true,
      }),
      null,
    );
    assert.equal(
      cloudWorkstationRefreshIntervalMs({
        canChooseHostedWorkstation: true,
        hasRegisteredWorkstations: false,
        mutationKind: "idle",
        panelIsOpen: false,
      }),
      CLOUD_WORKSTATIONS_ACTIVE_REFRESH_INTERVAL_MS,
    );
    assert.equal(
      cloudWorkstationRefreshIntervalMs({
        canChooseHostedWorkstation: true,
        hasRegisteredWorkstations: true,
        mutationKind: "idle",
        panelIsOpen: true,
      }),
      CLOUD_WORKSTATIONS_ACTIVE_REFRESH_INTERVAL_MS,
    );
    assert.equal(
      cloudWorkstationRefreshIntervalMs({
        canChooseHostedWorkstation: true,
        hasRegisteredWorkstations: true,
        mutationKind: "idle",
        panelIsOpen: false,
      }),
      null,
    );
    assert.equal(
      cloudWorkstationRefreshIntervalMs({
        canChooseHostedWorkstation: true,
        hasRegisteredWorkstations: true,
        mutationKind: "attach",
        panelIsOpen: false,
      }),
      CLOUD_WORKSTATIONS_ATTACH_REFRESH_INTERVAL_MS,
    );
  });

  it("mints a pairing code and reads its status", async (t) => {
    const calls: string[] = [];
    t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/api/workstations/pairing-codes")) {
        return jsonResponse(
          {
            ok: true,
            pairing: {
              id: "pair-1",
              code: "ABCD-EFGH-JKMN",
              expires_at: "2026-06-12T12:00:00.000Z",
            },
          },
          201,
        );
      }
      return jsonResponse({
        ok: true,
        pairing: {
          id: "pair-1",
          status: "registered",
          expires_at: "2026-06-12T12:00:00.000Z",
          workstation_id: "ws-hub",
        },
      });
    });

    const minted = await mintCloudWorkstationPairingCode("/api/workstations", devAuth);
    assert.deepEqual(minted, {
      id: "pair-1",
      code: "ABCD-EFGH-JKMN",
      expiresAt: "2026-06-12T12:00:00.000Z",
    });

    const status = await fetchCloudWorkstationPairingStatus("/api/workstations", devAuth, "pair-1");
    assert.deepEqual(status, {
      status: "registered",
      expiresAt: "2026-06-12T12:00:00.000Z",
      workstationId: "ws-hub",
    });
    assert.deepEqual(calls, [
      "POST /api/workstations/pairing-codes",
      "GET /api/workstations/pairing-codes/pair-1",
    ]);
  });

  it("surfaces server errors from pairing mint", async (t) => {
    t.mock.method(globalThis, "fetch", async () =>
      jsonResponse({ error: "sign in to add a workstation" }, 401),
    );
    await assert.rejects(
      mintCloudWorkstationPairingCode("/api/workstations", devAuth),
      /sign in to add a workstation/,
    );
  });

  it("builds the workstation pairing command from origin and code", () => {
    assert.equal(
      cloudWorkstationConnectCommand("https://preview.runt.run", "ABCD-EFGH-JKMN"),
      "runt workstation connect https://preview.runt.run --code ABCD-EFGH-JKMN",
    );
  });

  it("builds copyable workstation setup commands from origin and code", () => {
    assert.deepEqual(
      cloudWorkstationPairingCommands("https://preview.runt.run", "ABCD-EFGH-JKMN"),
      [
        {
          id: "debian-prep",
          label: "Fresh Debian/Ubuntu only",
          command: CLOUD_WORKSTATION_DEBIAN_PREP_COMMAND,
          optional: true,
        },
        {
          id: "install",
          label: "Install nteract headless",
          command: CLOUD_WORKSTATION_HEADLESS_INSTALL_COMMAND,
        },
        {
          id: "path",
          label: "Use installed CLI in this shell",
          command: CLOUD_WORKSTATION_PATH_EXPORT_COMMAND,
        },
        {
          id: "connect",
          label: "Pair this workstation",
          command: "runt workstation connect https://preview.runt.run --code ABCD-EFGH-JKMN",
        },
        {
          id: "run",
          label: "Linux user systemd service",
          command: cloudWorkstationServiceInstallCommand(),
        },
        {
          id: "foreground-run",
          label: "macOS/non-systemd fallback",
          command: cloudWorkstationRunCommand(),
          optional: true,
        },
      ],
    );
  });
});

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
