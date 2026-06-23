import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DurableObjectState, Env } from "../src/cloudflare-types.ts";
import { OwnerComputeIndex, ownerComputeIndexObjectName } from "../src/compute-session-index.ts";
import type { NotebookComputeSessionSummary } from "runtimed";

describe("OwnerComputeIndex", () => {
  it("stores and lists compute sessions by requested notebook ids", async () => {
    const object = new OwnerComputeIndex(fakeState(), {} as Env);
    const summary = computeSummary("topic-viz");

    const upsert = await object.fetch(
      new Request("https://compute.internal/upsert", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ summary }),
      }),
    );
    assert.equal(upsert.status, 200);

    const list = await object.fetch(
      new Request("https://compute.internal/list", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notebook_ids: ["missing", "topic-viz"] }),
      }),
    );

    assert.equal(list.status, 200);
    assert.deepEqual(await list.json(), {
      ok: true,
      sessions: [summary],
    });
  });

  it("rejects malformed summaries and deletes notebook entries", async () => {
    const object = new OwnerComputeIndex(fakeState(), {} as Env);
    const invalid = await object.fetch(
      new Request("https://compute.internal/upsert", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ summary: { notebook_id: "topic-viz" } }),
      }),
    );
    assert.equal(invalid.status, 400);

    await object.fetch(
      new Request("https://compute.internal/upsert", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ summary: computeSummary("topic-viz") }),
      }),
    );
    const deleted = await object.fetch(
      new Request("https://compute.internal/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notebook_id: "topic-viz" }),
      }),
    );
    assert.equal(deleted.status, 200);

    const list = await object.fetch(
      new Request("https://compute.internal/list", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notebook_ids: ["topic-viz"] }),
      }),
    );
    assert.deepEqual(await list.json(), { ok: true, sessions: [] });
  });

  it("uses deterministic per-owner object names", () => {
    assert.equal(ownerComputeIndexObjectName("user:dev:alice"), "owner-compute:v1:user:dev:alice");
  });
});

function computeSummary(notebookId: string): NotebookComputeSessionSummary {
  return {
    environment_label: "Current Python",
    last_runtime_seen_at: "2026-06-23T00:00:00.000Z",
    notebook_id: notebookId,
    owner_principal: "user:dev:alice",
    queue_depth: 0,
    runtime_peer_count: 1,
    runtime_session_id: "job-1",
    status: "active",
    status_message: null,
    updated_at: "2026-06-23T00:00:00.000Z",
    working_directory: "/home/ubuntu/project",
    workstation_display_name: "lab2 workstation",
    workstation_id: "ws-lab2",
  };
}

function fakeState(): DurableObjectState {
  const values = new Map<string, unknown>();
  return {
    id: { toString: () => "owner-compute" },
    storage: {
      get: async <T>(key: string) => values.get(key) as T | undefined,
      put: async <T>(key: string, value: T) => {
        values.set(key, value);
      },
      delete: async (key: string) => values.delete(key),
      list: async <T>() => new Map(values as Map<string, T>),
    },
    waitUntil: () => undefined,
  };
}
