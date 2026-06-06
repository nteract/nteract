import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { updateCellSourceById } from "@/components/notebook/state/cell-store";
import { createNotebookViewModelFromNotebookCells } from "@/components/notebook/state/view-model-store";
import { setMarkdownProjectionProjector } from "@/lib/markdown-projection";
import {
  projectCloudCellsIntoNotebookViewStores,
  resetCloudViewStoreProjection,
} from "../viewer/notebook-view-store-bridge.ts";

describe("cloud NotebookView store bridge", () => {
  let restoreMarkdownProjectionProjector: (() => void) | undefined;

  afterEach(() => {
    restoreMarkdownProjectionProjector?.();
    restoreMarkdownProjectionProjector = undefined;
    resetCloudViewStoreProjection();
  });

  it("keeps outline projection tied to the shared NotebookView store after local source edits", () => {
    restoreMarkdownProjectionProjector = setMarkdownProjectionProjector(testMarkdownProjector);

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

    updateCellSourceById("intro", "# Updated title\n\nBody");

    assert.deepEqual(outlineTitlesFromStore(), ["Updated title"]);
  });

  it("reuses markdown projections for unchanged cloud cell sources", () => {
    let projectCalls = 0;
    restoreMarkdownProjectionProjector = setMarkdownProjectionProjector((source) => {
      projectCalls += 1;
      return testMarkdownProjector(source);
    });

    const cell = {
      id: "intro",
      cellType: "markdown" as const,
      source: "# Stable title",
      language: null,
      executionId: null,
      executionCount: null,
      outputs: [],
      metadata: {},
    };

    projectCloudCellsIntoNotebookViewStores([cell]);
    projectCloudCellsIntoNotebookViewStores([cell]);

    assert.equal(projectCalls, 1);
    assert.deepEqual(outlineTitlesFromStore(), ["Stable title"]);
  });
});

function outlineTitlesFromStore(): string[] {
  return createNotebookViewModelFromNotebookCells().outlineItems.map((item) => item.title);
}

function testMarkdownProjector(source: string): string {
  const title =
    source
      .replace(/^#+\s*/, "")
      .split(/\r?\n/, 1)[0]
      ?.trim() || "Untitled";
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return JSON.stringify({
    version: 1,
    engine: "test",
    byteLength: source.length,
    utf16Length: source.length,
    measurement: {
      estimatedHeight: 24,
      confidence: "high",
      width: 720,
    },
    anchors: [
      {
        anchorId: `anchor:${slug}`,
        blockId: "block:0",
        level: 1,
        slug,
        sourceSpanByte: [0, source.length],
        sourceSpanUtf16: [0, source.length],
        title,
      },
    ],
    blocks: [],
    runs: [],
  });
}
