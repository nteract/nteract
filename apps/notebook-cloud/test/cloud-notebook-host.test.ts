import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { BlobResolver, NotebookTransport } from "runtimed";
import { createCloudNotebookHost } from "../viewer/cloud-notebook-host.ts";
import type { CloudSyncRuntime } from "../viewer/live-sync.ts";

describe("cloud notebook host", () => {
  it("delegates notebook requests to the current live runtime transport", async () => {
    const calls: string[] = [];
    const runtimeA = createRuntime("a", calls);
    const runtimeB = createRuntime("b", calls);
    let current: CloudSyncRuntime | null = null;
    const host = createCloudNotebookHost({
      blobResolver: fixtureBlobResolver,
      getRuntime: () => current,
    });

    assert.equal(host.transport.connected, false);
    await assert.rejects(
      host.transport.sendRequest({ type: "save_notebook", format_cells: false }),
      /hosted notebook is not connected/,
    );

    current = runtimeA;
    assert.equal(host.transport.connected, true);
    current = runtimeB;
    assert.deepEqual(
      await host.transport.sendRequest({ type: "save_notebook", format_cells: false }),
      {
        result: "b",
      },
    );
    await host.transport.sendFrame(1, new Uint8Array([1, 2, 3]));

    host.transport.disconnect();

    assert.deepEqual(calls, ["b:sendRequest:save_notebook", "b:sendFrame:1"]);
  });

  it("returns an immediate empty completion result without touching the room transport", async () => {
    const calls: string[] = [];
    const host = createCloudNotebookHost({
      blobResolver: fixtureBlobResolver,
      getRuntime: () => createRuntime("cloud", calls),
    });

    assert.deepEqual(
      await host.transport.sendRequest({ type: "complete", code: "pri", cursor_pos: 3 }),
      {
        result: "completion_result",
        items: [],
        cursor_start: 3,
        cursor_end: 3,
      },
    );
    assert.deepEqual(calls, []);
  });

  it("returns empty hosted completions even before the live room is connected", async () => {
    const host = createCloudNotebookHost({
      blobResolver: fixtureBlobResolver,
      getRuntime: () => null,
    });

    assert.deepEqual(
      await host.transport.sendRequest({ type: "complete", code: "", cursor_pos: 0 }),
      {
        result: "completion_result",
        items: [],
        cursor_start: 0,
        cursor_end: 0,
      },
    );
  });

  it("serves hosted history from the live notebook document without waiting on a runtime request", async () => {
    const calls: string[] = [];
    const host = createCloudNotebookHost({
      blobResolver: fixtureBlobResolver,
      getRuntime: () =>
        createRuntime("cloud", calls, {
          cells: [
            { id: "md-1", type: "markdown", source: "not history" },
            { id: "code-1", type: "code", source: "print('hello')" },
            { id: "code-2", type: "code", source: "import pandas as pd" },
            { id: "code-3", type: "code", source: "print('hello')" },
          ],
        }),
    });

    assert.deepEqual(
      await host.transport.sendRequest({
        type: "get_history",
        pattern: null,
        n: 10,
        unique: true,
      }),
      {
        result: "history_result",
        entries: [
          { session: 0, line: 1, source: "print('hello')" },
          { session: 0, line: 2, source: "import pandas as pd" },
        ],
      },
    );
    assert.deepEqual(
      await host.transport.sendRequest({
        type: "get_history",
        pattern: "*pandas*",
        n: 10,
        unique: true,
      }),
      {
        result: "history_result",
        entries: [{ session: 0, line: 1, source: "import pandas as pd" }],
      },
    );
    assert.deepEqual(calls, []);
  });

  it("exposes the cloud blob resolver without a local daemon port", async () => {
    const host = createCloudNotebookHost({
      blobResolver: fixtureBlobResolver,
      getRuntime: () => null,
    });

    assert.equal(await host.blobs.resolver(), fixtureBlobResolver);
    await assert.rejects(host.blobs.port(), /resolve blobs by URL/);
  });
});

const fixtureBlobResolver: BlobResolver = {
  url: (ref) => `https://example.test/blobs/${ref.blob}`,
  fetch: async (ref) => new Response(ref.blob),
};

function createRuntime(
  label: string,
  calls: string[],
  options: {
    cells?: Array<{ id: string; source: string; type: string }>;
  } = {},
): CloudSyncRuntime {
  const cells = options.cells ?? [];
  const transport: NotebookTransport = {
    connected: true,
    disconnect: () => {
      calls.push(`${label}:disconnect`);
    },
    onFrame: () => () => {},
    sendFrame: async (frameType) => {
      calls.push(`${label}:sendFrame:${frameType}`);
    },
    sendRequest: async (request) => {
      const type =
        typeof request === "object" &&
        request !== null &&
        "type" in request &&
        typeof request.type === "string"
          ? request.type
          : "unknown";
      calls.push(`${label}:sendRequest:${type}`);
      return { result: label };
    },
    sendTypedRequest: async () => ({ result: "ok" }),
  };

  return {
    handle: {
      get_cell_ids: () => cells.map((cell) => cell.id),
      get_cell_source: (cellId: string) => cells.find((cell) => cell.id === cellId)?.source ?? null,
      get_cell_type: (cellId: string) => cells.find((cell) => cell.id === cellId)?.type ?? null,
    },
    transport,
  } as CloudSyncRuntime;
}
