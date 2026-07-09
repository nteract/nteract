import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type {
  CloudflareWebSocket,
  D1Database,
  D1PreparedStatement,
  D1Result,
  DurableObjectNamespace,
  DurableObjectState,
  Env,
} from "../src/cloudflare-types.ts";
import {
  NOTEBOOK_CLOUD_WEBSOCKET_PROTOCOL,
  TRUSTED_WEBSOCKET_PROTOCOL_HEADER,
  authenticateAnonymousViewer,
  authenticateDevRequest,
  stampTrustedIdentity,
} from "../src/identity.ts";
import {
  NotebookRoom,
  RUNTIME_IDLE_TTL_MS,
  presencePeerLabel,
  rejectedFramePolicy,
  runtimePeerWorkstationMetadataFromRequest,
  rewritePresenceFrame,
  shouldBroadcastFrame,
  webSocketUpgradeHeaders,
} from "../src/notebook-room.ts";
import {
  FrameType,
  LIVENESS_PING,
  LIVENESS_PONG,
  decodeJsonPayload,
  encodeTypedFrame,
  splitTypedFrame,
} from "../src/protocol.ts";
import { decodePresenceFrame, encodePresenceFrame } from "../src/runtimed-wasm.ts";
import { RoomMaterializer, type RoomHostFrameResult } from "../src/room-materializer.ts";
import { roomSummaryKey, type NotebookRoomSummary } from "../src/storage.ts";
import { initializeTestRuntimedWasm } from "./runtimed-wasm-test-loader.ts";

before(async () => {
  await initializeTestRuntimedWasm();
});

