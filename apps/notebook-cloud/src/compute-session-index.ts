import type { DurableObjectNamespace, DurableObjectState, Env } from "./cloudflare-types.ts";
import { isNotebookComputeSessionSummary, type NotebookComputeSessionSummary } from "runtimed";
import { json } from "./http-responses.ts";
import { cloudLog, errorMessage } from "./observability.ts";
import { workstationEventsObjectName } from "./workstation-events.ts";

const COMPUTE_SESSION_KEY_PREFIX = "session:";
const WORKSTATION_LEASE_KEY_PREFIX = "lease:";
const OWNER_COMPUTE_INDEX_OBJECT_PREFIX = "owner-compute:v1:";
const MAX_NOTEBOOK_IDS_PER_LIST = 500;
// A lease that has stayed offline this far past its expiry is dead weight. The
// alarm drops it so DO storage does not accumulate stale records; D1 remains the
// registry of record, so the workstation still lists (offline) until it is
// deregistered.
const WORKSTATION_LEASE_GC_MS = 24 * 60 * 60_000;

/**
 * A workstation liveness lease held in the owner-scoped registry DO. The
 * heartbeat renews it (`lease_expires_at = now + ttl`); the DO's own `alarm()`
 * sweeps leases past their expiry to `online: false` without waiting on a read.
 *
 * The DO holds only lease state plus a self-scheduling alarm - no WebSockets -
 * so it hibernates between a heartbeat write and the next sweep. Connection
 * holding stays in WorkstationEvents (hibernatable sockets); the registry
 * reaches those sockets by an HTTP fetch, never by holding one here. See
 * docs/memos/byoc-control-plane.md.
 */
export interface WorkstationLeaseRecord {
  workstation_id: string;
  owner_principal: string;
  last_seen_at: string;
  lease_expires_at: number;
  online: boolean;
  offline_reason: string | null;
}

