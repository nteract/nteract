import { render, screen } from "@testing-library/react";
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

    // Stable names carry no hashed fallback URL.
    expect(siftMocks.setWasmUrl).toHaveBeenLastCalledWith(
      "https://notebooks.example/plugins/sift_wasm.wasm?v=dev",
      undefined,
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
      undefined,
    );
  });

  it("threads the stable fallback URL alongside a hashed manifest name", () => {
    let Renderer: ComponentType<RendererProps> | undefined;

    install({
      register: (_mimeTypes, component) => {
        Renderer = component;
      },
      registerPattern: vi.fn(),
      getHostContext: () => ({
        nteract: {
          rendererAssetsBaseUrl: "https://outputs.example/renderer-assets/",
          siftWasmAssetName: "sift_wasm.0123456789abcdef.wasm",
        },
      }),
      subscribeHostContext: () => () => {},
    });

    expect(Renderer).toBeDefined();
    render(
      <Renderer
        data="https://notebooks.example/api/n/demo/blobs/sha256-abc"
        mimeType="application/vnd.apache.parquet"
      />,
    );

    expect(siftMocks.setWasmUrl).toHaveBeenLastCalledWith(
      "https://outputs.example/renderer-assets/sift_wasm.0123456789abcdef.wasm",
      "https://outputs.example/renderer-assets/sift_wasm.wasm?v=dev",
    );
  });

  it("fits the table inside the iframe max height from host context", () => {
    let Renderer: ComponentType<RendererProps> | undefined;

    install({
      register: (_mimeTypes, component) => {
        Renderer = component;
      },
      registerPattern: vi.fn(),
      getHostContext: () => ({
        containerDimensions: {
          maxHeight: 400,
        },
      }),
      subscribeHostContext: () => () => undefined,
    });

    expect(Renderer).toBeDefined();
    render(
      <Renderer
        data="https://notebooks.example/api/n/demo/blobs/sha256-host-height"
        mimeType="application/vnd.apache.parquet"
      />,
    );

    expect(screen.getByTestId("sift-table").parentElement).toHaveStyle({ height: "398px" });
  });

  it("subtracts earlier iframe outputs from the table max height", () => {
    let Renderer: ComponentType<RendererProps> | undefined;
    const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
      if (this.id === "root") {
        return { ...originalGetBoundingClientRect.call(this), top: 0, bottom: 400 };
      }
      if (this instanceof HTMLElement && this.dataset.slot === "sift-output") {
        return { ...originalGetBoundingClientRect.call(this), top: 80, bottom: 400 };
      }
      return originalGetBoundingClientRect.call(this);
    };

    try {
      install({
        register: (_mimeTypes, component) => {
          Renderer = component;
        },
        registerPattern: vi.fn(),
        getHostContext: () => ({
          containerDimensions: {
            maxHeight: 400,
          },
        }),
        subscribeHostContext: () => () => undefined,
      });

      expect(Renderer).toBeDefined();
      render(
        <div id="root">
          <div style={{ height: 80 }}>stream text</div>
          <Renderer
            data="https://notebooks.example/api/n/demo/blobs/sha256-host-offset"
            mimeType="application/vnd.apache.parquet"
          />
        </div>,
      );

      expect(screen.getByTestId("sift-table").parentElement).toHaveStyle({ height: "318px" });
    } finally {
      HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
    }
  });
});
