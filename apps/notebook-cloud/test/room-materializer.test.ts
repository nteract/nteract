import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type {
  D1Database,
  D1PreparedStatement,
  D1Result,
  D1Value,
  DurableObjectState,
  Env,
  R2Bucket,
  R2Object,
  R2ObjectBody,
  R2PutOptions,
} from "../src/cloudflare-types.ts";
import { authenticateDevRequest } from "../src/identity.ts";
import { FrameType, encodeTypedFrame, type FrameTypeValue } from "../src/protocol.ts";
import { RoomMaterializer } from "../src/room-materializer.ts";
import {
  createEmptyRoomHost,
  initializeRuntimedWasm,
  loadRoomHostSnapshot,
  NotebookHandle,
  RuntimeStatePeerHandle,
} from "../src/runtimed-wasm.ts";

const wasmBytes = await readFile(
  new URL("../../notebook/src/wasm/runtimed-wasm/runtimed_wasm_bg.wasm", import.meta.url),
);

before(async () => {
  await initializeRuntimedWasm(wasmBytes);
});

type TestConnectionScope = "viewer" | "editor" | "runtime_peer" | "owner";

describe("RoomHostHandle", () => {
  it("hosts NotebookDoc sync with per-peer state", async () => {
    const host = await createEmptyRoomHost("demo", "system/schema:notebook-cloud-room");
    const owner = NotebookHandle.create_bootstrap("user:dev:alice/desktop:a");
    const viewer = NotebookHandle.create_bootstrap("user:dev:bob/desktop:b");

    syncHostWithClient(host, "peer-owner", "user:dev:alice", true, true, owner);
    owner.add_cell(0, "cell-1", "markdown");
    owner.update_source("cell-1", "# Hosted markdown\n");
    const message = owner.flush_local_changes();
    assert.ok(message);

    const ownerResult = host.receive_peer_frame(
      "peer-owner",
      "user:dev:alice",
      "user:dev:alice/test",
      "owner",
      true,
      encodeTypedFrame(FrameType.AUTOMERGE_SYNC, message),
    ) as {
      changed: boolean;
      outbound: Array<{ peer_id: string; frame_type: FrameTypeValue; payload: number[] }>;
    };

    assert.equal(ownerResult.changed, true);

    syncHostWithClient(host, "peer-viewer", "user:dev:bob", false, false, viewer);

    const cells = JSON.parse(viewer.get_cells_json()) as Array<{ id: string; source: string }>;
    assert.deepEqual(
      cells.map((cell) => [cell.id, cell.source]),
      [["cell-1", "# Hosted markdown\n"]],
    );
  });

  it("allows editor-scoped source edits to existing markdown cells", async () => {
    const host = await createEmptyRoomHost("demo", "system/schema:notebook-cloud-room");
    const owner = NotebookHandle.create_bootstrap("user:dev:alice/desktop:owner");
    const editor = NotebookHandle.create_bootstrap("user:dev:bob/desktop:editor");
    const viewer = NotebookHandle.create_bootstrap("user:dev:carol/desktop:viewer");

    syncHostWithClient(host, "peer-owner", "user:dev:alice", true, true, owner);
    owner.add_cell(0, "markdown-cell", "markdown");
    owner.update_source("markdown-cell", "Draft\n");
    applyClientChangesToHost(host, "peer-owner", "user:dev:alice", true, true, owner);

    syncHostWithClient(host, "peer-editor", "user:dev:bob", true, false, editor);
    editor.update_source("markdown-cell", "Edited collaboratively\n");
    applyClientChangesToHost(host, "peer-editor", "user:dev:bob", true, false, editor);

    syncHostWithClient(host, "peer-viewer", "user:dev:carol", false, false, viewer);
    const cells = JSON.parse(viewer.get_cells_json()) as Array<{ id: string; source: string }>;
    assert.equal(cells[0].id, "markdown-cell");
    assert.equal(cells[0].source, "Edited collaboratively\n");
  });

  it("accepts owner-scoped execution request frames", async () => {
    const host = await createEmptyRoomHost("demo", "system/schema:notebook-cloud-room");
    const owner = NotebookHandle.create_bootstrap("user:dev:alice/desktop:owner");

    syncHostWithClient(host, "peer-owner", "user:dev:alice", true, true, owner);
    owner.add_cell(0, "code-cell", "code");
    owner.update_source("code-cell", "print('owner-only request authority')\n");
    applyClientChangesToHost(host, "peer-owner", "user:dev:alice", true, true, owner);

    const result = host.receive_peer_frame(
      "peer-owner",
      "user:dev:alice",
      "user:dev:alice/desktop:owner",
      "owner",
      true,
      encodeTypedFrame(
        FrameType.REQUEST,
        new TextEncoder().encode(
          JSON.stringify({ id: "request-1", action: "execute_cell", cell_id: "code-cell" }),
        ),
      ),
    ) as { runtime_state_changed: boolean; notebook_changed: boolean };

    assert.equal(result.runtime_state_changed, true);
    assert.equal(result.notebook_changed, true);
  });

  it("rejects non-owner-scoped execution request frames", async () => {
    const host = await createEmptyRoomHost("demo", "system/schema:notebook-cloud-room");
    const owner = NotebookHandle.create_bootstrap("user:dev:alice/desktop:owner");

    syncHostWithClient(host, "peer-owner", "user:dev:alice", true, true, owner);
    owner.add_cell(0, "code-cell", "code");
    owner.update_source("code-cell", "print('owner-only request authority')\n");
    applyClientChangesToHost(host, "peer-owner", "user:dev:alice", true, true, owner);

    for (const scope of ["editor", "viewer", "runtime_peer"] as const) {
      assert.throws(
        () =>
          host.receive_peer_frame(
            `peer-${scope}`,
            `user:dev:${scope}`,
            `user:dev:${scope}/desktop:${scope}`,
            scope,
            false,
            encodeTypedFrame(
              FrameType.REQUEST,
              new TextEncoder().encode(
                JSON.stringify({ id: "request-1", action: "execute_cell", cell_id: "code-cell" }),
              ),
            ),
          ),
        /connection scope cannot submit execution requests/,
        `${scope} should not submit execution requests`,
      );
    }
  });

  it("pushes later document changes to an already-connected viewer", async () => {
    const host = await createEmptyRoomHost("demo", "system/schema:notebook-cloud-room");
    const owner = NotebookHandle.create_bootstrap("user:dev:alice/desktop:owner");
    const viewer = NotebookHandle.create_bootstrap("user:dev:carol/desktop:viewer");

    syncHostWithClient(host, "peer-owner", "user:dev:alice", true, true, owner);
    syncHostWithClient(host, "peer-viewer", "user:dev:carol", false, false, viewer);
    assert.deepEqual(JSON.parse(viewer.get_cells_json()), []);

    owner.add_cell(0, "live-markdown", "markdown");
    owner.update_source("live-markdown", "Live read-only viewers should update.\n");
    const message = owner.flush_local_changes();
    assert.ok(message);

    const result = host.receive_peer_frame(
      "peer-owner",
      "user:dev:alice",
      "user:dev:alice/test",
      "owner",
      true,
      encodeTypedFrame(FrameType.AUTOMERGE_SYNC, message),
    ) as {
      changed: boolean;
      outbound: Array<{ peer_id: string; frame_type: FrameTypeValue; payload: number[] }>;
    };

    assert.equal(result.changed, true);
    assert.ok(
      result.outbound.some(
        (frame) => frame.peer_id === "peer-viewer" && frame.frame_type === FrameType.AUTOMERGE_SYNC,
      ),
      "room host did not queue the editor change for the viewer",
    );

    applyOutboundToClient(result.outbound, "peer-viewer", viewer);
    const cells = JSON.parse(viewer.get_cells_json()) as Array<{ id: string; source: string }>;
    assert.deepEqual(
      cells.map((cell) => [cell.id, cell.source]),
      [["live-markdown", "Live read-only viewers should update.\n"]],
    );
  });

  it("allows editor-scoped source edits to code cells", async () => {
    const host = await createEmptyRoomHost("demo", "system/schema:notebook-cloud-room");
    const owner = NotebookHandle.create_bootstrap("user:dev:alice/desktop:owner");
    const editor = NotebookHandle.create_bootstrap("user:dev:bob/desktop:editor");
    const viewer = NotebookHandle.create_bootstrap("user:dev:carol/desktop:viewer");

    syncHostWithClient(host, "peer-owner", "user:dev:alice", true, true, owner);
    owner.add_cell(0, "code-cell", "code");
    owner.update_source("code-cell", "x = 1\n");
    applyClientChangesToHost(host, "peer-owner", "user:dev:alice", true, true, owner);

    syncHostWithClient(host, "peer-editor", "user:dev:bob", true, false, editor);
    editor.update_source("code-cell", "x = 2\n");
    applyClientChangesToHost(host, "peer-editor", "user:dev:bob", true, false, editor);

    syncHostWithClient(host, "peer-viewer", "user:dev:carol", false, false, viewer);
    const cells = JSON.parse(viewer.get_cells_json()) as Array<{ id: string; source: string }>;
    assert.equal(cells[0].id, "code-cell");
    assert.equal(cells[0].source, "x = 2\n");
  });

  it("allows editor-scoped structural NotebookDoc changes", async () => {
    const host = await createEmptyRoomHost("demo", "system/schema:notebook-cloud-room");
    const editor = NotebookHandle.create_bootstrap("user:dev:bob/desktop:editor");
    const viewer = NotebookHandle.create_bootstrap("user:dev:carol/desktop:viewer");

    syncHostWithClient(host, "peer-editor", "user:dev:bob", true, false, editor);
    editor.add_cell(0, "new-markdown", "markdown");
    editor.update_source("new-markdown", "Editor created this\n");
    applyClientChangesToHost(host, "peer-editor", "user:dev:bob", true, false, editor);

    syncHostWithClient(host, "peer-viewer", "user:dev:carol", false, false, viewer);
    const cells = JSON.parse(viewer.get_cells_json()) as Array<{ id: string; source: string }>;
    assert.equal(cells[0].id, "new-markdown");
    assert.equal(cells[0].source, "Editor created this\n");
  });

  it("rejects editor-scoped notebook metadata changes", async () => {
    const host = await createEmptyRoomHost("demo", "system/schema:notebook-cloud-room");
    const editor = NotebookHandle.create_bootstrap("user:dev:bob/desktop:editor");

    syncHostWithClient(host, "peer-editor", "user:dev:bob", true, false, editor);
    editor.set_metadata("trust", "tampered");
    const message = editor.flush_local_changes();
    assert.ok(message);

    assert.throws(
      () =>
        host.receive_peer_frame(
          "peer-editor",
          "user:dev:bob",
          "user:dev:bob/test",
          "editor",
          false,
          encodeTypedFrame(FrameType.AUTOMERGE_SYNC, message),
        ),
      /editor scope may only edit cells/,
    );
  });

  it("rejects editor-scoped runtime_state_doc_id repointing", async () => {
    const host = await createEmptyRoomHost("demo", "system/schema:notebook-cloud-room");
    const editor = NotebookHandle.create_bootstrap("user:dev:bob/desktop:editor");

    syncHostWithClient(host, "peer-editor", "user:dev:bob", true, false, editor);
    editor.set_runtime_state_doc_id("forged-runtime-doc");
    const message = editor.flush_local_changes();
    assert.ok(message);

    assert.throws(
      () =>
        host.receive_peer_frame(
          "peer-editor",
          "user:dev:bob",
          "user:dev:bob/test",
          "editor",
          false,
          encodeTypedFrame(FrameType.AUTOMERGE_SYNC, message),
        ),
      /editor scope may only edit cells/,
    );
  });

  it("rejects document changes authored by a foreign principal", async () => {
    const host = await createEmptyRoomHost("demo", "system/schema:notebook-cloud-room");
    const forged = NotebookHandle.create_bootstrap("user:dev:mallory/desktop:forge");
    syncHostWithClient(host, "peer-alice", "user:dev:alice", true, true, forged);
    forged.add_cell(0, "cell-forged", "markdown");
    const message = forged.flush_local_changes();
    assert.ok(message);

    assert.throws(
      () =>
        host.receive_peer_frame(
          "peer-alice",
          "user:dev:alice",
          "user:dev:alice/test",
          "owner",
          true,
          encodeTypedFrame(FrameType.AUTOMERGE_SYNC, message),
        ),
      /not authorized/,
    );
  });

  it("rejects viewer-authored document changes", async () => {
    const host = await createEmptyRoomHost("demo", "system/schema:notebook-cloud-room");
    const forgedWriter = NotebookHandle.create_bootstrap("user:dev:alice/desktop:a");
    syncHostWithClient(host, "peer-writer", "user:dev:alice", true, true, forgedWriter);
    forgedWriter.add_cell(0, "cell-viewer", "markdown");
    const message = forgedWriter.flush_local_changes();
    assert.ok(message);

    assert.throws(
      () =>
        host.receive_peer_frame(
          "peer-viewer",
          "user:dev:alice",
          "user:dev:alice/test",
          "viewer",
          false,
          encodeTypedFrame(FrameType.AUTOMERGE_SYNC, message),
        ),
      /cannot write NotebookDoc/,
    );
  });

  it("rejects runtime peers creating RuntimeStateDoc execution intent", async () => {
    const host = await createEmptyRoomHost("demo", "system/schema:notebook-cloud-room");
    const runtime = new RuntimeStatePeerHandle("user:dev:runtime-service/runtime:py-3.12");
    syncRuntimeHostWithRuntimePeer(
      host,
      "peer-runtime",
      "user:dev:runtime-service",
      "runtime_peer",
      false,
      runtime,
    );

    runtime.create_execution_with_source("exec-1", "print('hosted runtime')", 0);

    const message = runtime.flush_runtime_state_sync();
    assert.ok(message);

    assert.throws(
      () =>
        host.receive_peer_frame(
          "peer-runtime",
          "user:dev:runtime-service",
          "user:dev:runtime-service/test",
          "runtime_peer",
          false,
          encodeTypedFrame(FrameType.RUNTIME_STATE_SYNC, message),
        ),
      /executions/,
    );
  });

  it("rejects editor-scoped RuntimeStateDoc changes", async () => {
    const setupHost = await createEmptyRoomHost("demo", "system/schema:notebook-cloud-room");
    const forged = new RuntimeStatePeerHandle("user:dev:bob/desktop:editor");
    // Establish a writable sync state only to force Automerge to emit a
    // changed RuntimeStateDoc payload; the assertion below sends that payload
    // through an editor-scoped connection on a fresh host.
    syncRuntimeHostWithRuntimePeer(
      setupHost,
      "peer-setup",
      "user:dev:bob",
      "runtime_peer",
      false,
      forged,
    );

    forged.create_execution("exec-forged-editor");
    const message = forged.flush_runtime_state_sync();
    assert.ok(message);

    const host = await createEmptyRoomHost("demo", "system/schema:notebook-cloud-room");
    assert.throws(
      () =>
        host.receive_peer_frame(
          "peer-editor",
          "user:dev:bob",
          "user:dev:bob/test",
          "editor",
          false,
          encodeTypedFrame(FrameType.RUNTIME_STATE_SYNC, message),
        ),
      /RuntimeStateDoc/,
    );
  });

  it("allows runtime peers to publish progress for accepted RuntimeStateDoc executions", async () => {
    const host = await createRoomHostWithAcceptedExecution(
      "demo",
      "exec-1",
      "print('hosted runtime')",
    );
    const runtime = new RuntimeStatePeerHandle("user:dev:runtime-service/runtime:py-3.12");
    const viewer = NotebookHandle.create_bootstrap("user:dev:carol/desktop:viewer");
    syncRuntimeHostWithRuntimePeer(
      host,
      "peer-runtime",
      "user:dev:runtime-service",
      "runtime_peer",
      false,
      runtime,
    );

    runtime.set_execution_running("exec-1");
    runtime.set_execution_count("exec-1", 1);
    runtime.append_output_json(
      "exec-1",
      JSON.stringify({
        output_type: "stream",
        output_id: "out-stdout-1",
        name: "stdout",
        text: "hosted runtime\n",
      }),
    );
    runtime.set_execution_done("exec-1", true);

    const message = runtime.flush_runtime_state_sync();
    assert.ok(message);
    const result = host.receive_peer_frame(
      "peer-runtime",
      "user:dev:runtime-service",
      "user:dev:runtime-service/test",
      "runtime_peer",
      false,
      encodeTypedFrame(FrameType.RUNTIME_STATE_SYNC, message),
    ) as {
      changed: boolean;
      runtime_state_changed: boolean;
      outbound: Array<{ peer_id: string; frame_type: FrameTypeValue; payload: number[] }>;
    };

    assert.equal(result.changed, true);
    assert.equal(result.runtime_state_changed, true);

    syncRuntimeHostWithClient(host, "peer-viewer", "user:dev:carol", false, false, viewer);
    const execution = viewer.get_execution_by_id("exec-1") as {
      status: string;
      success: boolean;
      execution_count: number;
      output_ids: string[];
      submitted_by_actor_label: string | null;
    };
    assert.deepEqual(execution, {
      status: "done",
      success: true,
      execution_count: 1,
      output_ids: ["out-stdout-1"],
      submitted_by_actor_label: null,
    });
    assert.deepEqual(viewer.get_output_by_id("out-stdout-1"), {
      output_type: "stream",
      output_id: "out-stdout-1",
      name: "stdout",
      text: "hosted runtime\n",
    });
  });

  it("lets a runtime peer replace stale published kernel error with live running state", async () => {
    const seedHost = await createEmptyRoomHost("demo", "system/schema:notebook-cloud-room");
    const seedRuntime = new RuntimeStatePeerHandle("system/schema:notebook-cloud-room");
    seedRuntime.set_kernel_error("published runtime state is stale");
    const host = await loadRoomHostSnapshot(seedHost.save_notebook(), seedRuntime.save());

    const runtimePrincipal = "user:dev:runtime-service";
    const runtime = new RuntimeStatePeerHandle(`${runtimePrincipal}/agent:runt:test`);
    syncRuntimeHostWithRuntimePeer(
      host,
      "peer-runtime",
      runtimePrincipal,
      "runtime_peer",
      false,
      runtime,
    );

    runtime.set_kernel_running("python", "python", "uv:current_python", "runtime-agent-1");
    const message = runtime.flush_runtime_state_sync();
    assert.ok(message);
    const result = host.receive_peer_frame(
      "peer-runtime",
      runtimePrincipal,
      `${runtimePrincipal}/agent:runt:test`,
      "runtime_peer",
      false,
      encodeTypedFrame(FrameType.RUNTIME_STATE_SYNC, message),
    ) as {
      changed: boolean;
      runtime_state_changed: boolean;
      outbound: Array<{ peer_id: string; frame_type: FrameTypeValue; payload: number[] }>;
    };
    assert.equal(result.changed, true);
    assert.equal(result.runtime_state_changed, true);

    const viewer = NotebookHandle.create_bootstrap("user:dev:carol/desktop:viewer");
    syncRuntimeHostWithClient(host, "peer-viewer", "user:dev:carol", false, false, viewer);
    const runtimeState = viewer.get_runtime_state() as {
      kernel: {
        lifecycle: { lifecycle: string; activity?: string };
        name: string;
        language: string;
        env_source: string;
        runtime_agent_id: string;
      };
    };
    assert.deepEqual(runtimeState.kernel.lifecycle, {
      lifecycle: "Running",
      activity: "Idle",
    });
    assert.equal(runtimeState.kernel.name, "python");
    assert.equal(runtimeState.kernel.language, "python");
    assert.equal(runtimeState.kernel.env_source, "uv:current_python");
    assert.equal(runtimeState.kernel.runtime_agent_id, "runtime-agent-1");
  });

  it("accepts launch state authored after the runtime peer receives the host snapshot", async () => {
    const seedHost = await createEmptyRoomHost("demo", "system/schema:notebook-cloud-room");
    const seedRuntime = new RuntimeStatePeerHandle("system/schema:notebook-cloud-room");
    seedRuntime.set_kernel_error("published runtime state is stale");
    const host = await loadRoomHostSnapshot(seedHost.save_notebook(), seedRuntime.save());

    const runtimePrincipal = "user:dev:runtime-service";
    const runtimeActor = `${runtimePrincipal}/agent:runt:test`;
    const runtime = new RuntimeStatePeerHandle(runtimeActor);
    const peerId = "peer-runtime";

    const initial = host.sync_peer(peerId, "runtime_peer") as {
      outbound: Array<{ peer_id: string; frame_type: FrameTypeValue; payload: number[] }>;
    };
    for (const frame of initial.outbound) {
      if (frame.peer_id !== peerId || frame.frame_type !== FrameType.RUNTIME_STATE_SYNC) {
        continue;
      }
      runtime.receive_frame(encodeTypedFrame(frame.frame_type, new Uint8Array(frame.payload)));
    }

    runtime.set_kernel_running("python", "python", "uv:current_python", "runtime-agent-1");
    const reply = runtime.generate_runtime_state_sync_reply();
    assert.ok(reply);

    const result = host.receive_peer_frame(
      peerId,
      runtimePrincipal,
      runtimeActor,
      "runtime_peer",
      false,
      encodeTypedFrame(FrameType.RUNTIME_STATE_SYNC, reply),
    ) as {
      changed: boolean;
      runtime_state_changed: boolean;
    };
    assert.equal(result.changed, true);
    assert.equal(result.runtime_state_changed, true);

    const viewer = NotebookHandle.create_bootstrap("user:dev:carol/desktop:viewer");
    syncRuntimeHostWithClient(host, "peer-viewer", "user:dev:carol", false, false, viewer);
    const runtimeState = viewer.get_runtime_state() as {
      kernel: { lifecycle: { lifecycle: string; activity?: string }; runtime_agent_id: string };
    };
    assert.deepEqual(runtimeState.kernel.lifecycle, {
      lifecycle: "Running",
      activity: "Idle",
    });
    assert.equal(runtimeState.kernel.runtime_agent_id, "runtime-agent-1");
  });

  it("rejects runtime peer RuntimeStateDoc changes authored by a foreign principal", async () => {
    const host = await createEmptyRoomHost("demo", "system/schema:notebook-cloud-room");
    const forged = new RuntimeStatePeerHandle("user:dev:mallory/runtime:py-3.12");
    syncRuntimeHostWithRuntimePeer(
      host,
      "peer-runtime",
      "user:dev:runtime-service",
      "runtime_peer",
      false,
      forged,
    );

    forged.create_execution("exec-forged");
    const message = forged.flush_runtime_state_sync();
    assert.ok(message);

    assert.throws(
      () =>
        host.receive_peer_frame(
          "peer-runtime",
          "user:dev:runtime-service",
          "user:dev:runtime-service/test",
          "runtime_peer",
          false,
          encodeTypedFrame(FrameType.RUNTIME_STATE_SYNC, message),
        ),
      /not authorized/,
    );
  });

  it("rejects peer RuntimeStateDoc changes authored as system actors", async () => {
    const host = await createEmptyRoomHost("demo", "system/schema:notebook-cloud-room");
    const forged = new RuntimeStatePeerHandle("system/forged-runtime");
    syncRuntimeHostWithRuntimePeer(
      host,
      "peer-runtime",
      "user:dev:runtime-service",
      "runtime_peer",
      false,
      forged,
    );

    forged.create_execution("exec-forged-system");
    const message = forged.flush_runtime_state_sync();
    assert.ok(message);

    assert.throws(
      () =>
        host.receive_peer_frame(
          "peer-runtime",
          "user:dev:runtime-service",
          "user:dev:runtime-service/test",
          "runtime_peer",
          false,
          encodeTypedFrame(FrameType.RUNTIME_STATE_SYNC, message),
        ),
      /not authorized/,
    );
  });

  it("rejects runtime peers that try to edit the NotebookDoc", async () => {
    const host = await createEmptyRoomHost("demo", "system/schema:notebook-cloud-room");
    const runtime = NotebookHandle.create_bootstrap("user:dev:runtime-service/runtime:py-3.12");
    syncHostWithClient(
      host,
      "peer-runtime-writer",
      "user:dev:runtime-service",
      true,
      true,
      runtime,
    );

    runtime.add_cell(0, "runtime-cell", "markdown");
    const message = runtime.flush_local_changes();
    assert.ok(message);

    assert.throws(
      () =>
        host.receive_peer_frame(
          "peer-runtime",
          "user:dev:runtime-service",
          "user:dev:runtime-service/test",
          "runtime_peer",
          false,
          encodeTypedFrame(FrameType.AUTOMERGE_SYNC, message),
        ),
      /cannot write NotebookDoc/,
    );
  });
});