describe("NotebookRoom presence rewrite", () => {
  it("builds room-ready rosters from current peers", () => {
    const room = new NotebookRoom(fakeState(), {} as Env);
    const harness = roomHarness(room);
    const ownerIdentity = authenticateDevRequest(
      new Request("https://cloud.test/n/demo/sync?user=alice&operator=browser:a&scope=owner"),
    );
    const runtimeIdentity = authenticateDevRequest(
      new Request(
        "https://cloud.test/n/demo/sync?user=alice&operator=runtime:py&scope=runtime_peer",
      ),
    );
    harness.peers.set("owner", {
      id: "owner",
      socket: new FakeSocket().asCloudflareWebSocket(),
      identity: {
        ...ownerIdentity,
        metadata: {
          ...ownerIdentity.metadata,
          displayName: "Alice Demo",
        },
      },
      connectedAt: "2026-06-13T00:00:00.000Z",
      consecutiveRejectedFrames: 0,
    });
    harness.peers.set("runtime", {
      id: "runtime",
      socket: new FakeSocket().asCloudflareWebSocket(),
      identity: runtimeIdentity,
      connectedAt: "2026-06-13T00:00:01.000Z",
      consecutiveRejectedFrames: 0,
    });

    const roster = harness.roomPeerRoster();

    assert.deepEqual(
      roster.map((peer) => ({
        peer_id: peer.peer_id,
        actor_label: peer.actor_label,
        connection_scope: peer.connection_scope,
        participant_key: peer.participant_key,
        display_name: peer.display_name,
      })),
      [
        {
          peer_id: "owner",
          actor_label: "user:dev:alice/browser:a",
          connection_scope: "owner",
          participant_key: "user:dev:alice",
          display_name: "Alice Demo",
        },
        {
          peer_id: "runtime",
          actor_label: "user:dev:alice/runtime:py",
          connection_scope: "runtime_peer",
          participant_key: "user:dev:alice",
          display_name: "alice",
        },
      ],
    );
  });

  it("rewrites canonical CBOR presence to the server peer and friendly display label", async () => {
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
    assert.equal(body.peer_label, "alice");
    assert.equal(body.actor_label, "user:dev:alice/agent:codex:s1");
  });

  it("uses display name, email, then principal for rewritten presence peer labels", () => {
    const baseIdentity = authenticateDevRequest(
      new Request("https://cloud.test/n/demo/sync?user=alice&operator=browser:a&scope=editor"),
    );
    const withoutDisplayName = {
      ...baseIdentity,
      metadata: {
        provider: baseIdentity.metadata.provider,
        transport: baseIdentity.metadata.transport,
        principalNamespace: baseIdentity.metadata.principalNamespace,
        email: "alice@example.com",
      },
    };
    const withoutFriendlyMetadata = {
      ...baseIdentity,
      metadata: {
        provider: baseIdentity.metadata.provider,
        transport: baseIdentity.metadata.transport,
        principalNamespace: baseIdentity.metadata.principalNamespace,
      },
    };

    assert.equal(presencePeerLabel(baseIdentity), "alice");
    assert.equal(presencePeerLabel(withoutDisplayName), "alice@example.com");
    assert.equal(presencePeerLabel(withoutFriendlyMetadata), "alice");
  });

  it("keeps rewritten Anaconda presence labels human-scale when metadata is missing", () => {
    const identity = {
      ...authenticateDevRequest(
        new Request("https://cloud.test/n/demo/sync?user=alice&operator=browser:a&scope=editor"),
      ),
      principal: "user:anaconda:fe0f6c3a-f7c7-4c04-9b8d-77e596da1375",
      metadata: {
        provider: "oidc" as const,
        transport: "oidc-bearer" as const,
        principalNamespace: "user:anaconda",
      },
    };

    assert.equal(presencePeerLabel(identity), "Anaconda user fe0f6c3a");
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
    assert.equal(body.peer_label, "alice");
  });

  it("rewrites notebook interaction presence targets", async () => {
    const identity = authenticateDevRequest(
      new Request("https://cloud.test/n/demo/sync?user=alice&operator=desktop:a&scope=editor"),
    );
    const payload = await encodePresenceFrame({
      type: "update",
      peer_id: "client-peer",
      peer_label: "Mallory",
      actor_label: "user:dev:mallory/agent:codex:s1",
      channel: "interaction",
      data: { kind: "output", cell_id: "cell-plot" },
    });
    const frame = splitTypedFrame(encodeTypedFrame(FrameType.PRESENCE, payload));

    const rewritten = await rewritePresenceFrame(frame, { id: "server-peer", identity });
    const body = (await decodePresenceFrame(rewritten.payload)) as Record<string, unknown>;

    assert.equal(rewritten.type, FrameType.PRESENCE);
    assert.equal(body.peer_id, "server-peer");
    assert.equal(body.peer_label, "alice");
    assert.equal(body.actor_label, "user:dev:alice/agent:codex:s1");
    assert.deepEqual(body.data, { kind: "output", cell_id: "cell-plot" });
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

  it("drops unsupported presence payloads without surfacing a room load rejection", async () => {
    const room = new NotebookRoom(fakeState(), {} as Env);
    const identity = authenticateDevRequest(
      new Request("https://cloud.test/n/demo/sync?user=alice&operator=desktop:a&scope=editor"),
    );
    const socket = new FakeSocket();
    const peer = {
      id: "peer-a",
      socket: socket.asCloudflareWebSocket(),
      identity,
      connectedAt: "2026-05-22T00:00:00.000Z",
      consecutiveRejectedFrames: 0,
    };
    const harness = roomHarness(room);
    harness.peers.set(peer.id, peer);

    await harness.handleMessage(
      "demo",
      peer,
      encodeTypedFrame(
        FrameType.PRESENCE,
        new TextEncoder().encode(JSON.stringify({ actor_label: identity.actorLabel })),
      ),
    );

    assert.equal(peer.consecutiveRejectedFrames, 1);
    assert.equal(socket.sent.length, 0, "bad presence should not send cloud_frame_rejected");
    assert.equal(socket.closed, false);
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

  it("broadcasts authenticated presence without durable room history", async () => {
    const room = new NotebookRoom(fakeState(), {} as Env);
    const identity = authenticateDevRequest(
      new Request("https://cloud.test/n/demo/sync?user=alice&operator=desktop:a&scope=editor"),
    );
    const socket = new FakeSocket();
    const peer = {
      id: "peer-a",
      socket: socket.asCloudflareWebSocket(),
      identity,
      connectedAt: "2026-05-22T00:00:00.000Z",
      consecutiveRejectedFrames: 0,
    };
    const harness = roomHarness(room);
    let broadcasted = 0;
    harness.peers.set(peer.id, peer);
    harness.broadcastFrame = () => {
      broadcasted += 1;
    };
    const message = encodeTypedFrame(
      FrameType.PRESENCE,
      await encodePresenceFrame({
        type: "heartbeat",
        peer_id: "client-peer",
      }),
    );

    await harness.handleMessage("demo", peer, message);

    assert.equal(broadcasted, 1);
    assert.equal(socket.sent.length, 1);
    assert.equal(
      decodeJsonPayload<Record<string, unknown>>(socket.sent[0].slice(1)).type,
      "cloud_frame_accepted",
    );
    assert.equal(peer.consecutiveRejectedFrames, 0);
  });
});

describe("NotebookRoom rejected frame policy", () => {
  it("allows a bounded streak of rejected frames before closing the peer", () => {
    let consecutiveRejectedFrames = 0;
    for (let i = 1; i < 8; i += 1) {
      const policy = rejectedFramePolicy(consecutiveRejectedFrames, 8);
      consecutiveRejectedFrames = policy.consecutiveRejectedFrames;
      assert.equal(policy.shouldClose, false);
      assert.equal(policy.consecutiveRejectedFrames, i);
    }

    const policy = rejectedFramePolicy(consecutiveRejectedFrames, 8);
    assert.equal(policy.consecutiveRejectedFrames, 8);
    assert.equal(policy.shouldClose, true);
  });

  it("normalizes invalid limits to one rejected frame", () => {
    assert.deepEqual(rejectedFramePolicy(0, 0), {
      consecutiveRejectedFrames: 1,
      limit: 1,
      shouldClose: true,
    });
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

  it("reads bounded runtime-peer workstation metadata from upgrade headers", () => {
    const request = new Request("https://cloud.test/n/demo/sync", {
      headers: {
        "x-nteract-workstation-id": "ws-lab2",
        "x-nteract-workstation-display-name": "Lab2 workstation",
        "x-nteract-workstation-default-environment": "Current Python",
        "x-nteract-workstation-environment-policy": "current_python",
        "x-nteract-runtime-session-id": "job-123",
        "x-nteract-workstation-working-directory": `${"/srv/".repeat(200)}project`,
      },
    });
    const runtimeIdentity = authenticateDevRequest(
      new Request("https://cloud.test/n/demo/sync?user=runtime&scope=runtime_peer"),
    );
    const viewerIdentity = authenticateDevRequest(
      new Request("https://cloud.test/n/demo/sync?user=viewer&scope=viewer"),
    );

    const metadata = runtimePeerWorkstationMetadataFromRequest(request, runtimeIdentity);

    assert.equal(metadata?.workstationId, "ws-lab2");
    assert.equal(metadata?.displayName, "Lab2 workstation");
    assert.equal(metadata?.defaultEnvironmentLabel, "Current Python");
    assert.equal(metadata?.environmentPolicy, "current_python");
    assert.equal(metadata?.runtimeSessionId, "job-123");
    assert.equal(metadata?.workingDirectory?.length, 512);
    assert.equal(runtimePeerWorkstationMetadataFromRequest(request, viewerIdentity), null);
  });

  it("closes peers after repeated rejected frames without echoing the threshold rejection", async () => {
    const room = new NotebookRoom(fakeState(), {} as Env);
    const identity = authenticateDevRequest(
      new Request("https://cloud.test/n/demo/sync?user=alice&operator=desktop:a&scope=editor"),
    );
    const socket = new FakeSocket();
    const peer = {
      id: "peer-a",
      socket: socket.asCloudflareWebSocket(),
      identity,
      connectedAt: "2026-05-22T00:00:00.000Z",
      consecutiveRejectedFrames: 0,
    };
    const harness = roomHarness(room);
    harness.peers.set(peer.id, peer);
    harness.materializers.set("demo", fakeMaterializer(noopMaterializedResult()));

    for (let i = 0; i < 7; i += 1) {
      await harness.handleMessage("demo", peer, "not-a-binary-frame");
    }

    assert.equal(socket.closed, false);
    assert.equal(socket.sent.length, 7);
    assert(
      socket.sent.every(
        (frame) =>
          frame[0] === FrameType.SESSION_CONTROL &&
          decodeJsonPayload<Record<string, unknown>>(frame.slice(1)).type ===
            "cloud_frame_rejected",
      ),
    );

    await harness.handleMessage("demo", peer, "not-a-binary-frame");

    assert.equal(socket.closed, true);
    assert.equal(socket.closeCode, 1008);
    assert.equal(socket.closeReason, "too many rejected frames");
    assert.equal(harness.peers.has(peer.id), false);
    assert.equal(
      socket.sent.length,
      7,
      "the close-triggering rejection should not echo another control frame",
    );
  });

  it("arms the CF auto-response liveness pair when the runtime supports it", () => {
    const pairs: Array<{ request: string; response: string }> = [];
    class PairCtor {
      constructor(
        readonly request: string,
        readonly response: string,
      ) {}
    }
    const globals = globalThis as { WebSocketRequestResponsePair?: unknown };
    const original = globals.WebSocketRequestResponsePair;
    globals.WebSocketRequestResponsePair = PairCtor;
    try {
      const state = fakeState() as DurableObjectState & {
        setWebSocketAutoResponse?: (pair: { request: string; response: string }) => void;
      };
      state.setWebSocketAutoResponse = (pair) => pairs.push(pair);
      new NotebookRoom(state, {} as Env);
      assert.equal(pairs.length, 1);
      assert.equal(pairs[0].request, LIVENESS_PING);
      assert.equal(pairs[0].response, LIVENESS_PONG);

      // Hibernation wake = a fresh constructor run against the SAME durable
      // state. Re-arming per wake must be an idempotent re-set of the same
      // pair — the load-bearing claim behind arming in the constructor.
      new NotebookRoom(state, {} as Env);
      assert.equal(pairs.length, 2);
      assert.equal(pairs[1].request, pairs[0].request);
      assert.equal(pairs[1].response, pairs[0].response);

      // Older runtime shape: the global constructor exists but the state
      // lacks setWebSocketAutoResponse. The second conjunct of the feature
      // detection must keep the constructor from throwing — a TypeError
      // here is a total room outage, not a degraded probe.
      assert.doesNotThrow(() => new NotebookRoom(fakeState(), {} as Env));
    } finally {
      globals.WebSocketRequestResponsePair = original;
    }
    // Feature detection: without the global constructor (every other test in
    // this file), the constructor must not call setWebSocketAutoResponse.
    const uncalled: unknown[] = [];
    const bare = fakeState() as DurableObjectState & {
      setWebSocketAutoResponse?: (pair: unknown) => void;
    };
    bare.setWebSocketAutoResponse = (pair) => uncalled.push(pair);
    new NotebookRoom(bare, {} as Env);
    assert.equal(uncalled.length, 0);
  });

  it("answers liveness pings without counting them toward rejected-frame close", async () => {
    const room = new NotebookRoom(fakeState(), {} as Env);
    const identity = authenticateDevRequest(
      new Request("https://cloud.test/n/demo/sync?user=alice&operator=desktop:a&scope=editor"),
    );
    const socket = new FakeSocket();
    const peer = {
      id: "peer-a",
      socket: socket.asCloudflareWebSocket(),
      identity,
      connectedAt: "2026-05-22T00:00:00.000Z",
      consecutiveRejectedFrames: 0,
    };
    const harness = roomHarness(room);
    harness.peers.set(peer.id, peer);
    harness.materializers.set("demo", fakeMaterializer(noopMaterializedResult()));

    // Fallback path for runtimes without setWebSocketAutoResponse: pings are
    // text frames, but they must never ride the binary-only rejection.
    for (let i = 0; i < 20; i += 1) {
      await harness.handleMessage("demo", peer, LIVENESS_PING);
    }

    assert.equal(socket.closed, false);
    assert.equal(peer.consecutiveRejectedFrames, 0);
    assert.equal(socket.sent.length, 20);
    assert(
      socket.sent.every((frame) => new TextDecoder().decode(frame) === LIVENESS_PONG),
      "every ping is answered with a pong, not a rejection control frame",
    );
  });

  it("swallows pong send failures on a closing socket", async () => {
    const room = new NotebookRoom(fakeState(), {} as Env);
    const identity = authenticateDevRequest(
      new Request("https://cloud.test/n/demo/sync?user=alice&operator=desktop:a&scope=editor"),
    );
    const socket = new FakeSocket({ throwOnSend: true });
    const peer = {
      id: "peer-a",
      socket: socket.asCloudflareWebSocket(),
      identity,
      connectedAt: "2026-05-22T00:00:00.000Z",
      consecutiveRejectedFrames: 0,
    };
    const harness = roomHarness(room);
    harness.peers.set(peer.id, peer);

    await harness.handleMessage("demo", peer, LIVENESS_PING);

    assert.equal(peer.consecutiveRejectedFrames, 0);
    assert.equal(harness.peers.has(peer.id), true);
  });

  it("does not count server-side room host failures toward peer close", async () => {
    const room = new NotebookRoom(fakeState(), {} as Env);
    const identity = authenticateDevRequest(
      new Request("https://cloud.test/n/demo/sync?user=alice&operator=desktop:a&scope=editor"),
    );
    const socket = new FakeSocket();
    const peer = {
      id: "peer-a",
      socket: socket.asCloudflareWebSocket(),
      identity,
      connectedAt: "2026-05-22T00:00:00.000Z",
      consecutiveRejectedFrames: 0,
    };
    const harness = roomHarness(room);
    harness.peers.set(peer.id, peer);
    harness.materializers.set("demo", {
      syncPeer: async () => noopMaterializedResult(),
      receiveFrame: async () => {
        throw new Error("room host storage temporarily unavailable");
      },
      checkpoint: async () => undefined,
      removePeer: async () => undefined,
    });

    for (let i = 0; i < 10; i += 1) {
      await harness.handleMessage(
        "demo",
        peer,
        encodeTypedFrame(FrameType.AUTOMERGE_SYNC, new Uint8Array([1])),
      );
    }

    assert.equal(socket.closed, false);
    assert.equal(peer.consecutiveRejectedFrames, 0);
    assert.equal(socket.sent.length, 10);
    assert(
      socket.sent.every(
        (frame) =>
          frame[0] === FrameType.SESSION_CONTROL &&
          decodeJsonPayload<Record<string, unknown>>(frame.slice(1)).type ===
            "cloud_frame_rejected",
      ),
    );
  });

  it("keeps the socket open when initial room-host peer sync is degraded", async () => {
    const room = new NotebookRoom(fakeState(), {} as Env);
    const identity = authenticateDevRequest(
      new Request("https://cloud.test/n/demo/sync?user=alice&operator=desktop:a&scope=editor"),
    );
    const socket = new FakeSocket();
    const peer = {
      id: "peer-a",
      socket: socket.asCloudflareWebSocket(),
      identity,
      connectedAt: "2026-05-22T00:00:00.000Z",
      consecutiveRejectedFrames: 0,
    };
    const harness = roomHarness(room);
    harness.peers.set(peer.id, peer);
    harness.materializers.set("demo", {
      syncPeer: async () => {
        throw new Error("Exceeded allowed rows written in Durable Objects free tier.");
      },
      receiveFrame: async () => noopMaterializedResult(),
      checkpoint: async () => undefined,
      removePeer: async () => undefined,
    });

    await harness.syncPeerFromRoomHost("demo", peer);

    assert.equal(socket.closed, false);
    assert.equal(harness.peers.has(peer.id), true);
    assert.equal(socket.sent.length, 1);
    assert.equal(socket.sent[0][0], FrameType.SESSION_CONTROL);
    const degraded = decodeJsonPayload<Record<string, unknown>>(socket.sent[0].slice(1));
    assert.equal(degraded.type, "cloud_room_degraded");
    assert.equal(degraded.peer_id, peer.id);
    assert.match(String(degraded.reason), /Exceeded allowed rows written/);
  });

  it("closes the socket when initial room-host peer sync fails for non-storage errors", async () => {
    const room = new NotebookRoom(fakeState(), {} as Env);
    const identity = authenticateDevRequest(
      new Request("https://cloud.test/n/demo/sync?user=alice&operator=desktop:a&scope=editor"),
    );
    const socket = new FakeSocket();
    const peer = {
      id: "peer-a",
      socket: socket.asCloudflareWebSocket(),
      identity,
      connectedAt: "2026-05-22T00:00:00.000Z",
      consecutiveRejectedFrames: 0,
    };
    const harness = roomHarness(room);
    harness.peers.set(peer.id, peer);
    harness.materializers.set("demo", {
      syncPeer: async () => {
        throw new Error("host document could not be materialized");
      },
      receiveFrame: async () => noopMaterializedResult(),
      checkpoint: async () => undefined,
      removePeer: async () => undefined,
    });

    await harness.syncPeerFromRoomHost("demo", peer);

    assert.equal(socket.closed, true);
    assert.equal(socket.closeCode, 1011);
    assert.equal(socket.closeReason, "room sync failed");
    assert.equal(harness.peers.has(peer.id), false);
    assert.equal(socket.sent.length, 0);
  });

  it("reports materialized sync storage degradation without rejecting the frame", async () => {
    const room = new NotebookRoom(fakeState(), {} as Env);
    const identity = authenticateDevRequest(
      new Request("https://cloud.test/n/demo/sync?user=alice&operator=desktop:a&scope=editor"),
    );
    const socket = new FakeSocket();
    const peer = {
      id: "peer-a",
      socket: socket.asCloudflareWebSocket(),
      identity,
      connectedAt: "2026-05-22T00:00:00.000Z",
      consecutiveRejectedFrames: 0,
    };
    const harness = roomHarness(room);
    harness.peers.set(peer.id, peer);
    harness.materializers.set("demo", {
      syncPeer: async () => noopMaterializedResult(),
      receiveFrame: async () => {
        throw new Error("Exceeded allowed rows written in Durable Objects free tier.");
      },
      checkpoint: async () => undefined,
      removePeer: async () => undefined,
    });

    await harness.handleMessage(
      "demo",
      peer,
      encodeTypedFrame(FrameType.AUTOMERGE_SYNC, new Uint8Array([1])),
    );

    assert.equal(socket.closed, false);
    assert.equal(peer.consecutiveRejectedFrames, 0);
    assert.equal(socket.sent.length, 1);
    assert.equal(socket.sent[0][0], FrameType.SESSION_CONTROL);
    const degraded = decodeJsonPayload<Record<string, unknown>>(socket.sent[0].slice(1));
    assert.equal(degraded.type, "cloud_room_degraded");
    assert.equal(degraded.peer_id, peer.id);
    assert.match(String(degraded.reason), /Exceeded allowed rows written/);
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
    const peerLeft = decodeJsonPayload<Record<string, unknown>>(healthySocket.sent[1].slice(1));
    assert.equal(peerLeft.type, "cloud_peer_left");
    assert.equal(peerLeft.connection_scope, "editor");
    assert.equal(staleSocket.closed, true);
  });

  it("re-registers hibernated peers with the room host sync state", async () => {
    const identity = authenticateDevRequest(
      new Request(
        "https://cloud.test/n/demo/sync?user=runtime&operator=runtime:py&scope=runtime_peer",
      ),
    );
    const socket = new FakeSocket();
    socket.serializeAttachment({
      notebookId: "demo",
      peerId: "runtime-peer",
      identity,
      connectedAt: "2026-06-06T00:00:00.000Z",
      workstation: {
        workingDirectory: "/home/ubuntu/project",
        defaultEnvironmentLabel: "Current Python",
      },
    });
    const state = hibernatedState([socket.asCloudflareWebSocket()]);
    const room = new NotebookRoom(state.state, {} as Env);

    await state.drain();

    assert.equal(
      roomHarness(room).peerForSocket(socket.asCloudflareWebSocket())?.id,
      "runtime-peer",
      "the hibernated socket is restored into the peer map",
    );
    assert.equal(
      roomHarness(room).peerForSocket(socket.asCloudflareWebSocket())?.workstation
        ?.workingDirectory,
      "/home/ubuntu/project",
      "runtime-peer workstation metadata survives hibernation attachment restore",
    );
    assert(
      socket.sent.some((frame) => frame[0] === FrameType.RUNTIME_STATE_SYNC),
      "restored peers receive RuntimeStateDoc sync so future ExecuteCell fanout can target them",
    );
  });

  it("collapses duplicate hibernated runtime peers for the same workstation", async () => {
    const oldIdentity = authenticateDevRequest(
      new Request(
        "https://cloud.test/n/demo/sync?user=runtime&operator=runtime:old&scope=runtime_peer",
      ),
    );
    const otherIdentity = authenticateDevRequest(
      new Request(
        "https://cloud.test/n/demo/sync?user=runtime&operator=runtime:other&scope=runtime_peer",
      ),
    );
    const newIdentity = authenticateDevRequest(
      new Request(
        "https://cloud.test/n/demo/sync?user=runtime&operator=runtime:new&scope=runtime_peer",
      ),
    );
    const oldSocket = new FakeSocket();
    const otherSocket = new FakeSocket();
    const newSocket = new FakeSocket();
    oldSocket.serializeAttachment({
      notebookId: "demo",
      peerId: "runtime-old",
      identity: oldIdentity,
      connectedAt: "2026-06-06T00:00:00.000Z",
      workstation: { workstationId: "ws-lab2" },
    });
    otherSocket.serializeAttachment({
      notebookId: "demo",
      peerId: "runtime-other",
      identity: otherIdentity,
      connectedAt: "2026-06-06T00:00:00.000Z",
      workstation: { workstationId: "ws-other" },
    });
    newSocket.serializeAttachment({
      notebookId: "demo",
      peerId: "runtime-new",
      identity: newIdentity,
      connectedAt: "2026-06-06T00:00:01.000Z",
      workstation: { workstationId: "ws-lab2" },
    });
    const state = hibernatedState([
      oldSocket.asCloudflareWebSocket(),
      otherSocket.asCloudflareWebSocket(),
      newSocket.asCloudflareWebSocket(),
    ]);
    const room = new NotebookRoom(state.state, {} as Env);
    const harness = roomHarness(room);

    await state.drain();

    assert.equal(oldSocket.closed, true);
    assert.equal(oldSocket.closeCode, 1008);
    assert.equal(oldSocket.closeReason, "replaced by newer runtime peer");
    assert.equal(harness.peerForSocket(oldSocket.asCloudflareWebSocket()), undefined);
    assert.equal(
      harness.peerForSocket(newSocket.asCloudflareWebSocket())?.id,
      "runtime-new",
      "newer runtime peer for the same workstation survives restore",
    );
    assert.equal(
      harness.peerForSocket(otherSocket.asCloudflareWebSocket())?.id,
      "runtime-other",
      "different workstation runtime peer survives restore",
    );
  });

  it("publishes a sanitized runtime-peer workstation attachment", async () => {
    const state = hibernatedState([]);
    const room = new NotebookRoom(state.state, {} as Env);
    const harness = roomHarness(room);
    const viewerSocket = new FakeSocket();
    const viewerPeer = {
      id: "viewer",
      socket: viewerSocket.asCloudflareWebSocket(),
      identity: authenticateDevRequest(
        new Request("https://cloud.test/n/demo/sync?user=viewer&operator=desktop:v&scope=viewer"),
      ),
      connectedAt: "2026-06-07T00:00:00.000Z",
    };
    const runtimePeer = {
      id: "runtime",
      socket: new FakeSocket().asCloudflareWebSocket(),
      identity: authenticateDevRequest(
        new Request(
          "https://cloud.test/n/demo/sync?user=runtime&operator=runtime:py&scope=runtime_peer",
        ),
      ),
      connectedAt: "2026-06-07T00:00:01.000Z",
    };
    harness.peers.set(viewerPeer.id, viewerPeer);

    let checkpointed = 0;
    let publishedAttachment: unknown;
    harness.materializers.set("demo", {
      receiveFrame: async () => noopMaterializedResult(),
      checkpoint: async () => {
        checkpointed += 1;
      },
      setWorkstationAttachment: async (attachment: unknown) => {
        publishedAttachment = attachment;
        return {
          ...noopMaterializedResult(),
          changed: true,
          runtime_state_changed: true,
          outbound: [
            {
              peer_id: viewerPeer.id,
              frame_type: FrameType.RUNTIME_STATE_SYNC,
              payload: [1, 2, 3],
            },
          ],
        };
      },
    } as never);

    await harness.publishRuntimePeerAttachment("demo", runtimePeer);

    assert.deepEqual(publishedAttachment, {
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
      runtime_session_id: null,
      updated_at: runtimePeer.connectedAt,
    });
    assert.equal(checkpointed, 1, "changed attachments are checkpointed");
    assert.equal(viewerSocket.sent.length, 1);
    assert.deepEqual([...viewerSocket.sent[0]], [FrameType.RUNTIME_STATE_SYNC, 1, 2, 3]);
  });

  it("does not cache selected runtime session for ignored stale runtime-peer publishes", async () => {
    const state = hibernatedState([]);
    const room = new NotebookRoom(state.state, {} as Env);
    const harness = roomHarness(room);
    const runtimePeer = {
      id: "runtime",
      socket: new FakeSocket().asCloudflareWebSocket(),
      identity: authenticateDevRequest(
        new Request(
          "https://cloud.test/n/demo/sync?user=runtime&operator=runtime:py&scope=runtime_peer",
        ),
      ),
      connectedAt: "2026-06-07T00:00:01.000Z",
      workstation: {
        workstationId: "ws-lab2",
        displayName: "Lab2 workstation",
        defaultEnvironmentLabel: "Current Python",
        environmentPolicy: "current_python",
        runtimeSessionId: "job-stale",
        workingDirectory: "/home/ubuntu/project",
      },
    };
    let checkpointed = 0;
    harness.materializers.set("demo", {
      receiveFrame: async () => noopMaterializedResult(),
      checkpoint: async () => {
        checkpointed += 1;
      },
      setWorkstationAttachment: async () => ({
        ...noopMaterializedResult(),
        ignored_stale: true,
      }),
    } as never);

    await harness.publishRuntimePeerAttachment("demo", runtimePeer);

    assert.equal(checkpointed, 0, "ignored stale publishes are not checkpointed");
    assert.equal(
      await harness.runtimePeerAuthorityError?.("demo", {
        ...runtimePeer.workstation,
        runtimeSessionId: "job-current",
      }),
      null,
      "ignored stale publish does not poison selected runtime session authority",
    );
  });

  it("publishes workstation attachment control updates through the room host", async () => {
    const state = hibernatedState([]);
    const room = new NotebookRoom(state.state, {} as Env);
    const harness = roomHarness(room);
    const viewerSocket = new FakeSocket();
    const viewerPeer = {
      id: "viewer",
      socket: viewerSocket.asCloudflareWebSocket(),
      identity: authenticateDevRequest(
        new Request("https://cloud.test/n/demo/sync?user=viewer&operator=desktop:v&scope=viewer"),
      ),
      connectedAt: "2026-06-07T00:00:00.000Z",
    };
    harness.peers.set(viewerPeer.id, viewerPeer);

    const attachment = {
      workstation_id: "ws-lab2",
      display_name: "Lab2 workstation",
      provider: "runtime_peer",
      default_environment_label: "Current Python",
      environment_policy: "current_python",
      status: "connecting",
      status_message: "Lab2 workstation accepted the request and is starting compute.",
      cpu_count: 8,
      memory_bytes: 16_000_000_000,
      working_directory: "/home/ubuntu/project",
      updated_at: "2026-06-07T00:00:01.000Z",
    };
    let checkpointed = 0;
    let publishedAttachment: unknown;
    harness.materializers.set("demo", {
      receiveFrame: async () => noopMaterializedResult(),
      checkpoint: async () => {
        checkpointed += 1;
      },
      setWorkstationAttachment: async (nextAttachment: unknown) => {
        publishedAttachment = nextAttachment;
        return {
          ...noopMaterializedResult(),
          changed: true,
          runtime_state_changed: true,
          outbound: [
            {
              peer_id: viewerPeer.id,
              frame_type: FrameType.RUNTIME_STATE_SYNC,
              payload: [4, 5, 6],
            },
          ],
        };
      },
    } as never);

    const response = await room.fetch(
      new Request("https://room.internal/internal/n/demo/workstation-attachment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ attachment }),
      }),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      changed: true,
      checkpoint_persisted: true,
    });
    assert.deepEqual(publishedAttachment, attachment);
    assert.equal(checkpointed, 1, "changed control updates are checkpointed");
    assert.deepEqual([...viewerSocket.sent[0]], [FrameType.RUNTIME_STATE_SYNC, 4, 5, 6]);
  });

  it("reports workstation attachment control when checkpoint persistence fails", async () => {
    const state = hibernatedState([]);
    const room = new NotebookRoom(state.state, {} as Env);
    const harness = roomHarness(room);
    harness.materializers.set("demo", {
      receiveFrame: async () => noopMaterializedResult(),
      checkpoint: async () => {
        throw new Error("Exceeded allowed rows written in Durable Objects free tier.");
      },
      setWorkstationAttachment: async () => ({
        ...noopMaterializedResult(),
        changed: true,
        runtime_state_changed: true,
      }),
      getRuntimeQueueDepth: async () => 0,
    } as never);

    const response = await room.fetch(
      new Request("https://room.internal/internal/n/demo/workstation-attachment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          attachment: {
            workstation_id: "ws-lab2",
            display_name: "Lab2 workstation",
            provider: "runtime_peer",
            default_environment_label: "Current Python",
            environment_policy: "current_python",
            status: "connecting",
            status_message: "Waiting for Lab2 to accept the compute request.",
            cpu_count: null,
            memory_bytes: null,
            working_directory: null,
            updated_at: "2026-06-07T00:00:01.000Z",
          },
        }),
      }),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      changed: true,
      checkpoint_persisted: false,
    });
  });

  it("disconnects runtime peers when replacement workstation attachment control is published", async () => {
    const state = alarmCapableState();
    const compute = new FakeOwnerComputeIndexNamespace();
    const room = new NotebookRoom(state.state, roomEnvWithComputeIndex(compute));
    const harness = roomHarness(room);
    const runtimeSocket = new FakeSocket();
    const runtimePeer = {
      id: "runtime",
      socket: runtimeSocket.asCloudflareWebSocket(),
      identity: authenticateDevRequest(
        new Request(
          "https://cloud.test/n/demo/sync?user=runtime&operator=runtime:py&scope=runtime_peer",
        ),
      ),
      connectedAt: "2026-06-07T00:00:00.000Z",
    };
    harness.peers.set(runtimePeer.id, runtimePeer);
    harness.materializers.set("demo", {
      receiveFrame: async () => noopMaterializedResult(),
      checkpoint: async () => undefined,
      removePeer: async () => undefined,
      setWorkstationAttachment: async () => ({
        ...noopMaterializedResult(),
        changed: true,
        runtime_state_changed: true,
      }),
      getRuntimeQueueDepth: async () => 0,
    } as never);

    const response = await room.fetch(
      new Request("https://room.internal/internal/n/demo/workstation-attachment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          close_runtime_peers: true,
          close_reason: "workstation restart requested",
          attachment: {
            workstation_id: "ws-lab2",
            display_name: "Lab2 workstation",
            provider: "runtime_peer",
            default_environment_label: "Current Python",
            environment_policy: "current_python",
            status: "connecting",
            status_message: "Waiting for Lab2 to accept the compute request.",
            cpu_count: 8,
            memory_bytes: 16_000_000_000,
            working_directory: "/home/ubuntu/project",
            updated_at: "2026-06-07T00:00:01.000Z",
          },
        }),
      }),
    );

    await state.drain();
    assert.equal(response.status, 200);
    assert.equal(harness.hasRuntimePeer(), false);
    assert.equal(runtimeSocket.closed, true);
    assert.equal(runtimeSocket.closeCode, 1012);
    assert.equal(runtimeSocket.closeReason, "workstation restart requested");
    assert.equal(await state.getAlarm(), null, "intentional replacement does not arm stale repair");
    assert.deepEqual(
      compute.requests.map((request) => [
        request.objectName,
        new URL(request.url).pathname,
        request.body?.summary?.status,
        request.body?.summary?.runtime_peer_count,
        request.body?.summary?.workstation_id,
      ]),
      [["owner-compute:v1:user:dev:alice", "/upsert", "starting", 0, "ws-lab2"]],
    );
  });

  it("keeps runtime peers when replacement workstation attachment control is ignored as stale", async () => {
    const state = alarmCapableState();
    const room = new NotebookRoom(state.state, {} as Env);
    const harness = roomHarness(room);
    const runtimeSocket = new FakeSocket();
    const runtimePeer = {
      id: "runtime",
      socket: runtimeSocket.asCloudflareWebSocket(),
      identity: authenticateDevRequest(
        new Request(
          "https://cloud.test/n/demo/sync?user=runtime&operator=runtime:py&scope=runtime_peer",
        ),
      ),
      connectedAt: "2026-06-07T00:00:00.000Z",
    };
    harness.peers.set(runtimePeer.id, runtimePeer);
    harness.materializers.set("demo", {
      receiveFrame: async () => noopMaterializedResult(),
      checkpoint: async () => undefined,
      removePeer: async () => undefined,
      setWorkstationAttachment: async () => ({
        ...noopMaterializedResult(),
        ignored_stale: true,
      }),
    } as never);

    const response = await room.fetch(
      new Request("https://room.internal/internal/n/demo/workstation-attachment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          close_runtime_peers: true,
          close_reason: "workstation restart requested",
          attachment: {
            workstation_id: "ws-lab2",
            display_name: "Lab2 workstation",
            provider: "runtime_peer",
            default_environment_label: "Current Python",
            environment_policy: "current_python",
            status: "connecting",
            status_message: "Waiting for Lab2 to accept the compute request.",
            cpu_count: 8,
            memory_bytes: 16_000_000_000,
            working_directory: "/home/ubuntu/project",
            updated_at: "2026-06-07T00:00:01.000Z",
            runtime_session_id: "job-stale",
          },
        }),
      }),
    );

    await state.drain();
    assert.equal(response.status, 200);
    assert.equal(harness.hasRuntimePeer(), true);
    assert.equal(runtimeSocket.closed, false);
    assert.equal(await state.getAlarm(), null, "ignored stale close does not arm stale repair");
  });

  it("does not resurrect a runtime-peer compute summary after attachment clear wins", async () => {
    const state = hibernatedState([]);
    const compute = new FakeOwnerComputeIndexNamespace();
    const room = new NotebookRoom(state.state, roomEnvWithComputeIndex(compute));
    const harness = roomHarness(room);
    const runtimePeer: PeerForTest = {
      id: "runtime",
      socket: new FakeSocket().asCloudflareWebSocket(),
      identity: authenticateDevRequest(
        new Request(
          "https://cloud.test/n/demo/sync?user=runtime&operator=runtime:py&scope=runtime_peer",
        ),
      ),
      connectedAt: "2026-06-07T00:00:00.000Z",
      workstation: {
        workstationId: "ws-lab2",
        displayName: "Lab2 workstation",
        defaultEnvironmentLabel: "Current Python",
        environmentPolicy: "current_python",
        runtimeSessionId: "job-1",
        workingDirectory: "/home/ubuntu/project",
      },
    };

    let currentAttachment: unknown = null;
    let checkpointCalls = 0;
    let resolveFirstCheckpointStarted: () => void = () => undefined;
    const firstCheckpointStarted = new Promise<void>((resolve) => {
      resolveFirstCheckpointStarted = resolve;
    });
    let releaseFirstCheckpoint: () => void = () => undefined;
    const firstCheckpointReleased = new Promise<void>((resolve) => {
      releaseFirstCheckpoint = resolve;
    });
    harness.materializers.set("demo", {
      receiveFrame: async () => noopMaterializedResult(),
      checkpoint: async () => {
        checkpointCalls += 1;
        if (checkpointCalls === 1) {
          resolveFirstCheckpointStarted();
          await firstCheckpointReleased;
        }
      },
      setWorkstationAttachment: async (attachment: unknown) => {
        currentAttachment = attachment;
        return {
          ...noopMaterializedResult(),
          changed: true,
          runtime_state_changed: true,
        };
      },
      getWorkstationAttachment: async () => currentAttachment,
      getRuntimeQueueDepth: async () => 0,
      removePeer: async () => undefined,
    } as never);

    const attachPublish = harness.publishRuntimePeerAttachment("demo", runtimePeer);
    await firstCheckpointStarted;

    const response = await room.fetch(
      new Request("https://room.internal/internal/n/demo/workstation-attachment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ attachment: null }),
      }),
    );
    assert.equal(response.status, 200);
    await state.drain();

    releaseFirstCheckpoint();
    await attachPublish;
    await state.drain();

    assert.deepEqual(
      compute.requests.map((request) => new URL(request.url).pathname),
      ["/delete", "/delete"],
      "the delayed runtime-peer publish re-reads the cleared attachment instead of upserting stale compute",
    );
  });

  it("disconnects anonymous viewers when public link access is revoked", async () => {
    const room = new NotebookRoom(fakeState(), {} as Env);
    const harness = roomHarness(room);
    const anonymousSocket = new FakeSocket();
    const signedInViewerSocket = new FakeSocket();
    const ownerSocket = new FakeSocket();
    const anonymousPeer = {
      id: "anonymous-viewer",
      socket: anonymousSocket.asCloudflareWebSocket(),
      identity: authenticateAnonymousViewer(
        new Request("https://cloud.test/n/demo/sync?viewer_session=anon-a"),
      ),
      connectedAt: "2026-06-07T00:00:00.000Z",
    };
    const signedInViewerPeer = {
      id: "signed-in-viewer",
      socket: signedInViewerSocket.asCloudflareWebSocket(),
      identity: authenticateDevRequest(
        new Request("https://cloud.test/n/demo/sync?user=bob&operator=browser:b&scope=viewer"),
      ),
      connectedAt: "2026-06-07T00:00:01.000Z",
    };
    const ownerPeer = {
      id: "owner",
      socket: ownerSocket.asCloudflareWebSocket(),
      identity: authenticateDevRequest(
        new Request("https://cloud.test/n/demo/sync?user=alice&operator=browser:a&scope=owner"),
      ),
      connectedAt: "2026-06-07T00:00:02.000Z",
    };
    harness.peers.set(anonymousPeer.id, anonymousPeer);
    harness.peers.set(signedInViewerPeer.id, signedInViewerPeer);
    harness.peers.set(ownerPeer.id, ownerPeer);
    harness.materializers.set("demo", fakeMaterializer(noopMaterializedResult()));

    const response = await room.fetch(
      new Request("https://room.internal/internal/n/demo/access-revocation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          close_anonymous_viewers: true,
          close_reason: "public link access revoked",
        }),
      }),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      closed_anonymous_viewers: 1,
    });
    assert.equal(anonymousSocket.closed, true);
    assert.equal(anonymousSocket.closeCode, 1008);
    assert.equal(anonymousSocket.closeReason, "public link access revoked");
    assert.equal(signedInViewerSocket.closed, false);
    assert.equal(ownerSocket.closed, false);
    assert.equal(harness.peers.has(anonymousPeer.id), false);
    assert.equal(harness.peers.has(signedInViewerPeer.id), true);
    assert.equal(harness.peers.has(ownerPeer.id), true);
  });

  it("keeps runtime peers when replacement workstation attachment publish fails", async () => {
    const state = alarmCapableState();
    const room = new NotebookRoom(state.state, {} as Env);
    const harness = roomHarness(room);
    const runtimeSocket = new FakeSocket();
    const runtimePeer = {
      id: "runtime",
      socket: runtimeSocket.asCloudflareWebSocket(),
      identity: authenticateDevRequest(
        new Request(
          "https://cloud.test/n/demo/sync?user=runtime&operator=runtime:py&scope=runtime_peer",
        ),
      ),
      connectedAt: "2026-06-07T00:00:00.000Z",
    };
    harness.peers.set(runtimePeer.id, runtimePeer);
    harness.materializers.set("demo", {
      receiveFrame: async () => noopMaterializedResult(),
      checkpoint: async () => undefined,
      removePeer: async () => undefined,
      setWorkstationAttachment: async () => {
        throw new Error("publish failed");
      },
    } as never);

    const response = await room.fetch(
      new Request("https://room.internal/internal/n/demo/workstation-attachment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          close_runtime_peers: true,
          attachment: {
            workstation_id: "ws-lab2",
            display_name: "Lab2 workstation",
            provider: "runtime_peer",
            default_environment_label: "Current Python",
            environment_policy: "current_python",
            status: "connecting",
            status_message: "Waiting for Lab2 to accept the compute request.",
            cpu_count: 8,
            memory_bytes: 16_000_000_000,
            working_directory: "/home/ubuntu/project",
            updated_at: "2026-06-07T00:00:01.000Z",
          },
        }),
      }),
    );

    await state.drain();
    assert.equal(response.status, 500);
    assert.equal(harness.hasRuntimePeer(), true);
    assert.equal(runtimeSocket.closed, false);
    assert.equal(await state.getAlarm(), null);
  });

  it("projects runtime-peer workstation metadata into the attachment", async () => {
    const state = hibernatedState([]);
    const room = new NotebookRoom(state.state, {} as Env);
    const harness = roomHarness(room);
    const runtimePeer = {
      id: "runtime",
      socket: new FakeSocket().asCloudflareWebSocket(),
      identity: authenticateDevRequest(
        new Request(
          "https://cloud.test/n/demo/sync?user=runtime&operator=runtime:py&scope=runtime_peer",
        ),
      ),
      connectedAt: "2026-06-07T00:00:01.000Z",
      workstation: {
        workstationId: "ws-lab2",
        displayName: "Lab2 workstation",
        defaultEnvironmentLabel: "Current Python",
        environmentPolicy: "current_python",
        runtimeSessionId: "job-123",
        workingDirectory: "/home/ubuntu/codex/nteract",
      },
    };

    let publishedAttachment: unknown;
    harness.materializers.set("demo", {
      receiveFrame: async () => noopMaterializedResult(),
      checkpoint: async () => undefined,
      setWorkstationAttachment: async (attachment: unknown) => {
        publishedAttachment = attachment;
        return noopMaterializedResult();
      },
    } as never);

    await harness.publishRuntimePeerAttachment("demo", runtimePeer);

    assert.deepEqual(publishedAttachment, {
      workstation_id: "ws-lab2",
      display_name: "Lab2 workstation",
      provider: "runtime_peer",
      default_environment_label: "Current Python",
      environment_policy: "current_python",
      status: "ready",
      status_message: null,
      cpu_count: null,
      memory_bytes: null,
      working_directory: "/home/ubuntu/codex/nteract",
      runtime_session_id: "job-123",
      updated_at: runtimePeer.connectedAt,
    });
  });

  it("allows only the selected workstation to refresh runtime-peer attachment state", async () => {
    const state = hibernatedState([]);
    const room = new NotebookRoom(state.state, {} as Env);
    const harness = roomHarness(room);
    let attachmentReads = 0;
    harness.materializers.set("demo", {
      receiveFrame: async () => noopMaterializedResult(),
      checkpoint: async () => undefined,
      getWorkstationAttachment: async () => {
        attachmentReads += 1;
        return {
          workstation_id: "lab2",
          display_name: "lab2 workstation",
          provider: "runtime_peer",
          default_environment_label: "Current Python",
          environment_policy: "current_python",
          status: "connecting",
          status_message: "lab2 accepted the request",
          cpu_count: null,
          memory_bytes: null,
          working_directory: "/home/ubuntu/codex/nteract",
          runtime_session_id: "job-123",
          updated_at: "2026-06-07T00:00:00.000Z",
        };
      },
      setWorkstationAttachment: async () => noopMaterializedResult(),
    } as never);

    const matching = await harness.runtimePeerAuthorityError?.("demo", {
      workstationId: "lab2",
      runtimeSessionId: "job-123",
    });
    const staleSession = await harness.runtimePeerAuthorityError?.("demo", {
      workstationId: "lab2",
      runtimeSessionId: "job-456",
    });
    const missingSession = await harness.runtimePeerAuthorityError?.("demo", {
      workstationId: "lab2",
    });
    const mismatched = await harness.runtimePeerAuthorityError?.("demo", {
      workstationId: "other-box",
      runtimeSessionId: "job-123",
    });
    const missing = await harness.runtimePeerAuthorityError?.("demo", null);

    assert.equal(matching, null);
    assert.match(String(staleSession), /does not match selected runtime session job-123/);
    assert.match(String(missingSession), /does not match selected runtime session job-123/);
    assert.match(String(mismatched), /does not match selected workstation lab2/);
    assert.match(String(missing), /runtime-peer does not match selected workstation lab2/);
    assert.equal(
      attachmentReads,
      1,
      "selected runtime session is cached after the first attachment read",
    );
  });

  it("rejects runtime-peer upgrades for idle selected sessions", async () => {
    const room = new NotebookRoom(fakeState(), {} as Env);
    const harness = roomHarness(room);
    harness.materializers.set("demo", {
      receiveFrame: async () => noopMaterializedResult(),
      checkpoint: async () => undefined,
      getWorkstationAttachment: async () => ({
        workstation_id: "lab2",
        display_name: "lab2 workstation",
        provider: "runtime_peer",
        default_environment_label: "Current Python",
        environment_policy: "current_python",
        status: "idle",
        status_message: "Compute stopped after 30 minutes without queued or active execution.",
        cpu_count: null,
        memory_bytes: null,
        working_directory: "/home/ubuntu/codex/nteract",
        runtime_session_id: "job-old",
        updated_at: "2026-06-07T00:00:00.000Z",
      }),
    } as never);
    const identity = authenticateDevRequest(
      new Request(
        "https://cloud.test/n/demo/sync?user=runtime&operator=runtime:py&scope=runtime_peer",
      ),
    );
    const response = await room.fetch(
      stampTrustedIdentity(
        new Request("https://cloud.test/n/demo/sync", {
          headers: {
            Upgrade: "websocket",
            "x-nteract-workstation-id": "lab2",
            "x-nteract-runtime-session-id": "job-old",
          },
        }),
        identity,
      ),
    );

    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: "selected runtime session is idle" });
  });

  it("refreshes the selected runtime session cache when a runtime peer publishes", async () => {
    const state = hibernatedState([]);
    const room = new NotebookRoom(state.state, {} as Env);
    const harness = roomHarness(room);
    let attachmentReads = 0;
    let publishedAttachment: unknown;
    harness.materializers.set("demo", {
      receiveFrame: async () => noopMaterializedResult(),
      checkpoint: async () => undefined,
      getWorkstationAttachment: async () => {
        attachmentReads += 1;
        return {
          workstation_id: "lab2",
          display_name: "lab2 workstation",
          provider: "runtime_peer",
          default_environment_label: "Current Python",
          environment_policy: "current_python",
          status: "ready",
          status_message: null,
          cpu_count: null,
          memory_bytes: null,
          working_directory: "/home/ubuntu/codex/nteract",
          runtime_session_id: "old-job",
          updated_at: "2026-06-07T00:00:00.000Z",
        };
      },
      setWorkstationAttachment: async (attachment: unknown) => {
        publishedAttachment = attachment;
        return {
          ...noopMaterializedResult(),
          changed: true,
          runtime_state_changed: true,
        };
      },
    } as never);

    assert.equal(
      await harness.runtimePeerAuthorityError?.("demo", {
        workstationId: "lab2",
        runtimeSessionId: "old-job",
      }),
      null,
    );

    await harness.publishRuntimePeerAttachment("demo", {
      id: "runtime",
      socket: new FakeSocket().asCloudflareWebSocket(),
      identity: authenticateDevRequest(
        new Request(
          "https://cloud.test/n/demo/sync?user=runtime&operator=runtime:py&scope=runtime_peer",
        ),
      ),
      connectedAt: "2026-06-07T00:00:01.000Z",
      workstation: {
        workstationId: "lab2",
        runtimeSessionId: "new-job",
        displayName: "lab2",
      },
      consecutiveRejectedFrames: 0,
    });

    assert.equal(
      (publishedAttachment as { runtime_session_id?: string }).runtime_session_id,
      "new-job",
    );
    assert.match(
      String(
        await harness.runtimePeerAuthorityError?.("demo", {
          workstationId: "lab2",
          runtimeSessionId: "old-job",
        }),
      ),
      /does not match selected runtime session new-job/,
    );
    assert.equal(
      await harness.runtimePeerAuthorityError?.("demo", {
        workstationId: "lab2",
        runtimeSessionId: "new-job",
      }),
      null,
    );
    assert.equal(attachmentReads, 1, "runtime publish refreshes the cache without rereading");
  });

  it("invalidates the selected runtime session cache after runtime-peer-gone repair", async () => {
    const state = hibernatedState([]);
    const room = new NotebookRoom(state.state, {} as Env);
    const harness = roomHarness(room);
    let attachmentReads = 0;
    let selectedAttachment: Record<string, unknown> = {
      workstation_id: "lab2",
      display_name: "lab2 workstation",
      provider: "runtime_peer",
      default_environment_label: "Current Python",
      environment_policy: "current_python",
      status: "ready",
      status_message: null,
      cpu_count: null,
      memory_bytes: null,
      working_directory: "/home/ubuntu/codex/nteract",
      runtime_session_id: "old-job",
      updated_at: "2026-06-07T00:00:00.000Z",
    };
    harness.materializers.set("demo", {
      receiveFrame: async () => noopMaterializedResult(),
      checkpoint: async () => undefined,
      getWorkstationAttachment: async () => {
        attachmentReads += 1;
        return selectedAttachment;
      },
      reconcileRuntimePeerGone: async () => {
        selectedAttachment = {
          ...selectedAttachment,
          status: "error",
          status_message: "runtime peer left",
          runtime_session_id: "new-job",
        };
        return {
          ...noopMaterializedResult(),
          changed: true,
          runtime_state_changed: true,
        };
      },
    } as never);

    assert.equal(
      await harness.runtimePeerAuthorityError?.("demo", {
        workstationId: "lab2",
        runtimeSessionId: "old-job",
      }),
      null,
    );
    assert.equal(attachmentReads, 1);

    const response = await room.fetch(
      new Request("https://room.internal/internal/n/demo/runtime-state-repair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "test repair" }),
      }),
    );
    assert.equal(response.status, 200);

    assert.match(
      String(
        await harness.runtimePeerAuthorityError?.("demo", {
          workstationId: "lab2",
          runtimeSessionId: "old-job",
        }),
      ),
      /does not match selected runtime session new-job/,
    );
    assert.equal(
      await harness.runtimePeerAuthorityError?.("demo", {
        workstationId: "lab2",
        runtimeSessionId: "new-job",
      }),
      null,
    );
    assert.equal(
      attachmentReads,
      2,
      "runtime-state repair invalidates the selected session cache for one fresh read",
    );
  });
});

