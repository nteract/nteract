import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CloudWebSocketTransport,
  cloudRoomReadyPeerLabel,
  normalizeConnectionScope,
  startCloudBootstrapSync,
  syncUrl,
  syncableCloudHandle,
  withReadyTimeout,
} from "../viewer/live-sync.ts";
import { FrameType } from "../src/protocol.ts";

describe("cloud live sync", () => {
  it("accepts known connection scopes", () => {
    assert.equal(normalizeConnectionScope("viewer"), "viewer");
    assert.equal(normalizeConnectionScope("editor"), "editor");
    assert.equal(normalizeConnectionScope("runtime_peer"), "runtime_peer");
    assert.equal(normalizeConnectionScope("owner"), "owner");
  });

  it("falls back to viewer for unknown connection scopes", () => {
    const originalWarn = console.warn;
    const warnings: unknown[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };
    try {
      assert.equal(normalizeConnectionScope("admin"), "viewer");
    } finally {
      console.warn = originalWarn;
    }

    assert.equal(warnings.length, 1);
  });

  it("times out a silent ready promise", async () => {
    await assert.rejects(
      withReadyTimeout(new Promise(() => undefined), 1, "silent socket"),
      /silent socket/,
    );
  });

  it("returns a ready value before the timeout", async () => {
    await assert.doesNotReject(
      withReadyTimeout(Promise.resolve("ready"), 1_000, "should not fire"),
    );
  });

  it("starts bootstrap sync with the same fresh-handle exchange desktop uses", () => {
    const calls: string[] = [];

    startCloudBootstrapSync({
      start: () => {
        calls.push("start");
      },
      resetForBootstrap: () => {
        calls.push("resetForBootstrap");
      },
      flush: () => {
        calls.push("flush");
      },
    });

    assert.deepEqual(calls, ["start", "resetForBootstrap", "flush"]);
  });

  it("uses the same bootstrap exchange for passive viewer sync", () => {
    const calls: string[] = [];

    startCloudBootstrapSync({
      start: () => {
        calls.push("start");
      },
      resetForBootstrap: () => {
        calls.push("resetForBootstrap");
      },
      flush: () => {
        calls.push("flush");
      },
    });

    assert.deepEqual(calls, ["start", "resetForBootstrap", "flush"]);
  });

  it("labels authenticated browser sync connections as browser operators", () => {
    const url = syncUrl("https://cloud.test/n/demo/sync", "session/one", {
      headers: { Authorization: "Bearer token" },
      protocols: ["nteract-bearer.dG9rZW4", "nteract.v4"],
      user: null,
      operator: null,
      requestedScope: "editor",
    });

    assert.equal(
      url.href,
      "wss://cloud.test/n/demo/sync?viewer_session=session%2Fone&operator=browser%3Asession%252Fone&scope=editor",
    );
  });

  it("does not present an operator for anonymous viewer sync", () => {
    const url = syncUrl("https://cloud.test/n/demo/sync", "anon-one", {
      headers: {},
      protocols: [],
      user: null,
      operator: null,
      requestedScope: null,
    });

    assert.equal(url.searchParams.get("viewer_session"), "anon-one");
    assert.equal(url.searchParams.has("operator"), false);
  });

  it("uses display name, email, then actor label for the local cloud room peer label", () => {
    const ready = {
      actor_label: "user:anaconda:uuid-123/browser:session-1",
      display_name: "Alice Example",
      email: "alice@example.com",
    };

    assert.equal(cloudRoomReadyPeerLabel(ready), "Alice Example");
    assert.equal(
      cloudRoomReadyPeerLabel({ ...ready, display_name: " ", email: "alice@example.com" }),
      "alice@example.com",
    );
    const { display_name: _displayName, email: _email, ...actorOnlyReady } = ready;
    assert.equal(cloudRoomReadyPeerLabel(actorOnlyReady), "Anaconda user uuid-123");
  });

  it("does not expose PoolDoc sync from the cloud viewer adapter", () => {
    const calls: string[] = [];
    const wasmHandle = {
      receive_frame: () => [],
      flush_local_changes: () => undefined,
      cancel_last_flush: () => {
        calls.push("cancel_last_flush");
      },
      flush_runtime_state_sync: () => undefined,
      cancel_last_runtime_state_flush: () => {
        calls.push("cancel_last_runtime_state_flush");
      },
      generate_runtime_state_sync_reply: () => undefined,
      flush_comms_doc_sync: () => undefined,
      cancel_last_comms_doc_flush: () => {
        calls.push("cancel_last_comms_doc_flush");
      },
      generate_comms_doc_sync_reply: () => undefined,
      flush_pool_state_sync: () => {
        calls.push("flush_pool_state_sync");
        return new Uint8Array([1, 2, 3]);
      },
      cancel_last_pool_state_flush: () => {
        calls.push("cancel_last_pool_state_flush");
      },
      generate_pool_state_sync_reply: () => {
        calls.push("generate_pool_state_sync_reply");
        return new Uint8Array([4, 5, 6]);
      },
      reset_sync_state: () => {
        calls.push("reset_sync_state");
      },
      cell_count: () => 0,
      get_heads_hex: () => [],
      get_dependency_fingerprint: () => undefined,
      resolve_comm_state: () => undefined,
    } as unknown as Parameters<typeof syncableCloudHandle>[0];
    const handle = syncableCloudHandle(wasmHandle);

    assert.equal(handle.flush_pool_state_sync(), null);
    assert.equal(handle.generate_pool_state_sync_reply(), null);
    handle.cancel_last_pool_state_flush();
    assert.deepEqual(calls, []);
  });

  it("notifies disconnect when a send sees a closing socket before the close event", async () => {
    const fake = installFakeWebSocket();
    const disconnects: string[] = [];
    try {
      const transport = new CloudWebSocketTransport(
        new URL("wss://example.test/n/room/sync"),
        [],
        undefined,
        (reason) => disconnects.push(reason.message),
      );
      const socket = fake.socket;
      socket.open();
      socket.ready("peer-1");
      await transport.ready;

      socket.readyState = FakeWebSocket.CLOSING;
      await assert.rejects(
        transport.sendFrame(FrameType.PRESENCE, new Uint8Array([1, 2, 3])),
        /cloud sync socket is closed/,
      );
      socket.close({ code: 1006 });

      assert.deepEqual(disconnects, ["cloud sync socket is closed"]);
    } finally {
      fake.restore();
    }
  });

  it("notifies disconnect when WebSocket.send throws", async () => {
    const fake = installFakeWebSocket();
    const disconnects: string[] = [];
    try {
      const transport = new CloudWebSocketTransport(
        new URL("wss://example.test/n/room/sync"),
        [],
        undefined,
        (reason) => disconnects.push(reason.message),
      );
      const socket = fake.socket;
      socket.open();
      socket.ready("peer-1");
      await transport.ready;

      socket.throwOnSend = true;
      await assert.rejects(
        transport.sendFrame(FrameType.PRESENCE, new Uint8Array([1, 2, 3])),
        /cloud sync socket send failed: synthetic send failure/,
      );
      assert.deepEqual(disconnects, ["cloud sync socket send failed: synthetic send failure"]);
    } finally {
      fake.restore();
    }
  });

  it("rejects ready when the bootstrap message cannot be decoded", async () => {
    const fake = installFakeWebSocket();
    try {
      const transport = new CloudWebSocketTransport(new URL("wss://example.test/n/room/sync"), []);
      const socket = fake.socket;
      socket.open();
      socket.message("not binary");

      await assert.rejects(
        transport.ready,
        /cloud sync socket message failed: unsupported WebSocket message/,
      );
      assert.equal(socket.readyState, FakeWebSocket.CLOSED);
    } finally {
      fake.restore();
    }
  });

  it("notifies disconnect when a post-ready message cannot be decoded", async () => {
    const fake = installFakeWebSocket();
    const disconnects: string[] = [];
    try {
      const transport = new CloudWebSocketTransport(
        new URL("wss://example.test/n/room/sync"),
        [],
        undefined,
        (reason) => disconnects.push(reason.message),
      );
      const socket = fake.socket;
      socket.open();
      socket.ready("peer-1");
      await transport.ready;

      socket.message("not binary");
      await nextMicrotask();

      assert.deepEqual(disconnects, [
        "cloud sync socket message failed: unsupported WebSocket message [object String]",
      ]);
      assert.equal(socket.readyState, FakeWebSocket.CLOSED);
      await assert.rejects(
        transport.sendFrame(FrameType.PRESENCE, new Uint8Array([1, 2, 3])),
        /cloud sync socket is closed/,
      );
    } finally {
      fake.restore();
    }
  });
});

