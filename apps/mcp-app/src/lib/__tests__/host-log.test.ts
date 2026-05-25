import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  hostLog,
  isHostFacingLevel,
  setHostLogSink,
  type HostLogParams,
} from "../host-log";

describe("hostLog", () => {
  let logs: HostLogParams[];

  beforeEach(() => {
    logs = [];
    setHostLogSink({
      sendLog: (params) => {
        logs.push(params);
      },
    });
  });

  afterEach(() => {
    setHostLogSink(null);
    vi.restoreAllMocks();
  });

  it("keeps low-level telemetry off the host logging channel", () => {
    hostLog("debug", "layout-measured", { height: 120 });
    hostLog("info", "tool-result-received", { outputCount: 1 });
    hostLog("notice", "app-connected", { displayMode: "inline" });

    expect(logs).toHaveLength(0);
  });

  it("forwards warnings and errors to the host", () => {
    hostLog("warning", "mime-renderer-no-supported-mime", { outputMimes: [] });
    hostLog("error", "plugin-render-failed", { mime: "text/markdown" });

    expect(logs).toEqual([
      expect.objectContaining({
        level: "warning",
        logger: "nteract.mcp-app",
        data: expect.objectContaining({
          event: "mime-renderer-no-supported-mime",
          outputMimes: [],
        }),
      }),
      expect.objectContaining({
        level: "error",
        logger: "nteract.mcp-app",
        data: expect.objectContaining({
          event: "plugin-render-failed",
          mime: "text/markdown",
        }),
      }),
    ]);
  });

  it("classifies only warning-or-higher severities as host-facing", () => {
    expect(isHostFacingLevel("debug")).toBe(false);
    expect(isHostFacingLevel("info")).toBe(false);
    expect(isHostFacingLevel("notice")).toBe(false);
    expect(isHostFacingLevel("warning")).toBe(true);
    expect(isHostFacingLevel("error")).toBe(true);
    expect(isHostFacingLevel("critical")).toBe(true);
    expect(isHostFacingLevel("alert")).toBe(true);
    expect(isHostFacingLevel("emergency")).toBe(true);
  });
});
