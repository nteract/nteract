import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BlobResolver } from "runtimed";
import {
  cloudNotebookLanguageFromHandle,
  materializeCloudNotebookView,
} from "../viewer/cloud-view-model.ts";
import { createOutputResolutionCache } from "../viewer/render-resolution.ts";
import type { NotebookHandle } from "../viewer/runtimed-wasm-client.ts";

describe("cloud notebook view model materialization", () => {
  it("materializes notebook cells and RuntimeStateDoc widget comms from a cloud handle", async () => {
    const handle = stubNotebookHandle({
      cells: [
        {
          id: "intro",
          cell_type: "markdown",
          source: "# Intro",
        },
        {
          id: "code-1",
          cell_type: "code",
          source: "print('ok')",
          execution_count: 4,
          outputs: [
            {
              output_id: "stdout-1",
              output_type: "stream",
              name: "stdout",
              text: "ok\n",
            },
          ],
        },
      ],
      metadata: { language_info: { name: "python" } },
      runtimeState: {
        comms: {
          "slider-1": {
            target_name: "jupyter.widget",
            model_module: "@jupyter-widgets/controls",
            model_name: "IntSliderModel",
            state: { value: 7 },
            seq: 2,
          },
        },
      },
    });

    const materialized = await materializeCloudNotebookView(handle, {
      blobResolver: noopBlobResolver(),
      defaultNotebookLanguage: "python",
      outputResolutionCache: createOutputResolutionCache(),
    });

    assert.equal(materialized.notebookLanguage, "python");
    assert.equal(materialized.rawCellCount, 2);
    assert.deepEqual(
      materialized.cells.map((cell) => [cell.id, cell.cellType, cell.language]),
      [
        ["intro", "markdown", null],
        ["code-1", "code", "python"],
      ],
    );
    assert.equal(materialized.cells[1].executionCount, 4);
    assert.equal(materialized.cells[1].outputs.length, 1);
    assert.deepEqual(
      materialized.widgetComms.map((comm) => [comm.comm_id, comm.model_name, comm.state.value]),
      [["slider-1", "IntSliderModel", 7]],
    );
  });

  it("falls back when notebook metadata has no language", () => {
    const handle = stubNotebookHandle({
      cells: [],
      metadata: {},
      runtimeState: {},
    });

    assert.equal(cloudNotebookLanguageFromHandle(handle, "python"), "python");
  });
});

function stubNotebookHandle({
  cells,
  metadata,
  runtimeState,
}: {
  cells: unknown[];
  metadata: unknown;
  runtimeState: unknown;
}): NotebookHandle {
  return {
    get_cells_json: () => JSON.stringify(cells),
    get_metadata_snapshot_json: () => JSON.stringify(metadata),
    get_runtime_state: () => runtimeState,
  } as unknown as NotebookHandle;
}

function noopBlobResolver(): BlobResolver {
  return {
    url: (blob) => `/blob/${blob.blob}`,
    fetch: async () => {
      throw new Error("unexpected blob fetch");
    },
  };
}