describe("RoomMaterializer", () => {
  it("seeds a brand-new hosted room with one initial code cell", async () => {
    const state = fakeState();
    const materializer = new RoomMaterializer("demo", state, {} as Env);
    const viewer = NotebookHandle.create_bootstrap("user:dev:bob/desktop:b");

    await syncMaterializerWithClient(
      materializer,
      {
        id: "peer-viewer",
        identity: authenticateDevRequest(
          new Request("https://cloud.test/n/demo/sync?user=bob&operator=desktop:b&scope=viewer"),
        ),
      },
      viewer,
    );

    assertInitialEmptyCodeCell(JSON.parse(viewer.get_cells_json()));
  });

  it("reconstructs uncheckpointed starter rooms with the same room-owned changes", async () => {
    const state = fakeState();
    const peer = {
      id: "peer-viewer",
      identity: authenticateDevRequest(
        new Request("https://cloud.test/n/demo/sync?user=bob&operator=desktop:b&scope=viewer"),
      ),
    };
    const viewer = NotebookHandle.create_bootstrap("user:dev:bob/desktop:b");

    await syncMaterializerWithClient(new RoomMaterializer("demo", state, {} as Env), peer, viewer);
    const firstCells = JSON.parse(viewer.get_cells_json()) as Array<{ id: string }>;
    assertInitialEmptyCodeCell(firstCells);

    await syncMaterializerWithClient(new RoomMaterializer("demo", state, {} as Env), peer, viewer);
    const secondCells = JSON.parse(viewer.get_cells_json()) as Array<{ id: string }>;
    assertInitialEmptyCodeCell(secondCells);
    assert.equal(secondCells[0]?.id, firstCells[0]?.id);
    assert.match(
      viewer.contributing_actors().join("\n"),
      /system:notebook-cloud-room\/room:[0-9a-f]{16}/,
    );
  });

  it("persists and reloads a durable room checkpoint", async () => {
    const state = fakeState();
    const editorIdentity = authenticateDevRequest(
      new Request("https://cloud.test/n/demo/sync?user=alice&operator=desktop:a&scope=owner"),
    );
    const editorPeer = {
      id: "peer-editor",
      identity: editorIdentity,
    };
    const editor = NotebookHandle.create_bootstrap(editorIdentity.actorLabel);
    const materializer = new RoomMaterializer("demo", state, {} as Env);
    await syncMaterializerWithClient(materializer, editorPeer, editor);
    editor.add_cell(0, "cell-1", "markdown");
    editor.update_source("cell-1", "Durable room checkpoint\n");
    const message = editor.flush_local_changes();
    assert.ok(message);

    const applied = await materializer.receiveFrame(editorPeer, {
      type: FrameType.AUTOMERGE_SYNC,
      payload: message,
    });
    assert.equal(applied.changed, true);
    await materializer.checkpoint();

    const keys = [...(await state.storage.list({ prefix: "room-host:" })).keys()].sort();
    assert.deepEqual(keys, [
      "room-host:checkpoint",
      "room-host:comms-doc",
      "room-host:notebook-doc",
      "room-host:runtime-state-doc",
    ]);

    const reloaded = new RoomMaterializer("demo", state, {} as Env);
    const viewer = NotebookHandle.create_bootstrap("user:dev:bob/desktop:b");
    await syncMaterializerWithClient(
      reloaded,
      {
        id: "peer-viewer",
        identity: authenticateDevRequest(
          new Request("https://cloud.test/n/demo/sync?user=bob&operator=desktop:b&scope=viewer"),
        ),
      },
      viewer,
    );

    const cells = JSON.parse(viewer.get_cells_json()) as Array<{ id: string; source: string }>;
    assert.equal(cells.length, 2);
    assert.equal(cells[0].id, "cell-1");
    assert.equal(cells[0].source, "Durable room checkpoint\n");
    assert.match(cells[1].id, /^cell-/);
    assert.equal(cells[1].source, "");
  });

  it("ignores unversioned prototype checkpoints so published snapshots can hydrate rooms", async () => {
    const state = fakeState();
    const editorIdentity = authenticateDevRequest(
      new Request("https://cloud.test/n/demo/sync?user=alice&operator=desktop:a&scope=owner"),
    );
    const editorPeer = {
      id: "peer-editor",
      identity: editorIdentity,
    };
    const editor = NotebookHandle.create_bootstrap(editorIdentity.actorLabel);
    const materializer = new RoomMaterializer("demo", state, {} as Env);
    await syncMaterializerWithClient(materializer, editorPeer, editor);
    editor.add_cell(0, "old-cell", "markdown");
    editor.update_source("old-cell", "Old unversioned checkpoint\n");
    const message = editor.flush_local_changes();
    assert.ok(message);
    await materializer.receiveFrame(editorPeer, {
      type: FrameType.AUTOMERGE_SYNC,
      payload: message,
    });
    await materializer.checkpoint();
    await state.storage.put("room-host:checkpoint", {
      notebook_heads: ["old"],
      runtime_state_heads: ["old-runtime"],
      saved_at: "2026-05-23T00:00:00.000Z",
    });

    const reloaded = new RoomMaterializer("demo", state, {} as Env);
    const viewer = NotebookHandle.create_bootstrap("user:dev:bob/desktop:b");
    await syncMaterializerWithClient(
      reloaded,
      {
        id: "peer-viewer",
        identity: authenticateDevRequest(
          new Request("https://cloud.test/n/demo/sync?user=bob&operator=desktop:b&scope=viewer"),
        ),
      },
      viewer,
    );

    assertInitialEmptyCodeCell(JSON.parse(viewer.get_cells_json()));
  });

  it("keeps legacy versioned checkpoints when no published snapshot is available", async () => {
    const state = fakeState();
    const checkpointSnapshot = await createNotebookRoomSnapshot(
      "demo",
      "legacy-cell",
      "Legacy versioned checkpoint\n",
    );
    await Promise.all([
      state.storage.put(
        "room-host:notebook-doc",
        arrayBufferFromBytes(checkpointSnapshot.notebookBytes),
      ),
      state.storage.put(
        "room-host:runtime-state-doc",
        arrayBufferFromBytes(checkpointSnapshot.runtimeStateBytes),
      ),
      state.storage.put("room-host:checkpoint", {
        version: 2,
        notebook_heads: ["legacy"],
        runtime_state_heads: ["legacy-runtime"],
        saved_at: "2026-05-27T00:00:00.000Z",
      }),
    ]);

    const reloaded = new RoomMaterializer("demo", state, {} as Env);
    const viewer = NotebookHandle.create_bootstrap("user:dev:bob/desktop:b");
    await syncMaterializerWithClient(
      reloaded,
      {
        id: "peer-viewer",
        identity: authenticateDevRequest(
          new Request("https://cloud.test/n/demo/sync?user=bob&operator=desktop:b&scope=viewer"),
        ),
      },
      viewer,
    );

    const cells = JSON.parse(viewer.get_cells_json()) as Array<{ id: string; source: string }>;
    assert.deepEqual(
      cells.map((cell) => [cell.id, cell.source]),
      [["legacy-cell", "Legacy versioned checkpoint\n"]],
    );
  });

  it("uses the latest published snapshot instead of legacy versioned checkpoints", async () => {
    const state = fakeState();
    const legacySnapshot = await createNotebookRoomSnapshot(
      "demo",
      "legacy-cell",
      "Legacy checkpoint edit\n",
    );
    await Promise.all([
      state.storage.put(
        "room-host:notebook-doc",
        arrayBufferFromBytes(legacySnapshot.notebookBytes),
      ),
      state.storage.put(
        "room-host:runtime-state-doc",
        arrayBufferFromBytes(legacySnapshot.runtimeStateBytes),
      ),
      state.storage.put("room-host:checkpoint", {
        version: 2,
        notebook_heads: ["legacy"],
        runtime_state_heads: ["legacy-runtime"],
        saved_at: "2026-05-27T00:00:00.000Z",
      }),
    ]);

    const publishedSnapshot = await createNotebookRoomSnapshot(
      "demo",
      "published-cell",
      "Published snapshot markdown\n",
    );
    const env = fakePublishedSnapshotEnv({
      notebookId: "demo",
      revisionId: "revision-current",
      actorLabel: "user:dev:publisher/agent:runt-publish",
      notebookBytes: publishedSnapshot.notebookBytes,
      runtimeStateBytes: publishedSnapshot.runtimeStateBytes,
    });

    const reloaded = new RoomMaterializer("demo", state, env);
    const viewer = NotebookHandle.create_bootstrap("user:dev:bob/desktop:b");
    await syncMaterializerWithClient(
      reloaded,
      {
        id: "peer-viewer",
        identity: authenticateDevRequest(
          new Request("https://cloud.test/n/demo/sync?user=bob&operator=desktop:b&scope=viewer"),
        ),
      },
      viewer,
    );

    const cells = JSON.parse(viewer.get_cells_json()) as Array<{ id: string; source: string }>;
    assert.deepEqual(
      cells.map((cell) => [cell.id, cell.source]),
      [["published-cell", "Published snapshot markdown\n"]],
    );
  });

  it("keeps legacy versioned checkpoints saved after the latest published snapshot", async () => {
    const state = fakeState();
    const legacySnapshot = await createNotebookRoomSnapshot(
      "demo",
      "legacy-cell",
      "Legacy checkpoint edit after publish\n",
    );
    await Promise.all([
      state.storage.put(
        "room-host:notebook-doc",
        arrayBufferFromBytes(legacySnapshot.notebookBytes),
      ),
      state.storage.put(
        "room-host:runtime-state-doc",
        arrayBufferFromBytes(legacySnapshot.runtimeStateBytes),
      ),
      state.storage.put("room-host:checkpoint", {
        version: 2,
        notebook_heads: legacySnapshot.notebookHeads,
        runtime_state_heads: legacySnapshot.runtimeStateHeads,
        saved_at: "2026-05-29T00:00:00.000Z",
      }),
    ]);

    const publishedSnapshot = await createNotebookRoomSnapshot(
      "demo",
      "published-cell",
      "Published snapshot markdown\n",
    );
    const env = fakePublishedSnapshotEnv({
      notebookId: "demo",
      revisionId: "revision-current",
      actorLabel: "user:dev:publisher/agent:runt-publish",
      notebookBytes: publishedSnapshot.notebookBytes,
      runtimeStateBytes: publishedSnapshot.runtimeStateBytes,
    });

    const reloaded = new RoomMaterializer("demo", state, env);
    const viewer = NotebookHandle.create_bootstrap("user:dev:bob/desktop:b");
    await syncMaterializerWithClient(
      reloaded,
      {
        id: "peer-viewer",
        identity: authenticateDevRequest(
          new Request("https://cloud.test/n/demo/sync?user=bob&operator=desktop:b&scope=viewer"),
        ),
      },
      viewer,
    );

    const cells = JSON.parse(viewer.get_cells_json()) as Array<{ id: string; source: string }>;
    assert.deepEqual(
      cells.map((cell) => [cell.id, cell.source]),
      [["legacy-cell", "Legacy checkpoint edit after publish\n"]],
    );
  });

  it("uses the latest published snapshot instead of no-baseline checkpoints", async () => {
    const state = fakeState();
    const checkpointSnapshot = await createNotebookRoomSnapshot(
      "demo",
      "local-cell",
      "Local room edit before first publish\n",
    );
    await Promise.all([
      state.storage.put(
        "room-host:notebook-doc",
        arrayBufferFromBytes(checkpointSnapshot.notebookBytes),
      ),
      state.storage.put(
        "room-host:runtime-state-doc",
        arrayBufferFromBytes(checkpointSnapshot.runtimeStateBytes),
      ),
      state.storage.put("room-host:checkpoint", {
        version: 4,
        notebook_heads: checkpointSnapshot.notebookHeads,
        runtime_state_heads: checkpointSnapshot.runtimeStateHeads,
        saved_at: "2026-05-28T00:00:00.000Z",
        published_revision_id: null,
        published_notebook_heads: null,
        published_runtime_state_heads: null,
      }),
    ]);

    const publishedSnapshot = await createNotebookRoomSnapshot(
      "demo",
      "published-cell",
      "Later published snapshot\n",
    );
    const env = fakePublishedSnapshotEnv({
      notebookId: "demo",
      revisionId: "revision-current",
      actorLabel: "user:dev:publisher/agent:runt-publish",
      notebookBytes: publishedSnapshot.notebookBytes,
      runtimeStateBytes: publishedSnapshot.runtimeStateBytes,
    });

    const reloaded = new RoomMaterializer("demo", state, env);
    const viewer = NotebookHandle.create_bootstrap("user:dev:bob/desktop:b");
    await syncMaterializerWithClient(
      reloaded,
      {
        id: "peer-viewer",
        identity: authenticateDevRequest(
          new Request("https://cloud.test/n/demo/sync?user=bob&operator=desktop:b&scope=viewer"),
        ),
      },
      viewer,
    );

    const cells = JSON.parse(viewer.get_cells_json()) as Array<{ id: string; source: string }>;
    assert.deepEqual(
      cells.map((cell) => [cell.id, cell.source]),
      [["published-cell", "Later published snapshot\n"]],
    );
  });

  it("ignores catalog revisions without RuntimeStateDoc ids", async () => {
    const state = fakeState();
    const publishedSnapshot = await createNotebookRoomSnapshot(
      "demo",
      "published-cell",
      "Legacy metadata publish\n",
    );
    const env = fakePublishedSnapshotEnv({
      notebookId: "demo",
      revisionId: "revision-without-runtime-doc-id",
      actorLabel: "user:dev:publisher/agent:runt-publish",
      notebookBytes: publishedSnapshot.notebookBytes,
      runtimeStateBytes: publishedSnapshot.runtimeStateBytes,
      runtimeStateDocId: null,
    });

    const materializer = new RoomMaterializer("demo", state, env);
    const viewer = NotebookHandle.create_bootstrap("user:dev:bob/desktop:b");
    await syncMaterializerWithClient(
      materializer,
      {
        id: "peer-viewer",
        identity: authenticateDevRequest(
          new Request("https://cloud.test/n/demo/sync?user=bob&operator=desktop:b&scope=viewer"),
        ),
      },
      viewer,
    );

    assertInitialEmptyCodeCell(JSON.parse(viewer.get_cells_json()));
  });

  it("uses the latest published snapshot instead of stale revision checkpoints", async () => {
    const state = fakeState();
    const staleSnapshot = await createNotebookRoomSnapshot(
      "demo",
      "stale-cell",
      "Stale room checkpoint\n",
    );
    await Promise.all([
      state.storage.put(
        "room-host:notebook-doc",
        arrayBufferFromBytes(staleSnapshot.notebookBytes),
      ),
      state.storage.put(
        "room-host:runtime-state-doc",
        arrayBufferFromBytes(staleSnapshot.runtimeStateBytes),
      ),
      state.storage.put("room-host:checkpoint", {
        version: 4,
        notebook_heads: staleSnapshot.notebookHeads,
        runtime_state_heads: staleSnapshot.runtimeStateHeads,
        saved_at: "2026-05-27T00:00:00.000Z",
        published_revision_id: "revision-old",
        published_notebook_heads: staleSnapshot.notebookHeads,
        published_runtime_state_heads: staleSnapshot.runtimeStateHeads,
      }),
    ]);

    const publishedSnapshot = await createNotebookRoomSnapshot(
      "demo",
      "published-cell",
      "Published snapshot markdown\n",
    );
    const env = fakePublishedSnapshotEnv({
      notebookId: "demo",
      revisionId: "revision-new",
      actorLabel: "user:dev:publisher/agent:runt-publish",
      notebookBytes: publishedSnapshot.notebookBytes,
      runtimeStateBytes: publishedSnapshot.runtimeStateBytes,
    });

    const reloaded = new RoomMaterializer("demo", state, env);
    const viewer = NotebookHandle.create_bootstrap("user:dev:bob/desktop:b");
    await syncMaterializerWithClient(
      reloaded,
      {
        id: "peer-viewer",
        identity: authenticateDevRequest(
          new Request("https://cloud.test/n/demo/sync?user=bob&operator=desktop:b&scope=viewer"),
        ),
      },
      viewer,
    );

    const cells = JSON.parse(viewer.get_cells_json()) as Array<{ id: string; source: string }>;
    assert.deepEqual(
      cells.map((cell) => [cell.id, cell.source]),
      [["published-cell", "Published snapshot markdown\n"]],
    );
  });

  it("keeps checkpoints with unpublished changes when a newer revision exists", async () => {
    const state = fakeState();
    const seedSnapshot = await createNotebookRoomSnapshot(
      "demo",
      "edited-cell",
      "Original checkpoint seed\n",
    );
    const editedSnapshot = await createNotebookRoomSnapshot(
      "demo",
      "edited-cell",
      "Unpublished live edit\n",
    );
    await Promise.all([
      state.storage.put(
        "room-host:notebook-doc",
        arrayBufferFromBytes(editedSnapshot.notebookBytes),
      ),
      state.storage.put(
        "room-host:runtime-state-doc",
        arrayBufferFromBytes(editedSnapshot.runtimeStateBytes),
      ),
      state.storage.put("room-host:checkpoint", {
        version: 4,
        notebook_heads: editedSnapshot.notebookHeads,
        runtime_state_heads: editedSnapshot.runtimeStateHeads,
        saved_at: "2026-05-28T00:00:00.000Z",
        published_revision_id: "revision-old",
        published_notebook_heads: seedSnapshot.notebookHeads,
        published_runtime_state_heads: seedSnapshot.runtimeStateHeads,
      }),
    ]);

    const publishedSnapshot = await createNotebookRoomSnapshot(
      "demo",
      "published-cell",
      "Newer published snapshot\n",
    );
    const env = fakePublishedSnapshotEnv({
      notebookId: "demo",
      revisionId: "revision-new",
      actorLabel: "user:dev:publisher/agent:runt-publish",
      notebookBytes: publishedSnapshot.notebookBytes,
      runtimeStateBytes: publishedSnapshot.runtimeStateBytes,
    });

    const reloaded = new RoomMaterializer("demo", state, env);
    const viewer = NotebookHandle.create_bootstrap("user:dev:bob/desktop:b");
    await syncMaterializerWithClient(
      reloaded,
      {
        id: "peer-viewer",
        identity: authenticateDevRequest(
          new Request("https://cloud.test/n/demo/sync?user=bob&operator=desktop:b&scope=viewer"),
        ),
      },
      viewer,
    );

    const cells = JSON.parse(viewer.get_cells_json()) as Array<{ id: string; source: string }>;
    assert.deepEqual(
      cells.map((cell) => [cell.id, cell.source]),
      [["edited-cell", "Unpublished live edit\n"]],
    );
  });

  it("falls back to a valid checkpoint when published snapshot lookup fails", async () => {
    const state = fakeState();
    const checkpointSnapshot = await createNotebookRoomSnapshot(
      "demo",
      "checkpoint-cell",
      "Checkpoint survives catalog outage\n",
    );
    await Promise.all([
      state.storage.put(
        "room-host:notebook-doc",
        arrayBufferFromBytes(checkpointSnapshot.notebookBytes),
      ),
      state.storage.put(
        "room-host:runtime-state-doc",
        arrayBufferFromBytes(checkpointSnapshot.runtimeStateBytes),
      ),
      state.storage.put("room-host:checkpoint", {
        version: 4,
        notebook_heads: checkpointSnapshot.notebookHeads,
        runtime_state_heads: checkpointSnapshot.runtimeStateHeads,
        saved_at: "2026-05-28T00:00:00.000Z",
        published_revision_id: "revision-current",
        published_notebook_heads: checkpointSnapshot.notebookHeads,
        published_runtime_state_heads: checkpointSnapshot.runtimeStateHeads,
      }),
    ]);

    const env = failingPublishedSnapshotEnv();
    const reloaded = new RoomMaterializer("demo", state, env);
    const viewer = NotebookHandle.create_bootstrap("user:dev:bob/desktop:b");
    await syncMaterializerWithClient(
      reloaded,
      {
        id: "peer-viewer",
        identity: authenticateDevRequest(
          new Request("https://cloud.test/n/demo/sync?user=bob&operator=desktop:b&scope=viewer"),
        ),
      },
      viewer,
    );

    const cells = JSON.parse(viewer.get_cells_json()) as Array<{ id: string; source: string }>;
    assert.deepEqual(
      cells.map((cell) => [cell.id, cell.source]),
      [["checkpoint-cell", "Checkpoint survives catalog outage\n"]],
    );
  });

  it("keeps a checkpoint seeded from the current published revision", async () => {
    const state = fakeState();
    const checkpointSnapshot = await createNotebookRoomSnapshot(
      "demo",
      "edited-cell",
      "Live edited checkpoint\n",
    );
    const publishedSnapshot = await createNotebookRoomSnapshot(
      "demo",
      "published-cell",
      "Original published snapshot\n",
    );
    await Promise.all([
      state.storage.put(
        "room-host:notebook-doc",
        arrayBufferFromBytes(checkpointSnapshot.notebookBytes),
      ),
      state.storage.put(
        "room-host:runtime-state-doc",
        arrayBufferFromBytes(checkpointSnapshot.runtimeStateBytes),
      ),
      state.storage.put("room-host:checkpoint", {
        version: 4,
        notebook_heads: checkpointSnapshot.notebookHeads,
        runtime_state_heads: checkpointSnapshot.runtimeStateHeads,
        saved_at: "2026-05-28T00:00:00.000Z",
        published_revision_id: "revision-current",
        published_notebook_heads: publishedSnapshot.notebookHeads,
        published_runtime_state_heads: publishedSnapshot.runtimeStateHeads,
      }),
    ]);

    const env = fakePublishedSnapshotEnv({
      notebookId: "demo",
      revisionId: "revision-current",
      actorLabel: "user:dev:publisher/agent:runt-publish",
      notebookBytes: publishedSnapshot.notebookBytes,
      runtimeStateBytes: publishedSnapshot.runtimeStateBytes,
    });

    const reloaded = new RoomMaterializer("demo", state, env);
    const viewer = NotebookHandle.create_bootstrap("user:dev:bob/desktop:b");
    await syncMaterializerWithClient(
      reloaded,
      {
        id: "peer-viewer",
        identity: authenticateDevRequest(
          new Request("https://cloud.test/n/demo/sync?user=bob&operator=desktop:b&scope=viewer"),
        ),
      },
      viewer,
    );

    const cells = JSON.parse(viewer.get_cells_json()) as Array<{ id: string; source: string }>;
    assert.deepEqual(
      cells.map((cell) => [cell.id, cell.source]),
      [["edited-cell", "Live edited checkpoint\n"]],
    );
  });

  it("recovers from a checkpoint host that fails initial peer sync", async () => {
    const state = fakeState();
    const checkpointSnapshot = await createNotebookRoomSnapshot(
      "demo",
      "checkpoint-cell",
      "Unreachable checkpoint edit\n",
    );
    const publishedSnapshot = await createNotebookRoomSnapshot(
      "demo",
      "published-cell",
      "Recovered published snapshot\n",
    );
    await Promise.all([
      state.storage.put(
        "room-host:notebook-doc",
        arrayBufferFromBytes(checkpointSnapshot.notebookBytes),
      ),
      state.storage.put(
        "room-host:runtime-state-doc",
        arrayBufferFromBytes(checkpointSnapshot.runtimeStateBytes),
      ),
      state.storage.put("room-host:checkpoint", {
        version: 4,
        notebook_heads: checkpointSnapshot.notebookHeads,
        runtime_state_heads: checkpointSnapshot.runtimeStateHeads,
        saved_at: "2026-05-28T00:00:00.000Z",
        published_revision_id: "revision-current",
        published_notebook_heads: publishedSnapshot.notebookHeads,
        published_runtime_state_heads: publishedSnapshot.runtimeStateHeads,
      }),
    ]);

    const env = fakePublishedSnapshotEnv({
      notebookId: "demo",
      revisionId: "revision-current",
      actorLabel: "user:dev:publisher/agent:runt-publish",
      notebookBytes: publishedSnapshot.notebookBytes,
      runtimeStateBytes: publishedSnapshot.runtimeStateBytes,
    });

    const reloaded = new RoomMaterializer("demo", state, env);
    const checkpointHost = await (
      reloaded as unknown as {
        loadHost(): Promise<{ sync_peer: (peerId: string, connectionScope: string) => unknown }>;
      }
    ).loadHost();
    checkpointHost.sync_peer = () => {
      throw new Error("recursive use of an object detected which would lead to unsafe aliasing");
    };

    const viewer = NotebookHandle.create_bootstrap("user:dev:bob/desktop:b");
    await syncMaterializerWithClient(
      reloaded,
      {
        id: "peer-viewer",
        identity: authenticateDevRequest(
          new Request("https://cloud.test/n/demo/sync?user=bob&operator=desktop:b&scope=viewer"),
        ),
      },
      viewer,
    );

    const cells = JSON.parse(viewer.get_cells_json()) as Array<{ id: string; source: string }>;
    assert.deepEqual(
      cells.map((cell) => [cell.id, cell.source]),
      [["published-cell", "Recovered published snapshot\n"]],
    );
    assert.deepEqual([...(await state.storage.list({ prefix: "room-host:" })).keys()], []);
  });

  it("rejects runtime peer execution creation over runtime-state sync", async () => {
    const state = fakeState();
    const materializer = new RoomMaterializer("demo", state, {} as Env);
    const runtimeIdentity = authenticateDevRequest(
      new Request(
        "https://cloud.test/n/demo/sync?user=runtime&operator=runtime:py&scope=runtime_peer",
      ),
    );
    const runtimePeerConnection = { id: "peer-runtime", identity: runtimeIdentity };
    const runtimePeer = new RuntimeStatePeerHandle(runtimeIdentity.actorLabel);
    await syncMaterializerWithRuntimePeer(materializer, runtimePeerConnection, runtimePeer);
    runtimePeer.cancel_last_runtime_state_flush();
    runtimePeer.create_execution_with_source("exec-runtime", "print('runtime')", 0);
    await assert.rejects(
      () => applyRuntimePeerChangesToMaterializer(materializer, runtimePeerConnection, runtimePeer),
      /executions/,
    );
  });

  it("publishes host-owned workstation attachment over runtime-state sync", async () => {
    const state = fakeState();
    const materializer = new RoomMaterializer("demo", state, {} as Env);
    const viewerIdentity = authenticateDevRequest(
      new Request("https://cloud.test/n/demo/sync?user=bob&operator=desktop:b&scope=viewer"),
    );
    const viewerPeer = { id: "peer-viewer", identity: viewerIdentity };
    const viewer = NotebookHandle.create_bootstrap(viewerIdentity.actorLabel);
    await syncMaterializerRuntimeStateWithClient(materializer, viewerPeer, viewer);

    const attachment = {
      workstation_id: "runtime-peer",
      display_name: "Attached workstation",
      provider: "runtime_peer",
      default_environment_label: "Current Python",
      environment_policy: "runtime_peer",
      status: "ready",
      status_message: null,
      cpu_count: null,
      memory_bytes: null,
      working_directory: null,
      updated_at: "2026-06-07T00:00:00.000Z",
    };
    const result = await materializer.setWorkstationAttachment(attachment);

    assert.equal(result.changed, true);
    assert.equal(result.runtime_state_changed, true);
    assert.ok(
      result.outbound.some(
        (frame) =>
          frame.peer_id === viewerPeer.id && frame.frame_type === FrameType.RUNTIME_STATE_SYNC,
      ),
      "attachment changes are broadcast through RuntimeStateDoc sync",
    );
    applyRuntimeOutboundToClient(result.outbound, viewerPeer.id, viewer);
    const runtimeState = viewer.get_runtime_state() as {
      workstation?: { workstation_id?: string; status?: string } | null;
    };
    assert.equal(runtimeState.workstation?.workstation_id, "runtime-peer");
    assert.equal(runtimeState.workstation?.status, "ready");

    const again = await materializer.setWorkstationAttachment(attachment);
    assert.equal(again.changed, false, "same attachment is idempotent");
    assert.deepEqual(again.outbound, []);
  });

  it("allows owner-scoped CommsDoc changes to existing runtime comm topology", async () => {
    const state = fakeState();
    const materializer = new RoomMaterializer("demo", state, {} as Env);
    const runtimeIdentity = authenticateDevRequest(
      new Request(
        "https://cloud.test/n/demo/sync?user=runtime&operator=runtime:py&scope=runtime_peer",
      ),
    );
    const runtimePeerConnection = { id: "peer-runtime", identity: runtimeIdentity };
    const runtimePeer = new RuntimeStatePeerHandle(runtimeIdentity.actorLabel);
    await syncMaterializerWithRuntimePeer(materializer, runtimePeerConnection, runtimePeer);
    runtimePeer.put_comm_json(
      "comm-widget",
      "jupyter.widget",
      "anywidget",
      "AnyModel",
      JSON.stringify({ value: 1, label: "before" }),
      0,
    );
    const topologyAccepted = await applyRuntimePeerChangesToMaterializer(
      materializer,
      runtimePeerConnection,
      runtimePeer,
    );
    assert.equal(topologyAccepted.changed, true);
    assert.equal(topologyAccepted.runtime_state_changed, true);
    const initialStateAccepted = await applyCommsPeerChangesToMaterializer(
      materializer,
      runtimePeerConnection,
      runtimePeer,
    );
    assert.equal(initialStateAccepted.changed, true);

    const ownerIdentity = authenticateDevRequest(
      new Request("https://cloud.test/n/demo/sync?user=alice&operator=desktop:a&scope=owner"),
    );
    const ownerPeerConnection = { id: "peer-owner", identity: ownerIdentity };
    const owner = NotebookHandle.create_bootstrap(ownerIdentity.actorLabel);
    await syncMaterializerRuntimeStateWithClient(materializer, ownerPeerConnection, owner);
    await syncMaterializerCommsDocWithClient(materializer, ownerPeerConnection, owner);
    assert.equal(owner.set_comm_state_property("comm-widget", "value", JSON.stringify(2)), true);
    const accepted = await applyCommsClientChangesToMaterializer(
      materializer,
      ownerPeerConnection,
      owner,
    );
    assert.equal(accepted.changed, true);
    assert.equal(accepted.runtime_state_changed, false);

    const viewerIdentity = authenticateDevRequest(
      new Request("https://cloud.test/n/demo/sync?user=carol&operator=desktop:c&scope=viewer"),
    );
    const viewer = NotebookHandle.create_bootstrap(viewerIdentity.actorLabel);
    viewer.set_blob_port(1234);
    await syncMaterializerRuntimeStateWithClient(
      materializer,
      { id: "peer-viewer", identity: viewerIdentity },
      viewer,
    );
    await syncMaterializerCommsDocWithClient(
      materializer,
      { id: "peer-viewer", identity: viewerIdentity },
      viewer,
    );
    const runtimeState = viewer.get_runtime_state() as {
      comms: Record<string, { state: Record<string, unknown> }>;
    };
    assert.deepEqual(runtimeState.comms["comm-widget"].state, {});
    const resolved = viewer.resolve_comm_state("comm-widget") as {
      state?: Record<string, unknown>;
    };
    assert.equal(resolved.state?.value, 2);
  });

  it("allows loaded owner handles to author CommsDoc changes with the connection actor", async () => {
    const state = fakeState();
    const materializer = new RoomMaterializer("demo", state, {} as Env);
    const runtimeIdentity = authenticateDevRequest(
      new Request(
        "https://cloud.test/n/demo/sync?user=runtime&operator=runtime:py&scope=runtime_peer",
      ),
    );
    const runtimePeerConnection = { id: "peer-runtime", identity: runtimeIdentity };
    const runtimePeer = new RuntimeStatePeerHandle(runtimeIdentity.actorLabel);
    await syncMaterializerWithRuntimePeer(materializer, runtimePeerConnection, runtimePeer);
    runtimePeer.put_comm_json(
      "comm-widget",
      "jupyter.widget",
      "@jupyter-widgets/controls",
      "IntSliderModel",
      JSON.stringify({ value: 7, description: "probe" }),
      0,
    );
    assert.equal(
      (
        await applyRuntimePeerChangesToMaterializer(
          materializer,
          runtimePeerConnection,
          runtimePeer,
        )
      ).changed,
      true,
    );
    assert.equal(
      (await applyCommsPeerChangesToMaterializer(materializer, runtimePeerConnection, runtimePeer))
        .changed,
      true,
    );

    const ownerIdentity = authenticateDevRequest(
      new Request("https://cloud.test/n/demo/sync?user=alice&operator=browser:a&scope=owner"),
    );
    const ownerPeerConnection = { id: "peer-owner", identity: ownerIdentity };
    const loadedOwner = NotebookHandle.load(
      NotebookHandle.create_bootstrap("user:dev:seed/browser:seed").save(),
    );
    loadedOwner.set_actor(ownerIdentity.actorLabel);
    await syncMaterializerRuntimeStateWithClient(materializer, ownerPeerConnection, loadedOwner);
    await syncMaterializerCommsDocWithClient(materializer, ownerPeerConnection, loadedOwner);

    assert.equal(
      loadedOwner.set_comm_state_property("comm-widget", "value", JSON.stringify(11)),
      true,
    );
    const accepted = await applyCommsClientChangesToMaterializer(
      materializer,
      ownerPeerConnection,
      loadedOwner,
    );
    assert.equal(
      accepted.changed,
      true,
      "loaded browser handles must not author CommsDoc changes with a raw random actor id",
    );
  });

  it("fans out owner CommsDoc changes to already-open peers", async () => {
    const state = fakeState();
    const materializer = new RoomMaterializer("demo", state, {} as Env);
    const runtimeIdentity = authenticateDevRequest(
      new Request(
        "https://cloud.test/n/demo/sync?user=runtime&operator=runtime:py&scope=runtime_peer",
      ),
    );
    const runtimePeerConnection = { id: "peer-runtime", identity: runtimeIdentity };
    const runtimePeer = new RuntimeStatePeerHandle(runtimeIdentity.actorLabel);
    await syncMaterializerWithRuntimePeer(materializer, runtimePeerConnection, runtimePeer);
    runtimePeer.put_comm_json(
      "comm-widget",
      "jupyter.widget",
      "anywidget",
      "AnyModel",
      JSON.stringify({ value: 7 }),
      0,
    );
    const topologyAccepted = await applyRuntimePeerChangesToMaterializer(
      materializer,
      runtimePeerConnection,
      runtimePeer,
    );
    assert.equal(topologyAccepted.changed, true);
    const initialStateAccepted = await applyCommsPeerChangesToMaterializer(
      materializer,
      runtimePeerConnection,
      runtimePeer,
    );
    assert.equal(initialStateAccepted.changed, true);

    const ownerAIdentity = authenticateDevRequest(
      new Request("https://cloud.test/n/demo/sync?user=alice&operator=browser:a&scope=owner"),
    );
    const ownerBIdentity = authenticateDevRequest(
      new Request("https://cloud.test/n/demo/sync?user=alice&operator=browser:b&scope=owner"),
    );
    const ownerAConnection = { id: "peer-owner-a", identity: ownerAIdentity };
    const ownerBConnection = { id: "peer-owner-b", identity: ownerBIdentity };
    const ownerA = NotebookHandle.create_bootstrap(ownerAIdentity.actorLabel);
    const ownerB = NotebookHandle.create_bootstrap(ownerBIdentity.actorLabel);
    ownerA.set_blob_port(1234);
    ownerB.set_blob_port(1234);
    await syncMaterializerRuntimeStateWithClient(materializer, ownerAConnection, ownerA);
    await syncMaterializerCommsDocWithClient(materializer, ownerAConnection, ownerA);
    await syncMaterializerRuntimeStateWithClient(materializer, ownerBConnection, ownerB);
    await syncMaterializerCommsDocWithClient(materializer, ownerBConnection, ownerB);
    assert.equal(
      (ownerB.resolve_comm_state("comm-widget") as { state?: Record<string, unknown> }).state
        ?.value,
      7,
      "second open owner starts from the persisted widget value",
    );

    assert.equal(ownerA.set_comm_state_property("comm-widget", "value", JSON.stringify(8)), true);
    const accepted = await applyCommsClientChangesToMaterializer(
      materializer,
      ownerAConnection,
      ownerA,
    );
    assert.equal(accepted.changed, true);
    assert.ok(
      accepted.outbound.some(
        (frame) =>
          frame.peer_id === ownerBConnection.id && frame.frame_type === FrameType.COMMS_DOC_SYNC,
      ),
      "CommsDoc mutation from one open owner is fanned out to the other open owner",
    );

    applyCommsOutboundToClient(accepted.outbound, ownerBConnection.id, ownerB);
    assert.equal(
      (ownerB.resolve_comm_state("comm-widget") as { state?: Record<string, unknown> }).state
        ?.value,
      8,
    );
  });

  it("rejects owner-scoped RuntimeStateDoc execution changes", async () => {
    const state = fakeState();
    const materializer = new RoomMaterializer("demo", state, {} as Env);
    const runtimeIdentity = authenticateDevRequest(
      new Request(
        "https://cloud.test/n/demo/sync?user=alice&operator=runtime:py&scope=runtime_peer",
      ),
    );
    const runtimePeerConnection = { id: "peer-runtime-owner-principal", identity: runtimeIdentity };
    const runtimePeer = new RuntimeStatePeerHandle(runtimeIdentity.actorLabel);
    await syncMaterializerWithRuntimePeer(materializer, runtimePeerConnection, runtimePeer);
    runtimePeer.create_execution_with_source("exec-owner-forged", "print('owner')", 0);
    const runtimeMessage = runtimePeer.flush_runtime_state_sync();
    assert.ok(runtimeMessage);

    const ownerIdentity = authenticateDevRequest(
      new Request("https://cloud.test/n/demo/sync?user=alice&operator=desktop:a&scope=owner"),
    );
    const ownerPeerConnection = { id: "peer-owner", identity: ownerIdentity };

    await assert.rejects(
      () =>
        materializer.receiveFrame(ownerPeerConnection, {
          type: FrameType.RUNTIME_STATE_SYNC,
          payload: runtimeMessage,
        }),
      /RuntimeStateDoc/,
    );
  });
});