describe("NotebookRoom materialized sync routing", () => {
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
    harness.materializers.set("demo", fakeMaterializer(noopMaterializedResult()));

    await harness.handleMessage(
      "demo",
      peer,
      encodeTypedFrame(FrameType.AUTOMERGE_SYNC, new Uint8Array()),
    );

    assert.equal(socket.sent.length, 1);
    assert.equal(
      decodeJsonPayload<Record<string, unknown>>(socket.sent[0].slice(1)).type,
      "cloud_frame_accepted",
    );
  });

  it("acknowledges changed materialized sync frames without persisted room history", async () => {
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
    let checkpointed = 0;
    harness.materializers.set("demo", {
      receiveFrame: async () => ({
        ...noopMaterializedResult(),
        changed: true,
        notebook_changed: true,
      }),
      checkpoint: async () => {
        checkpointed += 1;
      },
      removePeer: async () => undefined,
    });

    await harness.handleMessage(
      "demo",
      peer,
      encodeTypedFrame(FrameType.AUTOMERGE_SYNC, new Uint8Array([1])),
    );

    assert.equal(checkpointed, 1);
    assert.equal(socket.sent.length, 1);
    assert.equal(
      decodeJsonPayload<Record<string, unknown>>(socket.sent[0].slice(1)).type,
      "cloud_frame_accepted",
    );
  });

  it("republishes compute summary when execution changes queue depth", async () => {
    const state = hibernatedState([]);
    const compute = new FakeOwnerComputeIndexNamespace();
    const room = new NotebookRoom(state.state, roomEnvWithComputeIndex(compute));
    const harness = roomHarness(room);
    const ownerSocket = new FakeSocket();
    const ownerPeer: PeerForTest = {
      id: "owner",
      socket: ownerSocket.asCloudflareWebSocket(),
      identity: authenticateDevRequest(
        new Request("https://cloud.test/n/demo/sync?user=alice&operator=browser:a&scope=owner"),
      ),
      connectedAt: "2026-05-22T00:00:00.000Z",
    };
    const runtimePeer: PeerForTest = {
      id: "runtime",
      socket: new FakeSocket().asCloudflareWebSocket(),
      identity: authenticateDevRequest(
        new Request(
          "https://cloud.test/n/demo/sync?user=runtime&operator=runtime:py&scope=runtime_peer",
        ),
      ),
      connectedAt: "2026-05-22T00:00:01.000Z",
      workstation: {
        workstationId: "ws-lab2",
        runtimeSessionId: "job-1",
      },
    };
    harness.peers.set(ownerPeer.id, ownerPeer);
    harness.peers.set(runtimePeer.id, runtimePeer);

    let queueDepth = 0;
    harness.materializers.set("demo", {
      receiveFrame: async () => {
        queueDepth = 1;
        return {
          ...noopMaterializedResult(),
          changed: true,
          runtime_state_changed: true,
        };
      },
      checkpoint: async () => undefined,
      getWorkstationAttachment: async () => ({
        workstation_id: "ws-lab2",
        display_name: "lab2 workstation",
        provider: "runtime_peer",
        default_environment_label: "Current Python",
        environment_policy: "current_python",
        status: "ready",
        status_message: null,
        cpu_count: null,
        memory_bytes: null,
        working_directory: "/home/ubuntu/project",
        updated_at: "2026-06-23T00:00:00.000Z",
        runtime_session_id: "job-1",
      }),
      getRuntimeQueueDepth: async () => queueDepth,
      removePeer: async () => undefined,
    } as never);

    await harness.handleMessage(
      "demo",
      ownerPeer,
      encodeTypedFrame(
        FrameType.REQUEST,
        new TextEncoder().encode(
          JSON.stringify({ id: "request-1", action: "execute_cell", cell_id: "cell-1" }),
        ),
      ),
    );
    await state.drain();

    assert.equal(compute.requests.length, 1);
    assert.equal(compute.requests[0]?.body?.summary?.status, "active");
    assert.equal(compute.requests[0]?.body?.summary?.queue_depth, 1);
    assert.equal(compute.requests[0]?.body?.summary?.runtime_peer_count, 1);

    await harness.handleMessage(
      "demo",
      runtimePeer,
      encodeTypedFrame(FrameType.RUNTIME_STATE_SYNC, new Uint8Array([1])),
    );
    await state.drain();

    assert.equal(
      compute.requests.length,
      1,
      "runtime-state churn at the same queue depth does not rewrite the owner compute index",
    );
  });

  it("coalesces same-depth compute summary publishes while an index write is pending", async () => {
    const state = hibernatedState([]);
    const compute = new BlockingOwnerComputeIndexNamespace();
    const room = new NotebookRoom(state.state, roomEnvWithComputeIndex(compute));
    const harness = roomHarness(room);
    const ownerSocket = new FakeSocket();
    const ownerPeer: PeerForTest = {
      id: "owner",
      socket: ownerSocket.asCloudflareWebSocket(),
      identity: authenticateDevRequest(
        new Request("https://cloud.test/n/demo/sync?user=alice&operator=browser:a&scope=owner"),
      ),
      connectedAt: "2026-05-22T00:00:00.000Z",
    };
    const runtimePeer: PeerForTest = {
      id: "runtime",
      socket: new FakeSocket().asCloudflareWebSocket(),
      identity: authenticateDevRequest(
        new Request(
          "https://cloud.test/n/demo/sync?user=runtime&operator=runtime:py&scope=runtime_peer",
        ),
      ),
      connectedAt: "2026-05-22T00:00:01.000Z",
      workstation: {
        workstationId: "ws-lab2",
        runtimeSessionId: "job-1",
      },
    };
    harness.peers.set(ownerPeer.id, ownerPeer);
    harness.peers.set(runtimePeer.id, runtimePeer);

    let queueDepth = 0;
    harness.materializers.set("demo", {
      receiveFrame: async () => {
        queueDepth = 1;
        return {
          ...noopMaterializedResult(),
          changed: true,
          runtime_state_changed: true,
        };
      },
      checkpoint: async () => undefined,
      getWorkstationAttachment: async () => ({
        workstation_id: "ws-lab2",
        display_name: "lab2 workstation",
        provider: "runtime_peer",
        default_environment_label: "Current Python",
        environment_policy: "current_python",
        status: "ready",
        status_message: null,
        cpu_count: null,
        memory_bytes: null,
        working_directory: "/home/ubuntu/project",
        updated_at: "2026-06-23T00:00:00.000Z",
        runtime_session_id: "job-1",
      }),
      getRuntimeQueueDepth: async () => queueDepth,
      removePeer: async () => undefined,
    } as never);

    await harness.handleMessage(
      "demo",
      ownerPeer,
      encodeTypedFrame(
        FrameType.REQUEST,
        new TextEncoder().encode(
          JSON.stringify({ id: "request-1", action: "execute_cell", cell_id: "cell-1" }),
        ),
      ),
    );
    await compute.firstStarted;
    assert.equal(compute.requests.length, 1);

    await harness.handleMessage(
      "demo",
      runtimePeer,
      encodeTypedFrame(FrameType.RUNTIME_STATE_SYNC, new Uint8Array([1])),
    );
    assert.equal(
      compute.requests.length,
      1,
      "same-depth runtime-state churn is serialized behind the in-flight publish",
    );

    compute.releaseFirst();
    await state.drain();
    assert.equal(
      compute.requests.length,
      1,
      "same-depth runtime-state churn does not write the owner compute index after coalescing",
    );
  });

  it("retries same-depth compute summary after owner index write failure", async () => {
    const state = hibernatedState([]);
    const compute = new FailingFirstOwnerComputeIndexNamespace();
    const room = new NotebookRoom(state.state, roomEnvWithComputeIndex(compute));
    const harness = roomHarness(room);
    const ownerPeer: PeerForTest = {
      id: "owner",
      socket: new FakeSocket().asCloudflareWebSocket(),
      identity: authenticateDevRequest(
        new Request("https://cloud.test/n/demo/sync?user=alice&operator=browser:a&scope=owner"),
      ),
      connectedAt: "2026-05-22T00:00:00.000Z",
    };
    const runtimePeer: PeerForTest = {
      id: "runtime",
      socket: new FakeSocket().asCloudflareWebSocket(),
      identity: authenticateDevRequest(
        new Request(
          "https://cloud.test/n/demo/sync?user=runtime&operator=runtime:py&scope=runtime_peer",
        ),
      ),
      connectedAt: "2026-05-22T00:00:01.000Z",
      workstation: {
        workstationId: "ws-lab2",
        runtimeSessionId: "job-1",
      },
    };
    harness.peers.set(ownerPeer.id, ownerPeer);
    harness.peers.set(runtimePeer.id, runtimePeer);

    let queueDepth = 0;
    harness.materializers.set("demo", {
      receiveFrame: async () => {
        queueDepth = 1;
        return {
          ...noopMaterializedResult(),
          changed: true,
          runtime_state_changed: true,
        };
      },
      checkpoint: async () => undefined,
      getWorkstationAttachment: async () => ({
        workstation_id: "ws-lab2",
        display_name: "lab2 workstation",
        provider: "runtime_peer",
        default_environment_label: "Current Python",
        environment_policy: "current_python",
        status: "ready",
        status_message: null,
        cpu_count: null,
        memory_bytes: null,
        working_directory: "/home/ubuntu/project",
        updated_at: "2026-06-23T00:00:00.000Z",
        runtime_session_id: "job-1",
      }),
      getRuntimeQueueDepth: async () => queueDepth,
      removePeer: async () => undefined,
    } as never);

    await harness.handleMessage(
      "demo",
      ownerPeer,
      encodeTypedFrame(
        FrameType.REQUEST,
        new TextEncoder().encode(
          JSON.stringify({ id: "request-1", action: "execute_cell", cell_id: "cell-1" }),
        ),
      ),
    );
    await state.drain();
    assert.equal(compute.requests.length, 1);

    await harness.handleMessage(
      "demo",
      runtimePeer,
      encodeTypedFrame(FrameType.RUNTIME_STATE_SYNC, new Uint8Array([1])),
    );
    await state.drain();

    assert.equal(
      compute.requests.length,
      2,
      "failed owner-index writes do not mark the queue depth as published",
    );
    assert.equal(compute.requests[1]?.body?.summary?.queue_depth, 1);
  });

  it("skips D1 and owner-index work for clean same-depth runtime-state churn", async () => {
    const state = hibernatedState([]);
    const compute = new FakeOwnerComputeIndexNamespace();
    const db = new CountingNotebookOwnerD1();
    const room = new NotebookRoom(state.state, roomEnvWithComputeIndex(compute, db));
    const harness = roomHarness(room);
    const ownerPeer: PeerForTest = {
      id: "owner",
      socket: new FakeSocket().asCloudflareWebSocket(),
      identity: authenticateDevRequest(
        new Request("https://cloud.test/n/demo/sync?user=alice&operator=browser:a&scope=owner"),
      ),
      connectedAt: "2026-05-22T00:00:00.000Z",
    };
    const runtimePeer: PeerForTest = {
      id: "runtime",
      socket: new FakeSocket().asCloudflareWebSocket(),
      identity: authenticateDevRequest(
        new Request(
          "https://cloud.test/n/demo/sync?user=runtime&operator=runtime:py&scope=runtime_peer",
        ),
      ),
      connectedAt: "2026-05-22T00:00:01.000Z",
      workstation: {
        workstationId: "ws-lab2",
        runtimeSessionId: "job-1",
      },
    };
    harness.peers.set(ownerPeer.id, ownerPeer);
    harness.peers.set(runtimePeer.id, runtimePeer);

    let queueDepth = 0;
    harness.materializers.set("demo", {
      receiveFrame: async () => {
        queueDepth = 1;
        return {
          ...noopMaterializedResult(),
          changed: true,
          runtime_state_changed: true,
        };
      },
      checkpoint: async () => undefined,
      getWorkstationAttachment: async () => ({
        workstation_id: "ws-lab2",
        display_name: "lab2 workstation",
        provider: "runtime_peer",
        default_environment_label: "Current Python",
        environment_policy: "current_python",
        status: "ready",
        status_message: null,
        cpu_count: null,
        memory_bytes: null,
        working_directory: "/home/ubuntu/project",
        updated_at: "2026-06-23T00:00:00.000Z",
        runtime_session_id: "job-1",
      }),
      getRuntimeQueueDepth: async () => queueDepth,
      removePeer: async () => undefined,
    } as never);

    await harness.handleMessage(
      "demo",
      ownerPeer,
      encodeTypedFrame(
        FrameType.REQUEST,
        new TextEncoder().encode(
          JSON.stringify({ id: "request-1", action: "execute_cell", cell_id: "cell-1" }),
        ),
      ),
    );
    await state.drain();
    assert.equal(compute.requests.length, 1);
    assert.equal(db.notebookLookupCount, 1);

    db.notebookLookupCount = 0;
    await harness.handleMessage(
      "demo",
      runtimePeer,
      encodeTypedFrame(FrameType.RUNTIME_STATE_SYNC, new Uint8Array([1])),
    );
    await state.drain();

    assert.equal(compute.requests.length, 1);
    assert.equal(
      db.notebookLookupCount,
      0,
      "same-depth runtime-state churn returns before D1 notebook lookup",
    );
  });

  it("skips D1 and owner-index delete work after clean same-depth no-summary publish", async () => {
    const state = hibernatedState([]);
    const compute = new FakeOwnerComputeIndexNamespace();
    const db = new CountingNotebookOwnerD1();
    const room = new NotebookRoom(state.state, roomEnvWithComputeIndex(compute, db));
    const harness = roomHarness(room);
    const runtimePeer: PeerForTest = {
      id: "runtime",
      socket: new FakeSocket().asCloudflareWebSocket(),
      identity: authenticateDevRequest(
        new Request(
          "https://cloud.test/n/demo/sync?user=runtime&operator=runtime:py&scope=runtime_peer",
        ),
      ),
      connectedAt: "2026-05-22T00:00:01.000Z",
      workstation: {
        workstationId: "ws-lab2",
        runtimeSessionId: "job-1",
      },
    };
    harness.peers.set(runtimePeer.id, runtimePeer);

    harness.materializers.set("demo", {
      receiveFrame: async () => ({
        ...noopMaterializedResult(),
        changed: true,
        runtime_state_changed: true,
      }),
      checkpoint: async () => undefined,
      getWorkstationAttachment: async () => null,
      getRuntimeQueueDepth: async () => 0,
      removePeer: async () => undefined,
    } as never);

    await harness.handleMessage(
      "demo",
      runtimePeer,
      encodeTypedFrame(FrameType.RUNTIME_STATE_SYNC, new Uint8Array([1])),
    );
    await state.drain();
    assert.equal(compute.requests.length, 1);
    assert.match(compute.requests[0]?.url ?? "", /\/delete$/);
    assert.equal(db.notebookLookupCount, 1);

    db.notebookLookupCount = 0;
    await harness.handleMessage(
      "demo",
      runtimePeer,
      encodeTypedFrame(FrameType.RUNTIME_STATE_SYNC, new Uint8Array([1])),
    );
    await state.drain();

    assert.equal(compute.requests.length, 1);
    assert.equal(
      db.notebookLookupCount,
      0,
      "same-depth no-summary churn returns before D1 notebook lookup",
    );
  });

  it("retries same-depth dirty summary after failed active update", async () => {
    const state = hibernatedState([]);
    const compute = new FailingNumberedOwnerComputeIndexNamespace(2);
    const room = new NotebookRoom(state.state, roomEnvWithComputeIndex(compute));
    const harness = roomHarness(room);
    const runtimePeer: PeerForTest = {
      id: "runtime",
      socket: new FakeSocket().asCloudflareWebSocket(),
      identity: authenticateDevRequest(
        new Request(
          "https://cloud.test/n/demo/sync?user=runtime&operator=runtime:py&scope=runtime_peer",
        ),
      ),
      connectedAt: "2026-05-22T00:00:01.000Z",
      workstation: {
        workstationId: "ws-lab2",
        runtimeSessionId: "job-1",
      },
    };
    let currentAttachment: unknown = {
      workstation_id: "ws-lab2",
      display_name: "lab2 workstation",
      provider: "runtime_peer",
      default_environment_label: "Current Python",
      environment_policy: "current_python",
      status: "connecting",
      status_message: "Waiting for lab2.",
      cpu_count: null,
      memory_bytes: null,
      working_directory: "/home/ubuntu/project",
      updated_at: "2026-06-23T00:00:00.000Z",
      runtime_session_id: "job-1",
    };
    harness.materializers.set("demo", {
      receiveFrame: async () => ({
        ...noopMaterializedResult(),
        changed: true,
        runtime_state_changed: true,
      }),
      checkpoint: async () => undefined,
      getWorkstationAttachment: async () => currentAttachment,
      getRuntimeQueueDepth: async () => 0,
      setWorkstationAttachment: async (attachment: unknown) => {
        currentAttachment = attachment;
        return {
          ...noopMaterializedResult(),
          changed: true,
          runtime_state_changed: true,
        };
      },
      removePeer: async () => undefined,
    } as never);

    const response = await room.fetch(
      new Request("https://room.internal/internal/n/demo/workstation-attachment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ attachment: currentAttachment }),
      }),
    );
    assert.equal(response.status, 200);
    await state.drain();
    assert.equal(compute.requests[0]?.body?.summary?.status, "starting");

    harness.peers.set(runtimePeer.id, runtimePeer);
    await harness.publishRuntimePeerAttachment("demo", runtimePeer);
    assert.equal(compute.requests[1]?.body?.summary?.status, "active");

    await harness.handleMessage(
      "demo",
      runtimePeer,
      encodeTypedFrame(FrameType.RUNTIME_STATE_SYNC, new Uint8Array([1])),
    );
    await state.drain();

    assert.equal(
      compute.requests.length,
      3,
      "failed same-depth active update leaves the summary dirty for retry",
    );
    assert.equal(compute.requests[2]?.body?.summary?.status, "active");
    assert.equal(compute.requests[2]?.body?.summary?.queue_depth, 0);
  });

  it("delivers materialized sync outbound frames to connected viewer peers", async () => {
    const room = new NotebookRoom(fakeState(), {} as Env);
    const editorIdentity = authenticateDevRequest(
      new Request("https://cloud.test/n/demo/sync?user=alice&operator=desktop:a&scope=editor"),
    );
    const viewerIdentity = authenticateDevRequest(
      new Request("https://cloud.test/n/demo/sync?user=bob&operator=desktop:b&scope=viewer"),
    );
    const editorSocket = new FakeSocket();
    const viewerSocket = new FakeSocket();
    const editorPeer = {
      id: "editor",
      socket: editorSocket.asCloudflareWebSocket(),
      identity: editorIdentity,
      connectedAt: "2026-05-22T00:00:00.000Z",
    };
    const viewerPeer = {
      id: "viewer",
      socket: viewerSocket.asCloudflareWebSocket(),
      identity: viewerIdentity,
      connectedAt: "2026-05-22T00:00:00.000Z",
    };
    const harness = roomHarness(room);
    harness.peers.set(editorPeer.id, editorPeer);
    harness.peers.set(viewerPeer.id, viewerPeer);
    harness.materializers.set(
      "demo",
      fakeMaterializer({
        ...noopMaterializedResult(),
        changed: true,
        notebook_changed: true,
        outbound: [
          {
            peer_id: viewerPeer.id,
            frame_type: FrameType.AUTOMERGE_SYNC,
            payload: [7, 8, 9],
          },
        ],
      }),
    );

    await harness.handleMessage(
      "demo",
      editorPeer,
      encodeTypedFrame(FrameType.AUTOMERGE_SYNC, new Uint8Array([1])),
    );

    assert.equal(viewerSocket.sent.length, 1);
    assert.deepEqual([...viewerSocket.sent[0]], [FrameType.AUTOMERGE_SYNC, 7, 8, 9]);
    assert.equal(editorSocket.sent.length, 1);
    assert.equal(
      decodeJsonPayload<Record<string, unknown>>(editorSocket.sent[0].slice(1)).type,
      "cloud_frame_accepted",
    );
  });

  it("rejects editor-scoped PUT_BLOB frames on the WebSocket path", async () => {
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

    await harness.handleMessage(
      "demo",
      peer,
      encodeTypedFrame(FrameType.PUT_BLOB, new Uint8Array([1, 2, 3])),
    );

    assert.equal(socket.sent.length, 1);
    const rejected = decodeJsonPayload<Record<string, unknown>>(socket.sent[0].slice(1));
    assert.equal(rejected.type, "cloud_frame_rejected");
    assert.equal(rejected.reason, "editor cannot write put_blob frames");
  });

  it("accepts owner-scoped REQUEST frames on the WebSocket path", async () => {
    const room = new NotebookRoom(fakeState(), {} as Env);
    const identity = authenticateDevRequest(
      new Request("https://cloud.test/n/demo/sync?user=alice&operator=desktop:a&scope=owner"),
    );
    const socket = new FakeSocket();
    const peer = {
      id: "owner",
      socket: socket.asCloudflareWebSocket(),
      identity,
      connectedAt: "2026-05-22T00:00:00.000Z",
    };
    const harness = roomHarness(room);
    harness.peers.set("runtime", {
      ...peer,
      id: "runtime",
      identity: authenticateDevRequest(
        new Request(
          "https://cloud.test/n/demo/sync?user=alice&operator=runtime:py&scope=runtime_peer",
        ),
      ),
    });
    let materialized = 0;
    harness.materializers.set("demo", {
      receiveFrame: async () => {
        materialized += 1;
        return noopMaterializedResult();
      },
      checkpoint: async () => undefined,
    });

    await harness.handleMessage(
      "demo",
      peer,
      encodeTypedFrame(
        FrameType.REQUEST,
        new TextEncoder().encode(
          JSON.stringify({ id: "request-1", action: "execute_cell", cell_id: "cell-1" }),
        ),
      ),
    );

    assert.equal(materialized, 1);
    assert.equal(socket.sent.length, 1);
    const accepted = decodeJsonPayload<Record<string, unknown>>(socket.sent[0].slice(1));
    assert.equal(accepted.type, "cloud_frame_accepted");
  });

  it("forwards owner runtime-agent command REQUEST frames to attached runtime peers", async () => {
    const room = new NotebookRoom(fakeState(), {} as Env);
    const ownerIdentity = authenticateDevRequest(
      new Request("https://cloud.test/n/demo/sync?user=alice&operator=browser:a&scope=owner"),
    );
    const runtimeIdentity = authenticateDevRequest(
      new Request(
        "https://cloud.test/n/demo/sync?user=runtime&operator=runtime:py&scope=runtime_peer",
      ),
    );
    const ownerSocket = new FakeSocket();
    const runtimeSocket = new FakeSocket();
    const ownerPeer = {
      id: "owner",
      socket: ownerSocket.asCloudflareWebSocket(),
      identity: ownerIdentity,
      connectedAt: "2026-05-22T00:00:00.000Z",
      consecutiveRejectedFrames: 0,
    };
    const runtimePeer = {
      id: "runtime",
      socket: runtimeSocket.asCloudflareWebSocket(),
      identity: runtimeIdentity,
      connectedAt: "2026-05-22T00:00:00.000Z",
      consecutiveRejectedFrames: 0,
    };
    const harness = roomHarness(room);
    let materialized = 0;
    harness.peers.set(ownerPeer.id, ownerPeer);
    harness.peers.set(runtimePeer.id, runtimePeer);
    harness.materializers.set("demo", {
      receiveFrame: async () => {
        materialized += 1;
        return noopMaterializedResult();
      },
      checkpoint: async () => undefined,
      removePeer: async () => undefined,
    });
    const actions = ["interrupt_execution", "send_comm"] as const;
    for (const action of actions) {
      const envelope =
        action === "send_comm"
          ? {
              id: `request-${action}`,
              action,
              message: {
                header: { msg_type: "comm_msg" },
                metadata: {},
                content: {},
                buffers: [],
                channel: "shell",
              },
            }
          : { id: `request-${action}`, action };
      const requestPayload = new TextEncoder().encode(JSON.stringify(envelope));

      await harness.handleMessage(
        "demo",
        ownerPeer,
        encodeTypedFrame(FrameType.REQUEST, requestPayload),
      );

      assert.equal(runtimeSocket.sent.length, actions.indexOf(action) + 1);
      assert.deepEqual(
        [...runtimeSocket.sent.at(-1)!],
        [FrameType.REQUEST, ...Array.from(requestPayload)],
      );
      assert.equal(ownerSocket.sent.length, actions.indexOf(action) + 1);
      const accepted = decodeJsonPayload<Record<string, unknown>>(
        ownerSocket.sent.at(-1)!.slice(1),
      );
      assert.equal(accepted.type, "cloud_frame_accepted");
    }

    assert.equal(materialized, 0);
  });

  it("forwards runtime-agent command REQUEST frames only to the newest runtime peer", async () => {
    const room = new NotebookRoom(fakeState(), {} as Env);
    const ownerIdentity = authenticateDevRequest(
      new Request("https://cloud.test/n/demo/sync?user=alice&operator=browser:a&scope=owner"),
    );
    const oldRuntimeIdentity = authenticateDevRequest(
      new Request(
        "https://cloud.test/n/demo/sync?user=runtime&operator=runtime:old&scope=runtime_peer",
      ),
    );
    const newRuntimeIdentity = authenticateDevRequest(
      new Request(
        "https://cloud.test/n/demo/sync?user=runtime&operator=runtime:new&scope=runtime_peer",
      ),
    );
    const ownerSocket = new FakeSocket();
    const oldRuntimeSocket = new FakeSocket();
    const newRuntimeSocket = new FakeSocket();
    const ownerPeer = {
      id: "owner",
      socket: ownerSocket.asCloudflareWebSocket(),
      identity: ownerIdentity,
      connectedAt: "2026-05-22T00:00:00.000Z",
      consecutiveRejectedFrames: 0,
    };
    const oldRuntimePeer = {
      id: "runtime-old",
      socket: oldRuntimeSocket.asCloudflareWebSocket(),
      identity: oldRuntimeIdentity,
      connectedAt: "2026-05-22T00:00:00.000Z",
      consecutiveRejectedFrames: 0,
    };
    const newRuntimePeer = {
      id: "runtime-new",
      socket: newRuntimeSocket.asCloudflareWebSocket(),
      identity: newRuntimeIdentity,
      connectedAt: "2026-05-22T00:00:01.000Z",
      consecutiveRejectedFrames: 0,
    };
    const harness = roomHarness(room);
    harness.peers.set(ownerPeer.id, ownerPeer);
    harness.peers.set(oldRuntimePeer.id, oldRuntimePeer);
    harness.peers.set(newRuntimePeer.id, newRuntimePeer);
    harness.materializers.set("demo", fakeMaterializer(noopMaterializedResult()));
    const requestPayload = new TextEncoder().encode(
      JSON.stringify({ id: "request-1", action: "interrupt_execution" }),
    );

    await harness.handleMessage(
      "demo",
      ownerPeer,
      encodeTypedFrame(FrameType.REQUEST, requestPayload),
    );

    assert.equal(oldRuntimeSocket.sent.length, 0);
    assert.equal(newRuntimeSocket.sent.length, 1);
    assert.deepEqual(
      [...newRuntimeSocket.sent[0]],
      [FrameType.REQUEST, ...Array.from(requestPayload)],
    );
  });

  it("forwards runtime-agent command REQUEST frames only to the selected runtime session", async () => {
    const room = new NotebookRoom(fakeState(), {} as Env);
    const ownerIdentity = authenticateDevRequest(
      new Request("https://cloud.test/n/demo/sync?user=alice&operator=browser:a&scope=owner"),
    );
    const selectedRuntimeIdentity = authenticateDevRequest(
      new Request(
        "https://cloud.test/n/demo/sync?user=runtime&operator=runtime:selected&scope=runtime_peer",
      ),
    );
    const staleRuntimeIdentity = authenticateDevRequest(
      new Request(
        "https://cloud.test/n/demo/sync?user=runtime&operator=runtime:stale&scope=runtime_peer",
      ),
    );
    const ownerSocket = new FakeSocket();
    const selectedRuntimeSocket = new FakeSocket();
    const staleRuntimeSocket = new FakeSocket();
    const ownerPeer = {
      id: "owner",
      socket: ownerSocket.asCloudflareWebSocket(),
      identity: ownerIdentity,
      connectedAt: "2026-05-22T00:00:00.000Z",
      consecutiveRejectedFrames: 0,
    };
    const selectedRuntimePeer = {
      id: "runtime-selected",
      socket: selectedRuntimeSocket.asCloudflareWebSocket(),
      identity: selectedRuntimeIdentity,
      connectedAt: "2026-05-22T00:00:01.000Z",
      workstation: { workstationId: "ws-lab2", runtimeSessionId: "job-selected" },
      consecutiveRejectedFrames: 0,
    };
    const staleRuntimePeer = {
      id: "runtime-stale",
      socket: staleRuntimeSocket.asCloudflareWebSocket(),
      identity: staleRuntimeIdentity,
      connectedAt: "2026-05-22T00:00:02.000Z",
      workstation: { workstationId: "ws-lab2", runtimeSessionId: "job-stale" },
      consecutiveRejectedFrames: 0,
    };
    const harness = roomHarness(room);
    harness.peers.set(ownerPeer.id, ownerPeer);
    harness.peers.set(selectedRuntimePeer.id, selectedRuntimePeer);
    harness.peers.set(staleRuntimePeer.id, staleRuntimePeer);
    harness.materializers.set("demo", {
      receiveFrame: async () => noopMaterializedResult(),
      checkpoint: async () => undefined,
      removePeer: async () => undefined,
      getWorkstationAttachment: async () => ({
        workstation_id: "ws-lab2",
        display_name: "Lab2 workstation",
        provider: "runtime_peer",
        default_environment_label: "Current Python",
        environment_policy: "current_python",
        status: "ready",
        status_message: null,
        cpu_count: null,
        memory_bytes: null,
        working_directory: "/home/ubuntu/codex/nteract",
        runtime_session_id: "job-selected",
        updated_at: "2026-06-07T00:00:00.000Z",
      }),
    });
    const requestPayload = new TextEncoder().encode(
      JSON.stringify({ id: "request-1", action: "interrupt_execution" }),
    );

    await harness.handleMessage(
      "demo",
      ownerPeer,
      encodeTypedFrame(FrameType.REQUEST, requestPayload),
    );

    assert.equal(staleRuntimeSocket.sent.length, 0);
    assert.equal(selectedRuntimeSocket.sent.length, 1);
    assert.deepEqual(
      [...selectedRuntimeSocket.sent[0]],
      [FrameType.REQUEST, ...Array.from(requestPayload)],
    );
    assert.equal(ownerSocket.sent.length, 1);
    const accepted = decodeJsonPayload<Record<string, unknown>>(ownerSocket.sent[0].slice(1));
    assert.equal(accepted.type, "cloud_frame_accepted");
  });

  it("replaces duplicate runtime peers for the same workstation only", () => {
    const room = new NotebookRoom(fakeState(), {} as Env);
    const sameWorkstationIdentity = authenticateDevRequest(
      new Request(
        "https://cloud.test/n/demo/sync?user=runtime&operator=runtime:old&scope=runtime_peer",
      ),
    );
    const otherWorkstationIdentity = authenticateDevRequest(
      new Request(
        "https://cloud.test/n/demo/sync?user=runtime&operator=runtime:other&scope=runtime_peer",
      ),
    );
    const incomingIdentity = authenticateDevRequest(
      new Request(
        "https://cloud.test/n/demo/sync?user=runtime&operator=runtime:new&scope=runtime_peer",
      ),
    );
    const sameWorkstationSocket = new FakeSocket();
    const otherWorkstationSocket = new FakeSocket();
    const incomingSocket = new FakeSocket();
    const sameWorkstationPeer = {
      id: "runtime-old",
      socket: sameWorkstationSocket.asCloudflareWebSocket(),
      identity: sameWorkstationIdentity,
      connectedAt: "2026-05-22T00:00:00.000Z",
      workstation: { workstationId: "ws-lab2" },
      consecutiveRejectedFrames: 0,
    };
    const otherWorkstationPeer = {
      id: "runtime-other",
      socket: otherWorkstationSocket.asCloudflareWebSocket(),
      identity: otherWorkstationIdentity,
      connectedAt: "2026-05-22T00:00:00.000Z",
      workstation: { workstationId: "ws-other" },
      consecutiveRejectedFrames: 0,
    };
    const incomingPeer = {
      id: "runtime-new",
      socket: incomingSocket.asCloudflareWebSocket(),
      identity: incomingIdentity,
      connectedAt: "2026-05-22T00:00:01.000Z",
      workstation: { workstationId: "ws-lab2" },
      consecutiveRejectedFrames: 0,
    };
    const harness = roomHarness(room);
    harness.peers.set(sameWorkstationPeer.id, sameWorkstationPeer);
    harness.peers.set(otherWorkstationPeer.id, otherWorkstationPeer);
    harness.materializers.set("demo", fakeMaterializer(noopMaterializedResult()));

    harness.removeDuplicateRuntimePeers?.("demo", incomingPeer);

    assert.equal(harness.peers.has(sameWorkstationPeer.id), false);
    assert.equal(sameWorkstationSocket.closed, true);
    assert.equal(sameWorkstationSocket.closeCode, 1008);
    assert.equal(sameWorkstationSocket.closeReason, "replaced by newer runtime peer");
    assert.equal(harness.peers.has(otherWorkstationPeer.id), true);
    assert.equal(otherWorkstationSocket.closed, false);
  });

  it("breaks equal runtime-peer timestamps in favor of the later connection", async () => {
    const room = new NotebookRoom(fakeState(), {} as Env);
    const ownerIdentity = authenticateDevRequest(
      new Request("https://cloud.test/n/demo/sync?user=alice&operator=browser:a&scope=owner"),
    );
    const oldRuntimeIdentity = authenticateDevRequest(
      new Request(
        "https://cloud.test/n/demo/sync?user=runtime&operator=runtime:old&scope=runtime_peer",
      ),
    );
    const newRuntimeIdentity = authenticateDevRequest(
      new Request(
        "https://cloud.test/n/demo/sync?user=runtime&operator=runtime:new&scope=runtime_peer",
      ),
    );
    const ownerSocket = new FakeSocket();
    const oldRuntimeSocket = new FakeSocket();
    const newRuntimeSocket = new FakeSocket();
    const connectedAt = "2026-05-22T00:00:00.000Z";
    const ownerPeer = {
      id: "owner",
      socket: ownerSocket.asCloudflareWebSocket(),
      identity: ownerIdentity,
      connectedAt,
      consecutiveRejectedFrames: 0,
    };
    const oldRuntimePeer = {
      id: "runtime-old",
      socket: oldRuntimeSocket.asCloudflareWebSocket(),
      identity: oldRuntimeIdentity,
      connectedAt,
      consecutiveRejectedFrames: 0,
    };
    const newRuntimePeer = {
      id: "runtime-new",
      socket: newRuntimeSocket.asCloudflareWebSocket(),
      identity: newRuntimeIdentity,
      connectedAt,
      consecutiveRejectedFrames: 0,
    };
    const harness = roomHarness(room);
    harness.peers.set(ownerPeer.id, ownerPeer);
    harness.peers.set(oldRuntimePeer.id, oldRuntimePeer);
    harness.peers.set(newRuntimePeer.id, newRuntimePeer);
    harness.materializers.set("demo", fakeMaterializer(noopMaterializedResult()));
    const requestPayload = new TextEncoder().encode(
      JSON.stringify({ id: "request-1", action: "interrupt_execution" }),
    );

    await harness.handleMessage(
      "demo",
      ownerPeer,
      encodeTypedFrame(FrameType.REQUEST, requestPayload),
    );

    assert.equal(oldRuntimeSocket.sent.length, 0);
    assert.equal(newRuntimeSocket.sent.length, 1);
    assert.deepEqual(
      [...newRuntimeSocket.sent[0]],
      [FrameType.REQUEST, ...Array.from(requestPayload)],
    );
  });

  it("routes hosted completion REQUEST frames through the active runtime peer response", async () => {
    const room = new NotebookRoom(fakeState(), {} as Env);
    const ownerIdentity = authenticateDevRequest(
      new Request("https://cloud.test/n/demo/sync?user=alice&operator=browser:a&scope=owner"),
    );
    const runtimeIdentity = authenticateDevRequest(
      new Request(
        "https://cloud.test/n/demo/sync?user=runtime&operator=runtime:new&scope=runtime_peer",
      ),
    );
    const ownerSocket = new FakeSocket();
    const runtimeSocket = new FakeSocket();
    const ownerPeer = {
      id: "owner",
      socket: ownerSocket.asCloudflareWebSocket(),
      identity: ownerIdentity,
      connectedAt: "2026-05-22T00:00:00.000Z",
      workstation: null,
      consecutiveRejectedFrames: 0,
    };
    const runtimePeer = {
      id: "runtime",
      socket: runtimeSocket.asCloudflareWebSocket(),
      identity: runtimeIdentity,
      connectedAt: "2026-05-22T00:00:01.000Z",
      workstation: null,
      consecutiveRejectedFrames: 0,
    };
    const harness = roomHarness(room);
    let materialized = 0;
    harness.peers.set(ownerPeer.id, ownerPeer);
    harness.peers.set(runtimePeer.id, runtimePeer);
    harness.materializers.set("demo", {
      receiveFrame: async () => {
        materialized += 1;
        return noopMaterializedResult();
      },
      checkpoint: async () => undefined,
      removePeer: async () => undefined,
    });
    const requestPayload = new TextEncoder().encode(
      JSON.stringify({ id: "request-1", action: "complete", code: "pri", cursor_pos: 3 }),
    );

    await harness.handleMessage(
      "demo",
      ownerPeer,
      encodeTypedFrame(FrameType.REQUEST, requestPayload),
    );

    assert.equal(runtimeSocket.sent.length, 1);
    assert.deepEqual(
      [...runtimeSocket.sent[0]],
      [FrameType.REQUEST, ...Array.from(requestPayload)],
    );
    assert.equal(ownerSocket.sent.length, 1);
    assert.equal(
      decodeJsonPayload<Record<string, unknown>>(ownerSocket.sent[0].slice(1)).type,
      "cloud_frame_accepted",
    );

    const responsePayload = new TextEncoder().encode(
      JSON.stringify({
        id: "request-1",
        result: "completion_result",
        items: [{ label: "print", kind: "function" }],
        cursor_start: 0,
        cursor_end: 3,
      }),
    );
    await harness.handleMessage(
      "demo",
      runtimePeer,
      encodeTypedFrame(FrameType.RESPONSE, responsePayload),
    );

    assert.equal(ownerSocket.sent.length, 2);
    assert.deepEqual(
      [...ownerSocket.sent[1]],
      [FrameType.RESPONSE, ...Array.from(responsePayload)],
    );
    assert.equal(materialized, 0);
  });

  it("rejects late hosted completion responses from replaced runtime sessions", async () => {
    const room = new NotebookRoom(fakeState(), {} as Env);
    const ownerIdentity = authenticateDevRequest(
      new Request("https://cloud.test/n/demo/sync?user=alice&operator=browser:a&scope=owner"),
    );
    const selectedRuntimeIdentity = authenticateDevRequest(
      new Request(
        "https://cloud.test/n/demo/sync?user=runtime&operator=runtime:selected&scope=runtime_peer",
      ),
    );
    const staleRuntimeIdentity = authenticateDevRequest(
      new Request(
        "https://cloud.test/n/demo/sync?user=runtime&operator=runtime:stale&scope=runtime_peer",
      ),
    );
    const ownerSocket = new FakeSocket();
    const selectedRuntimeSocket = new FakeSocket();
    const staleRuntimeSocket = new FakeSocket();
    const ownerPeer = {
      id: "owner",
      socket: ownerSocket.asCloudflareWebSocket(),
      identity: ownerIdentity,
      connectedAt: "2026-05-22T00:00:00.000Z",
      consecutiveRejectedFrames: 0,
    };
    const selectedRuntimePeer = {
      id: "runtime-selected",
      socket: selectedRuntimeSocket.asCloudflareWebSocket(),
      identity: selectedRuntimeIdentity,
      connectedAt: "2026-05-22T00:00:01.000Z",
      workstation: { workstationId: "ws-lab2", runtimeSessionId: "job-selected" },
      consecutiveRejectedFrames: 0,
    };
    const staleRuntimePeer = {
      id: "runtime-stale",
      socket: staleRuntimeSocket.asCloudflareWebSocket(),
      identity: staleRuntimeIdentity,
      connectedAt: "2026-05-22T00:00:02.000Z",
      workstation: { workstationId: "ws-lab2", runtimeSessionId: "job-stale" },
      consecutiveRejectedFrames: 0,
    };
    const harness = roomHarness(room);
    harness.peers.set(ownerPeer.id, ownerPeer);
    harness.peers.set(selectedRuntimePeer.id, selectedRuntimePeer);
    harness.peers.set(staleRuntimePeer.id, staleRuntimePeer);
    harness.materializers.set("demo", {
      receiveFrame: async () => noopMaterializedResult(),
      checkpoint: async () => undefined,
      removePeer: async () => undefined,
      getWorkstationAttachment: async () => ({
        workstation_id: "ws-lab2",
        display_name: "Lab2 workstation",
        provider: "runtime_peer",
        default_environment_label: "Current Python",
        environment_policy: "current_python",
        status: "ready",
        status_message: null,
        cpu_count: null,
        memory_bytes: null,
        working_directory: "/home/ubuntu/codex/nteract",
        runtime_session_id: "job-selected",
        updated_at: "2026-06-07T00:00:00.000Z",
      }),
    });

    const requestPayload = new TextEncoder().encode(
      JSON.stringify({ id: "request-1", action: "complete", code: "pri", cursor_pos: 3 }),
    );
    await harness.handleMessage(
      "demo",
      ownerPeer,
      encodeTypedFrame(FrameType.REQUEST, requestPayload),
    );

    assert.equal(selectedRuntimeSocket.sent.length, 1);
    assert.equal(staleRuntimeSocket.sent.length, 0);

    const responsePayload = new TextEncoder().encode(
      JSON.stringify({
        id: "request-1",
        result: "completion_result",
        items: [{ label: "print", kind: "function" }],
        cursor_start: 0,
        cursor_end: 3,
      }),
    );
    await harness.handleMessage(
      "demo",
      staleRuntimePeer,
      encodeTypedFrame(FrameType.RESPONSE, responsePayload),
    );

    assert.equal(staleRuntimeSocket.sent.length, 0, "stale session did not receive an echo");
    assert.equal(staleRuntimeSocket.closed, true);
    assert.equal(staleRuntimeSocket.closeCode, 1008);
    assert.equal(staleRuntimeSocket.closeReason, "stale runtime session");
    assert.equal(ownerSocket.sent.filter((frame) => frame[0] === FrameType.RESPONSE).length, 0);

    await harness.handleMessage(
      "demo",
      selectedRuntimePeer,
      encodeTypedFrame(FrameType.RESPONSE, responsePayload),
    );

    const ownerResponseFrames = ownerSocket.sent.filter((frame) => frame[0] === FrameType.RESPONSE);
    assert.equal(ownerResponseFrames.length, 1);
    assert.deepEqual(
      [...ownerResponseFrames[0]],
      [FrameType.RESPONSE, ...Array.from(responsePayload)],
    );
  });

  it("settles the oldest hosted completion when the pending query cap evicts it", async () => {
    const room = new NotebookRoom(fakeState(), {} as Env);
    const ownerIdentity = authenticateDevRequest(
      new Request("https://cloud.test/n/demo/sync?user=alice&operator=browser:a&scope=owner"),
    );
    const runtimeIdentity = authenticateDevRequest(
      new Request(
        "https://cloud.test/n/demo/sync?user=runtime&operator=runtime:new&scope=runtime_peer",
      ),
    );
    const ownerSocket = new FakeSocket();
    const runtimeSocket = new FakeSocket();
    const ownerPeer = {
      id: "owner",
      socket: ownerSocket.asCloudflareWebSocket(),
      identity: ownerIdentity,
      connectedAt: "2026-05-22T00:00:00.000Z",
      workstation: null,
      consecutiveRejectedFrames: 0,
    };
    const runtimePeer = {
      id: "runtime",
      socket: runtimeSocket.asCloudflareWebSocket(),
      identity: runtimeIdentity,
      connectedAt: "2026-05-22T00:00:01.000Z",
      workstation: null,
      consecutiveRejectedFrames: 0,
    };
    const harness = roomHarness(room);
    harness.peers.set(ownerPeer.id, ownerPeer);
    harness.peers.set(runtimePeer.id, runtimePeer);
    harness.materializers.set("demo", fakeMaterializer(noopMaterializedResult()));

    for (let index = 0; index < 129; index += 1) {
      await harness.handleMessage(
        "demo",
        ownerPeer,
        encodeTypedFrame(
          FrameType.REQUEST,
          new TextEncoder().encode(
            JSON.stringify({
              id: `request-${index}`,
              action: "complete",
              code: "pri",
              cursor_pos: 3,
            }),
          ),
        ),
      );
    }

    const responseFrames = ownerSocket.sent.filter((frame) => frame[0] === FrameType.RESPONSE);
    assert.equal(responseFrames.length, 1);
    const evicted = decodeJsonPayload<Record<string, unknown>>(responseFrames[0].slice(1));
    assert.equal(evicted.id, "request-0");
    assert.equal(evicted.result, "error");
    assert.match(String(evicted.error), /too many queries are pending/);
    assert.equal(runtimeSocket.sent.length, 129);
  });

  it("settles expired hosted completions when pending queries are pruned", async () => {
    const room = new NotebookRoom(fakeState(), {} as Env);
    const ownerIdentity = authenticateDevRequest(
      new Request("https://cloud.test/n/demo/sync?user=alice&operator=browser:a&scope=owner"),
    );
    const runtimeIdentity = authenticateDevRequest(
      new Request(
        "https://cloud.test/n/demo/sync?user=runtime&operator=runtime:new&scope=runtime_peer",
      ),
    );
    const ownerSocket = new FakeSocket();
    const runtimeSocket = new FakeSocket();
    const ownerPeer = {
      id: "owner",
      socket: ownerSocket.asCloudflareWebSocket(),
      identity: ownerIdentity,
      connectedAt: "2026-05-22T00:00:00.000Z",
      workstation: null,
      consecutiveRejectedFrames: 0,
    };
    const runtimePeer = {
      id: "runtime",
      socket: runtimeSocket.asCloudflareWebSocket(),
      identity: runtimeIdentity,
      connectedAt: "2026-05-22T00:00:01.000Z",
      workstation: null,
      consecutiveRejectedFrames: 0,
    };
    const harness = roomHarness(room);
    harness.peers.set(ownerPeer.id, ownerPeer);
    harness.peers.set(runtimePeer.id, runtimePeer);
    harness.materializers.set("demo", fakeMaterializer(noopMaterializedResult()));
    await harness.handleMessage(
      "demo",
      ownerPeer,
      encodeTypedFrame(
        FrameType.REQUEST,
        new TextEncoder().encode(
          JSON.stringify({ id: "request-1", action: "complete", code: "pri", cursor_pos: 3 }),
        ),
      ),
    );

    harness.prunePendingRuntimePeerResponses(Date.now() + 61_000);

    const responseFrames = ownerSocket.sent.filter((frame) => frame[0] === FrameType.RESPONSE);
    assert.equal(responseFrames.length, 1);
    const expired = decodeJsonPayload<Record<string, unknown>>(responseFrames[0].slice(1));
    assert.equal(expired.id, "request-1");
    assert.equal(expired.result, "error");
    assert.match(String(expired.error), /expired before the runtime peer responded/);
  });

  it("counts unmatched runtime-peer RESPONSE frames toward rejected-frame close", async () => {
    const room = new NotebookRoom(fakeState(), {} as Env);
    const runtimeIdentity = authenticateDevRequest(
      new Request(
        "https://cloud.test/n/demo/sync?user=runtime&operator=runtime:new&scope=runtime_peer",
      ),
    );
    const runtimeSocket = new FakeSocket();
    const runtimePeer = {
      id: "runtime",
      socket: runtimeSocket.asCloudflareWebSocket(),
      identity: runtimeIdentity,
      connectedAt: "2026-05-22T00:00:01.000Z",
      workstation: null,
      consecutiveRejectedFrames: 0,
    };
    const harness = roomHarness(room);
    harness.peers.set(runtimePeer.id, runtimePeer);
    harness.materializers.set("demo", fakeMaterializer(noopMaterializedResult()));
    const responsePayload = new TextEncoder().encode(
      JSON.stringify({ id: "missing-request", result: "completion_result", items: [] }),
    );

    await harness.handleMessage(
      "demo",
      runtimePeer,
      encodeTypedFrame(FrameType.RESPONSE, responsePayload),
    );

    assert.equal(runtimePeer.consecutiveRejectedFrames, 1);
    assert.equal(runtimeSocket.closed, false);
    assert.equal(runtimeSocket.sent.length, 1);
    const rejected = decodeJsonPayload<Record<string, unknown>>(runtimeSocket.sent[0].slice(1));
    assert.equal(rejected.type, "cloud_frame_rejected");
    assert.equal(
      rejected.reason,
      "runtime peer response does not match an in-flight hosted request",
    );
  });

  it("rejects forwarded runtime-agent command REQUEST frames when no runtime peer is attached", async () => {
    const room = new NotebookRoom(fakeState(), {} as Env);
    const identity = authenticateDevRequest(
      new Request("https://cloud.test/n/demo/sync?user=alice&operator=browser:a&scope=owner"),
    );
    const socket = new FakeSocket();
    const peer = {
      id: "owner",
      socket: socket.asCloudflareWebSocket(),
      identity,
      connectedAt: "2026-05-22T00:00:00.000Z",
      consecutiveRejectedFrames: 0,
    };
    const harness = roomHarness(room);
    let materialized = 0;
    harness.materializers.set("demo", {
      receiveFrame: async () => {
        materialized += 1;
        return noopMaterializedResult();
      },
      checkpoint: async () => undefined,
      removePeer: async () => undefined,
    });

    await harness.handleMessage(
      "demo",
      peer,
      encodeTypedFrame(
        FrameType.REQUEST,
        new TextEncoder().encode(
          JSON.stringify({ id: "request-1", action: "interrupt_execution" }),
        ),
      ),
    );

    assert.equal(materialized, 0);
    assert.equal(peer.consecutiveRejectedFrames, 0);
    assert.equal(socket.sent.length, 1);
    const rejected = decodeJsonPayload<Record<string, unknown>>(socket.sent[0].slice(1));
    assert.equal(rejected.type, "cloud_frame_rejected");
    assert.equal(rejected.reason, "no runtime peer is attached for interrupt_execution");
  });

  it("rejects hosted execution requests and repairs stale ready attachments with no runtime peer", async () => {
    const room = new NotebookRoom(fakeState(), {} as Env);
    const identity = authenticateDevRequest(
      new Request("https://cloud.test/n/demo/sync?user=alice&operator=browser:a&scope=owner"),
    );
    const socket = new FakeSocket();
    const peer = {
      id: "owner",
      socket: socket.asCloudflareWebSocket(),
      identity,
      connectedAt: "2026-05-22T00:00:00.000Z",
      consecutiveRejectedFrames: 0,
    };
    const harness = roomHarness(room);
    let materialized = 0;
    let reconciledReason: string | null = null;
    harness.materializers.set("demo", {
      receiveFrame: async () => {
        materialized += 1;
        return noopMaterializedResult();
      },
      checkpoint: async () => undefined,
      removePeer: async () => undefined,
      getWorkstationAttachment: async () => ({
        workstation_id: "ws-lab",
        display_name: "Lab",
        provider: "runtime_peer",
        default_environment_label: "Current Python",
        environment_policy: "current_python",
        status: "ready",
        status_message: null,
        cpu_count: null,
        memory_bytes: null,
        working_directory: null,
        updated_at: "2026-05-22T00:00:00.000Z",
        runtime_session_id: "job-old",
      }),
      reconcileRuntimePeerGone: async (reason: string) => {
        reconciledReason = reason;
        return { ...noopMaterializedResult(), changed: true, runtime_state_changed: true };
      },
    } as never);

    await harness.handleMessage(
      "demo",
      peer,
      encodeTypedFrame(
        FrameType.REQUEST,
        new TextEncoder().encode(
          JSON.stringify({ id: "request-1", action: "execute_cell", cell_id: "cell-1" }),
        ),
      ),
    );

    assert.equal(materialized, 0, "stale execution request should not queue new work");
    assert.equal(reconciledReason, "no runtime peer is attached for execute_cell");
    assert.equal(peer.consecutiveRejectedFrames, 0);
    assert.equal(socket.sent.length, 1);
    const rejected = decodeJsonPayload<Record<string, unknown>>(socket.sent[0].slice(1));
    assert.equal(rejected.type, "cloud_frame_rejected");
    assert.equal(rejected.reason, "no runtime peer is attached for execute_cell");
  });

  it("allows hosted execution requests to queue while attach is connecting", async () => {
    const room = new NotebookRoom(fakeState(), {} as Env);
    const identity = authenticateDevRequest(
      new Request("https://cloud.test/n/demo/sync?user=alice&operator=browser:a&scope=owner"),
    );
    const socket = new FakeSocket();
    const peer = {
      id: "owner",
      socket: socket.asCloudflareWebSocket(),
      identity,
      connectedAt: "2026-05-22T00:00:00.000Z",
      consecutiveRejectedFrames: 0,
    };
    const harness = roomHarness(room);
    let materialized = 0;
    let reconciled = 0;
    harness.materializers.set("demo", {
      receiveFrame: async () => {
        materialized += 1;
        return noopMaterializedResult();
      },
      checkpoint: async () => undefined,
      removePeer: async () => undefined,
      getWorkstationAttachment: async () => ({
        workstation_id: "ws-lab",
        display_name: "Lab",
        provider: "runtime_peer",
        default_environment_label: "Current Python",
        environment_policy: "current_python",
        status: "connecting",
        status_message: "Lab accepted the request and is starting compute.",
        cpu_count: null,
        memory_bytes: null,
        working_directory: null,
        updated_at: "2026-05-22T00:00:00.000Z",
        runtime_session_id: "job-new",
      }),
      reconcileRuntimePeerGone: async () => {
        reconciled += 1;
        return noopMaterializedResult();
      },
    } as never);

    await harness.handleMessage(
      "demo",
      peer,
      encodeTypedFrame(
        FrameType.REQUEST,
        new TextEncoder().encode(
          JSON.stringify({ id: "request-1", action: "execute_cell", cell_id: "cell-1" }),
        ),
      ),
    );

    assert.equal(materialized, 1, "connecting attach may queue initial execution");
    assert.equal(reconciled, 0);
    assert.equal(peer.consecutiveRejectedFrames, 0);
    assert.equal(socket.sent.length, 1);
    const accepted = decodeJsonPayload<Record<string, unknown>>(socket.sent[0].slice(1));
    assert.equal(accepted.type, "cloud_frame_accepted");
  });

  it("creates an owner-scoped resume attach job when owner execution finds no runtime peer", async () => {
    const db = new ResumeNotebookD1();
    const room = new NotebookRoom(fakeState(), { DB: db } as unknown as Env);
    const identity = authenticateDevRequest(
      new Request("https://cloud.test/n/demo/sync?user=alice&operator=browser:a&scope=owner"),
    );
    const socket = new FakeSocket();
    const peer = {
      id: "owner",
      socket: socket.asCloudflareWebSocket(),
      identity,
      connectedAt: "2026-05-22T00:00:00.000Z",
      consecutiveRejectedFrames: 0,
    };
    const harness = roomHarness(room);
    let materialized = 0;
    let publishedAttachment: unknown = null;
    harness.materializers.set("demo", {
      receiveFrame: async () => {
        materialized += 1;
        return noopMaterializedResult();
      },
      checkpoint: async () => undefined,
      removePeer: async () => undefined,
      getWorkstationAttachment: async () => ({
        workstation_id: "ws-lab2",
        display_name: "Lab2",
        provider: "runtime_peer",
        default_environment_label: "Current Python",
        environment_policy: "current_python",
        status: "disconnected",
        status_message: "Compute stopped after 30 minutes without queued or active execution.",
        cpu_count: null,
        memory_bytes: null,
        working_directory: "/srv/project",
        updated_at: "2026-05-22T00:00:00.000Z",
        runtime_session_id: "job-old",
      }),
      setWorkstationAttachment: async (attachment: unknown) => {
        publishedAttachment = attachment;
        return {
          ...noopMaterializedResult(),
          changed: true,
          runtime_state_changed: true,
        };
      },
    } as never);

    await harness.handleMessage(
      "demo",
      peer,
      encodeTypedFrame(
        FrameType.REQUEST,
        new TextEncoder().encode(
          JSON.stringify({ id: "request-1", action: "execute_cell", cell_id: "cell-1" }),
        ),
      ),
    );

    assert.equal(materialized, 1);
    assert.equal(db.attachJobs.length, 1);
    assert.equal(db.attachJobs[0]?.owner_principal, "user:dev:alice");
    assert.equal(db.attachJobs[0]?.trigger, "resume");
    assert.equal(db.attachJobs[0]?.requested_by_actor_label, "execution resume");
    assert.equal((publishedAttachment as { status?: string })?.status, "connecting");
    assert.equal(
      (publishedAttachment as { runtime_session_id?: string })?.runtime_session_id,
      db.attachJobs[0]?.id,
    );
    const accepted = decodeJsonPayload<Record<string, unknown>>(socket.sent[0].slice(1));
    assert.equal(accepted.type, "cloud_frame_accepted");
  });

  it("creates an owner-scoped resume attach job when idle owner execution finds no runtime peer", async () => {
    const db = new ResumeNotebookD1();
    const room = new NotebookRoom(fakeState(), { DB: db } as unknown as Env);
    const identity = authenticateDevRequest(
      new Request("https://cloud.test/n/demo/sync?user=alice&operator=browser:a&scope=owner"),
    );
    const socket = new FakeSocket();
    const peer = {
      id: "owner",
      socket: socket.asCloudflareWebSocket(),
      identity,
      connectedAt: "2026-05-22T00:00:00.000Z",
      consecutiveRejectedFrames: 0,
    };
    const harness = roomHarness(room);
    let materialized = 0;
    let publishedAttachment: unknown = null;
    harness.materializers.set("demo", {
      receiveFrame: async () => {
        materialized += 1;
        return noopMaterializedResult();
      },
      checkpoint: async () => undefined,
      removePeer: async () => undefined,
      getWorkstationAttachment: async () => ({
        workstation_id: "ws-lab2",
        display_name: "Lab2",
        provider: "runtime_peer",
        default_environment_label: "Current Python",
        environment_policy: "current_python",
        status: "idle",
        status_message: "Compute stopped after 30 minutes without queued or active execution.",
        cpu_count: null,
        memory_bytes: null,
        working_directory: "/srv/project",
        updated_at: "2026-05-22T00:00:00.000Z",
        runtime_session_id: "job-old",
      }),
      setWorkstationAttachment: async (attachment: unknown) => {
        publishedAttachment = attachment;
        return {
          ...noopMaterializedResult(),
          changed: true,
          runtime_state_changed: true,
        };
      },
    } as never);

    await harness.handleMessage(
      "demo",
      peer,
      encodeTypedFrame(
        FrameType.REQUEST,
        new TextEncoder().encode(
          JSON.stringify({ id: "request-1", action: "execute_cell", cell_id: "cell-1" }),
        ),
      ),
    );

    assert.equal(materialized, 1);
    assert.equal(db.attachJobs.length, 1);
    assert.equal(db.attachJobs[0]?.owner_principal, "user:dev:alice");
    assert.equal(db.attachJobs[0]?.trigger, "resume");
    assert.equal(db.attachJobs[0]?.requested_by_actor_label, "execution resume");
    assert.equal((publishedAttachment as { status?: string })?.status, "connecting");
    assert.equal(
      (publishedAttachment as { runtime_session_id?: string })?.runtime_session_id,
      db.attachJobs[0]?.id,
    );
    assert.equal(
      await harness.runtimePeerAuthorityError?.("demo", {
        workstationId: "ws-lab2",
        runtimeSessionId: db.attachJobs[0]?.id,
      }),
      null,
    );
    const accepted = decodeJsonPayload<Record<string, unknown>>(socket.sent[0].slice(1));
    assert.equal(accepted.type, "cloud_frame_accepted");
  });

  it("admits owner execution after real idle reconciliation idles the attachment", async () => {
    const db = new ResumeNotebookD1();
    const state = fakeState();
    const env = { DB: db } as unknown as Env;
    const room = new NotebookRoom(state, env);
    const materializer = new RoomMaterializer("demo", state, env);
    const harness = roomHarness(room);
    harness.materializers.set("demo", materializer as never);
    await materializer.setWorkstationAttachment({
      workstation_id: "ws-lab2",
      display_name: "Lab2",
      provider: "runtime_peer",
      default_environment_label: "Current Python",
      environment_policy: "current_python",
      status: "ready",
      status_message: null,
      cpu_count: null,
      memory_bytes: null,
      working_directory: "/srv/project",
      updated_at: "2026-05-22T00:00:00.000Z",
      runtime_session_id: "job-old",
    });

    const idleResult = await materializer.reconcileRuntimeIdleTimeout(
      "Compute stopped after 30 minutes without queued or active execution.",
      "2026-07-08T00:30:00.000Z",
    );
    assert.equal(idleResult.changed, true);
    assert.equal((await materializer.getWorkstationAttachment())?.status, "idle");

    const identity = authenticateDevRequest(
      new Request("https://cloud.test/n/demo/sync?user=alice&operator=browser:a&scope=owner"),
    );
    const socket = new FakeSocket();
    const peer = {
      id: "owner",
      socket: socket.asCloudflareWebSocket(),
      identity,
      connectedAt: "2026-05-22T00:00:00.000Z",
      consecutiveRejectedFrames: 0,
    };

    await harness.handleMessage(
      "demo",
      peer,
      encodeTypedFrame(
        FrameType.REQUEST,
        new TextEncoder().encode(
          JSON.stringify({
            id: "request-1",
            action: "execute_cell",
            cell_id: initialHostedCellIdForTest("demo"),
          }),
        ),
      ),
    );

    assert.equal(db.attachJobs.length, 1);
    const attachment = await materializer.getWorkstationAttachment();
    assert.equal(attachment?.status, "connecting");
    assert.equal(attachment?.runtime_session_id, db.attachJobs[0]?.id);
    const accepted = decodeJsonPayload<Record<string, unknown>>(socket.sent[0].slice(1));
    assert.equal(accepted.type, "cloud_frame_accepted");
  });

  it("rejects non-owner execution without creating a resume attach job", async () => {
    const db = new ResumeNotebookD1();
    const room = new NotebookRoom(fakeState(), { DB: db } as unknown as Env);
    const identity = authenticateDevRequest(
      new Request("https://cloud.test/n/demo/sync?user=alice&operator=browser:a&scope=editor"),
    );
    const socket = new FakeSocket();
    const peer = {
      id: "editor",
      socket: socket.asCloudflareWebSocket(),
      identity,
      connectedAt: "2026-05-22T00:00:00.000Z",
      consecutiveRejectedFrames: 0,
    };
    const harness = roomHarness(room);
    harness.materializers.set("demo", {
      receiveFrame: async () => {
        throw new Error("non-owner execution should not reach the room host");
      },
      checkpoint: async () => undefined,
      removePeer: async () => undefined,
      getWorkstationAttachment: async () => {
        throw new Error("non-owner execution should not inspect workstation attachment");
      },
    } as never);

    await harness.handleMessage(
      "demo",
      peer,
      encodeTypedFrame(
        FrameType.REQUEST,
        new TextEncoder().encode(
          JSON.stringify({ id: "request-1", action: "execute_cell", cell_id: "cell-1" }),
        ),
      ),
    );

    assert.equal(db.attachJobs.length, 0);
    const rejected = decodeJsonPayload<Record<string, unknown>>(socket.sent[0].slice(1));
    assert.equal(rejected.type, "cloud_frame_rejected");
    assert.equal(rejected.reason, "editor cannot write request frames");
  });

  it("rejects response-bearing runtime REQUEST frames instead of acknowledging no-ops", async () => {
    const room = new NotebookRoom(fakeState(), {} as Env);
    const identity = authenticateDevRequest(
      new Request("https://cloud.test/n/demo/sync?user=alice&operator=browser:a&scope=owner"),
    );
    const socket = new FakeSocket();
    const peer = {
      id: "owner",
      socket: socket.asCloudflareWebSocket(),
      identity,
      connectedAt: "2026-05-22T00:00:00.000Z",
      consecutiveRejectedFrames: 0,
    };
    const harness = roomHarness(room);
    let materialized = 0;
    harness.materializers.set("demo", {
      receiveFrame: async () => {
        materialized += 1;
        return noopMaterializedResult();
      },
      checkpoint: async () => undefined,
      removePeer: async () => undefined,
    });

    const unsupportedActions = [
      "launch_kernel",
      "restart_kernel",
      "shutdown_kernel",
      "sync_environment",
      "get_history",
    ] as const;

    for (const action of unsupportedActions) {
      await harness.handleMessage(
        "demo",
        peer,
        encodeTypedFrame(
          FrameType.REQUEST,
          new TextEncoder().encode(JSON.stringify({ id: `request-${action}`, action })),
        ),
      );

      assert.equal(materialized, 0);
      assert.equal(peer.consecutiveRejectedFrames, 0);
      assert.equal(socket.sent.length, unsupportedActions.indexOf(action) + 1);
      const rejected = decodeJsonPayload<Record<string, unknown>>(socket.sent.at(-1)!.slice(1));
      assert.equal(rejected.type, "cloud_frame_rejected");
      assert.equal(
        rejected.reason,
        `hosted cloud rooms do not yet support response-bearing runtime request ${action}`,
      );
    }
  });

  it("rejects non-owner REQUEST frames on the WebSocket path", async () => {
    for (const scope of ["editor", "viewer", "runtime_peer"] as const) {
      const room = new NotebookRoom(fakeState(), {} as Env);
      const identity = authenticateDevRequest(
        new Request(
          `https://cloud.test/n/demo/sync?user=${scope}&operator=desktop:a&scope=${scope}`,
        ),
      );
      const socket = new FakeSocket();
      const peer = {
        id: scope,
        socket: socket.asCloudflareWebSocket(),
        identity,
        connectedAt: "2026-05-22T00:00:00.000Z",
      };
      const harness = roomHarness(room);
      let materialized = 0;
      harness.materializers.set("demo", {
        receiveFrame: async () => {
          materialized += 1;
          return noopMaterializedResult();
        },
        checkpoint: async () => undefined,
      });

      await harness.handleMessage(
        "demo",
        peer,
        encodeTypedFrame(
          FrameType.REQUEST,
          new TextEncoder().encode(
            JSON.stringify({ id: "request-1", action: "execute_cell", cell_id: "cell-1" }),
          ),
        ),
      );

      assert.equal(materialized, 0, `${scope} request reached room host`);
      assert.equal(socket.sent.length, 1);
      const rejected = decodeJsonPayload<Record<string, unknown>>(socket.sent[0].slice(1));
      assert.equal(rejected.type, "cloud_frame_rejected");
      assert.equal(rejected.reason, `${scope} cannot write request frames`);
    }
  });

  it("accepts runtime peer PUT_BLOB frames on the WebSocket path", async () => {
    const room = new NotebookRoom(fakeState(), {} as Env);
    const identity = authenticateDevRequest(
      new Request(
        "https://cloud.test/n/demo/sync?user=runtime&operator=runtime:py&scope=runtime_peer",
      ),
    );
    const socket = new FakeSocket();
    const peer = {
      id: "runtime",
      socket: socket.asCloudflareWebSocket(),
      identity,
      connectedAt: "2026-05-22T00:00:00.000Z",
    };
    const harness = roomHarness(room);

    await harness.handleMessage(
      "demo",
      peer,
      encodeTypedFrame(FrameType.PUT_BLOB, new Uint8Array([1, 2, 3])),
    );

    assert.equal(socket.sent.length, 1);
    assert.equal(
      decodeJsonPayload<Record<string, unknown>>(socket.sent[0].slice(1)).type,
      "cloud_frame_accepted",
    );
  });

  it("closes stale runtime sessions before they can author room frames", async () => {
    const room = new NotebookRoom(fakeState(), {} as Env);
    const harness = roomHarness(room);
    const socket = new FakeSocket();
    const runtimePeer = {
      id: "runtime",
      socket: socket.asCloudflareWebSocket(),
      identity: authenticateDevRequest(
        new Request(
          "https://cloud.test/n/demo/sync?user=runtime&operator=runtime:py&scope=runtime_peer",
        ),
      ),
      connectedAt: "2026-05-22T00:00:00.000Z",
      workstation: {
        workstationId: "lab2",
        runtimeSessionId: "old-job",
      },
    };
    harness.peers.set(runtimePeer.id, runtimePeer);

    let materialized = 0;
    harness.materializers.set("demo", {
      receiveFrame: async () => {
        materialized += 1;
        return noopMaterializedResult();
      },
      checkpoint: async () => undefined,
      removePeer: async () => undefined,
      getWorkstationAttachment: async () => ({
        workstation_id: "lab2",
        display_name: "Lab2 workstation",
        provider: "runtime_peer",
        default_environment_label: "Current Python",
        environment_policy: "current_python",
        status: "ready",
        status_message: null,
        cpu_count: null,
        memory_bytes: null,
        working_directory: "/home/ubuntu/codex/nteract",
        runtime_session_id: "new-job",
        updated_at: "2026-06-07T00:00:00.000Z",
      }),
    } as never);

    await harness.handleMessage(
      "demo",
      runtimePeer,
      encodeTypedFrame(FrameType.RUNTIME_STATE_SYNC, new Uint8Array([1])),
    );

    assert.equal(materialized, 0, "stale runtime frame reached room host");
    assert.equal(socket.sent.length, 0, "stale runtime frame was not echoed");
    assert.equal(socket.closed, true);
    assert.equal(socket.closeCode, 1008);
    assert.equal(socket.closeReason, "stale runtime session");
    assert.equal(harness.peerForSocket(socket.asCloudflareWebSocket()), undefined);
  });
});

