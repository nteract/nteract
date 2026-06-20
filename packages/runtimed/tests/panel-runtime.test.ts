import { describe, expect, it } from "vite-plus/test";
import {
  NTERACT_PANEL_RUNTIME_MIME_TYPE,
  PANEL_RUNTIME_PROTOCOL,
  PANEL_RUNTIME_PROTOCOL_VERSION,
  isPanelRuntimeHostMessage,
  isPanelRuntimeIframeMessage,
  panelRuntimeChannelId,
  panelRuntimeEventFromHostMessage,
  panelRuntimeEventFromIframeMessage,
  type PanelRuntimeBlobRef,
} from "../src/panel-runtime";

describe("Panel runtime event model", () => {
  it("exports the nteract-owned marker MIME", () => {
    expect(NTERACT_PANEL_RUNTIME_MIME_TYPE).toBe("application/vnd.nteract.panel-runtime.v1+json");
  });

  it("derives a stable channel id from notebook output and Panel ids", () => {
    expect(
      panelRuntimeChannelId(
        { plotId: "plot 1", commId: "client/comm" },
        { cellId: "cell-a", outputIds: ["output-a"] },
      ),
    ).toBe("cell:cell-a|output:output-a|plot:plot%201|comm:client%2Fcomm");
  });

  it("normalizes browser-origin Panel patches into typed runtime events", () => {
    const blobRef: PanelRuntimeBlobRef = {
      blob: "sha256-buffer",
      size: 4096,
      media_type: "application/octet-stream",
    };

    const event = panelRuntimeEventFromIframeMessage(
      {
        type: "panel_client_patch",
        payload: {
          plotId: "p1011",
          commId: "client-comm",
          data: { events: [{ kind: "ModelChanged", attr: "value", new: 6 }] },
          metadata: { msgid: "patch-1" },
          buffers: [blobRef],
        },
      },
      {
        cellId: "panel-cell",
        executionCount: 7,
        outputIds: ["panel-output"],
      },
    );

    expect(event).toEqual({
      protocol: PANEL_RUNTIME_PROTOCOL,
      version: PANEL_RUNTIME_PROTOCOL_VERSION,
      direction: "iframe_to_kernel",
      type: "client_patch",
      channel: {
        channelId: "cell:panel-cell|output:panel-output|plot:p1011|comm:client-comm",
        commId: "client-comm",
        plotId: "p1011",
        cellId: "panel-cell",
        executionCount: 7,
        outputId: "panel-output",
        outputIds: ["panel-output"],
      },
      patch: {
        data: { events: [{ kind: "ModelChanged", attr: "value", new: 6 }] },
        metadata: { msgid: "patch-1" },
        buffers: [blobRef],
      },
    });
  });

  it("normalizes Python-origin ACKs without exposing raw comm envelopes", () => {
    const event = panelRuntimeEventFromHostMessage(
      {
        type: "panel_ack",
        payload: {
          plotId: "p1011",
          commId: "client-comm",
          metadata: {
            msg_type: "Ready",
            content: "\n\tcallback stdout",
          },
        },
      },
      { cellId: "panel-cell", outputIds: ["panel-output"] },
    );

    expect(event).toMatchObject({
      protocol: PANEL_RUNTIME_PROTOCOL,
      version: PANEL_RUNTIME_PROTOCOL_VERSION,
      direction: "kernel_to_iframe",
      type: "ack",
      channel: {
        channelId: "cell:panel-cell|output:panel-output|plot:p1011|comm:client-comm",
        commId: "client-comm",
      },
      ack: {
        msg_type: "Ready",
        content: "\n\tcallback stdout",
      },
    });
  });

  it("guards Panel runtime messages without accepting generic widget comm messages", () => {
    expect(
      isPanelRuntimeIframeMessage({
        type: "panel_client_patch",
        payload: { plotId: "p1011", commId: "client-comm" },
      }),
    ).toBe(true);
    expect(
      isPanelRuntimeHostMessage({
        type: "panel_server_patch",
        payload: { plotId: "p1011", commId: "server-comm" },
      }),
    ).toBe(true);

    expect(
      isPanelRuntimeIframeMessage({
        type: "widget_comm_msg",
        payload: { commId: "client-comm", data: {} },
      }),
    ).toBe(false);
    expect(
      isPanelRuntimeIframeMessage({
        type: "panel_client_patch",
        payload: { plotId: "p1011" },
      }),
    ).toBe(false);
  });
});
