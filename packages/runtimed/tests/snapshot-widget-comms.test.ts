import { describe, expect, it } from "vite-plus/test";

import type { BlobRef, BlobResolver } from "../src";
import {
  resolveSnapshotWidgetComms,
  snapshotWidgetCommsFromRuntimeAndCommsState,
  type SnapshotWidgetComm,
} from "../src";

describe("snapshot widget comm projection", () => {
  it("preserves ordinary widget state objects with inline or blob properties", () => {
    const [comm] = resolveSnapshotWidgetComms(
      [
        widgetComm({
          layout: {
            inline: true,
            display: "flex",
          },
          marker: {
            blob: "not-a-content-ref",
          },
          payload: {
            blob: "also-not-a-content-ref",
            size: 3,
            extra: "state",
          },
        }),
      ],
      testBlobResolver,
    );

    expect(comm.state.layout).toEqual({ inline: true, display: "flex" });
    expect(comm.state.marker).toEqual({ blob: "not-a-content-ref" });
    expect(comm.state.payload).toEqual({
      blob: "also-not-a-content-ref",
      size: 3,
      extra: "state",
    });
    expect(comm.buffer_paths).toBeUndefined();
    expect(comm.text_paths).toBeUndefined();
  });

  it("resolves exact inline and blob ContentRef wrapper shapes", () => {
    const [comm] = resolveSnapshotWidgetComms(
      [
        widgetComm({
          label: { inline: "ready" },
          image: {
            blob: "image-hash",
            size: 24,
            media_type: "image/png",
          },
        }),
      ],
      testBlobResolver,
    );

    expect(comm.state.label).toBe("ready");
    expect(comm.state.image).toBe("https://cloud.test/blobs/image-hash");
    expect(comm.buffer_paths).toEqual([["image"]]);
  });

  it("merges CommsDoc state over legacy RuntimeStateDoc topology state", () => {
    const [comm] = snapshotWidgetCommsFromRuntimeAndCommsState(
      {
        comms: {
          comm: widgetComm({ value: 1 }),
        },
      },
      {
        comms: {
          comm: { value: 2 },
        },
      },
    );

    expect(comm.state.value).toBe(2);
  });
});

const testBlobResolver: BlobResolver = {
  url: (ref: BlobRef) => `https://cloud.test/blobs/${ref.blob}`,
  fetch: async (ref: BlobRef) => new Response(ref.blob),
};

function widgetComm(state: Record<string, unknown>): SnapshotWidgetComm {
  return {
    comm_id: "comm",
    target_name: "jupyter.widget",
    model_module: "@jupyter-widgets/controls",
    model_name: "IntSliderModel",
    state,
    seq: 0,
  };
}
