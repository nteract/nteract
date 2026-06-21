import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { NotebookCommentsPanel } from "../NotebookCommentsPanel";
import type { CommentsProjection } from "../comment-types";

const DOCUMENT_COMMENT_LABEL = "Add a comment on the document";

const projection: CommentsProjection = {
  comments_doc_id: "comments:local-room:notebook-1",
  threads: [
    {
      id: "thread-1",
      anchor: { kind: "notebook" },
      position: "80",
      status: "open",
      messages: [
        {
          id: "message-1",
          position: "80",
          body: "Check the framing before publishing.",
          created_at: "2026-06-16T00:00:00.000Z",
          created_by_actor_label: "alice",
        },
      ],
      badge_cell_ids: [],
      created_at: "2026-06-16T00:00:00.000Z",
    },
    {
      id: "thread-cell",
      anchor: { kind: "cell", cell_id: "cell-1" },
      position: "80",
      status: "open",
      messages: [
        {
          id: "message-cell",
          position: "80",
          body: "Cell-scoped comment",
          created_at: "2026-06-16T00:00:00.000Z",
        },
      ],
      badge_cell_ids: ["cell-1"],
      created_at: "2026-06-16T00:00:00.000Z",
    },
  ],
};

describe("NotebookCommentsPanel", () => {
  // jsdom has no matchMedia; the dark-mode/color-theme hooks read it when a
  // source-range quote highlights. Stub it for the lifetime of the suite.
  const originalMatchMedia = Object.getOwnPropertyDescriptor(window, "matchMedia");

  beforeEach(() => {
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
    if (originalMatchMedia) {
      Object.defineProperty(window, "matchMedia", originalMatchMedia);
    } else {
      delete (window as Partial<Window>).matchMedia;
    }
  });

  it("renders the unavailable state with disabled composer", () => {
    render(
      <NotebookCommentsPanel
        projection={null}
        readOnly
        statusMessage="Comments sync unavailable."
        errorMessage="Comment request failed."
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("Comments sync unavailable.");
    expect(screen.getByRole("alert")).toHaveTextContent("Comment request failed.");
    expect(screen.queryByText("No comments yet.")).not.toBeInTheDocument();
    expect(screen.getByLabelText(DOCUMENT_COMMENT_LABEL)).toBeDisabled();
  });

  it("submits a new document comment", async () => {
    const onCreateThread = vi.fn();
    render(
      <NotebookCommentsPanel
        projection={{ ...projection, threads: [] }}
        onCreateThread={onCreateThread}
      />,
    );

    const composer = screen.getByLabelText(DOCUMENT_COMMENT_LABEL);
    const submit = screen.getByRole("button", { name: "Add comment" });
    expect(composer).toHaveAttribute("placeholder", "Add to the discussion");
    expect(submit).toHaveAttribute("aria-label", "Add comment");
    expect(submit).toBeDisabled();

    fireEvent.change(composer, {
      target: { value: "Add this to the review notes" },
    });
    fireEvent.click(submit);

    await waitFor(() =>
      expect(onCreateThread).toHaveBeenCalledWith("Add this to the review notes"),
    );
    expect(screen.getByLabelText(DOCUMENT_COMMENT_LABEL)).toHaveValue("");
  });

  it("focuses the document composer when opened", async () => {
    render(
      <NotebookCommentsPanel
        projection={{ ...projection, threads: [] }}
        onCreateThread={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByLabelText(DOCUMENT_COMMENT_LABEL)).toHaveFocus());
  });

  it("submits a new document comment with Cmd Enter", async () => {
    const onCreateThread = vi.fn();
    render(
      <NotebookCommentsPanel
        projection={{ ...projection, threads: [] }}
        onCreateThread={onCreateThread}
      />,
    );

    const composer = screen.getByLabelText(DOCUMENT_COMMENT_LABEL);
    fireEvent.change(composer, {
      target: { value: "Submit from the keyboard" },
    });
    fireEvent.keyDown(composer, { key: "Enter", metaKey: true });

    await waitFor(() => expect(onCreateThread).toHaveBeenCalledWith("Submit from the keyboard"));
  });

  it("submits a selected source draft comment", async () => {
    const onCreateThread = vi.fn();
    const onClearDraftTarget = vi.fn();
    render(
      <NotebookCommentsPanel
        projection={{ ...projection, threads: [] }}
        draftTarget={{
          anchor: {
            kind: "source_range",
            cell_id: "cell-1",
            start_line: 1,
            start_column: 0,
            end_line: 1,
            end_column: 4,
            exact_quote: "beta",
          },
          quote: "beta",
        }}
        onClearDraftTarget={onClearDraftTarget}
        onCreateThread={onCreateThread}
      />,
    );

    expect(screen.getByTestId("comment-draft-target")).toHaveTextContent("Source selection");
    expect(screen.getByTestId("comment-draft-target")).toHaveTextContent("beta");
    expect(screen.getByTestId("notebook-comments-composer-dock")).toContainElement(
      screen.getByTestId("comment-draft-target"),
    );
    expect(screen.getByTestId("notebook-comments-thread-scroll")).not.toContainElement(
      screen.getByTestId("comment-draft-target"),
    );
    await waitFor(() => expect(screen.getByLabelText("New source comment")).toHaveFocus());

    fireEvent.change(screen.getByLabelText("New source comment"), {
      target: { value: "This line needs a note" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add comment" }));

    await waitFor(() => expect(onCreateThread).toHaveBeenCalledWith("This line needs a note"));

    fireEvent.click(screen.getByRole("button", { name: "Use document target" }));
    expect(onClearDraftTarget).toHaveBeenCalled();
  });

  it("preserves leading whitespace in selected source previews", () => {
    render(
      <NotebookCommentsPanel
        projection={{ ...projection, threads: [] }}
        draftTarget={{
          anchor: {
            kind: "source_range",
            cell_id: "cell-1",
            start_line: 1,
            start_column: 0,
            end_line: 1,
            end_column: 8,
            exact_quote: "    beta",
          },
          quote: "    beta",
        }}
        onCreateThread={vi.fn()}
      />,
    );

    const quote = screen.getByTestId("comment-draft-target").querySelector("blockquote");
    expect(quote?.textContent).toBe("    beta");
  });

  it("preserves draft text when changing a source draft back to document", async () => {
    const onCreateThread = vi.fn();
    const onClearDraftTarget = vi.fn();
    const draftTarget = {
      anchor: {
        kind: "source_range" as const,
        cell_id: "cell-1",
        start_line: 1,
        start_column: 0,
        end_line: 1,
        end_column: 4,
        exact_quote: "beta",
      },
      quote: "beta",
    };
    const renderPanel = (target: typeof draftTarget | null) => (
      <NotebookCommentsPanel
        projection={{ ...projection, threads: [] }}
        draftTarget={target}
        onClearDraftTarget={onClearDraftTarget}
        onCreateThread={onCreateThread}
      />
    );
    const { rerender } = render(renderPanel(draftTarget));

    fireEvent.change(screen.getByLabelText("New source comment"), {
      target: { value: "Keep this body while retargeting" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Use document target" }));
    expect(onClearDraftTarget).toHaveBeenCalled();

    rerender(renderPanel(null));
    expect(screen.getByLabelText(DOCUMENT_COMMENT_LABEL)).toHaveValue(
      "Keep this body while retargeting",
    );

    fireEvent.click(screen.getByRole("button", { name: "Add comment" }));
    await waitFor(() =>
      expect(onCreateThread).toHaveBeenCalledWith("Keep this body while retargeting"),
    );
  });

  it("clears submitted text while a comment request is in flight", async () => {
    let resolveCreate: (() => void) | null = null;
    const onCreateThread = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveCreate = resolve;
        }),
    );
    render(
      <NotebookCommentsPanel
        projection={{ ...projection, threads: [] }}
        onCreateThread={onCreateThread}
      />,
    );

    fireEvent.change(screen.getByLabelText(DOCUMENT_COMMENT_LABEL), {
      target: { value: "Do not leave duplicate text in the composer" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add comment" }));

    await waitFor(() =>
      expect(onCreateThread).toHaveBeenCalledWith("Do not leave duplicate text in the composer"),
    );
    expect(screen.getByLabelText(DOCUMENT_COMMENT_LABEL)).toHaveValue("");
    expect(screen.getByRole("button", { name: "Add comment" })).toBeDisabled();

    resolveCreate?.();
    await waitFor(() => expect(screen.getByLabelText(DOCUMENT_COMMENT_LABEL)).toBeEnabled());
  });

  it("restores submitted text when a comment request fails", async () => {
    const onCreateThread = vi.fn(() => Promise.reject(new Error("sync failed")));
    render(
      <NotebookCommentsPanel
        projection={{ ...projection, threads: [] }}
        onCreateThread={onCreateThread}
      />,
    );

    fireEvent.change(screen.getByLabelText(DOCUMENT_COMMENT_LABEL), {
      target: { value: "Keep this draft if submit fails" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add comment" }));

    await waitFor(() =>
      expect(onCreateThread).toHaveBeenCalledWith("Keep this draft if submit fails"),
    );
    await waitFor(() =>
      expect(screen.getByLabelText(DOCUMENT_COMMENT_LABEL)).toHaveValue(
        "Keep this draft if submit fails",
      ),
    );
  });

  it("docks the document composer below the scrollable thread list", () => {
    render(<NotebookCommentsPanel projection={projection} onCreateThread={vi.fn()} />);

    const scroll = screen.getByTestId("notebook-comments-thread-scroll");
    const dock = screen.getByTestId("notebook-comments-composer-dock");
    const composer = screen.getByLabelText(DOCUMENT_COMMENT_LABEL);

    expect(scroll).toContainElement(screen.getByText("Check the framing before publishing."));
    expect(dock).toContainElement(composer);
    expect(scroll).not.toContainElement(composer);
    expect(composer).toHaveAttribute("placeholder", "Add to the discussion");
  });

  it("renders threads and submits replies", async () => {
    const onReplyThread = vi.fn();
    const onResolveThread = vi.fn();
    render(
      <NotebookCommentsPanel
        projection={projection}
        onReplyThread={onReplyThread}
        onResolveThread={onResolveThread}
      />,
    );

    expect(screen.getByText("Check the framing before publishing.")).toBeVisible();
    expect(screen.getByText("alice")).toBeVisible();
    expect(screen.getByText("Cell-scoped comment")).toBeVisible();
    expect(screen.queryByLabelText("Reply to Document comment 1")).not.toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: "Reply" })[0]);
    await waitFor(() => expect(screen.getByLabelText("Reply to Document comment 1")).toHaveFocus());
    fireEvent.change(screen.getByLabelText("Reply to Document comment 1"), {
      target: { value: "Looks ready locally" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit reply to Document comment 1" }));

    await waitFor(() =>
      expect(onReplyThread).toHaveBeenCalledWith("thread-1", "Looks ready locally"),
    );

    fireEvent.click(screen.getByRole("button", { name: "Resolve Document comment 1" }));
    expect(onResolveThread).toHaveBeenCalledWith("thread-1");
  });

  it("does not open the reply composer for a focused thread", () => {
    render(
      <NotebookCommentsPanel
        projection={projection}
        focusedThreadId="thread-1"
        focusNonce={1}
        onReplyThread={vi.fn()}
      />,
    );

    expect(screen.queryByLabelText("Reply to Document comment 1")).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Reply" })[0]).toBeVisible();
  });

  it("submits replies with Ctrl Enter", async () => {
    const onReplyThread = vi.fn();
    render(<NotebookCommentsPanel projection={projection} onReplyThread={onReplyThread} />);

    fireEvent.click(screen.getAllByRole("button", { name: "Reply" })[0]);
    await waitFor(() => expect(screen.getByLabelText("Reply to Document comment 1")).toHaveFocus());
    const reply = screen.getByLabelText("Reply to Document comment 1");
    fireEvent.change(reply, {
      target: { value: "Reply from the keyboard" },
    });
    fireEvent.keyDown(reply, { key: "Enter", ctrlKey: true });

    await waitFor(() =>
      expect(onReplyThread).toHaveBeenCalledWith("thread-1", "Reply from the keyboard"),
    );
  });

  it("collapses a reply composer and discards its draft on Escape", async () => {
    const onReplyThread = vi.fn();
    render(<NotebookCommentsPanel projection={projection} onReplyThread={onReplyThread} />);

    fireEvent.click(screen.getAllByRole("button", { name: "Reply" })[0]);
    await waitFor(() => expect(screen.getByLabelText("Reply to Document comment 1")).toHaveFocus());
    const reply = screen.getByLabelText("Reply to Document comment 1");
    fireEvent.change(reply, {
      target: { value: "Do not keep this draft" },
    });

    fireEvent.keyDown(reply, { key: "Escape" });

    await waitFor(() =>
      expect(screen.queryByLabelText("Reply to Document comment 1")).not.toBeInTheDocument(),
    );
    expect(onReplyThread).not.toHaveBeenCalled();

    fireEvent.click(screen.getAllByRole("button", { name: "Reply" })[0]);
    await waitFor(() => expect(screen.getByLabelText("Reply to Document comment 1")).toHaveFocus());
    expect(screen.getByLabelText("Reply to Document comment 1")).toHaveValue("");
  });

  it("renders source excerpts on source range threads", () => {
    const onFocusThreadAnchor = vi.fn();
    const sourceThread = {
      ...projection.threads[0],
      id: "thread-source",
      anchor: {
        kind: "source_range" as const,
        cell_id: "cell-1",
        start_line: 2,
        start_column: 0,
        end_line: 2,
        end_column: 14,
        exact_quote: "important_call()",
      },
    };
    render(
      <NotebookCommentsPanel
        projection={{
          ...projection,
          threads: [sourceThread],
        }}
        onFocusThreadAnchor={onFocusThreadAnchor}
      />,
    );

    expect(screen.getByTestId("comment-thread-source-quote")).toHaveTextContent("important_call()");
    fireEvent.click(screen.getByRole("button", { name: "Show cell for Source comment 1" }));
    expect(onFocusThreadAnchor).toHaveBeenCalledWith(sourceThread);
  });

  it("formats local actor labels without exposing the raw durable id", () => {
    render(
      <NotebookCommentsPanel
        projection={{
          ...projection,
          threads: [
            {
              ...projection.threads[0],
              messages: [
                {
                  ...projection.threads[0].messages[0],
                  created_by_actor_label: "local:ubuntu/desktop:d47eea7d",
                },
              ],
            },
          ],
        }}
      />,
    );

    expect(screen.getByText("ubuntu desktop")).toBeVisible();
    expect(screen.queryByText("local:ubuntu/desktop:d47eea7d")).not.toBeInTheDocument();
  });

  it("renders resolved author attribution with the on-behalf-of principal", () => {
    const resolveCommentAuthor = vi.fn((actorLabel: string) => ({
      displayName: actorLabel.includes("agent") ? "Claude Code" : actorLabel,
      isAgent: true,
      onBehalfOf: "kylekelley",
      color: "#3b82f6",
    }));
    render(
      <NotebookCommentsPanel
        projection={{
          ...projection,
          threads: [
            {
              ...projection.threads[0],
              messages: [
                {
                  ...projection.threads[0].messages[0],
                  created_by_actor_label: "local:kylekelley/agent:nteract-mcp:6483cc03",
                },
              ],
            },
          ],
        }}
        resolveCommentAuthor={resolveCommentAuthor}
      />,
    );

    expect(screen.getByText("Claude Code")).toBeVisible();
    expect(screen.queryByText("AI")).not.toBeInTheDocument();
    expect(screen.getByText("· for kylekelley")).toBeVisible();
  });

  it("falls back to the parsed actor label when no author resolver is given", () => {
    render(
      <NotebookCommentsPanel
        projection={{
          ...projection,
          threads: [
            {
              ...projection.threads[0],
              messages: [
                {
                  ...projection.threads[0].messages[0],
                  created_by_actor_label: "local:kylekelley/agent:nteract-mcp:6483cc03",
                },
              ],
            },
          ],
        }}
      />,
    );

    expect(screen.getByText("kylekelley nteract-mcp")).toBeVisible();
  });

  it("reveals resolved threads behind a toggle and reopens them", () => {
    const onReopenThread = vi.fn();
    const resolveCommentAuthor = vi.fn((actorLabel: string) => ({
      displayName: actorLabel === "reviewer" ? "Reviewer" : actorLabel,
    }));
    render(
      <NotebookCommentsPanel
        projection={{
          ...projection,
          threads: [
            {
              ...projection.threads[0],
              status: "resolved",
              resolved_at: "2026-06-16T00:05:00.000Z",
              resolved_by_actor_label: "reviewer",
            },
          ],
        }}
        resolveCommentAuthor={resolveCommentAuthor}
        onReopenThread={onReopenThread}
      />,
    );

    // Resolved threads are hidden until revealed.
    expect(screen.queryByRole("button", { name: "Reopen Document comment 1" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show resolved (1)" }));
    expect(screen.getByTestId("comment-resolution-receipt")).toHaveAttribute(
      "aria-label",
      expect.stringContaining("Reviewer marked as resolved"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Reopen Document comment 1" }));
    expect(onReopenThread).toHaveBeenCalledWith("thread-1");
  });

  it("uses the resolver identity in the compact resolution receipt", () => {
    render(
      <NotebookCommentsPanel
        projection={{
          ...projection,
          threads: [
            {
              ...projection.threads[0],
              status: "resolved",
              resolved_at: "2026-06-16T00:05:00.000Z",
              resolved_by_actor_label: "reviewer",
            },
          ],
        }}
        resolveCommentAuthor={(actorLabel) => ({
          displayName: actorLabel === "reviewer" ? "Reviewer" : actorLabel,
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Show resolved (1)" }));
    expect(screen.getByTestId("comment-resolution-receipt")).toHaveAttribute(
      "aria-label",
      expect.stringContaining("Reviewer marked as resolved"),
    );
  });

  it("includes the on-behalf-of principal in the compact resolver identity", () => {
    render(
      <NotebookCommentsPanel
        projection={{
          ...projection,
          threads: [
            {
              ...projection.threads[0],
              status: "resolved",
              resolved_at: "2026-06-16T00:05:00.000Z",
              resolved_by_actor_label: "agent",
            },
          ],
        }}
        resolveCommentAuthor={() => ({
          displayName: "Claude Code",
          isAgent: true,
          onBehalfOf: "Ada",
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Show resolved (1)" }));
    expect(screen.getByTestId("comment-resolution-receipt")).toHaveAttribute(
      "aria-label",
      expect.stringContaining("Claude Code for Ada marked as resolved"),
    );
  });

  it("flashes the focused thread", () => {
    const { container } = render(
      <NotebookCommentsPanel projection={projection} focusedThreadId="thread-1" focusNonce={1} />,
    );
    // The focused thread gets a soft background flash.
    expect(container.querySelector("li")?.className).toContain("bg-primary/5");
  });
});
