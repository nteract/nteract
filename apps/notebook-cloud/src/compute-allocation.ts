import type { DurableObjectState, Env } from "./cloudflare-types.ts";
import { managedPythonStub } from "./managed-python.ts";
import { cloudLog } from "./observability.ts";
import { PROVIDER_ORPHAN_IDLE_MS } from "../../preview-python/src/lifecycle-policy.js";

export interface AllocationIdentity {
  ownerPrincipal: string;
  notebookId: string;
  sessionId: string;
}

interface Allocation extends AllocationIdentity {
  version: 1;
  provider: "celld-pyodide";
  desired: "running" | "released";
  phase: "allocating" | "ready" | "releasing" | "released" | "failed";
  requestedAt: number;
  updatedAt: number;
  error?: string;
}

const RECORD = "allocation-v1";
const RECONCILE_MS = 60_000;

class ProviderRejected extends Error {}
class SessionLost extends Error {}

export function allocationObjectName(identity: AllocationIdentity): string {
  return JSON.stringify([identity.ownerPrincipal, identity.notebookId, identity.sessionId]);
}

export function computeAllocationStub(env: Env, identity: AllocationIdentity) {
  if (!managedPythonStub(env) || !env.COMPUTE_ALLOCATIONS) return null;
  return env.COMPUTE_ALLOCATIONS.get(
    env.COMPUTE_ALLOCATIONS.idFromName(allocationObjectName(identity)),
  );
}

