import { act, createEvent, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { injectPluginsForMimes, needsPlugin } from "@/components/isolated/iframe-libraries";
import { OutputArea, type JupyterOutput } from "../OutputArea";

let mockDarkMode = false;
let mockColorTheme: string | undefined;
let lastFrameMessageHandler: ((message: unknown) => void) | undefined;
let isolatedFrameMountCount = 0;

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

vi.mock("@/components/isolated", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/isolated")>();
  const React = await import("react");

  const MockIsolatedFrame = React.forwardRef<
    typeof mockFrameHandle,
    {
      allowWheelBoundaryScroll?: boolean;
      autoHeight?: boolean;
      hostContext?: unknown;
      onMessage?: (message: unknown) => void;
      scrollPassthrough?: boolean;
      onReady?: () => void;
    }
  >(function MockIsolatedFrame(
    { allowWheelBoundaryScroll, autoHeight, hostContext, onMessage, scrollPassthrough, onReady },
    ref,
  ) {
    React.useImperativeHandle(ref, () => mockFrameHandle);

    React.useEffect(() => {
      isolatedFrameMountCount += 1;
    }, []);

    React.useEffect(() => {
      onReady?.();
    }, [onReady]);

    React.useEffect(() => {
      lastFrameMessageHandler = onMessage;
      return () => {
        if (lastFrameMessageHandler === onMessage) {
          lastFrameMessageHandler = undefined;
        }
      };
    }, [onMessage]);

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
    ...actual,
    CommBridgeManager: class CommBridgeManager {},
    IsolatedFrame: MockIsolatedFrame,
  };
});

function makeMarkdownOutput(content = "```python\nprint('hello')\n```"): JupyterOutput[] {
  return [
    {
      output_id: "markdown-output",
      output_type: "display_data",
      data: { "text/markdown": content },
      metadata: {},
    },
  ];
}

function makeStreamOutput(text = "hey\n"): JupyterOutput[] {
  return [
    {
      output_id: "stream-output",
      output_type: "stream",
      name: "stdout",
      text,
    },
  ];
}

function makeWidgetOutput(outputId = "widget-output", modelId = "widget-model"): JupyterOutput {
  return {
    output_id: outputId,
    output_type: "display_data",
    data: {
      "application/vnd.jupyter.widget-view+json": { model_id: modelId },
      "text/plain": "Widget fallback",
    },
    metadata: {},
  };
}

function makeMixedDocumentOutputs(): JupyterOutput[] {
  return [
    {
      output_id: "mixed-stream-output",
      output_type: "stream",
      name: "stdout",
      text: "stream before\n",
    },
    {
      output_id: "mixed-html-output",
      output_type: "display_data",
      data: { "text/html": "<b>unsafe html</b>" },
      metadata: {},
    },
    {
      output_id: "mixed-error-output",
      output_type: "error",
      ename: "RecursionError",
      evalue: "maximum recursion depth exceeded",
      traceback: ["RecursionError: maximum recursion depth exceeded"],
      rich: {
        ename: "RecursionError",
        evalue: "maximum recursion depth exceeded",
        execution: { execution_id: "exec-run", execution_count: 6 },
        frames: [
          {
            filename: "/var/folders/x/T/ipykernel_39879/258099874.py",
            lineno: 4,
            name: "<module>",
            source_ref: {
              kind: "notebook_execution",
              execution_id: "exec-run",
              source_hash: "source-hash-run",
            },
            lines: [{ lineno: 4, source: "f(200)", highlight: true }],
          },
        ],
      },
    },
  ];
}

function makeParquetOutput(): JupyterOutput[] {
  return [
    {
      output_id: "parquet-output",
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
    lastFrameMessageHandler = undefined;
    isolatedFrameMountCount = 0;
    vi.mocked(injectPluginsForMimes).mockResolvedValue(undefined);
    vi.mocked(needsPlugin).mockReturnValue(false);
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
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

  it("defers opt-in isolated output frames until the output nears the viewport", async () => {
    let intersectionCallback: IntersectionObserverCallback | undefined;
    const observer = {
      observe: vi.fn(),
      disconnect: vi.fn(),
      unobserve: vi.fn(),
      takeRecords: vi.fn(() => []),
    };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function MockIntersectionObserver(callback: IntersectionObserverCallback) {
        intersectionCallback = callback;
        return observer;
      }),
    );

    const { container } = render(
      <OutputArea outputs={makeMarkdownOutput()} isolated deferIsolatedFrameUntilVisible />,
    );

    expect(screen.queryByTestId("isolated-frame")).toBeNull();
    expect(container.querySelector('[data-slot="isolated-frame-deferred"]')).not.toBeNull();
    expect(mockFrameHandle.renderBatch).not.toHaveBeenCalled();
    expect(observer.observe).toHaveBeenCalledTimes(1);

    await act(async () => {
      intersectionCallback?.(
        [{ isIntersecting: true, intersectionRatio: 1 } as IntersectionObserverEntry],
        observer as unknown as IntersectionObserver,
      );
    });

    expect(screen.getByTestId("isolated-frame")).toBeInTheDocument();
    expect(observer.disconnect).toHaveBeenCalled();
    await waitFor(() => {
      expect(mockFrameHandle.renderBatch).toHaveBeenCalledWith([
        expect.objectContaining({
          mimeType: "text/markdown",
          outputId: "markdown-output",
        }),
      ]);
    });
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
        output_id: "plotly-output",
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
    expect(frame.getAttribute("data-allow-wheel-boundary-scroll")).toBe("false");
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

  it("segments mixed auto outputs into DOM, interactive iframe, and standalone sift iframe lanes", async () => {
    const outputs: JupyterOutput[] = [
      ...makeStreamOutput("stdout one\n"),
      ...makeStreamOutput("stdout two\n"),
      makeWidgetOutput("widget-progress-1", "model-progress-1"),
      makeWidgetOutput("widget-progress-2", "model-progress-2"),
      ...makeParquetOutput(),
    ];

    render(<OutputArea outputs={outputs} />);

    expect(screen.getByText(/stdout one/)).toBeInTheDocument();
    expect(screen.getByText(/stdout two/)).toBeInTheDocument();

    const frames = screen.getAllByTestId("isolated-frame");
    expect(frames).toHaveLength(2);
    expect(frames[0].getAttribute("data-scroll-passthrough")).toBe("false");
    expect(frames[0].getAttribute("data-allow-wheel-boundary-scroll")).toBe("true");
    expect(frames[1].getAttribute("data-scroll-passthrough")).toBe("true");
    expect(frames[1].getAttribute("data-allow-wheel-boundary-scroll")).toBe("false");

    await waitFor(() => {
      expect(mockFrameHandle.renderBatch).toHaveBeenCalledWith([
        expect.objectContaining({
          mimeType: "application/vnd.jupyter.widget-view+json",
          outputId: "widget-progress-1",
        }),
        expect.objectContaining({
          mimeType: "application/vnd.jupyter.widget-view+json",
          outputId: "widget-progress-2",
        }),
      ]);
      expect(mockFrameHandle.renderBatch).toHaveBeenCalledWith([
        expect.objectContaining({
          mimeType: "application/vnd.apache.parquet",
          outputId: "parquet-output",
        }),
      ]);
    });
  });

  it("keeps an existing segmented iframe mounted when outputs append to its lane", async () => {
    const stream = makeStreamOutput("stdout one\n");
    const firstWidget = makeWidgetOutput("widget-progress-1", "model-progress-1");
    const secondWidget = makeWidgetOutput("widget-progress-2", "model-progress-2");
    const { rerender } = render(<OutputArea outputs={[...stream, firstWidget]} />);

    await waitFor(() => {
      expect(screen.getAllByTestId("isolated-frame")).toHaveLength(1);
      expect(mockFrameHandle.renderBatch).toHaveBeenCalledWith([
        expect.objectContaining({
          mimeType: "application/vnd.jupyter.widget-view+json",
          outputId: "widget-progress-1",
        }),
      ]);
    });

    expect(isolatedFrameMountCount).toBe(1);

    rerender(<OutputArea outputs={[...stream, firstWidget, secondWidget]} />);

    await waitFor(() => {
      expect(screen.getAllByTestId("isolated-frame")).toHaveLength(1);
      expect(mockFrameHandle.renderBatch).toHaveBeenCalledWith([
        expect.objectContaining({
          mimeType: "application/vnd.jupyter.widget-view+json",
          outputId: "widget-progress-1",
        }),
        expect.objectContaining({
          mimeType: "application/vnd.jupyter.widget-view+json",
          outputId: "widget-progress-2",
        }),
      ]);
    });
    expect(isolatedFrameMountCount).toBe(1);
  });

  it("aggregates search match counts across segmented output lanes", async () => {
    const onSearchMatchCount = vi.fn();

    render(
      <OutputArea
        outputs={[...makeStreamOutput("foo foo\n"), makeWidgetOutput()]}
        searchQuery="foo"
        onSearchMatchCount={onSearchMatchCount}
      />,
    );

    await waitFor(() => {
      expect(onSearchMatchCount).toHaveBeenCalledWith(2);
    });

    lastFrameMessageHandler?.({
      type: "search_results",
      payload: { count: 1 },
    });

    expect(onSearchMatchCount).toHaveBeenLastCalledWith(3);
  });

  it("does not preload hidden iframes for DOM-only segments", () => {
    render(
      <OutputArea
        outputs={[...makeStreamOutput("stdout one\n"), makeWidgetOutput()]}
        preloadIframe
      />,
    );

    expect(screen.getAllByTestId("isolated-frame")).toHaveLength(1);
  });

  it("keeps one collapse control while splitting Sift into its own boundary", () => {
    const outputs: JupyterOutput[] = [
      ...makeStreamOutput("stdout one\n"),
      makeWidgetOutput("widget-progress-1", "model-progress-1"),
      ...makeParquetOutput(),
    ];

    render(<OutputArea outputs={outputs} onToggleCollapse={vi.fn()} />);

    expect(screen.getAllByRole("button", { name: "Hide outputs" })).toHaveLength(1);
    const frames = screen.getAllByTestId("isolated-frame");
    expect(frames).toHaveLength(2);
    expect(frames[0].parentElement?.getAttribute("data-sift-output")).toBeNull();
    expect(frames[1].parentElement?.getAttribute("data-sift-output")).toBe("true");
  });

  it("reports the full collapsed output count for segmented Sift boundaries", () => {
    const outputs: JupyterOutput[] = [
      ...makeStreamOutput("stdout one\n"),
      makeWidgetOutput("widget-progress-1", "model-progress-1"),
      ...makeParquetOutput(),
    ];

    render(<OutputArea outputs={outputs} collapsed onToggleCollapse={vi.fn()} />);

    expect(screen.getAllByRole("button", { name: "Show 3 outputs" })).toHaveLength(1);
    expect(screen.queryByTestId("isolated-frame")).toBeNull();
  });

  it("preserves collapsed state for non-segmented mixed outputs", () => {
    render(
      <OutputArea outputs={makeMixedDocumentOutputs()} collapsed onToggleCollapse={vi.fn()} />,
    );

    expect(screen.getAllByRole("button", { name: "Show 3 outputs" })).toHaveLength(1);
    expect(screen.queryByText("stream before")).toBeNull();
    expect(screen.queryByTestId("isolated-frame")).toBeNull();
  });

  it("keeps forced-isolated non-Sift mixed outputs together", async () => {
    render(<OutputArea outputs={makeMixedDocumentOutputs()} isolated />);

    await waitFor(() => {
      expect(mockFrameHandle.renderBatch).toHaveBeenCalledWith([
        expect.objectContaining({
          mimeType: "text/plain",
          data: "stream before\n",
          outputIndex: 0,
        }),
        expect.objectContaining({
          mimeType: "text/html",
          data: "<b>unsafe html</b>",
          outputIndex: 1,
        }),
        expect.objectContaining({
          mimeType: "application/vnd.nteract.traceback+json",
          data: expect.objectContaining({ ename: "RecursionError" }),
          outputIndex: 2,
        }),
      ]);
    });
  });

  it("splits forced-isolated Sift outputs away from stream and HTML siblings", async () => {
    const outputs: JupyterOutput[] = [
      ...makeStreamOutput("stream before\n"),
      {
        output_id: "forced-html-output",
        output_type: "display_data",
        data: { "text/html": "<b>unsafe html</b>" },
        metadata: {},
      },
      ...makeParquetOutput(),
    ];

    render(<OutputArea outputs={outputs} isolated />);

    expect(screen.getByText(/stream before/)).toBeInTheDocument();
    const frames = screen.getAllByTestId("isolated-frame");
    expect(frames).toHaveLength(2);
    expect(frames[0].parentElement?.getAttribute("data-sift-output")).toBeNull();
    expect(frames[1].parentElement?.getAttribute("data-sift-output")).toBe("true");

    await waitFor(() => {
      const batches = mockFrameHandle.renderBatch.mock.calls.map(([batch]) => batch);
      expect(
        batches.some((batch) => batch.some((payload) => payload.mimeType === "text/html")),
      ).toBe(true);
      expect(
        batches.some((batch) =>
          batch.some((payload) => payload.mimeType === "application/vnd.apache.parquet"),
        ),
      ).toBe(true);
      expect(
        batches.some(
          (batch) =>
            batch.some((payload) => payload.mimeType === "text/html") &&
            batch.some((payload) => payload.mimeType === "application/vnd.apache.parquet"),
        ),
      ).toBe(false);
    });
  });

  it("forwards traceback navigation messages from isolated outputs", async () => {
    const onNavigateToTracebackCell = vi.fn();
    const target = { cellId: "cell-from-traceback", label: "Cell [3]" };

    render(
      <OutputArea
        outputs={makeMarkdownOutput()}
        isolated
        onNavigateToTracebackCell={onNavigateToTracebackCell}
      />,
    );

    await waitFor(() => {
      expect(lastFrameMessageHandler).toBeDefined();
    });

    lastFrameMessageHandler?.({
      type: "traceback_navigate",
      payload: { target },
    });

    expect(onNavigateToTracebackCell).toHaveBeenCalledWith(target);
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
