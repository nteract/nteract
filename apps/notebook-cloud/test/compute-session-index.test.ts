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

describe("OwnerComputeIndex workstation leases", () => {
  it("renews a lease and arms the alarm for its expiry", async () => {
    const { state, scheduledAlarm } = fakeStateWithAlarm();
    const object = new OwnerComputeIndex(state, {} as Env);

    const response = await object.fetch(leaseUpsert("ws-a", "user:dev:alice", 60_000));
    assert.equal(response.status, 200);
    const body = (await response.json()) as { ok: boolean; lease_expires_at: number };
    assert.equal(body.ok, true);
    // Single-earliest-wins: the alarm is scheduled for exactly this expiry.
    assert.equal(scheduledAlarm(), body.lease_expires_at);

    const leases = await listLeases(object);
    assert.equal(leases.length, 1);
    assert.equal(leases[0].workstation_id, "ws-a");
    assert.equal(leases[0].online, true);
    assert.equal(leases[0].offline_reason, null);
  });

  it("keeps the alarm on the earliest of several leases", async () => {
    const { state, scheduledAlarm } = fakeStateWithAlarm();
    const object = new OwnerComputeIndex(state, {} as Env);

    const later = (await (
      await object.fetch(leaseUpsert("ws-late", "user:dev:alice", 120_000))
    ).json()) as { lease_expires_at: number };
    const sooner = (await (
      await object.fetch(leaseUpsert("ws-soon", "user:dev:alice", 30_000))
    ).json()) as { lease_expires_at: number };

    assert.ok(sooner.lease_expires_at < later.lease_expires_at);
    assert.equal(scheduledAlarm(), sooner.lease_expires_at);
  });

  it("sweeps an expired lease to offline and clears the alarm when none remain", async () => {
    const { state, values, scheduledAlarm } = fakeStateWithAlarm();
    const object = new OwnerComputeIndex(state, {} as Env);

    await object.fetch(leaseUpsert("ws-a", "user:dev:alice", 60_000));
    // Force the stored lease past its window, then fire the alarm the runtime
    // would have scheduled.
    const stored = values.get("lease:ws-a") as Record<string, unknown>;
    values.set("lease:ws-a", { ...stored, lease_expires_at: Date.now() - 1 });

    await object.alarm();

    const leases = await listLeases(object);
    assert.equal(leases.length, 1);
    assert.equal(leases[0].online, false);
    assert.match(leases[0].offline_reason ?? "", /lease expired/);
    // No live lease left, so the DO disarms and hibernates.
    assert.equal(scheduledAlarm(), null);
  });

  it("leaves live leases untouched while sweeping expired ones", async () => {
    const { state, values } = fakeStateWithAlarm();
    const object = new OwnerComputeIndex(state, {} as Env);

    await object.fetch(leaseUpsert("ws-dead", "user:dev:alice", 60_000));
    await object.fetch(leaseUpsert("ws-live", "user:dev:alice", 60_000));
    const dead = values.get("lease:ws-dead") as Record<string, unknown>;
    values.set("lease:ws-dead", { ...dead, lease_expires_at: Date.now() - 1 });

    await object.alarm();

    const byId = new Map(
      (await listLeases(object)).map((lease) => [lease.workstation_id, lease] as const),
    );
    assert.equal(byId.get("ws-dead")?.online, false);
    assert.equal(byId.get("ws-live")?.online, true);
  });
});