function syncHostWithClient(
  host: Awaited<ReturnType<typeof createEmptyRoomHost>>,
  peerId: string,
  principal: string,
  canWrite: boolean,
  canWriteAllNotebookChanges: boolean,
  client: NotebookHandle,
): void {
  const scope = notebookScopeFor(canWrite, canWriteAllNotebookChanges);
  let result = host.sync_peer(peerId, scope) as {
    outbound: Array<{ peer_id: string; frame_type: FrameTypeValue; payload: number[] }>;
  };
  for (let round = 0; round < 8; round += 1) {
    const replies = applyOutboundToClient(result.outbound, peerId, client);
    if (replies.length === 0) {
      return;
    }
    const outbound: Array<{ peer_id: string; frame_type: FrameTypeValue; payload: number[] }> = [];
    for (const reply of replies) {
      const next = host.receive_peer_frame(
        peerId,
        principal,
        `${principal}/test`,
        scope,
        canWriteAllNotebookChanges,
        reply,
      ) as {
        outbound: Array<{ peer_id: string; frame_type: FrameTypeValue; payload: number[] }>;
      };
      outbound.push(...next.outbound);
    }
    result = { outbound };
  }
}

function applyClientChangesToHost(
  host: Awaited<ReturnType<typeof createEmptyRoomHost>>,
  peerId: string,
  principal: string,
  canWrite: boolean,
  canWriteAllNotebookChanges: boolean,
  client: NotebookHandle,
): void {
  const scope = notebookScopeFor(canWrite, canWriteAllNotebookChanges);
  const message = client.flush_local_changes();
  assert.ok(message);
  host.receive_peer_frame(
    peerId,
    principal,
    `${principal}/test`,
    scope,
    canWriteAllNotebookChanges,
    encodeTypedFrame(FrameType.AUTOMERGE_SYNC, message),
  );
}

