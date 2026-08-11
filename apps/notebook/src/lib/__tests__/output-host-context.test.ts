// @vitest-environment jsdom
import { describe, expect, it } from "vite-plus/test";
import { act, renderHook } from "@testing-library/react";
import type { NotebookHost } from "@nteract/notebook-host";
import { createOutputHostContext, useOutputHostContext } from "../output-host-context";

describe("createOutputHostContext", () => {
  it("projects a host-supplied output document URL into renderer context", () => {
    expect(createOutputHostContext(" http://127.0.0.1:48123/output-frame ")).toEqual({
      nteract: { outputDocumentUrl: "http://127.0.0.1:48123/output-frame" },
    });
  });

  it("leaves browser rendering on its srcDoc fallback without a URL", () => {
    expect(createOutputHostContext(null)).toBeUndefined();
  });

  it("refreshes renderer context when relay ready changes the host URL", () => {
    let outputDocumentUrl: string | null = null;
    let ready: (() => void) | null = null;
    const host = {
      get outputDocumentUrl() {
        return outputDocumentUrl;
      },
      daemonEvents: {
        onReady(callback: () => void) {
          ready = callback;
          return () => {
            ready = null;
          };
        },
      },
    } as unknown as NotebookHost;

    const { result } = renderHook(() => useOutputHostContext(host));
    expect(result.current).toBeUndefined();

    act(() => {
      outputDocumentUrl = "http://127.0.0.1:49152/output-frame";
      ready?.();
    });
    expect(result.current).toEqual({
      nteract: { outputDocumentUrl: "http://127.0.0.1:49152/output-frame" },
    });
  });
});
