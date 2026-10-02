import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { NotebookCommentPreview } from "@/components/notebook/NotebookCommentPreview";
import type { CommentsProjection } from "@/components/notebook/comment-types";

const projection: CommentsProjection = {
  comments_doc_id: "comments:test",
  threads: [
    {
      id: "thread",
      status: "open",
      position: "0",
      anchor: { kind: "notebook" },
      badge_cell_ids: [],
      created_at: "2026-10-02T12:00:00Z",
      messages: [
        {
          id: "message",
          position: "0",
          body: "Read this beside the text.",
          created_at: "2026-10-02T12:00:00Z",
          created_by_actor_label: "Ada",
        },
      ],
    },
  ],
};
function fixture(props: Partial<React.ComponentProps<typeof NotebookCommentPreview>> = {}) {
  const openPanel = vi.fn();
  const reply = vi.fn();
  const view = render(
    <NotebookCommentPreview projection={projection} onReplyThread={reply} {...props}>
      <button type="button" data-comment-thread-id="thread" onClick={openPanel}>
        Highlighted text
      </button>
    </NotebookCommentPreview>,
  );
  return { ...view, openPanel, reply, trigger: screen.getByText("Highlighted text") };
}

describe("NotebookCommentPreview", () => {
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 100,
      y: 100,
      top: 100,
      left: 100,
      right: 200,
      bottom: 120,
      width: 100,
      height: 20,
      toJSON: () => ({}),
    });
    vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(1200);
    vi.spyOn(document.documentElement, "clientHeight", "get").mockReturnValue(800);
  });
  afterEach(() => vi.restoreAllMocks());
  it("opens inline on click without opening Discussions, and sends replies", async () => {
    const user = userEvent.setup();
    const { trigger, openPanel, reply } = fixture();
    await user.click(trigger);
    expect(screen.getByRole("dialog", { name: "Comment thread" })).toBeTruthy();
    expect(openPanel).not.toHaveBeenCalled();
    await user.type(screen.getByRole("textbox", { name: "Reply to comment" }), "Looks good");
    await user.click(screen.getByRole("button", { name: "Send reply" }));
    expect(reply).toHaveBeenCalledWith("thread", "Looks good");
  });

  it("previews on hover and stays open while moving into the card", async () => {
    const { trigger } = fixture();
    fireEvent.pointerOver(trigger);
    const card = await screen.findByRole("dialog", { name: "Comment thread" });
    fireEvent.pointerOut(trigger);
    fireEvent.pointerEnter(card);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(screen.getByText("Read this beside the text.")).toBeTruthy();
    fireEvent.pointerLeave(card);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("preserves a draft when dismissed and reopened", async () => {
    const user = userEvent.setup();
    const { trigger } = fixture();
    await user.click(trigger);
    await user.type(screen.getByRole("textbox"), "Unsent thought");
    await user.click(screen.getByRole("button", { name: "Close comment preview" }));
    await user.click(trigger);
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("Unsent thought");
  });

  it("retains failed replies and displays the error", async () => {
    const user = userEvent.setup();
    const { trigger } = fixture({
      onReplyThread: vi.fn().mockRejectedValue(new Error("Disconnected")),
    });
    await user.click(trigger);
    await user.type(screen.getByRole("textbox"), "Try again");
    await user.click(screen.getByRole("button", { name: "Send reply" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Disconnected");
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("Try again");
  });

  it("supports keyboard activation and read-only threads", async () => {
    const { trigger, openPanel } = fixture({ readOnly: true });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(openPanel).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });
});