async function syncMaterializerWithClient(
  materializer: RoomMaterializer,
  peer: { id: string; identity: ReturnType<typeof authenticateDevRequest> },
  client: NotebookHandle,
): Promise<void> {
  let result = await materializer.syncPeer(peer);
  for (let round = 0; round < 8; round += 1) {
    const replies = applyOutboundToClient(result.outbound, peer.id, client);
    if (replies.length === 0) {
      return;
    }
    const outbound = [];
    for (const reply of replies) {
      const next = await materializer.receiveFrame(peer, {
        type: FrameType.AUTOMERGE_SYNC,
        payload: reply.slice(1),
      });
      outbound.push(...next.outbound);
    }
    result = {
      changed: false,
      notebook_changed: false,
      runtime_state_changed: false,
      outbound,
    };
  }
}

async function applyCommsClientChangesToMaterializer(
  materializer: RoomMaterializer,
  peer: { id: string; identity: ReturnType<typeof authenticateDevRequest> },
  client: NotebookHandle,
) {
  const message = client.flush_comms_doc_sync();
  assert.ok(message);
  let result = await materializer.receiveFrame(peer, {
    type: FrameType.COMMS_DOC_SYNC,
    payload: message,
  });

  for (let round = 0; round < 8 && !result.changed; round += 1) {
    const replies = applyCommsOutboundToClient(result.outbound, peer.id, client);
    if (replies.length === 0) {
      break;
    }
    const outbound = [];
    for (const reply of replies) {
      const next = await materializer.receiveFrame(peer, {
        type: FrameType.COMMS_DOC_SYNC,
        payload: reply.slice(1),
      });
      if (next.changed) {
        result = next;
      }
      outbound.push(...next.outbound);
    }
    if (!result.changed) {
      result = {
        changed: false,
        notebook_changed: false,
        runtime_state_changed: false,
        outbound,
      };
    }
  }

  return result;
}