describe("NotebookRoom runtime_peer-gone watchdog", () => {
  function peerWithScope(id: string, scope: string): PeerForTest {
    const identity = authenticateDevRequest(
      new Request(
        `https://cloud.test/n/demo/sync?user=${id}&operator=desktop:${id}&scope=${scope}`,
      ),
    );
    return {
      id,
      socket: new FakeSocket().asCloudflareWebSocket(),
      identity,
      connectedAt: "2026-06-05T00:00:00.000Z",
    };
  }

  it("arms the alarm when the last runtime_peer leaves and reconciles on fire", async () => {
    const state = alarmCapableState();
    const room = new NotebookRoom(state.state, {} as Env);
    const harness = roomHarness(room);

    // A reconcile-recording fake materializer stands in for the wasm host.
    let reconcileCalls = 0;
    const reconciled: RoomHostFrameResult = {
      changed: true,
      notebook_changed: false,
      runtime_state_changed: true,
      outbound: [],
    };
    harness.materializers.set("demo", {
      receiveFrame: async () => noopMaterializedResult(),
      checkpoint: async () => undefined,
      removePeer: async () => undefined,
      getWorkstationAttachment: async () => null,
      reconcileRuntimePeerGone: async () => {
        reconcileCalls += 1;
        return reconciled;
      },
    } as never);

    const runtimePeer = peerWithScope("rt", "runtime_peer");
    harness.peers.set(runtimePeer.id, runtimePeer);
    harness.removePeer("demo", runtimePeer);
    await state.drain();

    // Departure with no runtime_peer left -> alarm armed.
    assert.equal(await state.getAlarm(), state.now + 30_000);
    assert.equal(reconcileCalls, 0, "reconcile waits for the grace alarm to fire");

    // Fire the alarm: still no runtime_peer -> reconcile runs.
    await (room as unknown as { alarm(): Promise<void> }).alarm();
    await state.drain();
    assert.equal(reconcileCalls, 1, "alarm reconciles the orphaned room");
  });

  it("skips peer-gone reconcile when idle teardown already materialized", async () => {
    const state = alarmCapableState();
    const room = new NotebookRoom(state.state, {} as Env);
    const harness = roomHarness(room);
    const attachment = {
      workstation_id: "ws-lab2",
      display_name: "Lab2",
      provider: "runtime_peer",
      default_environment_label: "Current Python",
      environment_policy: "current_python",
      status: "idle",
      status_message: "Compute stopped after 30 minutes without queued or active execution.",
      updated_at: "2026-05-22T00:00:02.000Z",
      runtime_session_id: "job-idle",
    };
    let reconcileCalls = 0;
    harness.materializers.set("demo", {
      receiveFrame: async () => noopMaterializedResult(),
      checkpoint: async () => undefined,
      removePeer: async () => undefined,
      getWorkstationAttachment: async () => attachment,
      reconcileRuntimePeerGone: async () => {
        reconcileCalls += 1;
        attachment.status = "error";
        attachment.status_message = "runtime peer disconnected";
        return {
          ...noopMaterializedResult(),
          changed: true,
          runtime_state_changed: true,
        };
      },
    } as never);

    const runtimePeer = peerWithScope("rt", "runtime_peer");
    harness.peers.set(runtimePeer.id, runtimePeer);
    harness.removePeer("demo", runtimePeer);
    await state.drain();
    assert.equal(await state.getAlarm(), state.now + 30_000, "watch armed after departure");

    const logs: unknown[][] = [];
    const originalInfo = console.info;
    console.info = (...args: unknown[]) => {
      logs.push(args);
    };
    try {
      await (room as unknown as { alarm(): Promise<void> }).alarm();
      await state.drain();
    } finally {
      console.info = originalInfo;
    }

    assert.equal(reconcileCalls, 0, "idle attachment suppresses peer-gone reconcile");
    assert.equal(attachment.status, "idle");
    assert.equal(attachment.runtime_session_id, "job-idle");
    assert.equal(attachment.updated_at, "2026-05-22T00:00:02.000Z");
    const skipLog = logs
      .map((args) => args[1])
      .find(
        (record): record is { event?: unknown; counter?: unknown } =>
          typeof record === "object" &&
          record !== null &&
          (record as { counter?: unknown }).counter === "runtime_peer_watch_skipped_idle",
      );
    assert.equal(skipLog?.event, "room.runtime_peer_watch.skipped_idle");
  });

  it("tears down an idle runtime after the TTL without considering viewer sockets", async () => {
    const state = alarmCapableState();
    const room = new NotebookRoom(state.state, {} as Env);
    const harness = roomHarness(room);
    const runtimeSocket = new FakeSocket();
    const viewerSocket = new FakeSocket();
    const runtimePeer = peerWithScope("rt", "runtime_peer");
    runtimePeer.socket = runtimeSocket.asCloudflareWebSocket();
    const viewerPeer = peerWithScope("viewer", "viewer");
    viewerPeer.socket = viewerSocket.asCloudflareWebSocket();
    harness.peers.set(runtimePeer.id, runtimePeer);
    harness.peers.set(viewerPeer.id, viewerPeer);
    let idleReconciles = 0;
    harness.materializers.set("demo", {
      receiveFrame: async () => noopMaterializedResult(),
      checkpoint: async () => undefined,
      removePeer: async () => undefined,
      getRuntimeExecutionActivity: async () => ({ executing: false, queueDepth: 0 }),
      reconcileRuntimeIdleTimeout: async () => {
        idleReconciles += 1;
        return {
          ...noopMaterializedResult(),
          changed: true,
          runtime_state_changed: true,
          outbound: [
            {
              peer_id: "rt",
              frame_type: FrameType.RUNTIME_STATE_SYNC,
              payload: new Uint8Array([7, 8, 9]),
            },
          ],
        };
      },
      getWorkstationAttachment: async () => ({
        workstation_id: "ws-lab2",
        display_name: "Lab2",
        provider: "runtime_peer",
        default_environment_label: "Current Python",
        environment_policy: "current_python",
        status: "ready",
        status_message: null,
        updated_at: "2026-05-22T00:00:00.000Z",
        runtime_session_id: "job-idle",
      }),
    } as never);

    harness.refreshRuntimeIdleWatch?.("demo");
    await state.drain();

    assert.equal(await state.getAlarm(), state.now + RUNTIME_IDLE_TTL_MS);

    await (room as unknown as { alarm(): Promise<void> }).alarm();
    await state.drain();

    assert.equal(idleReconciles, 1);
    assert.deepEqual([...runtimeSocket.sent[0]], [FrameType.RUNTIME_STATE_SYNC, 7, 8, 9]);
    assert.equal(runtimeSocket.closed, true);
    assert.equal(runtimeSocket.closeReason, "runtime idle timeout");
    assert.equal(viewerSocket.closed, false, "viewer presence must not defer idle teardown");
  });

  it("clears a racing peer-gone watch after idle teardown owns the room state", async () => {
    const state = alarmCapableState();
    const room = new NotebookRoom(state.state, {} as Env);
    const harness = roomHarness(room);
    const runtimeSocket = new FakeSocket();
    const runtimePeer = peerWithScope("rt", "runtime_peer");
    runtimePeer.socket = runtimeSocket.asCloudflareWebSocket();
    harness.peers.set(runtimePeer.id, runtimePeer);
    let idleReconciles = 0;
    harness.materializers.set("demo", {
      receiveFrame: async () => noopMaterializedResult(),
      checkpoint: async () => undefined,
      removePeer: async () => undefined,
      getRuntimeExecutionActivity: async () => ({ executing: false, queueDepth: 0 }),
      reconcileRuntimeIdleTimeout: async () => {
        idleReconciles += 1;
        return {
          ...noopMaterializedResult(),
          changed: true,
          runtime_state_changed: true,
        };
      },
    } as never);

    await state.state.storage.put("runtime_peer_gone_watch", "demo");
    await state.state.storage.put("runtime_peer_gone_watch_alarm_at", Number.MAX_SAFE_INTEGER);
    await state.state.storage.put("runtime_idle_watch", "demo");
    await state.state.storage.put("runtime_idle_watch_alarm_at", 0);

    await (room as unknown as { alarm(): Promise<void> }).alarm();
    await state.drain();

    assert.equal(idleReconciles, 1);
    assert.equal(runtimeSocket.closed, true);
    assert.equal(runtimeSocket.closeReason, "runtime idle timeout");
    assert.equal(await state.state.storage.get("runtime_peer_gone_watch"), undefined);
    assert.equal(await state.state.storage.get("runtime_peer_gone_watch_alarm_at"), undefined);
    assert.equal(await state.getAlarm(), null);
  });

  it("does not arm idle teardown while execution is active or queued", async () => {
    const state = alarmCapableState();
    const room = new NotebookRoom(state.state, {} as Env);
    const harness = roomHarness(room);
    harness.peers.set("rt", peerWithScope("rt", "runtime_peer"));
    harness.materializers.set("demo", {
      receiveFrame: async () => noopMaterializedResult(),
      checkpoint: async () => undefined,
      removePeer: async () => undefined,
      getRuntimeExecutionActivity: async () => ({ executing: true, queueDepth: 1 }),
    } as never);

    harness.refreshRuntimeIdleWatch?.("demo");
    await state.drain();

    assert.equal(await state.getAlarm(), null);
  });

  it("publishes active runtime peers to the owner compute index", async () => {
    const compute = new FakeOwnerComputeIndexNamespace();
    const env = roomEnvWithComputeIndex(compute);
    const room = new NotebookRoom(fakeState(), env);
    const harness = roomHarness(room);
    const runtimePeer = {
      ...peerWithScope("rt", "runtime_peer"),
      workstation: {
        workstationId: "ws-lab2",
        displayName: "lab2 workstation",
        defaultEnvironmentLabel: "Current Python",
        environmentPolicy: "current_python",
        runtimeSessionId: "job-1",
        workingDirectory: "/home/ubuntu/project",
      },
    };
    harness.peers.set(runtimePeer.id, runtimePeer);
    let currentAttachment: unknown = null;
    harness.materializers.set("demo", {
      receiveFrame: async () => noopMaterializedResult(),
      checkpoint: async () => undefined,
      setWorkstationAttachment: async (attachment: unknown) => {
        currentAttachment = attachment;
        return {
          ...noopMaterializedResult(),
          changed: true,
          runtime_state_changed: true,
        };
      },
      getWorkstationAttachment: async () => currentAttachment,
      getRuntimeQueueDepth: async () => 2,
    } as never);

    await harness.publishRuntimePeerAttachment("demo", runtimePeer);

    assert.deepEqual(
      compute.requests.map((request) => [
        request.objectName,
        new URL(request.url).pathname,
        request.body?.summary?.status,
        request.body?.summary?.queue_depth,
        request.body?.summary?.runtime_peer_count,
        request.body?.summary?.workstation_id,
      ]),
      [["owner-compute:v1:user:dev:alice", "/upsert", "active", 2, 1, "ws-lab2"]],
    );
  });

  it("publishes stale compute when the last runtime peer leaves", async () => {
    const state = hibernatedState([]);
    const compute = new FakeOwnerComputeIndexNamespace();
    const env = roomEnvWithComputeIndex(compute);
    const room = new NotebookRoom(state.state, env);
    const harness = roomHarness(room);
    const runtimePeer = peerWithScope("rt", "runtime_peer");
    harness.peers.set(runtimePeer.id, runtimePeer);
    harness.materializers.set("demo", {
      receiveFrame: async () => noopMaterializedResult(),
      checkpoint: async () => undefined,
      getWorkstationAttachment: async () => ({
        workstation_id: "ws-lab2",
        display_name: "lab2 workstation",
        provider: "runtime_peer",
        default_environment_label: "Current Python",
        environment_policy: "current_python",
        status: "ready",
        status_message: null,
        updated_at: "2026-06-23T00:00:00.000Z",
        runtime_session_id: "job-1",
      }),
      getRuntimeQueueDepth: async () => 1,
      removePeer: async () => undefined,
      reconcileRuntimePeerGone: async () => noopMaterializedResult(),
    } as never);

    harness.removePeer("demo", runtimePeer);
    await state.drain();

    const staleRequest = compute.requests.find(
      (request) => request.body?.summary?.status === "stale",
    );
    assert.equal(staleRequest?.objectName, "owner-compute:v1:user:dev:alice");
    assert.equal(staleRequest?.body?.summary?.queue_depth, 1);
    assert.equal(staleRequest?.body?.summary?.runtime_peer_count, 0);
  });

  it("disarms (no reconcile) when a runtime_peer rejoins within the grace window", async () => {
    const state = alarmCapableState();
    const room = new NotebookRoom(state.state, {} as Env);
    const harness = roomHarness(room);
    let reconcileCalls = 0;
    harness.materializers.set("demo", {
      receiveFrame: async () => noopMaterializedResult(),
      checkpoint: async () => undefined,
      removePeer: async () => undefined,
      reconcileRuntimePeerGone: async () => {
        reconcileCalls += 1;
        return noopMaterializedResult();
      },
    } as never);

    const runtimePeer = peerWithScope("rt", "runtime_peer");
    harness.peers.set(runtimePeer.id, runtimePeer);
    harness.removePeer("demo", runtimePeer);
    await state.drain();
    assert.equal(await state.getAlarm(), state.now + 30_000, "armed after departure");

    // A fresh runtime_peer rejoins before the alarm; the watch key is cleared so
    // a late alarm becomes a no-op.
    const rejoined = peerWithScope("rt2", "runtime_peer");
    harness.peers.set(rejoined.id, rejoined);
    harness.refreshRuntimePeerWatch?.("demo");
    await state.drain();
    assert.equal(await state.getAlarm(), null, "rejoin disarmed the alarm");

    await (room as unknown as { alarm(): Promise<void> }).alarm();
    await state.drain();
    assert.equal(reconcileCalls, 0, "no reconcile after a recovered blip");
  });

  it("a fired alarm is a no-op when a runtime_peer is present", async () => {
    const state = alarmCapableState();
    const room = new NotebookRoom(state.state, {} as Env);
    const harness = roomHarness(room);
    let reconcileCalls = 0;
    harness.materializers.set("demo", {
      receiveFrame: async () => noopMaterializedResult(),
      checkpoint: async () => undefined,
      removePeer: async () => undefined,
      reconcileRuntimePeerGone: async () => {
        reconcileCalls += 1;
        return noopMaterializedResult();
      },
    } as never);

    // Watch key set (as if armed), but a runtime_peer is attached when it fires.
    await state.state.storage.put("runtime_peer_gone_watch", "demo");
    harness.peers.set("rt", peerWithScope("rt", "runtime_peer"));

    await (room as unknown as { alarm(): Promise<void> }).alarm();
    await state.drain();
    assert.equal(reconcileCalls, 0, "present runtime_peer suppresses reconcile");
  });

  it("runs manual runtime-state repair through the internal room-host control path", async () => {
    const state = hibernatedState([]);
    const room = new NotebookRoom(state.state, {} as Env);
    const harness = roomHarness(room);
    const viewerSocket = new FakeSocket();
    const viewerPeer = peerWithScope("viewer", "viewer");
    viewerPeer.socket = viewerSocket.asCloudflareWebSocket();
    harness.peers.set(viewerPeer.id, viewerPeer);

    let checkpointed = 0;
    let repairReason: string | undefined;
    harness.materializers.set("demo", {
      receiveFrame: async () => noopMaterializedResult(),
      checkpoint: async () => {
        checkpointed += 1;
      },
      reconcileRuntimePeerGone: async (reason: string) => {
        repairReason = reason;
        return {
          ...noopMaterializedResult(),
          changed: true,
          runtime_state_changed: true,
          outbound: [
            {
              peer_id: viewerPeer.id,
              frame_type: FrameType.RUNTIME_STATE_SYNC,
              payload: [9, 8, 7],
            },
          ],
        };
      },
    } as never);

    const response = await room.fetch(
      new Request("https://room.internal/internal/n/demo/runtime-state-repair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "manual repair: stale topic-viz runtime" }),
      }),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      changed: true,
      forced: false,
      checkpoint_persisted: true,
      runtime_peer_count: 0,
    });
    assert.equal(repairReason, "manual repair: stale topic-viz runtime");
    assert.equal(checkpointed, 1);
    assert.deepEqual([...viewerSocket.sent[0]], [FrameType.RUNTIME_STATE_SYNC, 9, 8, 7]);
  });

  it("skips runtime-state repair when the expected runtime session is stale", async () => {
    const room = new NotebookRoom(fakeState(), {} as Env);
    const harness = roomHarness(room);
    let checkpointed = 0;
    let reconcileCalls = 0;
    const attachment = {
      workstation_id: "ws-lab2",
      display_name: "Lab2",
      provider: "runtime_peer",
      default_environment_label: "Current Python",
      environment_policy: "current_python",
      runtime_session_id: "fresh-job",
      status: "connecting",
      status_message: "Waiting for Lab2 to accept the compute request.",
      cpu_count: 8,
      memory_bytes: 16_000_000_000,
      working_directory: "/home/ubuntu/project",
      updated_at: "2026-05-22T00:00:01.000Z",
    };
    harness.materializers.set("demo", {
      receiveFrame: async () => noopMaterializedResult(),
      checkpoint: async () => {
        checkpointed += 1;
      },
      getWorkstationAttachment: async () => attachment,
      reconcileRuntimePeerGone: async () => {
        reconcileCalls += 1;
        return {
          ...noopMaterializedResult(),
          changed: true,
          runtime_state_changed: true,
        };
      },
    } as never);

    const response = await room.fetch(
      new Request("https://room.internal/internal/n/demo/runtime-state-repair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expected_runtime_session_id: "expired-job",
          reason: "expired pending attach job",
        }),
      }),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      changed: false,
      skipped: true,
      skip_reason: "runtime_session_mismatch",
      forced: false,
      runtime_peer_count: 0,
    });
    assert.equal(reconcileCalls, 0);
    assert.equal(checkpointed, 0);
    assert.equal(attachment.status, "connecting");
    assert.equal(attachment.runtime_session_id, "fresh-job");
  });

  it("repairs RuntimeStateDoc when the expected runtime session still owns the attachment", async () => {
    const room = new NotebookRoom(fakeState(), {} as Env);
    const harness = roomHarness(room);
    let checkpointed = 0;
    let repairReason: string | undefined;
    const attachment = {
      workstation_id: "ws-lab2",
      display_name: "Lab2",
      provider: "runtime_peer",
      default_environment_label: "Current Python",
      environment_policy: "current_python",
      runtime_session_id: "expired-job",
      status: "connecting",
      status_message: "Waiting for Lab2 to accept the compute request.",
      cpu_count: 8,
      memory_bytes: 16_000_000_000,
      working_directory: "/home/ubuntu/project",
      updated_at: "2026-05-22T00:00:01.000Z",
    };
    harness.materializers.set("demo", {
      receiveFrame: async () => noopMaterializedResult(),
      checkpoint: async () => {
        checkpointed += 1;
      },
      getWorkstationAttachment: async () => attachment,
      reconcileRuntimePeerGone: async (reason: string) => {
        repairReason = reason;
        attachment.status = "error";
        attachment.status_message = "runtime peer left";
        return {
          ...noopMaterializedResult(),
          changed: true,
          runtime_state_changed: true,
        };
      },
    } as never);

    const response = await room.fetch(
      new Request("https://room.internal/internal/n/demo/runtime-state-repair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expected_runtime_session_id: "expired-job",
          reason: "expired pending attach job",
        }),
      }),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      changed: true,
      forced: false,
      checkpoint_persisted: true,
      runtime_peer_count: 0,
    });
    assert.equal(repairReason, "expired pending attach job");
    assert.equal(checkpointed, 1);
    assert.equal(attachment.status, "error");
    assert.equal(attachment.runtime_session_id, "expired-job");
  });

  it("refuses manual runtime-state repair while a runtime_peer is connected", async () => {
    const state = hibernatedState([]);
    const room = new NotebookRoom(state.state, {} as Env);
    const harness = roomHarness(room);
    let reconcileCalls = 0;
    harness.materializers.set("demo", {
      receiveFrame: async () => noopMaterializedResult(),
      checkpoint: async () => undefined,
      reconcileRuntimePeerGone: async () => {
        reconcileCalls += 1;
        return noopMaterializedResult();
      },
    } as never);
    harness.peers.set("rt", peerWithScope("rt", "runtime_peer"));

    const response = await room.fetch(
      new Request("https://room.internal/internal/n/demo/runtime-state-repair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }),
    );

    assert.equal(response.status, 409);
    assert.equal(reconcileCalls, 0);
    assert.deepEqual(await response.json(), {
      error: "runtime peer is connected; reconnecting compute should reconcile live state",
      runtime_peer_count: 1,
    });
  });

  it("force-repairs by disconnecting runtime peers before reconciliation", async () => {
    const state = hibernatedState([]);
    const room = new NotebookRoom(state.state, {} as Env);
    const harness = roomHarness(room);
    let checkpointed = 0;
    let reconcileCalls = 0;
    harness.materializers.set("demo", {
      receiveFrame: async () => noopMaterializedResult(),
      checkpoint: async () => {
        checkpointed += 1;
      },
      removePeer: async () => undefined,
      reconcileRuntimePeerGone: async () => {
        reconcileCalls += 1;
        return {
          ...noopMaterializedResult(),
          changed: true,
          runtime_state_changed: true,
        };
      },
    } as never);
    const runtimeSocket = new FakeSocket();
    const runtimePeer = {
      ...peerWithScope("rt", "runtime_peer"),
      socket: runtimeSocket.asCloudflareWebSocket(),
    };
    harness.peers.set(runtimePeer.id, runtimePeer);

    const response = await room.fetch(
      new Request("https://room.internal/internal/n/demo/runtime-state-repair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force: true }),
      }),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      changed: true,
      forced: true,
      checkpoint_persisted: true,
      runtime_peer_count: 0,
    });
    assert.equal(reconcileCalls, 1);
    assert.equal(checkpointed, 1);
    assert.equal(runtimeSocket.closed, true);
    assert.equal(runtimeSocket.closeCode, 1008);
    assert.equal(runtimeSocket.closeReason, "runtime state repair");
  });
});

