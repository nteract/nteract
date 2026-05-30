import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BlobResolver } from "runtimed";
import { resolveCellsProgressively } from "../viewer/progressive-cell-resolution.ts";
import { createOutputResolutionCache } from "../viewer/render-resolution.ts";

describe("cloud viewer progressive cell resolution", () => {
  it("emits sync cells before waiting for blob-backed outputs", async () => {
    const slowBlob = deferred<void>();
    const events: string[] = [];
    const resolver = textBlobResolver({
      "sha256:slow": async () => {
        events.push("fetch:slow:start");
        await slowBlob.promise;
        events.push("fetch:slow:finish");
        return "shape: (200, 12)";
      },
    });

    const resolution = resolveCellsProgressively(
      [
        {
          id: "intro",
          cell_type: "markdown",
          source: "# Topic viz",
        },
        {
          id: "slow-table",
          cell_type: "code",
          source: "df",
          execution_count: 2,
          outputs: [
            {
              output_id: "slow-table-output",
              output_type: "execute_result",
              execution_count: 2,
              data: {
                "text/plain": { blob: "sha256:slow" },
              },
              metadata: {},
            },
          ],
        },
      ],
      resolver,
      "python",
      createOutputResolutionCache(),
      {
        onInitialCells(cells) {
          events.push(`initial:${cells.map((cell) => cell.outputs.length).join(",")}`);
        },
        onCellResolved(cell) {
          events.push(`resolved:${cell.id}:${cell.outputs.length}`);
        },
      },
    );

    await Promise.resolve();
    assert.equal(events[0], "initial:0,0");
    assert.ok(events.includes("fetch:slow:start"));
    assert.ok(events.includes("resolved:intro:0"));
    assert.ok(!events.includes("fetch:slow:finish"));
    assert.ok(!events.includes("resolved:slow-table:1"));

    slowBlob.resolve();
    const cells = await resolution;

    assert.equal(cells.length, 2);
    assert.equal(cells[1].outputs.length, 1);
    assert.equal(cells[1].outputs[0].output_type, "execute_result");
    if (cells[1].outputs[0].output_type === "execute_result") {
      assert.equal(cells[1].outputs[0].data["text/plain"], "shape: (200, 12)");
    }
    assert.ok(events.indexOf("fetch:slow:finish") < events.indexOf("resolved:slow-table:1"));
    assert.equal(events.at(-1), "resolved:slow-table:1");
  });

  it("stops emitting progressive updates when shouldContinue turns false", async () => {
    let continueResolving = true;
    const slowBlob = deferred<void>();
    const events: string[] = [];

    const resolution = resolveCellsProgressively(
      [
        {
          id: "slow-table",
          cell_type: "code",
          source: "df",
          outputs: [
            {
              output_id: "slow-table-output",
              output_type: "display_data",
              data: {
                "text/plain": { blob: "sha256:slow" },
              },
              metadata: {},
            },
          ],
        },
      ],
      textBlobResolver({
        "sha256:slow": async () => {
          await slowBlob.promise;
          return "late output";
        },
      }),
      "python",
      createOutputResolutionCache(),
      {
        shouldContinue: () => continueResolving,
        onInitialCells() {
          events.push("initial");
        },
        onCellResolved() {
          events.push("resolved");
        },
      },
    );

    await Promise.resolve();
    continueResolving = false;
    slowBlob.resolve();
    await resolution;

    assert.deepEqual(events, ["initial"]);
  });
});

function textBlobResolver(values: Record<string, string | (() => Promise<string>)>): BlobResolver {
  return {
    url(ref) {
      return `https://cloud.test/blobs/${encodeURIComponent(ref.blob)}`;
    },
    async fetch(ref) {
      const value = values[ref.blob];
      if (value === undefined) return new Response("missing", { status: 404 });
      return new Response(typeof value === "function" ? await value() : value);
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}
