import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";
import { resolveCommentsUiSurface } from "@/components/notebook/comments-ui-gate";
import { NotebookPackagesPanel, NotebookRail } from "@/components/notebook-rail";

describe("resolveCommentsUiSurface", () => {
  it("passes the comments panel and callbacks for writers", () => {
    const onCreateSourceComment = vi.fn();
    const onCreateOutputComment = vi.fn();
    const onActivateCommentThread = vi.fn();
    const surface = resolveCommentsUiSurface({
      canCreateComments: true,
      commentsPanel: "comments panel",
      onCreateSourceComment,
      onCreateOutputComment,
      onActivateCommentThread,
    });

    expect(surface.commentsPanel).toBe("comments panel");
    expect(surface.onCreateSourceComment).toBe(onCreateSourceComment);
    expect(surface.onCreateOutputComment).toBe(onCreateOutputComment);
    expect(surface.onActivateCommentThread).toBe(onActivateCommentThread);
  });

  it("always exposes Discussions in the rail", () => {
    const surface = resolveCommentsUiSurface({
      canCreateComments: false,
      commentsPanel: "comments panel",
      onCreateSourceComment: vi.fn(),
      onCreateOutputComment: vi.fn(),
      onActivateCommentThread: vi.fn(),
    });
    render(
      <NotebookRail
        activePanelId="comments"
        collapsed={false}
        outlineItems={[]}
        packagesPanel={<NotebookPackagesPanel>Packages</NotebookPackagesPanel>}
        commentsPanel={surface.commentsPanel}
        onActivePanelChange={vi.fn()}
        onCollapsedChange={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Discussions" })).toBeInTheDocument();
    expect(screen.getByText("comments panel")).toBeInTheDocument();
  });

  it("keeps the panel and activation callback for read-only comments without create affordances", () => {
    const onActivateCommentThread = vi.fn();
    const surface = resolveCommentsUiSurface({
      canCreateComments: false,
      commentsPanel: "comments panel",
      onCreateSourceComment: vi.fn(),
      onCreateOutputComment: vi.fn(),
      onActivateCommentThread,
    });

    expect(surface.commentsPanel).toBe("comments panel");
    expect(surface.onCreateSourceComment).toBeUndefined();
    expect(surface.onCreateOutputComment).toBeUndefined();
    expect(surface.onActivateCommentThread).toBe(onActivateCommentThread);
  });
});
