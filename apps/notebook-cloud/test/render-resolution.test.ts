import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { BlobResolver } from "runtimed";
import {
  OUTPUT_RESOLUTION_CACHE_MAX_ENTRIES,
  createOutputResolutionCache,
  resolveCell,
  resolveCellSync,
  resolveOutputs,
} from "../viewer/render-resolution.ts";

describe("cloud viewer render resolution", () => {
  it("preserves widget views so RuntimeStateDoc models can hydrate them", async () => {
    const outputs = await resolveOutputs(
      [
        {
          output_id: "widget-output",
          output_type: "display_data",
          data: {
            "application/vnd.jupyter.widget-view+json": {
              model_id: "slider-1",
            },
            "text/llm+plain": "IntSlider slider: 7 (0-10)",
          },
          metadata: {},
        },
      ],
      rejectingBlobResolver(),
    );

    assert.equal(outputs.length, 1);
    assert.equal(outputs[0].output_type, "display_data");
    if (outputs[0].output_type === "display_data") {
      assert.deepEqual(outputs[0].data["application/vnd.jupyter.widget-view+json"], {
        model_id: "slider-1",
      });
      assert.equal(outputs[0].data["text/llm+plain"], "IntSlider slider: 7 (0-10)");
    }
  });

  it("keeps widget-only outputs instead of inventing static fallbacks", async () => {
    const outputs = await resolveOutputs(
      [
        {
          output_id: "widget-output",
          output_type: "display_data",
          data: {
            "application/vnd.jupyter.widget-view+json": {
              model_id: "slider-1",
            },
          },
          metadata: {},
        },
      ],
      rejectingBlobResolver(),
    );

    assert.equal(outputs.length, 1);
    assert.equal(outputs[0].output_type, "display_data");
    if (outputs[0].output_type === "display_data") {
      assert.deepEqual(outputs[0].data["application/vnd.jupyter.widget-view+json"], {
        model_id: "slider-1",
      });
      assert.equal(outputs[0].data["text/plain"], undefined);
    }
  });

  it("keeps healthy outputs when one manifest fails to resolve", async () => {
    const outputs = await resolveOutputs(
      [
        {
          output_id: "healthy-stdout",
          output_type: "stream",
          name: "stdout",
          text: "healthy stdout\n",
        },
        {
          output_id: "missing-display",
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
      output_id: "healthy-stdout",
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
          outputs: [
            {
              output_id: "healthy-cell-stdout",
              output_type: "stream",
              name: "stdout",
              text: "ok\n",
            },
          ],
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
              output_id: "broken-result",
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

  it("materializes source and sync-resolvable outputs before blob-backed outputs", async () => {
    const cell = resolveCellSync(
      {
        id: "progressive-cell",
        cell_type: "code",
        source: "display(df)",
        execution_count: 1,
        outputs: [
          {
            output_id: "inline-stream",
            output_type: "stream",
            name: "stdout",
            text: { inline: "loaded\n" },
          },
          {
            output_id: "blob-text",
            output_type: "display_data",
            data: {
              "text/plain": { blob: "sha256:text" },
            },
            metadata: {},
          },
        ],
      },
      textBlobResolver({ "sha256:text": "shape: (25, 8)" }),
      0,
      "python",
    );

    assert.equal(cell.source, "display(df)");
    assert.equal(cell.outputs.length, 1);
    assert.equal(cell.outputs[0].output_id, "inline-stream");
  });

  it("deduplicates concurrent blob-backed output resolution", async () => {
    const cache = createOutputResolutionCache();
    const resolver = textBlobResolver({ "sha256:text": "resolved once" });
    const manifest = {
      output_id: "blob-text",
      output_type: "display_data",
      data: {
        "text/plain": { blob: "sha256:text" },
      },
      metadata: {},
    };

    const [first, second] = await Promise.all([
      resolveOutputs([manifest], resolver, "cell", cache),
      resolveOutputs([manifest], resolver, "cell", cache),
    ]);

    assert.equal(resolver.fetchCount(), 1);
    assert.deepEqual(first, second);
    assert.equal(first[0].output_type, "display_data");
    if (first[0].output_type === "display_data") {
      assert.equal(first[0].data["text/plain"], "resolved once");
    }
  });

  it("keeps synthetic output ids unique when cached raw outputs omit output_id", async () => {
    const cache = createOutputResolutionCache();
    const output = {
      output_type: "stream",
      name: "stdout",
      text: "same text\n",
    };

    const [first, second] = await Promise.all([
      resolveOutputs([output], rejectingBlobResolver(), "cell-a", cache),
      resolveOutputs([output], rejectingBlobResolver(), "cell-b", cache),
    ]);

    assert.equal(first[0].output_id, "cloud-output:cell-a:0");
    assert.equal(second[0].output_id, "cloud-output:cell-b:0");
  });

  it("skips cache collisions for non-serializable raw outputs", async () => {
    const cache = createOutputResolutionCache();
    const firstOutput = {
      output_type: "stream",
      name: "stdout",
      text: "first\n",
      value: 1n,
    };
    const secondOutput = {
      output_type: "stream",
      name: "stdout",
      text: "second\n",
      value: 2n,
    };

    const first = await resolveOutputs([firstOutput], rejectingBlobResolver(), "cell-a", cache);
    const second = await resolveOutputs([secondOutput], rejectingBlobResolver(), "cell-b", cache);

    assert.equal(first[0].output_type, "stream");
    assert.equal(second[0].output_type, "stream");
    if (first[0].output_type === "stream" && second[0].output_type === "stream") {
      assert.equal(first[0].text, "first\n");
      assert.equal(second[0].text, "second\n");
    }
  });

  it("bounds the output resolution cache across many distinct outputs", async () => {
    const cache = createOutputResolutionCache();
    const outputs = Array.from(
      { length: OUTPUT_RESOLUTION_CACHE_MAX_ENTRIES + 10 },
      (_, index) => ({
        output_id: `output-${index}`,
        output_type: "stream",
        name: "stdout",
        text: `output ${index}\n`,
      }),
    );

    await resolveOutputs(outputs, rejectingBlobResolver(), "many-outputs", cache);

    assert.equal(cache.size, OUTPUT_RESOLUTION_CACHE_MAX_ENTRIES);
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
        execution_id: "exec-runtime-count",
        execution_count: "null",
        outputs: [
          {
            output_id: "runtime-count-stream",
            output_type: "stream",
            name: "stdout",
            text: "loaded\n",
          },
          {
            output_id: "runtime-count-result",
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
    assert.equal(cell.executionId, "exec-runtime-count");
  });

  it("stamps direct outputs without output_id before isolated rendering", async () => {
    const cell = await resolveCell(
      {
        id: "raw-output-cell",
        cell_type: "code",
        source: "print('legacy')",
        outputs: [
          {
            output_type: "stream",
            name: "stdout",
            text: "legacy\n",
          },
        ],
      },
      rejectingBlobResolver(),
      0,
    );

    assert.equal(cell.outputs.length, 1);
    assert.equal(cell.outputs[0].output_id, "cloud-output:raw-output-cell:0");
  });

  it("reports manifest-shaped outputs without output_id instead of rendering ContentRefs", async () => {
    const outputs = await resolveOutputs(
      [
        {
          output_type: "display_data",
          data: {
            "text/plain": { inline: "legacy manifest text" },
          },
          metadata: {},
        },
      ],
      rejectingBlobResolver(),
      "legacy-manifest-cell",
    );

    assert.equal(outputs.length, 1);
    assert.equal(outputs[0].output_type, "error");
    assert.equal(outputs[0].output_id, "resolution-error:cloud-output:legacy-manifest-cell:0");
    if (outputs[0].output_type === "error") {
      assert.match(outputs[0].evalue, /without output_id/);
    }
  });

  it("does not mistake JSON MIME objects with url fields for ContentRefs", async () => {
    const outputs = await resolveOutputs(
      [
        {
          output_type: "display_data",
          data: {
            "application/json": { url: "https://example.test/value" },
          },
          metadata: {},
        },
      ],
      rejectingBlobResolver(),
      "json-url-cell",
    );

    assert.equal(outputs.length, 1);
    assert.equal(outputs[0].output_id, "cloud-output:json-url-cell:0");
    assert.equal(outputs[0].output_type, "display_data");
    if (outputs[0].output_type === "display_data") {
      assert.deepEqual(outputs[0].data["application/json"], {
        url: "https://example.test/value",
      });
    }
  });

  it("uses the first finite execute_result count as the output fallback", async () => {
    const cell = await resolveCell(
      {
        id: "multiple-results",
        cell_type: "code",
        source: "a\nb",
        execution_count: "null",
        outputs: [
          {
            output_id: "multiple-results-a",
            output_type: "execute_result",
            execution_count: 7,
            data: { "text/plain": "a" },
            metadata: {},
          },
          {
            output_id: "multiple-results-b",
            output_type: "execute_result",
            execution_count: 8,
            data: { "text/plain": "b" },
            metadata: {},
          },
        ],
      },
      rejectingBlobResolver(),
      0,
    );

    assert.equal(cell.executionCount, 7);
  });

  it("does not derive execution counts from non-result outputs", async () => {
    const cell = await resolveCell(
      {
        id: "no-result-count",
        cell_type: "code",
        source: "display(df)",
        execution_count: "null",
        outputs: [
          {
            output_id: "no-result-count-stream",
            output_type: "stream",
            name: "stdout",
            text: "loaded\n",
          },
          {
            output_id: "no-result-count-display",
            output_type: "display_data",
            execution_count: 99,
            data: { "text/plain": "display only" },
            metadata: {},
          },
        ],
      },
      rejectingBlobResolver(),
      0,
    );

    assert.equal(cell.executionCount, null);
  });

  it("resolves direct Arrow and Parquet blob refs to cloud blob URLs", async () => {
    const outputs = await resolveOutputs(
      [
        {
          output_id: "direct-columnar-refs",
          output_type: "execute_result",
          execution_count: 1,
          data: {
            "application/vnd.apache.arrow.stream": {
              blob: "sha256:arrow",
              size: 18744,
            },
            "application/vnd.apache.parquet": {
              blob: "sha256:parquet",
              size: 4096,
            },
            "text/plain": {
              inline: "shape: (25, 10)",
            },
          },
          metadata: {},
        },
      ],
      rejectingBlobResolver(),
    );

    assert.equal(outputs.length, 1);
    assert.equal(outputs[0].output_type, "execute_result");
    if (outputs[0].output_type === "execute_result") {
      assert.equal(
        outputs[0].data["application/vnd.apache.arrow.stream"],
        "https://cloud.test/blobs/sha256%3Aarrow",
      );
      assert.equal(
        outputs[0].data["application/vnd.apache.parquet"],
        "https://cloud.test/blobs/sha256%3Aparquet",
      );
      assert.equal(outputs[0].data["text/plain"], "shape: (25, 10)");
    }
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
            output_id: "cell-count-result",
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

function textBlobResolver(values: Record<string, string>): BlobResolver & { fetchCount(): number } {
  let count = 0;
  return {
    url(ref) {
      return `https://cloud.test/blobs/${encodeURIComponent(ref.blob)}`;
    },
    async fetch(ref) {
      count += 1;
      const value = values[ref.blob];
      return value === undefined ? new Response("missing", { status: 404 }) : new Response(value);
    },
    fetchCount() {
      return count;
    },
  };
}
