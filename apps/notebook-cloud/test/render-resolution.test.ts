import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { BlobResolver } from "runtimed";
import { resolveCell, resolveOutputs } from "../viewer/render-resolution.ts";

describe("cloud viewer render resolution", () => {
  it("keeps healthy outputs when one manifest fails to resolve", async () => {
    const outputs = await resolveOutputs(
      [
        {
          output_type: "stream",
          name: "stdout",
          text: "healthy stdout\n",
        },
        {
          output_type: "display_data",
          data: {
            "text/plain": {
              blob: "sha256:missing",
            },
          },
          metadata: {},
        },
      ],
      rejectingBlobResolver(),
    );

    assert.equal(outputs.length, 2);
    assert.deepEqual(outputs[0], {
      output_type: "stream",
      name: "stdout",
      text: "healthy stdout\n",
    });
    assert.equal(outputs[1].output_type, "error");
    if (outputs[1].output_type === "error") {
      assert.equal(outputs[1].ename, "OutputResolutionError");
      assert.match(outputs[1].evalue, /Unable to resolve output/);
      assert.match(outputs[1].evalue, /Failed to fetch blob sha256:missing: 404/);
    }
  });

  it("keeps healthy cells when a sibling cell has a broken output manifest", async () => {
    const [healthyCell, brokenCell] = await Promise.all([
      resolveCell(
        {
          id: "healthy",
          cell_type: "code",
          source: "print('ok')",
          execution_count: 1,
          outputs: [{ output_type: "stream", name: "stdout", text: "ok\n" }],
        },
        rejectingBlobResolver(),
        0,
      ),
      resolveCell(
        {
          id: "broken",
          cell_type: "code",
          source: "df",
          execution_count: 2,
          outputs: [
            {
              output_type: "execute_result",
              execution_count: 2,
              data: {
                "text/plain": {
                  blob: "sha256:missing-result",
                },
              },
              metadata: {},
            },
          ],
        },
        rejectingBlobResolver(),
        1,
      ),
    ]);

    assert.equal(healthyCell.outputs.length, 1);
    assert.equal(healthyCell.outputs[0].output_type, "stream");
    assert.equal(brokenCell.outputs.length, 1);
    assert.equal(brokenCell.outputs[0].output_type, "error");
  });

  it("derives code cell language from cell metadata before notebook metadata", async () => {
    const [
      cellWithLocalLanguage,
      cellWithNotebookLanguage,
      markdownCell,
      codeCellWithDefaultLanguage,
    ] = await Promise.all([
      resolveCell(
        {
          id: "local-language",
          cell_type: "code",
          source: "select * from cities",
          metadata: { language: "sql" },
        },
        rejectingBlobResolver(),
        0,
        "python",
      ),
      resolveCell(
        {
          id: "notebook-language",
          cell_type: "code",
          source: "x <- 1",
          metadata: {},
        },
        rejectingBlobResolver(),
        1,
        "r",
      ),
      resolveCell(
        {
          id: "markdown-language",
          cell_type: "markdown",
          source: "# Title",
          metadata: { language: "python" },
        },
        rejectingBlobResolver(),
        2,
        "python",
      ),
      resolveCell(
        {
          id: "default-language",
          cell_type: "code",
          source: "print('ok')",
          metadata: {},
        },
        rejectingBlobResolver(),
        3,
        "python",
      ),
    ]);

    assert.equal(cellWithLocalLanguage.language, "sql");
    assert.equal(cellWithNotebookLanguage.language, "r");
    assert.equal(markdownCell.language, null);
    assert.equal(codeCellWithDefaultLanguage.language, "python");
  });

  it("falls back to RuntimeStateDoc output execution counts", async () => {
    const cell = await resolveCell(
      {
        id: "runtime-count",
        cell_type: "code",
        source: "df",
        execution_count: "null",
        outputs: [
          {
            output_type: "stream",
            name: "stdout",
            text: "loaded\n",
          },
          {
            output_type: "execute_result",
            execution_count: 7,
            data: { "text/plain": "shape: (25, 8)" },
            metadata: {},
          },
        ],
      },
      rejectingBlobResolver(),
      0,
    );

    assert.equal(cell.executionCount, 7);
  });

  it("keeps an explicit cell execution count over output fallbacks", async () => {
    const cell = await resolveCell(
      {
        id: "cell-count",
        cell_type: "code",
        source: "df",
        execution_count: 3,
        outputs: [
          {
            output_type: "execute_result",
            execution_count: 7,
            data: { "text/plain": "shape: (25, 8)" },
            metadata: {},
          },
        ],
      },
      rejectingBlobResolver(),
      0,
    );

    assert.equal(cell.executionCount, 3);
  });
});

function rejectingBlobResolver(): BlobResolver {
  return {
    url(ref) {
      return `https://cloud.test/blobs/${encodeURIComponent(ref.blob)}`;
    },
    async fetch() {
      return new Response("missing", { status: 404 });
    },
  };
}