export class OwnerComputeIndex {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/upsert") {
      return this.handleUpsert(request);
    }
    if (request.method === "POST" && url.pathname === "/delete") {
      return this.handleDelete(request);
    }
    if (request.method === "POST" && url.pathname === "/list") {
      return this.handleList(request);
    }
    if (request.method === "POST" && url.pathname === "/lease/upsert") {
      return this.handleLeaseUpsert(request);
    }
    if (request.method === "POST" && url.pathname === "/lease/list") {
      return this.handleLeaseList();
    }
    return json({ error: "not found" }, 404);
  }

  /**
   * Fired by the runtime when the earliest lease reaches its expiry. Sweeps
   * every lease past its window to offline, then re-arms for the next one. The
   * DO hibernates again as soon as this returns.
   */
  async alarm(): Promise<void> {
    await this.sweepExpiredLeases(Date.now());
  }

  private async handleLeaseUpsert(request: Request): Promise<Response> {
    const payload = await readJsonObject(request);
    if (payload instanceof Response) {
      return payload;
    }
    const workstationId = boundedString(payload.workstation_id ?? payload.workstationId, 128);
    const ownerPrincipal = boundedString(payload.owner_principal ?? payload.ownerPrincipal, 320);
    const ttlMs = positiveInteger(payload.ttl_ms ?? payload.ttlMs);
    if (!workstationId || !ownerPrincipal || ttlMs === null) {
      return json({ error: "workstation_id, owner_principal, and ttl_ms are required" }, 400);
    }

    const now = Date.now();
    const lease: WorkstationLeaseRecord = {
      workstation_id: workstationId,
      owner_principal: ownerPrincipal,
      last_seen_at: new Date(now).toISOString(),
      lease_expires_at: now + ttlMs,
      online: true,
      offline_reason: null,
    };
    await this.state.storage.put(leaseKey(workstationId), lease);
    await this.armLeaseAlarm();
    return json({ ok: true, lease_expires_at: lease.lease_expires_at });
  }

  private async handleLeaseList(): Promise<Response> {
    const leases = await this.readLeases();
    return json({ ok: true, leases: Array.from(leases.values()) });
  }

  private async readLeases(): Promise<Map<string, WorkstationLeaseRecord>> {
    const all = await this.state.storage.list<unknown>({
      prefix: WORKSTATION_LEASE_KEY_PREFIX,
    });
    const leases = new Map<string, WorkstationLeaseRecord>();
    for (const [key, value] of all) {
      // Guard on the key prefix too: fake test storage ignores the list
      // prefix filter, so a compute-session value must not slip through.
      if (key.startsWith(WORKSTATION_LEASE_KEY_PREFIX) && isWorkstationLeaseRecord(value)) {
        leases.set(key, value);
      }
    }
    return leases;
  }

  /**
   * Single-earliest-wins: schedule the alarm for the soonest online lease
   * expiry, or clear it when no lease is live. Cheap to call on every upsert -
   * `setAlarm` is one row write, and we only rewrite when the target moves.
   */
  private async armLeaseAlarm(): Promise<void> {
    if (!this.state.storage.setAlarm) {
      return;
    }
    const leases = await this.readLeases();
    let earliest: number | null = null;
    for (const lease of leases.values()) {
      if (lease.online && (earliest === null || lease.lease_expires_at < earliest)) {
        earliest = lease.lease_expires_at;
      }
    }
    const current = (await this.state.storage.getAlarm?.()) ?? null;
    if (earliest === null) {
      if (current !== null) {
        await this.state.storage.deleteAlarm?.();
      }
      return;
    }
    if (current === null || current > earliest) {
      await this.state.storage.setAlarm(earliest);
    }
  }

  private async sweepExpiredLeases(now: number): Promise<number> {
    const leases = await this.readLeases();
    const wentOffline: WorkstationLeaseRecord[] = [];
    for (const [key, lease] of leases) {
      // Drop leases that have stayed offline well past their window so the DO
      // does not accumulate dead records.
      if (!lease.online && now - lease.lease_expires_at > WORKSTATION_LEASE_GC_MS) {
        await this.state.storage.delete(key);
        continue;
      }
      if (lease.online && lease.lease_expires_at <= now) {
        const offline: WorkstationLeaseRecord = {
          ...lease,
          online: false,
          offline_reason: "lease expired: no heartbeat within the lease window",
        };
        await this.state.storage.put(key, offline);
        wentOffline.push(offline);
        cloudLog("info", "fleet_registry.lease_expired", {
          owner_principal: lease.owner_principal,
          workstation_id: lease.workstation_id,
          counter: "fleet_registry_lease_expirations",
          counter_delta: 1,
        });
      }
    }
    await this.armLeaseAlarm();
    // Push the offline transition to any listeners, so the rail/toolbar learn
    // it went offline instead of inferring absence from a missed poll. The
    // registry reaches the socket-holding DO by fetch, never by holding a
    // socket itself.
    await this.notifyWentOffline(wentOffline);
    return wentOffline.length;
  }

  private async notifyWentOffline(leases: WorkstationLeaseRecord[]): Promise<void> {
    const namespace = this.env.WORKSTATION_EVENTS;
    if (!namespace || leases.length === 0) {
      return;
    }
    await Promise.allSettled(
      leases.map(async (lease) => {
        try {
          const id = namespace.idFromName(
            workstationEventsObjectName(lease.owner_principal, lease.workstation_id),
          );
          await namespace.get(id).fetch(
            new Request("https://workstation-events.internal/notify", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                event: "went_offline",
                workstation_id: lease.workstation_id,
                reason: lease.offline_reason ?? "went offline",
              }),
            }),
          );
        } catch (error) {
          cloudLog("warn", "fleet_registry.went_offline_notify_failed", {
            owner_principal: lease.owner_principal,
            workstation_id: lease.workstation_id,
            error: errorMessage(error),
            counter: "fleet_registry_went_offline_notify_failed",
            counter_delta: 1,
          });
        }
      }),
    );
  }

  private async handleUpsert(request: Request): Promise<Response> {
    const payload = await readJsonObject(request);
    if (payload instanceof Response) {
      return payload;
    }
    const summary = payload.summary;
    if (!isNotebookComputeSessionSummary(summary)) {
      return json({ error: "summary must be a valid notebook compute session summary" }, 400);
    }

    await this.state.storage.put(sessionKey(summary.notebook_id), summary);
    return json({ ok: true });
  }

  private async handleDelete(request: Request): Promise<Response> {
    const payload = await readJsonObject(request);
    if (payload instanceof Response) {
      return payload;
    }
    const notebookId = boundedString(payload.notebook_id ?? payload.notebookId, 160);
    if (!notebookId) {
      return json({ error: "notebook_id is required" }, 400);
    }
    await this.state.storage.delete(sessionKey(notebookId));
    return json({ ok: true });
  }

  private async handleList(request: Request): Promise<Response> {
    const payload = await readJsonObject(request);
    if (payload instanceof Response) {
      return payload;
    }
    const notebookIds = notebookIdsFromPayload(payload.notebook_ids ?? payload.notebookIds);
    if (!notebookIds) {
      return json({ error: "notebook_ids must be an array of notebook ids" }, 400);
    }

    const summaries: NotebookComputeSessionSummary[] = [];
    await Promise.all(
      notebookIds.map(async (notebookId) => {
        const summary = await this.state.storage.get<unknown>(sessionKey(notebookId));
        if (isNotebookComputeSessionSummary(summary)) {
          summaries.push(summary);
        }
      }),
    );
    summaries.sort((left, right) => left.notebook_id.localeCompare(right.notebook_id));
    return json({ ok: true, sessions: summaries });
  }
}

