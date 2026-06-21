import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";
import { resolveCommentsUiSurface } from "@/components/notebook/comments-ui-gate";
import { NotebookPackagesPanel, NotebookRail } from "@/components/notebook-rail";

describe("resolveCommentsUiSurface", () => {
  it("passes the comments panel and callbacks when comments UI is enabled", () => {
    const onCreateSourceComment = vi.fn();
    const onCreateOutputComment = vi.fn();
    const onActivateCommentThread = vi.fn();
    const surface = resolveCommentsUiSurface({
      commentsUiEnabled: true,
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

  it("suppresses the comments panel and every NotebookView callback when comments UI is disabled", () => {
    const surface = resolveCommentsUiSurface({
      commentsUiEnabled: false,
      canCreateComments: true,
      commentsPanel: "comments panel",
      onCreateSourceComment: vi.fn(),
      onCreateOutputComment: vi.fn(),
      onActivateCommentThread: vi.fn(),
    });

    expect(surface.commentsPanel).toBeUndefined();
    expect(surface.onCreateSourceComment).toBeUndefined();
    expect(surface.onCreateOutputComment).toBeUndefined();
    expect(surface.onActivateCommentThread).toBeUndefined();

    render(
      <NotebookRail
        activePanelId="outline"
        collapsed={false}
        outlineItems={[]}
        packagesPanel={<NotebookPackagesPanel>Packages</NotebookPackagesPanel>}
        commentsPanel={surface.commentsPanel}
        onActivePanelChange={vi.fn()}
        onCollapsedChange={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: "Discussions" })).not.toBeInTheDocument();
    expect(screen.queryByText("comments panel")).not.toBeInTheDocument();
  });

  it("keeps the panel and activation callback for read-only comments without create affordances", () => {
    const onActivateCommentThread = vi.fn();
    const surface = resolveCommentsUiSurface({
      commentsUiEnabled: true,
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
