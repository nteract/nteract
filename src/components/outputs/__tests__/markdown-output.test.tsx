import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { MarkdownOutput } from "../markdown-output";

describe("MarkdownOutput heading anchors", () => {
  const originalTop = Object.getOwnPropertyDescriptor(window, "top");
  const originalMatchMedia = Object.getOwnPropertyDescriptor(window, "matchMedia");

  beforeEach(() => {
    Object.defineProperty(window, "top", {
      configurable: true,
      value: {},
    });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
  });

  afterEach(() => {
    if (originalTop) {
      Object.defineProperty(window, "top", originalTop);
    }
    if (originalMatchMedia) {
      Object.defineProperty(window, "matchMedia", originalMatchMedia);
    } else {
      delete (window as Partial<Window>).matchMedia;
    }
  });

  it("applies deterministic outline anchor ids to rendered markdown headings", () => {
    render(
      <MarkdownOutput
        content={"# Load data\n\n## Clean columns"}
        headingAnchors={[
          {
            itemId: "cell-a:heading:0",
            title: "Load data",
            level: 1,
            anchor: "load-data",
            headingAnchorId: "notebook-cell-cell-a-heading-load-data",
          },
          {
            itemId: "cell-a:heading:1",
            title: "Clean columns",
            level: 2,
            anchor: "clean-columns",
            headingAnchorId: "notebook-cell-cell-a-heading-clean-columns",
          },
        ]}
      />,
    );

    expect(screen.getByRole("heading", { name: /Load data/ })).toHaveAttribute(
      "id",
      "notebook-cell-cell-a-heading-load-data",
    );
    expect(screen.getByRole("heading", { name: /Clean columns/ })).toHaveAttribute(
      "data-nteract-outline-item-id",
      "cell-a:heading:1",
    );
    expect(screen.getByRole("link", { name: "Link to Load data" })).toHaveAttribute(
      "href",
      "#notebook-cell-cell-a-heading-load-data",
    );
  });

  it("renders links with a visible default underline", () => {
    render(<MarkdownOutput content={"Read the [paper](https://example.com/paper)."} />);

    expect(screen.getByRole("link", { name: "paper" })).toHaveClass(
      "underline",
      "decoration-primary/45",
      "underline-offset-4",
    );
  });

  it("uses the shared evidence table treatment", () => {
    render(<MarkdownOutput content={"| metric | value |\n| --- | ---: |\n| rows | 128 |"} />);

    expect(screen.getByRole("table").parentElement).toHaveClass(
      "rounded-sm",
      "border",
      "shadow-sm",
    );
    expect(screen.getByRole("columnheader", { name: "metric" })).toHaveClass(
      "border-border/80",
      "py-2.5",
    );
    expect(screen.getByRole("cell", { name: "128" })).toHaveClass(
      "border-border/70",
      "text-muted-foreground",
    );
  });

  it("renders display math plainly in the document flow", () => {
    const { container } = render(<MarkdownOutput content={"$$\n\\\\int_0^1 x dx\n$$"} />);

    const displayMath = document.querySelector(".katex-display");
    expect(displayMath).not.toBeNull();
    expect(container.querySelector('[data-slot="markdown-output"]')).toHaveClass(
      "[&_.katex-display]:my-5",
      "[&_.katex-display]:overflow-x-auto",
      "[&_.katex-display]:text-center",
    );
    expect(container.querySelector('[data-slot="markdown-output"]')).not.toHaveClass(
      "[&_.katex-display]:border-y",
      "[&_.katex-display]:bg-muted/[0.16]",
    );
  });

  it("renders fenced code with a visible language and copy rail", () => {
    render(<MarkdownOutput content={"```python\nprint('hi')\n```"} />);

    expect(screen.getByText("code")).toHaveAttribute("title", "python code block");
    expect(screen.getByText("code")).toHaveClass("text-muted-foreground/80");
    expect(screen.queryByText("python")).toBeNull();
    expect(screen.getByTitle("Copy code")).toHaveClass("inline-flex", "bg-background/80");
    expect(screen.getByText("print")).toBeInTheDocument();
  });

  it("frames GFM task lists as compact protocol blocks", () => {
    render(<MarkdownOutput content={"- [x] Reproduce baseline\n- [ ] Compare candidate"} />);

    expect(document.querySelector("ul.contains-task-list")).toHaveClass(
      "rounded-md",
      "border",
      "p-2",
    );
    expect(screen.getByText("Compare candidate").closest("li")).toHaveClass(
      "grid",
      "grid-cols-[auto_minmax(0,1fr)]",
      "task-list-item",
    );
    expect(document.querySelector('[data-slot="markdown-task-checkbox"] span')).toHaveClass(
      "size-4",
    );
  });

  it("styles GFM footnotes as a compact document apparatus", () => {
    render(<MarkdownOutput content={"Claim with a note.[^1]\n\n[^1]: Detailed citation."} />);

    const footnotes = document.querySelector("section[data-footnotes]");
    expect(footnotes).toHaveClass("border-t", "font-[var(--output-ui-font)]", "text-sm");
    expect(screen.getByRole("link", { name: "1" })).toHaveClass(
      "rounded-full",
      "bg-primary/6",
      "no-underline",
    );
    expect(screen.getByText("↩")).toHaveClass("text-xs", "no-underline");
  });

  it("styles raw figure captions with the shared document treatment", () => {
    render(
      <MarkdownOutput
        content={
          '<figure><img src="https://example.com/plot.png" alt="Plot"><figcaption>Figure 1. Residual topology.</figcaption></figure>'
        }
      />,
    );

    expect(screen.getByRole("figure")).toHaveClass("my-5");
    expect(screen.getByRole("img", { name: "Plot" })).toHaveClass("border", "shadow-sm");
    expect(screen.getByText("Figure 1. Residual topology.")).toHaveClass(
      "font-[var(--output-ui-font)]",
      "text-xs",
    );
  });

  it("styles native disclosure blocks as compact appendices", () => {
    render(
      <MarkdownOutput
        content={
          "<details open><summary>Failure appendix</summary><p>Keep failed priors near the claim.</p></details>"
        }
      />,
    );

    expect(screen.getByText("Failure appendix").closest("details")).toHaveClass(
      "group/details",
      "rounded-md",
      "shadow-sm",
      "[&>:not(summary)]:mx-4",
    );
    expect(screen.getByText("Failure appendix").closest("summary")).toHaveClass(
      "cursor-pointer",
      "font-[var(--output-ui-font)]",
      "group-open/details:border-border/65",
    );
    expect(screen.getByText("›")).toHaveClass("group-open/details:rotate-90");
    expect(screen.getByText("Keep failed priors near the claim.")).toHaveClass("my-3");
  });
});
