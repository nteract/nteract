import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { CloudflareWebSocket, DurableObjectState, Env } from "../src/cloudflare-types.ts";
import {
  NOTEBOOK_CLOUD_WEBSOCKET_PROTOCOL,
  TRUSTED_WEBSOCKET_PROTOCOL_HEADER,
  authenticateAnonymousViewer,
  authenticateDevRequest,
  stampTrustedIdentity,
} from "../src/identity.ts";
import {
  NotebookRoom,
  rewritePresenceFrame,
  shouldBroadcastFrame,
  shouldPersistMaterializedSyncFrame,
  webSocketUpgradeHeaders,
} from "../src/notebook-room.ts";
import {
  FrameType,
  decodeJsonPayload,
  encodeTypedFrame,
  splitTypedFrame,
} from "../src/protocol.ts";
import {
  decodePresenceFrame,
  encodePresenceFrame,
  initializeRuntimedWasm,
} from "../src/runtimed-wasm.ts";
import type { RoomHostFrameResult } from "../src/room-materializer.ts";

const wasmBytes = await readFile(
  new URL("../../notebook/src/wasm/runtimed-wasm/runtimed_wasm_bg.wasm", import.meta.url),
);

before(async () => {
  await initializeRuntimedWasm(wasmBytes);
});

describe("NotebookRoom presence rewrite", () => {
  it("rewrites canonical CBOR presence to the server peer and authenticated principal", async () => {
    const identity = authenticateDevRequest(
      new Request("https://cloud.test/n/demo/sync?user=alice&operator=desktop:a&scope=editor"),
    );
    const payload = await encodePresenceFrame({
      type: "update",
      peer_id: "client-forged-peer",
      peer_label: "Mallory",
      actor_label: "user:dev:mallory/agent:codex:s1",
      channel: "cursor",
      data: { cell_id: "cell-1", line: 2, column: 4 },
    });
    const frame = splitTypedFrame(encodeTypedFrame(FrameType.PRESENCE, payload));

    const rewritten = await rewritePresenceFrame(frame, { id: "server-peer", identity });
    const body = (await decodePresenceFrame(rewritten.payload)) as Record<string, unknown>;

    assert.equal(rewritten.type, FrameType.PRESENCE);
    assert.equal(body.peer_id, "server-peer");
    assert.equal(body.peer_label, "user:dev:alice");
    assert.equal(body.actor_label, "user:dev:alice/agent:codex:s1");
  });

  it("falls back to the authenticated operator for invalid presented actor labels", async () => {
    const identity = authenticateDevRequest(
      new Request("https://cloud.test/n/demo/sync?user=alice&operator=desktop:a&scope=editor"),
    );
    const payload = await encodePresenceFrame({
      type: "update",
      peer_id: "client-peer",
      peer_label: "Mallory",
      actor_label: "/bad",
      channel: "focus",
      data: { cell_id: "cell-1" },
    });
    const frame = splitTypedFrame(encodeTypedFrame(FrameType.PRESENCE, payload));

    const rewritten = await rewritePresenceFrame(frame, { id: "server-peer", identity });
    const body = (await decodePresenceFrame(rewritten.payload)) as Record<string, unknown>;

    assert.equal(rewritten.type, FrameType.PRESENCE);
    assert.equal(body.actor_label, "user:dev:alice/desktop:a");
    assert.equal(body.peer_label, "user:dev:alice");
  });

  it("rejects non-CBOR presence payloads", async () => {
    const identity = authenticateDevRequest(
      new Request("https://cloud.test/n/demo/sync?user=alice&operator=desktop:a&scope=editor"),
    );
    const frame = splitTypedFrame(
      encodeTypedFrame(
        FrameType.PRESENCE,
        new TextEncoder().encode(JSON.stringify({ actor_label: identity.actorLabel })),
      ),
    );

    await assert.rejects(
      () => rewritePresenceFrame(frame, { id: "server-peer", identity }),
      /CBOR decode error/,
    );
  });

  it("keeps anonymous viewer presence local to the connection", async () => {
    const anonymous = authenticateAnonymousViewer(
      new Request("https://cloud.test/n/demo/sync?viewer_session=anon-a"),
    );
    const editor = authenticateDevRequest(
      new Request("https://cloud.test/n/demo/sync?user=alice&operator=desktop:a&scope=editor"),
    );
    const frame = splitTypedFrame(
      encodeTypedFrame(
        FrameType.PRESENCE,
        await encodePresenceFrame({
          type: "heartbeat",
          peer_id: "anonymous-client",
        }),
      ),
    );

    assert.equal(shouldBroadcastFrame(frame, anonymous), false);
    assert.equal(shouldBroadcastFrame(frame, editor), true);
  });
});

