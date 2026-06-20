import { describe, expect, it } from "vitest";
import {
  applyWidgetCommBroadcastToStore,
  applyWidgetCommChangesToStore,
  RAW_COMM_BROADCAST_MARKER,
} from "../comm-changes-store-bridge";
import { createWidgetStore } from "../widget-store";

describe("comm changes store bridge", () => {
  it("applies opened, updated, and closed comm changes to a WidgetStore", () => {
    const store = createWidgetStore();
    const cleared: string[] = [];

    applyWidgetCommChangesToStore(store, {
      opened: [
        {
          commId: "comm-slider",
          targetName: "jupyter.widget",
          modelModule: "@jupyter-widgets/controls",
          modelName: "IntSliderModel",
          state: { value: 7 },
          bufferPaths: [],
          unresolvedOutputs: null,
        },
      ],
      updated: [],
      closed: [],
    });

    expect(store.getModel("comm-slider")?.state).toMatchObject({
      _model_module: "@jupyter-widgets/controls",
      _model_name: "IntSliderModel",
      value: 7,
    });
    expect(store.getModel("comm-slider")?.targetName).toBe("jupyter.widget");

    applyWidgetCommChangesToStore(store, {
      opened: [],
      updated: [
        {
          commId: "comm-slider",
          targetName: "hv-extension-comm",
          modelModule: "@jupyter-widgets/controls",
          modelName: "IntSliderModel",
          state: { value: 18 },
          bufferPaths: [],
          unresolvedOutputs: null,
        },
      ],
      closed: [],
    });

    expect(store.getModel("comm-slider")?.state.value).toBe(18);

    applyWidgetCommChangesToStore(
      store,
      {
        opened: [],
        updated: [],
        closed: ["comm-slider"],
      },
      { clearComm: (commId) => cleared.push(commId) },
    );

    expect(cleared).toEqual(["comm-slider"]);
    expect(store.getModel("comm-slider")).toBeUndefined();
  });

  it("creates a missing model from a live update using comm metadata", () => {
    const store = createWidgetStore();

    applyWidgetCommChangesToStore(store, {
      opened: [],
      updated: [
        {
          commId: "comm-slider",
          targetName: "hv-extension-comm",
          modelModule: "@jupyter-widgets/controls",
          modelName: "IntSliderModel",
          state: { value: 18 },
          bufferPaths: [],
          unresolvedOutputs: null,
        },
      ],
      closed: [],
    });

    const model = store.getModel("comm-slider");
    expect(model?.state.value).toBe(18);
    expect(model?.state._model_module).toBe("@jupyter-widgets/controls");
    expect(model?.state._model_name).toBe("IntSliderModel");
    expect(model?.targetName).toBe("hv-extension-comm");
  });

  it("suppresses optimistic echoes while keeping output resolution hooks", () => {
    const store = createWidgetStore();
    const resolvedOutputs: Array<{ commId: string; outputs: unknown[] }> = [];

    store.createModel("comm-output", { value: 7 });
    applyWidgetCommChangesToStore(
      store,
      {
        opened: [],
        updated: [
          {
            commId: "comm-output",
            targetName: "jupyter.widget",
            modelModule: "@jupyter-widgets/controls",
            modelName: "OutputModel",
            state: { value: 8 },
            bufferPaths: [],
            unresolvedOutputs: [{ output_type: "stream", text: "ok" }],
          },
        ],
        closed: [],
      },
      {
        shouldSuppressEcho: () => null,
        resolveOutputs: (commId, outputs) => resolvedOutputs.push({ commId, outputs }),
      },
    );

    expect(store.getModel("comm-output")?.state.value).toBe(7);
    expect(resolvedOutputs).toEqual([
      { commId: "comm-output", outputs: [{ output_type: "stream", text: "ok" }] },
    ]);
  });

  it("routes custom comm broadcasts as ephemeral WidgetStore messages", () => {
    const store = createWidgetStore();
    const messages: Array<{ content: Record<string, unknown>; buffers?: DataView[] }> = [];

    store.subscribeToCustomMessage("comm-button", (content, buffers) => {
      messages.push({ content, buffers });
    });

    applyWidgetCommBroadcastToStore(store, {
      event: "comm",
      msg_type: "comm_msg",
      content: {
        comm_id: "comm-button",
        data: {
          method: "custom",
          content: { event: "click" },
        },
      },
      buffers: [[1, 2, 3]],
    });

    expect(messages).toHaveLength(1);
    expect(messages[0].content).toEqual({ event: "click" });
    expect(messages[0].buffers?.[0].byteLength).toBe(3);
  });

  it("routes non-custom comm broadcasts as raw messages with metadata", () => {
    const store = createWidgetStore();
    const messages: Array<{ content: Record<string, unknown>; buffers?: DataView[] }> = [];

    store.subscribeToCustomMessage("panel-comm", (content, buffers) => {
      messages.push({ content, buffers });
    });

    applyWidgetCommBroadcastToStore(store, {
      event: "comm",
      msg_type: "comm_msg",
      content: {
        comm_id: "panel-comm",
        data: "PATCH-DOC",
      },
      metadata: { msg_type: "Ready" },
      buffers: [[4, 5, 6]],
    });

    expect(messages).toHaveLength(1);
    expect(messages[0].content).toEqual({
      [RAW_COMM_BROADCAST_MARKER]: true,
      data: "PATCH-DOC",
      metadata: { msg_type: "Ready" },
    });
    expect(messages[0].buffers?.[0].byteLength).toBe(3);
  });
});