export function ownerComputeIndexObjectName(ownerPrincipal: string): string {
  return `${OWNER_COMPUTE_INDEX_OBJECT_PREFIX}${ownerPrincipal}`;
}

export async function upsertOwnerComputeSession(
  env: Env,
  summary: NotebookComputeSessionSummary,
): Promise<boolean> {
  const namespace = env.OWNER_COMPUTE_INDEX;
  if (!namespace) {
    return false;
  }
  return fetchOwnerComputeIndex(namespace, summary.owner_principal, "/upsert", { summary });
}

export async function deleteOwnerComputeSession(
  env: Env,
  ownerPrincipal: string,
  notebookId: string,
): Promise<boolean> {
  const namespace = env.OWNER_COMPUTE_INDEX;
  if (!namespace) {
    return false;
  }
  return fetchOwnerComputeIndex(namespace, ownerPrincipal, "/delete", {
    notebook_id: notebookId,
  });
}

export async function listOwnerComputeSessions(
  env: Env,
  ownerPrincipal: string,
  notebookIds: readonly string[],
): Promise<Map<string, NotebookComputeSessionSummary>> {
  const namespace = env.OWNER_COMPUTE_INDEX;
  if (!namespace || notebookIds.length === 0) {
    return new Map();
  }
  const boundedIds = Array.from(new Set(notebookIds.map((id) => id.trim()).filter(Boolean))).slice(
    0,
    MAX_NOTEBOOK_IDS_PER_LIST,
  );
  if (boundedIds.length === 0) {
    return new Map();
  }
  try {
    const response = await ownerComputeIndexStub(namespace, ownerPrincipal).fetch(
      new Request("https://owner-compute-index.internal/list", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notebook_ids: boundedIds }),
      }),
    );
    if (!response.ok) {
      cloudLog("warn", "owner_compute_index.list_failed", {
        owner_principal: ownerPrincipal,
        response_status: response.status,
        counter: "owner_compute_index_list_failed",
        counter_delta: 1,
      });
      return new Map();
    }
    const body = (await response.json()) as unknown;
    if (
      !body ||
      typeof body !== "object" ||
      !Array.isArray((body as { sessions?: unknown }).sessions)
    ) {
      return new Map();
    }
    const sessions = new Map<string, NotebookComputeSessionSummary>();
    for (const session of (body as { sessions: unknown[] }).sessions) {
      if (isNotebookComputeSessionSummary(session)) {
        sessions.set(session.notebook_id, session);
      }
    }
    return sessions;
  } catch (error) {
    cloudLog("warn", "owner_compute_index.list_failed", {
      owner_principal: ownerPrincipal,
      error: errorMessage(error),
      counter: "owner_compute_index_list_failed",
      counter_delta: 1,
    });
    return new Map();
  }
}

/**
 * Renew a workstation's liveness lease from the heartbeat path. Best-effort:
 * a registry write failure must not fail workstation registration, so callers
 * ignore the boolean beyond logging.
 */
export async function upsertWorkstationLease(
  env: Env,
  ownerPrincipal: string,
  workstationId: string,
  ttlMs: number,
): Promise<boolean> {
  const namespace = env.OWNER_COMPUTE_INDEX;
  if (!namespace) {
    return false;
  }
  try {
    const response = await ownerComputeIndexStub(namespace, ownerPrincipal).fetch(
      new Request("https://owner-compute-index.internal/lease/upsert", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workstation_id: workstationId,
          owner_principal: ownerPrincipal,
          ttl_ms: ttlMs,
        }),
      }),
    );
    if (response.ok) {
      return true;
    }
    cloudLog("warn", "fleet_registry.lease_upsert_failed", {
      owner_principal: ownerPrincipal,
      workstation_id: workstationId,
      response_status: response.status,
      counter: "fleet_registry_lease_upsert_failed",
      counter_delta: 1,
    });
  } catch (error) {
    cloudLog("warn", "fleet_registry.lease_upsert_failed", {
      owner_principal: ownerPrincipal,
      workstation_id: workstationId,
      error: errorMessage(error),
      counter: "fleet_registry_lease_upsert_failed",
      counter_delta: 1,
    });
  }
  return false;
}

