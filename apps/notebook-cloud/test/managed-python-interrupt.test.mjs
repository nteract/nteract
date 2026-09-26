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

for (const queued of [true, false]) {
  test(`interrupt with no runtime peer attached ${queued ? "cancels accepted work" : "is rejected when nothing is pending"}`, async () => {
    const room = new NotebookRoom(
      {
        id: { toString: () => "demo" },
        storage: { get: async () => undefined, put: async () => {}, delete: async () => {} },
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
    let cancelled = 0;
    let checkpoints = 0;
    room.materializers.set("demo", {
      // A bring-your-own workstation replacement is still connecting.
      getWorkstationAttachment: async () => ({
        workstation_id: "laptop",
        runtime_session_id: "replacement",
        status: "connecting",
      }),
      getRuntimeExecutionActivity: async () => ({ executing: false, queueDepth: queued ? 2 : 0 }),
      cancelUnstartedExecutions: async () => {
        cancelled++;
        return { changed: true, outbound: [] };
      },
      checkpoint: async () => {
        checkpoints++;
      },
    });
    await room.handleMessage(
      "demo",
      peer,
      encodeJsonFrame(FrameType.REQUEST, { id: "interrupt", action: "interrupt_execution" }),
    );
    const messages = sent.map((frame) => ({
      type: frame[0],
      body: JSON.parse(new TextDecoder().decode(frame.slice(1))),
    }));
    if (queued) {
      assert.equal(cancelled, 1);
      assert.ok(checkpoints >= 1, "the cancellation is persisted");
      const response = messages.find((m) => m.type === FrameType.RESPONSE);
      assert.equal(response.body.result, "interrupt_sent");
    } else {
      assert.equal(cancelled, 0);
      assert.ok(messages.some((m) => m.body.type === "cloud_frame_rejected"));
    }
  });
}
