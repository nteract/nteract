import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { CloudflareWebSocket, DurableObjectState, Env } from "../src/cloudflare-types.ts";
import { authenticateAnonymousViewer, authenticateDevRequest } from "../src/identity.ts";
import { NotebookRoom, rewritePresenceFrame, shouldBroadcastFrame } from "../src/notebook-room.ts";
import {
  FrameType,
  decodeJsonPayload,
  encodeTypedFrame,
  splitTypedFrame,
} from "../src/protocol.ts";

describe("NotebookRoom presence rewrite", () => {
  it("falls back to the authenticated actor for invalid presented actor labels", () => {
    const identity = authenticateDevRequest(
      new Request("https://cloud.test/n/demo/sync?user=alice&operator=desktop:a&scope=editor"),
    );
    const frame = splitTypedFrame(
      encodeTypedFrame(
        FrameType.PRESENCE,
        new TextEncoder().encode(JSON.stringify({ actor_label: "/bad", peer_label: "Mallory" })),
      ),
    );

    const rewritten = rewritePresenceFrame(frame, identity);
    const body = decodeJsonPayload<Record<string, unknown>>(rewritten.payload);

    assert.equal(rewritten.type, FrameType.PRESENCE);
    assert.equal(body.actor_label, "user:dev:alice/desktop:a");
    assert.equal(body.peer_label, "Mallory");
  });

  it("rejects non-JSON presence until the shared CBOR presence codec is available", () => {
    const identity = authenticateDevRequest(
      new Request("https://cloud.test/n/demo/sync?user=alice&operator=desktop:a&scope=editor"),
    );
    const frame = splitTypedFrame(
      encodeTypedFrame(FrameType.PRESENCE, new Uint8Array([0xa1, 0x01, 0x02])),
    );

    assert.throws(() => rewritePresenceFrame(frame, identity), /presence payload must be JSON/);
  });

  it("keeps anonymous viewer presence local to the connection", () => {
    const anonymous = authenticateAnonymousViewer(
      new Request("https://cloud.test/n/demo/sync?viewer_session=anon-a"),
    );
    const editor = authenticateDevRequest(
      new Request("https://cloud.test/n/demo/sync?user=alice&operator=desktop:a&scope=editor"),
    );
    const frame = splitTypedFrame(
      encodeTypedFrame(
        FrameType.PRESENCE,
        new TextEncoder().encode(JSON.stringify({ actor_label: "browser:anon-a" })),
      ),
    );

    assert.equal(shouldBroadcastFrame(frame, anonymous), false);
    assert.equal(shouldBroadcastFrame(frame, editor), true);
  });
});

describe("NotebookRoom peer lifecycle", () => {
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

type PeerForTest = {
  id: string;
  socket: CloudflareWebSocket;
  identity: ReturnType<typeof authenticateDevRequest>;
  connectedAt: string;
};

interface RoomHarness {
  peers: Map<string, PeerForTest>;
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
