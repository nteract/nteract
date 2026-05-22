/**
 * Snapshot materialization tests for persisted NotebookDoc + RuntimeStateDoc
 * pairs. This is the path hosted viewers use when loading published revisions
 * from object storage instead of joining a live local daemon room.
 */

import {
  assert,
  assertEquals,
  assertExists,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

// deno-lint-ignore no-explicit-any
let init: any, NotebookHandle: any;

const wasmJsPath = new URL(
  "../../../apps/notebook/src/wasm/runtimed-wasm/runtimed_wasm.js",
  import.meta.url,
);
const wasmBinPath = new URL(
  "../../../apps/notebook/src/wasm/runtimed-wasm/runtimed_wasm_bg.wasm",
  import.meta.url,
);
const fixturesDir = new URL("../../../packages/runtimed/tests/fixtures/", import.meta.url);

const mod = await import(wasmJsPath.href);
init = mod.default;
NotebookHandle = mod.NotebookHandle;

const wasmBytes = await Deno.readFile(wasmBinPath);
await init(wasmBytes);

async function readFixtureBytes(scenario: string, name: string): Promise<Uint8Array> {
  return await Deno.readFile(new URL(`${scenario}/${name}`, fixturesDir));
}

function loadCellsJson(handle: any): Array<Record<string, any>> {
  return JSON.parse(handle.get_cells_json());
}

Deno.test("load_snapshot materializes NotebookDoc cells with RuntimeStateDoc outputs", async () => {
  const docBytes = await readFixtureBytes("multi_cell_execution", "doc.bin");
  const stateBytes = await readFixtureBytes("multi_cell_execution", "state_doc.bin");

  const handle = NotebookHandle.load_snapshot(docBytes, stateBytes);
  try {
    const cells = loadCellsJson(handle);

    assertEquals(cells.length, 3);
    assertEquals(cells[0].id, "cell-1");
    assertEquals(cells[0].execution_id, "exec-001");
    assertEquals(cells[0].outputs, []);

    assertEquals(cells[1].id, "cell-2");
    assertEquals(cells[1].execution_id, "exec-002");
    assertEquals(cells[1].outputs.length, 1);
    assertEquals(cells[1].outputs[0].output_id, "8f359d50-e5a4-5243-a71a-120209c0adb1");

    const changeset = handle.project_execution_view_changeset();
    assertExists(changeset.execution_upserts);
    assert(
      changeset.execution_upserts.some(
        ([executionId]: [string, unknown]) => executionId === "exec-002",
      ),
      "projector should expose fixture execution snapshots",
    );
  } finally {
    handle.free();
  }
});

Deno.test("save_state_doc preserves runtime outputs for snapshot round trips", async () => {
  const docBytes = await readFixtureBytes("output_streaming", "doc.bin");
  const stateBytes = await readFixtureBytes("output_streaming", "state_doc.bin");

  const original = NotebookHandle.load_snapshot(docBytes, stateBytes);
  try {
    const originalNotebookHeads = original.get_heads_hex();
    const originalRuntimeHeads = original.get_runtime_state_heads_hex();
    const savedDoc = original.save();
    const savedStateDoc = original.save_state_doc();

    const roundTrip = NotebookHandle.load_snapshot(savedDoc, savedStateDoc);
    try {
      assertEquals(roundTrip.get_heads_hex(), originalNotebookHeads);
      assertEquals(roundTrip.get_runtime_state_heads_hex(), originalRuntimeHeads);

      const cell = loadCellsJson(roundTrip)[0];
      assertEquals(cell.id, "cell-1");
      assertEquals(cell.outputs.map((output: Record<string, unknown>) => output.output_id), [
        "c8b09c2d-a456-5186-b875-441a5fadf374",
        "58af4526-9a90-5bca-98de-d8d0e36718b2",
        "cad63e3f-42e3-542b-b28b-5d3acde7906d",
      ]);
    } finally {
      roundTrip.free();
    }
  } finally {
    original.free();
  }
});

Deno.test("load_snapshot reports invalid notebook and runtime-state bytes", async () => {
  const docBytes = await readFixtureBytes("multi_cell_execution", "doc.bin");
  const stateBytes = await readFixtureBytes("multi_cell_execution", "state_doc.bin");
  const malformedBytes = new Uint8Array([0xff, 0x00, 0xff, 0x00]);

  assertThrows(
    () => NotebookHandle.load_snapshot(malformedBytes, stateBytes),
    Error,
    "load failed",
  );
  assertThrows(
    () => NotebookHandle.load_snapshot(docBytes, malformedBytes),
    Error,
    "load_state_doc failed",
  );
});

Deno.test("load_state_doc resets runtime-state sync tracking", async () => {
  const docBytes = await readFixtureBytes("multi_cell_execution", "doc.bin");
  const stateBytes = await readFixtureBytes("multi_cell_execution", "state_doc.bin");

  const handle = NotebookHandle.load(docBytes);
  try {
    assertExists(
      handle.flush_runtime_state_sync(),
      "bootstrap RuntimeStateDoc should produce an initial sync message",
    );

    handle.load_state_doc(stateBytes);

    assertExists(
      handle.flush_runtime_state_sync(),
      "loaded RuntimeStateDoc should flush after sync-state reset",
    );
  } finally {
    handle.free();
  }
});
