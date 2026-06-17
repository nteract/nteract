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

const REQUEST_TIMEOUT_MS = 120_000;

export class McpPeer {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private stdout = "";
  private stderr = "";

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
    return await this.callToolJson("connect_notebook", { notebook_id: notebookId });
  }

  async createCell(source: string, cellType = "code"): Promise<string> {
    const text = await this.callToolText("create_cell", { source, cell_type: cellType });
    const match = text.match(/Created cell:\s*([^\s]+)/);
    if (!match) throw new Error(`create_cell did not return a cell id: ${text}`);
    return match[1];
  }

  async listComments(args: { cellId?: string; includeResolved?: boolean } = {}): Promise<unknown> {
    return await this.callToolJson("list_comments", {
      ...(args.cellId !== undefined ? { cell_id: args.cellId } : {}),
      ...(args.includeResolved !== undefined ? { include_resolved: args.includeResolved } : {}),
    });
  }

  async createCommentThread(
    body: string,
    anchor: Record<string, unknown> = { kind: "notebook" },
  ): Promise<unknown> {
    return await this.callToolJson("create_comment_thread", { anchor, body });
  }

  async replyCommentThread(threadId: string, body: string): Promise<unknown> {
    return await this.callToolJson("reply_comment_thread", { thread_id: threadId, body });
  }

  async resolveCommentThread(threadId: string): Promise<unknown> {
    return await this.callToolJson("resolve_comment_thread", { thread_id: threadId });
  }

  async reopenCommentThread(threadId: string): Promise<unknown> {
    return await this.callToolJson("reopen_comment_thread", { thread_id: threadId });
  }

  async setCell(cellId: string, source: string, andRun = false): Promise<unknown> {
    return await this.callToolJson("set_cell", {
      cell_id: cellId,
      source,
      and_run: andRun,
      timeout_secs: 120,
    });
  }

  async manageDependencies(dependencies: string[]): Promise<unknown> {
    return await this.callToolJson("manage_dependencies", {
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
    if (result.isError) throw new Error(`MCP tool ${name} failed: ${text}`);
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
