import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { PersistedNotebookDoc } from "runtimed";
import {
  CloudWebSocketTransport,
  cloudPrincipalFromActorLabel,
  cloudRoomReadyPeerLabel,
  isAnonymousCloudPrincipal,
  isRecoverableCloudFrameRejection,
  normalizeConnectionScope,
  resolveCloudNotebookHandle,
  shouldDiscardPersistedSeedOnRejection,
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

  it("treats rejected NotebookDoc sync frames as recoverable bootstrap failures", () => {
    assert.equal(
      isRecoverableCloudFrameRejection({
        type: "cloud_frame_rejected",
        notebook_id: "room",
        peer_id: "peer-1",
        frame_type: FrameType.AUTOMERGE_SYNC,
        reason: "duplicate seq from stale room-host actor",
        timestamp: "2026-06-08T00:00:00.000Z",
      }),
      true,
    );
    assert.equal(
      isRecoverableCloudFrameRejection({
        type: "cloud_frame_rejected",
        notebook_id: "room",
        peer_id: "peer-1",
        frame_type: FrameType.REQUEST,
        reason: "viewer cannot execute",
        timestamp: "2026-06-08T00:00:00.000Z",
      }),
      false,
    );
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

  it("tolerates deployed WASM handles without CommsDoc sync methods", () => {
    const originalWarn = console.warn;
    const warnings: unknown[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };

    try {
      const wasmHandle = {
        receive_frame: () => [],
        flush_local_changes: () => undefined,
        cancel_last_flush: () => undefined,
        flush_runtime_state_sync: () => undefined,
        cancel_last_runtime_state_flush: () => undefined,
        generate_runtime_state_sync_reply: () => undefined,
        reset_sync_state: () => undefined,
        cell_count: () => 0,
        get_heads_hex: () => [],
        get_dependency_fingerprint: () => undefined,
        resolve_comm_state: () => undefined,
      } as unknown as Parameters<typeof syncableCloudHandle>[0];
      const handle = syncableCloudHandle(wasmHandle);

      assert.equal(handle.flush_comms_doc_sync(), null);
      assert.equal(handle.generate_comms_doc_sync_reply(), null);
      assert.doesNotThrow(() => handle.cancel_last_comms_doc_flush());
    } finally {
      console.warn = originalWarn;
    }

    assert.equal(warnings.length, 1);
  });

  it("derives the connection principal from the actor label", () => {
    assert.equal(
      cloudPrincipalFromActorLabel("user:dev:alice/browser:session-1"),
      "user:dev:alice",
    );
    assert.equal(cloudPrincipalFromActorLabel("anonymous:abc/browser:abc"), "anonymous:abc");
    // No operator segment: the whole label is the principal.
    assert.equal(cloudPrincipalFromActorLabel("user:dev:alice"), "user:dev:alice");
  });

  it("classifies anonymous principals", () => {
    assert.equal(isAnonymousCloudPrincipal("anonymous:abc"), true);
    assert.equal(isAnonymousCloudPrincipal("user:dev:alice"), false);
    assert.equal(isAnonymousCloudPrincipal("user:anaconda:uuid-123"), false);
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

  it("emits offline when the socket closes before room readiness", async () => {
    const fake = installFakeWebSocket();
    const statuses: string[] = [];
    const disconnects: string[] = [];
    try {
      const transport = new CloudWebSocketTransport(
        new URL("wss://example.test/n/room/sync"),
        [],
        undefined,
        (reason) => disconnects.push(reason.message),
      );
      const subscription = transport.connectionStatus$.subscribe((status) => statuses.push(status));
      const ready = assert.rejects(transport.ready, /cloud sync socket closed before ready/);

      fake.socket.close({ code: 1006 });
      await ready;
      subscription.unsubscribe();

      assert.deepEqual(statuses, ["connecting", "offline"]);
      assert.deepEqual(disconnects, []);
    } finally {
      fake.restore();
    }
  });

  it("emits offline when manually disconnected after readiness", async () => {
    const fake = installFakeWebSocket();
    const statuses: string[] = [];
    try {
      const transport = new CloudWebSocketTransport(new URL("wss://example.test/n/room/sync"), []);
      const subscription = transport.connectionStatus$.subscribe((status) => statuses.push(status));
      const socket = fake.socket;
      socket.open();
      socket.ready("peer-1");
      await transport.ready;

      transport.disconnect();
      subscription.unsubscribe();

      assert.equal(transport.connected, false);
      assert.deepEqual(statuses, ["connecting", "online", "offline"]);
    } finally {
      fake.restore();
    }
  });

  it("sends notebook requests as cloud request frames and resolves on room-host ack", async () => {
    const fake = installFakeWebSocket();
    try {
      const transport = new CloudWebSocketTransport(new URL("wss://example.test/n/room/sync"), []);
      const socket = fake.socket;
      socket.open();
      socket.ready("peer-1");
      await transport.ready;

      const response = transport.sendRequest(
        { type: "execute_cell", cell_id: "cell-1" },
        { required_heads: ["head-1"] },
      );
      await nextMicrotask();

      assert.equal(socket.sent.length, 1);
      const frame = socket.sent[0];
      assert.ok(frame instanceof Uint8Array);
      assert.equal(frame[0], FrameType.REQUEST);
      const envelope = JSON.parse(new TextDecoder().decode(frame.slice(1))) as {
        action: string;
        cell_id: string;
        id: string;
        required_heads: string[];
      };
      assert.equal(envelope.action, "execute_cell");
      assert.equal(envelope.cell_id, "cell-1");
      assert.deepEqual(envelope.required_heads, ["head-1"]);
      assert.equal(typeof envelope.id, "string");

      socket.control({
        type: "cloud_frame_accepted",
        notebook_id: "room",
        peer_id: "peer-1",
        frame_type: FrameType.REQUEST,
        byte_length: frame.byteLength - 1,
        timestamp: "2026-06-06T00:00:00.000Z",
      });

      assert.deepEqual(await response, { result: "ok" });
    } finally {
      fake.restore();
    }
  });

  it("rejects notebook requests when the cloud room rejects the request frame", async () => {
    const fake = installFakeWebSocket();
    try {
      const transport = new CloudWebSocketTransport(new URL("wss://example.test/n/room/sync"), []);
      const socket = fake.socket;
      socket.open();
      socket.ready("peer-1");
      await transport.ready;

      const response = transport.sendRequest({ type: "execute_cell", cell_id: "cell-1" });
      await nextMicrotask();
      socket.control({
        type: "cloud_frame_rejected",
        notebook_id: "room",
        peer_id: "peer-1",
        frame_type: FrameType.REQUEST,
        reason: "viewer cannot write request frames",
        timestamp: "2026-06-06T00:00:00.000Z",
      });

      await assert.rejects(response, /viewer cannot write request frames/);
    } finally {
      fake.restore();
    }
  });

  it("resolves accepted notebook requests without waiting for a response frame", async () => {
    const fake = installFakeWebSocket();
    try {
      const transport = new CloudWebSocketTransport(new URL("wss://example.test/n/room/sync"), []);
      const socket = fake.socket;
      socket.open();
      socket.ready("peer-1");
      await transport.ready;

      const response = transport.sendTypedRequest(
        FrameType.REQUEST,
        new TextEncoder().encode(JSON.stringify({ id: "req-1", action: "complete" })),
        "req-1",
        20,
        "complete",
      );
      await nextMicrotask();
      socket.control({
        type: "cloud_frame_accepted",
        notebook_id: "room",
        peer_id: "peer-1",
        frame_type: FrameType.REQUEST,
        byte_length: socket.sent[0].byteLength - 1,
        timestamp: "2026-06-06T00:00:00.000Z",
      });

      assert.deepEqual(await response, { result: "ok" });
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

describe("cloud persisted-seed handle resolution", () => {
  const ACTOR_LABEL = "user:dev:alice/browser:session-1";

  function persistedRecord(principal: string): PersistedNotebookDoc {
    return {
      bytes: new Uint8Array([7, 8, 9]),
      meta: { headsHex: ["aa"], savedAt: 123, principal, schemaVersion: 1 },
    };
  }

  function createHarness(record: PersistedNotebookDoc | undefined) {
    const calls: string[] = [];
    const loadedBytes: Uint8Array[] = [];
    return {
      calls,
      loadedBytes,
      options: {
        actorLabel: ACTOR_LABEL,
        persistence: {
          loadPersisted: async () => {
            calls.push("loadPersisted");
            return record;
          },
          clear: async () => {
            calls.push("clear");
          },
        },
        createBootstrap: async () => {
          calls.push("createBootstrap");
          return "bootstrap-handle";
        },
        loadFromBytes: async (bytes: Uint8Array) => {
          calls.push("loadFromBytes");
          loadedBytes.push(bytes);
          return "seeded-handle";
        },
      },
    };
  }

  async function withSilencedWarnings<T>(run: () => Promise<T>): Promise<T> {
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      return await run();
    } finally {
      console.warn = originalWarn;
    }
  }

  it("bootstraps when no persistence is wired", async () => {
    const harness = createHarness(undefined);
    const resolved = await resolveCloudNotebookHandle({
      ...harness.options,
      persistence: undefined,
    });

    assert.deepEqual(resolved, { handle: "bootstrap-handle", outcome: "bootstrap" });
    assert.deepEqual(harness.calls, ["createBootstrap"]);
  });

  it("bootstraps without touching persistence for anonymous principals", async () => {
    // Anonymous principals are per-connection: a record can never match the
    // next session, and an anonymous session must never clear a signed-in
    // user's record on principal mismatch.
    const harness = createHarness(persistedRecord("anonymous:other-session"));
    const resolved = await resolveCloudNotebookHandle({
      ...harness.options,
      actorLabel: "anonymous:session-1/browser:session-1",
    });

    assert.deepEqual(resolved, { handle: "bootstrap-handle", outcome: "bootstrap" });
    assert.deepEqual(harness.calls, ["createBootstrap"]);
  });

  it("bootstraps without clearing when no record exists", async () => {
    const harness = createHarness(undefined);
    const resolved = await resolveCloudNotebookHandle(harness.options);

    assert.deepEqual(resolved, { handle: "bootstrap-handle", outcome: "bootstrap" });
    assert.deepEqual(harness.calls, ["loadPersisted", "createBootstrap"]);
  });

  it("seeds from persisted bytes when the principal matches", async () => {
    const harness = createHarness(persistedRecord("user:dev:alice"));
    const resolved = await resolveCloudNotebookHandle(harness.options);

    assert.deepEqual(resolved, { handle: "seeded-handle", outcome: "seeded" });
    assert.deepEqual(harness.calls, ["loadPersisted", "loadFromBytes"]);
    assert.deepEqual(harness.loadedBytes, [new Uint8Array([7, 8, 9])]);
  });

  it("clears the record and bootstraps on principal mismatch", async () => {
    const harness = createHarness(persistedRecord("user:dev:mallory"));
    const resolved = await resolveCloudNotebookHandle(harness.options);

    assert.deepEqual(resolved, { handle: "bootstrap-handle", outcome: "cleared" });
    assert.deepEqual(harness.calls, ["loadPersisted", "clear", "createBootstrap"]);
  });

  it("clears the record and bootstraps when meta is missing or corrupt", async () => {
    const harness = createHarness({ bytes: new Uint8Array([7, 8, 9]), meta: null });
    const resolved = await resolveCloudNotebookHandle(harness.options);

    assert.deepEqual(resolved, { handle: "bootstrap-handle", outcome: "cleared" });
    assert.deepEqual(harness.calls, ["loadPersisted", "clear", "createBootstrap"]);
  });

  it("clears the record and bootstraps when a torn envelope has no bytes", async () => {
    const record = persistedRecord("user:dev:alice");
    const harness = createHarness({ meta: record.meta });
    const resolved = await resolveCloudNotebookHandle(harness.options);

    assert.deepEqual(resolved, { handle: "bootstrap-handle", outcome: "cleared" });
    assert.deepEqual(harness.calls, ["loadPersisted", "clear", "createBootstrap"]);
  });

  it("clears the record and bootstraps when the persisted bytes fail to load", async () => {
    const harness = createHarness(persistedRecord("user:dev:alice"));
    harness.options.loadFromBytes = async () => {
      harness.calls.push("loadFromBytes");
      throw new Error("automerge load failed");
    };

    const resolved = await withSilencedWarnings(() => resolveCloudNotebookHandle(harness.options));

    assert.deepEqual(resolved, { handle: "bootstrap-handle", outcome: "cleared" });
    assert.deepEqual(harness.calls, ["loadPersisted", "loadFromBytes", "clear", "createBootstrap"]);
  });

  it("fails open as read_failed without clearing when the storage read fails", async () => {
    const harness = createHarness(undefined);
    harness.options.persistence = {
      loadPersisted: async () => {
        harness.calls.push("loadPersisted");
        throw new Error("indexedDB unavailable mid-session");
      },
      clear: async () => {
        harness.calls.push("clear");
      },
    };

    const resolved = await withSilencedWarnings(() => resolveCloudNotebookHandle(harness.options));

    assert.deepEqual(resolved, { handle: "bootstrap-handle", outcome: "read_failed" });
    assert.deepEqual(harness.calls, ["loadPersisted", "createBootstrap"]);
  });

  it("fails open as read_failed when the storage read never settles", async () => {
    const harness = createHarness(undefined);
    harness.options.persistence = {
      loadPersisted: () => {
        harness.calls.push("loadPersisted");
        return new Promise(() => undefined); // hung IDB open
      },
      clear: async () => {
        harness.calls.push("clear");
      },
    };

    const resolved = await withSilencedWarnings(() =>
      resolveCloudNotebookHandle({ ...harness.options, readTimeoutMs: 5 }),
    );

    assert.deepEqual(resolved, { handle: "bootstrap-handle", outcome: "read_failed" });
    assert.deepEqual(harness.calls, ["loadPersisted", "createBootstrap"]);
  });

  it("still bootstraps when clearing a rejected record fails", async () => {
    const harness = createHarness(persistedRecord("user:dev:mallory"));
    harness.options.persistence.clear = async () => {
      harness.calls.push("clear");
      throw new Error("removeRange failed");
    };

    const resolved = await withSilencedWarnings(() => resolveCloudNotebookHandle(harness.options));

    assert.deepEqual(resolved, { handle: "bootstrap-handle", outcome: "cleared" });
    assert.deepEqual(harness.calls, ["loadPersisted", "clear", "createBootstrap"]);
  });

  it("discards the persisted seed only for seeded sessions hitting sync rejections", () => {
    const rejection = {
      type: "cloud_frame_rejected" as const,
      notebook_id: "room",
      peer_id: "peer-1",
      frame_type: FrameType.AUTOMERGE_SYNC,
      reason: "connection scope cannot write NotebookDoc changes",
      timestamp: "2026-06-11T00:00:00.000Z",
    };

    assert.equal(shouldDiscardPersistedSeedOnRejection(rejection, true), true);
    assert.equal(shouldDiscardPersistedSeedOnRejection(rejection, false), false);
    assert.equal(
      shouldDiscardPersistedSeedOnRejection({ ...rejection, frame_type: FrameType.REQUEST }, true),
      false,
    );
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
  sent: Uint8Array[] = [];

  constructor() {
    super();
    FakeWebSocket.instances.push(this);
  }

  send(data: unknown): void {
    if (this.throwOnSend) {
      throw new Error("synthetic send failure");
    }
    if (data instanceof Uint8Array) {
      this.sent.push(data);
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
    this.control({
      type: "cloud_room_ready",
      protocol: "v4",
      notebook_id: "room",
      peer_id: peerId,
      actor_label: `user:dev:alice/desktop:${peerId}`,
      connection_scope: "editor",
      room_peer_count: 1,
      timestamp: "2026-05-24T00:00:00.000Z",
    });
  }

  control(value: unknown): void {
    const payload = new TextEncoder().encode(JSON.stringify(value));
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
