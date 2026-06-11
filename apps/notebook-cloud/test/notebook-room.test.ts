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
  presencePeerLabel,
  rejectedFramePolicy,
  runtimePeerWorkstationMetadataFromRequest,
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

  it("does not count server-side frame persistence failures toward peer close", async () => {
    const room = new NotebookRoom(fakeState(), {} as Env);
    const identity = authenticateDevRequest(
      new Request(
        "https://cloud.test/n/demo/sync?user=runtime&operator=runtime:a&scope=runtime_peer",
      ),
    );
    const socket = new FakeSocket();
    const peer = {
      id: "runtime-peer",
      socket: socket.asCloudflareWebSocket(),
      identity,
      connectedAt: "2026-05-22T00:00:00.000Z",
      consecutiveRejectedFrames: 0,
    };
    const harness = roomHarness(room);
    harness.peers.set(peer.id, peer);
    harness.persistFrame = async () => {
      throw new Error("storage temporarily unavailable");
    };

    for (let i = 0; i < 10; i += 1) {
      await harness.handleMessage(
        "demo",
        peer,
        encodeTypedFrame(FrameType.PUT_BLOB, new Uint8Array([1])),
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
      updated_at: runtimePeer.connectedAt,
    });
    assert.equal(checkpointed, 1, "changed attachments are checkpointed");
    assert.equal(viewerSocket.sent.length, 1);
    assert.deepEqual([...viewerSocket.sent[0]], [FrameType.RUNTIME_STATE_SYNC, 1, 2, 3]);
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
    assert.deepEqual(await response.json(), { ok: true, changed: true });
    assert.deepEqual(publishedAttachment, attachment);
    assert.equal(checkpointed, 1, "changed control updates are checkpointed");
    assert.deepEqual([...viewerSocket.sent[0]], [FrameType.RUNTIME_STATE_SYNC, 4, 5, 6]);
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
      updated_at: runtimePeer.connectedAt,
    });
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
    let persisted = 0;
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
    harness.persistFrame = async () => {
      persisted += 1;
    };

    await harness.handleMessage(
      "demo",
      editorPeer,
      encodeTypedFrame(FrameType.AUTOMERGE_SYNC, new Uint8Array([1])),
    );

    assert.equal(persisted, 1);
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
    let persisted = 0;
    harness.persistFrame = async () => {
      persisted += 1;
    };

    await harness.handleMessage(
      "demo",
      peer,
      encodeTypedFrame(FrameType.PUT_BLOB, new Uint8Array([1, 2, 3])),
    );

    assert.equal(persisted, 0);
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
    let persisted = 0;
    let materialized = 0;
    harness.materializers.set("demo", {
      receiveFrame: async () => {
        materialized += 1;
        return noopMaterializedResult();
      },
      checkpoint: async () => undefined,
    });
    harness.persistFrame = async () => {
      persisted += 1;
    };

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
    assert.equal(persisted, 0);
    assert.equal(socket.sent.length, 1);
    const accepted = decodeJsonPayload<Record<string, unknown>>(socket.sent[0].slice(1));
    assert.equal(accepted.type, "cloud_frame_accepted");
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
      let persisted = 0;
      let materialized = 0;
      harness.materializers.set("demo", {
        receiveFrame: async () => {
          materialized += 1;
          return noopMaterializedResult();
        },
        checkpoint: async () => undefined,
      });
      harness.persistFrame = async () => {
        persisted += 1;
      };

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
      assert.equal(persisted, 0, `${scope} request was persisted`);
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
    let persisted = 0;
    harness.persistFrame = async () => {
      persisted += 1;
    };

    await harness.handleMessage(
      "demo",
      peer,
      encodeTypedFrame(FrameType.PUT_BLOB, new Uint8Array([1, 2, 3])),
    );

    assert.equal(persisted, 1);
    assert.equal(socket.sent.length, 1);
    assert.equal(
      decodeJsonPayload<Record<string, unknown>>(socket.sent[0].slice(1)).type,
      "cloud_frame_accepted",
    );
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
});

type PeerForTest = {
  id: string;
  socket: CloudflareWebSocket;
  identity: ReturnType<typeof authenticateDevRequest>;
  connectedAt: string;
  workstation?: {
    workstationId?: string;
    displayName?: string;
    defaultEnvironmentLabel?: string;
    environmentPolicy?: string;
    workingDirectory?: string;
  } | null;
};

interface RoomHarness {
  peers: Map<string, PeerForTest>;
  materializers: Map<
    string,
    {
      receiveFrame(): Promise<RoomHostFrameResult>;
      checkpoint(): Promise<void>;
      removePeer?(peerId: string): Promise<void>;
      reconcileRuntimePeerGone?(reason: string): Promise<RoomHostFrameResult>;
      setWorkstationAttachment?(attachment: unknown): Promise<RoomHostFrameResult>;
    }
  >;
  refreshRuntimePeerWatch?(notebookId: string): void;
  publishRuntimePeerAttachment(notebookId: string, peer: PeerForTest): Promise<void>;
  handleMessage(
    notebookId: string,
    peer: PeerForTest,
    message: string | ArrayBuffer | ArrayBufferView,
  ): Promise<void>;
  persistFrame(): Promise<void>;
  removePeer(notebookId: string, peer: PeerForTest): void;
  peerForSocket(socket: CloudflareWebSocket): PeerForTest | undefined;
  broadcastFrame(notebookId: string, frame: Uint8Array, excludePeerId?: string): void;
  hasRuntimePeer(): boolean;
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
function alarmCapableState(): {
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
