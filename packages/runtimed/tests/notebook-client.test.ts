import { EMPTY } from "rxjs";
import { NotebookClient, type NotebookTransport } from "runtimed";
import { describe, expect, it, vi } from "vite-plus/test";

function stubClient() {
  const sendRequest = vi.fn().mockResolvedValue({ result: "sync_environment_complete" });
  const transport = {
    sendFrame: async () => {},
    onFrame: () => () => {},
    sendRequest,
    sendTypedRequest: vi.fn(),
    connected: true,
    connectionStatus$: EMPTY,
    disconnect: () => {},
  } satisfies NotebookTransport;

  return { client: new NotebookClient({ transport }), sendRequest };
}

function stubClientWithHeads(heads: string[]) {
  const sendRequest = vi.fn().mockResolvedValue({ result: "cell_queued", execution_id: "exec-1" });
  const flush = vi.fn();
  const transport = {
    sendFrame: async () => {},
    onFrame: () => () => {},
    sendRequest,
    sendTypedRequest: vi.fn(),
    connected: true,
    connectionStatus$: EMPTY,
    disconnect: () => {},
  } satisfies NotebookTransport;

  return {
    client: new NotebookClient({
      transport,
      getRequiredHeads: () => heads,
      flushBeforeRequiredHeadsRequest: flush,
    }),
    flush,
    sendRequest,
  };
}

describe("NotebookClient", () => {
  it("emits unguarded sync_environment requests", async () => {
    const { client, sendRequest } = stubClient();

    await client.syncEnvironment();

    expect(sendRequest).toHaveBeenCalledWith({ type: "sync_environment" });
  });

  it("emits guarded sync_environment requests with dependency provenance", async () => {
    const { client, sendRequest } = stubClient();

    await client.syncEnvironment({
      observed_heads: ["head-a", "head-b"],
    });

    expect(sendRequest).toHaveBeenCalledWith({
      type: "sync_environment",
      guard: {
        observed_heads: ["head-a", "head-b"],
      },
    });
  });

  it("emits project environment approval requests", async () => {
    const { client, sendRequest } = stubClient();

    await client.approveProjectEnvironment("/tmp/project/environment.yml");

    expect(sendRequest).toHaveBeenCalledWith({
      type: "approve_project_environment",
      project_file_path: "/tmp/project/environment.yml",
    });
  });

  it("clones a notebook as an ephemeral room", async () => {
    const { client, sendRequest } = stubClient();
    sendRequest.mockResolvedValueOnce({
      result: "notebook_cloned",
      notebook_id: "clone-1",
      working_dir: "/tmp/project",
    });

    await expect(client.cloneAsEphemeral("source-1")).resolves.toEqual({
      notebookId: "clone-1",
      workingDir: "/tmp/project",
    });
    expect(sendRequest).toHaveBeenCalledWith({
      type: "clone_as_ephemeral",
      source_notebook_id: "source-1",
    });
  });

  it("attaches required heads to daemon-managed execute requests", async () => {
    const { client, flush, sendRequest } = stubClientWithHeads(["head-a"]);

    await client.executeCell("cell-1");

    expect(flush).toHaveBeenCalledOnce();
    expect(sendRequest).toHaveBeenCalledWith(
      { type: "execute_cell", cell_id: "cell-1" },
      { required_heads: ["head-a"] },
    );
  });

  it("passes caller-provided execution ids on daemon-managed execute requests", async () => {
    const { client, flush, sendRequest } = stubClientWithHeads(["head-a"]);
    const executionId = "11111111-1111-4111-8111-111111111111";

    await client.executeCell("cell-1", { executionId });

    expect(flush).toHaveBeenCalledOnce();
    expect(sendRequest).toHaveBeenCalledWith(
      { type: "execute_cell", cell_id: "cell-1", execution_id: executionId },
      { required_heads: ["head-a"] },
    );
  });

  it("passes caller-provided execution ids on guarded execute requests", async () => {
    const { client, sendRequest } = stubClient();
    const executionId = "22222222-2222-4222-8222-222222222222";

    await client.executeCellGuarded(
      "cell-1",
      { observed_heads: ["head-a", "head-b"] },
      { executionId },
    );

    expect(sendRequest).toHaveBeenCalledWith({
      type: "execute_cell_guarded",
      cell_id: "cell-1",
      execution_id: executionId,
      observed_heads: ["head-a", "head-b"],
    });
  });

  it("attaches required heads to daemon-managed run-all requests", async () => {
    const { client, flush, sendRequest } = stubClientWithHeads(["head-a", "head-b"]);

    await client.runAllCells();

    expect(flush).toHaveBeenCalledOnce();
    expect(sendRequest).toHaveBeenCalledWith(
      { type: "run_all_cells" },
      { required_heads: ["head-a", "head-b"] },
    );
  });

  it("sends small Bokeh buffers inline with stable buffer ids", async () => {
    const { client, sendRequest } = stubClient();
    sendRequest.mockResolvedValueOnce({
      result: "bokeh_session_patch",
      reply: {
        status: "accepted",
        session_id: "session-1",
        transaction_id: "tx-1",
        revision: 5,
      },
    });

    await expect(
      client.applyBokehSessionPatch({
        sessionId: "session-1",
        transactionId: "tx-1",
        baseRevision: 4,
        patch: { events: [] },
        buffers: [{ id: "buffer-1", data: new Uint8Array([1, 2, 3]) }],
      }),
    ).resolves.toEqual({
      status: "accepted",
      session_id: "session-1",
      transaction_id: "tx-1",
      revision: 5,
    });
    expect(sendRequest).toHaveBeenCalledWith({
      type: "apply_bokeh_session_patch",
      request: {
        session_id: "session-1",
        transaction_id: "tx-1",
        base_revision: 4,
        patch: { events: [] },
        buffers: [{ id: "buffer-1", data: [1, 2, 3] }],
        buffer_refs: [],
      },
    });
  });

  it("surfaces stale Bokeh revisions as typed replies", async () => {
    const { client, sendRequest } = stubClient();
    sendRequest.mockResolvedValueOnce({
      result: "bokeh_session_patch",
      reply: {
        status: "stale",
        session_id: "session-1",
        transaction_id: "tx-stale",
        revision: 9,
      },
    });

    await expect(
      client.applyBokehSessionPatch({
        sessionId: "session-1",
        transactionId: "tx-stale",
        baseRevision: 8,
        patch: { events: [] },
      }),
    ).resolves.toEqual({
      status: "stale",
      session_id: "session-1",
      transaction_id: "tx-stale",
      revision: 9,
    });
  });
});
