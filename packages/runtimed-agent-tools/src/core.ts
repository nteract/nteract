import type { CellResult, JsOutput, OpenNotebookOptions, Session } from "@runtimed/node";

export interface RuntimeBindings {
  openNotebook(notebookId: string, options?: OpenNotebookOptions): Promise<Session>;
}

export interface RunSourceInput {
  agentSessionId: string;
  notebookId: string;
  source: string;
  timeoutMs?: number;
}

export interface RunSourceResult {
  notebook_id: string;
  cell_id: string;
  execution_id: string;
  execution_count?: number;
  status: string;
  success: boolean;
  outputs: Array<Record<string, unknown>>;
}

export interface RuntimedSessionRegistryOptions {
  socketPath?: string;
  peerLabelPrefix?: string;
  loadBindings?: () => Promise<RuntimeBindings>;
}

type SessionEntry = {
  agentSessionId: string;
  session: Promise<Session>;
};

const DEFAULT_PEER_LABEL_PREFIX = "runtimed-agent-tools";

export class RuntimedSessionRegistry {
  readonly #socketPath?: string;
  readonly #peerLabelPrefix: string;
  readonly #loadBindings: () => Promise<RuntimeBindings>;
  readonly #sessions = new Map<string, SessionEntry>();

  constructor(options: RuntimedSessionRegistryOptions = {}) {
    this.#socketPath = options.socketPath;
    this.#peerLabelPrefix = options.peerLabelPrefix ?? DEFAULT_PEER_LABEL_PREFIX;
    this.#loadBindings = options.loadBindings ?? loadRuntimeBindings;
  }

  async runSource(input: RunSourceInput): Promise<RunSourceResult> {
    const agentSessionId = requiredString(input.agentSessionId, "agentSessionId");
    const notebookId = requiredString(input.notebookId, "notebookId");
    const source = requiredString(input.source, "source", false);
    const session = await this.#getSession(agentSessionId, notebookId);
    const result = await session.runCell(source, { timeoutMs: input.timeoutMs });
    return normalizeResult(notebookId, result);
  }

  async disposeAgentSession(agentSessionId: string): Promise<void> {
    const pending: Promise<Session>[] = [];
    for (const [key, entry] of this.#sessions) {
      if (entry.agentSessionId !== agentSessionId) continue;
      this.#sessions.delete(key);
      pending.push(entry.session);
    }
    await closeSessions(pending);
  }

  async disposeAll(): Promise<void> {
    const pending = Array.from(this.#sessions.values(), (entry) => entry.session);
    this.#sessions.clear();
    await closeSessions(pending);
  }

  async #getSession(agentSessionId: string, notebookId: string): Promise<Session> {
    const key = sessionKey(agentSessionId, notebookId);
    const existing = this.#sessions.get(key);
    if (existing) return existing.session;

    const session = this.#openSession(agentSessionId, notebookId);
    this.#sessions.set(key, { agentSessionId, session });
    try {
      return await session;
    } catch (error) {
      this.#sessions.delete(key);
      throw error;
    }
  }

  async #openSession(agentSessionId: string, notebookId: string): Promise<Session> {
    const bindings = await this.#loadBindings();
    return bindings.openNotebook(notebookId, {
      socketPath: this.#socketPath,
      peerLabel: `${this.#peerLabelPrefix}:${agentSessionId}`,
      description: "OpenCode/Kilo notebook tool session",
    });
  }
}

export function serializeRunSourceResult(result: RunSourceResult): string {
  return JSON.stringify(result);
}

async function loadRuntimeBindings(): Promise<RuntimeBindings> {
  const imported = (await import("@runtimed/node")) as unknown as {
    default?: RuntimeBindings;
    openNotebook?: RuntimeBindings["openNotebook"];
  };
  if (typeof imported.openNotebook === "function") {
    return imported as RuntimeBindings;
  }
  if (typeof imported.default?.openNotebook === "function") {
    return imported.default;
  }
  throw new Error("@runtimed/node did not expose openNotebook");
}

function sessionKey(agentSessionId: string, notebookId: string): string {
  return `${agentSessionId}\u0000${notebookId}`;
}

function requiredString(value: string, name: string, trim = true): string {
  if (typeof value !== "string" || (trim ? value.trim() : value).length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return trim ? value.trim() : value;
}

function normalizeResult(notebookId: string, result: CellResult): RunSourceResult {
  return {
    notebook_id: notebookId,
    cell_id: result.cellId,
    execution_id: result.executionId,
    ...(result.executionCount === undefined ? {} : { execution_count: result.executionCount }),
    status: result.status,
    success: result.success,
    outputs: result.outputs.map(normalizeOutput),
  };
}

function normalizeOutput(output: JsOutput): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries({
      output_type: output.outputType,
      name: output.name,
      text: output.text,
      data: parseJson(output.dataJson),
      ename: output.ename,
      evalue: output.evalue,
      traceback: output.traceback,
      execution_count: output.executionCount,
      blob_urls: parseJson(output.blobUrlsJson),
      blob_paths: parseJson(output.blobPathsJson),
    }).filter(([, value]) => value !== undefined),
  );
}

function parseJson(value: string | undefined): unknown {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

async function closeSessions(pending: Promise<Session>[]): Promise<void> {
  const sessions = await Promise.allSettled(pending);
  await Promise.allSettled(
    sessions.flatMap((result) => (result.status === "fulfilled" ? [result.value.close()] : [])),
  );
}
