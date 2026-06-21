import { describe, expect, it } from "vitest";
import {
  buildRenderedCommentHighlights,
  PENDING_RENDERED_COMMENT_HIGHLIGHT_COLOR,
} from "../../lib/rendered-comment-highlights";
import {
  sourceRangeAnchorFromOffsets,
  type SourceRangeCommentAnchor,
} from "../../lib/comment-source-anchor";

function makeAnchor(
  cellId: string,
  source: string,
  from: number,
  to: number,
): SourceRangeCommentAnchor {
  const anchor = sourceRangeAnchorFromOffsets(cellId, source, from, to);
  if (!anchor) {
    throw new Error("test fixture failed to create source-range anchor");
  }
  return anchor;
}

describe("buildRenderedCommentHighlights", () => {
  it("adds a pending highlight for the matching cell anchor", () => {
    const source = "Alpha **beta** gamma";
    const from = source.indexOf("beta");
    const to = from + "beta".length;
    const pendingCommentAnchor = makeAnchor("cell-1", source, from, to);

    expect(
      buildRenderedCommentHighlights({
        cellId: "cell-1",
        source,
        editing: false,
        projectionMatchesPreview: true,
        pendingCommentAnchor,
      }),
    ).toEqual([
      {
        from,
        to,
        resolved: false,
        pending: true,
        color: PENDING_RENDERED_COMMENT_HIGHLIGHT_COLOR,
      },
    ]);
  });

  it("does not add a pending highlight for a different cell anchor", () => {
    const source = "Alpha **beta** gamma";
    const from = source.indexOf("beta");
    const pendingCommentAnchor = makeAnchor("cell-2", source, from, from + "beta".length);

    expect(
      buildRenderedCommentHighlights({
        cellId: "cell-1",
        source,
        editing: false,
        projectionMatchesPreview: true,
        pendingCommentAnchor,
      }),
    ).toBeUndefined();
  });
});
