import type { DurableObjectNamespace, DurableObjectState, Env } from "./cloudflare-types.ts";
import { isNotebookComputeSessionSummary, type NotebookComputeSessionSummary } from "runtimed";
import { json } from "./http-responses.ts";
import { cloudLog, errorMessage } from "./observability.ts";

const COMPUTE_SESSION_KEY_PREFIX = "session:";
const OWNER_COMPUTE_INDEX_OBJECT_PREFIX = "owner-compute:v1:";
const MAX_NOTEBOOK_IDS_PER_LIST = 500;

export class OwnerComputeIndex {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {
    void this.env;
  }

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
    return json({ error: "not found" }, 404);
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