describe("NotebookRoom peer lifecycle", () => {
  it("echoes only the trusted non-sensitive WebSocket subprotocol in upgrade headers", () => {
    const identity = {
      ...authenticateAnonymousViewer(
        new Request("https://cloud.test/n/demo/sync?viewer_session=anon-a"),
      ),
      webSocketProtocol: NOTEBOOK_CLOUD_WEBSOCKET_PROTOCOL,
    };
    const stamped = stampTrustedIdentity(new Request("https://cloud.test/n/demo/sync"), identity);

    assert.equal(
      webSocketUpgradeHeaders(identity).get("Sec-WebSocket-Protocol"),
      NOTEBOOK_CLOUD_WEBSOCKET_PROTOCOL,
    );
    assert.equal(
      webSocketUpgradeHeaders(
        authenticateAnonymousViewer(
          new Request("https://cloud.test/n/demo/sync?viewer_session=anon-b"),
        ),
      ).has("Sec-WebSocket-Protocol"),
      false,
    );
    assert.equal(
      stamped.headers.get(TRUSTED_WEBSOCKET_PROTOCOL_HEADER),
      NOTEBOOK_CLOUD_WEBSOCKET_PROTOCOL,
    );
  });

  it("does not silently resurrect a removed hibernated peer", () => {
    const room = new NotebookRoom(fakeState(), {} as Env);
    const identity = authenticateDevRequest(
      new Request("https://cloud.test/n/demo/sync?user=alice&operator=desktop:a&scope=editor"),
    );
    const socket = new FakeSocket();
    socket.serializeAttachment({
      notebookId: "demo",
      peerId: "peer-a",
      identity,
      connectedAt: "2026-05-22T00:00:00.000Z",
    });
    const peer = {
      id: "peer-a",
      socket: socket.asCloudflareWebSocket(),
      identity,
      connectedAt: "2026-05-22T00:00:00.000Z",
    };
    const harness = roomHarness(room);
    harness.peers.set(peer.id, peer);

    harness.removePeer("demo", peer);

    assert.equal(socket.closed, true);
    assert.equal(harness.peerForSocket(socket.asCloudflareWebSocket()), undefined);
  });

  it("broadcasts the original frame before peer-left cleanup for failed peers", () => {
    const room = new NotebookRoom(fakeState(), {} as Env);
    const staleIdentity = authenticateDevRequest(
      new Request("https://cloud.test/n/demo/sync?user=stale&operator=desktop:a&scope=editor"),
    );
    const healthyIdentity = authenticateDevRequest(
      new Request("https://cloud.test/n/demo/sync?user=healthy&operator=desktop:b&scope=editor"),
    );
    const staleSocket = new FakeSocket({ throwOnSend: true });
    const healthySocket = new FakeSocket();
    const stalePeer = {
      id: "stale",
      socket: staleSocket.asCloudflareWebSocket(),
      identity: staleIdentity,
      connectedAt: "2026-05-22T00:00:00.000Z",
    };
    const healthyPeer = {
      id: "healthy",
      socket: healthySocket.asCloudflareWebSocket(),
      identity: healthyIdentity,
      connectedAt: "2026-05-22T00:00:00.000Z",
    };
    const harness = roomHarness(room);
    harness.peers.set(stalePeer.id, stalePeer);
    harness.peers.set(healthyPeer.id, healthyPeer);

    harness.broadcastFrame("demo", new Uint8Array([FrameType.AUTOMERGE_SYNC, 42]));

    assert.equal(healthySocket.sent.length, 2);
    assert.deepEqual([...healthySocket.sent[0]], [FrameType.AUTOMERGE_SYNC, 42]);
    assert.equal(healthySocket.sent[1][0], FrameType.SESSION_CONTROL);
    assert.equal(
      decodeJsonPayload<Record<string, unknown>>(healthySocket.sent[1].slice(1)).type,
      "cloud_peer_left",
    );
    assert.equal(staleSocket.closed, true);
  });
});

