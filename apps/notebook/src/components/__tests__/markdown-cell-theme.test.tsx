import { act, createEvent, fireEvent, render, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { MarkdownCell as MarkdownCellType } from "../../types";

let mockDarkMode = false;
let mockColorTheme: string | undefined;
let mockIsFocused = false;
const isolatedFrameProps: Array<Record<string, unknown>> = [];
let lastFrameMouseUp: ((params: { hasSelection?: boolean }) => void) | undefined;
let lastFrameDoubleClick: (() => void) | undefined;

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
  measureElement: vi.fn(async () => null),
  isReady: true,
  isIframeReady: true,
};

vi.mock("@/lib/dark-mode", () => ({
  useDarkMode: () => mockDarkMode,
  useColorTheme: () => mockColorTheme,
}));

vi.mock("@/components/isolated/iframe-libraries", () => ({
  injectPluginsForMimes: vi.fn(async () => {}),
}));

vi.mock("@/components/isolated", async () => {
  const React = await import("react");

  const MockIsolatedFrame = React.forwardRef<
    typeof mockFrameHandle,
    Record<string, unknown> & {
      onMouseDown?: () => void;
      onMouseUp?: (params: { hasSelection?: boolean }) => void;
      onDoubleClick?: () => void;
      onReady?: () => void;
    }
  >(function MockIsolatedFrame(props, ref) {
    isolatedFrameProps.push(props);
    React.useImperativeHandle(ref, () => mockFrameHandle);

    React.useEffect(() => {
      props.onReady?.();
    }, [props.onReady]);

    React.useEffect(() => {
      lastFrameMouseUp = props.onMouseUp;
      lastFrameDoubleClick = props.onDoubleClick;
      return () => {
        if (lastFrameMouseUp === props.onMouseUp) {
          lastFrameMouseUp = undefined;
        }
        if (lastFrameDoubleClick === props.onDoubleClick) {
          lastFrameDoubleClick = undefined;
        }
      };
    }, [props.onDoubleClick, props.onMouseUp]);

    return (
      <iframe
        data-testid="markdown-frame"
        data-slot="isolated-frame"
        onMouseDown={props.onMouseDown}
        onDoubleClick={props.onDoubleClick}
      />
    );
  });

  return {
    IsolatedFrame: MockIsolatedFrame,
  };
});

vi.mock("@/components/cell/CellContainer", () => ({
  CellContainer: ({ codeContent }: { codeContent: React.ReactNode }) => <div>{codeContent}</div>,
}));

vi.mock("@/components/editor/codemirror-editor", () => ({
  CodeMirrorEditor: React.forwardRef(function CodeMirrorEditor(
    props: { keyMap?: Array<{ key: string; run: () => boolean }> },
    _ref,
  ) {
    return (
      <div
        data-testid="markdown-editor"
        tabIndex={0}
        onKeyDown={(event) => {
          const key = event.ctrlKey && event.key === "Enter" ? "Ctrl-Enter" : event.key;
          const binding = props.keyMap?.find((entry) => entry.key === key);
          if (binding?.run()) {
            event.preventDefault();
          }
        }}
      />
    );
  }),
}));

vi.mock("@/components/editor/remote-cursors", () => ({
  remoteCursorsExtension: () => [],
}));

vi.mock("@/components/editor/search-highlight", () => ({
  searchHighlight: () => [],
}));

vi.mock("@/components/editor/text-attribution", () => ({
  textAttributionExtension: () => [],
}));

vi.mock("../cell/CellPresenceIndicators", () => ({
  CellPresenceIndicators: () => null,
}));

vi.mock("../../contexts/PresenceContext", () => ({
  usePresenceContext: () => null,
}));

vi.mock("../../hooks/useCellKeyboardNavigation", () => ({
  useCellKeyboardNavigation: () => [],
}));

vi.mock("../../hooks/useCrdtBridge", () => ({
  useCrdtBridge: () => ({ extension: [] }),
}));

vi.mock("../../lib/blob-port", () => ({
  useBlobResolver: () => null,
  useBlobPort: () => null,
}));

vi.mock("@/components/notebook/state/cell-ui-state", () => ({
  useIsCellFocused: () => mockIsFocused,
  useIsNextCellFromFocused: () => false,
  useIsPreviousCellFromFocused: () => false,
  useSearchQuery: () => "",
}));

vi.mock("../../lib/cursor-registry", () => ({
  onEditorRegistered: vi.fn(),
  onEditorUnregistered: vi.fn(),
}));

