import { describe, expect, it } from "vite-plus/test";

import {
  DISPLAY_CAPABLE_JUPYTER_OUTPUT_TYPES,
  isDisplayCapableJupyterOutput,
  isDisplayCapableJupyterOutputType,
  isInitialLoadFailed,
  isInitialLoadStreaming,
  type InitialLoadPhase,
} from "../src";

describe("protocol contract discriminants", () => {
  it("identifies display-capable Jupyter output types", () => {
    expect(DISPLAY_CAPABLE_JUPYTER_OUTPUT_TYPES).toEqual(["execute_result", "display_data"]);
    expect(isDisplayCapableJupyterOutputType("execute_result")).toBe(true);
    expect(isDisplayCapableJupyterOutputType("display_data")).toBe(true);
    expect(isDisplayCapableJupyterOutputType("stream")).toBe(false);
    expect(isDisplayCapableJupyterOutputType("error")).toBe(false);
    expect(isDisplayCapableJupyterOutputType(undefined)).toBe(false);
  });

  it("identifies display-capable Jupyter output objects", () => {
    expect(
      isDisplayCapableJupyterOutput({
        output_type: "display_data",
        data: { "text/plain": "ok" },
      }),
    ).toBe(true);
    expect(
      isDisplayCapableJupyterOutput({
        output_type: "execute_result",
        data: { "text/plain": "ok" },
        execution_count: 1,
      }),
    ).toBe(true);
    expect(isDisplayCapableJupyterOutput({ output_type: "stream" })).toBe(false);
    expect(isDisplayCapableJupyterOutput(null)).toBe(false);
  });

  it("selects initial-load failed and streaming states", () => {
    const failed: InitialLoadPhase = { phase: "failed", reason: "bad snapshot" };
    const streaming: InitialLoadPhase = { phase: "streaming" };
    const ready: InitialLoadPhase = { phase: "ready" };

    expect(isInitialLoadFailed(failed)).toBe(true);
    expect(isInitialLoadFailed(streaming)).toBe(false);
    expect(isInitialLoadStreaming(streaming)).toBe(true);
    expect(isInitialLoadStreaming(ready)).toBe(false);
  });
});
