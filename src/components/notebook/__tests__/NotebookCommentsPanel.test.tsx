import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";
import { NotebookCommentsPanel } from "../NotebookCommentsPanel";
import type { CommentsProjection } from "runtimed";

const projection: CommentsProjection = {
  comments_doc_id: "comments:local-room:notebook-1",
  threads: [
    {
      id: "thread-1",
      anchor: { kind: "notebook" },
      position: "80",
      status: "open",
      mutation_state: "accepted",
      trusted: true,
      messages: [
        {
          id: "message-1",
          position: "80",
          body: "Check the framing before publishing.",
          mutation_state: "accepted",
          trusted: true,
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
      mutation_state: "accepted",
      trusted: true,
      messages: [
        {
          id: "message-cell",
          position: "80",
          body: "Cell-scoped comment",
          mutation_state: "accepted",
          trusted: true,
          created_at: "2026-06-16T00:00:00.000Z",
        },
      ],
      badge_cell_ids: ["cell-1"],
      created_at: "2026-06-16T00:00:00.000Z",
    },
  ],
};

describe("NotebookCommentsPanel", () => {
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
    expect(screen.getByLabelText("New document comment")).toBeDisabled();
  });

  it("submits a new document comment", async () => {
    const onCreateThread = vi.fn();
    render(
      <NotebookCommentsPanel
        projection={{ ...projection, threads: [] }}
        onCreateThread={onCreateThread}
      />,
    );

    fireEvent.change(screen.getByLabelText("New document comment"), {
      target: { value: "Add this to the review notes" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add comment" }));

    await waitFor(() =>
      expect(onCreateThread).toHaveBeenCalledWith("Add this to the review notes"),
    );
    expect(screen.getByLabelText("New document comment")).toHaveValue("");
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
    expect(screen.getByLabelText("New document comment")).toHaveValue(
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

    fireEvent.change(screen.getByLabelText("New document comment"), {
      target: { value: "Do not leave duplicate text in the composer" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add comment" }));

    await waitFor(() =>
      expect(onCreateThread).toHaveBeenCalledWith("Do not leave duplicate text in the composer"),
    );
    expect(screen.getByLabelText("New document comment")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Add comment" })).toBeDisabled();

    resolveCreate?.();
    await waitFor(() => expect(screen.getByLabelText("New document comment")).toBeEnabled());
  });

  it("restores submitted text when a comment request fails", async () => {
    const onCreateThread = vi.fn(() => Promise.reject(new Error("sync failed")));
    render(
      <NotebookCommentsPanel
        projection={{ ...projection, threads: [] }}
        onCreateThread={onCreateThread}
      />,
    );

    fireEvent.change(screen.getByLabelText("New document comment"), {
      target: { value: "Keep this draft if submit fails" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add comment" }));

    await waitFor(() =>
      expect(onCreateThread).toHaveBeenCalledWith("Keep this draft if submit fails"),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("New document comment")).toHaveValue(
        "Keep this draft if submit fails",
      ),
    );
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
    expect(screen.getByText("Cell comment 2")).toBeVisible();
    expect(screen.getByText("Cell-scoped comment")).toBeVisible();
    expect(screen.getAllByLabelText("1 message")).toHaveLength(2);

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

  it("renders source excerpts on source range threads", () => {
    render(
      <NotebookCommentsPanel
        projection={{
          ...projection,
          threads: [
            {
              ...projection.threads[0],
              id: "thread-source",
              anchor: {
                kind: "source_range",
                cell_id: "cell-1",
                start_line: 2,
                start_column: 0,
                end_line: 2,
                end_column: 14,
                exact_quote: "important_call()",
              },
            },
          ],
        }}
      />,
    );

    expect(screen.getByText("Source comment 1")).toBeVisible();
    expect(screen.getByTestId("comment-thread-source-quote")).toHaveTextContent("important_call()");
  });

  it("does not allow status actions while a reply is pending", () => {
    const onResolveThread = vi.fn();
    render(
      <NotebookCommentsPanel
        projection={{
          ...projection,
          threads: [
            {
              ...projection.threads[0],
              messages: [
                ...projection.threads[0].messages,
                {
                  id: "message-pending",
                  position: "81",
                  body: "Still syncing",
                  mutation_state: "pending",
                  trusted: false,
                  created_at: "2026-06-16T00:01:00.000Z",
                },
              ],
            },
          ],
        }}
        onResolveThread={onResolveThread}
      />,
    );

    const resolve = screen.getByRole("button", { name: "Resolve Document comment 1" });
    expect(resolve).toBeDisabled();
    fireEvent.click(resolve);
    expect(onResolveThread).not.toHaveBeenCalled();
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

  it("reopens resolved threads", () => {
    const onReopenThread = vi.fn();
    render(
      <NotebookCommentsPanel
        projection={{
          ...projection,
          threads: [{ ...projection.threads[0], status: "resolved" }],
        }}
        onReopenThread={onReopenThread}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Reopen Document comment 1" }));
    expect(onReopenThread).toHaveBeenCalledWith("thread-1");
  });

  it("does not allow status actions for pending threads", () => {
    const onResolveThread = vi.fn();
    render(
      <NotebookCommentsPanel
        projection={{
          ...projection,
          threads: [{ ...projection.threads[0], mutation_state: "pending" }],
        }}
        onResolveThread={onResolveThread}
      />,
    );

    const resolve = screen.getByRole("button", { name: "Resolve Document comment 1" });
    expect(resolve).toBeDisabled();
    fireEvent.click(resolve);
    expect(onResolveThread).not.toHaveBeenCalled();
  });
});