describe("NotebookRoom room summary", () => {
  function summaryPeer(
    id: string,
    user: string,
    scope: "viewer" | "editor" | "owner" | "runtime_peer",
    options: { operator?: string; displayName?: string } = {},
  ): PeerForTest {
    const operator = options.operator ?? `browser:${id}`;
    const identity = authenticateDevRequest(
      new Request(
        `https://cloud.test/n/demo/sync?user=${user}&operator=${operator}&scope=${scope}`,
      ),
    );
    return {
      id,
      socket: new FakeSocket().asCloudflareWebSocket(),
      identity: {
        ...identity,
        metadata: {
          ...identity.metadata,
          ...(options.displayName ? { displayName: options.displayName } : {}),
        },
      },
      connectedAt: "2026-06-05T00:00:00.000Z",
    };
  }

  it("writes deduped human occupants and ignores runtime peers", async () => {
    const state = alarmCapableState();
    const bucket = new FakeRoomSummaryBucket();
    const room = new NotebookRoom(state.state, roomEnvWithSnapshots(bucket));
    const harness = roomHarness(room);

    const beforeAlice = harness.roomSummaryOccupantKeys();
    harness.peers.set(
      "alice-a",
      summaryPeer("alice-a", "alice", "owner", {
        displayName: "Alice Demo",
        operator: "browser:a",
      }),
    );
    harness.publishRoomSummaryIfHumanOccupantsChanged("demo", beforeAlice, "peer_joined");
    await state.drain();

    assert.deepEqual(bucket.summary("demo").occupants, [
      {
        participant_key: "user:dev:alice",
        actor_label: "user:dev:alice/browser:a",
        display_name: "Alice Demo",
        connection_scope: "owner",
      },
    ]);
    assert.equal(await state.getAlarm(), state.now + 60_000);
    const putsAfterAlice = bucket.puts.length;

    const beforeDuplicate = harness.roomSummaryOccupantKeys();
    harness.peers.set(
      "alice-b",
      summaryPeer("alice-b", "alice", "editor", { operator: "browser:b" }),
    );
    harness.publishRoomSummaryIfHumanOccupantsChanged("demo", beforeDuplicate, "peer_joined");
    await state.drain();
    assert.equal(bucket.puts.length, putsAfterAlice, "same participant does not rewrite summary");

    const beforeRuntime = harness.roomSummaryOccupantKeys();
    harness.peers.set("runtime", summaryPeer("runtime", "alice", "runtime_peer"));
    harness.publishRoomSummaryIfHumanOccupantsChanged("demo", beforeRuntime, "peer_joined");
    await state.drain();
    assert.equal(bucket.puts.length, putsAfterAlice, "runtime peer does not rewrite summary");

    const beforeBob = harness.roomSummaryOccupantKeys();
    harness.peers.set("bob", summaryPeer("bob", "bob", "editor", { displayName: "Bob Editor" }));
    harness.publishRoomSummaryIfHumanOccupantsChanged("demo", beforeBob, "peer_joined");
    await state.drain();

    assert.deepEqual(
      bucket
        .summary("demo")
        .occupants.map((occupant) => [
          occupant.participant_key,
          occupant.display_name ?? null,
          occupant.connection_scope,
        ]),
      [
        ["user:dev:alice", "Alice Demo", "owner"],
        ["user:dev:bob", "Bob Editor", "editor"],
      ],
    );
  });

  it("republishes when a participant's strongest scope changes (viewer to editor)", async () => {
    const state = alarmCapableState();
    const bucket = new FakeRoomSummaryBucket();
    const room = new NotebookRoom(state.state, roomEnvWithSnapshots(bucket));
    const harness = roomHarness(room);

    const beforeViewer = harness.roomSummaryOccupantKeys();
    harness.peers.set(
      "vera-view",
      summaryPeer("vera-view", "vera", "viewer", { operator: "browser:a" }),
    );
    harness.publishRoomSummaryIfHumanOccupantsChanged("demo", beforeViewer, "peer_joined");
    await state.drain();
    assert.equal(bucket.summary("demo").occupants[0]?.connection_scope, "viewer");
    const putsAfterViewer = bucket.puts.length;

    // Same participant opens an editing connection: the dashboard only counts
    // editing scopes, so this transition must publish immediately.
    const beforeEditor = harness.roomSummaryOccupantKeys();
    harness.peers.set(
      "vera-edit",
      summaryPeer("vera-edit", "vera", "editor", { operator: "browser:b" }),
    );
    harness.publishRoomSummaryIfHumanOccupantsChanged("demo", beforeEditor, "peer_joined");
    await state.drain();
    assert.ok(bucket.puts.length > putsAfterViewer, "scope transition republishes");
    assert.equal(bucket.summary("demo").occupants[0]?.connection_scope, "editor");
  });

  it("writes an empty summary and disarms refresh when the occupant set empties", async () => {
    const state = alarmCapableState();
    const bucket = new FakeRoomSummaryBucket();
    const room = new NotebookRoom(state.state, roomEnvWithSnapshots(bucket));
    const harness = roomHarness(room);
    harness.materializers.set("demo", {
      receiveFrame: async () => noopMaterializedResult(),
      checkpoint: async () => undefined,
      removePeer: async () => undefined,
    } as never);

    const firstAlice = summaryPeer("alice-a", "alice", "owner");
    const secondAlice = summaryPeer("alice-b", "alice", "owner", { operator: "browser:b" });
    harness.peers.set(firstAlice.id, firstAlice);
    harness.peers.set(secondAlice.id, secondAlice);
    harness.publishRoomSummary("demo", "peer_joined");
    await state.drain();
    const putsAfterInitial = bucket.puts.length;

    harness.removePeer("demo", firstAlice);
    await state.drain();
    assert.equal(bucket.puts.length, putsAfterInitial, "remaining tab keeps occupant set stable");

    harness.removePeer("demo", secondAlice);
    await state.drain();
    assert.deepEqual(bucket.summary("demo").occupants, []);
    assert.equal(await state.getAlarm(), null);
  });

  it("publishes and re-arms the summary on refresh alarms", async () => {
    const state = alarmCapableState();
    const bucket = new FakeRoomSummaryBucket();
    const room = new NotebookRoom(state.state, roomEnvWithSnapshots(bucket));
    const harness = roomHarness(room);
    harness.peers.set("alice", summaryPeer("alice", "alice", "owner"));
    harness.publishRoomSummary("demo", "peer_joined");
    await state.drain();
    const putsAfterInitial = bucket.puts.length;

    await state.state.storage.put("room_summary_refresh", "demo");
    await state.state.storage.put("room_summary_refresh_alarm_at", 0);
    await (room as unknown as { alarm(): Promise<void> }).alarm();
    await state.drain();

    assert.equal(bucket.puts.length, putsAfterInitial + 1);
    assert.notEqual(await state.getAlarm(), null);
  });

  it("restores hibernated human peers into the room summary and refresh alarm", async () => {
    const socket = new FakeSocket();
    const identity = authenticateDevRequest(
      new Request("https://cloud.test/n/demo/sync?user=carol&operator=browser:c&scope=editor"),
    );
    socket.serializeAttachment({
      notebookId: "demo",
      peerId: "carol",
      identity: {
        ...identity,
        metadata: {
          ...identity.metadata,
          displayName: "Carol Editor",
        },
      },
      connectedAt: "2026-06-05T00:00:00.000Z",
      workstation: null,
    });
    const state = alarmCapableState([socket.asCloudflareWebSocket()]);
    const bucket = new FakeRoomSummaryBucket();

    new NotebookRoom(state.state, roomEnvWithSnapshots(bucket));
    await state.drain();

    assert.deepEqual(bucket.summary("demo").occupants, [
      {
        participant_key: "user:dev:carol",
        actor_label: "user:dev:carol/browser:c",
        display_name: "Carol Editor",
        connection_scope: "editor",
      },
    ]);
    assert.equal(await state.getAlarm(), state.now + 60_000);
  });
});

