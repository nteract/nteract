import { describe, expect, it } from "vite-plus/test";
import { classifyOutputShape } from "../output-shape";
import type { JupyterOutput } from "../jupyter-output";

const stream = (text = "hello\n", name: "stdout" | "stderr" = "stdout"): JupyterOutput => ({
  output_type: "stream",
  name,
  text,
});

const display = (data: Record<string, unknown>): JupyterOutput => ({
  output_type: "display_data",
  data,
});

const execute = (data: Record<string, unknown>): JupyterOutput => ({
  output_type: "execute_result",
  data,
  execution_count: 1,
});

const error = (): JupyterOutput => ({
  output_type: "error",
  ename: "ValueError",
  evalue: "x",
  traceback: ["Traceback (most recent call last):", "ValueError: x"],
});

describe("classifyOutputShape", () => {
  it("empty outputs -> empty", () => {
    expect(classifyOutputShape([])).toEqual({ kind: "empty" });
  });

  it("single stream -> streams-only", () => {
    expect(classifyOutputShape([stream()])).toEqual({ kind: "streams-only" });
  });

  it("multiple streams -> streams-only", () => {
    expect(classifyOutputShape([stream(), stream("more\n", "stderr")])).toEqual({
      kind: "streams-only",
    });
  });

  it("single error -> single-error", () => {
    expect(classifyOutputShape([error()])).toEqual({ kind: "single-error" });
  });

  it("single plotly without explicit height -> single-iframe-chart plotly", () => {
    expect(
      classifyOutputShape([
        display({ "application/vnd.plotly.v1+json": { data: [], layout: {} } }),
      ]),
    ).toEqual({ kind: "single-iframe-chart", mime: "plotly" });
  });

  it("single plotly with layout.height -> carries explicitHeight", () => {
    const shape = classifyOutputShape([
      display({
        "application/vnd.plotly.v1+json": { data: [], layout: { height: 900 } },
      }),
    ]);
    expect(shape).toEqual({ kind: "single-iframe-chart", mime: "plotly", explicitHeight: 900 });
  });

  it("plotly layout.height that is not a number is dropped", () => {
    expect(
      classifyOutputShape([
        display({ "application/vnd.plotly.v1+json": { data: [], layout: { height: "auto" } } }),
      ]),
    ).toEqual({ kind: "single-iframe-chart", mime: "plotly" });
  });

  it("single vega-lite v5 -> single-iframe-chart vega", () => {
    expect(classifyOutputShape([display({ "application/vnd.vegalite.v5+json": {} })])).toEqual({
      kind: "single-iframe-chart",
      mime: "vega",
    });
  });

  it("single vega v5 -> single-iframe-chart vega", () => {
    expect(classifyOutputShape([display({ "application/vnd.vega.v5+json": {} })])).toEqual({
      kind: "single-iframe-chart",
      mime: "vega",
    });
  });

  it("single geo+json -> single-iframe-chart leaflet", () => {
    expect(classifyOutputShape([display({ "application/geo+json": {} })])).toEqual({
      kind: "single-iframe-chart",
      mime: "leaflet",
    });
  });

  it("single arrow stream -> single-table arrow", () => {
    expect(
      classifyOutputShape([display({ "application/vnd.apache.arrow.stream": "<bytes>" })]),
    ).toEqual({ kind: "single-table", mime: "arrow" });
  });

  it("single parquet -> single-table parquet", () => {
    expect(classifyOutputShape([display({ "application/vnd.apache.parquet": "<bytes>" })])).toEqual(
      { kind: "single-table", mime: "parquet" },
    );
  });

  it("widget view -> single-widget", () => {
    expect(
      classifyOutputShape([
        display({ "application/vnd.jupyter.widget-view+json": { model_id: "abc" } }),
      ]),
    ).toEqual({ kind: "single-widget" });
  });

  it("markdown -> single-rich-text markdown", () => {
    expect(classifyOutputShape([display({ "text/markdown": "# hi" })])).toEqual({
      kind: "single-rich-text",
      mime: "markdown",
    });
  });

  it("html -> single-rich-text html", () => {
    expect(classifyOutputShape([display({ "text/html": "<p>hi</p>" })])).toEqual({
      kind: "single-rich-text",
      mime: "html",
    });
  });

  it("svg -> single-rich-text svg", () => {
    expect(classifyOutputShape([display({ "image/svg+xml": "<svg/>" })])).toEqual({
      kind: "single-rich-text",
      mime: "svg",
    });
  });

  it("png image -> single-image", () => {
    expect(classifyOutputShape([display({ "image/png": "abc" })])).toEqual({
      kind: "single-image",
      mime: "image/png",
    });
  });

  it("plain text only -> mixed (no dedicated kind)", () => {
    expect(classifyOutputShape([execute({ "text/plain": "hello" })])).toEqual({ kind: "mixed" });
  });

  it("streams followed by a plotly result -> streams-then-result(plotly)", () => {
    const shape = classifyOutputShape([
      stream("training...\n"),
      stream("done\n"),
      execute({ "application/vnd.plotly.v1+json": { data: [], layout: { height: 600 } } }),
    ]);
    expect(shape).toEqual({
      kind: "streams-then-result",
      result: { kind: "single-iframe-chart", mime: "plotly", explicitHeight: 600 },
    });
  });

  it("streams followed by a parquet result -> streams-then-result(parquet)", () => {
    const shape = classifyOutputShape([
      stream("loading\n"),
      execute({ "application/vnd.apache.parquet": "<bytes>" }),
    ]);
    expect(shape).toEqual({
      kind: "streams-then-result",
      result: { kind: "single-table", mime: "parquet" },
    });
  });

  it("streams followed by error -> streams-then-result(error)", () => {
    const shape = classifyOutputShape([stream("bad\n"), error()]);
    expect(shape).toEqual({ kind: "streams-then-result", result: { kind: "single-error" } });
  });

  it("two non-stream outputs -> mixed", () => {
    expect(
      classifyOutputShape([
        display({ "text/markdown": "# hi" }),
        display({ "application/vnd.plotly.v1+json": { data: [], layout: {} } }),
      ]),
    ).toEqual({ kind: "mixed" });
  });

  it("stream after a non-stream -> mixed", () => {
    expect(
      classifyOutputShape([
        display({ "application/vnd.plotly.v1+json": { data: [], layout: {} } }),
        stream("late\n"),
      ]),
    ).toEqual({ kind: "mixed" });
  });
});
