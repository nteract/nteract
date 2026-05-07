import { createEvent, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { injectPluginsForMimes, needsPlugin } from "@/components/isolated/iframe-libraries";
import { OutputArea, type JupyterOutput } from "../OutputArea";

let mockDarkMode = false;
let mockColorTheme: string | undefined;

const mockFrameHandle = {
  send: vi.fn(),
  render: vi.fn(),
  renderBatch: vi.fn(),
  eval: vi.fn(),
  installRenderer: vi.fn(),
  setTheme: vi.fn(),
  clear: vi.fn(),
  search: vi.fn(),
  searchNavigate: vi.fn(),
  isReady: false,
  isIframeReady: true,
};

vi.mock("@/lib/dark-mode", () => ({
  useDarkMode: () => mockDarkMode,
  useColorTheme: () => mockColorTheme,
}));

vi.mock("@/components/isolated/iframe-libraries", () => ({
  injectPluginsForMimes: vi.fn(async () => {}),
  needsPlugin: vi.fn(() => false),
}));

vi.mock("@/components/isolated", async () => {
  const React = await import("react");

  const MockIsolatedFrame = React.forwardRef<
    typeof mockFrameHandle,
    {
      allowWheelBoundaryScroll?: boolean;
      autoHeight?: boolean;
      scrollPassthrough?: boolean;
      onReady?: () => void;
    }
  >(function MockIsolatedFrame(
    { allowWheelBoundaryScroll, autoHeight, scrollPassthrough, onReady },
    ref,
  ) {
    React.useImperativeHandle(ref, () => mockFrameHandle);

    React.useEffect(() => {
      onReady?.();
    }, [onReady]);

    return (
      <div
        data-allow-wheel-boundary-scroll={String(allowWheelBoundaryScroll)}
        data-auto-height={String(autoHeight)}
        data-scroll-passthrough={String(scrollPassthrough)}
        data-testid="isolated-frame"
      />
    );
  });

  return {
    CommBridgeManager: class CommBridgeManager {},
    IsolatedFrame: MockIsolatedFrame,
  };
});

function makeMarkdownOutput(content = "```python\nprint('hello')\n```"): JupyterOutput[] {
  return [
    {
      output_type: "display_data",
      data: { "text/markdown": content },
      metadata: {},
    },
  ];
}

function makeParquetOutput(): JupyterOutput[] {
  return [
    {
      output_type: "display_data",
      data: { "application/vnd.apache.parquet": { hash: "fake-parquet" } },
      metadata: {},
    },
  ];
}

function pointerOutWithButtons(element: HTMLElement, buttons: number) {
  const event = createEvent.pointerOut(element);
  Object.defineProperty(event, "buttons", { value: buttons });
  fireEvent(element, event);
}

function getOutputContent(container: HTMLElement): HTMLElement {
  const outputContent = container.querySelector('[data-slot="output-area"] > div');
  if (!(outputContent instanceof HTMLElement)) {
    throw new Error("Expected output content wrapper to render");
  }
  return outputContent;
}

describe("OutputArea iframe theme sync", () => {
  beforeEach(() => {
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 800,
    });
    mockDarkMode = false;
    mockColorTheme = undefined;
    mockFrameHandle.send.mockClear();
    mockFrameHandle.render.mockClear();
    mockFrameHandle.renderBatch.mockClear();
    mockFrameHandle.eval.mockClear();
    mockFrameHandle.installRenderer.mockClear();
    mockFrameHandle.setTheme.mockClear();
    mockFrameHandle.clear.mockClear();
    mockFrameHandle.search.mockClear();
    mockFrameHandle.searchNavigate.mockClear();
    vi.mocked(injectPluginsForMimes).mockResolvedValue(undefined);
    vi.mocked(needsPlugin).mockReturnValue(false);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("re-sends the current cream color theme when the iframe becomes ready", async () => {
    mockColorTheme = "cream";

    render(<OutputArea outputs={makeMarkdownOutput()} isolated />);

    await waitFor(() => {
      expect(mockFrameHandle.setTheme).toHaveBeenCalledWith(false, "cream");
    });

    await waitFor(() => {
      expect(mockFrameHandle.renderBatch).toHaveBeenCalledWith([
        expect.objectContaining({
          mimeType: "text/markdown",
          data: "```python\nprint('hello')\n```",
        }),
      ]);
    });
  });

  it("renders a contained fallback when an isolated renderer plugin fails to load", async () => {
    vi.mocked(needsPlugin).mockReturnValue(true);
    vi.mocked(injectPluginsForMimes).mockRejectedValue(new Error("chunk failed"));

    render(<OutputArea outputs={makeMarkdownOutput()} isolated />);

    await waitFor(() => {
      expect(mockFrameHandle.renderBatch).toHaveBeenCalledWith([
        expect.objectContaining({
          mimeType: "text/plain",
          data: "Failed to load renderer plugin: chunk failed",
          metadata: { isError: true },
          outputIndex: 0,
        }),
      ]);
    });
  });

  it("sends null for classic so a reloaded iframe clears stale cream state", async () => {
    mockColorTheme = undefined;

    render(<OutputArea outputs={makeMarkdownOutput()} isolated />);

    await waitFor(() => {
      expect(mockFrameHandle.setTheme).toHaveBeenCalledWith(false, null);
    });
  });

  it("makes static markdown iframe outputs scroll-transparent", () => {
    const { getByTestId } = render(<OutputArea outputs={makeMarkdownOutput()} isolated />);

    expect(getByTestId("isolated-frame").getAttribute("data-scroll-passthrough")).toBe("true");
    expect(getByTestId("isolated-frame").getAttribute("data-allow-wheel-boundary-scroll")).toBe(
      "false",
    );
  });

  it("activates static iframe outputs for pointer interaction until the pointer leaves", () => {
    const onIframeMouseDown = vi.fn();
    const { getByTestId } = render(
      <OutputArea outputs={makeMarkdownOutput()} isolated onIframeMouseDown={onIframeMouseDown} />,
    );

    const frame = getByTestId("isolated-frame");
    const activationWell = frame.parentElement as HTMLElement;

    fireEvent.pointerDown(activationWell);

    expect(onIframeMouseDown).toHaveBeenCalled();
    expect(getByTestId("isolated-frame").getAttribute("data-scroll-passthrough")).toBe("false");
    expect(getByTestId("isolated-frame").getAttribute("data-allow-wheel-boundary-scroll")).toBe(
      "true",
    );

    pointerOutWithButtons(activationWell, 1);

    expect(getByTestId("isolated-frame").getAttribute("data-scroll-passthrough")).toBe("false");
    expect(getByTestId("isolated-frame").getAttribute("data-allow-wheel-boundary-scroll")).toBe(
      "true",
    );

    pointerOutWithButtons(activationWell, 0);

    expect(getByTestId("isolated-frame").getAttribute("data-scroll-passthrough")).toBe("true");
    expect(getByTestId("isolated-frame").getAttribute("data-allow-wheel-boundary-scroll")).toBe(
      "false",
    );
  });

  it("keeps interactive plugin iframe outputs on the wheel-boundary path", () => {
    const plotlyOutput: JupyterOutput[] = [
      {
        output_type: "display_data",
        data: { "application/vnd.plotly.v1+json": { data: [] } },
        metadata: {},
      },
    ];

    const { getByTestId } = render(<OutputArea outputs={plotlyOutput} isolated />);

    expect(getByTestId("isolated-frame").getAttribute("data-scroll-passthrough")).toBe("false");
    expect(getByTestId("isolated-frame").getAttribute("data-allow-wheel-boundary-scroll")).toBe(
      "true",
    );
  });

  it("keeps parquet iframe outputs on the wheel-boundary path while idle", () => {
    const { getByTestId } = render(<OutputArea outputs={makeParquetOutput()} isolated />);

    expect(getByTestId("isolated-frame").getAttribute("data-scroll-passthrough")).toBe("false");
    expect(getByTestId("isolated-frame").getAttribute("data-allow-wheel-boundary-scroll")).toBe(
      "true",
    );
  });

  it("forces focused iframe outputs off scroll passthrough and wheel-boundary forwarding", () => {
    const { getByTestId } = render(<OutputArea outputs={makeMarkdownOutput()} isolated focused />);

    expect(getByTestId("isolated-frame").getAttribute("data-scroll-passthrough")).toBe("false");
    expect(getByTestId("isolated-frame").getAttribute("data-allow-wheel-boundary-scroll")).toBe(
      "false",
    );
  });

  it("constrains isolated iframe outputs to a viewport-sized output well by default", () => {
    const { container, getByTestId } = render(
      <OutputArea outputs={makeMarkdownOutput()} isolated />,
    );

    const outputContent = getOutputContent(container);

    expect(getByTestId("isolated-frame").getAttribute("data-auto-height")).toBe("true");
    expect(outputContent.getAttribute("class") ?? "").toContain("overflow-y-auto");
    expect(outputContent.style.maxHeight).toBe("600px");
    expect(outputContent.style.minHeight).toBe("");
  });

  it("can expand isolated iframe outputs past the default output well cap", () => {
    const { container, getByTestId } = render(
      <OutputArea outputs={makeMarkdownOutput()} isolated expandIframeOutputs />,
    );

    expect(getByTestId("isolated-frame").getAttribute("data-auto-height")).toBe("true");
    const outputContent = getOutputContent(container);
    expect(outputContent.style.maxHeight).toBe("");
  });

  it("uses a focused output well floor for short iframe content", () => {
    const { container, getByTestId } = render(
      <OutputArea outputs={makeMarkdownOutput()} isolated focused />,
    );

    const outputContent = getOutputContent(container);

    expect(getByTestId("isolated-frame").getAttribute("data-auto-height")).toBe("true");
    expect(outputContent.getAttribute("class") ?? "").toContain("overflow-y-auto");
    expect(outputContent.style.minHeight).toBe("360px");
  });

  it("uses an 80vh focused output well ceiling for tall iframe content", () => {
    const { container } = render(<OutputArea outputs={makeMarkdownOutput()} isolated focused />);

    expect(getOutputContent(container).style.maxHeight).toBe("640px");
  });

  it("leaves focused iframe content without a fixed wrapper height between the floor and ceiling", () => {
    const { container } = render(<OutputArea outputs={makeMarkdownOutput()} isolated focused />);

    expect(getOutputContent(container).style.height).toBe("");
  });

  it("keeps the focused output well clamp when expand is also enabled", () => {
    const { container } = render(
      <OutputArea outputs={makeMarkdownOutput()} isolated expandIframeOutputs focused />,
    );

    const outputContent = getOutputContent(container);
    expect(outputContent.style.maxHeight).toBe("640px");
    expect(outputContent.style.minHeight).toBe("360px");
  });

  it("updates the focused output well ceiling on resize", () => {
    const { container } = render(<OutputArea outputs={makeMarkdownOutput()} isolated focused />);

    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 500,
    });
    fireEvent(window, new Event("resize"));

    expect(getOutputContent(container).style.maxHeight).toBe("400px");
  });
});
