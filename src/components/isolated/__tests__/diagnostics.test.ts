// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { ISOLATED_DIAGNOSTICS_STORAGE_KEY, logIsolatedDiagnostic } from "../diagnostics";

describe("isolated diagnostics", () => {
  beforeEach(() => {
    window.localStorage.removeItem(ISOLATED_DIAGNOSTICS_STORAGE_KEY);
    vi.spyOn(console, "debug").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    window.localStorage.removeItem(ISOLATED_DIAGNOSTICS_STORAGE_KEY);
    vi.restoreAllMocks();
  });

  it("suppresses debug diagnostics by default", () => {
    logIsolatedDiagnostic({
      source: "isolated-frame",
      phase: "renderer-ready",
      details: { generation: 1 },
    });

    expect(console.debug).not.toHaveBeenCalled();
  });

  it("allows debug diagnostics when explicitly opted in", () => {
    window.localStorage.setItem(ISOLATED_DIAGNOSTICS_STORAGE_KEY, "debug");

    logIsolatedDiagnostic({
      source: "isolated-frame",
      phase: "renderer-ready",
      details: { generation: 1 },
    });

    expect(console.debug).toHaveBeenCalledWith("[isolated-frame] renderer-ready", {
      generation: 1,
    });
  });

  it("keeps warning diagnostics visible", () => {
    logIsolatedDiagnostic({
      source: "isolated-renderer",
      phase: "rendered-empty-after-paint",
      level: "warn",
      details: { expectedOutputCount: 1 },
    });

    expect(console.warn).toHaveBeenCalledWith("[isolated-renderer] rendered-empty-after-paint", {
      expectedOutputCount: 1,
    });
  });
});
