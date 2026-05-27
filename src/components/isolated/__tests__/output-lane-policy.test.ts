import { describe, expect, it } from "vite-plus/test";
import type { JupyterOutput } from "@/components/cell/jupyter-output";
import {
  anyOutputNeedsIsolation,
  hasWidgetOutputs,
  outputAllowsScrollPassthrough,
  outputSegmentLane,
  outputUsesSift,
  segmentedOutputLanes,
  selectedOutputMimeType,
  splitOutputSegments,
} from "../output-lane-policy";

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

  it("classifies static and interactive iframe outputs separately", () => {
    expect(outputSegmentLane(displayOutput("markdown-output", { "text/markdown": "# hi" }))).toBe(
      "static-frame",
    );
    expect(
      outputSegmentLane(displayOutput("plotly-output", { "application/vnd.plotly.v1+json": {} })),
    ).toBe("interactive-frame");
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
