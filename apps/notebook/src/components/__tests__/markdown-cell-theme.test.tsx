import { fireEvent, render, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { MarkdownCell as MarkdownCellType } from "../../types";

let mockIsFocused = false;
const outputAreaProps: Array<Record<string, unknown>> = [];

vi.mock("@/components/cell/OutputArea", () => ({
  OutputArea: (props: Record<string, unknown>) => {
    outputAreaProps.push(props);
    return (
      <div
        data-testid="markdown-output-area"
        onMouseDown={() => (props.onIframeMouseDown as (() => void) | undefined)?.()}
      />
    );
  },
}));

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

function makeCell(): MarkdownCellType {
  return {
    cell_type: "markdown",
    id: "md-1",
    source: "```python\nprint('hello')\n```",
    metadata: {},
  };
}

describe("MarkdownCell preview rendering", () => {
  beforeEach(() => {
    mockIsFocused = false;
    outputAreaProps.length = 0;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders markdown source through the isolated output area", () => {
    render(<MarkdownCell cell={makeCell()} onFocus={() => {}} onDelete={() => {}} />);

    expect(outputAreaProps.at(-1)).toEqual(
      expect.objectContaining({
        cellId: "md-1",
        className: "!pl-0 !pr-0",
        isolated: true,
        outputs: [
          {
            output_type: "display_data",
            data: { "text/markdown": "```python\nprint('hello')\n```" },
            metadata: {},
          },
        ],
      }),
    );
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

  it("calls the cell focus handler when the markdown output iframe is activated", () => {
    const onFocus = vi.fn();

    const { getByTestId } = render(
      <MarkdownCell cell={makeCell()} onFocus={onFocus} onDelete={() => {}} />,
    );

    fireEvent.mouseDown(getByTestId("markdown-output-area"));

    expect(onFocus).toHaveBeenCalled();
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

  it("renders a late markdown source when the cell leaves edit mode", async () => {
    const emptyCell = { ...makeCell(), source: "" };
    const { getByTestId, rerender } = render(
      <MarkdownCell cell={emptyCell} onFocus={() => {}} onDelete={() => {}} />,
    );

    expect(outputAreaProps).toHaveLength(0);

    const filledCell = { ...makeCell(), source: "# Late source" };
    rerender(<MarkdownCell cell={filledCell} onFocus={() => {}} onDelete={() => {}} />);

    expect(outputAreaProps).toHaveLength(0);

    fireEvent.keyDown(getByTestId("markdown-editor"), {
      key: "Enter",
      ctrlKey: true,
    });

    await waitFor(() => {
      expect(outputAreaProps.at(-1)).toEqual(
        expect.objectContaining({
          outputs: [
            {
              output_type: "display_data",
              data: { "text/markdown": "# Late source" },
              metadata: {},
            },
          ],
        }),
      );
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
