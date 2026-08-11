import {
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { loadRuntimedWasm } from "./wasm_loader.ts";

// @ts-nocheck — wasm-bindgen output doesn't have Deno-compatible type declarations

// deno-lint-ignore no-explicit-any
const { NotebookHandle, RoomHostHandle, RuntimeStatePeerHandle }: any =
  await loadRuntimedWasm();

const REQUEST_FRAME_TYPE = 0x01;
const EXECUTION_ID = "11111111-1111-4111-8111-111111111111";

function createRoomHost() {
  const notebook = new NotebookHandle("hosted-execution-id-test");
  notebook.add_cell(0, "cell-1", "code");
  notebook.update_source("cell-1", "print('one')");
  notebook.add_cell(1, "cell-2", "code");
  notebook.update_source("cell-2", "print('two')");
  const host = RoomHostHandle.load_snapshot(
    notebook.save(),
    notebook.save_state_doc(),
  );
  notebook.free();
  return host;
}

function executeCell(
  host: RoomHostHandle,
  cellId: string,
  executionId: string,
) {
  const payload = new TextEncoder().encode(
    JSON.stringify({
      action: "execute_cell",
      cell_id: cellId,
      execution_id: executionId,
    }),
  );
  const frame = new Uint8Array(payload.length + 1);
  frame[0] = REQUEST_FRAME_TYPE;
  frame.set(payload, 1);
  return host.receive_peer_frame(
    "owner-peer",
    "user:dev:alice",
    "user:dev:alice/browser:cloud",
    "owner",
    true,
    frame,
  );
}

Deno.test("RoomHostHandle: retries the same requested execution ID for the same cell", () => {
  let host = createRoomHost();
  const first = executeCell(host, "cell-1", EXECUTION_ID);
  assertEquals(first.runtime_state_changed, true);
  assertEquals(first.notebook_changed, true);
  assertEquals(host.get_runtime_queue_depth(), 1);

  const activeRetry = executeCell(host, "cell-1", EXECUTION_ID);
  assertEquals(activeRetry.runtime_state_changed, false);
  assertEquals(activeRetry.notebook_changed, false);
  assertEquals(host.get_runtime_queue_depth(), 1);

  const runtime = RuntimeStatePeerHandle.load(
    host.save_runtime_state_doc(),
    "runtime:dev:test/agent:hosted",
  );
  runtime.set_execution_done(EXECUTION_ID, true);
  const terminalHost = RoomHostHandle.load_snapshot(
    host.save_notebook(),
    runtime.save(),
  );
  runtime.free();
  host.free();
  host = terminalHost;

  const terminalRetry = executeCell(host, "cell-1", EXECUTION_ID);
  assertEquals(terminalRetry.runtime_state_changed, false);
  assertEquals(terminalRetry.notebook_changed, false);
  assertEquals(host.get_runtime_queue_depth(), 1);
  host.free();
});

Deno.test("RoomHostHandle: rejects a requested execution ID owned by another cell", () => {
  const host = createRoomHost();
  executeCell(host, "cell-1", EXECUTION_ID);

  assertThrows(
    () => executeCell(host, "cell-2", EXECUTION_ID),
    Error,
    `execution_id already exists: ${EXECUTION_ID}`,
  );
  assertEquals(host.get_runtime_queue_depth(), 1);
  host.free();
});