type PeerForTest = {
  id: string;
  socket: CloudflareWebSocket;
  identity: ReturnType<typeof authenticateDevRequest>;
  connectedAt: string;
  consecutiveRejectedFrames?: number;
  workstation?: {
    workstationId?: string;
    displayName?: string;
    defaultEnvironmentLabel?: string;
    environmentPolicy?: string;
    runtimeSessionId?: string;
    workingDirectory?: string;
  } | null;
};

interface RoomHarness {
  peers: Map<string, PeerForTest>;
  materializers: Map<
    string,
    {
      syncPeer?(): Promise<RoomHostFrameResult>;
      receiveFrame(): Promise<RoomHostFrameResult>;
      checkpoint(): Promise<void>;
      getRuntimeExecutionActivity?(): Promise<{ executing: boolean; queueDepth: number }>;
      getRuntimeQueueDepth?(): Promise<number>;
      getWorkstationAttachment?(): Promise<unknown>;
      removePeer?(peerId: string): Promise<void>;
      reconcileRuntimeIdleTimeout?(reason: string, updatedAt: string): Promise<RoomHostFrameResult>;
      reconcileRuntimePeerGone?(reason: string): Promise<RoomHostFrameResult>;
      setWorkstationAttachment?(attachment: unknown): Promise<RoomHostFrameResult>;
    }
  >;
  refreshRuntimeIdleWatch?(notebookId: string): void;
  refreshRuntimePeerWatch?(notebookId: string): void;
  roomSummaryOccupantKeys(): Set<string>;
  publishRoomSummaryIfHumanOccupantsChanged(
    notebookId: string,
    previousOccupantKeys: ReadonlySet<string>,
    reason: "peer_joined" | "peer_left",
  ): void;
  publishRoomSummary(
    notebookId: string,
    reason: "peer_joined" | "peer_left" | "hibernation_restore" | "refresh_alarm",
  ): void;
  runtimePeerAuthorityError?(
    notebookId: string,
    workstation: PeerForTest["workstation"],
  ): Promise<string | null>;
  removeDuplicateRuntimePeers?(notebookId: string, incomingPeer: PeerForTest): void;
  publishRuntimePeerAttachment(notebookId: string, peer: PeerForTest): Promise<void>;
  syncPeerFromRoomHost(notebookId: string, peer: PeerForTest): Promise<void>;
  handleMessage(
    notebookId: string,
    peer: PeerForTest,
    message: string | ArrayBuffer | ArrayBufferView,
  ): Promise<void>;
  removePeer(notebookId: string, peer: PeerForTest): void;
  peerForSocket(socket: CloudflareWebSocket): PeerForTest | undefined;
  roomPeerRoster(): Array<{
    peer_id: string;
    actor_label: string;
    connection_scope: string;
    participant_key: string;
    display_name?: string;
  }>;
  broadcastFrame(notebookId: string, frame: Uint8Array, excludePeerId?: string): void;
  hasRuntimePeer(): boolean;
  prunePendingRuntimePeerResponses(nowMs?: number): void;
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

function roomEnvWithComputeIndex(
  computeIndex: DurableObjectNamespace,
  db: D1Database = new NotebookOwnerD1(),
): Env {
  return {
    DB: db,
    NOTEBOOK_ROOMS: {
      idFromName: (name: string) => ({ toString: () => name }),
      get: () => ({
        fetch: async () => new Response("not implemented", { status: 501 }),
      }),
    },
    OWNER_COMPUTE_INDEX: computeIndex,
  } as Env;
}

function roomEnvWithSnapshots(bucket: FakeRoomSummaryBucket): Env {
  return {
    NOTEBOOK_ROOMS: {
      idFromName: (name: string) => ({ toString: () => name }),
      get: () => ({
        fetch: async () => new Response("not implemented", { status: 501 }),
      }),
    },
    NOTEBOOK_SNAPSHOTS: bucket,
  };
}

class FakeRoomSummaryBucket {
  readonly objects = new Map<string, string>();
  readonly puts: Array<{ key: string; value: string }> = [];

