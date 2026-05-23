import { render } from "@testing-library/react";
import type { ComponentType } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import type {
  RendererHostContext,
  RendererInstallContext,
  RendererProps,
} from "@/lib/renderer-registry";
import { install } from "../sift-renderer";

const siftMocks = vi.hoisted(() => ({
  setWasmUrl: vi.fn(),
}));

vi.mock("@nteract/sift", () => ({
  setWasmUrl: siftMocks.setWasmUrl,
  SiftFocusStatus: () => null,
  SiftTable: () => <div data-testid="sift-table" />,
}));

describe("Sift renderer plugin", () => {
  it("reconfigures WASM when a renderer asset base arrives after first render", () => {
    let hostContext: RendererHostContext | undefined;
    const hostContextListeners = new Set<
      Parameters<RendererInstallContext["subscribeHostContext"]>[0]
    >();
    let Renderer: ComponentType<RendererProps> | undefined;

    install({
      register: (_mimeTypes, component) => {
        Renderer = component;
      },
      registerPattern: vi.fn(),
      getHostContext: () => hostContext,
      subscribeHostContext: (listener) => {
        hostContextListeners.add(listener);
        return () => hostContextListeners.delete(listener);
      },
    });

    expect(Renderer).toBeDefined();
    render(
      <Renderer
        data="https://notebooks.example/api/n/demo/blobs/sha256-abc"
        mimeType="application/vnd.apache.parquet"
      />,
    );

    expect(siftMocks.setWasmUrl).toHaveBeenLastCalledWith(
      "https://notebooks.example/plugins/sift_wasm.wasm?v=dev",
    );

    hostContext = {
      nteract: {
        rendererAssetsBaseUrl: "https://outputs.example/renderer-assets/",
      },
    };
    for (const listener of hostContextListeners) {
      listener(hostContext);
    }

    expect(siftMocks.setWasmUrl).toHaveBeenLastCalledWith(
      "https://outputs.example/renderer-assets/sift_wasm.wasm?v=dev",
    );
  });
});