describe("OwnerComputeIndex lease notifications and GC", () => {
  it("pushes went_offline to WorkstationEvents when a lease lapses", async () => {
    const { state, values } = fakeStateWithAlarm();
    const events = fakeWorkstationEvents();
    const object = new OwnerComputeIndex(state, events.env);

    await object.fetch(leaseUpsert("ws-a", "user:dev:alice", 60_000));
    const stored = values.get("lease:ws-a") as Record<string, unknown>;
    values.set("lease:ws-a", { ...stored, lease_expires_at: Date.now() - 1 });

    await object.alarm();

    assert.equal(events.notifications.length, 1);
    assert.equal(events.notifications[0].objectName, "user:dev:alice\nws-a");
    assert.equal(events.notifications[0].body.event, "went_offline");
    assert.equal(events.notifications[0].body.workstation_id, "ws-a");
    assert.match(events.notifications[0].body.reason as string, /lease expired/);
  });

  it("does not push for a lease that is already offline", async () => {
    const { state, values } = fakeStateWithAlarm();
    const events = fakeWorkstationEvents();
    const object = new OwnerComputeIndex(state, events.env);

    await object.fetch(leaseUpsert("ws-a", "user:dev:alice", 60_000));
    const stored = values.get("lease:ws-a") as Record<string, unknown>;
    values.set("lease:ws-a", { ...stored, online: false, lease_expires_at: Date.now() - 1 });

    await object.alarm();

    assert.equal(events.notifications.length, 0);
  });

  it("garbage-collects leases offline past the GC window", async () => {
    const { state, values } = fakeStateWithAlarm();
    const object = new OwnerComputeIndex(state, {} as Env);

    await object.fetch(leaseUpsert("ws-old", "user:dev:alice", 60_000));
    // Offline for well over a day past expiry.
    const stored = values.get("lease:ws-old") as Record<string, unknown>;
    values.set("lease:ws-old", {
      ...stored,
      online: false,
      lease_expires_at: Date.now() - 25 * 60 * 60_000,
    });

    await object.alarm();

    assert.equal((await listLeases(object)).length, 0);
    assert.equal(values.has("lease:ws-old"), false);
  });
});

function fakeWorkstationEvents(): {
  env: Env;
  notifications: Array<{ objectName: string; body: Record<string, unknown> }>;
} {
  const notifications: Array<{ objectName: string; body: Record<string, unknown> }> = [];
  const namespace = {
    idFromName: (name: string) => ({ toString: () => name, name }),
    get: (id: { name: string }) => ({
      fetch: async (request: Request) => {
        notifications.push({
          objectName: id.name,
          body: (await request.json()) as Record<string, unknown>,
        });
        return Response.json({ ok: true, delivered: 1 });
      },
    }),
  };
  return {
    env: { WORKSTATION_EVENTS: namespace } as unknown as Env,
    notifications,
  };
}

function leaseUpsert(workstationId: string, ownerPrincipal: string, ttlMs: number): Request {
  return new Request("https://compute.internal/lease/upsert", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workstation_id: workstationId,
      owner_principal: ownerPrincipal,
      ttl_ms: ttlMs,
    }),
  });
}

async function listLeases(
  object: OwnerComputeIndex,
): Promise<Array<{ workstation_id: string; online: boolean; offline_reason: string | null }>> {
  const response = await object.fetch(
    new Request("https://compute.internal/lease/list", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }),
  );
  const body = (await response.json()) as {
    leases: Array<{ workstation_id: string; online: boolean; offline_reason: string | null }>;
  };
  return body.leases;
}

function fakeStateWithAlarm(): {
  state: DurableObjectState;
  values: Map<string, unknown>;
  scheduledAlarm: () => number | null;
} {
  const values = new Map<string, unknown>();
  let alarm: number | null = null;
  const state: DurableObjectState = {
    id: { toString: () => "owner-compute" },
    storage: {
      get: async <T>(key: string) => values.get(key) as T | undefined,
      put: async <T>(key: string, value: T) => {
        values.set(key, value);
      },
      delete: async (key: string) => values.delete(key),
      list: async <T>() => new Map(values as Map<string, T>),
      setAlarm: async (time: number | Date) => {
        alarm = typeof time === "number" ? time : time.getTime();
      },
      getAlarm: async () => alarm,
      deleteAlarm: async () => {
        alarm = null;
      },
    },
    waitUntil: () => undefined,
  };
  return { state, values, scheduledAlarm: () => alarm };
}

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
