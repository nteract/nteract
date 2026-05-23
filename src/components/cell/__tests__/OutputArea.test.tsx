import { createEvent, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  setHostContext: vi.fn(),
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
      hostContext?: unknown;
      scrollPassthrough?: boolean;
      onReady?: () => void;
    }
  >(function MockIsolatedFrame(
    { allowWheelBoundaryScroll, autoHeight, hostContext, scrollPassthrough, onReady },
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
        data-host-context={JSON.stringify(hostContext ?? null)}
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

function makeStreamOutput(text = "hey\n"): JupyterOutput[] {
  return [
    {
      output_type: "stream",
      name: "stdout",
      text,
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
    mockFrameHandle.setHostContext.mockClear();
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

  it("does not resend isolated output renders for unrelated parent rerenders", async () => {
    const outputs = makeMarkdownOutput();
    const { rerender } = render(<OutputArea outputs={outputs} isolated />);

    await waitFor(() => {
      expect(mockFrameHandle.renderBatch).toHaveBeenCalledTimes(1);
    });

    rerender(<OutputArea outputs={outputs} isolated />);

    expect(mockFrameHandle.renderBatch).toHaveBeenCalledTimes(1);
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

  it("passes host context through to isolated output frames", () => {
    const { getByTestId } = render(
      <OutputArea
        outputs={makeParquetOutput()}
        isolated
        hostContext={{
          nteract: {
            rendererAssetsBaseUrl: "https://cdn.example.test/plugins/",
          },
        }}
      />,
    );

    expect(getByTestId("isolated-frame").getAttribute("data-host-context")).toContain(
      "https://cdn.example.test/plugins/",
    );
  });

  it("activates static iframe outputs on pointer down and keeps them active when the pointer leaves", () => {
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

    // Pointer out while a button is held used to be a no-op and remains so —
    // active drags keep the frame focused.
    pointerOutWithButtons(activationWell, 1);

    expect(getByTestId("isolated-frame").getAttribute("data-scroll-passthrough")).toBe("false");
    expect(getByTestId("isolated-frame").getAttribute("data-allow-wheel-boundary-scroll")).toBe(
      "true",
    );

    // Pointer out without buttons no longer drops focus; the user has to
    // click elsewhere or press Escape. See the dedicated outside-pointer-down
    // and Escape tests below.
    pointerOutWithButtons(activationWell, 0);

    expect(getByTestId("isolated-frame").getAttribute("data-scroll-passthrough")).toBe("false");
    expect(getByTestId("isolated-frame").getAttribute("data-allow-wheel-boundary-scroll")).toBe(
      "true",
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

  it("puts parquet iframe outputs on scroll passthrough so the page wheels through sift", () => {
    // Sift renders interactive tables but iframes-in-a-doc are unwieldy: every
    // wheel gesture that crosses a 600px sift box would otherwise get trapped.
    // Sift now joins markdown / HTML / SVG on the click-to-engage path —
    // pointer-down on the wrapper flips the iframe back into interactive mode.
    const { getByTestId } = render(<OutputArea outputs={makeParquetOutput()} isolated />);

    expect(getByTestId("isolated-frame").getAttribute("data-scroll-passthrough")).toBe("true");
    expect(getByTestId("isolated-frame").getAttribute("data-allow-wheel-boundary-scroll")).toBe(
      "false",
    );
  });

  it("aligns sift before engaging iframe scrolling and releases on Escape", () => {
    const scrollBy = vi.fn();
    Object.defineProperty(window, "scrollBy", {
      configurable: true,
      value: scrollBy,
    });
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 800,
    });

    const { getByTestId } = render(<OutputArea outputs={makeParquetOutput()} isolated />);
    const frame = getByTestId("isolated-frame");
    const activationWell = frame.parentElement as HTMLElement;
    vi.spyOn(activationWell, "getBoundingClientRect").mockReturnValue({
      top: 700,
      bottom: 1420,
      left: 0,
      right: 1200,
      width: 1200,
      height: 720,
      x: 0,
      y: 700,
      toJSON: () => ({}),
    } as DOMRect);

    fireEvent.pointerDown(activationWell);

    expect(scrollBy).toHaveBeenCalledWith({ top: 604, behavior: "auto" });
    expect(activationWell.getAttribute("data-frame-interaction-active")).toBe("true");
    expect(frame.getAttribute("data-scroll-passthrough")).toBe("false");
    expect(frame.getAttribute("data-allow-wheel-boundary-scroll")).toBe("false");
    expect(screen.queryByText("Click inside the table to scroll")).toBeNull();

    fireEvent.keyDown(activationWell, { key: "Escape" });

    expect(activationWell.getAttribute("data-frame-interaction-active")).toBeNull();
    expect(frame.getAttribute("data-scroll-passthrough")).toBe("true");
    expect(
      screen.getByRole("button", { name: "Click inside the table to scroll" }),
    ).toBeInTheDocument();
  });

  it("activates sift iframe scrolling from the magnetize cue", () => {
    const { getByTestId } = render(<OutputArea outputs={makeParquetOutput()} isolated />);
    const frame = getByTestId("isolated-frame");
    const activationWell = frame.parentElement as HTMLElement;

    fireEvent.pointerDown(screen.getByRole("button", { name: "Click inside the table to scroll" }));

    expect(activationWell.getAttribute("data-frame-interaction-active")).toBe("true");
    expect(frame.getAttribute("data-scroll-passthrough")).toBe("false");
    expect(frame.getAttribute("data-allow-wheel-boundary-scroll")).toBe("false");
    expect(screen.queryByRole("button", { name: "Click inside the table to scroll" })).toBeNull();
  });

  it("releases sift iframe scrolling on outside pointer down", () => {
    const { getByTestId } = render(<OutputArea outputs={makeParquetOutput()} isolated />);
    const frame = getByTestId("isolated-frame");
    const activationWell = frame.parentElement as HTMLElement;

    fireEvent.pointerDown(activationWell);

    expect(activationWell.getAttribute("data-frame-interaction-active")).toBe("true");
    expect(frame.getAttribute("data-scroll-passthrough")).toBe("false");

    fireEvent.pointerDown(document.body);

    expect(activationWell.getAttribute("data-frame-interaction-active")).toBeNull();
    expect(frame.getAttribute("data-scroll-passthrough")).toBe("true");
    expect(screen.queryByText("Table focused")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Click inside the table to scroll" }),
    ).toBeInTheDocument();
  });

  it("forces focused iframe outputs off scroll passthrough and wheel-boundary forwarding", () => {
    const { getByTestId } = render(<OutputArea outputs={makeMarkdownOutput()} isolated focused />);

    expect(getByTestId("isolated-frame").getAttribute("data-scroll-passthrough")).toBe("false");
    expect(getByTestId("isolated-frame").getAttribute("data-allow-wheel-boundary-scroll")).toBe(
      "false",
    );
  });

  it("renders isolated iframe outputs at natural height by default", () => {
    const { container, getByTestId } = render(
      <OutputArea outputs={makeMarkdownOutput()} isolated />,
    );

    const outputContent = getOutputContent(container);

    expect(getByTestId("isolated-frame").getAttribute("data-auto-height")).toBe("true");
    expect(outputContent.getAttribute("class") ?? "").not.toContain("overflow-y-auto");
    expect(outputContent.style.maxHeight).toBe("");
    expect(outputContent.style.minHeight).toBe("");
  });

  it("renders plain in-DOM output without output well constraints", () => {
    const { container } = render(<OutputArea outputs={makeStreamOutput()} useOutputWell={false} />);

    const outputContent = getOutputContent(container);
    expect(outputContent.getAttribute("class") ?? "").not.toContain("overflow-y-auto");
    expect(outputContent.style.maxHeight).toBe("");
  });

  it("constrains isolated iframe outputs when maxHeight is explicit", () => {
    const { container, getByTestId } = render(
      <OutputArea outputs={makeMarkdownOutput()} isolated maxHeight={420} />,
    );

    expect(getByTestId("isolated-frame").getAttribute("data-auto-height")).toBe("true");
    const outputContent = getOutputContent(container);
    expect(outputContent.getAttribute("class") ?? "").toContain("overflow-y-auto");
    expect(outputContent.style.maxHeight).toBe("420px");
  });

  it("uses a focused output well floor for short iframe content", () => {
    const { container, getByTestId } = render(
      <OutputArea outputs={makeMarkdownOutput()} isolated focused />,
    );

    const outputContent = getOutputContent(container);

    // Focused mode disables iframe autoHeight so the iframe document handles
    // its own wheel via internal overflow, instead of growing to its full
    // content height (which left the wrapper as the only scroll container,
    // and wheel-over-iframe events never reached it).
    expect(getByTestId("isolated-frame").getAttribute("data-auto-height")).toBe("false");
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

  it("keeps the focused output well clamp", () => {
    const { container } = render(<OutputArea outputs={makeMarkdownOutput()} isolated focused />);

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
