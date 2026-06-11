import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SyncEngine, type PersistedNotebookDoc, type SyncableHandle } from "runtimed";
import {
  CloudRecoverableRejectionTracker,
  CloudWebSocketTransport,
  applyCloudRoomReady,
  cloudConnectionIdentityFromReady,
  cloudPrincipalFromActorLabel,
  cloudRoomReadyPeerLabel,
  createCloudConnectTarget,
  discardPersistedSeedAfterTeardown,
  isAnonymousCloudPrincipal,
  isRecoverableCloudFrameRejection,
  mintCloudSessionId,
  normalizeConnectionScope,
  reestablishCloudConnection,
  resolveCloudNotebookHandle,
  shouldDiscardPersistedSeedOnRejection,
  startCloudBootstrapSync,
  syncUrl,
  syncableCloudHandle,
  withReadyTimeout,
  type CloudWebSocketTransportOptions,
} from "../viewer/live-sync.ts";
import { FrameType, LIVENESS_PING, LIVENESS_PONG } from "../src/protocol.ts";

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

  it("rejects sends while the socket is not open without tearing the connection down", async () => {
    const fake = installFakeWebSocket();
    const lost: string[] = [];
    try {
      const transport = createTransport({
        onConnectionLost: (reason) => lost.push(reason.message),
      });
      const socket = await waitForSocket(0);
      socket.open();
      socket.ready("peer-1");
      await transport.ready;

      socket.readyState = FakeWebSocket.CLOSING;
      // Drop, don't buffer: the sync layer rolls back and regenerates after
      // the next handshake.
      await assert.rejects(
        transport.sendFrame(FrameType.PRESENCE, new Uint8Array([1, 2, 3])),
        /cloud sync socket is not open/,
      );
      assert.deepEqual(lost, []);

      socket.close({ code: 1006 });
      assert.equal(lost.length, 1);
      assert.match(lost[0], /cloud sync socket closed \(1006\)/);
      transport.disconnect();
    } finally {
      fake.restore();
    }
  });

  it("keeps connecting and retries when the socket closes before room readiness", async () => {
    const fake = installFakeWebSocket();
    const statuses: string[] = [];
    const lost: string[] = [];
    try {
      const transport = createTransport({
        onConnectionLost: (reason) => lost.push(reason.message),
        reconnectBaseDelayMs: 1,
        random: () => 0.5,
      });
      const subscription = transport.connectionStatus$.subscribe((status) => statuses.push(status));

      const first = await waitForSocket(0);
      first.close({ code: 1006 });
      await delayMs(10); // let the (tiny) retry delay elapse

      // Initial-connect failure rides the retry loop: status stays
      // "connecting" (never been online) and a fresh socket appears.
      const second = await waitForSocket(1);
      assert.notEqual(second, first);
      assert.equal(lost.length, 1);
      assert.deepEqual(statuses, ["connecting"]);

      subscription.unsubscribe();
      transport.disconnect();
    } finally {
      fake.restore();
    }
  });

  it("emits offline when manually disconnected after readiness", async () => {
    const fake = installFakeWebSocket();
    const statuses: string[] = [];
    try {
      const transport = createTransport();
      const subscription = transport.connectionStatus$.subscribe((status) => statuses.push(status));
      const socket = await waitForSocket(0);
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
      const transport = createTransport();
      const socket = await waitForSocket(0);
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
      const transport = createTransport();
      const socket = await waitForSocket(0);
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
      const transport = createTransport();
      const socket = await waitForSocket(0);
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

  it("recycles the connection when WebSocket.send throws", async () => {
    const fake = installFakeWebSocket();
    const lost: string[] = [];
    try {
      const transport = createTransport({
        onConnectionLost: (reason) => lost.push(reason.message),
        reconnectBaseDelayMs: 1,
        random: () => 0.5,
      });
      const socket = await waitForSocket(0);
      socket.open();
      socket.ready("peer-1");
      await transport.ready;

      socket.throwOnSend = true;
      await assert.rejects(
        transport.sendFrame(FrameType.PRESENCE, new Uint8Array([1, 2, 3])),
        /cloud sync socket send failed: synthetic send failure/,
      );
      assert.deepEqual(lost, ["cloud sync socket send failed: synthetic send failure"]);

      // The retry loop replaces the broken socket.
      await delayMs(10);
      await waitForSocket(1);
      transport.disconnect();
    } finally {
      fake.restore();
    }
  });

  it("recycles the connection when the bootstrap message cannot be decoded", async () => {
    const fake = installFakeWebSocket();
    const lost: string[] = [];
    try {
      const transport = createTransport({
        onConnectionLost: (reason) => lost.push(reason.message),
        reconnectBaseDelayMs: 1,
        random: () => 0.5,
      });
      const socket = await waitForSocket(0);
      socket.open();
      socket.message("not binary");
      await nextMicrotask();

      assert.equal(lost.length, 1);
      assert.match(lost[0], /cloud sync socket message failed: unsupported WebSocket message/);
      assert.equal(socket.readyState, FakeWebSocket.CLOSED);

      // ready is not rejected — the loop keeps trying until disconnect().
      await delayMs(10);
      const second = await waitForSocket(1);
      second.open();
      second.ready("peer-1");
      const ready = await transport.ready;
      assert.equal(ready.peer_id, "peer-1");
      transport.disconnect();
    } finally {
      fake.restore();
    }
  });

  it("recycles the connection when a post-ready message cannot be decoded", async () => {
    const fake = installFakeWebSocket();
    const lost: string[] = [];
    try {
      const transport = createTransport({
        onConnectionLost: (reason) => lost.push(reason.message),
        reconnectBaseDelayMs: 1,
        random: () => 0.5,
      });
      const socket = await waitForSocket(0);
      socket.open();
      socket.ready("peer-1");
      await transport.ready;

      socket.message("not binary");
      await nextMicrotask();

      assert.deepEqual(lost, [
        "cloud sync socket message failed: unsupported WebSocket message [object String]",
      ]);
      assert.equal(socket.readyState, FakeWebSocket.CLOSED);
      await assert.rejects(
        transport.sendFrame(FrameType.PRESENCE, new Uint8Array([1, 2, 3])),
        /cloud sync socket is not open/,
      );
      transport.disconnect();
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

describe("cloud transport reconnect loop", () => {
  it("resolves the connect target per attempt (fresh auth + operator nonce)", async () => {
    const fake = installFakeWebSocket();
    const minted: string[] = [];
    const authResolutions: string[] = [];
    try {
      // The REAL production factory: every transport attempt must re-resolve
      // auth and carry a freshly-minted operator nonce in the socket URL.
      const transport = createTransport({
        connectTarget: createCloudConnectTarget({
          syncEndpoint: "https://example.test/n/room/sync",
          resolveAuth: (sessionId) => {
            authResolutions.push(sessionId);
            return {
              headers: { Authorization: "Bearer token" },
              protocols: ["nteract-bearer.dG9rZW4", "nteract.v4"],
              user: null,
              operator: null,
              requestedScope: null,
            };
          },
          mintSessionId: () => {
            const id = mintCloudSessionId();
            minted.push(id);
            return id;
          },
        }),
        reconnectBaseDelayMs: 1,
        random: () => 0.5,
      });

      const first = await waitForSocket(0);
      first.close({ code: 1006 });
      await delayMs(10);
      const second = await waitForSocket(1);

      assert.equal(minted.length, 2);
      assert.notEqual(minted[0], minted[1]);
      assert.deepEqual(authResolutions, minted); // auth re-resolved per attempt
      assert.ok(first.url.includes(`operator=browser%3A${minted[0]}`));
      assert.ok(second.url.includes(`operator=browser%3A${minted[1]}`));
      transport.disconnect();
    } finally {
      fake.restore();
    }
  });

  it("emits roomReady$ per handshake with the fresh connection identity", async () => {
    const fake = installFakeWebSocket();
    const readyPeers: string[] = [];
    try {
      const transport = createTransport({ reconnectBaseDelayMs: 1, random: () => 0.5 });
      transport.roomReady$.subscribe((ready) => readyPeers.push(ready.peer_id));

      const first = await waitForSocket(0);
      first.open();
      first.ready("peer-1");
      const ready = await transport.ready;
      assert.equal(ready.peer_id, "peer-1");

      first.close({ code: 1006 });
      await delayMs(10);
      const second = await waitForSocket(1);
      second.open();
      second.ready("peer-2");
      await drainMicrotasks();

      assert.deepEqual(readyPeers, ["peer-1", "peer-2"]);
      transport.disconnect();
    } finally {
      fake.restore();
    }
  });

  it("replays the latest handshake to late roomReady$ subscribers", async () => {
    const fake = installFakeWebSocket();
    try {
      const transport = createTransport();
      const socket = await waitForSocket(0);
      socket.open();
      socket.ready("peer-1");
      await transport.ready;

      // A subscriber attaching after the handshake (the session wires up
      // once the runtime resolves) still observes the connection it must
      // adopt — closes the missed-reconnect-during-setup gap.
      const replayed: string[] = [];
      transport.roomReady$.subscribe((ready) => replayed.push(ready.peer_id));
      assert.deepEqual(replayed, ["peer-1"]);
      transport.disconnect();
    } finally {
      fake.restore();
    }
  });

  it("walks the status machine: connecting, online, reconnecting, online, offline", async () => {
    const fake = installFakeWebSocket();
    const statuses: string[] = [];
    try {
      const transport = createTransport({ reconnectBaseDelayMs: 1, random: () => 0.5 });
      const subscription = transport.connectionStatus$.subscribe((status) => statuses.push(status));

      const first = await waitForSocket(0);
      first.open();
      first.ready("peer-1");
      await transport.ready;

      first.close({ code: 1006 });
      await delayMs(10);
      const second = await waitForSocket(1);
      second.open();
      second.ready("peer-2");
      await drainMicrotasks();

      transport.disconnect();
      subscription.unsubscribe();

      assert.deepEqual(statuses, ["connecting", "online", "reconnecting", "online", "offline"]);
    } finally {
      fake.restore();
    }
  });

  it("rejects pending frame ACKs when the connection is lost", async () => {
    const fake = installFakeWebSocket();
    try {
      const transport = createTransport({ reconnectBaseDelayMs: 1, random: () => 0.5 });
      const socket = await waitForSocket(0);
      socket.open();
      socket.ready("peer-1");
      await transport.ready;

      const response = transport.sendRequest({ type: "execute_cell", cell_id: "cell-1" });
      await nextMicrotask();
      assert.equal(socket.sent.length, 1);

      // FIFO frame-type ACK matching cannot span sockets.
      socket.close({ code: 1006 });
      await assert.rejects(response, /cloud sync socket closed \(1006\)/);
      transport.disconnect();
    } finally {
      fake.restore();
    }
  });

  it("backs off exponentially, caps the delay, and resets on cloud_room_ready", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const fake = installFakeWebSocket();
    try {
      // random() = 0.5 makes the jitter factor exactly 1.0.
      const transport = createTransport({ random: () => 0.5 });

      // Attempt 0 connects immediately.
      const failAttempt = async (index: number) => {
        const socket = await waitForSocket(index);
        socket.close({ code: 1006 });
      };

      // Failed attempts schedule retries at 1s, 2s, 4s ... capped at 30s.
      const expectedDelays = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000];
      await failAttempt(0);
      for (const [index, delay] of expectedDelays.entries()) {
        t.mock.timers.tick(delay - 1);
        await drainMicrotasks();
        assert.equal(
          FakeWebSocket.instances.length,
          index + 1,
          `no early retry before ${delay}ms (attempt ${index + 1})`,
        );
        t.mock.timers.tick(1);
        await failAttempt(index + 1);
      }

      // A successful handshake resets the backoff to the base delay.
      t.mock.timers.tick(30_000);
      const recovered = await waitForSocket(expectedDelays.length + 1);
      recovered.open();
      recovered.ready("peer-1");
      await transport.ready;
      recovered.close({ code: 1006 });

      t.mock.timers.tick(999);
      await drainMicrotasks();
      assert.equal(FakeWebSocket.instances.length, expectedDelays.length + 2);
      t.mock.timers.tick(1);
      await waitForSocket(expectedDelays.length + 2);

      transport.disconnect();
    } finally {
      fake.restore();
    }
  });

  it("keeps retry delays within the ±50% jitter bounds", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const fake = installFakeWebSocket();
    try {
      // random() = 0 → 0.5× base; random() = 1 → 1.5× base.
      const low = createTransport({ random: () => 0 });
      (await waitForSocket(0)).close({ code: 1006 });
      t.mock.timers.tick(499);
      await drainMicrotasks();
      assert.equal(FakeWebSocket.instances.length, 1, "0.5×base lower bound holds");
      t.mock.timers.tick(1);
      await waitForSocket(1);
      low.disconnect();

      const high = createTransport({ random: () => 1 });
      (await waitForSocket(2)).close({ code: 1006 });
      t.mock.timers.tick(1_499);
      await drainMicrotasks();
      assert.equal(FakeWebSocket.instances.length, 3, "1.5×base upper bound holds");
      t.mock.timers.tick(1);
      await waitForSocket(3);
      high.disconnect();
    } finally {
      fake.restore();
    }
  });

  it("short-circuits the backoff wait on the browser online event", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const fake = installFakeWebSocket();
    const fakeWindow = installFakeWindow();
    try {
      const transport = createTransport({ random: () => 0.5 });
      (await waitForSocket(0)).close({ code: 1006 });
      // Burn a couple of attempts so the pending delay is long.
      t.mock.timers.tick(1_000);
      (await waitForSocket(1)).close({ code: 1006 });
      t.mock.timers.tick(2_000);
      (await waitForSocket(2)).close({ code: 1006 });

      // 4s wait pending; connectivity returns — reconnect immediately.
      fakeWindow.dispatchEvent(new Event("online"));
      await waitForSocket(3);

      transport.disconnect();
    } finally {
      fakeWindow.restore();
      fake.restore();
    }
  });

  it("recycles the live socket when the browser reports offline and recovers on online", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const fake = installFakeWebSocket();
    const fakeWindow = installFakeWindow();
    try {
      const lost: Error[] = [];
      const statuses: string[] = [];
      const transport = createTransport({
        random: () => 0.5,
        onConnectionLost: (reason) => lost.push(reason),
      });
      transport.connectionStatus$.subscribe((status) => statuses.push(status));
      const first = await waitForSocket(0);
      first.open();
      first.ready("peer-1");
      await transport.ready;
      assert.equal(statuses.at(-1), "online");

      // OS-level offline: the zombie socket would never fire close/error.
      // The browser event proactively tears it down and flips status.
      fakeWindow.dispatchEvent(new Event("offline"));
      assert.equal(lost.length, 1);
      assert.match(lost[0].message, /browser reported offline/);
      assert.equal(first.readyState, FakeWebSocket.CLOSED);
      assert.equal(statuses.at(-1), "reconnecting");

      // A second offline event with no socket is a no-op (no double loss).
      fakeWindow.dispatchEvent(new Event("offline"));
      assert.equal(lost.length, 1);

      // Connectivity returns: the online handler short-circuits the backoff.
      fakeWindow.dispatchEvent(new Event("online"));
      const second = await waitForSocket(1);
      second.open();
      second.ready("peer-2");
      await drainMicrotasks();
      assert.equal(statuses.at(-1), "online");

      transport.disconnect();
      // After manual disconnect the offline listener is unregistered.
      fakeWindow.dispatchEvent(new Event("offline"));
      assert.equal(lost.length, 1);
      assert.equal(statuses.at(-1), "offline");
    } finally {
      fakeWindow.restore();
      fake.restore();
    }
  });

  it("sends liveness pings after ready and a timely pong keeps the connection alive", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    const fake = installFakeWebSocket();
    try {
      const lost: Error[] = [];
      const transport = createTransport({
        livenessPingIntervalMs: 20_000,
        livenessPongDeadlineMs: 10_000,
        onConnectionLost: (reason) => lost.push(reason),
      });
      const socket = await waitForSocket(0);
      socket.open();
      socket.ready("peer-1");
      await transport.ready;
      assert.deepEqual(socket.sentText, [], "no ping before the interval elapses");

      t.mock.timers.tick(20_000);
      assert.deepEqual(socket.sentText, [LIVENESS_PING]);

      // Pong arrives within the deadline: the connection stays healthy
      // past the would-be deadline, and the next interval pings again.
      socket.message(LIVENESS_PONG);
      await drainMicrotasks();
      t.mock.timers.tick(10_000);
      await drainMicrotasks();
      assert.equal(lost.length, 0, "answered ping must not count as loss");

      t.mock.timers.tick(10_000);
      assert.deepEqual(socket.sentText, [LIVENESS_PING, LIVENESS_PING]);

      // Manual disconnect stops the probe.
      socket.message(LIVENESS_PONG);
      await drainMicrotasks();
      transport.disconnect();
      t.mock.timers.tick(60_000);
      assert.equal(socket.sentText.length, 2, "no pings after disconnect");
      assert.equal(lost.length, 0);
    } finally {
      fake.restore();
    }
  });

  it("treats a missed liveness pong as connection loss and restarts the probe on reconnect", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    const fake = installFakeWebSocket();
    try {
      const lost: Error[] = [];
      const statuses: string[] = [];
      const transport = createTransport({
        livenessPingIntervalMs: 20_000,
        livenessPongDeadlineMs: 10_000,
        random: () => 0,
        onConnectionLost: (reason) => lost.push(reason),
      });
      transport.connectionStatus$.subscribe((status) => statuses.push(status));
      const first = await waitForSocket(0);
      first.open();
      first.ready("peer-1");
      await transport.ready;

      t.mock.timers.tick(20_000);
      assert.deepEqual(first.sentText, [LIVENESS_PING]);

      // The zombie socket stays OPEN and never answers. One tick before
      // the deadline nothing happens; at the deadline the link is declared
      // dead even though no close/error event ever fired.
      t.mock.timers.tick(9_999);
      await drainMicrotasks();
      assert.equal(lost.length, 0);
      t.mock.timers.tick(1);
      assert.equal(lost.length, 1);
      assert.match(lost[0].message, /liveness pong missed/);
      assert.equal(statuses.at(-1), "reconnecting");

      // Retry (random()=0 → 0.5×base = 500ms), then the probe restarts on
      // the NEW connection — the old interval is gone.
      t.mock.timers.tick(500);
      const second = await waitForSocket(1);
      second.open();
      second.ready("peer-2");
      await drainMicrotasks();
      assert.equal(statuses.at(-1), "online");

      t.mock.timers.tick(20_000);
      assert.deepEqual(second.sentText, [LIVENESS_PING]);
      assert.equal(first.sentText.length, 1, "stale probe must not ping the dead socket");

      transport.disconnect();
    } finally {
      fake.restore();
    }
  });

  it("processes a sync frame arriving immediately after a reconnect ready AFTER the re-establish", async () => {
    const fake = installFakeWebSocket();
    const order: string[] = [];
    try {
      const transport = createTransport({ reconnectBaseDelayMs: 1, random: () => 0.5 });
      const first = await waitForSocket(0);
      first.open();
      first.ready("peer-1");
      await transport.ready;

      transport.onFrame((frame) => order.push(`frame:${frame[0]}`));
      transport.roomReady$.subscribe((ready) => order.push(`ready:${ready.peer_id}`));
      assert.deepEqual(order, ["ready:peer-1"]); // replayed handshake

      first.close({ code: 1006 });
      await delayMs(10);
      const second = await waitForSocket(1);
      second.open();
      // The room host kicks sync immediately after ready: the sync frame
      // lands right behind the handshake. Subscribers (the session's
      // synchronous re-establish) must run before the frame is dispatched.
      second.ready("peer-2");
      second.message(new Uint8Array([FrameType.AUTOMERGE_SYNC, 9]).buffer);
      await drainMicrotasks();

      assert.deepEqual(order, ["ready:peer-1", "ready:peer-2", "frame:0"]);
      transport.disconnect();
    } finally {
      fake.restore();
    }
  });

  it("delivers an edit made while disconnected after the reconnect resync, with continuity", async () => {
    const fake = installFakeWebSocket();
    try {
      const transport = createTransport({ reconnectBaseDelayMs: 1, random: () => 0.5 });
      const first = await waitForSocket(0);
      first.open();
      first.ready("peer-1");
      const ready = await transport.ready;

      // Mock SyncableHandle with claim/rollback semantics for local edits.
      const handleCalls: string[] = [];
      let pendingEdit: Uint8Array | null = null;
      let claimedEdit: Uint8Array | null = null;
      const handle: SyncableHandle = {
        receive_frame: (bytes) =>
          bytes[0] === FrameType.AUTOMERGE_SYNC
            ? [
                {
                  type: "sync_applied",
                  changed: true,
                  changeset: {
                    changed: [{ cell_id: "c1", fields: { source: true } }],
                    added: [],
                    removed: [],
                    order_changed: false,
                  },
                },
              ]
            : [],
        flush_local_changes: () => {
          const edit = pendingEdit;
          if (edit) {
            claimedEdit = edit;
            pendingEdit = null;
          }
          return edit;
        },
        cancel_last_flush: () => {
          handleCalls.push("cancel_last_flush");
          pendingEdit = claimedEdit;
          claimedEdit = null;
        },
        flush_runtime_state_sync: () => null,
        cancel_last_runtime_state_flush: () => undefined,
        generate_runtime_state_sync_reply: () => null,
        flush_comms_doc_sync: () => null,
        cancel_last_comms_doc_flush: () => undefined,
        generate_comms_doc_sync_reply: () => null,
        flush_pool_state_sync: () => null,
        cancel_last_pool_state_flush: () => undefined,
        generate_pool_state_sync_reply: () => null,
        reset_sync_state: () => {
          handleCalls.push("reset_sync_state");
        },
        cell_count: () => 1,
        get_heads_hex: () => ["aa"],
        get_dependency_fingerprint: () => undefined,
      };
      const setActorCalls: string[] = [];
      const engine = new SyncEngine({
        getHandle: () => handle,
        transport,
        presenceHeartbeat: { intervalMs: 60_000, encode: () => new Uint8Array([0]) },
        flushDeliveryTimeoutMs: 50,
      });
      startCloudBootstrapSync(engine);

      // The session-shaped roomReady$ wiring, through the PRODUCTION
      // adoption seam: identity dedup + synchronous re-establish on every
      // handshake after the one already adopted.
      const identity = cloudConnectionIdentityFromReady(ready);
      transport.roomReady$.subscribe((next) => {
        applyCloudRoomReady(identity, next, () =>
          reestablishCloudConnection(
            { set_actor: (label: string) => setActorCalls.push(label) },
            engine,
            next.actor_label,
          ),
        );
      });

      // Continuity seam: the cellChanges$ subscription must survive the
      // reconnect (no engine restart, no projection blanking).
      const changesets: unknown[] = [];
      engine.cellChanges$.subscribe((changeset) => changesets.push(changeset));

      // Connection drops; an edit lands while offline.
      first.close({ code: 1006 });
      pendingEdit = new Uint8Array([42]);
      engine.flush();
      await delayMs(10);
      // The send was dropped (not buffered) and rolled back into the handle.
      assert.deepEqual(handleCalls, ["cancel_last_flush"]);
      assert.deepEqual(pendingEdit, new Uint8Array([42]));

      // Reconnect: handshake replay triggers the synchronous re-establish,
      // and the resync flush delivers the preserved edit.
      const second = await waitForSocket(1);
      second.open();
      second.ready("peer-2");
      await delayMs(10);
      assert.deepEqual(setActorCalls, ["user:dev:alice/desktop:peer-2"]);
      assert.equal(identity.peerId, "peer-2"); // presence identity adopted
      assert.ok(handleCalls.includes("reset_sync_state"));
      const syncFrames = second.sent.filter((frame) => frame[0] === FrameType.AUTOMERGE_SYNC);
      assert.equal(syncFrames.length, 1);
      assert.deepEqual(Array.from(syncFrames[0].slice(1)), [42]);

      // Inbound sync after the reconnect still reaches the ORIGINAL
      // subscription — engine and consumers were preserved throughout.
      second.message(new Uint8Array([FrameType.AUTOMERGE_SYNC, 7]).buffer);
      await delayMs(60); // cellChanges$ coalesces on a 32ms buffer
      assert.equal(changesets.length, 1);

      engine.stop();
      transport.disconnect();
    } finally {
      fake.restore();
    }
  });

  it("discards frames queued from a dead connection instead of replaying them", async () => {
    const fake = installFakeWebSocket();
    try {
      const transport = createTransport({ reconnectBaseDelayMs: 1, random: () => 0.5 });
      const first = await waitForSocket(0);
      first.open();
      first.ready("peer-1");
      await transport.ready;

      // A frame arrives before any onFrame listener exists (the engine
      // attaches after ready) and the connection then dies: the frame is
      // bound to connection 1's sync state and must never replay into
      // connection 2's.
      first.message(new Uint8Array([FrameType.AUTOMERGE_SYNC, 11]).buffer);
      await drainMicrotasks();
      first.close({ code: 1006 });

      await delayMs(10);
      const second = await waitForSocket(1);
      second.open();
      second.ready("peer-2");
      await drainMicrotasks();

      const frames: number[][] = [];
      transport.onFrame((frame) => frames.push(frame));
      assert.deepEqual(frames, []); // stale frame discarded, not replayed

      second.message(new Uint8Array([FrameType.AUTOMERGE_SYNC, 22]).buffer);
      await drainMicrotasks();
      assert.deepEqual(frames, [[FrameType.AUTOMERGE_SYNC, 22]]);
      transport.disconnect();
    } finally {
      fake.restore();
    }
  });

  it("does not reset the backoff on WS open without cloud_room_ready", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const fake = installFakeWebSocket();
    try {
      const transport = createTransport({ random: () => 0.5, handshakeTimeoutMs: 100 });

      // Two failed attempts: delays 1000, 2000.
      (await waitForSocket(0)).close({ code: 1006 });
      t.mock.timers.tick(1_000);
      (await waitForSocket(1)).close({ code: 1006 });
      t.mock.timers.tick(2_000);

      // Attempt 2 OPENS but never readies (LB accepts the socket while the
      // room is unreachable). WS open alone must not reset the counter.
      const opened = await waitForSocket(2);
      opened.open();
      opened.close({ code: 1006 });

      // The next delay must continue escalating (4000), not reset to base.
      t.mock.timers.tick(3_999);
      await drainMicrotasks();
      assert.equal(FakeWebSocket.instances.length, 3, "no retry before the escalated delay");
      t.mock.timers.tick(1);
      await waitForSocket(3);

      transport.disconnect();
    } finally {
      fake.restore();
    }
  });

  it("recycles an attempt whose handshake never completes", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const fake = installFakeWebSocket();
    const lost: string[] = [];
    try {
      const transport = createTransport({
        onConnectionLost: (reason) => lost.push(reason.message),
        random: () => 0.5,
        handshakeTimeoutMs: 100,
      });

      // The socket opens but the room never sends cloud_room_ready.
      const hung = await waitForSocket(0);
      hung.open();
      t.mock.timers.tick(100);
      await drainMicrotasks();

      assert.equal(lost.length, 1);
      assert.match(lost[0], /handshake did not complete within 100ms/);
      assert.equal(hung.readyState, FakeWebSocket.CLOSED);

      // The attempt rides the normal backoff instead of dead-ending.
      t.mock.timers.tick(1_000);
      const retry = await waitForSocket(1);
      retry.open();
      retry.ready("peer-1");
      const ready = await transport.ready;
      assert.equal(ready.peer_id, "peer-1");
      transport.disconnect();
    } finally {
      fake.restore();
    }
  });

  it("rides the retry loop when connectTarget rejects (auth re-resolution failure)", async () => {
    const fake = installFakeWebSocket();
    const lost: string[] = [];
    let attempts = 0;
    try {
      const transport = createTransport({
        connectTarget: async () => {
          attempts += 1;
          if (attempts === 1) {
            throw new Error("token refresh 401");
          }
          return { url: new URL("wss://example.test/n/room/sync"), protocols: [] };
        },
        onConnectionLost: (reason) => lost.push(reason.message),
        reconnectBaseDelayMs: 1,
        random: () => 0.5,
      });

      await delayMs(10);
      const socket = await waitForSocket(0); // attempt 2's socket
      socket.open();
      socket.ready("peer-1");
      const ready = await transport.ready;

      assert.equal(attempts, 2);
      assert.equal(lost.length, 1);
      assert.match(lost[0], /connect target failed: token refresh 401/);
      assert.equal(ready.peer_id, "peer-1");
      transport.disconnect();
    } finally {
      fake.restore();
    }
  });

  it("recycles a hung connectTarget through the per-attempt budget", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const fake = installFakeWebSocket();
    const lost: string[] = [];
    let attempts = 0;
    try {
      const transport = createTransport({
        connectTarget: () => {
          attempts += 1;
          if (attempts === 1) {
            return new Promise(() => undefined); // hung auth fetch
          }
          return Promise.resolve({
            url: new URL("wss://example.test/n/room/sync"),
            protocols: [],
          });
        },
        onConnectionLost: (reason) => lost.push(reason.message),
        random: () => 0.5,
        handshakeTimeoutMs: 100,
      });

      // No socket, no handshake timer, no retry timer — the per-attempt
      // budget must still recycle the attempt.
      t.mock.timers.tick(100);
      await drainMicrotasks();
      assert.equal(lost.length, 1);
      assert.match(lost[0], /connect target did not settle within 100ms/);

      t.mock.timers.tick(1_000); // backoff after the failed attempt
      const socket = await waitForSocket(0);
      socket.open();
      socket.ready("peer-1");
      const ready = await transport.ready;
      assert.equal(ready.peer_id, "peer-1");
      assert.equal(attempts, 2);
      transport.disconnect();
    } finally {
      fake.restore();
    }
  });

  it("lets the browser online event supersede a parked connectTarget await", async () => {
    const fake = installFakeWebSocket();
    const fakeWindow = installFakeWindow();
    let attempts = 0;
    try {
      const transport = createTransport({
        connectTarget: () => {
          attempts += 1;
          if (attempts === 1) {
            return new Promise(() => undefined); // hung auth fetch
          }
          return Promise.resolve({
            url: new URL("wss://example.test/n/room/sync"),
            protocols: [],
          });
        },
        // Keeps the superseded attempt's per-attempt budget timer short so
        // the test process is not held open by a 30s real timer.
        handshakeTimeoutMs: 50,
      });
      await drainMicrotasks();
      assert.equal(FakeWebSocket.instances.length, 0); // parked in attempt 1

      // Connectivity returns while attempt 1 is parked awaiting auth: the
      // online event supersedes it (epoch bump discards the late target).
      fakeWindow.dispatchEvent(new Event("online"));
      const socket = await waitForSocket(0);
      socket.open();
      socket.ready("peer-1");
      const ready = await transport.ready;
      assert.equal(ready.peer_id, "peer-1");
      assert.equal(attempts, 2);
      transport.disconnect();
    } finally {
      fakeWindow.restore();
      fake.restore();
    }
  });

  it("rejects sends in the open-to-ready handshake window", async () => {
    const fake = installFakeWebSocket();
    try {
      const transport = createTransport({ reconnectBaseDelayMs: 1, random: () => 0.5 });
      const first = await waitForSocket(0);
      first.open();
      // Socket OPEN but cloud_room_ready not yet handled: frames would go
      // out under the previous connection's sync state and actor.
      await assert.rejects(
        transport.sendFrame(FrameType.PRESENCE, new Uint8Array([1])),
        /cloud sync connection is not ready/,
      );

      first.ready("peer-1");
      await transport.ready;
      await transport.sendFrame(FrameType.PRESENCE, new Uint8Array([2]));
      assert.equal(first.sent.length, 1);

      // The same gate applies per reconnect attempt.
      first.close({ code: 1006 });
      await delayMs(10);
      const second = await waitForSocket(1);
      second.open();
      await assert.rejects(
        transport.sendFrame(FrameType.PRESENCE, new Uint8Array([3])),
        /cloud sync connection is not ready/,
      );
      second.ready("peer-2");
      await drainMicrotasks();
      await transport.sendFrame(FrameType.PRESENCE, new Uint8Array([4]));
      assert.equal(second.sent.length, 1);
      transport.disconnect();
    } finally {
      fake.restore();
    }
  });
});