async function applyRuntimePeerChangesToMaterializer(
  materializer: RoomMaterializer,
  peer: { id: string; identity: ReturnType<typeof authenticateDevRequest> },
  runtime: RuntimeStatePeerHandle,
) {
  const message = runtime.flush_runtime_state_sync();
  assert.ok(message);
  let result = await materializer.receiveFrame(peer, {
    type: FrameType.RUNTIME_STATE_SYNC,
    payload: message,
  });

  for (let round = 0; round < 8 && !result.changed; round += 1) {
    const replies = applyRuntimeOutboundToRuntimePeer(result.outbound, peer.id, runtime);
    if (replies.length === 0) {
      break;
    }
    const outbound = [];
    for (const reply of replies) {
      const next = await materializer.receiveFrame(peer, {
        type: FrameType.RUNTIME_STATE_SYNC,
        payload: reply.slice(1),
      });
      if (next.changed) {
        result = next;
      }
      outbound.push(...next.outbound);
    }
    if (!result.changed) {
      result = {
        changed: false,
        notebook_changed: false,
        runtime_state_changed: false,
        outbound,
      };
    }
  }

  return result;
}

async function applyCommsPeerChangesToMaterializer(
  materializer: RoomMaterializer,
  peer: { id: string; identity: ReturnType<typeof authenticateDevRequest> },
  runtime: RuntimeStatePeerHandle,
) {
  const message = runtime.flush_comms_doc_sync();
  assert.ok(message);
  let result = await materializer.receiveFrame(peer, {
    type: FrameType.COMMS_DOC_SYNC,
    payload: message,
  });

  for (let round = 0; round < 8 && !result.changed; round += 1) {
    const replies = applyCommsOutboundToRuntimePeer(result.outbound, peer.id, runtime);
    if (replies.length === 0) {
      break;
    }
    const outbound = [];
    for (const reply of replies) {
      const next = await materializer.receiveFrame(peer, {
        type: FrameType.COMMS_DOC_SYNC,
        payload: reply.slice(1),
      });
      if (next.changed) {
        result = next;
      }
      outbound.push(...next.outbound);
    }
    if (!result.changed) {
      result = {
        changed: false,
        notebook_changed: false,
        runtime_state_changed: false,
        outbound,
      };
    }
  }

  return result;
}

