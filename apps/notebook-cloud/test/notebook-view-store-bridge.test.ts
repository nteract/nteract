import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { updateCellById } from "@/components/notebook/state/cell-store";
import { createNotebookViewModelFromNotebookCells } from "@/components/notebook/state/view-model-store";
import {
  projectCloudCellsIntoNotebookViewStores,
  resetCloudViewStoreProjection,
} from "../viewer/notebook-view-store-bridge.ts";

describe("cloud NotebookView store bridge", () => {
  afterEach(() => {
    resetCloudViewStoreProjection();
  });

  it("keeps outline projection tied to the shared NotebookView store after local source edits", () => {
    projectCloudCellsIntoNotebookViewStores([
      {
        id: "intro",
        cellType: "markdown",
        source: "# Original title",
        language: null,
        executionId: null,
        executionCount: null,
        outputs: [],
        metadata: {},
      },
    ]);

    assert.deepEqual(outlineTitlesFromStore(), ["Original title"]);

    updateCellById("intro", (cell) => ({
      ...cell,
      source: "# Updated title\n\nBody",
    }));

    assert.deepEqual(outlineTitlesFromStore(), ["Updated title"]);
  });
});

function outlineTitlesFromStore(): string[] {
  return createNotebookViewModelFromNotebookCells().outlineItems.map((item) => item.title);
}
