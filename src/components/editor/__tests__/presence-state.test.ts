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

  it("uses interaction targets as the active peer cell", () => {
    const state = new RemotePresenceState("local-peer");

    state.handlePresence({
      type: "update",
      peer_id: "peer-1",
      peer_label: "Alice",
      channel: "cursor",
      data: { cell_id: "cell-editor", line: 2, column: 4 },
    });
    const affected = state.handlePresence({
      type: "update",
      peer_id: "peer-1",
      peer_label: "Alice",
      channel: "interaction",
      data: { kind: "output", cell_id: "cell-output" },
    });

    expect([...affected].sort()).toEqual(["cell-editor", "cell-output"]);
    expect(state.getPeersForCell("cell-editor")).toEqual([]);
    expect(state.getPeersForCell("cell-output")).toMatchObject([
      {
        peerId: "peer-1",
        interaction: { kind: "output", cell_id: "cell-output" },
      },
    ]);
  });

  it("suppresses stale editor geometry while a peer interacts with output", () => {
    const state = new RemotePresenceState("local-peer");

    state.handlePresence({
      type: "snapshot",
      peer_id: "daemon",
      peers: [
        {
          peer_id: "peer-1",
          peer_label: "Alice",
          channels: [
            {
              channel: "cursor",
              data: { cell_id: "cell-1", line: 1, column: 2 },
            },
            {
              channel: "interaction",
              data: { kind: "output", cell_id: "cell-2", output_id: "out-1" },
            },
          ],
        },
      ],
    });

    expect(state.presenceForCell("cell-1").cursors).toEqual([]);
    expect(state.getPeersForCell("cell-2")).toMatchObject([
      {
        interaction: { kind: "output", cell_id: "cell-2", output_id: "out-1" },
      },
    ]);
  });

  it("does not let same-cell legacy focus overwrite a richer interaction target", () => {
    const state = new RemotePresenceState("local-peer");

    state.handlePresence({
      type: "update",
      peer_id: "peer-1",
      channel: "interaction",
      data: { kind: "output", cell_id: "cell-1" },
    });
    state.handlePresence({
      type: "update",
      peer_id: "peer-1",
      channel: "focus",
      data: { cell_id: "cell-1" },
    });

    expect(state.getPeersForCell("cell-1")).toMatchObject([
      {
        interaction: { kind: "output", cell_id: "cell-1" },
      },
    ]);
  });

  it("uses legacy focus to move cells when interaction has not arrived yet", () => {
    const state = new RemotePresenceState("local-peer");

    state.handlePresence({
      type: "update",
      peer_id: "peer-1",
      channel: "interaction",
      data: { kind: "output", cell_id: "cell-1" },
    });
    state.handlePresence({
      type: "update",
      peer_id: "peer-1",
      channel: "focus",
      data: { cell_id: "cell-2" },
    });

    expect(state.getPeersForCell("cell-1")).toEqual([]);
    expect(state.getPeersForCell("cell-2")).toMatchObject([
      {
        interaction: { kind: "cell", cell_id: "cell-2" },
      },
    ]);
  });

  it("restores editor geometry when the interaction channel is cleared", () => {
    const state = new RemotePresenceState("local-peer");

    state.handlePresence({
      type: "update",
      peer_id: "peer-1",
      channel: "cursor",
      data: { cell_id: "cell-1", line: 1, column: 2 },
    });
    state.handlePresence({
      type: "update",
      peer_id: "peer-1",
      channel: "interaction",
      data: { kind: "output", cell_id: "cell-2" },
    });
    const affected = state.handlePresence({
      type: "clear_channel",
      peer_id: "peer-1",
      channel: "interaction",
    });

    expect([...affected]).toEqual(["cell-2"]);
    expect(state.presenceForCell("cell-1").cursors).toMatchObject([
      { peerId: "peer-1", line: 1, column: 2 },
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
