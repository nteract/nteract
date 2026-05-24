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
      true,
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
      true,
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
          true,
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
          true,
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
          true,
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
          false,
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
      true,
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
      true,
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
    };
    assert.deepEqual(execution, {
      status: "done",
      success: true,
      execution_count: 1,
      output_ids: ["out-stdout-1"],
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
      true,
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
          true,
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
          false,
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
});

function syncHostWithClient(
  host: Awaited<ReturnType<typeof createEmptyRoomHost>>,
  peerId: string,
  principal: string,
  canWrite: boolean,
  canWriteAllNotebookChanges: boolean,
  client: NotebookHandle,
): void {
  let result = host.sync_peer(peerId, canWrite, canWrite) as {
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
        canWrite,
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
  const message = client.flush_local_changes();
  assert.ok(message);
  host.receive_peer_frame(
    peerId,
    principal,
    canWrite,
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
  const outbound: Array<{ peer_id: string; frame_type: FrameTypeValue; payload: number[] }> = [];
  const initial = client.flush_runtime_state_sync();
  if (initial) {
    const reply = host.receive_peer_frame(
      peerId,
      principal,
      canWrite,
      canWriteAllNotebookChanges,
      encodeTypedFrame(FrameType.RUNTIME_STATE_SYNC, initial),
    ) as {
      outbound: Array<{ peer_id: string; frame_type: FrameTypeValue; payload: number[] }>;
    };
    outbound.push(...reply.outbound);
  }

  const hostSync = host.sync_peer(peerId, false, canWrite) as {
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
        canWrite,
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
  canWrite: boolean,
  canWriteAllNotebookChanges: boolean,
  runtime: RuntimeStatePeerHandle,
): void {
  let result = host.sync_peer(peerId, false, canWrite) as {
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
        canWrite,
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
    for (const event of events ?? []) {
      if (event.type === "runtime_state_sync_applied" && event.reply) {
        replies.push(encodeTypedFrame(FrameType.RUNTIME_STATE_SYNC, new Uint8Array(event.reply)));
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
