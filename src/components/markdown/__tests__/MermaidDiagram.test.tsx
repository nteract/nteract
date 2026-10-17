import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { MarkdownCodeBlock } from "../MarkdownCodeBlock";
import { MermaidDiagram } from "../MermaidDiagram";
import { mountMermaid } from "../mermaid-renderer";
import { ProjectedMarkdownView } from "../ProjectedMarkdownView";
import { MarkdownOutput } from "../../outputs/markdown-output";

vi.mock("../mermaid-renderer", () => ({ mountMermaid: vi.fn() }));
const mount = vi.mocked(mountMermaid);

describe("Mermaid Markdown blocks", () => {
  afterEach(() => vi.unstubAllGlobals());
  beforeEach(() => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    );
    mount.mockReset();
    mount.mockImplementation((element, source, _id, callbacks) => {
      element.textContent = `Diagram: ${source}`;
      callbacks.onRender?.({ svg: "", width: 1, height: 1, type: "flowchart", links: [] });
      return {
        destroy: vi.fn(),
        refresh: vi.fn(),
        update: vi.fn(),
        result: { svg: "", width: 1, height: 1, type: "flowchart", links: [] },
        zoom: undefined,
      };
    });
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
  });

  it("renders diagrams, switches to source, and copies the original source", async () => {
    const code = "flowchart LR\nA --> B";
    render(<MarkdownCodeBlock code={code} language="mermaid" colorTheme="classic" />);
    await screen.findByText("Diagram: flowchart LR A --> B");
    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(code);
    const instance = mount.mock.results[0].value;
    fireEvent.click(screen.getByRole("button", { name: "Show source" }));
    expect(instance.destroy).toHaveBeenCalledOnce();
    expect(screen.queryByLabelText("Mermaid diagram")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show diagram" }));
    await waitFor(() => expect(mount).toHaveBeenCalledTimes(2));
  });

  it("keeps invalid source available, escapes the error, and recovers after an edit", async () => {
    mount.mockImplementationOnce(() => {
      throw new Error('<img src=x onerror="alert(1)">');
    });
    const { container, rerender } = render(
      <MermaidDiagram source="broken" fallback={<pre>broken source</pre>} />,
    );
    await screen.findByText(/Diagram unavailable:/);
    expect(screen.getByText("broken source")).toBeVisible();
    expect(container.querySelector("img")).toBeNull();
    rerender(<MermaidDiagram source="flowchart LR; A-->B" fallback={<pre>new source</pre>} />);
    await screen.findByText("Diagram: flowchart LR; A-->B");
    expect(screen.queryByText(/Diagram unavailable:/)).toBeNull();
    expect(screen.queryByText("new source")).toBeNull();
  });

  it("ignores callbacks from an obsolete source and destroys observers on unmount", async () => {
    const { rerender, unmount } = render(<MermaidDiagram source="first" fallback={null} />);
    await waitFor(() => expect(mount).toHaveBeenCalledOnce());
    const stale = mount.mock.calls[0][3];
    const first = mount.mock.results[0].value;
    rerender(<MermaidDiagram source="second" fallback={null} />);
    await screen.findByText("Diagram: second");
    expect(first.destroy).toHaveBeenCalledOnce();
    stale.onError?.(new Error("stale failure"));
    expect(screen.queryByText(/stale failure/)).toBeNull();
    const second = mount.mock.results[1].value;
    unmount();
    expect(second.destroy).toHaveBeenCalledOnce();
  });

  it("does not mount a renderer for ordinary code", () => {
    render(<MarkdownCodeBlock code="print(1)" language="python" colorTheme="classic" />);
    expect(mount).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Show source" })).toBeNull();
  });

  it.each(["mermaid", "code"])(
    "renders %s projections through the shared renderer",
    async (kind) => {
      render(
        <ProjectedMarkdownView
          plan={{
            version: 1,
            engine: "test",
            byteLength: 0,
            utf16Length: 0,
            measurement: { estimatedHeight: 240, confidence: "low", width: 720 },
            anchors: [],
            runs: [],
            blocks: [
              {
                blockId: "diagram",
                blockIndex: 0,
                element: "div",
                kind,
                codeLanguage: "MERMAID",
                text: "flowchart LR; A-->B",
                measurement: { estimatedHeight: 240, confidence: "low", width: 720 },
                sourceSpanByte: [0, 0],
                sourceSpanUtf16: [0, 0],
                syntaxSpans: [],
              },
            ],
          }}
        />,
      );
      await screen.findByText("Diagram: flowchart LR; A-->B");
    },
  );

  it("renders fenced Mermaid in Markdown MIME outputs", async () => {
    vi.stubGlobal("self", {});
    render(<MarkdownOutput content={"```mermaid\nflowchart LR; A-->B\n```"} />);
    await screen.findByText("Diagram: flowchart LR; A-->B");
    expect(mount.mock.calls[0][1]).toBe("flowchart LR; A-->B");
  });
});
