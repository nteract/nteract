import { afterEach, describe, expect, it } from "vite-plus/test";
import type { JupyterOutput } from "@/components/cell/jupyter-output";
import {
  MARKDOWN_PROJECTION_MIME_TYPE,
  setMarkdownProjectionProjector,
} from "@/lib/markdown-projection";
import {
  anyOutputNeedsIsolation,
  hasWidgetOutputs,
  outputAllowsScrollPassthrough,
  outputSegmentLane,
  outputUsesPlotly,
  outputUsesSift,
  outputUsesVega,
  outputUsesWheelOwningFrame,
  segmentedOutputLanes,
  selectedOutputMimeType,
  splitOutputSegments,
} from "../output-lane-policy";

let restoreMarkdownProjector: (() => void) | undefined;

function withMarkdownProjection(blockKind: string) {
  restoreMarkdownProjector?.();
  restoreMarkdownProjector = setMarkdownProjectionProjector((source) =>
    JSON.stringify(makeMarkdownProjectionPlan({ blockKind, source })),
  );
}

function makeMarkdownProjectionPlan({
  blockKind,
  source = "# hi",
}: {
  blockKind: string;
  source?: string;
}) {
  return {
    version: 1,
    engine: "test",
    byteLength: source.length,
    utf16Length: source.length,
    measurement: { estimatedHeight: 32, confidence: "high", width: 720 },
    blocks: [
      {
        anchorSlug: blockKind === "heading" ? "hi" : undefined,
        blockId: "b0",
        blockIndex: 0,
        element: blockKind === "heading" ? "h1" : "div",
        kind: blockKind,
        measurement: { estimatedHeight: 32, confidence: "high", width: 720 },
        sourceSpanByte: [0, source.length],
        sourceSpanUtf16: [0, source.length],
        syntaxSpans: [],
        text: source.replace(/^#+\s*/, ""),
      },
    ],
    runs:
      blockKind === "isolated"
        ? []
        : [
            {
              blockId: "b0",
              inlineId: "r0",
              listItemIndex: null,
              renderedText: source.replace(/^#+\s*/, ""),
              renderedTextUtf16: [0, source.length],
              semantic: "text",
              sourceSpanByte: [0, source.length],
              sourceSpanUtf16: [0, source.length],
            },
          ],
  };
}

function streamOutput(text = "hello\n"): JupyterOutput {
  return {
    output_id: "stream-output",
    output_type: "stream",
    name: "stdout",
    text,
  };
}

function displayOutput(output_id: string, data: Record<string, unknown>): JupyterOutput {
  return {
    output_id,
    output_type: "display_data",
    data,
    metadata: {},
  };
}

describe("output lane policy", () => {
  afterEach(() => {
    restoreMarkdownProjector?.();
    restoreMarkdownProjector = undefined;
  });

  it("selects richer Sift bytes before text fallbacks", () => {
    const output = displayOutput("table-output", {
      "text/html": "<table></table>",
      "application/vnd.apache.parquet": "http://localhost:47830/blob/table",
      "text/plain": "table fallback",
    });

    expect(selectedOutputMimeType(output)).toBe("application/vnd.apache.parquet");
    expect(outputUsesSift(output)).toBe(true);
    expect(outputAllowsScrollPassthrough(output)).toBe(true);
    expect(outputSegmentLane(output)).toBe("sift-frame");
  });

  it("renders projected markdown outputs in the host DOM when the plan is safe", () => {
    withMarkdownProjection("heading");

    expect(outputSegmentLane(displayOutput("markdown-output", { "text/markdown": "# hi" }))).toBe(
      "dom",
    );
    expect(
      anyOutputNeedsIsolation([displayOutput("markdown-output", { "text/markdown": "# hi" })]),
    ).toBe(false);
  });

  it("renders projected nteract markdown plans in the host DOM when safe", () => {
    expect(
      outputSegmentLane(
        displayOutput("markdown-plan-output", {
          [MARKDOWN_PROJECTION_MIME_TYPE]: makeMarkdownProjectionPlan({ blockKind: "heading" }),
        }),
      ),
    ).toBe("dom");
  });

  it("renders text/latex outputs in the host DOM", () => {
    expect(outputSegmentLane(displayOutput("latex-output", { "text/latex": "$x^2$" }))).toBe("dom");
    expect(
      anyOutputNeedsIsolation([displayOutput("latex-output", { "text/latex": "$x^2$" })]),
    ).toBe(false);
  });

  it("keeps markdown outputs with isolated blocks in the DOM fast path", () => {
    withMarkdownProjection("isolated");

    expect(
      outputSegmentLane(
        displayOutput("markdown-html-output", { "text/markdown": "<div>hi</div>" }),
      ),
    ).toBe("dom");
  });

  it("routes Plotly charts onto standalone click-to-engage frames", () => {
    const output = displayOutput("plotly-output", {
      "application/vnd.plotly.v1+json": {},
    });

    expect(outputUsesPlotly(output)).toBe(true);
    expect(outputUsesWheelOwningFrame(output)).toBe(true);
    expect(outputAllowsScrollPassthrough(output)).toBe(true);
    expect(outputSegmentLane(output)).toBe("plotly-frame");
  });

  it("classifies generic interactive iframe outputs separately", () => {
    expect(
      outputSegmentLane(
        displayOutput("widget-output", {
          "application/vnd.jupyter.widget-view+json": { model_id: "widget" },
        }),
      ),
    ).toBe("interactive-frame");
  });

  it("routes Vega/Altair charts onto the click-to-engage static frame", () => {
    const output = displayOutput("vega-output", {
      "application/vnd.vegalite.v5+json": { mark: "circle" },
    });

    expect(outputUsesVega(output)).toBe(true);
    expect(outputUsesSift(output)).toBe(false);
    expect(outputUsesWheelOwningFrame(output)).toBe(true);
    expect(outputAllowsScrollPassthrough(output)).toBe(true);
    expect(outputSegmentLane(output)).toBe("vega-frame");
  });

  it("keeps Bokeh's HTML and JavaScript display outputs in one document lane", () => {
    const outputs = [
      displayOutput("bokeh-loading-html", {
        "text/html": '<span id="bokeh-loading">Loading BokehJS ...</span>',
      }),
      displayOutput("bokeh-load-js", {
        "application/javascript": 'document.getElementById("bokeh-loading").textContent = "ok";',
        "application/vnd.bokehjs_load.v0+json": "",
      }),
      displayOutput("bokeh-root-html", {
        "text/html": '<div id="bokeh-root"></div>',
      }),
      displayOutput("bokeh-exec-js", {
        "application/javascript": 'document.getElementById("bokeh-root").textContent = "plot";',
        "application/vnd.bokehjs_exec.v0+json": "",
      }),
    ];

    const segments = splitOutputSegments(outputs);

    expect(outputs.map((output) => outputAllowsScrollPassthrough(output))).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(segments.map((segment) => segment.lane)).toEqual(["static-frame"]);
    expect(segments[0].outputs.map((output) => output.output_id)).toEqual([
      "bokeh-loading-html",
      "bokeh-load-js",
      "bokeh-root-html",
      "bokeh-exec-js",
    ]);
  });

  it("keeps pan/zoom charts standalone instead of coalescing with sibling document outputs", () => {
    withMarkdownProjection("isolated");
    const markdown = displayOutput("markdown-1", { "text/markdown": "# heading" });
    const plotly = displayOutput("plotly-1", {
      "application/vnd.plotly.v1+json": { data: [] },
    });
    const vegaOne = displayOutput("vega-1", {
      "application/vnd.vegalite.v5+json": { mark: "circle" },
    });
    const vegaTwo = displayOutput("vega-2", {
      "application/vnd.vega.v5+json": { mark: "bar" },
    });

    const segments = splitOutputSegments([markdown, plotly, vegaOne, vegaTwo]);

    expect(segments.map((segment) => segment.lane)).toEqual([
      "dom",
      "plotly-frame",
      "vega-frame",
      "vega-frame",
    ]);
    expect(segments.map((segment) => segment.outputs.map((output) => output.output_id))).toEqual([
      ["markdown-1"],
      ["plotly-1"],
      ["vega-1"],
      ["vega-2"],
    ]);
  });

  it("keeps DOM-safe outputs out of isolated lanes", () => {
    const outputs = [
      streamOutput(),
      displayOutput("plain-output", { "text/plain": "plain text" }),
      displayOutput("json-output", { "application/json": JSON.stringify({ ok: true }) }),
    ];

    expect(outputs.map((output) => outputSegmentLane(output))).toEqual(["dom", "dom", "dom"]);
    expect(anyOutputNeedsIsolation(outputs)).toBe(false);
  });

  it("does not mark display outputs without a selected MIME as scroll passthrough", () => {
    const output = displayOutput("empty-display", {
      "text/plain": null,
    });

    expect(selectedOutputMimeType(output)).toBeNull();
    expect(outputAllowsScrollPassthrough(output)).toBe(false);
    expect(outputSegmentLane(output)).toBe("dom");
  });

  it("segments adjacent compatible lanes while keeping Sift outputs standalone", () => {
    const widgetOne = displayOutput("widget-1", {
      "application/vnd.jupyter.widget-view+json": { model_id: "one" },
    });
    const widgetTwo = displayOutput("widget-2", {
      "application/vnd.jupyter.widget-view+json": { model_id: "two" },
    });
    const tableOne = displayOutput("table-1", {
      "application/vnd.apache.parquet": "http://localhost/blob/table-1",
    });
    const tableTwo = displayOutput("table-2", {
      "application/vnd.apache.parquet": "http://localhost/blob/table-2",
    });

    const segments = splitOutputSegments([
      streamOutput("one\n"),
      streamOutput("two\n"),
      widgetOne,
      widgetTwo,
      tableOne,
      tableTwo,
    ]);

    expect(segments.map((segment) => segment.lane)).toEqual([
      "dom",
      "interactive-frame",
      "sift-frame",
      "sift-frame",
    ]);
    expect(segments.map((segment) => segment.outputs.map((output) => output.output_id))).toEqual([
      ["stream-output", "stream-output"],
      ["widget-1", "widget-2"],
      ["table-1"],
      ["table-2"],
    ]);
    expect(hasWidgetOutputs(segments[1].outputs)).toBe(true);
  });

  it("keeps ordinary mixed output groups together when forced or collapsible", () => {
    const outputs = [
      streamOutput(),
      displayOutput("widget", {
        "application/vnd.jupyter.widget-view+json": { model_id: "widget" },
      }),
    ];

    expect(segmentedOutputLanes(outputs).map((segment) => segment.lane)).toEqual([
      "dom",
      "interactive-frame",
    ]);
    expect(segmentedOutputLanes(outputs, { isolated: true })).toEqual([]);
    expect(segmentedOutputLanes(outputs, { hasCollapseControl: true })).toEqual([]);
    expect(segmentedOutputLanes([outputs[1]])).toEqual([]);
  });

  it("still splits Sift into standalone boundaries when forced or collapsible", () => {
    const outputs = [
      streamOutput(),
      displayOutput("html", { "text/html": "<b>html</b>" }),
      displayOutput("table", {
        "application/vnd.apache.parquet": "http://localhost/blob/table",
      }),
    ];

    expect(
      segmentedOutputLanes(outputs, { isolated: true }).map((segment) => segment.lane),
    ).toEqual(["dom", "static-frame", "sift-frame"]);
    expect(
      segmentedOutputLanes(outputs, { hasCollapseControl: true }).map((segment) => segment.lane),
    ).toEqual(["dom", "static-frame", "sift-frame"]);
  });
});
