import { beforeAll, describe, expect, it } from "vite-plus/test";
import type { BokehSessionState, KeyedDocFrame } from "runtimed";
import {
  BokehSessionDocHandle,
  encode_keyed_doc_frame,
  keyed_doc_frame_header,
} from "../../../../apps/notebook/src/wasm/runtimed-wasm/runtimed_wasm.js";
import { initializeRuntimedWasm } from "@/test/runtimed-wasm";
import {
  BOKEH_SESSION_DOC_KIND,
  type BokehSessionDocReplica,
  BokehSessionDocStore,
} from "../bokeh-session-doc-store";

const FRAME_TYPE = 0x0b;

/** Route a payload the way the sync engine's `keyedDocFrames$` does. */
function routed(payload: Uint8Array): KeyedDocFrame {
  const frame = new Uint8Array([FRAME_TYPE, ...payload]);
  const header = keyed_doc_frame_header(frame) as { kind: string; id: string; epoch: number };
  return { ...header, frame };
}

function record(epoch: number): BokehSessionState {
  return {
    output_id: "output-1",
    cell_id: "cell-1",
    execution_id: "execution-1",
    kernel_id: "kernel-1",
    status: "connected",
    producer_name: "panel",
    producer_version: "1.9.4",
    bokeh_version: "3.9.2",
    root_ids: [],
    epoch,
    doc_heads: [],
  };
}

/** Another peer's opening frame, as the hub would relay it. */
function peerFrame(sessionId: string, epoch: number): KeyedDocFrame {
  const peer = new BokehSessionDocHandle(sessionId, epoch, "user:test:peer/browser");
  const payload = peer.flush_sync();
  peer.free();
  if (!payload) throw new Error("an empty replica always asks for the document");
  return routed(payload);
}

describe("BokehSessionDocStore with the WASM handle", () => {
  beforeAll(async () => {
    await initializeRuntimedWasm();
  });

  it("drives real replicas: subscribe, route by header, follow newer epochs", async () => {
    const created: Array<{ epoch: number; handle: BokehSessionDocHandle }> = [];
    const sent: Uint8Array[] = [];
    const store = new BokehSessionDocStore({
      createReplica: (sessionId, epoch) => {
        const handle = new BokehSessionDocHandle(sessionId, epoch, "user:test:alice/browser");
        created.push({ epoch, handle });
        return handle as unknown as BokehSessionDocReplica;
      },
      sendFrame: async (payload) => {
        sent.push(payload);
      },
      fetchBlob: async () => new Response("null"),
    });
    store.updateSessions({ "session-1": record(1) });
    const updates: unknown[] = [];
    store.subscribe("session-1", (update) => updates.push(update));

    // Subscribing sends the replica's opening frame for the record's epoch.
    expect(created.map((entry) => entry.epoch)).toEqual([1]);
    expect(sent).toHaveLength(1);
    const { kind, id, epoch } = routed(sent[0]);
    expect({ kind, id, epoch }).toEqual({
      kind: BOKEH_SESSION_DOC_KIND,
      id: "session-1",
      epoch: 1,
    });
    expect(store.writeProps("session-1", { slider: { value: "1" } })).toEqual({
      status: "read_only",
    });
    expect(store.columnRefs("session-1", { source: null })).toBeNull();
    // The binding the store reads delta origins through.
    expect(created[0].handle.get_prop_origin("slider", "value")).toBeUndefined();

    // Older epochs and other sessions never reach the replica.
    store.receiveFrame(peerFrame("session-1", 0));
    store.receiveFrame(peerFrame("session-2", 1));
    expect(created).toHaveLength(1);

    // A frame for a newer epoch replaces the replica before RuntimeStateDoc says so.
    store.receiveFrame(peerFrame("session-1", 2));
    expect(created.map((entry) => entry.epoch)).toEqual([1, 2]);
    expect(created[1].handle.is_read_only()).toBe(false);

    store.updateSessions({ "session-1": { ...record(2), status: "disconnected" } });
    expect(created[1].handle.is_read_only()).toBe(true);

    // An undecodable sync body is dropped instead of throwing into the frame pipeline.
    store.receiveFrame(
      routed(
        encode_keyed_doc_frame(BOKEH_SESSION_DOC_KIND, "session-1", 2, new Uint8Array([1, 2])),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(updates).toEqual([]);
    store.dispose();
  });
});