async function createRoomHostWithAcceptedExecution(
  notebookId: string,
  executionId: string,
  source: string,
) {
  const seedHost = await createEmptyRoomHost(notebookId, "system/schema:notebook-cloud-room");
  const runtimeSeed = new RuntimeStatePeerHandle("system/schema:notebook-cloud-room");
  runtimeSeed.create_execution_with_source(executionId, source, 0);
  return loadRoomHostSnapshot(seedHost.save_notebook(), runtimeSeed.save());
}

async function createNotebookRoomSnapshot(
  notebookId: string,
  cellId: string,
  source: string,
): Promise<{
  notebookBytes: Uint8Array;
  runtimeStateBytes: Uint8Array;
  notebookHeads: string[];
  runtimeStateHeads: string[];
}> {
  const host = await createEmptyRoomHost(notebookId, "system/schema:notebook-cloud-room");
  const owner = NotebookHandle.create_bootstrap("user:dev:publisher/agent:runt-publish");
  syncHostWithClient(host, "peer-owner", "user:dev:publisher", true, true, owner);
  owner.add_cell(0, cellId, "markdown");
  owner.update_source(cellId, source);
  applyClientChangesToHost(host, "peer-owner", "user:dev:publisher", true, true, owner);
  return {
    notebookBytes: host.save_notebook(),
    runtimeStateBytes: host.save_runtime_state_doc(),
    notebookHeads: Array.from(host.get_heads_hex()),
    runtimeStateHeads: Array.from(host.get_runtime_state_heads_hex()),
  };
}

