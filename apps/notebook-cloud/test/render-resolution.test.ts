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
