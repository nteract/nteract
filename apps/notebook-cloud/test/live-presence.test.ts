import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CloudLivePresenceStore, normalizeCloudPresencePayload } from "../viewer/live-presence.ts";

describe("cloud live presence", () => {
  it("normalizes raw actor labels before they reach shared cursor rendering", () => {
    const store = new CloudLivePresenceStore("local-peer");
    const snapshot = store.handlePresence({
      type: "update",
      peer_id: "remote-peer",
      peer_label: "user:anaconda:550e8400-e29b-41d4-a716-446655440000",
      actor_label: "user:anaconda:550e8400-e29b-41d4-a716-446655440000/browser:tab",
      channel: "cursor",
      data: { cell_id: "cell-1", line: 2, column: 4 },
    });

    assert.ok(snapshot);
    assert.equal(snapshot.cells.get("cell-1")?.cursors[0]?.peerLabel, "Anaconda user");
  });

  it("preserves friendly peer labels from presence snapshots", () => {
    const normalized = normalizeCloudPresencePayload({
      type: "snapshot",
      peer_id: "local-peer",
      peers: [
        {
          peer_id: "remote-a",
          peer_label: "Alice Demo",
          actor_label: "user:anaconda:alice/browser:tab",
          channels: [],
        },
        {
          peer_id: "remote-b",
          peer_label: "user:anaconda:550e8400-e29b-41d4-a716-446655440000",
          actor_label: "user:anaconda:550e8400-e29b-41d4-a716-446655440000/browser:tab",
          channels: [],
        },
      ],
    }) as {
      peers: Array<{ peer_label: string }>;
    };

    assert.deepEqual(
      normalized.peers.map((peer) => peer.peer_label),
      ["Alice Demo", "Anaconda user"],
    );
  });
});
