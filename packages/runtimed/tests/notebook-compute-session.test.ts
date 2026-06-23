import { beforeEach, describe, expect, it } from "vitest";
import {
  clearNotebookComputeSessionProjectionCacheForTests,
  isNotebookComputeSessionSummary,
  projectNotebookComputeSessionFact,
  projectNotebookComputeSessionSummary,
  type WorkstationAttachmentState,
} from "../src";

beforeEach(() => {
  clearNotebookComputeSessionProjectionCacheForTests();
});

const attachment: WorkstationAttachmentState = {
  workstation_id: "ws-lab2",
  display_name: "lab2 workstation",
  provider: "runtime_peer",
  default_environment_label: "Current Python",
  environment_policy: "current_python",
  status: "ready",
  status_message: null,
  cpu_count: 8,
  memory_bytes: 16_000_000_000,
  working_directory: "/home/ubuntu/project",
  updated_at: "2026-06-23T00:00:00.000Z",
  runtime_session_id: "job-1",
};

describe("projectNotebookComputeSessionSummary", () => {
  it("projects an attached runtime peer as active compute", () => {
    const summary = projectNotebookComputeSessionSummary({
      attachment,
      notebookId: "topic-viz",
      ownerPrincipal: "user:dev:alice",
      queueDepth: 2,
      runtimePeerCount: 1,
      updatedAt: "2026-06-23T00:00:05.000Z",
    });

    expect(summary).toEqual({
      environment_label: "Current Python",
      last_runtime_seen_at: "2026-06-23T00:00:05.000Z",
      notebook_id: "topic-viz",
      owner_principal: "user:dev:alice",
      queue_depth: 2,
      runtime_peer_count: 1,
      runtime_session_id: "job-1",
      status: "active",
      status_message: null,
      updated_at: "2026-06-23T00:00:05.000Z",
      working_directory: "/home/ubuntu/project",
      workstation_display_name: "lab2 workstation",
      workstation_id: "ws-lab2",
    });
    expect(isNotebookComputeSessionSummary(summary)).toBe(true);
  });

  it("keeps a disconnected ready attachment visible as stale", () => {
    const summary = projectNotebookComputeSessionSummary({
      attachment,
      notebookId: "topic-viz",
      ownerPrincipal: "user:dev:alice",
      runtimePeerCount: 0,
    });

    expect(summary?.status).toBe("stale");
    expect(summary?.last_runtime_seen_at).toBeNull();
  });

  it("projects accepted attach jobs as starting", () => {
    const summary = projectNotebookComputeSessionSummary({
      attachment: {
        ...attachment,
        status: "connecting",
        status_message: "lab2 accepted the request and is starting compute.",
      },
      notebookId: "topic-viz",
      ownerPrincipal: "user:dev:alice",
      runtimePeerCount: 0,
    });

    expect(summary?.status).toBe("starting");
    expect(projectNotebookComputeSessionFact(summary)?.label).toBe("lab2 workstation starting");
  });

  it("surfaces failed attachments as attention-worthy compute", () => {
    const summary = projectNotebookComputeSessionSummary({
      attachment: {
        ...attachment,
        status: "error",
        status_message: "ipykernel is missing",
      },
      notebookId: "topic-viz",
      ownerPrincipal: "user:dev:alice",
      runtimePeerCount: 0,
    });

    expect(summary?.status).toBe("error");
    expect(summary?.status_message).toBe("ipykernel is missing");
    expect(projectNotebookComputeSessionFact(summary)).toEqual({
      label: "lab2 workstation needs attention",
      status: "error",
      tone: "error",
    });
  });

  it("returns stable frozen projections for equivalent inputs", () => {
    const first = projectNotebookComputeSessionSummary({
      attachment,
      notebookId: "topic-viz",
      ownerPrincipal: "user:dev:alice",
      runtimePeerCount: 1,
    });
    const second = projectNotebookComputeSessionSummary({
      attachment,
      notebookId: "topic-viz",
      ownerPrincipal: "user:dev:alice",
      runtimePeerCount: 1,
    });

    expect(first).toBe(second);
    expect(Object.isFrozen(first)).toBe(true);
  });
});
