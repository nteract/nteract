import type { CellResult, Session } from "@runtimed/node";
import { describe, expect, it, vi } from "vitest";

import {
  RuntimedSessionRegistry,
  serializeRunSourceResult,
  type RuntimeBindings,
} from "../src/core.js";

function cellResult(overrides: Partial<CellResult> = {}): CellResult {
  return {
    cellId: "cell-1",
    executionId: "execution-1",
    executionCount: 3,
    status: "done",
    success: true,
    outputs: [
      {
        outputType: "execute_result",
        dataJson: JSON.stringify({ "text/plain": "42" }),
      },
    ],
    ...overrides,
  };
}

function fakeRuntime() {
  const runCell = vi.fn(async () => cellResult());
  const close = vi.fn(async () => undefined);
  const session = { runCell, close } as unknown as Session;
  const openNotebook = vi.fn(async () => session);
  const bindings: RuntimeBindings = { openNotebook };
  return { bindings, session, runCell, close, openNotebook };
}

describe("RuntimedSessionRegistry", () => {
  it("opens once per agent and notebook, then executes synced cells", async () => {
    const runtime = fakeRuntime();
    const registry = new RuntimedSessionRegistry({
      socketPath: "/tmp/runtimed.sock",
      loadBindings: async () => runtime.bindings,
    });

    const first = await registry.runSource({
      agentSessionId: "agent-1",
      notebookId: "notebook-1",
      source: "21 * 2",
    });
    await registry.runSource({
      agentSessionId: "agent-1",
      notebookId: "notebook-1",
      source: "6 * 7",
      timeoutMs: 5_000,
    });

    expect(runtime.openNotebook).toHaveBeenCalledOnce();
    expect(runtime.openNotebook).toHaveBeenCalledWith("notebook-1", {
      socketPath: "/tmp/runtimed.sock",
      peerLabel: "runtimed-agent-tools:agent-1",
      description: "OpenCode/Kilo notebook tool session",
    });
    expect(runtime.runCell).toHaveBeenNthCalledWith(1, "21 * 2", {
      timeoutMs: undefined,
    });
    expect(runtime.runCell).toHaveBeenNthCalledWith(2, "6 * 7", {
      timeoutMs: 5_000,
    });
    expect(first).toEqual({
      notebook_id: "notebook-1",
      cell_id: "cell-1",
      execution_id: "execution-1",
      execution_count: 3,
      status: "done",
      success: true,
      outputs: [
        {
          output_type: "execute_result",
          data: { "text/plain": "42" },
        },
      ],
    });
  });

  it("isolates notebooks across agent sessions and closes their handles", async () => {
    const runtime = fakeRuntime();
    const registry = new RuntimedSessionRegistry({
      loadBindings: async () => runtime.bindings,
    });

    await registry.runSource({
      agentSessionId: "agent-1",
      notebookId: "notebook-1",
      source: "1",
    });
    await registry.runSource({
      agentSessionId: "agent-2",
      notebookId: "notebook-1",
      source: "2",
    });
    await registry.disposeAgentSession("agent-1");

    expect(runtime.openNotebook).toHaveBeenCalledTimes(2);
    expect(runtime.close).toHaveBeenCalledOnce();

    await registry.disposeAll();
    expect(runtime.close).toHaveBeenCalledTimes(2);
  });

  it("serializes a stable JSON tool response", () => {
    expect(
      JSON.parse(
        serializeRunSourceResult({
          notebook_id: "notebook-1",
          cell_id: "cell-1",
          execution_id: "execution-1",
          status: "done",
          success: true,
          outputs: [],
        }),
      ),
    ).toEqual({
      notebook_id: "notebook-1",
      cell_id: "cell-1",
      execution_id: "execution-1",
      status: "done",
      success: true,
      outputs: [],
    });
  });
});
