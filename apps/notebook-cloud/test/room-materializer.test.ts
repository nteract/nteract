import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { DurableObjectState, Env } from "../src/cloudflare-types.ts";
import { authenticateDevRequest } from "../src/identity.ts";
import { FrameType, encodeTypedFrame, type FrameTypeValue } from "../src/protocol.ts";
import { RoomMaterializer } from "../src/room-materializer.ts";
import {
  createEmptyRoomHost,
  initializeRuntimedWasm,
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

  it("rejects editor-scoped source edits to code cells", async () => {
    const host = await createEmptyRoomHost("demo", "system/schema:notebook-cloud-room");
    const owner = NotebookHandle.create_bootstrap("user:dev:alice/desktop:owner");
    const editor = NotebookHandle.create_bootstrap("user:dev:bob/desktop:editor");

    syncHostWithClient(host, "peer-owner", "user:dev:alice", true, true, owner);
    owner.add_cell(0, "code-cell", "code");
    owner.update_source("code-cell", "x = 1\n");
    applyClientChangesToHost(host, "peer-owner", "user:dev:alice", true, true, owner);

    syncHostWithClient(host, "peer-editor", "user:dev:bob", true, false, editor);
    editor.update_source("code-cell", "x = 2\n");
    const message = editor.flush_local_changes();
    assert.ok(message);

    assert.throws(
      () =>
        host.receive_peer_frame(
          "peer-editor",
          "user:dev:bob",
          "editor",
          false,
          encodeTypedFrame(FrameType.AUTOMERGE_SYNC, message),
        ),
      /cannot edit code or raw cells/,
    );
  });

  it("rejects editor-scoped structural NotebookDoc changes", async () => {
    const host = await createEmptyRoomHost("demo", "system/schema:notebook-cloud-room");
    const editor = NotebookHandle.create_bootstrap("user:dev:bob/desktop:editor");

    syncHostWithClient(host, "peer-editor", "user:dev:bob", true, false, editor);
    editor.add_cell(0, "new-markdown", "markdown");
    const message = editor.flush_local_changes();
    assert.ok(message);

    assert.throws(
      () =>
        host.receive_peer_frame(
          "peer-editor",
          "user:dev:bob",
          "editor",
          false,
          encodeTypedFrame(FrameType.AUTOMERGE_SYNC, message),
        ),
      /cannot add, remove, or reorder cells/,
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
          "viewer",
          false,
          encodeTypedFrame(FrameType.AUTOMERGE_SYNC, message),
        ),
      /cannot write NotebookDoc/,
    );
  });

  it("allows runtime peers to publish RuntimeStateDoc executions and outputs", async () => {
    const host = await createEmptyRoomHost("demo", "system/schema:notebook-cloud-room");
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

    runtime.create_execution_with_source("exec-1", "print('hosted runtime')", 0);
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
          "runtime_peer",
          false,
          encodeTypedFrame(FrameType.AUTOMERGE_SYNC, message),
        ),
      /cannot write NotebookDoc/,
    );
  });
});

describe("RoomMaterializer", () => {
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
    assert.deepEqual(
      cells.map((cell) => cell.id),
      ["cell-1"],
    );
    assert.equal(cells[0].source, "Durable room checkpoint\n");
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

    assert.deepEqual(JSON.parse(viewer.get_cells_json()), []);
  });

  it("allows runtime peers, not editors, to author runtime state changes", async () => {
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
    runtimePeer.create_execution_with_source("exec-runtime", "print('runtime')", 0);
    const runtimeMessage = runtimePeer.flush_runtime_state_sync();
    assert.ok(runtimeMessage);

    const accepted = await materializer.receiveFrame(runtimePeerConnection, {
      type: FrameType.RUNTIME_STATE_SYNC,
      payload: runtimeMessage,
    });
    assert.equal(accepted.changed, true);
    assert.equal(accepted.runtime_state_changed, true);

    const editorIdentity = authenticateDevRequest(
      new Request("https://cloud.test/n/demo/sync?user=bob&operator=desktop:b&scope=editor"),
    );
    const editorPeerConnection = { id: "peer-editor", identity: editorIdentity };
    const editorPeer = NotebookHandle.create_bootstrap(editorIdentity.actorLabel);
    await syncMaterializerRuntimeStateWithClient(materializer, editorPeerConnection, editorPeer);
    assert.deepEqual(editorPeer.get_execution_by_id("exec-runtime"), {
      status: "queued",
      success: null,
      execution_count: null,
      output_ids: [],
      submitted_by_actor_label: null,
    });

    const forgedEditorRuntime = new RuntimeStatePeerHandle(editorIdentity.actorLabel);
    await syncMaterializerWithRuntimePeer(materializer, editorPeerConnection, forgedEditorRuntime);
    forgedEditorRuntime.create_execution_with_source("exec-editor-forged", "print('editor')", 0);
    await assert.rejects(
      () =>
        applyRuntimePeerChangesToMaterializer(
          materializer,
          editorPeerConnection,
          forgedEditorRuntime,
        ),
      /executions/,
    );
  });

  it("allows owner-scoped RuntimeStateDoc changes to existing comm state", async () => {
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
    const runtimeMessage = runtimePeer.flush_runtime_state_sync();
    assert.ok(runtimeMessage);
    await materializer.receiveFrame(runtimePeerConnection, {
      type: FrameType.RUNTIME_STATE_SYNC,
      payload: runtimeMessage,
    });

    const ownerIdentity = authenticateDevRequest(
      new Request("https://cloud.test/n/demo/sync?user=alice&operator=desktop:a&scope=owner"),
    );
    const ownerPeerConnection = { id: "peer-owner", identity: ownerIdentity };
    const owner = NotebookHandle.create_bootstrap(ownerIdentity.actorLabel);
    await syncMaterializerRuntimeStateWithClient(materializer, ownerPeerConnection, owner);
    assert.equal(owner.set_comm_state_property("comm-widget", "value", JSON.stringify(2)), true);
    const accepted = await applyRuntimeClientChangesToMaterializer(
      materializer,
      ownerPeerConnection,
      owner,
    );
    assert.equal(accepted.changed, true);
    assert.equal(accepted.runtime_state_changed, true);

    const viewerIdentity = authenticateDevRequest(
      new Request("https://cloud.test/n/demo/sync?user=carol&operator=desktop:c&scope=viewer"),
    );
    const viewer = NotebookHandle.create_bootstrap(viewerIdentity.actorLabel);
    await syncMaterializerRuntimeStateWithClient(
      materializer,
      { id: "peer-viewer", identity: viewerIdentity },
      viewer,
    );
    const runtimeState = viewer.get_runtime_state() as {
      comms: Record<string, { state: Record<string, unknown> }>;
    };
    assert.equal(runtimeState.comms["comm-widget"].state.value, 2);
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
      /executions/,
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

async function applyRuntimeClientChangesToMaterializer(
  materializer: RoomMaterializer,
  peer: { id: string; identity: ReturnType<typeof authenticateDevRequest> },
  client: NotebookHandle,
) {
  const message = client.flush_runtime_state_sync();
  assert.ok(message);
  let result = await materializer.receiveFrame(peer, {
    type: FrameType.RUNTIME_STATE_SYNC,
    payload: message,
  });

  for (let round = 0; round < 8 && !result.changed; round += 1) {
    const replies = applyRuntimeOutboundToClient(result.outbound, peer.id, client);
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