describe("NotebookRoom materialized sync persistence", () => {
  it("persists only sync frames that changed a materialized document", () => {
    assert.equal(
      shouldPersistMaterializedSyncFrame({
        notebook_changed: false,
        runtime_state_changed: false,
      }),
      false,
    );
    assert.equal(
      shouldPersistMaterializedSyncFrame({
        notebook_changed: true,
        runtime_state_changed: false,
      }),
      true,
    );
    assert.equal(
      shouldPersistMaterializedSyncFrame({
        notebook_changed: false,
        runtime_state_changed: true,
      }),
      true,
    );
  });

  it("acknowledges no-op sync control frames without persisted room history", async () => {
    const room = new NotebookRoom(fakeState(), {} as Env);
    const identity = authenticateDevRequest(
      new Request("https://cloud.test/n/demo/sync?user=viewer&operator=desktop:a&scope=viewer"),
    );
    const socket = new FakeSocket();
    const peer = {
      id: "viewer",
      socket: socket.asCloudflareWebSocket(),
      identity,
      connectedAt: "2026-05-22T00:00:00.000Z",
    };
    const harness = roomHarness(room);
    let persisted = 0;
    harness.materializers.set("demo", fakeMaterializer(noopMaterializedResult()));
    harness.persistFrame = async () => {
      persisted += 1;
    };

    await harness.handleMessage(
      "demo",
      peer,
      encodeTypedFrame(FrameType.AUTOMERGE_SYNC, new Uint8Array()),
    );

    assert.equal(persisted, 0);
    assert.equal(socket.sent.length, 1);
    assert.equal(
      decodeJsonPayload<Record<string, unknown>>(socket.sent[0].slice(1)).type,
      "cloud_frame_accepted",
    );
  });

  it("persists materialized sync frames that change document state", async () => {
    const room = new NotebookRoom(fakeState(), {} as Env);
    const identity = authenticateDevRequest(
      new Request("https://cloud.test/n/demo/sync?user=alice&operator=desktop:a&scope=editor"),
    );
    const socket = new FakeSocket();
    const peer = {
      id: "editor",
      socket: socket.asCloudflareWebSocket(),
      identity,
      connectedAt: "2026-05-22T00:00:00.000Z",
    };
    const harness = roomHarness(room);
    let persisted = 0;
    harness.materializers.set(
      "demo",
      fakeMaterializer({
        ...noopMaterializedResult(),
        changed: true,
        notebook_changed: true,
      }),
    );
    harness.persistFrame = async () => {
      persisted += 1;
    };

    await harness.handleMessage(
      "demo",
      peer,
      encodeTypedFrame(FrameType.AUTOMERGE_SYNC, new Uint8Array([1])),
    );

    assert.equal(persisted, 1);
    assert.equal(socket.sent.length, 1);
    assert.equal(
      decodeJsonPayload<Record<string, unknown>>(socket.sent[0].slice(1)).type,
      "cloud_frame_accepted",
    );
  });
});

type PeerForTest = {
  id: string;
  socket: CloudflareWebSocket;
  identity: ReturnType<typeof authenticateDevRequest>;
  connectedAt: string;
};

interface RoomHarness {
  peers: Map<string, PeerForTest>;
  materializers: Map<
    string,
    {
      receiveFrame(): Promise<RoomHostFrameResult>;
      checkpoint(): Promise<void>;
    }
  >;
  handleMessage(
    notebookId: string,
    peer: PeerForTest,
    message: string | ArrayBuffer | ArrayBufferView,
  ): Promise<void>;
  persistFrame(): Promise<void>;
  removePeer(notebookId: string, peer: PeerForTest): void;
  peerForSocket(socket: CloudflareWebSocket): PeerForTest | undefined;
  broadcastFrame(notebookId: string, frame: Uint8Array, excludePeerId?: string): void;
}

function roomHarness(room: NotebookRoom): RoomHarness {
  return room as unknown as RoomHarness;
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
      list: async <T>() => new Map(values as Map<string, T>),
    },
    waitUntil: () => undefined,
  };
}

function noopMaterializedResult(): RoomHostFrameResult {
  return {
    changed: false,
    notebook_changed: false,
    runtime_state_changed: false,
    outbound: [],
  };
}

function fakeMaterializer(result: RoomHostFrameResult): {
  receiveFrame(): Promise<RoomHostFrameResult>;
  checkpoint(): Promise<void>;
} {
  return {
    receiveFrame: async () => result,
    checkpoint: async () => undefined,
  };
}

class FakeSocket {
  readonly sent: Uint8Array[] = [];
  closed = false;
  private attachment: unknown;

  constructor(private readonly options: { throwOnSend?: boolean } = {}) {}

  accept(): void {}

  addEventListener(): void {}

  send(message: string | ArrayBuffer | ArrayBufferView): void {
    if (this.options.throwOnSend) {
      throw new Error("send failed");
    }

    if (typeof message === "string") {
      this.sent.push(new TextEncoder().encode(message));
    } else if (message instanceof ArrayBuffer) {
      this.sent.push(new Uint8Array(message));
    } else {
      this.sent.push(new Uint8Array(message.buffer, message.byteOffset, message.byteLength));
    }
  }

  close(): void {
    this.closed = true;
  }

  serializeAttachment(value: unknown): void {
    this.attachment = value;
  }

  deserializeAttachment(): unknown {
    return this.attachment;
  }

  asCloudflareWebSocket(): CloudflareWebSocket {
    return this as unknown as CloudflareWebSocket;
  }
}
