import { assertEquals, assertExists } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { loadRuntimedWasm } from "./wasm_loader.ts";

const { RoomHostHandle, NotebookHandle } = await loadRuntimedWasm();

Deno.test("RoomHostHandle exposes a receipt matching its saved execution", () => {
  const host = RoomHostHandle.create_empty("receipt-test", "system/host");
  try {
    host.seed_initial_code_cell_if_empty("cell-1");
    const request = new TextEncoder().encode(JSON.stringify({ action: "execute_cell", cell_id: "cell-1" }));
    const frame = new Uint8Array(request.length + 1);
    frame[0] = 1; // REQUEST
    frame.set(request, 1);
    const execute = () => host.receive_peer_frame("peer", "user:dev:alice", "user:dev:alice/client:a", "owner", true, frame);
    const result = execute();
    assertExists(result.execution_response);
    assertEquals(result.execution_response.result, "cell_queued");
    assertEquals(result.execution_response.cell_id, "cell-1");
    const restored = NotebookHandle.load_snapshot(host.save_notebook(), host.save_runtime_state_doc());
    try {
      assertEquals(restored.get_cell_execution_id("cell-1"), result.execution_response.execution_id);
      assertExists(restored.get_execution_by_id(result.execution_response.execution_id));
    } finally { restored.free(); }
    const retry = execute();
    assertEquals(retry.changed, false);
    assertEquals(retry.execution_response, result.execution_response);
  } finally { host.free(); }
});
