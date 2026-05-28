import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createWidgetStore } from "../../../src/components/widgets/widget-store.ts";
import {
  projectCloudWidgetComms,
  type ProjectCloudWidgetCommsOptions,
} from "../viewer/widget-comm-projection.ts";
import type { SnapshotWidgetComm } from "../src/widget-comms.ts";

describe("cloud widget runtime projection", () => {
  it("does not delete previously projected models when async projection is cancelled", async () => {
    const store = createWidgetStore();
    store.createModel("comm-a", widgetState({ value: "old", payload: "old-payload" }));
    store.createModel("comm-b", widgetState({ value: "keep" }));
    const projectedCommIdsRef = { current: new Set(["comm-a", "comm-b"]) };
    const originalFetch = globalThis.fetch;
    let shouldContinue = true;

    globalThis.fetch = (async () => {
      shouldContinue = false;
      return new Response("new-payload");
    }) as typeof fetch;

    try {
      await projectCloudWidgetComms(
        store,
        [
          widgetComm("comm-a", {
            value: "new",
            payload: "https://cloud.test/api/n/demo/blobs/payload",
          }),
        ],
        projectedCommIdsRef,
        {
          isAllowedBlobUrl: (url) => url.startsWith("https://cloud.test/api/n/demo/blobs/"),
          shouldContinue: () => shouldContinue,
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(store.getModel("comm-a")?.state.value, "old");
    assert.equal(store.getModel("comm-a")?.state.payload, "old-payload");
    assert.equal(store.getModel("comm-b")?.state.value, "keep");
    assert.deepEqual([...projectedCommIdsRef.current].sort(), ["comm-a", "comm-b"]);
  });

  it("reconciles stale models after a complete projection pass", async () => {
    const store = createWidgetStore();
    store.createModel("comm-a", widgetState({ value: "old" }));
    store.createModel("comm-b", widgetState({ value: "stale" }));
    const projectedCommIdsRef = { current: new Set(["comm-a", "comm-b"]) };

    await projectCloudWidgetComms(
      store,
      [widgetComm("comm-a", { value: "new" })],
      projectedCommIdsRef,
      noBlobFetches(),
    );

    assert.equal(store.getModel("comm-a")?.state.value, "new");
    assert.equal(store.getModel("comm-b"), undefined);
    assert.deepEqual([...projectedCommIdsRef.current], ["comm-a"]);
  });
});

function widgetComm(commId: string, state: Record<string, unknown>): SnapshotWidgetComm {
  return {
    comm_id: commId,
    target_name: "jupyter.widget",
    model_module: "@jupyter-widgets/controls",
    model_name: "IntSliderModel",
    state: widgetState(state),
    text_paths: [["payload"]],
    seq: 0,
  };
}

function widgetState(state: Record<string, unknown>): Record<string, unknown> {
  return {
    _model_module: "@jupyter-widgets/controls",
    _model_name: "IntSliderModel",
    ...state,
  };
}

function noBlobFetches(): ProjectCloudWidgetCommsOptions {
  return {
    isAllowedBlobUrl: () => false,
  };
}
