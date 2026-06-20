import { describe, expect, it } from "vite-plus/test";
import type { IdentifiedJupyterOutput } from "../output-payloads";
import { jupyterOutputToRenderPayload } from "../output-payloads";
import { BOKEHJS_EXEC_MIME_TYPE, BOKEHJS_LOAD_MIME_TYPE } from "@/components/outputs/bokeh-mime";
import {
  NTERACT_PANEL_RUNTIME_MIME_TYPE,
  PANEL_EXEC_MIME_TYPE,
} from "@/components/outputs/panel-mime";

describe("isolated output payload conversion", () => {
  it("remaps Bokeh load bundles to the Bokeh MIME while preserving sibling JavaScript", () => {
    const output: IdentifiedJupyterOutput = {
      output_id: "bokeh-load",
      output_type: "display_data",
      data: {
        "application/javascript": "window.Bokeh = {};",
        [BOKEHJS_LOAD_MIME_TYPE]: "",
      },
      metadata: {},
    };

    expect(jupyterOutputToRenderPayload(output, 0)).toEqual(
      expect.objectContaining({
        data: {
          "application/javascript": "window.Bokeh = {};",
          "text/html": undefined,
          [BOKEHJS_LOAD_MIME_TYPE]: "",
        },
        mimeType: BOKEHJS_LOAD_MIME_TYPE,
        outputId: "bokeh-load",
      }),
    );
  });

  it("remaps Bokeh exec bundles to the Bokeh MIME while preserving sibling HTML and JavaScript", () => {
    const output: IdentifiedJupyterOutput = {
      output_id: "bokeh-exec",
      output_type: "display_data",
      data: {
        "text/html": "<script>server output</script>",
        "application/javascript": "window.__bokehExecRan = true;",
        [BOKEHJS_EXEC_MIME_TYPE]: "",
      },
      metadata: {
        [BOKEHJS_EXEC_MIME_TYPE]: { id: "p1011" },
      },
    };

    expect(jupyterOutputToRenderPayload(output, 1)).toEqual(
      expect.objectContaining({
        data: {
          "application/javascript": "window.__bokehExecRan = true;",
          "text/html": "<script>server output</script>",
          [BOKEHJS_EXEC_MIME_TYPE]: "",
        },
        metadata: { id: "p1011" },
        mimeType: BOKEHJS_EXEC_MIME_TYPE,
        outputId: "bokeh-exec",
        outputIndex: 1,
      }),
    );
  });

  it("remaps Panel exec bundles to the Panel MIME while preserving sibling HTML and JavaScript", () => {
    const output: IdentifiedJupyterOutput = {
      output_id: "panel-exec",
      output_type: "display_data",
      data: {
        "text/html": '<div id="panel-root"></div><script>window.__panelHtmlRan = true;</script>',
        "application/javascript": "window.__panelExecRan = true;",
        [PANEL_EXEC_MIME_TYPE]: "",
      },
      metadata: {
        [PANEL_EXEC_MIME_TYPE]: { id: "p1011" },
      },
    };

    expect(jupyterOutputToRenderPayload(output, 1)).toEqual(
      expect.objectContaining({
        data: {
          "application/javascript": "window.__panelExecRan = true;",
          "text/html": '<div id="panel-root"></div><script>window.__panelHtmlRan = true;</script>',
          [PANEL_EXEC_MIME_TYPE]: "",
        },
        metadata: { id: "p1011" },
        mimeType: PANEL_EXEC_MIME_TYPE,
        outputId: "panel-exec",
        outputIndex: 1,
      }),
    );
  });

  it("remaps nteract Panel runtime bundles while preserving sibling HTML and JavaScript", () => {
    const output: IdentifiedJupyterOutput = {
      output_id: "panel-runtime",
      output_type: "display_data",
      data: {
        "text/html": '<div id="panel-root"></div><script>window.__panelHtmlRan = true;</script>',
        "application/javascript": "window.__panelRuntimeRan = true;",
        [NTERACT_PANEL_RUNTIME_MIME_TYPE]: { version: 1, channel_id: "panel-1" },
        [PANEL_EXEC_MIME_TYPE]: "",
      },
      metadata: {
        [NTERACT_PANEL_RUNTIME_MIME_TYPE]: { id: "doc-1" },
        [PANEL_EXEC_MIME_TYPE]: { id: "legacy-doc" },
      },
    };

    expect(jupyterOutputToRenderPayload(output, 1)).toEqual(
      expect.objectContaining({
        data: {
          "application/javascript": "window.__panelRuntimeRan = true;",
          "text/html": '<div id="panel-root"></div><script>window.__panelHtmlRan = true;</script>',
          [NTERACT_PANEL_RUNTIME_MIME_TYPE]: { version: 1, channel_id: "panel-1" },
        },
        metadata: { id: "doc-1" },
        mimeType: NTERACT_PANEL_RUNTIME_MIME_TYPE,
        outputId: "panel-runtime",
        outputIndex: 1,
      }),
    );
  });
});
