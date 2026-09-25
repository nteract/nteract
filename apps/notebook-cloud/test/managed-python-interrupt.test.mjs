import test from "node:test";
import assert from "node:assert/strict";
import { NotebookRoom } from "../src/notebook-room.ts";
import { authenticateDevRequest } from "../src/identity.ts";
import { FrameType, encodeJsonFrame } from "../src/protocol.ts";

for (const scope of ["owner", "editor", "viewer"])
  for (const cleanupFails of [false, true]) {
    test(`managed interrupt ${scope}, cleanup failure ${cleanupFails}`, async () => {
      const values = new Map();
      const room = new NotebookRoom(
        {
          id: { toString: () => "demo" },
          storage: {
            get: async (key) => values.get(key),
            put: async (key, value) => values.set(key, value),
            delete: async (key) => values.delete(key),
            list: async () => new Map(values),
          },
          waitUntil: () => {},
        },
        {},
      );
      const sent = [];
      const peer = {
        id: "owner",
        identity: authenticateDevRequest(
          new Request(
            `https://cloud.test/n/demo/sync?user=alice&operator=browser:test&scope=${scope}`,
          ),
        ),
        socket: { send: (frame) => sent.push(new Uint8Array(frame)), close: () => {} },
        connectedAt: new Date().toISOString(),
        consecutiveRejectedFrames: 0,
      };
      room.peers.set(peer.id, peer);
      let closed = 0;
      const runtime = {
        sessionId: "session",
        presence: {
          peer_id: "managed",
          actor_label: "user:dev:alice/managed",
          connection_scope: "runtime_peer",
          participant_key: "managed",
        },
        close: async () => {
          closed++;
          if (cleanupFails) throw Error("termination failed");
        },
      };
      room.managedPython.set("demo", { runtime, ready: Promise.resolve() });
      let failed = 0;
      room.materializers.set("demo", {
        transitionManagedPythonSession: async (id, status, reason) => {
          assert.equal(id, "session");
          assert.equal(status, "error");
          assert.match(reason, /interrupted/);
          failed++;
          return { changed: true, outbound: [] };
        },
        checkpoint: async () => {},
      });
      await room.handleMessage(
        "demo",
        peer,
        encodeJsonFrame(FrameType.REQUEST, { id: "interrupt", action: "interrupt_execution" }),
      );
      if (scope !== "owner") {
        assert.equal(closed, 0);
        assert.equal(failed, 0);
        assert.equal(room.managedPython.size, 1);
        assert.ok(
          sent.some(
            (frame) =>
              JSON.parse(new TextDecoder().decode(frame.slice(1))).type === "cloud_frame_rejected",
          ),
        );
      } else {
        assert.equal(
          JSON.parse(new TextDecoder().decode(sent[0].slice(1))).type,
          "cloud_frame_accepted",
        );
        assert.equal(closed, 1);
        assert.equal(failed, 1);
        assert.equal(room.managedPython.size, 0);
        const response = sent.find((frame) => frame[0] === FrameType.RESPONSE);
        assert.ok(response);
        const body = JSON.parse(new TextDecoder().decode(response.slice(1)));
        assert.equal(body.id, "interrupt");
        assert.equal(body.result, cleanupFails ? "error" : "interrupt_sent");
        if (cleanupFails) assert.match(body.error, /not confirmed/);
        const departed = sent
          .map((frame) => JSON.parse(new TextDecoder().decode(frame.slice(1))))
          .find((m) => m.type === "cloud_peer_left");
        assert.equal(departed.runtime_peer_count, 0);
      }
    });
  }

test("managed startup errors before runtime registration are surfaced", async () => {
  const room = new NotebookRoom(
    {
      id: { toString: () => "demo" },
      storage: { get: async () => undefined },
      waitUntil: () => {},
    },
    {},
  );
  let failed = false;
  room.materializers.set("demo", {
    getWorkstationAttachment: async () => ({ runtime_session_id: "session", status: "connecting" }),
    transitionManagedPythonSession: async (id, status, reason) => {
      assert.equal(id, "session");
      assert.equal(status, "error");
      assert.match(reason, /constructor failed/);
      failed = true;
      return { changed: true, outbound: [] };
    },
    checkpoint: async () => {},
  });
  room.startManagedPythonNow = async () => {
    throw Error("constructor failed");
  };
  await assert.rejects(room.startManagedPython("demo", "session"), /constructor failed/);
  assert.equal(failed, true);
});

for (const [outcome, keepsSession] of [
  ["interrupted", true],
  // Idle Interrupt still terminates: it is how an owner frees a quota slot.
  ["not_running", false],
  ["timeout", false],
  ["ended", false],
  ["busy", false],
  ["throws", false],
  ["connecting", false],
]) {
  test(`cooperative managed interrupt: ${outcome}`, async () => {
    const values = new Map();
    const room = new NotebookRoom(
      {
        id: { toString: () => "demo" },
        storage: {
          get: async (key) => values.get(key),
          put: async (key, value) => values.set(key, value),
          delete: async (key) => values.delete(key),
          list: async () => new Map(values),
        },
        waitUntil: () => {},
      },
      {},
    );
    const sent = [];
    const peer = {
      id: "owner",
      identity: authenticateDevRequest(
        new Request("https://cloud.test/n/demo/sync?user=alice&operator=browser:test&scope=owner"),
      ),
      socket: { send: (frame) => sent.push(new Uint8Array(frame)), close: () => {} },
      connectedAt: new Date().toISOString(),
      consecutiveRejectedFrames: 0,
    };
    room.peers.set(peer.id, peer);
    let closed = 0;
    let interrupts = 0;
    const runtime = {
      sessionId: "session",
      presence: {
        peer_id: "managed",
        actor_label: "user:dev:alice/managed",
        connection_scope: "runtime_peer",
        participant_key: "managed",
      },
      interrupt: async () => {
        interrupts++;
        if (outcome === "throws") throw Error("provider has no /interrupt");
        return outcome;
      },
      close: async () => {
        closed++;
      },
    };
    room.managedPython.set("demo", { runtime, ready: Promise.resolve() });
    let failed = 0;
    room.materializers.set("demo", {
      getWorkstationAttachment: async () => ({
        workstation_id: "celld-preview-python",
        runtime_session_id: "session",
        status: outcome === "connecting" ? "connecting" : "ready",
      }),
      transitionManagedPythonSession: async (id, status, reason) => {
        assert.equal(id, "session");
        assert.equal(status, "error");
        assert.match(reason, /Variables were discarded/);
        failed++;
        return { changed: true, outbound: [] };
      },
      checkpoint: async () => {},
    });
    await room.handleMessage(
      "demo",
      peer,
      encodeJsonFrame(FrameType.REQUEST, { id: "interrupt", action: "interrupt_execution" }),
    );
    assert.equal(interrupts, outcome === "connecting" ? 0 : 1);
    assert.equal(closed, keepsSession ? 0 : 1);
    assert.equal(failed, keepsSession ? 0 : 1);
    assert.equal(room.managedPython.size, keepsSession ? 1 : 0);
    const response = sent.find((frame) => frame[0] === FrameType.RESPONSE);
    const body = JSON.parse(new TextDecoder().decode(response.slice(1)));
    assert.equal(body.result, "interrupt_sent");
  });
}
