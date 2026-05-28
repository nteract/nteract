import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { BlobRef, BlobResolver } from "runtimed";
import { resolveSnapshotWidgetComms, type SnapshotWidgetComm } from "../src/widget-comms.ts";

describe("cloud widget comm projection", () => {
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

    assert.deepEqual(comm.state.layout, { inline: true, display: "flex" });
    assert.deepEqual(comm.state.marker, { blob: "not-a-content-ref" });
    assert.deepEqual(comm.state.payload, {
      blob: "also-not-a-content-ref",
      size: 3,
      extra: "state",
    });
    assert.equal(comm.buffer_paths, undefined);
    assert.equal(comm.text_paths, undefined);
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

    assert.equal(comm.state.label, "ready");
    assert.equal(comm.state.image, "https://cloud.test/blobs/image-hash");
    assert.deepEqual(comm.buffer_paths, [["image"]]);
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
