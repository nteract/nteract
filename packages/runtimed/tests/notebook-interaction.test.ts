import { describe, expect, it } from "vite-plus/test";
import {
  createNotebookInteractionStore,
  notebookInteractionTargetCellId,
  notebookInteractionTargetsEqual,
  notebookInteractionTargetToPresenceTarget,
  notebookPresenceTargetToInteractionTarget,
} from "../src/notebook-interaction";

describe("notebook interaction projection", () => {
  it("derives active cell id from every target kind", () => {
    expect(notebookInteractionTargetCellId({ kind: "cell", cellId: "cell-1" })).toBe("cell-1");
    expect(notebookInteractionTargetCellId({ kind: "editor", cellId: "cell-2" })).toBe("cell-2");
    expect(
      notebookInteractionTargetCellId({
        kind: "markdownAnchor",
        cellId: "cell-3",
        anchorId: "findings",
      }),
    ).toBe("cell-3");
    expect(
      notebookInteractionTargetCellId({ kind: "output", cellId: "cell-4", outputId: "out-1" }),
    ).toBe("cell-4");
  });

  it("compares optional output ids and markdown anchors", () => {
    expect(
      notebookInteractionTargetsEqual(
        { kind: "output", cellId: "cell-1" },
        { kind: "output", cellId: "cell-1" },
      ),
    ).toBe(true);
    expect(
      notebookInteractionTargetsEqual(
        { kind: "output", cellId: "cell-1" },
        { kind: "output", cellId: "cell-1", outputId: "out-1" },
      ),
    ).toBe(false);
    expect(
      notebookInteractionTargetsEqual(
        { kind: "markdownAnchor", cellId: "cell-1", anchorId: "a" },
        { kind: "markdownAnchor", cellId: "cell-1", anchorId: "b" },
      ),
    ).toBe(false);
  });

  it("converts between app and presence target shapes", () => {
    const appTarget = {
      kind: "markdownAnchor" as const,
      cellId: "cell-1",
      anchorId: "findings",
    };
    const presenceTarget = notebookInteractionTargetToPresenceTarget(appTarget);

    expect(presenceTarget).toEqual({
      kind: "markdown_anchor",
      cell_id: "cell-1",
      anchor_id: "findings",
    });
    expect(notebookPresenceTargetToInteractionTarget(presenceTarget)).toEqual(appTarget);
  });

  it("emits snapshots when the active target changes", () => {
    const store = createNotebookInteractionStore();
    const seen: Array<string | null> = [];
    const unsubscribe = store.subscribe(() => {
      seen.push(store.getSnapshot().activeCellId);
    });

    store.setActiveTarget({ kind: "cell", cellId: "cell-1" });
    store.setActiveTarget({ kind: "cell", cellId: "cell-1" });
    store.setActiveTarget({ kind: "output", cellId: "cell-1" });
    store.clearActiveTarget();
    unsubscribe();

    expect(seen).toEqual([null, "cell-1", "cell-1", null]);
    expect(store.getSnapshot()).toMatchObject({
      activeTarget: null,
      activeCellId: null,
      version: 3,
    });
  });
});
