import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveCloudNotebookOutlineItems } from "../viewer/notebook-outline.ts";

test("cloud notebook outline derives headings from live materialized cells", () => {
  const outline = deriveCloudNotebookOutlineItems([
    {
      id: "intro",
      cellType: "markdown",
      source: "# Intro\n\n## Setup",
      executionCount: null,
    },
    {
      id: "code-1",
      cellType: "code",
      source: "print('ok')",
      executionCount: 3,
    },
  ]);

  assert.deepEqual(
    outline.map((item) => [item.id, item.cellId, item.title, item.level]),
    [
      ["intro:heading:0", "intro", "Intro", 1],
      ["intro:heading:1", "intro", "Setup", 2],
    ],
  );
});

test("cloud notebook outline follows live cell source updates", () => {
  const first = deriveCloudNotebookOutlineItems([
    {
      id: "section",
      cellType: "markdown",
      source: "# Draft",
      executionCount: null,
    },
  ]);
  const updated = deriveCloudNotebookOutlineItems([
    {
      id: "section",
      cellType: "markdown",
      source: "# Published\n\n## Details",
      executionCount: null,
    },
  ]);

  assert.deepEqual(
    first.map((item) => item.title),
    ["Draft"],
  );
  assert.deepEqual(
    updated.map((item) => item.title),
    ["Published", "Details"],
  );
});

test("cloud notebook outline falls back to cells when headings are absent", () => {
  const outline = deriveCloudNotebookOutlineItems([
    {
      id: "code-1",
      cellType: "code",
      source: "print('ok')",
      executionCount: 7,
    },
  ]);

  assert.equal(outline.length, 1);
  assert.equal(outline[0].cellId, "code-1");
  assert.equal(outline[0].statusLabel, "In [7]");
});