/** Read every lease this owner holds, keyed by workstation id. */
export async function listWorkstationLeases(
  env: Env,
  ownerPrincipal: string,
): Promise<Map<string, WorkstationLeaseRecord>> {
  const namespace = env.OWNER_COMPUTE_INDEX;
  if (!namespace) {
    return new Map();
  }
  try {
    const response = await ownerComputeIndexStub(namespace, ownerPrincipal).fetch(
      new Request("https://owner-compute-index.internal/lease/list", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    if (!response.ok) {
      cloudLog("warn", "fleet_registry.lease_list_failed", {
        owner_principal: ownerPrincipal,
        response_status: response.status,
        counter: "fleet_registry_lease_list_failed",
        counter_delta: 1,
      });
      return new Map();
    }
    const body = (await response.json()) as unknown;
    const leases = new Map<string, WorkstationLeaseRecord>();
    if (body && typeof body === "object" && Array.isArray((body as { leases?: unknown }).leases)) {
      for (const entry of (body as { leases: unknown[] }).leases) {
        if (isWorkstationLeaseRecord(entry)) {
          leases.set(entry.workstation_id, entry);
        }
      }
    }
    return leases;
  } catch (error) {
    cloudLog("warn", "fleet_registry.lease_list_failed", {
      owner_principal: ownerPrincipal,
      error: errorMessage(error),
      counter: "fleet_registry_lease_list_failed",
      counter_delta: 1,
    });
    return new Map();
  }
}

function ownerComputeIndexStub(namespace: DurableObjectNamespace, ownerPrincipal: string) {
  const id = namespace.idFromName(ownerComputeIndexObjectName(ownerPrincipal));
  return namespace.get(id);
}

async function fetchOwnerComputeIndex(
  namespace: DurableObjectNamespace,
  ownerPrincipal: string,
  pathname: "/upsert" | "/delete",
  body: Record<string, unknown>,
): Promise<boolean> {
  try {
    const response = await ownerComputeIndexStub(namespace, ownerPrincipal).fetch(
      new Request(`https://owner-compute-index.internal${pathname}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    if (response.ok) {
      return true;
    }
    cloudLog("warn", "owner_compute_index.write_failed", {
      owner_principal: ownerPrincipal,
      pathname,
      response_status: response.status,
      counter: "owner_compute_index_write_failed",
      counter_delta: 1,
    });
  } catch (error) {
    cloudLog("warn", "owner_compute_index.write_failed", {
      owner_principal: ownerPrincipal,
      pathname,
      error: errorMessage(error),
      counter: "owner_compute_index_write_failed",
      counter_delta: 1,
    });
  }
  return false;
}

function sessionKey(notebookId: string): string {
  return `${COMPUTE_SESSION_KEY_PREFIX}${notebookId}`;
}

function leaseKey(workstationId: string): string {
  return `${WORKSTATION_LEASE_KEY_PREFIX}${workstationId}`;
}

function positiveInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return Math.floor(value);
}

function isWorkstationLeaseRecord(value: unknown): value is WorkstationLeaseRecord {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.workstation_id === "string" &&
    typeof record.owner_principal === "string" &&
    typeof record.last_seen_at === "string" &&
    typeof record.lease_expires_at === "number" &&
    typeof record.online === "boolean"
  );
}

async function readJsonObject(request: Request): Promise<Record<string, unknown> | Response> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    return json({ error: "body must be JSON" }, 400);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return json({ error: "body must be a JSON object" }, 400);
  }
  return value as Record<string, unknown>;
}

function notebookIdsFromPayload(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const ids: string[] = [];
  for (const entry of value) {
    const id = boundedString(entry, 160);
    if (id) {
      ids.push(id);
    }
    if (ids.length >= MAX_NOTEBOOK_IDS_PER_LIST) {
      break;
    }
  }
  return ids;
}

function boundedString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : null;
}
