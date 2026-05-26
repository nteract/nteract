// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { ISOLATED_DIAGNOSTICS_STORAGE_KEY } from "@/components/isolated";
import { logNotebookIsolatedDiagnostic } from "../isolated-diagnostics";
import { logger } from "../logger";

vi.mock("../logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe("logNotebookIsolatedDiagnostic", () => {
  afterEach(() => {
    window.localStorage.removeItem(ISOLATED_DIAGNOSTICS_STORAGE_KEY);
    vi.clearAllMocks();
  });

  it("suppresses debug diagnostics unless explicitly enabled", () => {
    logNotebookIsolatedDiagnostic("renderer-ready", { generation: 1 });

    expect(logger.debug).not.toHaveBeenCalled();

    window.localStorage.setItem(ISOLATED_DIAGNOSTICS_STORAGE_KEY, "debug");
    logNotebookIsolatedDiagnostic("renderer-ready", { generation: 1 });

    expect(logger.debug).toHaveBeenCalledWith("[isolated-frame] renderer-ready", {
      generation: 1,
    });
  });

  it("routes warnings and errors through the notebook host logger", () => {
    logNotebookIsolatedDiagnostic(
      "rendered-empty-after-paint",
      { expectedOutputCount: 1 },
      "warn",
      "isolated-renderer",
    );
    logNotebookIsolatedDiagnostic(
      "renderer-plugin-install-failed",
      { message: "failed" },
      "error",
      "isolated-renderer",
    );

    expect(logger.warn).toHaveBeenCalledWith("[isolated-renderer] rendered-empty-after-paint", {
      expectedOutputCount: 1,
    });
    expect(logger.error).toHaveBeenCalledWith(
      "[isolated-renderer] renderer-plugin-install-failed",
      { message: "failed" },
    );
  });
});
