import { describe, expect, it } from "vite-plus/test";
import { inferDefaultOutputMode } from "../output-well-presets";
import type { OutputShape } from "../output-shape";

describe("inferDefaultOutputMode", () => {
  it("empty -> compact", () => {
    expect(inferDefaultOutputMode({ kind: "empty" })).toBe("compact");
  });

  it("single-iframe-chart (plotly) -> compact", () => {
    expect(
      inferDefaultOutputMode({ kind: "single-iframe-chart", mime: "plotly", explicitHeight: 900 }),
    ).toBe("compact");
  });

  it("single-iframe-chart (vega) -> compact", () => {
    expect(inferDefaultOutputMode({ kind: "single-iframe-chart", mime: "vega" })).toBe("compact");
  });

  it("single-iframe-chart (leaflet) -> compact", () => {
    expect(inferDefaultOutputMode({ kind: "single-iframe-chart", mime: "leaflet" })).toBe(
      "compact",
    );
  });

  it("single-table (parquet) -> focused", () => {
    expect(inferDefaultOutputMode({ kind: "single-table", mime: "parquet" })).toBe("focused");
  });

  it("single-table (arrow) -> focused", () => {
    expect(inferDefaultOutputMode({ kind: "single-table", mime: "arrow" })).toBe("focused");
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

  it("streams-then-result(table) -> focused (recurses on result)", () => {
    const shape: OutputShape = {
      kind: "streams-then-result",
      result: { kind: "single-table", mime: "parquet" },
    };
    expect(inferDefaultOutputMode(shape)).toBe("focused");
  });

  it("streams-then-result(plotly) -> compact", () => {
    expect(
      inferDefaultOutputMode({
        kind: "streams-then-result",
        result: { kind: "single-iframe-chart", mime: "plotly" },
      }),
    ).toBe("compact");
  });

  it("streams-then-result(markdown) -> expanded", () => {
    expect(
      inferDefaultOutputMode({
        kind: "streams-then-result",
        result: { kind: "single-rich-text", mime: "markdown" },
      }),
    ).toBe("expanded");
  });
});
