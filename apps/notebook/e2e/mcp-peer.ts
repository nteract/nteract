import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface JsonRpcResponse {
  id?: number;
  result?: unknown;
  error?: { message?: string; code?: number; data?: unknown };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface CallToolResult {
  content?: Array<{ type?: string; text?: string }>;
  isError?: boolean;
}

interface ConnectResponse {
  notebook_handle?: string;
  capabilities?: { mutate?: boolean };
}

interface NotebookAttachment {
  readonly handle: string;
  readonly response: ConnectResponse;
}

class McpToolError extends Error {
  readonly code: string | undefined;

  constructor(name: string, text: string) {
    super(`MCP tool ${name} failed: ${text}`);
    try {
      this.code = (JSON.parse(text) as { error?: { code?: string } }).error?.code;
    } catch {
      this.code = undefined;
    }
  }
}

const REQUEST_TIMEOUT_MS = 120_000;

export class McpPeer {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private stdout = "";
  private stderr = "";
  // This E2E peer owns one attachment for its whole lifetime. It cannot be
  // repurposed as a process-wide "current notebook" router.
  private attachment:
    | { readonly notebookId: string; readonly ready: Promise<NotebookAttachment> }
    | undefined;

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.handleStdout(String(chunk)));
    child.stderr.on("data", (chunk) => {
      this.stderr += String(chunk);
    });
    child.on("exit", (code, signal) => {
      const reason = signal ? `signal ${signal}` : `exit code ${code}`;
      const error = new Error(`MCP peer exited unexpectedly (${reason})${this.stderrSuffix()}`);
      for (const [, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
    });
  }

  static async start(): Promise<McpPeer> {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
    const binary = path.join(repoRoot, "target", "debug", "runt");
    const command = process.env.NTERACT_BROWSER_E2E_MCP_COMMAND;
    const args = process.env.NTERACT_BROWSER_E2E_MCP_ARGS;

    const child =
      command !== undefined
        ? spawn(command, args === undefined ? [] : (JSON.parse(args) as string[]), {
            cwd: repoRoot,
            env: process.env,
          })
        : fs.existsSync(binary)
          ? spawn(binary, ["mcp", "--no-show"], { cwd: repoRoot, env: process.env })
          : spawn("cargo", ["run", "--quiet", "-p", "runt", "--", "mcp", "--no-show"], {
              cwd: repoRoot,
              env: process.env,
            });

    const peer = new McpPeer(child);
    await peer.initialize();
    return peer;
  }

  async connectNotebook(notebookId: string): Promise<unknown> {
    if (this.attachment) {
      if (this.attachment.notebookId !== notebookId) {
        throw new Error(
          "This MCP peer owns one notebook; start another peer for a different target",
        );
      }
    } else {
      this.attachment = Object.freeze({ notebookId, ready: this.acquireNotebook(notebookId) });
    }
    return (await this.attachment.ready).response;
  }

  private async acquireNotebook(notebookId: string): Promise<NotebookAttachment> {
    const response = (await this.callToolJson("connect_notebook", {
      notebook_id: notebookId,
    })) as ConnectResponse;
    const handle = response.notebook_handle;
    if (typeof handle !== "string" || !handle.trim()) {
      throw new Error(
        `connect_notebook did not return a notebook_handle: ${JSON.stringify(response)}`,
      );
    }
    const attachment = Object.freeze({ handle, response });
    if (response.capabilities?.mutate === true) return attachment;
    // One acquisition can return a projection before convergence. Poll that
    // owner's document; neither acquire another handle nor try a mutation.
    const deadline = Date.now() + 30_000;
    do {
      try {
        const cells = await this.callToolJson("get_all_cells", {
          notebook_handle: handle,
          format: "json",
        });
        // Interactive get_all_cells is a JSON array. A retained projection is
        // an object with explicit readiness, and does not authorize mutation.
        if (Array.isArray(cells)) return attachment;
        const readiness = (
          cells as {
            readiness?: { interactive?: boolean; capabilities?: { mutate?: boolean } };
          }
        )?.readiness;
        if (readiness?.interactive === true && readiness.capabilities?.mutate === true) {
          return attachment;
        }
      } catch (error) {
        if (
          !(error instanceof McpToolError) ||
          !["notebook_not_ready", "runtime_not_ready"].includes(error.code ?? "")
        ) {
          throw error;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    throw new Error(`Notebook attachment ${handle} did not become ready for mutations`);
  }

  async createCell(source: string, cellType = "code"): Promise<string> {
    const text = await this.callAttachmentToolText("create_cell", { source, cell_type: cellType });
    const match = text.match(/Created cell:\s*([^\s]+)/);
    if (!match) throw new Error(`create_cell did not return a cell id: ${text}`);
    return match[1];
  }

  async setCell(cellId: string, source: string, andRun = false): Promise<unknown> {
    return await this.callAttachmentToolJson("set_cell", {
      cell_id: cellId,
      source,
      and_run: andRun,
      timeout_secs: 120,
    });
  }

  async moveCell(cellId: string, afterCellId: string | null): Promise<unknown> {
    return this.callAttachmentToolText("move_cell", {
      cell_id: cellId,
      after_cell_id: afterCellId,
    });
  }

  async deleteCell(cellId: string): Promise<unknown> {
    return this.callAttachmentToolText("delete_cell", { cell_id: cellId });
  }

  async createComment(body: string, cellId?: string): Promise<string> {
    const text = await this.callAttachmentToolText("create_comment", {
      anchor: cellId ? { cell_id: cellId } : { notebook: true },
      body,
    });
    const match = text.match(/Created comment thread:\s*([^\s]+)/);
    if (!match) throw new Error(`create_comment did not return a thread id: ${text}`);
    return match[1];
  }

  async replyComment(threadId: string, body: string): Promise<unknown> {
    return await this.callAttachmentToolText("reply_comment", { thread_id: threadId, body });
  }

  async readCommentBodies(threadId: string): Promise<string[]> {
    const attachment = await this.requireAttachment();
    const result = (await this.request("resources/read", {
      uri: `nteract://sessions/${attachment.handle}/comments`,
    })) as { contents: Array<{ text: string }> };
    const projection = JSON.parse(result.contents[0].text) as {
      threads: Array<{ id: string; messages: Array<{ body: string }> }>;
    };
    return (
      projection.threads
        .find((thread) => thread.id === threadId)
        ?.messages.map((message) => message.body) ?? []
    );
  }

  async manageDependencies(dependencies: string[]): Promise<unknown> {
    return await this.callAttachmentToolJson("manage_dependencies", {
      add: dependencies,
      trust: true,
      apply: "sync",
    });
  }

  async close(): Promise<void> {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error("MCP peer closed"));
    }
    this.pending.clear();
    if (this.child.exitCode !== null) return;
    this.child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (this.child.exitCode === null) this.child.kill("SIGKILL");
        resolve();
      }, 1_000);
      this.child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private async initialize(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: {
        name: "notebook-browser-e2e",
        version: "0.0.0",
      },
    });
    this.notify("notifications/initialized", {});
  }

  private async callToolText(name: string, args: Record<string, unknown>): Promise<string> {
    const result = (await this.request("tools/call", {
      name,
      arguments: args,
    })) as CallToolResult;
    const text = result.content?.find((item) => item.type === "text")?.text ?? "";
    if (result.isError) throw new McpToolError(name, text);
    return text;
  }

  private async callToolJson(name: string, args: Record<string, unknown>): Promise<unknown> {
    const text = await this.callToolText(name, args);
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  private async requireAttachment(): Promise<NotebookAttachment> {
    if (!this.attachment) throw new Error("Connect a notebook before calling notebook tools");
    return this.attachment.ready;
  }

  private async callAttachmentToolText(
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const attachment = await this.requireAttachment();
    return this.callToolText(name, { ...args, notebook_handle: attachment.handle });
  }

  private async callAttachmentToolJson(
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const text = await this.callAttachmentToolText(name, args);
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    const message = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}${this.stderrSuffix()}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
    });
  }

  private notify(method: string, params: unknown): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  private handleStdout(chunk: string): void {
    this.stdout += chunk;
    let newline = this.stdout.indexOf("\n");
    while (newline !== -1) {
      const line = this.stdout.slice(0, newline).trim();
      this.stdout = this.stdout.slice(newline + 1);
      if (line) this.handleLine(line);
      newline = this.stdout.indexOf("\n");
    }
  }

  private handleLine(line: string): void {
    let response: JsonRpcResponse;
    try {
      response = JSON.parse(line) as JsonRpcResponse;
    } catch {
      return;
    }
    if (typeof response.id !== "number") return;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    clearTimeout(pending.timer);
    if (response.error) {
      pending.reject(
        new Error(
          `MCP error ${response.error.code ?? ""}: ${response.error.message ?? "unknown error"}`,
        ),
      );
      return;
    }
    pending.resolve(response.result);
  }

  private stderrSuffix(): string {
    const stderr = this.stderr.trim();
    return stderr ? `\n${stderr}` : "";
  }
}