describe("cloud reconnect session policies", () => {
  it("re-establishes in the safe order: set_actor, resetForBootstrap, resetAndResync", () => {
    const calls: string[] = [];
    reestablishCloudConnection(
      { set_actor: () => calls.push("set_actor") },
      {
        resetForBootstrap: () => calls.push("resetForBootstrap"),
        resetAndResync: () => calls.push("resetAndResync"),
      },
      "user:dev:alice/browser:fresh",
    );
    assert.deepEqual(calls, ["set_actor", "resetForBootstrap", "resetAndResync"]);
  });

  it("tracks rejection strikes: first resyncs in place, post-delivery repeats escalate", () => {
    const tracker = new CloudRecoverableRejectionTracker();
    assert.equal(tracker.record(true), "resync_in_place");
    tracker.resyncSettled();
    assert.equal(tracker.record(true), "escalate");
    assert.equal(tracker.record(true), "escalate");
  });

  it("absorbs pipelined rejections that cannot have observed the in-flight resync", () => {
    // Several AUTOMERGE_SYNC frames are routinely outstanding and acks
    // carry no id: rejections arriving before the strike-1 resync's flush
    // was delivered are the same divergence event, never escalation
    // evidence — the poison-pill discard must not fire from them.
    const tracker = new CloudRecoverableRejectionTracker();
    assert.equal(tracker.record(true), "resync_in_place");
    assert.equal(tracker.record(true), "absorb");
    assert.equal(tracker.record(true), "absorb");
    tracker.resyncSettled();
    assert.equal(tracker.record(true), "escalate");
  });

  it("escalates immediately when no runtime exists and resets per connection", () => {
    const tracker = new CloudRecoverableRejectionTracker();
    // No runtime yet (rejection during connect): nothing to resync in place.
    assert.equal(tracker.record(false), "escalate");

    // A fresh cloud_room_ready resets the strike count AND any pending
    // resync gate from the previous connection.
    tracker.reset();
    assert.equal(tracker.record(true), "resync_in_place");
    tracker.reset();
    assert.equal(tracker.record(true), "resync_in_place");
  });

  it("adopts a handshake once: dedup, identity update, then re-establish", () => {
    const identity = cloudConnectionIdentityFromReady({
      type: "cloud_room_ready",
      protocol: "v4",
      notebook_id: "room",
      peer_id: "peer-1",
      actor_label: "user:dev:alice/browser:one",
      connection_scope: "editor",
      room_peer_count: 1,
      timestamp: "2026-06-11T00:00:00.000Z",
    });
    const reestablishes: string[] = [];

    // Replayed handshake for the connection already adopted: no-op.
    assert.equal(
      applyCloudRoomReady(
        identity,
        {
          type: "cloud_room_ready",
          protocol: "v4",
          notebook_id: "room",
          peer_id: "peer-1",
          actor_label: "user:dev:alice/browser:one",
          connection_scope: "editor",
          room_peer_count: 1,
          timestamp: "2026-06-11T00:00:00.000Z",
        },
        () => reestablishes.push(identity.peerId),
      ),
      false,
    );
    assert.deepEqual(reestablishes, [] as string[]);

    // Fresh connection: identity updated BEFORE the re-establish runs, so
    // presence encoders already stamp the new peer id during the resync.
    assert.equal(
      applyCloudRoomReady(
        identity,
        {
          type: "cloud_room_ready",
          protocol: "v4",
          notebook_id: "room",
          peer_id: "peer-2",
          actor_label: "user:dev:alice/browser:two",
          connection_scope: "viewer",
          room_peer_count: 2,
          timestamp: "2026-06-11T00:00:01.000Z",
        },
        () => reestablishes.push(identity.peerId),
      ),
      true,
    );
    assert.deepEqual(reestablishes, ["peer-2"]);
    assert.equal(identity.actorLabel, "user:dev:alice/browser:two");
    assert.equal(identity.connectionScope, "viewer");
    assert.equal(
      identity.peerLabel,
      cloudRoomReadyPeerLabel({ actor_label: "user:dev:alice/browser:two" }),
    );
  });

  it("clears the seed only after the teardown flush settles, and never rejects", async () => {
    const order: string[] = [];
    let releaseDispose!: () => void;
    const disposeRuntime = () =>
      new Promise<void>((resolve) => {
        releaseDispose = () => {
          order.push("dispose_settled");
          resolve();
        };
      });

    const chain = discardPersistedSeedAfterTeardown(disposeRuntime, async () => {
      order.push("clear");
    });
    await delayMs(5);
    // The teardown flushNow re-writes the record with the rejected changes;
    // clearing before it settles would leave the poison record behind.
    assert.deepEqual(order, []);
    releaseDispose();
    await chain;
    assert.deepEqual(order, ["dispose_settled", "clear"]);

    // Clear failures are swallowed (the chain gates the next attempt's
    // persistence arming, so it must never reject).
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      await discardPersistedSeedAfterTeardown(
        () => Promise.reject(new Error("dispose failed")),
        () => Promise.reject(new Error("clear failed")),
      );
    } finally {
      console.warn = originalWarn;
    }
  });

  it("mints a fresh operator nonce and re-resolves auth per connect target call", async () => {
    const resolvedFor: string[] = [];
    const connectTarget = createCloudConnectTarget({
      syncEndpoint: "https://cloud.test/n/demo/sync",
      resolveAuth: (sessionId) => {
        resolvedFor.push(sessionId);
        return {
          headers: { Authorization: "Bearer token" },
          protocols: ["nteract-bearer.dG9rZW4", "nteract.v4"],
          user: null,
          operator: null,
          requestedScope: null,
        };
      },
    });

    const first = await connectTarget();
    const second = await connectTarget();

    assert.equal(resolvedFor.length, 2);
    assert.notEqual(resolvedFor[0], resolvedFor[1]);
    assert.equal(
      first.url.searchParams.get("operator"),
      `browser:${encodeURIComponent(resolvedFor[0])}`,
    );
    assert.equal(
      second.url.searchParams.get("operator"),
      `browser:${encodeURIComponent(resolvedFor[1])}`,
    );
    assert.deepEqual(first.protocols, ["nteract-bearer.dG9rZW4", "nteract.v4"]);
  });
});

