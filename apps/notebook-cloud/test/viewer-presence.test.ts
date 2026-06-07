import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  cloudFriendlyPeerLabel,
  cloudPresenceHasRuntimePeer,
  cloudPresenceRuntimePeerCount,
  cloudVisiblePeerLabel,
  cloudViewerPresenceDisplay,
  initialCloudViewerPresence,
  reduceCloudViewerConnection,
  reduceCloudViewerPresenceMessage,
} from "../viewer/presence.ts";

describe("cloud viewer presence", () => {
  it("tracks the authoritative room count from session-control messages", () => {
    let state = initialCloudViewerPresence();

    state = reduceCloudViewerPresenceMessage(state, {
      type: "cloud_room_ready",
      protocol: "v4",
      notebook_id: "demo",
      peer_id: "peer-a",
      actor_label: "anonymous:viewer:session-a/desktop:browser",
      connection_scope: "viewer",
      room_peer_count: 1,
      timestamp: "2026-05-23T00:00:00.000Z",
    });
    assert.deepEqual(
      {
        connection: state.connection,
        ownPeerId: state.ownPeerId,
        actorLabel: state.actorLabel,
        ownPeerLabel: state.ownPeerLabel,
        roomPeerCount: state.roomPeerCount,
        runtimePeerCount: state.runtimePeerCount,
      },
      {
        connection: "connected",
        ownPeerId: "peer-a",
        actorLabel: "anonymous:viewer:session-a/desktop:browser",
        ownPeerLabel: "Anonymous",
        roomPeerCount: 1,
        runtimePeerCount: 0,
      },
    );
    assert.equal(cloudViewerPresenceDisplay(state).label, "1 here now");

    state = reduceCloudViewerPresenceMessage(state, {
      type: "cloud_peer_joined",
      notebook_id: "demo",
      peer_id: "peer-b",
      actor_label: "anonymous:viewer:session-b/desktop:browser",
      connection_scope: "viewer",
      room_peer_count: 2,
      timestamp: "2026-05-23T00:00:01.000Z",
    });
    assert.equal(state.roomPeerCount, 2);
    assert.equal(cloudViewerPresenceDisplay(state).label, "2 here now");
    assert.deepEqual(
      cloudViewerPresenceDisplay(state).peers.map((peer) => ({
        kind: peer.kind,
        label: peer.label,
        count: peer.count,
      })),
      [{ kind: "anonymous", label: "2 anonymous viewers", count: 2 }],
    );

    state = reduceCloudViewerPresenceMessage(state, {
      type: "cloud_peer_left",
      notebook_id: "demo",
      peer_id: "peer-b",
      actor_label: "anonymous:viewer:session-b/desktop:browser",
      connection_scope: "viewer",
      room_peer_count: 1,
      timestamp: "2026-05-23T00:00:02.000Z",
    });
    assert.equal(state.roomPeerCount, 1);
    assert.equal(cloudViewerPresenceDisplay(state).label, "1 here now");
  });

  it("surfaces disconnected state without losing the last room count", () => {
    const connected = reduceCloudViewerPresenceMessage(initialCloudViewerPresence(), {
      type: "cloud_room_ready",
      protocol: "v4",
      notebook_id: "demo",
      peer_id: "peer-a",
      actor_label: "anonymous:viewer:session-a/desktop:browser",
      connection_scope: "viewer",
      room_peer_count: 3,
      timestamp: "2026-05-23T00:00:00.000Z",
    });

    const disconnected = reduceCloudViewerConnection(connected, "disconnected");

    assert.equal(disconnected.roomPeerCount, 3);
    const display = cloudViewerPresenceDisplay(disconnected);
    assert.equal(display.label, "Offline");
    assert.equal(display.title, "Room unavailable");
    assert.equal(display.connected, false);
    assert.equal(display.peers.length, 3);
    assert.equal(
      display.peers.every((peer) => peer.status === "offline"),
      true,
    );
  });

  it("uses friendly display metadata in the connected status title", () => {
    const state = reduceCloudViewerPresenceMessage(initialCloudViewerPresence(), {
      type: "cloud_room_ready",
      protocol: "v4",
      notebook_id: "demo",
      peer_id: "peer-a",
      actor_label: "user:anaconda:550e8400-e29b-41d4-a716-446655440000/browser:tab",
      connection_scope: "editor",
      display_name: "Alice Demo",
      email: "alice@example.com",
      room_peer_count: 2,
      timestamp: "2026-05-23T00:00:00.000Z",
    });

    assert.equal(state.ownPeerLabel, "Alice Demo");
    const display = cloudViewerPresenceDisplay(state);
    assert.equal(display.label, "2 here now");
    assert.equal(display.title, "2 participants");
    assert.equal(display.connected, true);
    assert.deepEqual(
      display.peers.map((peer) => ({
        kind: peer.kind,
        label: peer.label,
        count: peer.count,
      })),
      [
        { kind: "self", label: "Alice Demo", count: undefined },
        { kind: "anonymous", label: "Anonymous viewer", count: 1 },
      ],
    );
  });

  it("keeps named peers visible before grouping anonymous viewers", () => {
    let state = reduceCloudViewerPresenceMessage(initialCloudViewerPresence(), {
      type: "cloud_room_ready",
      protocol: "v4",
      notebook_id: "demo",
      peer_id: "peer-a",
      actor_label: "user:anaconda:alice/browser:tab",
      connection_scope: "editor",
      display_name: "Alice Demo",
      room_peer_count: 1,
      timestamp: "2026-05-23T00:00:00.000Z",
    });

    state = reduceCloudViewerPresenceMessage(state, {
      type: "cloud_peer_joined",
      notebook_id: "demo",
      peer_id: "peer-b",
      actor_label: "user:anaconda:bob/browser:tab",
      connection_scope: "editor",
      room_peer_count: 2,
      timestamp: "2026-05-23T00:00:01.000Z",
    });
    state = reduceCloudViewerPresenceMessage(state, {
      type: "cloud_peer_joined",
      notebook_id: "demo",
      peer_id: "peer-c",
      actor_label: "anonymous:viewer:session-c/browser",
      connection_scope: "viewer",
      room_peer_count: 3,
      timestamp: "2026-05-23T00:00:02.000Z",
    });

    const display = cloudViewerPresenceDisplay(state);

    assert.deepEqual(
      display.peers.map((peer) => ({
        kind: peer.kind,
        label: peer.label,
        count: peer.count,
      })),
      [
        { kind: "self", label: "Alice Demo", count: undefined },
        { kind: "peer", label: "Bob", count: undefined },
        { kind: "anonymous", label: "Anonymous viewer", count: 1 },
      ],
    );
    assert.equal(display.hiddenCount, 0);
  });

  it("detects attached runtime peers from session-control scope", () => {
    let state = reduceCloudViewerPresenceMessage(initialCloudViewerPresence(), {
      type: "cloud_room_ready",
      protocol: "v4",
      notebook_id: "demo",
      peer_id: "peer-owner",
      actor_label: "user:anaconda:alice/browser:tab",
      connection_scope: "owner",
      room_peer_count: 1,
      runtime_peer_count: 0,
      timestamp: "2026-05-23T00:00:00.000Z",
    });
    assert.equal(cloudPresenceHasRuntimePeer(state), false);
    assert.equal(cloudPresenceRuntimePeerCount(state), 0);

    state = reduceCloudViewerPresenceMessage(state, {
      type: "cloud_peer_joined",
      notebook_id: "demo",
      peer_id: "peer-runtime",
      actor_label: "user:anaconda:alice/agent:runt-cloud-peer",
      connection_scope: "runtime_peer",
      room_peer_count: 2,
      runtime_peer_count: 1,
      timestamp: "2026-05-23T00:00:01.000Z",
    });
    assert.equal(cloudPresenceHasRuntimePeer(state), true);
    assert.equal(cloudPresenceRuntimePeerCount(state), 1);

    state = reduceCloudViewerPresenceMessage(state, {
      type: "cloud_peer_left",
      notebook_id: "demo",
      peer_id: "peer-runtime",
      actor_label: "user:anaconda:alice/agent:runt-cloud-peer",
      connection_scope: "runtime_peer",
      room_peer_count: 1,
      runtime_peer_count: 0,
      timestamp: "2026-05-23T00:00:02.000Z",
    });
    assert.equal(cloudPresenceHasRuntimePeer(state), false);
    assert.equal(cloudPresenceRuntimePeerCount(state), 0);
  });

  it("detects runtime peers already present when this browser joins", () => {
    const state = reduceCloudViewerPresenceMessage(initialCloudViewerPresence(), {
      type: "cloud_room_ready",
      protocol: "v4",
      notebook_id: "demo",
      peer_id: "peer-owner",
      actor_label: "user:anaconda:alice/browser:tab",
      connection_scope: "owner",
      room_peer_count: 2,
      runtime_peer_count: 1,
      timestamp: "2026-05-23T00:00:00.000Z",
    });

    assert.equal(cloudPresenceHasRuntimePeer(state), true);
    assert.equal(cloudPresenceRuntimePeerCount(state), 1);
  });

  it("counts visible runtime peers when aggregate runtime peer count is absent", () => {
    let state = reduceCloudViewerPresenceMessage(initialCloudViewerPresence(), {
      type: "cloud_room_ready",
      protocol: "v4",
      notebook_id: "demo",
      peer_id: "peer-owner",
      actor_label: "user:anaconda:alice/browser:tab",
      connection_scope: "owner",
      room_peer_count: 1,
      timestamp: "2026-05-23T00:00:00.000Z",
    });
    state = reduceCloudViewerPresenceMessage(state, {
      type: "cloud_peer_joined",
      notebook_id: "demo",
      peer_id: "peer-runtime",
      actor_label: "user:anaconda:alice/agent:runt-cloud-peer",
      connection_scope: "runtime_peer",
      room_peer_count: 2,
      timestamp: "2026-05-23T00:00:01.000Z",
    });

    assert.equal(cloudPresenceHasRuntimePeer(state), true);
    assert.equal(cloudPresenceRuntimePeerCount(state), 1);
  });

  it("falls back to readable cloud peer labels instead of raw actor labels", () => {
    assert.equal(
      cloudFriendlyPeerLabel({
        actorLabel: "user:anaconda:550e8400-e29b-41d4-a716-446655440000/browser:tab",
      }),
      "Anaconda user",
    );
    assert.equal(
      cloudVisiblePeerLabel(
        "user:anaconda:550e8400-e29b-41d4-a716-446655440000",
        "user:anaconda:550e8400-e29b-41d4-a716-446655440000/browser:tab",
      ),
      "Anaconda user",
    );
    assert.equal(
      cloudVisiblePeerLabel("Alice Demo", "user:anaconda:alice/browser:tab"),
      "Alice Demo",
    );
    assert.equal(
      cloudFriendlyPeerLabel({
        email: "alice@example.com",
        actorLabel: "user:anaconda:550e8400-e29b-41d4-a716-446655440000/browser:tab",
      }),
      "alice@example.com",
    );
    assert.equal(
      cloudFriendlyPeerLabel({
        actorLabel: "user:anaconda:kyle/agent:codex:s1",
      }),
      "Codex for Kyle",
    );
  });
});