function assertInitialEmptyCodeCell(cells: unknown): void {
  assert.ok(Array.isArray(cells), "expected cells array");
  assert.equal(cells.length, 1);
  const [cell] = cells as Array<{
    id?: unknown;
    cell_type?: unknown;
    source?: unknown;
  }>;
  if (typeof cell.id !== "string") {
    assert.fail("expected seeded cell id to be a string");
  }
  const cellId: string = cell.id;
  assert.match(cellId, /^cell-/);
  assert.equal(cell.cell_type, "code");
  assert.equal(cell.source, "");
}

async function syncMaterializerWithRuntimePeer(
  materializer: RoomMaterializer,
  peer: { id: string; identity: ReturnType<typeof authenticateDevRequest> },
  runtime: RuntimeStatePeerHandle,
): Promise<void> {
  let result = await materializer.syncPeer(peer);
  for (let round = 0; round < 8; round += 1) {
    const replies = applyRuntimeOutboundToRuntimePeer(result.outbound, peer.id, runtime);
    if (replies.length === 0) {
      return;
    }
    const outbound = [];
    for (const reply of replies) {
      const next = await materializer.receiveFrame(peer, {
        type: FrameType.RUNTIME_STATE_SYNC,
        payload: reply.slice(1),
      });
      outbound.push(...next.outbound);
    }
    result = {
      changed: false,
      notebook_changed: false,
      runtime_state_changed: false,
      outbound,
    };
  }
}

async function syncMaterializerRuntimeStateWithClient(
  materializer: RoomMaterializer,
  peer: { id: string; identity: ReturnType<typeof authenticateDevRequest> },
  client: NotebookHandle,
): Promise<void> {
  const outbound = [];
  const initial = client.flush_runtime_state_sync();
  if (initial) {
    const reply = await materializer.receiveFrame(peer, {
      type: FrameType.RUNTIME_STATE_SYNC,
      payload: initial,
    });
    outbound.push(...reply.outbound);
  }

  const hostSync = await materializer.syncPeer(peer);
  outbound.push(...hostSync.outbound);
  let result = { ...hostSync, outbound };
  for (let round = 0; round < 8; round += 1) {
    const replies = applyRuntimeOutboundToClient(result.outbound, peer.id, client);
    if (replies.length === 0) {
      return;
    }
    const outbound = [];
    for (const reply of replies) {
      const next = await materializer.receiveFrame(peer, {
        type: FrameType.RUNTIME_STATE_SYNC,
        payload: reply.slice(1),
      });
      outbound.push(...next.outbound);
    }
    result = {
      changed: false,
      notebook_changed: false,
      runtime_state_changed: false,
      outbound,
    };
  }
}

async function syncMaterializerCommsDocWithClient(
  materializer: RoomMaterializer,
  peer: { id: string; identity: ReturnType<typeof authenticateDevRequest> },
  client: NotebookHandle,
): Promise<void> {
  const outbound = [];
  const initial = client.flush_comms_doc_sync();
  if (initial) {
    const reply = await materializer.receiveFrame(peer, {
      type: FrameType.COMMS_DOC_SYNC,
      payload: initial,
    });
    outbound.push(...reply.outbound);
  }

  const hostSync = await materializer.syncPeer(peer);
  outbound.push(...hostSync.outbound);
  let result = { ...hostSync, outbound };
  for (let round = 0; round < 8; round += 1) {
    const replies = applyCommsOutboundToClient(result.outbound, peer.id, client);
    if (replies.length === 0) {
      return;
    }
    const outbound = [];
    for (const reply of replies) {
      const next = await materializer.receiveFrame(peer, {
        type: FrameType.COMMS_DOC_SYNC,
        payload: reply.slice(1),
      });
      outbound.push(...next.outbound);
    }
    result = {
      changed: false,
      notebook_changed: false,
      runtime_state_changed: false,
      outbound,
    };
  }
}

function applyOutboundToClient(
  outbound: Array<{ peer_id: string; frame_type: FrameTypeValue; payload: Uint8Array | number[] }>,
  peerId: string,
  client: NotebookHandle,
): Uint8Array[] {
  const replies: Uint8Array[] = [];
  for (const frame of outbound) {
    if (frame.peer_id !== peerId || frame.frame_type !== FrameType.AUTOMERGE_SYNC) {
      continue;
    }
    const events = client.receive_frame(
      encodeTypedFrame(frame.frame_type, new Uint8Array(frame.payload)),
    ) as Array<{ type: string; reply?: number[] }>;
    for (const event of events ?? []) {
      if (event.type === "sync_applied" && event.reply) {
        replies.push(encodeTypedFrame(FrameType.AUTOMERGE_SYNC, new Uint8Array(event.reply)));
      }
    }
  }
  return replies;
}

function syncRuntimeHostWithClient(
  host: Awaited<ReturnType<typeof createEmptyRoomHost>>,
  peerId: string,
  principal: string,
  canWrite: boolean,
  canWriteAllNotebookChanges: boolean,
  client: NotebookHandle,
): void {
  const scope = runtimeScopeFor(canWrite);
  const outbound: Array<{ peer_id: string; frame_type: FrameTypeValue; payload: number[] }> = [];
  const initial = client.flush_runtime_state_sync();
  if (initial) {
    const reply = host.receive_peer_frame(
      peerId,
      principal,
      `${principal}/test`,
      scope,
      canWriteAllNotebookChanges,
      encodeTypedFrame(FrameType.RUNTIME_STATE_SYNC, initial),
    ) as {
      outbound: Array<{ peer_id: string; frame_type: FrameTypeValue; payload: number[] }>;
    };
    outbound.push(...reply.outbound);
  }

  const hostSync = host.sync_peer(peerId, scope) as {
    outbound: Array<{ peer_id: string; frame_type: FrameTypeValue; payload: number[] }>;
  };
  outbound.push(...hostSync.outbound);
  let result = { outbound };
  for (let round = 0; round < 8; round += 1) {
    const replies = applyRuntimeOutboundToClient(result.outbound, peerId, client);
    if (replies.length === 0) {
      return;
    }
    const outbound: Array<{ peer_id: string; frame_type: FrameTypeValue; payload: number[] }> = [];
    for (const reply of replies) {
      const next = host.receive_peer_frame(
        peerId,
        principal,
        `${principal}/test`,
        scope,
        canWriteAllNotebookChanges,
        reply,
      ) as {
        outbound: Array<{ peer_id: string; frame_type: FrameTypeValue; payload: number[] }>;
      };
      outbound.push(...next.outbound);
    }
    result = { outbound };
  }
}

function syncRuntimeHostWithRuntimePeer(
  host: Awaited<ReturnType<typeof createEmptyRoomHost>>,
  peerId: string,
  principal: string,
  scope: TestConnectionScope,
  canWriteAllNotebookChanges: boolean,
  runtime: RuntimeStatePeerHandle,
): void {
  let result = host.sync_peer(peerId, scope) as {
    outbound: Array<{ peer_id: string; frame_type: FrameTypeValue; payload: number[] }>;
  };
  for (let round = 0; round < 8; round += 1) {
    const replies = applyRuntimeOutboundToRuntimePeer(result.outbound, peerId, runtime);
    if (replies.length === 0) {
      return;
    }
    const outbound: Array<{ peer_id: string; frame_type: FrameTypeValue; payload: number[] }> = [];
    for (const reply of replies) {
      const next = host.receive_peer_frame(
        peerId,
        principal,
        `${principal}/test`,
        scope,
        canWriteAllNotebookChanges,
        reply,
      ) as {
        outbound: Array<{ peer_id: string; frame_type: FrameTypeValue; payload: number[] }>;
      };
      outbound.push(...next.outbound);
    }
    result = { outbound };
  }
}

