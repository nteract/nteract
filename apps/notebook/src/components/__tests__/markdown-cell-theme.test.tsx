import { fireEvent, render, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { JupyterOutput } from "@/components/cell/jupyter-output";
import type { MarkdownCell as MarkdownCellType } from "../../types";

let mockIsFocused = false;
let mockSearchQuery = "";

const outputAreaCalls = vi.hoisted(() => ({
  props: [] as Array<{
    cellId?: string;
    className?: string;
    onIframeMouseDown?: () => void;
    onLinkClick?: (url: string, newTab: boolean) => void;
    outputs: JupyterOutput[];
    searchQuery?: string;
  }>,
}));

vi.mock("@/components/cell/OutputArea", () => ({
  OutputArea: (props: {
    cellId?: string;
    className?: string;
    onIframeMouseDown?: () => void;
    onLinkClick?: (url: string, newTab: boolean) => void;
    outputs: JupyterOutput[];
    searchQuery?: string;
  }) => {
    outputAreaCalls.props.push(props);
    return (
      <div
        data-cell-id={props.cellId}
        data-class-name={props.className ?? ""}
        data-search-query={props.searchQuery ?? ""}
        data-testid="markdown-output-area"
      />
    );
  },
}));

vi.mock("@/components/cell/CellContainer", () => ({
  CellContainer: ({
    codeContent,
    onFocus,
    rightGutterContent,
  }: {
    codeContent: React.ReactNode;
    onFocus?: () => void;
    rightGutterContent?: React.ReactNode;
  }) => (
    <div onMouseDown={onFocus}>
      {codeContent}
      {rightGutterContent}
    </div>
  ),
}));

vi.mock("@/components/editor/codemirror-editor", () => ({
  CodeMirrorEditor: React.forwardRef(function CodeMirrorEditor(
    props: {
      initialValue?: string;
      keyMap?: Array<{ key: string; run: () => boolean }>;
      onBlur?: () => void;
      placeholder?: string;
    },
    ref,
  ) {
    React.useImperativeHandle(ref, () => ({
      focus: vi.fn(),
      setCursorPosition: vi.fn(),
      getEditor: () => ({
        state: {
          doc: {
            toString: () => props.initialValue ?? "",
          },
        },
      }),
    }));

    return (
      <div
        data-placeholder={props.placeholder}
        data-testid="markdown-editor"
        tabIndex={0}
        onBlur={props.onBlur}
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
  useBlobResolver: () => new Map([["asset.png", "blob://asset.png"]]),
  useBlobPort: () => null,
}));

vi.mock("../../lib/cell-ui-state", () => ({
  useIsCellFocused: () => mockIsFocused,
  useIsNextCellFromFocused: () => false,
  useIsPreviousCellFromFocused: () => false,
  useSearchQuery: () => mockSearchQuery,
}));

vi.mock("../../lib/cursor-registry", () => ({
  onEditorRegistered: vi.fn(),
  onEditorUnregistered: vi.fn(),
}));

vi.mock("../../lib/editor-registry", () => ({
  registerCellEditor: vi.fn(),
  unregisterCellEditor: vi.fn(),
}));

vi.mock("../../lib/isolated-diagnostics", () => ({
  logNotebookIsolatedDiagnostic: vi.fn(),
}));

vi.mock("../../lib/markdown-assets", () => ({
  rewriteMarkdownAssetRefs: (
    source: string,
    resolvedAssets: Record<string, string> | undefined,
    blobResolver: Map<string, string>,
  ) => source.replace("asset.png", resolvedAssets?.["asset.png"] ?? blobResolver.get("asset.png")),
}));

const openUrlMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/open-url", () => ({
  openUrl: openUrlMock,
}));

vi.mock("../../lib/presence-sender", () => ({
  presenceSenderExtension: () => [],
}));

import { MarkdownCell } from "../MarkdownCell";

function makeCell(): MarkdownCellType {
  return {
    cell_type: "markdown",
    id: "md-1",
    source: "![asset](asset.png)",
    metadata: {},
    resolvedAssets: { "asset.png": "blob://resolved-asset.png" },
  };
}

describe("MarkdownCell shared surface adapter", () => {
  beforeEach(() => {
    mockIsFocused = false;
    mockSearchQuery = "";
    outputAreaCalls.props.length = 0;
    openUrlMock.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("passes resolved markdown source into the shared output surface", () => {
    render(<MarkdownCell cell={makeCell()} onFocus={() => {}} onDelete={() => {}} />);

    const markdownOutput = outputAreaCalls.props.at(-1)?.outputs[0];
    expect(markdownOutput?.data["text/markdown"]).toBe("![asset](blob://resolved-asset.png)");
  });

  it("passes heading anchors to the shared markdown output metadata", () => {
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

    expect(outputAreaCalls.props.at(-1)?.outputs[0]?.metadata).toEqual({
      nteractMarkdownHeadingAnchors: headingAnchors,
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

  it("passes search, iframe focus, and link opening through the shared output surface", () => {
    mockSearchQuery = "needle";
    const onFocus = vi.fn();

    render(<MarkdownCell cell={makeCell()} onFocus={onFocus} onDelete={() => {}} />);

    const props = outputAreaCalls.props.at(-1);
    expect(props?.searchQuery).toBe("needle");

    props?.onIframeMouseDown?.();
    expect(onFocus).toHaveBeenCalled();

    props?.onLinkClick?.("https://example.test", true);
    expect(openUrlMock).toHaveBeenCalledWith("https://example.test");
  });

  it("Ctrl+Enter exits edit mode for empty markdown cells", async () => {
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
});