/** Private resource lifecycle only. Execution and Automerge never pass through this object. */
export class ComputeAllocation {
  private mutations: Promise<unknown> = Promise.resolve();
  private reconciling: Promise<void> | undefined;

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.mutations.then(operation);
    this.mutations = next.catch(() => undefined);
    return next;
  }

  private async schedule(): Promise<void> {
    if (!this.state.storage.setAlarm) throw new Error("Allocation alarms are unavailable");
    await this.state.storage.setAlarm(Date.now() + RECONCILE_MS);
  }

  private async save(record: Allocation): Promise<void> {
    const previous = await this.state.storage.get<Allocation>(RECORD);
    // Arm recovery before a side effect can escape its durable intent.
    if (!["released", "failed"].includes(record.phase)) await this.schedule();
    await this.state.storage.put(RECORD, { ...record, updatedAt: Date.now() });
    if (previous?.phase !== record.phase)
      cloudLog("info", "compute_allocation_phase", {
        notebook_id: record.notebookId,
        session_id: record.sessionId,
        provider: record.provider,
        phase: record.phase,
      });
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method !== "POST" || !["/ensure", "/release", "/status"].includes(path))
      return new Response("Not found", { status: 404 });
    const text = await request.text();
    if (text.length > 4096) return new Response("Request too large", { status: 413 });
    let identity: AllocationIdentity;
    try {
      const input = JSON.parse(text);
      const fields = [input?.ownerPrincipal, input?.notebookId, input?.sessionId];
      if (fields.some((part) => typeof part !== "string" || !part || part.length > 512))
        throw new Error("Invalid allocation identity");
      identity = { ownerPrincipal: fields[0], notebookId: fields[1], sessionId: fields[2] };
    } catch {
      return new Response("Invalid allocation identity", { status: 400 });
    }
    try {
      const record = await this.mutate(async () => {
        let current = await this.state.storage.get<Allocation>(RECORD);
        if (current && allocationObjectName(current) !== allocationObjectName(identity))
          throw new Error("Allocation identity mismatch");
        if (!current && path === "/status") return undefined;
        current ??= {
          ...identity,
          version: 1,
          provider: "celld-pyodide",
          desired: "running",
          phase: "allocating",
          requestedAt: Date.now(),
          updatedAt: Date.now(),
        };
        if (path === "/release" && !["released", "failed"].includes(current.phase)) {
          current = { ...current, desired: "released", phase: "releasing" };
        }
        if (path !== "/status") await this.save(current);
        return current;
      });
      if (!record) return Response.json({ allocation: null });
      if (path === "/ensure") {
        if (record.desired === "released")
          throw new Error(record.error ?? "Allocation released; restart to continue");
        await this.reconcile();
      } else if (path === "/release") {
        // Do not wait behind an in-flight open. Provider close fences that
        // identity first and destroys a late interpreter before acknowledging.
        await this.release();
      }
      const latest = await this.state.storage.get<Allocation>(RECORD);
      if (path === "/ensure" && latest?.phase !== "ready")
        throw new Error(latest?.error ?? "Allocation was released during startup");
      return Response.json({ allocation: latest });
    } catch (error) {
      return Response.json(
        {
          error: String(error)
            .replace(/^Error: /, "")
            .slice(0, 1000),
        },
        { status: 409 },
      );
    }
  }

  private async provider(path: string, record: Allocation): Promise<Record<string, unknown>> {
    const provider = managedPythonStub(this.env);
    if (!provider) throw new Error("Managed Python provider unavailable");
    const response = await provider.fetch(
      new Request(`https://preview-python.internal${path}`, {
        method: "POST",
        body: JSON.stringify({
          ownerPrincipal: record.ownerPrincipal,
          notebookId: record.notebookId,
          sessionId: record.sessionId,
        }),
      }),
    );
    if (!response.ok) {
      let message = (await response.text()).slice(0, 1000);
      try {
        const body = JSON.parse(message);
        if (typeof body.error === "string") message = body.error;
      } catch {
        // Providers may return plain text for malformed requests.
      }
      message = message.replace(/^Error: /, "");
      // Admission rejection is definite. Transport and server failures leave
      // resource state uncertain and must be retried with the same identity.
      const ErrorType = response.status < 500 ? ProviderRejected : Error;
      throw new ErrorType(message);
    }
    return response.json();
  }

  private reconcile(): Promise<void> {
    this.reconciling ??= this.reconcileNow().finally(() => {
      this.reconciling = undefined;
    });
    // Retain the recovery operation even if the requesting room disconnects.
    this.state.waitUntil(this.reconciling.catch(() => undefined));
    return this.reconciling;
  }

  private async reconcileNow(): Promise<void> {
    const record = await this.state.storage.get<Allocation>(RECORD);
    if (!record || ["released", "failed"].includes(record.phase)) return;
    if (record.desired === "released") return this.release();
    let inspecting = false;
    try {
      if (record.phase === "allocating") {
        await this.provider("/open", record);
      } else {
        inspecting = true;
        const status = await this.provider("/inspect", record);
        if (status.phase === "absent" || status.phase === "releasing")
          throw new SessionLost("Python session was lost; restart to continue");
        if (status.phase !== "ready") throw new Error("Python session status is uncertain");
        inspecting = false;
        if (
          status.busy !== true &&
          typeof status.lastUsed === "number" &&
          Date.now() - status.lastUsed >= PROVIDER_ORPHAN_IDLE_MS
        ) {
          await this.mutate(async () => {
            const current = await this.state.storage.get<Allocation>(RECORD);
            if (current?.desired === "running")
              await this.save({ ...current, desired: "released", phase: "releasing" });
          });
          return this.release();
        }
      }
      const released = await this.mutate(async () => {
        const current = await this.state.storage.get<Allocation>(RECORD);
        if (!current || current.desired !== "running") return true;
        await this.save({ ...current, phase: "ready" });
        return false;
      });
      if (released) await this.release();
    } catch (error) {
      if (
        !(error instanceof SessionLost) &&
        !(record.phase === "allocating" && error instanceof ProviderRejected)
      ) {
        if (inspecting) {
          // Reattachment uses the last confirmed allocation. An inconclusive
          // health probe must not send the room down its startup-failed cleanup
          // path and destroy a used interpreter. The alarm retries inspection;
          // executions still reach the existing session directly.
          cloudLog("warn", "compute_allocation_inspection_deferred", {
            notebook_id: record.notebookId,
            session_id: record.sessionId,
            error: String(error).slice(0, 1000),
          });
          return;
        }
        throw error;
      }
      await this.mutate(async () => {
        const current = await this.state.storage.get<Allocation>(RECORD);
        if (current?.desired === "running")
          await this.save({
            ...current,
            desired: "released",
            phase: "releasing",
            error: String(error).slice(0, 1000),
          });
      });
      await this.release();
      throw error;
    }
  }

  private async release(): Promise<void> {
    const record = await this.state.storage.get<Allocation>(RECORD);
    if (!record || ["released", "failed"].includes(record.phase)) return;
    await this.provider("/close", record);
    await this.mutate(async () => {
      const current = await this.state.storage.get<Allocation>(RECORD);
      if (current?.desired === "released")
        await this.save({ ...current, phase: current.error ? "failed" : "released" });
    });
  }

  async alarm(): Promise<void> {
    // Re-arm before I/O: uncertain closes remain cleanup obligations.
    const record = await this.state.storage.get<Allocation>(RECORD);
    if (!record || ["released", "failed"].includes(record.phase)) return;
    await this.schedule();
    await this.reconcile();
  }
}