  summary(notebookId: string): NotebookRoomSummary {
    const value = this.objects.get(roomSummaryKey(notebookId));
    assert.ok(value, `expected room summary for ${notebookId}`);
    return JSON.parse(value) as NotebookRoomSummary;
  }

  async get(): Promise<null> {
    return null;
  }

  async head(): Promise<null> {
    return null;
  }

  async put(key: string, value: string): Promise<never> {
    this.objects.set(key, value);
    this.puts.push({ key, value });
    return { key } as never;
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

interface FakeOwnerComputeIndexRequest {
  body: {
    summary?: {
      queue_depth?: number;
      runtime_peer_count?: number;
      status?: string;
      workstation_id?: string;
    };
  };
  objectName: string;
  url: string;
}

class FakeOwnerComputeIndexNamespace implements DurableObjectNamespace {
  readonly requests: FakeOwnerComputeIndexRequest[] = [];

  idFromName(name: string): { toString(): string } {
    return { toString: () => name };
  }

  get(id: { toString(): string }) {
    const requests = this.requests;
    const objectName = id.toString();
    return {
      fetch: async (request: Request) => {
        const body = (await request
          .json()
          .catch(() => ({}))) as FakeOwnerComputeIndexRequest["body"];
        requests.push({ body, objectName, url: request.url });
        return Response.json({ ok: true });
      },
    };
  }
}

class BlockingOwnerComputeIndexNamespace extends FakeOwnerComputeIndexNamespace {
  private resolveFirstStarted: () => void = () => undefined;
  private resolveReleaseFirst: () => void = () => undefined;
  readonly firstStarted = new Promise<void>((resolve) => {
    this.resolveFirstStarted = resolve;
  });
  private readonly firstRelease = new Promise<void>((resolve) => {
    this.resolveReleaseFirst = resolve;
  });

  releaseFirst(): void {
    this.resolveReleaseFirst();
  }

  get(id: { toString(): string }) {
    const requests = this.requests;
    const objectName = id.toString();
    return {
      fetch: async (request: Request) => {
        const body = (await request
          .json()
          .catch(() => ({}))) as FakeOwnerComputeIndexRequest["body"];
        requests.push({ body, objectName, url: request.url });
        if (requests.length === 1) {
          this.resolveFirstStarted();
          await this.firstRelease;
        }
        return Response.json({ ok: true });
      },
    };
  }
}

class FailingFirstOwnerComputeIndexNamespace extends FakeOwnerComputeIndexNamespace {
  get(id: { toString(): string }) {
    const requests = this.requests;
    const objectName = id.toString();
    return {
      fetch: async (request: Request) => {
        const body = (await request
          .json()
          .catch(() => ({}))) as FakeOwnerComputeIndexRequest["body"];
        requests.push({ body, objectName, url: request.url });
        if (requests.length === 1) {
          return new Response("owner compute index unavailable", { status: 503 });
        }
        return Response.json({ ok: true });
      },
    };
  }
}

class FailingNumberedOwnerComputeIndexNamespace extends FakeOwnerComputeIndexNamespace {
  constructor(private readonly failOnRequestNumber: number) {
    super();
  }

  get(id: { toString(): string }) {
    const requests = this.requests;
    const objectName = id.toString();
    return {
      fetch: async (request: Request) => {
        const body = (await request
          .json()
          .catch(() => ({}))) as FakeOwnerComputeIndexRequest["body"];
        requests.push({ body, objectName, url: request.url });
        if (requests.length === this.failOnRequestNumber) {
          return new Response("owner compute index unavailable", { status: 503 });
        }
        return Response.json({ ok: true });
      },
    };
  }
}

class NotebookOwnerD1 implements D1Database {
  prepare(query: string): D1PreparedStatement {
    return new NotebookOwnerD1Statement(query);
  }

  async exec(): Promise<D1Result> {
    return d1OkResult();
  }

  async batch<T = unknown>(): Promise<D1Result<T>[]> {
    return [];
  }
}

class CountingNotebookOwnerD1 extends NotebookOwnerD1 {
  notebookLookupCount = 0;

  override prepare(query: string): D1PreparedStatement {
    if (query.includes("FROM notebooks") && query.includes("WHERE id = ?")) {
      this.notebookLookupCount += 1;
    }
    return super.prepare(query);
  }
}

class ResumeNotebookD1 implements D1Database {
  readonly attachJobs: Array<{
    id: string;
    notebook_id: string;
    owner_principal: string;
    workstation_id: string;
    status: string;
    trigger: string;
    requested_by_actor_label: string;
    requested_at: string;
    updated_at: string;
    accepted_at: string | null;
    finished_at: string | null;
    error_message: string | null;
  }> = [];

  prepare(query: string): D1PreparedStatement {
    return new ResumeNotebookD1Statement(this, query);
  }

  async exec(): Promise<D1Result> {
    return d1OkResult();
  }

  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    const results: D1Result<T>[] = [];
    for (const statement of statements) {
      results.push(await statement.run<T>());
    }
    return results;
  }
}

class ResumeNotebookD1Statement implements D1PreparedStatement {
  private values: unknown[] = [];

