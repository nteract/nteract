// @vitest-environment jsdom
import { Compartment, EditorState } from "@codemirror/state";
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
  it("coalesces local source store updates while keeping sync notifications", async () => {
    let source = "hello";
    const calls: string[] = [];
    const bridge = createCrdtBridge({
      getHandle: () =>
        ({
          splice_source: (
            _cellId: string,
            index: number,
            deleteCount: number,
            text: string,
          ) => {
            source = `${source.slice(0, index)}${text}${source.slice(index + deleteCount)}`;
            return true;
          },
          get_cell_source: () => source,
        }) as never,
      cellId: "cell-a",
      onSourceChanged: (nextSource) => calls.push(`store:${nextSource}`),
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
    view.dispatch({ changes: { from: 6, insert: "?" } });

    expect(view.state.doc.toString()).toBe("hello!?");
    expect(calls).toEqual(["sync", "sync"]);

    await Promise.resolve();

    expect(calls).toEqual(["sync", "sync", "store:hello!?"]);
  });

  it("keeps notifying source changes after the bridge plugin is recreated", async () => {
    let source = "hello";
    const calls: string[] = [];
    const bridge = createCrdtBridge({
      getHandle: () =>
        ({
          splice_source: (
            _cellId: string,
            index: number,
            deleteCount: number,
            text: string,
          ) => {
            source = `${source.slice(0, index)}${text}${source.slice(index + deleteCount)}`;
            return true;
          },
          get_cell_source: () => source,
        }) as never,
      cellId: "cell-a",
      onSourceChanged: (nextSource) => calls.push(`store:${nextSource}`),
      onSyncNeeded: () => calls.push("sync"),
    });
    const bridgeCompartment = new Compartment();
    const view = new EditorView({
      state: EditorState.create({
        doc: "hello",
        extensions: [bridgeCompartment.of(bridge.extension)],
      }),
    });
    views.push(view);

    view.dispatch({ effects: bridgeCompartment.reconfigure([]) });
    view.dispatch({ effects: bridgeCompartment.reconfigure(bridge.extension) });
    view.dispatch({ changes: { from: 5, insert: "!" } });

    await Promise.resolve();

    expect(view.state.doc.toString()).toBe("hello!");
    expect(calls).toEqual(["sync", "store:hello!"]);
  });

  it("drops pending coalesced store updates after imperative source replacement", async () => {
    let source = "hello";
    const calls: string[] = [];
    const bridge = createCrdtBridge({
      getHandle: () =>
        ({
          splice_source: (
            _cellId: string,
            index: number,
            deleteCount: number,
            text: string,
          ) => {
            source = `${source.slice(0, index)}${text}${source.slice(index + deleteCount)}`;
            return true;
          },
          update_source: (_cellId: string, nextSource: string) => {
            source = nextSource;
            return true;
          },
          get_cell_source: () => source,
        }) as never,
      cellId: "cell-a",
      onSourceChanged: (nextSource) => calls.push(`store:${nextSource}`),
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
    expect(bridge.replaceSource("external")).toBe(true);

    await Promise.resolve();

    expect(view.state.doc.toString()).toBe("external");
    expect(calls).toEqual(["sync", "store:external", "sync"]);
  });

  it("reconciles outbound editor transactions when the host cannot write", () => {
    const calls: string[] = [];
    const bridge = createCrdtBridge({
      getHandle: () =>
        ({
          splice_source: (_cellId: string, _index: number, _deleteCount: number, text: string) => {
            calls.push(text);
            return true;
          },
          get_cell_source: () => "hello",
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

    expect(view.state.doc.toString()).toBe("hello");
    expect(calls).toEqual([]);
  });

  it("reconciles outbound editor transactions when the handle is unavailable", () => {
    const calls: string[] = [];
    const bridge = createCrdtBridge({
      getHandle: () => null,
      cellId: "cell-a",
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

    expect(view.state.doc.toString()).toBe("hello");
    expect(calls).toEqual([]);
  });

  it("reconciles to the handle source when a splice is rejected", async () => {
    const calls: string[] = [];
    const bridge = createCrdtBridge({
      getHandle: () =>
        ({
          splice_source: () => false,
          get_cell_source: () => "authoritative",
        }) as never,
      cellId: "cell-a",
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
    await Promise.resolve();

    expect(view.state.doc.toString()).toBe("authoritative");
    expect(calls).toEqual(["store:authoritative", "sync"]);
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