function installFakeWebSocket(): {
  restore: () => void;
  socket: FakeWebSocket;
} {
  const original = globalThis.WebSocket;
  FakeWebSocket.instances = [];
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  return {
    restore: () => {
      globalThis.WebSocket = original;
    },
    get socket() {
      const socket = FakeWebSocket.instances[0];
      assert.ok(socket, "expected a WebSocket instance");
      return socket;
    },
  };
}

class FakeWebSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  binaryType: BinaryType = "arraybuffer";
  readyState = FakeWebSocket.CONNECTING;
  throwOnSend = false;

  constructor() {
    super();
    FakeWebSocket.instances.push(this);
  }

  send(): void {
    if (this.throwOnSend) {
      throw new Error("synthetic send failure");
    }
  }

  close({ code = 1000, reason = "" }: { code?: number; reason?: string } = {}): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent(closeEvent(code, reason));
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  ready(peerId: string): void {
    const payload = new TextEncoder().encode(
      JSON.stringify({
        type: "cloud_room_ready",
        protocol: "v4",
        notebook_id: "room",
        peer_id: peerId,
        actor_label: `user:dev:alice/desktop:${peerId}`,
        connection_scope: "editor",
        timestamp: "2026-05-24T00:00:00.000Z",
      }),
    );
    const frame = new Uint8Array(payload.byteLength + 1);
    frame[0] = FrameType.SESSION_CONTROL;
    frame.set(payload, 1);
    this.dispatchEvent(messageEvent(frame.buffer));
  }

  message(data: unknown): void {
    this.dispatchEvent(messageEvent(data));
  }
}

function messageEvent(data: unknown): Event {
  const event = new Event("message");
  Object.defineProperty(event, "data", { value: data });
  return event;
}

async function nextMicrotask(): Promise<void> {
  await Promise.resolve();
}

function closeEvent(code: number, reason: string): Event {
  const event = new Event("close");
  Object.defineProperties(event, {
    code: { value: code },
    reason: { value: reason },
  });
  return event;
}
