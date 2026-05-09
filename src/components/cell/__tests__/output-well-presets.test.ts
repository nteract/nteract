import { describe, expect, it } from "vite-plus/test";
import { inferDefaultOutputMode } from "../output-well-presets";
import type { OutputShape } from "../output-shape";

describe("inferDefaultOutputMode", () => {
  it("empty -> compact", () => {
    expect(inferDefaultOutputMode({ kind: "empty" })).toBe("compact");
  });

  it("single-iframe-chart (plotly) -> expanded (chart owns its requested height)", () => {
    expect(
      inferDefaultOutputMode({ kind: "single-iframe-chart", mime: "plotly", explicitHeight: 900 }),
    ).toBe("expanded");
  });

  it("single-iframe-chart (vega) -> expanded", () => {
    expect(inferDefaultOutputMode({ kind: "single-iframe-chart", mime: "vega" })).toBe("expanded");
  });

  it("single-iframe-chart (leaflet) -> expanded", () => {
    expect(inferDefaultOutputMode({ kind: "single-iframe-chart", mime: "leaflet" })).toBe(
      "expanded",
    );
  });

  it("single-table (parquet) -> expanded (sift owns its own height + passthrough)", () => {
    expect(inferDefaultOutputMode({ kind: "single-table", mime: "parquet" })).toBe("expanded");
  });

  it("single-table (arrow) -> expanded", () => {
    expect(inferDefaultOutputMode({ kind: "single-table", mime: "arrow" })).toBe("expanded");
  });

  it("single-image -> compact", () => {
    expect(inferDefaultOutputMode({ kind: "single-image", mime: "image/png" })).toBe("compact");
  });

  it("single-rich-text (markdown) -> expanded", () => {
    expect(inferDefaultOutputMode({ kind: "single-rich-text", mime: "markdown" })).toBe("expanded");
  });

  it("single-rich-text (html) -> expanded", () => {
    expect(inferDefaultOutputMode({ kind: "single-rich-text", mime: "html" })).toBe("expanded");
  });

  it("single-rich-text (svg) -> expanded", () => {
    expect(inferDefaultOutputMode({ kind: "single-rich-text", mime: "svg" })).toBe("expanded");
  });

  it("single-widget -> compact", () => {
    expect(inferDefaultOutputMode({ kind: "single-widget" })).toBe("compact");
  });

  it("single-error -> compact", () => {
    expect(inferDefaultOutputMode({ kind: "single-error" })).toBe("compact");
  });

  it("streams-only -> compact", () => {
    expect(inferDefaultOutputMode({ kind: "streams-only" })).toBe("compact");
  });

  it("mixed -> compact", () => {
    expect(inferDefaultOutputMode({ kind: "mixed" })).toBe("compact");
  });

  it("streams-then-result(table) -> expanded (no nested wrapper scrollbar)", () => {
    const shape: OutputShape = {
      kind: "streams-then-result",
      result: { kind: "single-table", mime: "parquet" },
    };
    expect(inferDefaultOutputMode(shape)).toBe("expanded");
  });

  it("streams-then-result(plotly) -> expanded", () => {
    expect(
      inferDefaultOutputMode({
        kind: "streams-then-result",
        result: { kind: "single-iframe-chart", mime: "plotly" },
      }),
    ).toBe("expanded");
  });

  it("streams-then-result(markdown) -> expanded", () => {
    expect(
      inferDefaultOutputMode({
        kind: "streams-then-result",
        result: { kind: "single-rich-text", mime: "markdown" },
      }),
    ).toBe("expanded");
  });

  it("streams-then-result(error) -> expanded", () => {
    expect(
      inferDefaultOutputMode({
        kind: "streams-then-result",
        result: { kind: "single-error" },
      }),
    ).toBe("expanded");
  });
});
