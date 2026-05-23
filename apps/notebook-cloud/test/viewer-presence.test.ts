import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
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
        roomPeerCount: state.roomPeerCount,
      },
      {
        connection: "connected",
        ownPeerId: "peer-a",
        actorLabel: "anonymous:viewer:session-a/desktop:browser",
        roomPeerCount: 1,
      },
    );
    assert.equal(cloudViewerPresenceDisplay(state).label, "1 viewing");

    state = reduceCloudViewerPresenceMessage(state, {
      type: "cloud_peer_joined",
      notebook_id: "demo",
      peer_id: "peer-b",
      actor_label: "anonymous:viewer:session-b/desktop:browser",
      room_peer_count: 2,
      timestamp: "2026-05-23T00:00:01.000Z",
    });
    assert.equal(state.roomPeerCount, 2);
    assert.equal(cloudViewerPresenceDisplay(state).label, "2 viewing");

    state = reduceCloudViewerPresenceMessage(state, {
      type: "cloud_peer_left",
      notebook_id: "demo",
      peer_id: "peer-b",
      actor_label: "anonymous:viewer:session-b/desktop:browser",
      room_peer_count: 1,
      timestamp: "2026-05-23T00:00:02.000Z",
    });
    assert.equal(state.roomPeerCount, 1);
    assert.equal(cloudViewerPresenceDisplay(state).label, "1 viewing");
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
});
