import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  cloudFriendlyPeerLabel,
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
      },
      {
        connection: "connected",
        ownPeerId: "peer-a",
        actorLabel: "anonymous:viewer:session-a/desktop:browser",
        ownPeerLabel: "Anonymous",
        roomPeerCount: 1,
      },
    );
    assert.equal(cloudViewerPresenceDisplay(state).label, "1 here now");

    state = reduceCloudViewerPresenceMessage(state, {
      type: "cloud_peer_joined",
      notebook_id: "demo",
      peer_id: "peer-b",
      actor_label: "anonymous:viewer:session-b/desktop:browser",
      room_peer_count: 2,
      timestamp: "2026-05-23T00:00:01.000Z",
    });
    assert.equal(state.roomPeerCount, 2);
    assert.equal(cloudViewerPresenceDisplay(state).label, "2 here now");

    state = reduceCloudViewerPresenceMessage(state, {
      type: "cloud_peer_left",
      notebook_id: "demo",
      peer_id: "peer-b",
      actor_label: "anonymous:viewer:session-b/desktop:browser",
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
    assert.deepEqual(cloudViewerPresenceDisplay(disconnected), {
      label: "Offline",
      title: "Disconnected from the notebook room",
      connected: false,
    });
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
    assert.deepEqual(cloudViewerPresenceDisplay(state), {
      label: "2 here now",
      title: "2 participants are in this notebook; You are Alice Demo",
      connected: true,
    });
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
  });
});