  constructor(
    private readonly db: ResumeNotebookD1,
    private readonly query: string,
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    this.values = values;
    return this;
  }

  async first<T = unknown>(): Promise<T | null> {
    if (this.query.includes("FROM notebooks") && this.query.includes("WHERE id = ?")) {
      const notebookId = String(this.values[0] ?? "demo");
      return {
        id: notebookId,
        owner_principal: "user:dev:alice",
        title: "Demo",
        created_at: "2026-06-23T00:00:00.000Z",
        updated_at: "2026-06-23T00:00:00.000Z",
        latest_revision_id: null,
      } as T;
    }
    if (this.query.includes("FROM workstations") && this.query.includes("workstation_id = ?")) {
      return {
        owner_principal: "user:dev:alice",
        workstation_id: "ws-lab2",
        display_name: "Lab2",
        provider: "runtime_peer",
        provider_label: null,
        status: "online",
        status_message: null,
        default_environment_label: "Current Python",
        environment_policy: "current_python",
        working_directory: "/srv/project",
        cpu_count: null,
        memory_bytes: null,
        environments_json: null,
        created_at: "2026-06-23T00:00:00.000Z",
        updated_at: "2026-06-23T00:00:00.000Z",
        last_seen_at: new Date().toISOString(),
      } as T;
    }
    if (this.query.includes("FROM workstation_attach_jobs") && this.query.includes("LIMIT 1")) {
      return null;
    }
    if (
      this.query.includes("FROM workstation_attach_jobs") &&
      this.query.includes("WHERE id = ?")
    ) {
      const [jobId] = this.values;
      return (this.db.attachJobs.find((job) => job.id === jobId) ?? null) as T | null;
    }
    return null;
  }

  async run<T = unknown>(): Promise<D1Result<T>> {
    if (this.query.includes("INSERT INTO workstation_attach_jobs")) {
      const [
        id,
        notebookId,
        ownerPrincipal,
        workstationId,
        trigger,
        requestedByActorLabel,
        requestedAt,
        updatedAt,
      ] = this.values.map((value) => String(value));
      this.db.attachJobs.push({
        id,
        notebook_id: notebookId,
        owner_principal: ownerPrincipal,
        workstation_id: workstationId,
        status: "pending",
        trigger,
        requested_by_actor_label: requestedByActorLabel,
        requested_at: requestedAt,
        updated_at: updatedAt,
        accepted_at: null,
        finished_at: null,
        error_message: null,
      });
    }
    return d1OkResult<T>();
  }

  async all<T = unknown>(): Promise<D1Result<T>> {
    return d1OkResult<T>([]);
  }
}

class NotebookOwnerD1Statement implements D1PreparedStatement {
  private values: unknown[] = [];

  constructor(private readonly query: string) {}

  bind(...values: unknown[]): D1PreparedStatement {
    this.values = values;
    return this;
  }

  async first<T = unknown>(): Promise<T | null> {
    if (this.query.includes("FROM notebooks") && this.query.includes("WHERE id = ?")) {
      const notebookId = String(this.values[0] ?? "demo");
      return {
        id: notebookId,
        owner_principal: "user:dev:alice",
        title: "Demo",
        created_at: "2026-06-23T00:00:00.000Z",
        updated_at: "2026-06-23T00:00:00.000Z",
        latest_revision_id: null,
      } as T;
    }
    return null;
  }

  async run<T = unknown>(): Promise<D1Result<T>> {
    return d1OkResult<T>();
  }

  async all<T = unknown>(): Promise<D1Result<T>> {
    return d1OkResult<T>([]);
  }
}

function d1OkResult<T = unknown>(results: T[] = []): D1Result<T> {
  return { results, success: true, meta: {} };
}

function initialHostedCellIdForTest(notebookId: string): string {
  return `cell-room-${stableRoomKeyForTest(notebookId)}`;
}

function stableRoomKeyForTest(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

function hibernatedState(sockets: CloudflareWebSocket[]): {
  state: DurableObjectState;
  drain(): Promise<void>;
} {
  const values = new Map<string, unknown>();
  const pending: Promise<unknown>[] = [];
  return {
    state: {
      id: { toString: () => "room-id" },
      storage: {
        get: async <T>(key: string) => values.get(key) as T | undefined,
        put: async <T>(key: string, value: T) => {
          values.set(key, value);
        },
        delete: async (key: string) => values.delete(key),
        list: async <T>() => new Map(values as Map<string, T>),
        deleteAlarm: async () => undefined,
        setAlarm: async () => undefined,
      },
      getWebSockets: () => sockets,
      waitUntil: (promise: Promise<unknown>) => {
        pending.push(promise.catch(() => undefined));
      },
    },
    drain: async () => {
      while (pending.length > 0) {
        const batch = pending.splice(0, pending.length);
        await Promise.all(batch);
      }
    },
  };
}

/// A fake DurableObjectState with the alarm API and a deterministic clock, plus
/// a `drain()` that awaits everything passed to `waitUntil` (so the watchdog's
/// fire-and-forget arm/disarm work completes before assertions). `now` is fixed
/// so the armed alarm time is predictable in tests.
function alarmCapableState(sockets: CloudflareWebSocket[] = []): {
  state: DurableObjectState;
  now: number;
  getAlarm(): Promise<number | null>;
  drain(): Promise<void>;
} {
  const values = new Map<string, unknown>();
  const pending: Promise<unknown>[] = [];
  let alarmAt: number | null = null;
  const now = 1_000_000;
  const state: DurableObjectState = {
    id: { toString: () => "room-id" },
    storage: {
      get: async <T>(key: string) => values.get(key) as T | undefined,
      put: async <T>(key: string, value: T) => {
        values.set(key, value);
      },
      delete: async (key: string) => values.delete(key),
      list: async <T>() => new Map(values as Map<string, T>),
      setAlarm: async (scheduledTime: number | Date) => {
        alarmAt = typeof scheduledTime === "number" ? scheduledTime : scheduledTime.getTime();
      },
      getAlarm: async () => alarmAt,
      deleteAlarm: async () => {
        alarmAt = null;
      },
    },
    getWebSockets: () => sockets,
    waitUntil: (promise: Promise<unknown>) => {
      pending.push(promise.catch(() => undefined));
    },
  };
  // The room reads Date.now() to compute the alarm time; pin it for the test.
  const realNow = Date.now;
  Date.now = () => now;
  return {
    state,
    now,
    getAlarm: async () => alarmAt,
    drain: async () => {
      while (pending.length > 0) {
        const batch = pending.splice(0, pending.length);
        await Promise.all(batch);
      }
      Date.now = realNow;
    },
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
  removePeer(): Promise<void>;
} {
  return {
    receiveFrame: async () => result,
    checkpoint: async () => undefined,
    removePeer: async () => undefined,
  };
}

class FakeSocket {
  readonly sent: Uint8Array[] = [];
  closed = false;
  closeCode: number | undefined;
  closeReason: string | undefined;
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

  close(code?: number, reason?: string): void {
    this.closed = true;
    this.closeCode = code;
    this.closeReason = reason;
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
