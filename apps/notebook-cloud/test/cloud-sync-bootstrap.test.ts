import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { connectCloudSyncRuntime, type CloudSyncRuntime } from "../viewer/live-sync.ts";
import {
  FrameType,
  encodeTypedFrame,
  LIVENESS_PING,
  LIVENESS_PONG,
  type FrameTypeValue,
} from "../src/protocol.ts";
import {
  _resetRuntimedWasmClientForTests,
  _setRuntimedWasmFetchForTests,
  _setRuntimedWasmModuleImporterForTests,
} from "../viewer/runtimed-wasm-client.ts";
import { NOTEBOOK_DOC_HEAL_KEY, SyncHealScheduler } from "../viewer/sync-heal.ts";
import { observeCloudNotebookCatchUp } from "../viewer/instant-paint.ts";
import * as wasm from "../../notebook/src/wasm/runtimed-wasm/runtimed_wasm.js";

const PRINCIPAL = "user:dev:alice";
const PEER = "peer-bootstrap";
const ACTOR = `${PRINCIPAL}/browser:bootstrap`;
type HostResult = {
  changed: boolean;
  outbound: Array<{ peer_id: string; frame_type: FrameTypeValue; payload: number[] }>;
};

for (const deliverInitialFrames of [true, false]) {
  test(
    deliverInitialFrames
      ? "a seeded runtime observes room frames queued while persistence loads"
      : "transport acceptance without peer heads still stalls, then real sync clears it",
    async (t) => {
      const bytes = await readFile(
        new URL("../../notebook/src/wasm/runtimed-wasm/runtimed_wasm_bg.wasm", import.meta.url),
      );
      await wasm.default({ module_or_path: bytes });
      const host = wasm.RoomHostHandle.create_empty(
        "bootstrap-test",
        "system/schema:bootstrap-test",
      );
      host.seed_initial_code_cell_if_empty("server-cell");
      const originalWebSocket = globalThis.WebSocket;
      const originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
      const results: Array<{ type: number; changed: boolean; replies: number }> = [];
      const replayedFrameTypes: number[] = [];
      let runtime: CloudSyncRuntime | undefined;
      let releasePersistence!: () => void;
      const persistenceGate = new Promise<void>((resolve) => {
        releasePersistence = resolve;
      });
      class FixtureSocket extends EventTarget {
        static CONNECTING = 0;
        static OPEN = 1;
        static CLOSED = 3;
        static instances: FixtureSocket[] = [];
        readyState = FixtureSocket.CONNECTING;
        binaryType = "arraybuffer";
        constructor(_url: string, _protocols: string[]) {
          super();
          FixtureSocket.instances.push(this);
        }
        close() {
          this.readyState = FixtureSocket.CLOSED;
        }
        message(data: unknown) {
          this.dispatchEvent(Object.assign(new Event("message"), { data }));
        }
        control(value: unknown) {
          this.message(
            encodeTypedFrame(
              FrameType.SESSION_CONTROL,
              new TextEncoder().encode(JSON.stringify(value)),
            ).buffer,
          );
        }
        deliver(result: HostResult) {
          for (const frame of result.outbound) {
            if (frame.peer_id === PEER)
              this.message(
                encodeTypedFrame(frame.frame_type, new Uint8Array(frame.payload)).buffer,
              );
          }
        }
        send(data: string | Uint8Array) {
          if (data === LIVENESS_PING) {
            queueMicrotask(() => this.message(LIVENESS_PONG));
            return;
          }
          if (typeof data === "string") return;
          const type = data[0];
          if (type === FrameType.PRESENCE) return;
          const result = host.receive_peer_frame(
            PEER,
            PRINCIPAL,
            ACTOR,
            "owner",
            true,
            data,
          ) as HostResult;
          results.push({ type, changed: result.changed, replies: result.outbound.length });
          queueMicrotask(() => {
            this.deliver(result);
            this.control({ type: "cloud_frame_accepted", frame_type: type });
          });
        }
      }
      globalThis.WebSocket = FixtureSocket as unknown as typeof WebSocket;
      Object.defineProperty(globalThis, "location", {
        configurable: true,
        value: { href: "https://notebook.example.test/n/bootstrap-test" },
      });
      _resetRuntimedWasmClientForTests();
      _setRuntimedWasmModuleImporterForTests(async () => wasm);
      _setRuntimedWasmFetchForTests(
        async () => new Response(bytes, { headers: { "Content-Type": "application/wasm" } }),
      );
      t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
      let heal: SyncHealScheduler | undefined;
      try {
        const pending = connectCloudSyncRuntime({
          connectTarget: async () => ({
            url: new URL("wss://notebook.example.test/sync"),
            protocols: [],
          }),
          runtimedWasmModulePath: "/runtime.js",
          runtimedWasmPath: "/runtime.wasm",
          onTransportCreated: (transport) => {
            const register = transport.onFrame.bind(transport);
            t.mock.method(transport, "onFrame", (listener: (frame: number[]) => void) => {
              let registering = true;
              const unsubscribe = register((frame) => {
                if (registering) replayedFrameTypes.push(frame[0]);
                listener(frame);
              });
              registering = false;
              return unsubscribe;
            });
          },
          persistence: {
            loadPersisted: async () => {
              await persistenceGate;
              return {
                bytes: host.save_notebook(),
                meta: {
                  principal: PRINCIPAL,
                  headsHex: host.get_heads_hex(),
                  savedAt: 123,
                  schemaVersion: 1,
                },
              };
            },
            clear: async () => {
              assert.fail("valid seed must not be cleared");
            },
          },
        });
        await drainMicrotasks();
        const socket = FixtureSocket.instances[0];
        assert.ok(socket);
        socket.readyState = FixtureSocket.OPEN;
        socket.dispatchEvent(new Event("open"));
        socket.control({
          type: "cloud_room_ready",
          protocol: "v4",
          notebook_id: "bootstrap-test",
          peer_id: PEER,
          actor_label: ACTOR,
          connection_scope: "owner",
          room_peer_count: 1,
          comments_doc_id: "comments:bootstrap-test",
          timestamp: "2026-09-22T00:00:00Z",
        });
        await drainMicrotasks();
        const initial = host.sync_peer(PEER, "owner") as HostResult;
        assert.ok(initial.outbound.some((frame) => frame.frame_type === FrameType.AUTOMERGE_SYNC));
        // The real browser can receive host-initiated sync while IndexedDB or
        // WASM initialization is pending. These frames enter the actual
        // transport queue before connectCloudSyncRuntime starts its engine.
        if (deliverInitialFrames) socket.deliver(initial);
        await drainMicrotasks();
        releasePersistence();
        runtime = await pending;
        assert.deepEqual(
          replayedFrameTypes,
          deliverInitialFrames
            ? initial.outbound
                .filter((frame) => frame.peer_id === PEER)
                .map((frame) => frame.frame_type)
            : [],
          "the regression must exercise synchronous replay, not later frame arrival",
        );
        const caughtUpWhenAttached = runtime.handle.notebook_doc_caught_up();
        let stalled = false;
        heal = new SyncHealScheduler({
          kick: () => runtime!.engine.resetAndResync(),
          shouldKick: () => true,
          onExhausted: () => {
            stalled = true;
          },
          onRecovered: () => {
            stalled = false;
          },
          baseDelayMs: 1,
          maxDelayMs: 4,
          maxAttempts: 2,
          jitterRatio: 0,
        });
        heal.noteResyncKicked(NOTEBOOK_DOC_HEAL_KEY);
        // Attach through the same catch-up observation seam as the session,
        // after startup has already had a chance to apply queued frames.
        const verification = observeCloudNotebookCatchUp(
          runtime.engine.notebookSyncApplied$,
          runtime.handle,
        ).subscribe((caughtUp) => {
          heal!.noteVerification(NOTEBOOK_DOC_HEAL_KEY, caughtUp);
        });
        await drainMicrotasks();
        for (const milliseconds of [1, 2, 4]) {
          t.mock.timers.tick(milliseconds);
          await drainMicrotasks();
        }
        t.diagnostic(
          JSON.stringify({
            initialFrames: initial.outbound.length,
            caughtUpWhenAttached,
            caughtUp: runtime.handle.notebook_doc_caught_up(),
            stalled,
            results,
          }),
        );
        assert.equal(
          caughtUpWhenAttached,
          deliverInitialFrames,
          "only applied room frames establish peer heads",
        );
        assert.equal(runtime.handle.notebook_doc_caught_up(), deliverInitialFrames);
        assert.equal(
          stalled,
          !deliverInitialFrames,
          "acceptance alone cannot settle the convergence watchdog",
        );
        if (!deliverInitialFrames) {
          host.remove_peer(PEER);
          socket.deliver(host.sync_peer(PEER, "owner") as HostResult);
          await drainMicrotasks();
          assert.equal(runtime.handle.notebook_doc_caught_up(), true);
          assert.equal(stalled, false, "an applied room sync clears the stalled notice");
        }
        verification.unsubscribe();
      } finally {
        heal?.dispose();
        runtime?.engine.stop();
        runtime?.transport.disconnect();
        runtime?.handle.free();
        host.free();
        globalThis.WebSocket = originalWebSocket;
        if (originalLocation) Object.defineProperty(globalThis, "location", originalLocation);
        else Reflect.deleteProperty(globalThis, "location");
        _resetRuntimedWasmClientForTests();
        _setRuntimedWasmModuleImporterForTests(null);
        _setRuntimedWasmFetchForTests(null);
      }
    },
  );
}

async function drainMicrotasks() {
  for (let i = 0; i < 80; i++) await Promise.resolve();
}
