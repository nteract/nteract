import { act, createEvent, fireEvent, render, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { MarkdownCell as MarkdownCellType } from "../../types";

let mockDarkMode = false;
let mockColorTheme: string | undefined;
let mockIsFocused = false;
const isolatedFrameProps: Array<Record<string, unknown>> = [];

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

vi.mock("@/components/isolated/iframe-libraries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/isolated/iframe-libraries")>();
  return {
    ...actual,
    injectPluginsForMimes: vi.fn(async () => {}),
  };
});

vi.mock("@/components/isolated", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/isolated")>();
  const React = await import("react");

  const MockIsolatedFrame = React.forwardRef<
    typeof mockFrameHandle,
    Record<string, unknown> & { onMouseDown?: () => void; onReady?: () => void }
  >(function MockIsolatedFrame(props, ref) {
    isolatedFrameProps.push(props);
    React.useImperativeHandle(ref, () => mockFrameHandle);

    React.useEffect(() => {
      props.onReady?.();
    }, [props.onReady]);

    return (
      <iframe
        data-testid="markdown-frame"
        data-slot="isolated-frame"
        onMouseDown={props.onMouseDown}
      />
    );
  });

  return {
    ...actual,
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

vi.mock("../../lib/cell-ui-state", () => ({
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
    vi.clearAllMocks();
  });

  it("passes the current color theme to the markdown iframe and re-syncs it on ready", async () => {
    mockColorTheme = "cream";

    render(<MarkdownCell cell={makeCell()} onFocus={() => {}} onDelete={() => {}} />);

    await waitFor(() => {
      expect(mockFrameHandle.setTheme).toHaveBeenCalledWith(false, "cream");
    });

    expect(isolatedFrameProps.at(-1)?.colorTheme).toBe("cream");
    expect(isolatedFrameProps.at(-1)?.revealOnRender).toBe(true);

    await waitFor(() => {
      expect(mockFrameHandle.renderBatch).toHaveBeenCalledWith([
        expect.objectContaining({
          mimeType: "text/markdown",
          data: "```python\nprint('hello')\n```",
          outputId: "markdown:md-1",
          cellId: "md-1",
        }),
      ]);
    });
  });

  it("renders a contained fallback when the markdown renderer plugin fails to load", async () => {
    vi.mocked(injectPluginsForMimes).mockRejectedValue(new Error("chunk failed"));

    render(<MarkdownCell cell={makeCell()} onFocus={() => {}} onDelete={() => {}} />);

    await waitFor(() => {
      expect(mockFrameHandle.renderBatch).toHaveBeenCalledWith([
        expect.objectContaining({
          mimeType: "text/plain",
          data: "Failed to load renderer plugin: chunk failed",
          outputId: "md-1:plugin-load-error",
          cellId: "md-1",
        }),
      ]);
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
      expect(mockFrameHandle.renderBatch).toHaveBeenCalledWith([
        expect.objectContaining({
          mimeType: "text/markdown",
          data: "# Load data",
          metadata: { nteractMarkdownHeadingAnchors: headingAnchors },
          outputId: "markdown:md-1",
          cellId: "md-1",
        }),
      ]);
    });
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

  it("lets the markdown iframe own pointer interaction without entering output-well layout", async () => {
    const onFocus = vi.fn();

    const { getByLabelText } = render(
      <MarkdownCell cell={makeCell()} onFocus={onFocus} onDelete={() => {}} />,
    );

    expect(isolatedFrameProps.at(-1)?.scrollPassthrough).toBe(true);
    expect(isolatedFrameProps.at(-1)?.allowWheelBoundaryScroll).toBe(false);
    expect(isolatedFrameProps.at(-1)?.autoHeight).toBe(true);

    const previewWrapper = getByLabelText("Markdown cell content");

    fireEvent.pointerDown(previewWrapper);

    expect(onFocus).toHaveBeenCalled();
    await waitFor(() => {
      expect(isolatedFrameProps.at(-1)?.scrollPassthrough).toBe(false);
      expect(isolatedFrameProps.at(-1)?.allowWheelBoundaryScroll).toBe(true);
      expect(isolatedFrameProps.at(-1)?.autoHeight).toBe(true);
    });

    pointerOutWithButtons(previewWrapper, 1);
    pointerOutWithButtons(previewWrapper, 0);
    await waitFor(() => {
      expect(isolatedFrameProps.at(-1)?.scrollPassthrough).toBe(true);
      expect(isolatedFrameProps.at(-1)?.allowWheelBoundaryScroll).toBe(false);
    });
  });

  it("enters edit mode from double-clicks forwarded by the iframe", async () => {
    const { getByTestId } = render(
      <MarkdownCell cell={makeCell()} onFocus={() => {}} onDelete={() => {}} />,
    );

    expect(getByTestId("markdown-frame")).toBeVisible();

    act(() => {
      (isolatedFrameProps.at(-1)?.onDoubleClick as (() => void) | undefined)?.();
    });

    await waitFor(() => {
      expect(getByTestId("markdown-editor")).toBeVisible();
    });
  });

  it("Ctrl+Enter exits edit mode for markdown cells", async () => {
    const cell = { ...makeCell(), source: "" };

    const { getByTestId, queryByLabelText, findByLabelText } = render(
      <MarkdownCell cell={cell} onFocus={() => {}} onDelete={() => {}} />,
    );

    expect(queryByLabelText("Markdown cell content")?.className).toContain("hidden");

    fireEvent.keyDown(getByTestId("markdown-editor"), {
      key: "Enter",
      ctrlKey: true,
    });

    await expect(findByLabelText("Markdown cell content")).resolves.toBeVisible();
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
});