vi.mock("../../lib/editor-registry", () => ({
  registerCellEditor: vi.fn(),
  unregisterCellEditor: vi.fn(),
}));

vi.mock("../../lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn() },
}));

vi.mock("../../lib/markdown-assets", () => ({
  rewriteMarkdownAssetRefs: (source: string) => source,
}));

vi.mock("../../lib/open-url", () => ({
  openUrl: vi.fn(),
}));

vi.mock("../../lib/presence-sender", () => ({
  presenceSenderExtension: () => [],
}));

import { MarkdownCell } from "../MarkdownCell";
import { injectPluginsForMimes } from "@/components/isolated/iframe-libraries";

function makeCell(): MarkdownCellType {
  return {
    cell_type: "markdown",
    id: "md-1",
    source: "```python\nprint('hello')\n```",
    metadata: {},
  };
}

function pointerOutWithButtons(element: HTMLElement, buttons: number) {
  const event = createEvent.pointerOut(element);
  Object.defineProperty(event, "buttons", { value: buttons });
  fireEvent(element, event);
}

describe("MarkdownCell theme sync", () => {
  beforeEach(() => {
    mockDarkMode = false;
    mockColorTheme = undefined;
    mockIsFocused = false;
    isolatedFrameProps.length = 0;
    lastFrameMouseUp = undefined;
    lastFrameDoubleClick = undefined;
    mockFrameHandle.send.mockClear();
    mockFrameHandle.render.mockClear();
    mockFrameHandle.renderBatch.mockClear();
    mockFrameHandle.eval.mockClear();
    mockFrameHandle.installRenderer.mockClear();
    mockFrameHandle.setTheme.mockClear();
    mockFrameHandle.clear.mockClear();
    mockFrameHandle.search.mockClear();
    mockFrameHandle.searchNavigate.mockClear();
    mockFrameHandle.measureElement.mockClear();
    vi.mocked(injectPluginsForMimes).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("passes the current color theme to the markdown iframe and re-syncs it on ready", async () => {
    mockColorTheme = "cream";

    render(<MarkdownCell cell={makeCell()} onFocus={() => {}} onDelete={() => {}} />);

    await waitFor(() => {
      expect(mockFrameHandle.setTheme).toHaveBeenCalledWith(false, "cream");
    });

    expect(isolatedFrameProps.at(-1)?.colorTheme).toBe("cream");

    await waitFor(() => {
      expect(mockFrameHandle.render).toHaveBeenCalledWith({
        mimeType: "text/markdown",
        data: "```python\nprint('hello')\n```",
        outputId: "markdown:md-1",
        cellId: "md-1",
        replace: true,
      });
    });
  });

  it("renders a contained fallback when the markdown renderer plugin fails to load", async () => {
    vi.mocked(injectPluginsForMimes).mockRejectedValue(new Error("chunk failed"));

    render(<MarkdownCell cell={makeCell()} onFocus={() => {}} onDelete={() => {}} />);

    await waitFor(() => {
      expect(mockFrameHandle.render).toHaveBeenCalledWith({
        mimeType: "text/plain",
        data: "Failed to load markdown renderer: chunk failed",
        outputId: "markdown-error:md-1",
        cellId: "md-1",
        replace: true,
      });
    });
  });

  it("passes heading anchors to the markdown renderer metadata", async () => {
    const headingAnchors = [
      {
        itemId: "md-1:heading:0",
        title: "Load data",
        level: 1,
        anchor: "load-data",
        headingAnchorId: "notebook-cell-md-1-heading-load-data",
      },
    ];

    render(
      <MarkdownCell
        cell={{ ...makeCell(), source: "# Load data" }}
        headingAnchors={headingAnchors}
        onFocus={() => {}}
        onDelete={() => {}}
      />,
    );

    await waitFor(() => {
      expect(mockFrameHandle.render).toHaveBeenCalledWith({
        mimeType: "text/markdown",
        data: "# Load data",
        metadata: { nteractMarkdownHeadingAnchors: headingAnchors },
        outputId: "markdown:md-1",
        cellId: "md-1",
        replace: true,
      });
    });
  });

  it("reserves a markdown-sized preview while the isolated renderer loads", () => {
    render(
      <MarkdownCell
        cell={{
          ...makeCell(),
          source: "# Heading\n\nThis paragraph should reserve document geometry.",
        }}
        onFocus={() => {}}
        onDelete={() => {}}
      />,
    );

    const frameProps = isolatedFrameProps.at(-1);
    expect(frameProps?.revealOnRender).toBe(true);
    expect(frameProps?.reserveHeightOnReveal).toBe(true);
    expect(frameProps?.minHeight).toBeGreaterThan(24);
  });

  it("focuses the markdown preview without scrolling when the cell becomes focused", async () => {
    const focusSpy = vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(() => undefined);

    const { rerender } = render(
      <MarkdownCell cell={makeCell()} onFocus={() => {}} onDelete={() => {}} />,
    );

    expect(focusSpy).not.toHaveBeenCalledWith({ preventScroll: true });

    mockIsFocused = true;
    rerender(<MarkdownCell cell={makeCell()} onFocus={() => {}} onDelete={() => {}} />);

    await waitFor(() => {
      expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true });
    });
  });

  it("activates markdown iframe pointer interaction after clicking the preview", () => {
    const onFocus = vi.fn();

    const { getByTestId } = render(
      <MarkdownCell cell={makeCell()} onFocus={onFocus} onDelete={() => {}} />,
    );

    expect(isolatedFrameProps.at(-1)?.scrollPassthrough).toBe(true);
    expect(isolatedFrameProps.at(-1)?.allowWheelBoundaryScroll).toBe(false);

    const previewWrapper = getByTestId("markdown-frame").parentElement as HTMLElement;

    fireEvent.pointerDown(previewWrapper);

    expect(onFocus).toHaveBeenCalled();
    expect(isolatedFrameProps.at(-1)?.scrollPassthrough).toBe(false);
    expect(isolatedFrameProps.at(-1)?.allowWheelBoundaryScroll).toBe(true);

    pointerOutWithButtons(previewWrapper, 1);

    expect(isolatedFrameProps.at(-1)?.scrollPassthrough).toBe(false);
    expect(isolatedFrameProps.at(-1)?.allowWheelBoundaryScroll).toBe(true);

    pointerOutWithButtons(previewWrapper, 0);

    expect(isolatedFrameProps.at(-1)?.scrollPassthrough).toBe(true);
    expect(isolatedFrameProps.at(-1)?.allowWheelBoundaryScroll).toBe(false);
  });

  it("releases markdown iframe pointer interaction after a plain iframe click", () => {
    const { getByTestId } = render(
      <MarkdownCell cell={makeCell()} onFocus={() => {}} onDelete={() => {}} />,
    );

    const previewWrapper = getByTestId("markdown-frame").parentElement as HTMLElement;

    fireEvent.pointerDown(previewWrapper);

    expect(isolatedFrameProps.at(-1)?.scrollPassthrough).toBe(false);

    act(() => {
      lastFrameMouseUp?.({ hasSelection: false });
    });

    expect(isolatedFrameProps.at(-1)?.scrollPassthrough).toBe(true);
    expect(isolatedFrameProps.at(-1)?.allowWheelBoundaryScroll).toBe(false);
  });

  it("keeps markdown iframe interaction active after text selection", () => {
    const { getByTestId } = render(
      <MarkdownCell cell={makeCell()} onFocus={() => {}} onDelete={() => {}} />,
    );

    const previewWrapper = getByTestId("markdown-frame").parentElement as HTMLElement;

    fireEvent.pointerDown(previewWrapper);

    act(() => {
      lastFrameMouseUp?.({ hasSelection: true });
    });

    expect(isolatedFrameProps.at(-1)?.scrollPassthrough).toBe(false);
    expect(isolatedFrameProps.at(-1)?.allowWheelBoundaryScroll).toBe(true);
  });

  it("does not time out markdown iframe interaction before a selection mouseup", () => {
    vi.useFakeTimers();

    const { getByTestId } = render(
      <MarkdownCell cell={makeCell()} onFocus={() => {}} onDelete={() => {}} />,
    );

    const previewWrapper = getByTestId("markdown-frame").parentElement as HTMLElement;

    fireEvent.pointerDown(previewWrapper);

    expect(isolatedFrameProps.at(-1)?.scrollPassthrough).toBe(false);

    act(() => {
      vi.advanceTimersByTime(1_000);
    });

    expect(isolatedFrameProps.at(-1)?.scrollPassthrough).toBe(false);
    expect(isolatedFrameProps.at(-1)?.allowWheelBoundaryScroll).toBe(true);
  });

  it("enters edit mode from an iframe double-click", async () => {
    mockIsFocused = true;
    const onFocus = vi.fn();

    const { getByLabelText } = render(
      <MarkdownCell cell={makeCell()} onFocus={onFocus} onDelete={() => {}} />,
    );

    const preview = getByLabelText("Markdown cell content");
    expect(preview.className).not.toContain("hidden");

    act(() => {
      lastFrameDoubleClick?.();
    });

    await waitFor(() => {
      expect(preview.className).toContain("hidden");
    });
    expect(onFocus).toHaveBeenCalled();
    expect(isolatedFrameProps.at(-1)?.scrollPassthrough).toBe(true);
  });

  it("Ctrl+Enter exits edit mode for markdown cells", async () => {
    const cell = { ...makeCell(), source: "" };

    const { getByLabelText, getByTestId } = render(
      <MarkdownCell cell={cell} onFocus={() => {}} onDelete={() => {}} />,
    );

    const preview = getByLabelText("Markdown cell content");
    expect(preview.className).toContain("hidden");

    fireEvent.keyDown(getByTestId("markdown-editor"), {
      key: "Enter",
      ctrlKey: true,
    });

    await waitFor(() => {
      expect(preview.className).not.toContain("hidden");
    });
  });

  it("Ctrl+Enter keeps markdown preview in view mode", () => {
    const { getByLabelText } = render(
      <MarkdownCell cell={makeCell()} onFocus={() => {}} onDelete={() => {}} />,
    );

    const preview = getByLabelText("Markdown cell content");
    expect(preview.className).not.toContain("hidden");

    fireEvent.keyDown(preview, { key: "Enter", ctrlKey: true });

    expect(preview.className).not.toContain("hidden");
  });

  it("exits edit mode when a focused cell with content loses notebook focus", async () => {
    const cell = { ...makeCell(), source: "# Has content" };
    mockIsFocused = true;

    const { getByLabelText, rerender } = render(
      <MarkdownCell cell={cell} onFocus={() => {}} onDelete={() => {}} />,
    );

    const preview = getByLabelText("Markdown cell content");
    // Enter edit mode from the preview (plain Enter on the focused view).
    fireEvent.keyDown(preview, { key: "Enter" });

    await waitFor(() => {
      expect(preview.className).toContain("hidden");
    });

    // Notebook focus moves to another cell — the focus effect should drop
    // this cell back to preview because it has content.
    mockIsFocused = false;
    rerender(<MarkdownCell cell={cell} onFocus={() => {}} onDelete={() => {}} />);

    await waitFor(() => {
      expect(preview.className).not.toContain("hidden");
    });
  });

  it("stays editable when an empty cell loses notebook focus", async () => {
    // Empty cells begin in edit mode and must not be forced into an
    // uneditable preview when notebook focus moves away.
    const cell = { ...makeCell(), source: "" };
    mockIsFocused = true;

    const { getByLabelText, rerender } = render(
      <MarkdownCell cell={cell} onFocus={() => {}} onDelete={() => {}} />,
    );

    const preview = getByLabelText("Markdown cell content");
    expect(preview.className).toContain("hidden");

    mockIsFocused = false;
    rerender(<MarkdownCell cell={cell} onFocus={() => {}} onDelete={() => {}} />);

    // The editor must remain visible (preview stays hidden) after losing focus.
    await waitFor(() => {
      expect(preview.className).toContain("hidden");
    });
  });

  it("keeps view-mode keyboard navigation active for read-only markdown cells", () => {
    const onFocusNext = vi.fn();
    const onFocusPrevious = vi.fn();

    const { getByLabelText } = render(
      <MarkdownCell
        cell={makeCell()}
        onFocus={() => {}}
        onDelete={() => {}}
        onFocusNext={onFocusNext}
        onFocusPrevious={onFocusPrevious}
        readOnly
      />,
    );

    const preview = getByLabelText("Markdown cell content");

    fireEvent.keyDown(preview, { key: "ArrowDown" });
    expect(onFocusNext).toHaveBeenCalledWith("start");

    fireEvent.keyDown(preview, { key: "ArrowUp" });
    expect(onFocusPrevious).toHaveBeenCalledWith("end");

    fireEvent.keyDown(preview, { key: "Enter", shiftKey: true });
    expect(onFocusNext).toHaveBeenCalledTimes(2);
    expect(onFocusNext).toHaveBeenLastCalledWith("start");

    fireEvent.keyDown(preview, { key: "Enter" });
    expect(preview.className).not.toContain("hidden");
  });
});
