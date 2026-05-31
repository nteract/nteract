// @vitest-environment jsdom
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createCrdtBridge, remoteChangesFromTextAttributions } from "../crdt-editor-bridge";

let views: EditorView[] = [];

afterEach(() => {
  for (const view of views) {
    view.destroy();
  }
  views = [];
});

describe("remoteChangesFromTextAttributions", () => {
  it("filters attributions to the requested cell", () => {
    const changes = remoteChangesFromTextAttributions(
      [
        {
          cell_id: "cell-a",
          index: 3,
          text: "hi",
          deleted: 0,
          actors: ["user:dev:bob/desktop:1"],
        },
        {
          cell_id: "cell-b",
          index: 0,
          text: "ignored",
          deleted: 0,
          actors: ["user:dev:bob/desktop:1"],
        },
      ],
      "cell-a",
      "user:dev:alice/desktop:1",
    );

    expect(changes).toEqual([{ index: 3, text: "hi", deleted: 0 }]);
  });

  it("drops self-echo attributions for the local actor", () => {
    const changes = remoteChangesFromTextAttributions(
      [
        {
          cell_id: "cell-a",
          index: 0,
          text: "local",
          deleted: 0,
          actors: ["user:dev:alice/desktop:1"],
        },
        {
          cell_id: "cell-a",
          index: 5,
          text: "remote",
          deleted: 0,
          actors: ["user:dev:bob/desktop:1"],
        },
      ],
      "cell-a",
      "user:dev:alice/desktop:1",
    );

    expect(changes).toEqual([{ index: 5, text: "remote", deleted: 0 }]);
  });

  it("keeps multi-actor attributions because they are not pure self echo", () => {
    const changes = remoteChangesFromTextAttributions(
      [
        {
          cell_id: "cell-a",
          index: 1,
          text: "merged",
          deleted: 2,
          actors: ["user:dev:alice/desktop:1", "user:dev:bob/desktop:1"],
        },
      ],
      "cell-a",
      "user:dev:alice/desktop:1",
    );

    expect(changes).toEqual([{ index: 1, text: "merged", deleted: 2 }]);
  });
});

describe("createCrdtBridge capability gating", () => {
  it("blocks outbound editor transactions when the host cannot write", () => {
    const calls: string[] = [];
    const bridge = createCrdtBridge({
      getHandle: () =>
        ({
          splice_source: (_cellId: string, _index: number, _deleteCount: number, text: string) => {
            calls.push(text);
            return true;
          },
          get_cell_source: () => "unchanged",
        }) as never,
      cellId: "cell-a",
      canWriteSource: () => false,
      onSourceChanged: (source) => calls.push(`store:${source}`),
      onSyncNeeded: () => calls.push("sync"),
    });
    const view = new EditorView({
      state: EditorState.create({
        doc: "hello",
        extensions: [bridge.extension],
      }),
    });
    views.push(view);

    view.dispatch({ changes: { from: 5, insert: "!" } });

    expect(view.state.doc.toString()).toBe("hello!");
    expect(calls).toEqual([]);
  });

  it("blocks imperative source replacement when the host cannot write", () => {
    const calls: string[] = [];
    const bridge = createCrdtBridge({
      getHandle: () =>
        ({
          update_source: (_cellId: string, source: string) => {
            calls.push(source);
            return true;
          },
          get_cell_source: () => "updated",
        }) as never,
      cellId: "cell-a",
      canWriteSource: () => false,
      onSourceChanged: (source) => calls.push(`store:${source}`),
      onSyncNeeded: () => calls.push("sync"),
    });

    expect(bridge.replaceSource("blocked")).toBe(false);
    expect(calls).toEqual([]);
  });
});
