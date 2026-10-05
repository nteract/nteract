import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vite-plus/test";
import { commentHighlightExtension, setCommentHighlightsEffect } from "../comment-highlight-extension";

describe("comment highlights", () => {
  it("exposes thread identity for the shared inline preview without a competing tooltip", () => {
    const view = new EditorView({ state: EditorState.create({ doc: "value = 42", extensions: [commentHighlightExtension({ onActivate: vi.fn() })] }) });
    view.dispatch({ effects: setCommentHighlightsEffect.of([{ from: 0, to: 5, threadId: "thread", resolved: false }]) });
    expect(view.dom.querySelector("[data-comment-thread-id='thread']")?.textContent).toBe("value");
    expect(view.dom.querySelector(".cm-tooltip")).toBeNull();
    view.destroy();
  });
});