function notebookScopeFor(
  canWrite: boolean,
  canWriteAllNotebookChanges: boolean,
): TestConnectionScope {
  if (!canWrite) {
    return "viewer";
  }
  return canWriteAllNotebookChanges ? "owner" : "editor";
}

function runtimeScopeFor(canWrite: boolean): TestConnectionScope {
  return canWrite ? "runtime_peer" : "viewer";
}

function applyRuntimeOutboundToClient(
  outbound: Array<{ peer_id: string; frame_type: FrameTypeValue; payload: Uint8Array | number[] }>,
  peerId: string,
  client: NotebookHandle,
): Uint8Array[] {
  const replies: Uint8Array[] = [];
  for (const frame of outbound) {
    if (frame.peer_id !== peerId || frame.frame_type !== FrameType.RUNTIME_STATE_SYNC) {
      continue;
    }
    const events = client.receive_frame(
      encodeTypedFrame(frame.frame_type, new Uint8Array(frame.payload)),
    ) as Array<{ type: string; reply?: number[] }>;
    let sawRuntimeStateSync = false;
    for (const event of events ?? []) {
      if (
        event.type === "runtime_state_sync_applied" ||
        event.type === "runtime_state_sync_error"
      ) {
        sawRuntimeStateSync = true;
      }
      if (event.reply) {
        replies.push(encodeTypedFrame(FrameType.RUNTIME_STATE_SYNC, new Uint8Array(event.reply)));
      }
    }
    if (sawRuntimeStateSync) {
      const reply = client.generate_runtime_state_sync_reply();
      if (reply) {
        replies.push(encodeTypedFrame(FrameType.RUNTIME_STATE_SYNC, reply));
      }
    }
  }
  return replies;
}

function applyCommsOutboundToClient(
  outbound: Array<{ peer_id: string; frame_type: FrameTypeValue; payload: Uint8Array | number[] }>,
  peerId: string,
  client: NotebookHandle,
): Uint8Array[] {
  const replies: Uint8Array[] = [];
  for (const frame of outbound) {
    if (frame.peer_id !== peerId || frame.frame_type !== FrameType.COMMS_DOC_SYNC) {
      continue;
    }
    const events = client.receive_frame(
      encodeTypedFrame(frame.frame_type, new Uint8Array(frame.payload)),
    ) as Array<{ type: string; reply?: number[] }>;
    let sawCommsDocSync = false;
    for (const event of events ?? []) {
      if (event.type === "comms_doc_sync_applied" || event.type === "comms_doc_sync_error") {
        sawCommsDocSync = true;
      }
      if (event.reply) {
        replies.push(encodeTypedFrame(FrameType.COMMS_DOC_SYNC, new Uint8Array(event.reply)));
      }
    }
    if (sawCommsDocSync) {
      const reply = client.generate_comms_doc_sync_reply();
      if (reply) {
        replies.push(encodeTypedFrame(FrameType.COMMS_DOC_SYNC, reply));
      }
    }
  }
  return replies;
}

function applyRuntimeOutboundToRuntimePeer(
  outbound: Array<{ peer_id: string; frame_type: FrameTypeValue; payload: Uint8Array | number[] }>,
  peerId: string,
  runtime: RuntimeStatePeerHandle,
): Uint8Array[] {
  const replies: Uint8Array[] = [];
  for (const frame of outbound) {
    if (frame.peer_id !== peerId || frame.frame_type !== FrameType.RUNTIME_STATE_SYNC) {
      continue;
    }
    const event = runtime.receive_frame(
      encodeTypedFrame(frame.frame_type, new Uint8Array(frame.payload)),
    ) as { reply?: number[] };
    if (event.reply) {
      replies.push(encodeTypedFrame(FrameType.RUNTIME_STATE_SYNC, new Uint8Array(event.reply)));
    }
  }
  return replies;
}

function applyCommsOutboundToRuntimePeer(
  outbound: Array<{ peer_id: string; frame_type: FrameTypeValue; payload: Uint8Array | number[] }>,
  peerId: string,
  runtime: RuntimeStatePeerHandle,
): Uint8Array[] {
  const replies: Uint8Array[] = [];
  for (const frame of outbound) {
    if (frame.peer_id !== peerId || frame.frame_type !== FrameType.COMMS_DOC_SYNC) {
      continue;
    }
    const event = runtime.receive_frame(
      encodeTypedFrame(frame.frame_type, new Uint8Array(frame.payload)),
    ) as { reply?: number[] };
    if (event.reply) {
      replies.push(encodeTypedFrame(FrameType.COMMS_DOC_SYNC, new Uint8Array(event.reply)));
    }
  }
  return replies;
}

function fakeState(): DurableObjectState {
  const values = new Map<string, unknown>();
  return {
    id: { toString: () => "room-id" },
    storage: {
      get: async <T>(key: string) => values.get(key) as T | undefined,
      put: async <T>(key: string, value: T) => {
        values.set(key, value);
      },
      delete: async (key: string) => values.delete(key),
      list: async <T>(options?: { prefix?: string }) => {
        const entries = [...values.entries()].filter(
          ([key]) => !options?.prefix || key.startsWith(options.prefix),
        );
        return new Map(entries) as Map<string, T>;
      },
    },
    waitUntil: () => undefined,
  };
}

function fakePublishedSnapshotEnv(input: {
  notebookId: string;
  revisionId: string;
  actorLabel: string;
  notebookBytes: Uint8Array;
  runtimeStateBytes: Uint8Array;
  runtimeStateDocId?: string | null;
}): Env {
  const snapshotKey = "test:notebook-snapshot";
  const runtimeSnapshotKey = "test:runtime-state-snapshot";
  const bucket = new FakeR2Bucket();
  bucket.objects.set(snapshotKey, arrayBufferFromBytes(input.notebookBytes));
  bucket.objects.set(runtimeSnapshotKey, arrayBufferFromBytes(input.runtimeStateBytes));
  return {
    DB: new FakeCatalogD1({
      notebook: {
        id: input.notebookId,
        owner_principal: "user:dev:publisher",
        title: null,
        created_at: "2026-05-28T00:00:00.000Z",
        updated_at: "2026-05-28T00:00:00.000Z",
        latest_revision_id: input.revisionId,
      },
      revision: {
        id: input.revisionId,
        notebook_id: input.notebookId,
        runtime_state_doc_id: Object.hasOwn(input, "runtimeStateDocId")
          ? (input.runtimeStateDocId ?? null)
          : `runtime:${input.notebookId}`,
        notebook_heads_hash: "heads-published",
        runtime_heads_hash: "runtime-published",
        comms_heads_hash: null,
        snapshot_key: snapshotKey,
        runtime_snapshot_key: runtimeSnapshotKey,
        comms_snapshot_key: null,
        actor_label: input.actorLabel,
        created_at: "2026-05-28T00:00:00.000Z",
      },
    }),
    NOTEBOOK_SNAPSHOTS: bucket,
  } as unknown as Env;
}

function failingPublishedSnapshotEnv(): Env {
  const dbError = new Error("catalog unavailable");
  return {
    DB: {
      prepare(): D1PreparedStatement {
        throw dbError;
      },
      async exec(): Promise<D1Result> {
        throw dbError;
      },
      async batch<T = unknown>(): Promise<D1Result<T>[]> {
        throw dbError;
      },
    },
    NOTEBOOK_SNAPSHOTS: new FakeR2Bucket(),
  } as unknown as Env;
}

function arrayBufferFromBytes(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

class FakeCatalogD1 implements D1Database {
  constructor(
    readonly catalog: {
      notebook: {
        id: string;
        owner_principal: string;
        title: string | null;
        created_at: string;
        updated_at: string;
        latest_revision_id: string;
      };
      revision: {
        id: string;
        notebook_id: string;
        runtime_state_doc_id: string | null;
        notebook_heads_hash: string;
        runtime_heads_hash: string;
        comms_heads_hash: string | null;
        snapshot_key: string;
        runtime_snapshot_key: string;
        comms_snapshot_key: string | null;
        actor_label: string;
        created_at: string;
      };
    },
  ) {}

  prepare(query: string): D1PreparedStatement {
    return new FakeCatalogStatement(this, query);
  }

  async exec(): Promise<D1Result> {
    return okResult();
  }

  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    return Promise.all(statements.map((statement) => statement.run<T>()));
  }
}

class FakeCatalogStatement implements D1PreparedStatement {
  private values: D1Value[] = [];

  constructor(
    private readonly db: FakeCatalogD1,
    private readonly query: string,
  ) {}

  bind(...values: D1Value[]): D1PreparedStatement {
    this.values = values;
    return this;
  }

  async first<T = unknown>(): Promise<T | null> {
    if (/FROM notebooks\s+WHERE id = \?/s.test(this.query)) {
      const notebookId = this.values[0];
      return notebookId === this.db.catalog.notebook.id ? (this.db.catalog.notebook as T) : null;
    }
    return null;
  }

  async run<T = unknown>(): Promise<D1Result<T>> {
    return okResult<T>();
  }

  async all<T = unknown>(): Promise<D1Result<T>> {
    if (/PRAGMA table_info\(notebook_revisions\)/.test(this.query)) {
      return okResult([
        { name: "runtime_snapshot_key" },
        { name: "runtime_state_doc_id" },
        { name: "comms_heads_hash" },
        { name: "comms_snapshot_key" },
      ] as T[]);
    }
    if (/FROM notebook_revisions/s.test(this.query)) {
      const notebookId = this.values[0];
      const results = notebookId === this.db.catalog.notebook.id ? [this.db.catalog.revision] : [];
      return okResult(results as T[]);
    }
    if (/FROM notebook_blobs/s.test(this.query)) {
      return okResult([]);
    }
    return okResult([]);
  }
}

function okResult<T = unknown>(results: T[] = []): D1Result<T> {
  return { results, success: true, meta: { changes: 0 } };
}

class FakeR2Bucket implements R2Bucket {
  readonly objects = new Map<string, ArrayBuffer>();

  async get(key: string): Promise<R2ObjectBody | null> {
    const value = this.objects.get(key);
    return value ? new FakeR2Object(key, value) : null;
  }

  async head(key: string): Promise<R2Object | null> {
    const value = this.objects.get(key);
    return value ? new FakeR2Object(key, value) : null;
  }

  async put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null,
    _options?: R2PutOptions,
  ): Promise<R2Object> {
    const bytes =
      typeof value === "string"
        ? new TextEncoder().encode(value).buffer
        : value instanceof ArrayBuffer
          ? value
          : ArrayBuffer.isView(value)
            ? value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
            : new ArrayBuffer(0);
    this.objects.set(key, bytes);
    return new FakeR2Object(key, bytes);
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

class FakeR2Object implements R2ObjectBody {
  readonly version = "test";
  readonly etag = "etag";
  readonly httpEtag = "etag";
  readonly uploaded = new Date("2026-05-28T00:00:00.000Z");
  readonly httpMetadata = undefined;
  readonly customMetadata = undefined;

  constructor(
    readonly key: string,
    private readonly value: ArrayBuffer,
  ) {}

  get size(): number {
    return this.value.byteLength;
  }

  get body(): ReadableStream {
    return new Response(this.value).body!;
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    return this.value.slice(0);
  }

  async text(): Promise<string> {
    return new TextDecoder().decode(this.value);
  }

  writeHttpMetadata(_headers: Headers): void {}
}
