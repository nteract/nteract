import { describe, expect, it } from "vite-plus/test";
import { RemotePresenceState } from "../presence-state";

describe("RemotePresenceState", () => {
  it("reduces cursor and selection updates into per-cell remote presence", () => {
    const state = new RemotePresenceState("local-peer");

    let affected = state.handlePresence({
      type: "update",
      peer_id: "peer-1",
      peer_label: "Alice",
      actor_label: "user:dev:alice/desktop:a",
      channel: "cursor",
      data: { cell_id: "cell-1", line: 2, column: 4 },
    });
    expect([...affected]).toEqual(["cell-1"]);

    affected = state.handlePresence({
      type: "update",
      peer_id: "peer-1",
      peer_label: "Alice",
      channel: "selection",
      data: {
        cell_id: "cell-1",
        anchor_line: 2,
        anchor_col: 4,
        head_line: 2,
        head_col: 9,
      },
    });
    expect([...affected]).toEqual(["cell-1"]);

    const presence = state.presenceForCell("cell-1");
    expect(presence.cursors).toMatchObject([
      {
        peerId: "peer-1",
        peerLabel: "Alice",
        line: 2,
        column: 4,
      },
    ]);
    expect(presence.selections).toMatchObject([
      {
        peerId: "peer-1",
        peerLabel: "Alice",
        anchorLine: 2,
        anchorCol: 4,
        headLine: 2,
        headCol: 9,
      },
    ]);
    expect(state.findPeerColorByActorLabel("user:dev:alice/desktop:a")).toBeDefined();
  });

  it("reports both old and new cells when a peer moves", () => {
    const state = new RemotePresenceState("local-peer");
    state.handlePresence({
      type: "update",
      peer_id: "peer-1",
      channel: "cursor",
      data: { cell_id: "cell-1", line: 0, column: 0 },
    });

    const affected = state.handlePresence({
      type: "update",
      peer_id: "peer-1",
      channel: "cursor",
      data: { cell_id: "cell-2", line: 1, column: 1 },
    });

    expect([...affected].sort()).toEqual(["cell-1", "cell-2"]);
    expect(state.presenceForCell("cell-1").cursors).toEqual([]);
    expect(state.presenceForCell("cell-2").cursors).toMatchObject([
      { peerId: "peer-1", line: 1, column: 1 },
    ]);
  });

  it("ignores the local peer and clears remote state on left", () => {
    const state = new RemotePresenceState("local-peer");
    state.handlePresence({
      type: "update",
      peer_id: "local-peer",
      channel: "cursor",
      data: { cell_id: "cell-1", line: 0, column: 0 },
    });
    expect(state.presenceForCell("cell-1").cursors).toEqual([]);

    state.handlePresence({
      type: "update",
      peer_id: "peer-1",
      channel: "cursor",
      data: { cell_id: "cell-1", line: 0, column: 0 },
    });
    const affected = state.handlePresence({ type: "left", peer_id: "peer-1" });

    expect([...affected]).toEqual(["cell-1"]);
    expect(state.presenceForCell("cell-1").cursors).toEqual([]);
  });
});
