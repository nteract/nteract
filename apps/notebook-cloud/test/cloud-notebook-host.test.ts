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
      host.transport.sendRequest({ type: "get_history" }),
      /hosted notebook is not connected/,
    );

    current = runtimeA;
    assert.equal(host.transport.connected, true);
    assert.deepEqual(await host.transport.sendRequest({ type: "get_history" }), {
      result: "a",
    });

    current = runtimeB;
    assert.deepEqual(await host.transport.sendRequest({ type: "complete" }), {
      result: "b",
    });
    await host.transport.sendFrame(1, new Uint8Array([1, 2, 3]));

    host.transport.disconnect();

    assert.deepEqual(calls, [
      "a:sendRequest:get_history",
      "b:sendRequest:complete",
      "b:sendFrame:1",
    ]);
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

function createRuntime(label: string, calls: string[]): CloudSyncRuntime {
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

  return { transport } as CloudSyncRuntime;
}
