import { fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
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

    fireEvent.mouseDown(activationWell);

    expect(onIframeMouseDown).toHaveBeenCalled();
    expect(getByTestId("isolated-frame").getAttribute("data-scroll-passthrough")).toBe("false");
    expect(getByTestId("isolated-frame").getAttribute("data-allow-wheel-boundary-scroll")).toBe(
      "true",
    );

    fireEvent.mouseLeave(activationWell);

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

  it("constrains isolated iframe outputs to a viewport-sized output well by default", () => {
    const { container, getByTestId } = render(
      <OutputArea outputs={makeMarkdownOutput()} isolated />,
    );

    const outputContent = container.querySelector('[data-slot="output-area"] > div');

    expect(getByTestId("isolated-frame").getAttribute("data-auto-height")).toBe("true");
    expect(outputContent?.getAttribute("class") ?? "").toContain("overflow-y-auto");
    expect((outputContent as HTMLElement | null)?.style.maxHeight).toBe("600px");
  });

  it("can expand isolated iframe outputs past the default output well cap", () => {
    const { container, getByTestId } = render(
      <OutputArea outputs={makeMarkdownOutput()} isolated expandIframeOutputs />,
    );

    expect(getByTestId("isolated-frame").getAttribute("data-auto-height")).toBe("true");
    const outputContent = container.querySelector('[data-slot="output-area"] > div') as HTMLElement;
    expect(outputContent.style.maxHeight).toBe("");
  });
});
