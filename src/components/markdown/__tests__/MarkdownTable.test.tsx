import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";
import {
  MarkdownTableBody,
  MarkdownTableCell,
  MarkdownTableElement,
  MarkdownTableFrame,
  MarkdownTableHead,
  MarkdownTableHeaderCell,
  MarkdownTableHeaderRow,
  MarkdownTableRow,
} from "../MarkdownTable";

describe("MarkdownTable", () => {
  it("renders the shared document table frame and cells", () => {
    render(
      <MarkdownTableFrame data-slot="test-table">
        <MarkdownTableElement>
          <MarkdownTableHead>
            <MarkdownTableHeaderRow>
              <MarkdownTableHeaderCell>metric</MarkdownTableHeaderCell>
              <MarkdownTableHeaderCell style={{ textAlign: "right" }}>
                candidate
              </MarkdownTableHeaderCell>
            </MarkdownTableHeaderRow>
          </MarkdownTableHead>
          <MarkdownTableBody>
            <MarkdownTableRow>
              <MarkdownTableCell>topic stability</MarkdownTableCell>
              <MarkdownTableCell style={{ textAlign: "right" }}>0.84</MarkdownTableCell>
            </MarkdownTableRow>
          </MarkdownTableBody>
        </MarkdownTableElement>
      </MarkdownTableFrame>,
    );

    expect(screen.getByRole("table").parentElement).toHaveClass(
      "rounded-sm",
      "border",
      "shadow-sm",
    );
    expect(screen.getByRole("table")).toHaveClass("font-[var(--output-ui-font)]", "text-sm");
    expect(screen.getByRole("columnheader", { name: "metric" })).toHaveClass(
      "border-border/80",
      "font-semibold",
    );
    expect(screen.getByRole("columnheader", { name: "candidate" })).toHaveStyle({
      textAlign: "right",
    });
    expect(screen.getByRole("row", { name: "topic stability 0.84" })).toHaveClass(
      "odd:bg-muted/[0.05]",
    );
    expect(screen.getByRole("cell", { name: "0.84" })).toHaveClass("text-muted-foreground");
  });
});