function createTransport(
  overrides: Partial<CloudWebSocketTransportOptions> = {},
): CloudWebSocketTransport {
  return new CloudWebSocketTransport({
    connectTarget: async () => ({
      url: new URL("wss://example.test/n/room/sync"),
      protocols: [],
    }),
    ...overrides,
  });
}

/** Connect attempts resolve their target asynchronously; wait for socket N. */
async function waitForSocket(index: number): Promise<FakeWebSocket> {
  for (let i = 0; i < 50 && FakeWebSocket.instances.length <= index; i++) {
    await nextMicrotask();
  }
  const socket = FakeWebSocket.instances[index];
  assert.ok(socket, `expected WebSocket instance ${index}`);
  return socket;
}

async function drainMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await nextMicrotask();
  }
}

function delayMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function installFakeWindow(): { dispatchEvent: (event: Event) => void; restore: () => void } {
  const target = new EventTarget();
  const original = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = target;
  return {
    dispatchEvent: (event) => target.dispatchEvent(event),
    restore: () => {
      (globalThis as { window?: unknown }).window = original;
    },
  };
}

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
  /** Text sends (liveness pings) recorded separately from binary frames. */
  sentText: string[] = [];
  readonly url: string;

  constructor(url?: unknown) {
    super();
    this.url = String(url ?? "");
    FakeWebSocket.instances.push(this);
  }

  send(data: unknown): void {
    if (this.throwOnSend) {
      throw new Error("synthetic send failure");
    }
    if (typeof data === "string") {
      this.sentText.push(data);
      return;
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
