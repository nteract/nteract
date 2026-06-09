import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { CloudPrototypeAuthState } from "../viewer/collaborator-auth";
import {
  CLOUD_WORKSTATIONS_ACTIVE_REFRESH_INTERVAL_MS,
  CLOUD_WORKSTATIONS_ATTACH_REFRESH_INTERVAL_MS,
  cloudWorkstationRefreshIntervalMs,
  cloudWorkstationsCanLoad,
  fetchCloudWorkstations,
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
      defaultEnvironmentLabel: "Current Python",
      environmentPolicy: "current_python",
      workingDirectory: "/home/ubuntu/project",
      cpuCount: 8,
      memoryBytes: 16000000000,
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
      { jobId: "job-1", status: "pending" },
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

  it("waits for browser app-session cookies before loading the registry", () => {
    assert.equal(
      cloudWorkstationsCanLoad({
        authState: { mode: "oidc" },
        hasAppSession: false,
      }),
      false,
    );
    assert.equal(
      cloudWorkstationsCanLoad({
        authState: { mode: "oidc" },
        hasAppSession: true,
      }),
      true,
    );
    assert.equal(
      cloudWorkstationsCanLoad({
        authState: { mode: "dev" },
        hasAppSession: false,
      }),
      true,
    );
    assert.equal(
      cloudWorkstationsCanLoad({
        authState: { mode: "anonymous" },
        hasAppSession: false,
      }),
      false,
    );
  });
});

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
