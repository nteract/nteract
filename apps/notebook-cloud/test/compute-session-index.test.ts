import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  D1Database,
  D1PreparedStatement,
  D1Result,
  D1Value,
  DurableObjectNamespace,
  DurableObjectState,
  Env,
} from "../src/cloudflare-types.ts";
import {
  OwnerComputeIndex,
  ownerComputeIndexObjectName,
  WORKSTATION_LEASE_GC_MS,
} from "../src/compute-session-index.ts";
import type { WorkstationAttachJobRow, WorkstationAttachJobStatus } from "../src/storage.ts";
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

  it("sweeps an expired lease to offline and arms the GC deadline for the dead row", async () => {
    const { state, values, scheduledAlarm, deliverAlarm } = fakeStateWithAlarm();
    const object = new OwnerComputeIndex(state, {} as Env);

    await object.fetch(leaseUpsert("ws-a", "user:dev:alice", 60_000));
    // Force the stored lease past its window, then fire the alarm the runtime
    // would have scheduled.
    const stored = values.get("lease:ws-a") as Record<string, unknown>;
    const expiredAt = Date.now() - 1;
    values.set("lease:ws-a", { ...stored, lease_expires_at: expiredAt });

    deliverAlarm();
    await object.alarm();

    const leases = await listLeases(object);
    assert.equal(leases.length, 1);
    assert.equal(leases[0].online, false);
    assert.match(leases[0].offline_reason ?? "", /lease expired/);
    // The row is offline now, so the alarm is armed for its GC deadline, not
    // cleared - otherwise the dead row would never be collected.
    assert.equal(scheduledAlarm(), expiredAt + WORKSTATION_LEASE_GC_MS);
  });

  it("leaves live leases untouched while sweeping expired ones", async () => {
    const { state, values, deliverAlarm } = fakeStateWithAlarm();
    const object = new OwnerComputeIndex(state, {} as Env);

    await object.fetch(leaseUpsert("ws-dead", "user:dev:alice", 60_000));
    await object.fetch(leaseUpsert("ws-live", "user:dev:alice", 60_000));
    const dead = values.get("lease:ws-dead") as Record<string, unknown>;
    values.set("lease:ws-dead", { ...dead, lease_expires_at: Date.now() - 1 });

    deliverAlarm();
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
    const { state, values, settle, deliverAlarm } = fakeStateWithAlarm();
    const events = fakeWorkstationEvents();
    const object = new OwnerComputeIndex(state, events.env);

    await object.fetch(leaseUpsert("ws-a", "user:dev:alice", 60_000));
    const stored = values.get("lease:ws-a") as Record<string, unknown>;
    values.set("lease:ws-a", { ...stored, lease_expires_at: Date.now() - 1 });

    deliverAlarm();
    await object.alarm();
    // Delivery is dispatched off the handler via waitUntil; drain it.
    await settle();

    assert.equal(events.notifications.length, 1);
    assert.equal(events.notifications[0].objectName, "user:dev:alice\nws-a");
    assert.equal(events.notifications[0].body.event, "went_offline");
    assert.equal(events.notifications[0].body.workstation_id, "ws-a");
    assert.match(events.notifications[0].body.reason as string, /lease expired/);
  });

  it("fails active attach jobs when a lease lapses", async () => {
    const { state, values, settle, deliverAlarm } = fakeStateWithAlarm();
    const events = fakeWorkstationEvents();
    const rooms = fakeNotebookRooms();
    const jobs = new Map<string, WorkstationAttachJobRow>([
      ["pending-job", attachJob("pending-job", "pending", { notebook_id: "nb-pending" })],
      ["accepted-job", attachJob("accepted-job", "accepted", { notebook_id: "nb-accepted" })],
      ["running-job", attachJob("running-job", "running", { notebook_id: "nb-running" })],
      ["completed-job", attachJob("completed-job", "completed", { notebook_id: "nb-done" })],
    ]);
    const object = new OwnerComputeIndex(state, {
      ...events.env,
      DB: fakeAttachJobsDb(jobs),
      NOTEBOOK_ROOMS: rooms.namespace,
    } as Env);

    await object.fetch(leaseUpsert("ws-a", "user:dev:alice", 60_000));
    const stored = values.get("lease:ws-a") as Record<string, unknown>;
    values.set("lease:ws-a", { ...stored, lease_expires_at: Date.now() - 1 });

    deliverAlarm();
    await object.alarm();
    await settle();

    const expectedError = "workstation lease expired: no heartbeat within the lease window";
    for (const jobId of ["pending-job", "accepted-job", "running-job"]) {
      assert.equal(jobs.get(jobId)?.status, "failed");
      assert.equal(jobs.get(jobId)?.error_message, expectedError);
      assert.ok(jobs.get(jobId)?.finished_at);
    }
    assert.equal(jobs.get("completed-job")?.status, "completed");
    assert.equal(jobs.get("completed-job")?.error_message, null);

    const attachNotifications = events.notifications.filter(
      (entry) => entry.body.event === "attach_jobs",
    );
    assert.deepEqual(
      new Set(attachNotifications.map((entry) => entry.body.job_id)),
      new Set(["pending-job", "accepted-job", "running-job"]),
    );
    assert.equal(
      events.notifications.some((entry) => entry.body.event === "went_offline"),
      true,
    );
    assert.deepEqual(
      new Set(rooms.repairs.map((repair) => repair.body.expected_runtime_session_id)),
      new Set(["pending-job", "accepted-job", "running-job"]),
    );
    assert.equal(
      rooms.repairs.every((repair) => repair.body.reason === expectedError),
      true,
    );
  });

  it("deletes an online lease and leaves no lease for a concurrent sweep to notify", async () => {
    const { state, scheduledAlarm, settle, deliverAlarm } = fakeStateWithAlarm();
    const events = fakeWorkstationEvents();
    const object = new OwnerComputeIndex(state, events.env);

    await object.fetch(leaseUpsert("ws-a", "user:dev:alice", 60_000));

    const deleted = await object.fetch(leaseDelete("ws-a", "user:dev:alice"));
    assert.equal(deleted.status, 200);
    assert.deepEqual(await deleted.json(), {
      ok: true,
      deleted: true,
      went_offline: true,
      reason: null,
    });
    assert.equal((await listLeases(object)).length, 0);
    assert.equal(scheduledAlarm(), null);

    deliverAlarm();
    await object.alarm();
    await settle();

    assert.equal(events.notifications.length, 0);
  });

  it("does not ask delete callers to notify again when the sweep already marked offline", async () => {
    const { state, values, settle, deliverAlarm } = fakeStateWithAlarm();
    const events = fakeWorkstationEvents();
    const object = new OwnerComputeIndex(state, events.env);

    await object.fetch(leaseUpsert("ws-a", "user:dev:alice", 60_000));
    const stored = values.get("lease:ws-a") as Record<string, unknown>;
    values.set("lease:ws-a", { ...stored, lease_expires_at: Date.now() - 1 });

    deliverAlarm();
    await object.alarm();
    await settle();

    const deleted = await object.fetch(leaseDelete("ws-a", "user:dev:alice"));
    assert.equal(deleted.status, 200);
    assert.deepEqual(await deleted.json(), {
      ok: true,
      deleted: true,
      went_offline: false,
      reason: "lease expired: no heartbeat within the lease window",
    });
    assert.equal(events.notifications.length, 1);
  });

  it("does not push for a lease that is already offline", async () => {
    const { state, values, settle, deliverAlarm } = fakeStateWithAlarm();
    const events = fakeWorkstationEvents();
    const object = new OwnerComputeIndex(state, events.env);

    await object.fetch(leaseUpsert("ws-a", "user:dev:alice", 60_000));
    const stored = values.get("lease:ws-a") as Record<string, unknown>;
    values.set("lease:ws-a", { ...stored, online: false, lease_expires_at: Date.now() - 1 });

    deliverAlarm();
    await object.alarm();
    await settle();

    assert.equal(events.notifications.length, 0);
  });

  it("garbage-collects leases offline past the GC window and disarms", async () => {
    const { state, values, scheduledAlarm, deliverAlarm } = fakeStateWithAlarm();
    const object = new OwnerComputeIndex(state, {} as Env);

    await object.fetch(leaseUpsert("ws-old", "user:dev:alice", 60_000));
    // Offline for well over a day past expiry.
    const stored = values.get("lease:ws-old") as Record<string, unknown>;
    values.set("lease:ws-old", {
      ...stored,
      online: false,
      lease_expires_at: Date.now() - 25 * 60 * 60_000,
    });

    deliverAlarm();
    await object.alarm();

    assert.equal((await listLeases(object)).length, 0);
    assert.equal(values.has("lease:ws-old"), false);
    // Nothing left to sweep, so the alarm is cleared and the DO hibernates.
    assert.equal(scheduledAlarm(), null);
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

function fakeNotebookRooms(): {
  namespace: DurableObjectNamespace;
  repairs: Array<{ objectName: string; body: Record<string, unknown> }>;
} {
  const repairs: Array<{ objectName: string; body: Record<string, unknown> }> = [];
  const namespace = {
    idFromName: (name: string) => ({ toString: () => name, name }),
    get: (id: { name: string }) => ({
      fetch: async (request: Request) => {
        repairs.push({
          objectName: id.name,
          body: (await request.json()) as Record<string, unknown>,
        });
        return Response.json({ ok: true, repaired: true });
      },
    }),
  };
  return { namespace: namespace as unknown as DurableObjectNamespace, repairs };
}

function fakeAttachJobsDb(jobs: Map<string, WorkstationAttachJobRow>): D1Database {
  return {
    prepare: (query: string) => fakeD1Statement(query, jobs),
    exec: async () => d1Result(),
    batch: async <T>(statements: D1PreparedStatement[]) =>
      Promise.all(statements.map((statement) => statement.run<T>())),
  };
}

function fakeD1Statement(
  query: string,
  jobs: Map<string, WorkstationAttachJobRow>,
): D1PreparedStatement {
  let boundValues: D1Value[] = [];
  const statement: D1PreparedStatement = {
    bind: (...values: D1Value[]) => {
      boundValues = values;
      return statement;
    },
    first: async () => null,
    run: async <T>() => d1Result<T>(),
    all: async <T>() => {
      if (query.includes("UPDATE workstation_attach_jobs") && query.includes("RETURNING id")) {
        const [updatedAt, finishedAt, errorMessage, ownerPrincipal, workstationId] = boundValues;
        const failed: WorkstationAttachJobRow[] = [];
        for (const job of jobs.values()) {
          if (
            job.owner_principal !== ownerPrincipal ||
            job.workstation_id !== workstationId ||
            !["pending", "accepted", "running"].includes(job.status)
          ) {
            continue;
          }
          const next: WorkstationAttachJobRow = {
            ...job,
            status: "failed",
            updated_at: String(updatedAt),
            finished_at: String(finishedAt),
            error_message: String(errorMessage),
          };
          jobs.set(job.id, next);
          failed.push(next);
        }
        return d1Result(failed as T[]);
      }
      return d1Result<T>();
    },
  };
  return statement;
}

function d1Result<T = unknown>(results: T[] = []): D1Result<T> {
  return { results, success: true, meta: {} };
}

function attachJob(
  id: string,
  status: WorkstationAttachJobStatus,
  overrides: Partial<WorkstationAttachJobRow> = {},
): WorkstationAttachJobRow {
  return {
    id,
    notebook_id: "nb-1",
    owner_principal: "user:dev:alice",
    workstation_id: "ws-a",
    status,
    requested_by_actor_label: "alice",
    requested_at: "2026-07-07T00:00:00.000Z",
    updated_at: "2026-07-07T00:00:00.000Z",
    accepted_at: status === "pending" ? null : "2026-07-07T00:01:00.000Z",
    finished_at: ["failed", "completed", "cancelled"].includes(status)
      ? "2026-07-07T00:02:00.000Z"
      : null,
    error_message: null,
    ...overrides,
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

function leaseDelete(workstationId: string, ownerPrincipal: string): Request {
  return new Request("https://compute.internal/lease/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workstation_id: workstationId,
      owner_principal: ownerPrincipal,
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
  settle: () => Promise<unknown>;
  deliverAlarm: () => void;
} {
  const values = new Map<string, unknown>();
  let alarm: number | null = null;
  // The alarm dispatches went_offline via waitUntil so the handler returns
  // without awaiting delivery. Capture those promises so a test can await the
  // background work it wants to observe.
  const pending: Promise<unknown>[] = [];
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
    waitUntil: (promise: Promise<unknown>) => {
      pending.push(Promise.resolve(promise));
    },
  };
  return {
    state,
    values,
    scheduledAlarm: () => alarm,
    settle: () => Promise.allSettled(pending),
    // Model Cloudflare delivering the alarm: the pending alarm is consumed
    // before the handler runs, so getAlarm() reads null inside alarm() unless
    // the handler re-arms. Call this right before object.alarm().
    deliverAlarm: () => {
      alarm = null;
    },
  };
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
