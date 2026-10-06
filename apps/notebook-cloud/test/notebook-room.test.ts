import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type {
  CloudflareWebSocket,
  D1Database,
  D1PreparedStatement,
  D1Result,
  DurableObjectNamespace,
  DurableObjectState,
  Env,
} from "../src/cloudflare-types.ts";
import {
  NOTEBOOK_CLOUD_WEBSOCKET_PROTOCOL,
  TRUSTED_WEBSOCKET_PROTOCOL_HEADER,
  authenticateAnonymousViewer,
  authenticateDevRequest,
  stampTrustedIdentity,
} from "../src/identity.ts";
import {
  NotebookRoom,
  RUNTIME_IDLE_TTL_MS,
  presencePeerLabel,
  rejectedFramePolicy,
  runtimePeerWorkstationMetadataFromRequest,
  rewritePresenceFrame,
  shouldBroadcastFrame,
  webSocketUpgradeHeaders,
} from "../src/notebook-room.ts";
import {
  FrameType,
  LIVENESS_PING,
  LIVENESS_PONG,
  decodeJsonPayload,
  encodeTypedFrame,
  splitTypedFrame,
} from "../src/protocol.ts";
import {
  decodePresenceFrame,
  encodePresenceFrame,
  NotebookHandle,
  RuntimeStatePeerHandle,
} from "../src/runtimed-wasm.ts";
import { ManagedPythonRoom } from "../src/managed-python-room.ts";
import { RoomMaterializer, type RoomHostFrameResult } from "../src/room-materializer.ts";
import {
  createWorkstationAttachJob,
  roomSummaryKey,
  type NotebookRoomSummary,
} from "../src/storage.ts";
import { initializeTestRuntimedWasm } from "./runtimed-wasm-test-loader.ts";
// @ts-expect-error The provider is plain JS; use its real pool for the cross-layer quota regression.
import { SessionPool } from "../../preview-python/src/session-pool.js";
// @ts-expect-error The private provider service does not ship TypeScript declarations.
import { createProviderService } from "../../preview-python/src/provider-service.js";

before(async () => {
  await initializeTestRuntimedWasm();
});

describe("NotebookRoom owner package operations", () => {
  it("fences execution before a managed startup entry exists", async () => {
    const state = hibernatedState([]);
    const room = new NotebookRoom(state.state, {} as Env);
    await state.drain();
    const harness = roomHarness(room);
    const materializer = new RoomMaterializer("demo", state.state, {} as Env);
    harness.materializers.set("demo", materializer as never);
    await materializer.setWorkstationAttachment({
      workstation_id: "celld-preview-python",
      display_name: "Python",
      provider: "celld-pyodide",
      default_environment_label: "Python",
      environment_policy: "curated",
      status: "connecting",
      runtime_session_id: "starting-session",
    });
    Object.assign(room, { ensureRuntimeForHostedExecution: async () => true });
    const receive = materializer.receiveFrame.bind(materializer);
    materializer.receiveFrame = async (peer, frame, expectedSession) => {
      if (frame.type === FrameType.REQUEST)
        await materializer.transitionManagedPythonSession(
          "starting-session",
          "error",
          "startup failed before entry creation",
        );
      return receive(peer, frame, expectedSession);
    };
    const socket = new FakeSocket();
    const peer = {
      id: "owner",
      socket: socket.asCloudflareWebSocket(),
      identity: authenticateDevRequest(
        new Request("https://cloud.test/n/demo/sync?user=alice&operator=browser:a&scope=owner"),
      ),
      connectedAt: new Date().toISOString(),
      workstation: null,
    };
    socket.serializeAttachment({
      notebookId: "demo",
      peerId: peer.id,
      identity: peer.identity,
      connectedAt: peer.connectedAt,
    });
    harness.peers.set(peer.id, peer);
    await room.webSocketMessage(
      peer.socket,
      encodeTypedFrame(
        FrameType.REQUEST,
        new TextEncoder().encode(
          JSON.stringify({
            id: "run",
            action: "execute_cell",
            cell_id: initialHostedCellIdForTest("demo"),
          }),
        ),
      ),
    );
    await state.drain();
    assert.equal(await materializer.getRuntimeQueueDepth(), 0);
    const rejected = decodeJsonPayload<Record<string, unknown>>(socket.sent.at(-1)!.slice(1));
    assert.equal(rejected.type, "cloud_frame_rejected");
    assert.match(String(rejected.reason), /startup failed before entry creation/);
  });

  for (const outcome of ["interrupt", "revoked"] as const)
    it(
      `admits synced execution during saved-package restore: ${outcome}`,
      { timeout: 3000 },
      async () => {
        const state = hibernatedState([]);
        const db = new NotebookOwnerD1();
        let ownerAccess = true;
        const prepare = db.prepare.bind(db);
        db.prepare = (query) => {
          const statement = prepare(query);
          if (query.includes("FROM workstation_attach_jobs"))
            statement.first = async <T>() => ({ owner_principal: "user:dev:alice" }) as T;
          if (query.includes("FROM notebook_acl"))
            statement.all = async <T>() =>
              d1OkResult<T>(
                ownerAccess
                  ? [
                      {
                        scope: "owner",
                        subject_kind: "principal",
                        subject: "user:dev:alice",
                        notebook_id: "demo",
                      } as T,
                    ]
                  : [],
              );
          return statement;
        };
        const requests: string[] = [];
        let restoring!: () => void;
        const restoreEntered = new Promise<void>((resolve) => {
          restoring = resolve;
        });
        let finishRestore!: () => void;
        const restoreReleased = new Promise<void>((resolve) => {
          finishRestore = resolve;
        });
        const env = {
          DB: db,
          NOTEBOOK_CLOUD_PYTHON_PROVIDER: "celld",
          PREVIEW_PYTHON_SESSIONS: {
            idFromName: (name: string) => name,
            get: () => ({
              fetch: async (request: Request) => {
                const path = new URL(request.url).pathname;
                requests.push(path);
                if (path === "/packages/inventory") return Response.json({ installed: [] });
                if (path === "/packages") {
                  restoring();
                  if (outcome === "revoked") {
                    await restoreReleased;
                    return Response.json({ status: "ready", installed: ["six==1.0"], manifest });
                  }
                  return Response.json({
                    status: "error",
                    code: "planner_busy",
                    error: "Another package installation is active",
                    needs_restart: false,
                  });
                }
                return Response.json({ ok: true });
              },
            }),
          },
        } as unknown as Env;
        const room = new NotebookRoom(state.state, env);
        await state.drain();
        const harness = roomHarness(room);
        const materializer = new RoomMaterializer("demo", state.state, {} as Env);
        harness.materializers.set("demo", materializer as never);
        await materializer.setWorkstationAttachment({
          workstation_id: "celld-preview-python",
          display_name: "Python",
          provider: "celld-pyodide",
          default_environment_label: "Python",
          environment_policy: "curated",
          status: "connecting",
          runtime_session_id: "restore-session",
        });
        const manifest = { version: 1, pyodide: "0.28.3", requirements: ["six"], wheels: [] };
        await materializer.compareSetCloudPackageManifest(null, manifest);
        const socket = new FakeSocket();
        const peer = {
          id: "owner",
          socket: socket.asCloudflareWebSocket(),
          identity: authenticateDevRequest(
            new Request("https://cloud.test/n/demo/sync?user=alice&operator=browser:a&scope=owner"),
          ),
          connectedAt: new Date().toISOString(),
          workstation: null,
        };
        socket.serializeAttachment({
          notebookId: "demo",
          peerId: peer.id,
          identity: peer.identity,
          connectedAt: peer.connectedAt,
        });
        harness.peers.set(peer.id, peer);
        const owner = NotebookHandle.create_bootstrap(peer.identity.actorLabel);
        let outbound = (await materializer.syncPeer(peer)).outbound;
        for (let round = 0; round < 8 && outbound.length; round++) {
          const next = [];
          for (const frame of outbound) {
            if (frame.peer_id !== peer.id || frame.frame_type !== FrameType.AUTOMERGE_SYNC)
              continue;
            for (const event of owner.receive_frame(
              encodeTypedFrame(frame.frame_type, new Uint8Array(frame.payload)),
            )) {
              if (event.reply)
                next.push(
                  ...(
                    await materializer.receiveFrame(peer, {
                      type: FrameType.AUTOMERGE_SYNC,
                      payload: new Uint8Array(event.reply),
                    })
                  ).outbound,
                );
            }
          }
          outbound = next;
        }
        const cell = JSON.parse(owner.get_cells_json())[0];
        owner.update_source(cell.id, "print('synced before execution')");
        const heads = owner.get_heads_hex();
        assert.equal(await materializer.waitForNotebookHeads(heads, 1), false);
        const managedHarness = room as unknown as {
          startManagedPython(notebookId: string, sessionId: string): Promise<void>;
          managedPython: Map<string, { runtime: ManagedPythonRoom; ready: Promise<void> }>;
        };
        const starting = managedHarness
          .startManagedPython("demo", "restore-session")
          .catch((error: unknown) => error);
        await restoreEntered;
        const entry = managedHarness.managedPython.get("demo")!;
        const runtime = entry.runtime;
        const settled = entry.ready.catch((error: unknown) => error);
        const request = (id: string, action: string, extra = {}) =>
          encodeTypedFrame(
            FrameType.REQUEST,
            new TextEncoder().encode(JSON.stringify({ id, action, ...extra })),
          );
        const interruptResponse = () =>
          socket.sent.find(
            (frame) =>
              frame[0] === FrameType.RESPONSE &&
              JSON.parse(new TextDecoder().decode(frame.slice(1))).id === "interrupt",
          );
        try {
          await restoreEntered;
          await room.webSocketMessage(
            peer.socket,
            request("run", "execute_cell", { cell_id: cell.id, required_heads: heads }),
          );
          if (outcome === "interrupt")
            await room.webSocketMessage(peer.socket, request("interrupt", "interrupt_execution"));
          for (let round = 0; round < 10; round++)
            await new Promise((resolve) => setImmediate(resolve));
          assert.equal(
            await materializer.getRuntimeQueueDepth(),
            0,
            "later requests cannot overtake unsynced execution intent",
          );
          assert.ok(!requests.includes("/close"));
          const sync = owner.flush_local_changes();
          assert.ok(sync);
          await room.webSocketMessage(
            peer.socket,
            encodeTypedFrame(FrameType.AUTOMERGE_SYNC, sync),
          );
          if (outcome === "revoked") {
            for (
              let round = 0;
              round < 50 && (await materializer.getRuntimeQueueDepth()) === 0;
              round++
            )
              await new Promise((resolve) => setImmediate(resolve));
            assert.equal(
              await materializer.getRuntimeQueueDepth(),
              1,
              "synced execution is queued while restore is pending",
            );
            assert.ok(!requests.includes("/execute"));
            ownerAccess = false;
            finishRestore();
            await state.drain();
            assert.match(String(await settled), /access was revoked/);
            assert.equal((await materializer.getWorkstationAttachment())?.status, "error");
            assert.equal(await materializer.getRuntimeQueueDepth(), 0);
            assert.ok(requests.includes("/close"));
            assert.ok(!requests.includes("/execute"), "revoked compute cannot run restored work");
            return;
          }
          for (let round = 0; round < 50 && !interruptResponse(); round++)
            await new Promise((resolve) => setImmediate(resolve));
          assert.ok(
            interruptResponse(),
            "interrupt must complete while saved-package restoration is waiting",
          );
          assert.equal(
            JSON.parse(new TextDecoder().decode(interruptResponse()!.slice(1))).result,
            "interrupt_sent",
          );
          assert.ok(requests.includes("/close"));
          assert.ok(
            !requests.includes("/execute"),
            "queued code cannot execute before restoration finishes",
          );
          assert.match(String(await settled), /expired|replaced/i);
          assert.deepEqual(await materializer.getCloudPackageManifest(), manifest);
        } finally {
          finishRestore();
          if (!requests.includes("/close")) await runtime.close();
          await settled;
          await starting;
          await state.drain();
          owner.free();
        }
      },
    );

  for (const operation of ["remove", "clear"] as const) {
    it(`waits for managed readiness before waking after ${operation}`, async () => {
      const state = hibernatedState([]);
      const db = new NotebookOwnerD1();
      const prepare = db.prepare.bind(db);
      db.prepare = (query) => {
        const statement = prepare(query);
        if (query.includes("FROM notebook_acl"))
          statement.all = async <T>() =>
            d1OkResult<T>([
              {
                scope: "owner",
                subject_kind: "principal",
                subject: "user:dev:alice",
                notebook_id: "demo",
              } as T,
            ]);
        return statement;
      };
      const env = { DB: db } as unknown as Env;
      const room = new NotebookRoom(state.state, env);
      await state.drain();
      const harness = roomHarness(room);
      const materializer = new RoomMaterializer("demo", state.state, env);
      harness.materializers.set("demo", materializer as never);
      await materializer.setWorkstationAttachment({
        workstation_id: "celld-preview-python",
        display_name: "Python",
        provider: "celld-pyodide",
        default_environment_label: "Python",
        environment_policy: "curated",
        status: "ready",
        runtime_session_id: "package-session",
      });
      await materializer.compareSetCloudPackageManifest(null, {
        version: 1,
        pyodide: "0.28.3",
        requirements: ["six"],
        wheels: [],
      });
      let finishReady!: () => void;
      const ready = new Promise<void>((resolve) => {
        finishReady = resolve;
      });
      let wakes = 0;
      const runtime = {
        ownerPrincipal: "user:dev:alice",
        sessionId: "package-session",
        presence: { peer_id: "runtime", connection_scope: "runtime_peer" },
        wake: async () => {
          wakes += 1;
        },
        close: async () => {},
        accept: () => {},
      };
      Object.assign(room, {
        managedPython: new Map([["demo", { runtime, ready }]]),
      });

      const socket = new FakeSocket();
      const peer = {
        id: "owner",
        socket: socket.asCloudflareWebSocket(),
        identity: authenticateDevRequest(
          new Request("https://cloud.test/n/demo/sync?user=alice&operator=browser:a&scope=owner"),
        ),
        connectedAt: new Date().toISOString(),
        workstation: null,
      };
      socket.serializeAttachment({
        notebookId: "demo",
        peerId: peer.id,
        identity: peer.identity,
        connectedAt: peer.connectedAt,
      });
      harness.peers.set(peer.id, peer);
      const id = `package-${operation}`;
      const requestOperation = operation;
      await room.webSocketMessage(
        peer.socket,
        encodeTypedFrame(
          FrameType.REQUEST,
          new TextEncoder().encode(
            JSON.stringify({
              id,
              action: "cloud_package_change",
              operation: requestOperation,
              requirement: operation === "remove" ? "six" : "",
            }),
          ),
        ),
      );
      for (let round = 0; round < 50; round++) {
        if (
          socket.sent.some(
            (frame) =>
              frame[0] === FrameType.RESPONSE &&
              JSON.parse(new TextDecoder().decode(frame.slice(1))).id === id,
          )
        )
          break;
        await new Promise((resolve) => setImmediate(resolve));
      }
      const response = socket.sent
        .filter((frame) => frame[0] === FrameType.RESPONSE)
        .map((frame) => JSON.parse(new TextDecoder().decode(frame.slice(1))))
        .find((frame) => frame.id === id);
      assert.ok(response, "terminal package response does not block on readiness");
      assert.equal(wakes, 0, "managed runtime is not woken before readiness");

      finishReady();
      await state.drain();
      assert.equal(wakes, 1, "selected managed runtime wakes after readiness");
    });
  }

  it("does not wake a replaced runtime after package completion waits for readiness", async () => {
    const state = hibernatedState([]);
    const db = new NotebookOwnerD1();
    const prepare = db.prepare.bind(db);
    db.prepare = (query) => {
      const statement = prepare(query);
      if (query.includes("FROM notebook_acl"))
        statement.all = async <T>() =>
          d1OkResult<T>([
            {
              scope: "owner",
              subject_kind: "principal",
              subject: "user:dev:alice",
              notebook_id: "demo",
            } as T,
          ]);
      return statement;
    };
    const env = { DB: db } as unknown as Env;
    const room = new NotebookRoom(state.state, env);
    await state.drain();
    const harness = roomHarness(room);
    const materializer = new RoomMaterializer("demo", state.state, env);
    harness.materializers.set("demo", materializer as never);
    await materializer.setWorkstationAttachment({
      workstation_id: "celld-preview-python",
      display_name: "Python",
      provider: "celld-pyodide",
      default_environment_label: "Python",
      environment_policy: "curated",
      status: "ready",
      runtime_session_id: "package-session",
    });
    let finishReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      finishReady = resolve;
    });
    let oldWakes = 0;
    let newWakes = 0;
    const runtime = {
      ownerPrincipal: "user:dev:alice",
      sessionId: "package-session",
      presence: { peer_id: "runtime", connection_scope: "runtime_peer" },
      wake: async () => {
        oldWakes++;
      },
      close: async () => {},
      accept: () => {},
    };
    harness.managedPython.set("demo", { runtime, ready } as never);
    const socket = new FakeSocket();
    const peer = {
      id: "owner",
      socket: socket.asCloudflareWebSocket(),
      identity: authenticateDevRequest(
        new Request("https://cloud.test/n/demo/sync?user=alice&operator=browser:a&scope=owner"),
      ),
      connectedAt: new Date().toISOString(),
      workstation: null,
    };
    socket.serializeAttachment({
      notebookId: "demo",
      peerId: peer.id,
      identity: peer.identity,
      connectedAt: peer.connectedAt,
    });
    harness.peers.set(peer.id, peer);
    await room.webSocketMessage(
      peer.socket,
      encodeTypedFrame(
        FrameType.REQUEST,
        new TextEncoder().encode(
          JSON.stringify({
            id: "remove-before-replacement",
            action: "cloud_package_change",
            operation: "clear",
            requirement: "",
          }),
        ),
      ),
    );
    for (let round = 0; round < 50; round++) {
      if (socket.sent.some((frame) => frame[0] === FrameType.RESPONSE)) break;
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.ok(socket.sent.some((frame) => frame[0] === FrameType.RESPONSE));
    harness.managedPython.set("demo", {
      runtime: {
        ...runtime,
        sessionId: "replacement-session",
        wake: async () => {
          newWakes++;
        },
      },
      ready: Promise.resolve(),
    } as never);
    finishReady();
    await state.drain();
    assert.equal(oldWakes, 0);
    assert.equal(newWakes, 0);
    assert.equal(harness.managedPython.get("demo")?.runtime.sessionId, "replacement-session");
  });

  it("preserves restart-required state through package checkpoint failure", async (t) => {
    const state = hibernatedState([]);
    const db = new NotebookOwnerD1();
    const prepare = db.prepare.bind(db);
    db.prepare = (query) => {
      const statement = prepare(query);
      if (query.includes("FROM notebook_acl"))
        statement.all = async <T>() =>
          d1OkResult<T>([
            {
              scope: "owner",
              subject_kind: "principal",
              subject: "user:dev:alice",
              notebook_id: "demo",
            } as T,
          ]);
      return statement;
    };
    const env = { DB: db } as unknown as Env;
    const room = new NotebookRoom(state.state, env);
    await state.drain();
    const harness = roomHarness(room);
    const materializer = new RoomMaterializer("demo", state.state, env);
    harness.materializers.set("demo", materializer as never);
    const attachment = {
      workstation_id: "celld-preview-python",
      display_name: "Python",
      provider: "celld-pyodide",
      default_environment_label: "Python",
      environment_policy: "curated",
      status: "ready",
      runtime_session_id: "package-session",
    } as const;
    await materializer.setWorkstationAttachment(attachment);
    await materializer.compareSetCloudPackageManifest(null, {
      version: 1,
      pyodide: "0.28.3",
      requirements: [],
      wheels: [],
    });
    const runtime = {
      ownerPrincipal: "user:dev:alice",
      sessionId: "package-session",
      presence: { peer_id: "runtime", connection_scope: "runtime_peer" },
      installPackages: async () => ({
        status: "error" as const,
        error: "Install left Python uncertain",
        needs_restart: true,
      }),
      wake: async () => {},
      close: async () => {},
      accept: () => {},
    };
    Object.assign(room, {
      managedPython: new Map([["demo", { runtime, ready: Promise.resolve() }]]),
    });
    const checkpoint = t.mock.method(materializer, "checkpoint", async () => {
      throw new Error("checkpoint unavailable");
    });
    const socket = new FakeSocket();
    const peer = {
      id: "owner",
      socket: socket.asCloudflareWebSocket(),
      identity: authenticateDevRequest(
        new Request("https://cloud.test/n/demo/sync?user=alice&operator=browser:a&scope=owner"),
      ),
      connectedAt: new Date().toISOString(),
      workstation: null,
    };
    socket.serializeAttachment({
      notebookId: "demo",
      peerId: peer.id,
      identity: peer.identity,
      connectedAt: peer.connectedAt,
    });
    harness.peers.set(peer.id, peer);
    await room.webSocketMessage(
      peer.socket,
      encodeTypedFrame(
        FrameType.REQUEST,
        new TextEncoder().encode(
          JSON.stringify({
            id: "restart-checkpoint",
            action: "cloud_package_change",
            operation: "add",
            requirement: "six",
          }),
        ),
      ),
    );
    for (let round = 0; round < 50; round++) {
      if (socket.sent.some((frame) => frame[0] === FrameType.RESPONSE)) break;
      await new Promise((resolve) => setImmediate(resolve));
    }
    const response = socket.sent
      .filter((frame) => frame[0] === FrameType.RESPONSE)
      .map((frame) => JSON.parse(new TextDecoder().decode(frame.slice(1))))
      .find((frame) => frame.id === "restart-checkpoint");
    assert.equal(response?.needs_restart, true);
    assert.equal(checkpoint.mock.callCount(), 1, "failure occurs during managed cleanup");
    assert.equal(harness.managedPython.has("demo"), false, "uncertain Python is retired");
  });

  for (const outcome of [
    "success",
    "failure",
    "restart_checkpoint_failure",
    "concurrent_edit",
    "interrupt",
  ] as const) {
    it(
      `owns package completion after transport admission: ${outcome}`,
      { timeout: 3000 },
      async () => {
        const state = hibernatedState([]);
        const db = new NotebookOwnerD1();
        const prepare = db.prepare.bind(db);
        db.prepare = (query) => {
          const statement = prepare(query);
          if (query.includes("FROM notebook_acl"))
            statement.all = async <T>() =>
              d1OkResult<T>([
                {
                  scope: "owner",
                  subject_kind: "principal",
                  subject: "user:dev:alice",
                  notebook_id: "demo",
                } as T,
              ]);
          return statement;
        };
        const env = {} as Env;
        env.DB = db;
        const room = new NotebookRoom(state.state, env);
        await state.drain();
        const harness = roomHarness(room);
        const materializer = new RoomMaterializer("demo", state.state, {} as Env);
        harness.materializers.set("demo", materializer as never);
        await materializer.setWorkstationAttachment({
          workstation_id: "celld-preview-python",
          display_name: "Python",
          provider: "celld-pyodide",
          default_environment_label: "Python",
          environment_policy: "curated",
          status: "ready",
          runtime_session_id: "package-session",
        });
        const baseline = { version: 1, pyodide: "0.28.3", requirements: ["six"], wheels: [] };
        const next = { ...baseline, requirements: ["six", "requests"] };
        await materializer.compareSetCloudPackageManifest(null, baseline);
        const socket = new FakeSocket();
        const peer = {
          id: "owner",
          socket: socket.asCloudflareWebSocket(),
          identity: authenticateDevRequest(
            new Request("https://cloud.test/n/demo/sync?user=alice&operator=browser:a&scope=owner"),
          ),
          connectedAt: new Date().toISOString(),
          workstation: null,
        };
        socket.serializeAttachment({
          notebookId: "demo",
          peerId: peer.id,
          identity: peer.identity,
          connectedAt: peer.connectedAt,
        });
        harness.peers.set(peer.id, peer);
        let signalStarted!: () => void;
        let finish!: (value: unknown) => void;
        const started = new Promise<void>((resolve) => {
          signalStarted = resolve;
        });
        const finished = new Promise<unknown>((resolve) => {
          finish = resolve;
        });
        const runtime = {
          ownerPrincipal: "user:dev:alice",
          sessionId: "package-session",
          presence: { peer_id: "runtime", connection_scope: "runtime_peer" },
          installPackages: async () => {
            signalStarted();
            return finished;
          },
          wake: async () => {},
          close: async () => {},
          accept: () => {},
        };
        Object.assign(room, {
          managedPython: new Map([["demo", { runtime, ready: Promise.resolve() }]]),
        });
        if (outcome === "restart_checkpoint_failure")
          materializer.checkpoint = async () => {
            throw new Error("checkpoint failed");
          };
        const request = (id: string, action: string, extra = {}) =>
          encodeTypedFrame(
            FrameType.REQUEST,
            new TextEncoder().encode(JSON.stringify({ id, action, ...extra })),
          );
        await room.webSocketMessage(
          peer.socket,
          request("packages", "cloud_package_change", {
            operation: "add",
            requirement: "requests",
          }),
        );
        await started;
        assert.deepEqual(
          await materializer.getCloudPackageManifest(),
          baseline,
          "ack is not a successful install",
        );
        if (outcome === "concurrent_edit")
          await materializer.compareSetCloudPackageManifest(baseline, {
            ...baseline,
            requirements: ["owner-edit"],
          });
        if (outcome === "interrupt") {
          await room.webSocketMessage(peer.socket, request("interrupt", "interrupt_execution"));
          for (
            let round = 0;
            round < 10 &&
            !socket.sent.some(
              (frame) =>
                frame[0] === FrameType.RESPONSE &&
                JSON.parse(new TextDecoder().decode(frame.slice(1))).id === "interrupt",
            );
            round++
          )
            await new Promise((resolve) => setImmediate(resolve));
          assert.ok(
            socket.sent.some(
              (frame) =>
                frame[0] === FrameType.RESPONSE &&
                JSON.parse(new TextDecoder().decode(frame.slice(1))).id === "interrupt",
            ),
            "interrupt must finish while install is still pending",
          );
        }
        finish(
          outcome === "failure" || outcome === "restart_checkpoint_failure"
            ? {
                status: "error",
                error: "Package installation needs a restart",
                needs_restart: outcome === "restart_checkpoint_failure",
              }
            : { status: "ready", manifest: next, installed: ["six==1", "requests==2"] },
        );
        await state.drain();
        const responses = socket.sent
          .filter((frame) => frame[0] === FrameType.RESPONSE)
          .map((frame) => JSON.parse(new TextDecoder().decode(frame.slice(1))));
        assert.equal(
          responses.find((response) => response.id === "packages")?.result,
          outcome === "success" ? "sync_environment_complete" : "sync_environment_failed",
        );
        if (outcome === "restart_checkpoint_failure")
          assert.equal(
            responses.find((response) => response.id === "packages")?.needs_restart,
            true,
            "checkpoint failure must not hide the provider's restart requirement",
          );
        assert.deepEqual(
          ((await materializer.getCloudPackageManifest()) as typeof baseline).requirements,
          outcome === "success"
            ? next.requirements
            : outcome === "concurrent_edit"
              ? ["owner-edit"]
              : baseline.requirements,
        );
        if (outcome === "success") {
          await room.webSocketMessage(
            peer.socket,
            request("remove", "cloud_package_change", {
              operation: "remove",
              requirement: "requests",
            }),
          );
          await state.drain();
          assert.deepEqual(
            ((await materializer.getCloudPackageManifest()) as typeof baseline).requirements,
            ["six"],
          );
        }
        if (outcome === "interrupt") {
          await materializer.compareSetCloudPackageManifest(baseline, {
            ...baseline,
            pyodide: "old",
            wheels: [{ malformed: true }],
          });
          await room.webSocketMessage(
            peer.socket,
            request("clear", "cloud_package_change", { operation: "clear", requirement: "" }),
          );
          await state.drain();
          assert.deepEqual(
            ((await materializer.getCloudPackageManifest()) as typeof baseline).requirements,
            [],
          );
        }
      },
    );
  }
});

describe("NotebookRoom presence rewrite", () => {
  it("reports an unexpected execution request failure and accepts the next request", async () => {
    const state = hibernatedState([]);
    const room = new NotebookRoom(state.state, {} as Env);
    await state.drain();
    const backgroundErrors: unknown[] = [];
    const waitUntil = state.state.waitUntil;
    state.state.waitUntil = (promise) => {
      void promise.catch((error) => {
        backgroundErrors.push(error);
      });
      waitUntil(promise);
    };
    const harness = roomHarness(room);
    const socket = new FakeSocket();
    const peer = {
      id: "owner",
      socket: socket.asCloudflareWebSocket(),
      identity: authenticateDevRequest(
        new Request("https://cloud.test/n/demo/sync?user=alice&operator=browser:a&scope=owner"),
      ),
      connectedAt: new Date().toISOString(),
      consecutiveRejectedFrames: 0,
      workstation: null,
    };
    socket.serializeAttachment({
      notebookId: "demo",
      peerId: peer.id,
      identity: peer.identity,
      connectedAt: peer.connectedAt,
    });
    harness.peers.set(peer.id, peer);
    let attempts = 0;
    let executions = 0;
    Object.assign(room, {
      activeRuntimePeer: async () => {
        if (++attempts === 1) throw new Error("runtime lookup unavailable");
        return undefined;
      },
      ensureRuntimeForHostedExecution: async () => true,
    });
    harness.materializers.set("demo", {
      receiveFrame: async () => {
        executions++;
        return noopMaterializedResult();
      },
    } as never);
    const request = (id: string) =>
      encodeTypedFrame(
        FrameType.REQUEST,
        new TextEncoder().encode(JSON.stringify({ id, action: "execute_cell", cell_id: "code" })),
      );

    await room.webSocketMessage(peer.socket, request("first"));
    // Report the request failure without leaving a rejected background task.
    await state.drain();
    assert.deepEqual(backgroundErrors, [], "the request background task must settle successfully");
    assert.equal(socket.sent.length, 1, "the browser must receive the request failure");
    const rejected = decodeJsonPayload<Record<string, unknown>>(socket.sent[0].slice(1));
    assert.equal(rejected.type, "cloud_frame_rejected");
    assert.match(String(rejected.reason), /runtime lookup unavailable/);
    assert.equal(peer.consecutiveRejectedFrames, 0, "server failure is not client abuse");
    assert.equal(executions, 0);

    await room.webSocketMessage(peer.socket, request("second"));
    await state.drain();
    assert.deepEqual(backgroundErrors, []);
    assert.equal(executions, 1);
    const accepted = decodeJsonPayload<Record<string, unknown>>(socket.sent[1].slice(1));
    assert.equal(accepted.type, "cloud_frame_accepted");
  });

  it("lets the next socket sync satisfy a waiting execution request", async () => {
    const state = hibernatedState([]);
    const room = new NotebookRoom(state.state, {} as Env);
    await state.drain();
    const harness = roomHarness(room);
    const socket = new FakeSocket();
    const peer = {
      id: "owner",
      socket: socket.asCloudflareWebSocket(),
      identity: authenticateDevRequest(
        new Request("https://cloud.test/n/demo/sync?user=alice&operator=browser:a&scope=owner"),
      ),
      connectedAt: new Date().toISOString(),
      consecutiveRejectedFrames: 0,
      workstation: null,
    };
    socket.serializeAttachment({
      notebookId: "demo",
      peerId: peer.id,
      identity: peer.identity,
      connectedAt: new Date().toISOString(),
    });
    harness.peers.set(peer.id, peer);
    let releaseHeads!: (present: boolean) => void;
    const headsArrived = new Promise<boolean>((resolve) => {
      releaseHeads = resolve;
    });
    const executed: string[] = [];
    harness.materializers.set("demo", {
      waitForNotebookHeads: () => headsArrived,
      receiveFrame: async (_peer: unknown, frame: { type: number; payload: Uint8Array }) => {
        if (frame.type === FrameType.AUTOMERGE_SYNC) releaseHeads(true);
        if (frame.type === FrameType.REQUEST)
          executed.push(JSON.parse(new TextDecoder().decode(frame.payload)).id);
        return noopMaterializedResult();
      },
    } as never);
    Object.assign(room, { ensureRuntimeForHostedExecution: async () => true });
    const request = encodeTypedFrame(
      FrameType.REQUEST,
      new TextEncoder().encode(
        JSON.stringify({
          id: "causal",
          action: "execute_cell",
          cell_id: "code",
          required_heads: ["a".repeat(64)],
        }),
      ),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const returned = await Promise.race([
        room.webSocketMessage(peer.socket, request).then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), 100);
        }),
      ]);
      assert.equal(
        returned,
        true,
        "the socket reader must be allowed to receive the required sync",
      );
      assert.deepEqual(executed, []);
      await room.webSocketMessage(
        peer.socket,
        encodeTypedFrame(
          FrameType.REQUEST,
          new TextEncoder().encode(
            JSON.stringify({ id: "later", action: "execute_cell", cell_id: "code" }),
          ),
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.deepEqual(executed, [], "later requests cannot overtake the causal wait");
      await room.webSocketMessage(
        peer.socket,
        encodeTypedFrame(FrameType.AUTOMERGE_SYNC, new Uint8Array([0])),
      );
      await state.drain();
      assert.deepEqual(executed, ["causal", "later"]);
      Object.assign(harness.materializers.get("demo")!, {
        waitForNotebookHeads: async () => {
          harness.peers.delete(peer.id);
          return true;
        },
      });
      await room.webSocketMessage(peer.socket, request);
      await state.drain();
      assert.deepEqual(
        executed,
        ["causal", "later"],
        "disconnect during causal wait must not submit execution",
      );
    } finally {
      clearTimeout(timer);
      releaseHeads(false);
      await state.drain();
    }
  });

  it("does not broadcast an in-flight cursor update after announcing the peer's departure", async () => {
    const state = hibernatedState([]);
    const room = new NotebookRoom(state.state, {} as Env);
    await state.drain();
    const harness = roomHarness(room);
    const identity = authenticateDevRequest(
      new Request("https://cloud.test/n/demo/sync?user=alice&operator=browser:a&scope=editor"),
    );
    const socket = new FakeSocket();
    const observer = new FakeSocket();
    const peer = {
      id: "departing",
      socket: socket.asCloudflareWebSocket(),
      identity,
      connectedAt: new Date().toISOString(),
      consecutiveRejectedFrames: 0,
    };
    harness.peers.set(peer.id, peer);
    harness.peers.set("observer", {
      ...peer,
      id: "observer",
      socket: observer.asCloudflareWebSocket(),
    });
    harness.materializers.set("demo", fakeMaterializer(noopMaterializedResult()));
    const frame = encodeTypedFrame(
      FrameType.PRESENCE,
      await encodePresenceFrame({
        type: "update",
        peer_id: peer.id,
        channel: "cursor",
        data: { cell_id: "cell", line: 1, column: 1 },
      }),
    );
    const pending = harness.handleMessage("demo", peer, frame);
    harness.removePeer("demo", peer);
    await pending;
    await state.drain();
    const frames = observer.sent.map(splitTypedFrame);
    assert.deepEqual(
      frames.map((frame) => frame.type),
      [FrameType.SESSION_CONTROL],
    );
    assert.equal(decodeJsonPayload<{ type: string }>(frames[0].payload).type, "cloud_peer_left");
    assert.equal(socket.sent.length, 0, "a departed peer is not acknowledged after normalization");
  });

  for (const event of ["close", "error"] as const) {
    it(`records ${event} evidence and broadcasts one departure for a hibernation socket`, async () => {
      const state = hibernatedState([]);
      const room = new NotebookRoom(state.state, {} as Env);
      await state.drain();
      const harness = roomHarness(room);
      const socket = new FakeSocket();
      const observer = new FakeSocket();
      const identity = authenticateDevRequest(
        new Request("https://cloud.test/n/demo/sync?user=alice&operator=browser:a&scope=editor"),
      );
      const connectedAt = new Date(Date.now() - 5_000).toISOString();
      socket.serializeAttachment({
        notebookId: "demo",
        peerId: "departing",
        identity,
        connectedAt,
      });
      harness.peers.set("departing", {
        id: "departing",
        socket: socket.asCloudflareWebSocket(),
        identity,
        connectedAt,
        consecutiveRejectedFrames: 0,
      });
      harness.peers.set("observer", {
        id: "observer",
        socket: observer.asCloudflareWebSocket(),
        identity,
        connectedAt,
        consecutiveRejectedFrames: 0,
      });
      harness.materializers.set("demo", fakeMaterializer(noopMaterializedResult()));
      const heartbeatAt = new Date(Date.now() - 1_000);
      state.state.getWebSocketAutoResponseTimestamp = (ws) => {
        assert.equal(ws, socket.asCloudflareWebSocket());
        assert.equal(socket.closed, false, "read runtime evidence before closing");
        return heartbeatAt;
      };
      const logs: Record<string, unknown>[] = [];
      const originalInfo = console.info;
      console.info = (_prefix, record) => logs.push(record);
      try {
        if (event === "close")
          room.webSocketClose(socket.asCloudflareWebSocket(), 1001, "going away", true);
        else room.webSocketError(socket.asCloudflareWebSocket(), new Error("connection reset"));
        room.webSocketClose(socket.asCloudflareWebSocket(), 1006, "", false);
        await state.drain();
      } finally {
        console.info = originalInfo;
      }
      assert.equal(harness.peers.has("departing"), false);
      assert.equal(harness.peers.has("observer"), true);
      const closed = logs.filter((record) => record.event === "room.connection.closed");
      assert.equal(closed.length, 1);
      assert.equal(closed[0].close_source, `websocket_${event}`);
      assert.equal(closed[0].last_auto_response_at, heartbeatAt.toISOString());
      assert.equal(closed[0].auto_response_timestamp_supported, true);
      if (event === "close") {
        assert.equal(closed[0].close_code, 1001);
        assert.equal(closed[0].close_reason, "going away");
        assert.equal(closed[0].close_was_clean, true);
      } else {
        assert.equal(closed[0].close_error, "connection reset");
        assert.equal(closed[0].close_was_clean, undefined);
      }
      const departures = observer.sent
        .map(splitTypedFrame)
        .filter((frame) => frame.type === FrameType.SESSION_CONTROL)
        .map((frame) => decodeJsonPayload<{ type: string; peer_id: string }>(frame.payload))
        .filter((control) => control.type === "cloud_peer_left");
      assert.deepEqual(
        departures.map((control) => control.peer_id),
        ["departing"],
      );
    });
  }
  it("builds room-ready rosters from current peers", () => {
    const room = new NotebookRoom(fakeState(), {} as Env);
    const harness = roomHarness(room);
    const ownerIdentity = authenticateDevRequest(
      new Request("https://cloud.test/n/demo/sync?user=alice&operator=browser:a&scope=owner"),
    );
    const runtimeIdentity = authenticateDevRequest(
      new Request(
        "https://cloud.test/n/demo/sync?user=alice&operator=runtime:py&scope=runtime_peer",
      ),
    );
    harness.peers.set("owner", {
      id: "owner",
      socket: new FakeSocket().asCloudflareWebSocket(),
      identity: {
        ...ownerIdentity,
        metadata: {
          ...ownerIdentity.metadata,
          displayName: "Alice Demo",
        },
      },
      connectedAt: "2026-06-13T00:00:00.000Z",
      consecutiveRejectedFrames: 0,
    });
    harness.peers.set("runtime", {
      id: "runtime",
      socket: new FakeSocket().asCloudflareWebSocket(),
      identity: runtimeIdentity,
      connectedAt: "2026-06-13T00:00:01.000Z",
      consecutiveRejectedFrames: 0,
    });

    const roster = harness.roomPeerRoster();

    assert.deepEqual(
      roster.map((peer) => ({
        peer_id: peer.peer_id,
        actor_label: peer.actor_label,
        connection_scope: peer.connection_scope,
        participant_key: peer.participant_key,
        display_name: peer.display_name,
      })),
      [
        {
          peer_id: "owner",
          actor_label: "user:dev:alice/browser:a",
          connection_scope: "owner",
          participant_key: "user:dev:alice",
          display_name: "Alice Demo",
        },
        {
          peer_id: "runtime",
          actor_label: "user:dev:alice/runtime:py",
          connection_scope: "runtime_peer",
          participant_key: "user:dev:alice",
          display_name: "alice",
        },
      ],
    );
  });

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

  it("drops unsupported presence payloads without surfacing a room load rejection", async () => {
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

    await harness.handleMessage(
      "demo",
      peer,
      encodeTypedFrame(
        FrameType.PRESENCE,
        new TextEncoder().encode(JSON.stringify({ actor_label: identity.actorLabel })),
      ),
    );

    assert.equal(peer.consecutiveRejectedFrames, 1);
    assert.equal(socket.sent.length, 0, "bad presence should not send cloud_frame_rejected");
    assert.equal(socket.closed, false);
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

  it("broadcasts authenticated presence without durable room history", async () => {
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
    let broadcasted = 0;
    harness.peers.set(peer.id, peer);
    harness.broadcastFrame = () => {
      broadcasted += 1;
    };
    const message = encodeTypedFrame(
      FrameType.PRESENCE,
      await encodePresenceFrame({
        type: "heartbeat",
        peer_id: "client-peer",
      }),
    );

    await harness.handleMessage("demo", peer, message);

    assert.equal(broadcasted, 1);
    assert.equal(socket.sent.length, 1);
    assert.equal(
      decodeJsonPayload<Record<string, unknown>>(socket.sent[0].slice(1)).type,
      "cloud_frame_accepted",
    );
    assert.equal(peer.consecutiveRejectedFrames, 0);
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
        "x-nteract-runtime-session-id": "job-123",
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
    assert.equal(metadata?.runtimeSessionId, "job-123");
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

  it("arms the CF auto-response liveness pair when the runtime supports it", () => {
    const pairs: Array<{ request: string; response: string }> = [];
    class PairCtor {
      constructor(
        readonly request: string,
        readonly response: string,
      ) {}
    }
    const globals = globalThis as { WebSocketRequestResponsePair?: unknown };
    const original = globals.WebSocketRequestResponsePair;
    globals.WebSocketRequestResponsePair = PairCtor;
    try {
      const state = fakeState() as DurableObjectState & {
        setWebSocketAutoResponse?: (pair: { request: string; response: string }) => void;
      };
      state.setWebSocketAutoResponse = (pair) => pairs.push(pair);
      new NotebookRoom(state, {} as Env);
      assert.equal(pairs.length, 1);
      assert.equal(pairs[0].request, LIVENESS_PING);
      assert.equal(pairs[0].response, LIVENESS_PONG);

      // Hibernation wake = a fresh constructor run against the SAME durable
      // state. Re-arming per wake must be an idempotent re-set of the same
      // pair — the load-bearing claim behind arming in the constructor.
      new NotebookRoom(state, {} as Env);
      assert.equal(pairs.length, 2);
      assert.equal(pairs[1].request, pairs[0].request);
      assert.equal(pairs[1].response, pairs[0].response);

      // Older runtime shape: the global constructor exists but the state
      // lacks setWebSocketAutoResponse. The second conjunct of the feature
      // detection must keep the constructor from throwing — a TypeError
      // here is a total room outage, not a degraded probe.
      assert.doesNotThrow(() => new NotebookRoom(fakeState(), {} as Env));
    } finally {
      globals.WebSocketRequestResponsePair = original;
    }
    // Feature detection: without the global constructor (every other test in
    // this file), the constructor must not call setWebSocketAutoResponse.
    const uncalled: unknown[] = [];
    const bare = fakeState() as DurableObjectState & {
      setWebSocketAutoResponse?: (pair: unknown) => void;
    };
    bare.setWebSocketAutoResponse = (pair) => uncalled.push(pair);
    new NotebookRoom(bare, {} as Env);
    assert.equal(uncalled.length, 0);
  });

  it("answers liveness pings without counting them toward rejected-frame close", async () => {
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

    // Fallback path for runtimes without setWebSocketAutoResponse: pings are
    // text frames, but they must never ride the binary-only rejection.
    for (let i = 0; i < 20; i += 1) {
      await harness.handleMessage("demo", peer, LIVENESS_PING);
    }

    assert.equal(socket.closed, false);
    assert.equal(peer.consecutiveRejectedFrames, 0);
    assert.equal(socket.sent.length, 20);
    assert(
      socket.sent.every((frame) => new TextDecoder().decode(frame) === LIVENESS_PONG),
      "every ping is answered with a pong, not a rejection control frame",
    );
  });

  it("swallows pong send failures on a closing socket", async () => {
    const room = new NotebookRoom(fakeState(), {} as Env);
    const identity = authenticateDevRequest(
      new Request("https://cloud.test/n/demo/sync?user=alice&operator=desktop:a&scope=editor"),
    );
    const socket = new FakeSocket({ throwOnSend: true });
    const peer = {
      id: "peer-a",
      socket: socket.asCloudflareWebSocket(),
      identity,
      connectedAt: "2026-05-22T00:00:00.000Z",
      consecutiveRejectedFrames: 0,
    };
    const harness = roomHarness(room);
    harness.peers.set(peer.id, peer);

    await harness.handleMessage("demo", peer, LIVENESS_PING);

    assert.equal(peer.consecutiveRejectedFrames, 0);
    assert.equal(harness.peers.has(peer.id), true);
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
      syncPeer: async () => noopMaterializedResult(),
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

  it("keeps the socket open when initial room-host peer sync is degraded", async () => {
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
      syncPeer: async () => {
        throw new Error("Exceeded allowed rows written in Durable Objects free tier.");
      },
      receiveFrame: async () => noopMaterializedResult(),
      checkpoint: async () => undefined,
      removePeer: async () => undefined,
    });

    await harness.syncPeerFromRoomHost("demo", peer);

    assert.equal(socket.closed, false);
    assert.equal(harness.peers.has(peer.id), true);
    assert.equal(socket.sent.length, 1);
    assert.equal(socket.sent[0][0], FrameType.SESSION_CONTROL);
    const degraded = decodeJsonPayload<Record<string, unknown>>(socket.sent[0].slice(1));
    assert.equal(degraded.type, "cloud_room_degraded");
    assert.equal(degraded.peer_id, peer.id);
    assert.match(String(degraded.reason), /Exceeded allowed rows written/);
  });

  it("closes the socket when initial room-host peer sync fails for non-storage errors", async () => {
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
      syncPeer: async () => {
        throw new Error("host document could not be materialized");
      },
      receiveFrame: async () => noopMaterializedResult(),
      checkpoint: async () => undefined,
      removePeer: async () => undefined,
    });

    await harness.syncPeerFromRoomHost("demo", peer);

    assert.equal(socket.closed, true);
    assert.equal(socket.closeCode, 1011);
    assert.equal(socket.closeReason, "room sync failed");
    assert.equal(harness.peers.has(peer.id), false);
    assert.equal(socket.sent.length, 0);
  });

  it("reports materialized sync storage degradation without rejecting the frame", async () => {
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
      syncPeer: async () => noopMaterializedResult(),
      receiveFrame: async () => {
        throw new Error("Exceeded allowed rows written in Durable Objects free tier.");
      },
      checkpoint: async () => undefined,
      removePeer: async () => undefined,
    });

    await harness.handleMessage(
      "demo",
      peer,
      encodeTypedFrame(FrameType.AUTOMERGE_SYNC, new Uint8Array([1])),
    );

    assert.equal(socket.closed, false);
    assert.equal(peer.consecutiveRejectedFrames, 0);
    assert.equal(socket.sent.length, 1);
    assert.equal(socket.sent[0][0], FrameType.SESSION_CONTROL);
    const degraded = decodeJsonPayload<Record<string, unknown>>(socket.sent[0].slice(1));
    assert.equal(degraded.type, "cloud_room_degraded");
    assert.equal(degraded.peer_id, peer.id);
    assert.match(String(degraded.reason), /Exceeded allowed rows written/);
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

  it("collapses duplicate hibernated runtime peers for the same workstation", async () => {
    const oldIdentity = authenticateDevRequest(
      new Request(
        "https://cloud.test/n/demo/sync?user=runtime&operator=runtime:old&scope=runtime_peer",
      ),
    );
    const otherIdentity = authenticateDevRequest(
      new Request(
        "https://cloud.test/n/demo/sync?user=runtime&operator=runtime:other&scope=runtime_peer",
      ),
    );
    const newIdentity = authenticateDevRequest(
      new Request(
        "https://cloud.test/n/demo/sync?user=runtime&operator=runtime:new&scope=runtime_peer",
      ),
    );
    const oldSocket = new FakeSocket();
    const otherSocket = new FakeSocket();
    const newSocket = new FakeSocket();
    oldSocket.serializeAttachment({
      notebookId: "demo",
      peerId: "runtime-old",
      identity: oldIdentity,
      connectedAt: "2026-06-06T00:00:00.000Z",
      workstation: { workstationId: "ws-lab2" },
    });
    otherSocket.serializeAttachment({
      notebookId: "demo",
      peerId: "runtime-other",
      identity: otherIdentity,
      connectedAt: "2026-06-06T00:00:00.000Z",
      workstation: { workstationId: "ws-other" },
    });
    newSocket.serializeAttachment({
      notebookId: "demo",
      peerId: "runtime-new",
      identity: newIdentity,
      connectedAt: "2026-06-06T00:00:01.000Z",
      workstation: { workstationId: "ws-lab2" },
    });
    const state = hibernatedState([
      oldSocket.asCloudflareWebSocket(),
      otherSocket.asCloudflareWebSocket(),
      newSocket.asCloudflareWebSocket(),
    ]);
    const room = new NotebookRoom(state.state, {} as Env);
    const harness = roomHarness(room);

    await state.drain();

    assert.equal(oldSocket.closed, true);
    assert.equal(oldSocket.closeCode, 1008);
    assert.equal(oldSocket.closeReason, "replaced by newer runtime peer");
    assert.equal(harness.peerForSocket(oldSocket.asCloudflareWebSocket()), undefined);
    assert.equal(
      harness.peerForSocket(newSocket.asCloudflareWebSocket())?.id,
      "runtime-new",
      "newer runtime peer for the same workstation survives restore",
    );
    assert.equal(
      harness.peerForSocket(otherSocket.asCloudflareWebSocket())?.id,
      "runtime-other",
      "different workstation runtime peer survives restore",
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

    harness.peers.set(runtimePeer.id, runtimePeer);
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
      accelerators: null,
      working_directory: null,
      runtime_session_id: null,
      updated_at: runtimePeer.connectedAt,
    });
    assert.equal(checkpointed, 1, "changed attachments are checkpointed");
    assert.equal(viewerSocket.sent.length, 1);
    assert.deepEqual([...viewerSocket.sent[0]], [FrameType.RUNTIME_STATE_SYNC, 1, 2, 3]);
  });

  it("keeps host-owned accelerator facts when a selected runtime peer becomes ready", async () => {
    const state = hibernatedState([]);
    const accelerators = [
      {
        kind: "gpu",
        vendor: "NVIDIA",
        model: "A100",
        count: 1,
        memory_bytes_per_device: 80 * 1024 ** 3,
        readiness: "ready",
        diagnostic: null,
      },
    ] as const;
    const db = new ResumeNotebookD1({
      acceleratorsJson: JSON.stringify(accelerators),
      cpuCount: 16,
      memoryBytes: 64 * 1024 ** 3,
    });
    const room = new NotebookRoom(state.state, { DB: db } as unknown as Env);
    const harness = roomHarness(room);
    const runtimePeer = {
      id: "runtime-gpu",
      socket: new FakeSocket().asCloudflareWebSocket(),
      identity: authenticateDevRequest(
        new Request(
          "https://cloud.test/n/demo/sync?user=runtime&operator=runtime:gpu&scope=runtime_peer",
        ),
      ),
      connectedAt: "2026-07-09T00:00:01.000Z",
      workstation: {
        workstationId: "ws-lab2",
        runtimeSessionId: "job-gpu",
        displayName: "GPU workstation",
        defaultEnvironmentLabel: "Current Python",
        environmentPolicy: "current_python",
        workingDirectory: "/srv/notebooks",
      },
    };
    let publishedAttachment: unknown;
    harness.materializers.set("demo", {
      receiveFrame: async () => noopMaterializedResult(),
      setWorkstationAttachment: async (attachment: unknown) => {
        publishedAttachment = attachment;
        return noopMaterializedResult();
      },
    } as never);

    harness.peers.set(runtimePeer.id, runtimePeer);
    await harness.publishRuntimePeerAttachment("demo", runtimePeer);

    assert.deepEqual(publishedAttachment, {
      workstation_id: "ws-lab2",
      display_name: "GPU workstation",
      provider: "runtime_peer",
      default_environment_label: "Current Python",
      environment_policy: "current_python",
      status: "ready",
      status_message: null,
      cpu_count: 16,
      memory_bytes: 64 * 1024 ** 3,
      accelerators,
      working_directory: "/srv/notebooks",
      updated_at: runtimePeer.connectedAt,
      runtime_session_id: "job-gpu",
    });
  });

  it("does not erase host-owned hardware facts when the registry lookup fails", async () => {
    const state = hibernatedState([]);
    const db = new ResumeNotebookD1({ workstationLookupFails: true });
    const room = new NotebookRoom(state.state, { DB: db } as unknown as Env);
    const harness = roomHarness(room);
    const retainedAttachment = {
      workstation_id: "ws-lab2",
      display_name: "GPU workstation",
      provider: "runtime_peer",
      default_environment_label: "Current Python",
      environment_policy: "current_python",
      status: "connecting",
      status_message: "Starting compute.",
      cpu_count: 16,
      memory_bytes: 64 * 1024 ** 3,
      accelerators: [
        {
          kind: "gpu",
          vendor: "NVIDIA",
          model: "A100",
          count: 1,
          memory_bytes_per_device: 80 * 1024 ** 3,
          readiness: "ready",
          diagnostic: null,
        },
      ],
      working_directory: "/srv/notebooks",
      updated_at: "2026-07-09T00:00:00.000Z",
      runtime_session_id: "job-old",
    } as const;
    const runtimePeer = {
      id: "runtime-gpu",
      socket: new FakeSocket().asCloudflareWebSocket(),
      identity: authenticateDevRequest(
        new Request(
          "https://cloud.test/n/demo/sync?user=runtime&operator=runtime:gpu&scope=runtime_peer",
        ),
      ),
      connectedAt: "2026-07-09T00:00:01.000Z",
      workstation: {
        workstationId: "ws-lab2",
        runtimeSessionId: "job-new",
        displayName: "GPU workstation",
        defaultEnvironmentLabel: "Current Python",
        environmentPolicy: "current_python",
        workingDirectory: "/srv/notebooks",
      },
    };
    let publishedAttachment: unknown;
    harness.materializers.set("demo", {
      receiveFrame: async () => noopMaterializedResult(),
      getWorkstationAttachment: async () => retainedAttachment,
      setWorkstationAttachment: async (attachment: unknown) => {
        publishedAttachment = attachment;
        return noopMaterializedResult();
      },
    } as never);

    harness.peers.set(runtimePeer.id, runtimePeer);
    await harness.publishRuntimePeerAttachment("demo", runtimePeer);

    assert.deepEqual(publishedAttachment, {
      ...retainedAttachment,
      status: "ready",
      status_message: null,
      updated_at: runtimePeer.connectedAt,
      runtime_session_id: "job-new",
    });
  });

  it("does not cache selected runtime session for ignored stale runtime-peer publishes", async () => {
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
        runtimeSessionId: "job-stale",
        workingDirectory: "/home/ubuntu/project",
      },
    };
    let checkpointed = 0;
    harness.materializers.set("demo", {
      receiveFrame: async () => noopMaterializedResult(),
      checkpoint: async () => {
        checkpointed += 1;
      },
      setWorkstationAttachment: async () => ({
        ...noopMaterializedResult(),
        ignored_stale: true,
      }),
    } as never);

    harness.peers.set(runtimePeer.id, runtimePeer);
    await harness.publishRuntimePeerAttachment("demo", runtimePeer);

    assert.equal(checkpointed, 0, "ignored stale publishes are not checkpointed");
    assert.equal(
      await harness.runtimePeerAuthorityError?.("demo", {
        ...runtimePeer.workstation,
        runtimeSessionId: "job-current",
      }),
      null,
      "ignored stale publish does not poison selected runtime session authority",
    );
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
    assert.deepEqual(await response.json(), {
      ok: true,
      changed: true,
      checkpoint_persisted: true,
    });
    assert.deepEqual(publishedAttachment, attachment);
    assert.equal(checkpointed, 1, "changed control updates are checkpointed");
    assert.deepEqual([...viewerSocket.sent[0]], [FrameType.RUNTIME_STATE_SYNC, 4, 5, 6]);
  });

  it("reports workstation attachment control when checkpoint persistence fails", async () => {
    const state = hibernatedState([]);
    const room = new NotebookRoom(state.state, {} as Env);
    const harness = roomHarness(room);
    harness.materializers.set("demo", {
      receiveFrame: async () => noopMaterializedResult(),
      checkpoint: async () => {
        throw new Error("Exceeded allowed rows written in Durable Objects free tier.");
      },
      setWorkstationAttachment: async () => ({
        ...noopMaterializedResult(),
        changed: true,
        runtime_state_changed: true,
      }),
      getRuntimeQueueDepth: async () => 0,
    } as never);

    const response = await room.fetch(
      new Request("https://room.internal/internal/n/demo/workstation-attachment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          attachment: {
            workstation_id: "ws-lab2",
            display_name: "Lab2 workstation",
            provider: "runtime_peer",
            default_environment_label: "Current Python",
            environment_policy: "current_python",
            status: "connecting",
            status_message: "Waiting for Lab2 to accept the compute request.",
            cpu_count: null,
            memory_bytes: null,
            working_directory: null,
            updated_at: "2026-06-07T00:00:01.000Z",
          },
        }),
      }),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      changed: true,
      checkpoint_persisted: false,
    });
  });

  it("disconnects runtime peers when replacement workstation attachment control is published", async () => {
    const state = alarmCapableState();
    const compute = new FakeOwnerComputeIndexNamespace();
    const room = new NotebookRoom(state.state, roomEnvWithComputeIndex(compute));
    const harness = roomHarness(room);
    const runtimeSocket = new FakeSocket();
    const runtimePeer = {
      id: "runtime",
      socket: runtimeSocket.asCloudflareWebSocket(),
      identity: authenticateDevRequest(
        new Request(
          "https://cloud.test/n/demo/sync?user=runtime&operator=runtime:py&scope=runtime_peer",
        ),
      ),
      connectedAt: "2026-06-07T00:00:00.000Z",
    };
    harness.peers.set(runtimePeer.id, runtimePeer);
    harness.materializers.set("demo", {
      receiveFrame: async () => noopMaterializedResult(),
      checkpoint: async () => undefined,
      removePeer: async () => undefined,
      setWorkstationAttachment: async () => ({
        ...noopMaterializedResult(),
        changed: true,
        runtime_state_changed: true,
      }),
      getRuntimeQueueDepth: async () => 0,
    } as never);

    const response = await room.fetch(
      new Request("https://room.internal/internal/n/demo/workstation-attachment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          close_runtime_peers: true,
          close_reason: "workstation restart requested",
          attachment: {
            workstation_id: "ws-lab2",
            display_name: "Lab2 workstation",
            provider: "runtime_peer",
            default_environment_label: "Current Python",
            environment_policy: "current_python",
            status: "connecting",
            status_message: "Waiting for Lab2 to accept the compute request.",
            cpu_count: 8,
            memory_bytes: 16_000_000_000,
            working_directory: "/home/ubuntu/project",
            updated_at: "2026-06-07T00:00:01.000Z",
          },
        }),
      }),
    );

    await state.drain();
    assert.equal(response.status, 200);
    assert.equal(harness.hasRuntimePeer(), false);
    assert.equal(runtimeSocket.closed, true);
    assert.equal(runtimeSocket.closeCode, 1012);
    assert.equal(runtimeSocket.closeReason, "workstation restart requested");
    assert.equal(await state.getAlarm(), null, "intentional replacement does not arm stale repair");
    assert.deepEqual(
      compute.requests.map((request) => [
        request.objectName,
        new URL(request.url).pathname,
        request.body?.summary?.status,
        request.body?.summary?.runtime_peer_count,
        request.body?.summary?.workstation_id,
      ]),
      [["owner-compute:v1:user:dev:alice", "/upsert", "starting", 0, "ws-lab2"]],
    );
  });

  it("keeps runtime peers when replacement workstation attachment control is ignored as stale", async () => {
    const state = alarmCapableState();
    const room = new NotebookRoom(state.state, {} as Env);
    const harness = roomHarness(room);
    const runtimeSocket = new FakeSocket();
    const runtimePeer = {
      id: "runtime",
      socket: runtimeSocket.asCloudflareWebSocket(),
      identity: authenticateDevRequest(
        new Request(
          "https://cloud.test/n/demo/sync?user=runtime&operator=runtime:py&scope=runtime_peer",
        ),
      ),
      connectedAt: "2026-06-07T00:00:00.000Z",
    };
    harness.peers.set(runtimePeer.id, runtimePeer);
    harness.materializers.set("demo", {
      receiveFrame: async () => noopMaterializedResult(),
      checkpoint: async () => undefined,
      removePeer: async () => undefined,
      setWorkstationAttachment: async () => ({
        ...noopMaterializedResult(),
        ignored_stale: true,
      }),
    } as never);

    const response = await room.fetch(
      new Request("https://room.internal/internal/n/demo/workstation-attachment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          close_runtime_peers: true,
          close_reason: "workstation restart requested",
          attachment: {
            workstation_id: "ws-lab2",
            display_name: "Lab2 workstation",
            provider: "runtime_peer",
            default_environment_label: "Current Python",
            environment_policy: "current_python",
            status: "connecting",
            status_message: "Waiting for Lab2 to accept the compute request.",
            cpu_count: 8,
            memory_bytes: 16_000_000_000,
            working_directory: "/home/ubuntu/project",
            updated_at: "2026-06-07T00:00:01.000Z",
            runtime_session_id: "job-stale",
          },
        }),
      }),
    );

    await state.drain();
    assert.equal(response.status, 200);
    assert.equal(harness.hasRuntimePeer(), true);
    assert.equal(runtimeSocket.closed, false);
    assert.equal(await state.getAlarm(), null, "ignored stale close does not arm stale repair");
  });

  it("does not resurrect a runtime-peer compute summary after attachment clear wins", async () => {
    const state = hibernatedState([]);
    const compute = new FakeOwnerComputeIndexNamespace();
    const room = new NotebookRoom(state.state, roomEnvWithComputeIndex(compute));
    const harness = roomHarness(room);
    const runtimePeer: PeerForTest = {
      id: "runtime",
      socket: new FakeSocket().asCloudflareWebSocket(),
      identity: authenticateDevRequest(
        new Request(
          "https://cloud.test/n/demo/sync?user=runtime&operator=runtime:py&scope=runtime_peer",
        ),
      ),
      connectedAt: "2026-06-07T00:00:00.000Z",
      workstation: {
        workstationId: "ws-lab2",
        displayName: "Lab2 workstation",
        defaultEnvironmentLabel: "Current Python",
        environmentPolicy: "current_python",
        runtimeSessionId: "job-1",
        workingDirectory: "/home/ubuntu/project",
      },
    };

    let currentAttachment: unknown = null;
    let checkpointCalls = 0;
    let resolveFirstCheckpointStarted: () => void = () => undefined;
    const firstCheckpointStarted = new Promise<void>((resolve) => {
      resolveFirstCheckpointStarted = resolve;
    });
    let releaseFirstCheckpoint: () => void = () => undefined;
    const firstCheckpointReleased = new Promise<void>((resolve) => {
      releaseFirstCheckpoint = resolve;
    });
    harness.materializers.set("demo", {
      receiveFrame: async () => noopMaterializedResult(),
      checkpoint: async () => {
        checkpointCalls += 1;
        if (checkpointCalls === 1) {
          resolveFirstCheckpointStarted();
          await firstCheckpointReleased;
        }
      },
      setWorkstationAttachment: async (attachment: unknown) => {
        currentAttachment = attachment;
        return {
          ...noopMaterializedResult(),
          changed: true,
          runtime_state_changed: true,
        };
      },
      getWorkstationAttachment: async () => currentAttachment,
      getRuntimeQueueDepth: async () => 0,
      removePeer: async () => undefined,
    } as never);

    harness.peers.set(runtimePeer.id, runtimePeer);
    const attachPublish = harness.publishRuntimePeerAttachment("demo", runtimePeer);
    await firstCheckpointStarted;

    const response = await room.fetch(
      new Request("https://room.internal/internal/n/demo/workstation-attachment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ attachment: null }),
      }),
    );
    assert.equal(response.status, 200);
    await state.drain();

    releaseFirstCheckpoint();
    await attachPublish;
    await state.drain();

    assert.deepEqual(
      compute.requests.map((request) => new URL(request.url).pathname),
      ["/delete", "/delete"],
      "the delayed runtime-peer publish re-reads the cleared attachment instead of upserting stale compute",
    );
  });

  it("disconnects anonymous viewers when public link access is revoked", async () => {
    const room = new NotebookRoom(fakeState(), {} as Env);
    const harness = roomHarness(room);
    const anonymousSocket = new FakeSocket();
    const signedInViewerSocket = new FakeSocket();
    const ownerSocket = new FakeSocket();
    const anonymousPeer = {
      id: "anonymous-viewer",
      socket: anonymousSocket.asCloudflareWebSocket(),
      identity: authenticateAnonymousViewer(
        new Request("https://cloud.test/n/demo/sync?viewer_session=anon-a"),
      ),
      connectedAt: "2026-06-07T00:00:00.000Z",
    };
    const signedInViewerPeer = {
      id: "signed-in-viewer",
      socket: signedInViewerSocket.asCloudflareWebSocket(),
      identity: authenticateDevRequest(
        new Request("https://cloud.test/n/demo/sync?user=bob&operator=browser:b&scope=viewer"),
      ),
      connectedAt: "2026-06-07T00:00:01.000Z",
    };
    const ownerPeer = {
      id: "owner",
      socket: ownerSocket.asCloudflareWebSocket(),
      identity: authenticateDevRequest(
        new Request("https://cloud.test/n/demo/sync?user=alice&operator=browser:a&scope=owner"),
      ),
      connectedAt: "2026-06-07T00:00:02.000Z",
    };
    harness.peers.set(anonymousPeer.id, anonymousPeer);
    harness.peers.set(signedInViewerPeer.id, signedInViewerPeer);
    harness.peers.set(ownerPeer.id, ownerPeer);
    harness.materializers.set("demo", fakeMaterializer(noopMaterializedResult()));

    const response = await room.fetch(
      new Request("https://room.internal/internal/n/demo/access-revocation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          close_anonymous_viewers: true,
          close_reason: "public link access revoked",
        }),
      }),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      closed_anonymous_viewers: 1,
    });
    assert.equal(anonymousSocket.closed, true);
    assert.equal(anonymousSocket.closeCode, 1008);
    assert.equal(anonymousSocket.closeReason, "public link access revoked");
    assert.equal(signedInViewerSocket.closed, false);
    assert.equal(ownerSocket.closed, false);
    assert.equal(harness.peers.has(anonymousPeer.id), false);
    assert.equal(harness.peers.has(signedInViewerPeer.id), true);
    assert.equal(harness.peers.has(ownerPeer.id), true);
  });

  it("keeps runtime peers when replacement workstation attachment publish fails", async () => {
    const state = alarmCapableState();
    const room = new NotebookRoom(state.state, {} as Env);
    const harness = roomHarness(room);
    const runtimeSocket = new FakeSocket();
    const runtimePeer = {
      id: "runtime",
      socket: runtimeSocket.asCloudflareWebSocket(),
      identity: authenticateDevRequest(
        new Request(
          "https://cloud.test/n/demo/sync?user=runtime&operator=runtime:py&scope=runtime_peer",
        ),
      ),
      connectedAt: "2026-06-07T00:00:00.000Z",
    };
    harness.peers.set(runtimePeer.id, runtimePeer);
    harness.materializers.set("demo", {
      receiveFrame: async () => noopMaterializedResult(),
      checkpoint: async () => undefined,
      removePeer: async () => undefined,
      setWorkstationAttachment: async () => {
        throw new Error("publish failed");
      },
    } as never);

    const response = await room.fetch(
      new Request("https://room.internal/internal/n/demo/workstation-attachment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          close_runtime_peers: true,
          attachment: {
            workstation_id: "ws-lab2",
            display_name: "Lab2 workstation",
            provider: "runtime_peer",
            default_environment_label: "Current Python",
            environment_policy: "current_python",
            status: "connecting",
            status_message: "Waiting for Lab2 to accept the compute request.",
            cpu_count: 8,
            memory_bytes: 16_000_000_000,
            working_directory: "/home/ubuntu/project",
            updated_at: "2026-06-07T00:00:01.000Z",
          },
        }),
      }),
    );

    await state.drain();
    assert.equal(response.status, 500);
    assert.equal(harness.hasRuntimePeer(), true);
    assert.equal(runtimeSocket.closed, false);
    assert.equal(await state.getAlarm(), null);
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
        runtimeSessionId: "job-123",
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

    harness.peers.set(runtimePeer.id, runtimePeer);
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
      accelerators: null,
      working_directory: "/home/ubuntu/codex/nteract",
      runtime_session_id: "job-123",
      updated_at: runtimePeer.connectedAt,
    });
  });

  it("allows only the selected workstation to refresh runtime-peer attachment state", async () => {
    const state = hibernatedState([]);
    const room = new NotebookRoom(state.state, {} as Env);
    const harness = roomHarness(room);
    let attachmentReads = 0;
    harness.materializers.set("demo", {
      receiveFrame: async () => noopMaterializedResult(),
      checkpoint: async () => undefined,
      getWorkstationAttachment: async () => {
        attachmentReads += 1;
        return {
          workstation_id: "lab2",
          display_name: "lab2 workstation",
          provider: "runtime_peer",
          default_environment_label: "Current Python",
          environment_policy: "current_python",
          status: "connecting",
          status_message: "lab2 accepted the request",
          cpu_count: null,
          memory_bytes: null,
          working_directory: "/home/ubuntu/codex/nteract",
          runtime_session_id: "job-123",
          updated_at: "2026-06-07T00:00:00.000Z",
        };
      },
      setWorkstationAttachment: async () => noopMaterializedResult(),
    } as never);

    const matching = await harness.runtimePeerAuthorityError?.("demo", {
      workstationId: "lab2",
      runtimeSessionId: "job-123",
    });
    const staleSession = await harness.runtimePeerAuthorityError?.("demo", {
      workstationId: "lab2",
      runtimeSessionId: "job-456",
    });
    const missingSession = await harness.runtimePeerAuthorityError?.("demo", {
      workstationId: "lab2",
    });
    const mismatched = await harness.runtimePeerAuthorityError?.("demo", {
      workstationId: "other-box",
      runtimeSessionId: "job-123",
    });
    const missing = await harness.runtimePeerAuthorityError?.("demo", null);

    assert.equal(matching, null);
    assert.match(String(staleSession), /does not match selected runtime session job-123/);
    assert.match(String(missingSession), /does not match selected runtime session job-123/);
    assert.match(String(mismatched), /does not match selected workstation lab2/);
    assert.match(String(missing), /runtime-peer does not match selected workstation lab2/);
    assert.equal(
      attachmentReads,
      1,
      "selected runtime session is cached after the first attachment read",
    );
  });

  it("allows only the matching selected runtime session to rejoin after disconnect", async () => {
    const state = hibernatedState([]);
    const room = new NotebookRoom(state.state, {} as Env);
    const harness = roomHarness(room);
    harness.materializers.set("demo", {
      receiveFrame: async () => noopMaterializedResult(),
      checkpoint: async () => undefined,
      getWorkstationAttachment: async () => ({
        workstation_id: "lab2",
        display_name: "lab2 workstation",
        provider: "runtime_peer",
        default_environment_label: "Current Python",
        environment_policy: "current_python",
        status: "disconnected",
        status_message: "compute disconnected: runtime peer left the room",
        cpu_count: null,
        memory_bytes: null,
        working_directory: "/home/ubuntu/codex/nteract",
        runtime_session_id: "job-123",
        updated_at: "2026-06-07T00:00:00.000Z",
      }),
      setWorkstationAttachment: async () => noopMaterializedResult(),
    } as never);

    const matching = await harness.runtimePeerAuthorityError?.("demo", {
      workstationId: "lab2",
      runtimeSessionId: "job-123",
    });
    const staleSession = await harness.runtimePeerAuthorityError?.("demo", {
      workstationId: "lab2",
      runtimeSessionId: "job-456",
    });

    assert.equal(matching, null);
    assert.match(String(staleSession), /does not match selected runtime session job-123/);
  });

  it("rejects runtime-peer upgrades for idle selected sessions", async () => {
    const room = new NotebookRoom(fakeState(), {} as Env);
    const harness = roomHarness(room);
    harness.materializers.set("demo", {
      receiveFrame: async () => noopMaterializedResult(),
      checkpoint: async () => undefined,
      getWorkstationAttachment: async () => ({
        workstation_id: "lab2",
        display_name: "lab2 workstation",
        provider: "runtime_peer",
        default_environment_label: "Current Python",
        environment_policy: "current_python",
        status: "idle",
        status_message: "Compute stopped after 30 minutes without queued or active execution.",
        cpu_count: null,
        memory_bytes: null,
        working_directory: "/home/ubuntu/codex/nteract",
        runtime_session_id: "job-old",
        updated_at: "2026-06-07T00:00:00.000Z",
      }),
    } as never);
    const identity = authenticateDevRequest(
      new Request(
        "https://cloud.test/n/demo/sync?user=runtime&operator=runtime:py&scope=runtime_peer",
      ),
    );
    const response = await room.fetch(
      stampTrustedIdentity(
        new Request("https://cloud.test/n/demo/sync", {
          headers: {
            Upgrade: "websocket",
            "x-nteract-workstation-id": "lab2",
            "x-nteract-runtime-session-id": "job-old",
          },
        }),
        identity,
      ),
    );

    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: "selected runtime session is idle" });
  });

  it("refreshes the selected runtime session cache when a runtime peer publishes", async () => {
    const state = hibernatedState([]);
    const room = new NotebookRoom(state.state, {} as Env);
    const harness = roomHarness(room);
    let attachmentReads = 0;
    let publishedAttachment: unknown;
    harness.materializers.set("demo", {
      receiveFrame: async () => noopMaterializedResult(),
      checkpoint: async () => undefined,
      getWorkstationAttachment: async () => {
        attachmentReads += 1;
        return {
          workstation_id: "lab2",
          display_name: "lab2 workstation",
          provider: "runtime_peer",
          default_environment_label: "Current Python",
          environment_policy: "current_python",
          status: "ready",
          status_message: null,
          cpu_count: null,
          memory_bytes: null,
          working_directory: "/home/ubuntu/codex/nteract",
          runtime_session_id: "old-job",
          updated_at: "2026-06-07T00:00:00.000Z",
        };
      },
      setWorkstationAttachment: async (attachment: unknown) => {
        publishedAttachment = attachment;
        return {
          ...noopMaterializedResult(),
          changed: true,
          runtime_state_changed: true,
        };
      },
    } as never);

    assert.equal(
      await harness.runtimePeerAuthorityError?.("demo", {
        workstationId: "lab2",
        runtimeSessionId: "old-job",
      }),
      null,
    );

    const publishingPeer = {
      id: "runtime",
      socket: new FakeSocket().asCloudflareWebSocket(),
      identity: authenticateDevRequest(
        new Request(
          "https://cloud.test/n/demo/sync?user=runtime&operator=runtime:py&scope=runtime_peer",
        ),
      ),
      connectedAt: "2026-06-07T00:00:01.000Z",
      workstation: {
        workstationId: "lab2",
        runtimeSessionId: "new-job",
        displayName: "lab2",
      },
      consecutiveRejectedFrames: 0,
    };
    harness.peers.set(publishingPeer.id, publishingPeer);
    await harness.publishRuntimePeerAttachment("demo", publishingPeer);

    assert.equal(
      (publishedAttachment as { runtime_session_id?: string }).runtime_session_id,
      "new-job",
    );
    assert.match(
      String(
        await harness.runtimePeerAuthorityError?.("demo", {
          workstationId: "lab2",
          runtimeSessionId: "old-job",
        }),
      ),
      /does not match selected runtime session new-job/,
    );
    assert.equal(
      await harness.runtimePeerAuthorityError?.("demo", {
        workstationId: "lab2",
        runtimeSessionId: "new-job",
      }),
      null,
    );
    assert.equal(attachmentReads, 1, "runtime publish refreshes the cache without rereading");
  });

  it("invalidates the selected runtime session cache after runtime-peer-gone repair", async () => {
    const state = hibernatedState([]);
    const room = new NotebookRoom(state.state, {} as Env);
    const harness = roomHarness(room);
    let attachmentReads = 0;
    let selectedAttachment: Record<string, unknown> = {
      workstation_id: "lab2",
      display_name: "lab2 workstation",
      provider: "runtime_peer",
      default_environment_label: "Current Python",
      environment_policy: "current_python",
      status: "ready",
      status_message: null,
      cpu_count: null,
      memory_bytes: null,
      working_directory: "/home/ubuntu/codex/nteract",
      runtime_session_id: "old-job",
      updated_at: "2026-06-07T00:00:00.000Z",
    };
    harness.materializers.set("demo", {
      receiveFrame: async () => noopMaterializedResult(),
      checkpoint: async () => undefined,
      getWorkstationAttachment: async () => {
        attachmentReads += 1;
        return selectedAttachment;
      },
      reconcileRuntimePeerGone: async () => {
        selectedAttachment = {
          ...selectedAttachment,
          status: "error",
          status_message: "runtime peer left",
          runtime_session_id: "new-job",
        };
        return {
          ...noopMaterializedResult(),
          changed: true,
          runtime_state_changed: true,
        };
      },
    } as never);

    assert.equal(
      await harness.runtimePeerAuthorityError?.("demo", {
        workstationId: "lab2",
        runtimeSessionId: "old-job",
      }),
      null,
    );
    assert.equal(attachmentReads, 1);

    const response = await room.fetch(
      new Request("https://room.internal/internal/n/demo/runtime-state-repair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "test repair" }),
      }),
    );
    assert.equal(response.status, 200);

    assert.match(
      String(
        await harness.runtimePeerAuthorityError?.("demo", {
          workstationId: "lab2",
          runtimeSessionId: "old-job",
        }),
      ),
      /does not match selected runtime session new-job/,
    );
    assert.equal(
      await harness.runtimePeerAuthorityError?.("demo", {
        workstationId: "lab2",
        runtimeSessionId: "new-job",
      }),
      null,
    );
    assert.equal(
      attachmentReads,
      2,
      "runtime-state repair invalidates the selected session cache for one fresh read",
    );
  });
});

describe("NotebookRoom materialized sync routing", () => {
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
    harness.materializers.set("demo", fakeMaterializer(noopMaterializedResult()));

    await harness.handleMessage(
      "demo",
      peer,
      encodeTypedFrame(FrameType.AUTOMERGE_SYNC, new Uint8Array()),
    );

    assert.equal(socket.sent.length, 1);
    assert.equal(
      decodeJsonPayload<Record<string, unknown>>(socket.sent[0].slice(1)).type,
      "cloud_frame_accepted",
    );
  });

  it("acknowledges changed materialized sync frames without persisted room history", async () => {
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
    let checkpointed = 0;
    harness.materializers.set("demo", {
      receiveFrame: async () => ({
        ...noopMaterializedResult(),
        changed: true,
        notebook_changed: true,
      }),
      checkpoint: async () => {
        checkpointed += 1;
      },
      removePeer: async () => undefined,
    });

    await harness.handleMessage(
      "demo",
      peer,
      encodeTypedFrame(FrameType.AUTOMERGE_SYNC, new Uint8Array([1])),
    );

    assert.equal(checkpointed, 1);
    assert.equal(socket.sent.length, 1);
    assert.equal(
      decodeJsonPayload<Record<string, unknown>>(socket.sent[0].slice(1)).type,
      "cloud_frame_accepted",
    );
  });

  it("republishes compute summary when execution changes queue depth", async () => {
    const state = hibernatedState([]);
    const compute = new FakeOwnerComputeIndexNamespace();
    const room = new NotebookRoom(state.state, roomEnvWithComputeIndex(compute));
    const harness = roomHarness(room);
    const ownerSocket = new FakeSocket();
    const ownerPeer: PeerForTest = {
      id: "owner",
      socket: ownerSocket.asCloudflareWebSocket(),
      identity: authenticateDevRequest(
        new Request("https://cloud.test/n/demo/sync?user=alice&operator=browser:a&scope=owner"),
      ),
      connectedAt: "2026-05-22T00:00:00.000Z",
    };
    const runtimePeer: PeerForTest = {
      id: "runtime",
      socket: new FakeSocket().asCloudflareWebSocket(),
      identity: authenticateDevRequest(
        new Request(
          "https://cloud.test/n/demo/sync?user=runtime&operator=runtime:py&scope=runtime_peer",
        ),
      ),
      connectedAt: "2026-05-22T00:00:01.000Z",
      workstation: {
        workstationId: "ws-lab2",
        runtimeSessionId: "job-1",
      },
    };
    harness.peers.set(ownerPeer.id, ownerPeer);
    harness.peers.set(runtimePeer.id, runtimePeer);

    let queueDepth = 0;
    harness.materializers.set("demo", {
      receiveFrame: async () => {
        queueDepth = 1;
        return {
          ...noopMaterializedResult(),
          changed: true,
          runtime_state_changed: true,
        };
      },
      checkpoint: async () => undefined,
      getWorkstationAttachment: async () => ({
        workstation_id: "ws-lab2",
        display_name: "lab2 workstation",
        provider: "runtime_peer",
        default_environment_label: "Current Python",
        environment_policy: "current_python",
        status: "ready",
        status_message: null,
        cpu_count: null,
        memory_bytes: null,
        working_directory: "/home/ubuntu/project",
        updated_at: "2026-06-23T00:00:00.000Z",
        runtime_session_id: "job-1",
      }),
      getRuntimeQueueDepth: async () => queueDepth,
      removePeer: async () => undefined,
    } as never);

    await harness.handleMessage(
      "demo",
      ownerPeer,
      encodeTypedFrame(
        FrameType.REQUEST,
        new TextEncoder().encode(
          JSON.stringify({ id: "request-1", action: "execute_cell", cell_id: "cell-1" }),
        ),
      ),
    );
    await state.drain();

    assert.equal(compute.requests.length, 1);
    assert.equal(compute.requests[0]?.body?.summary?.status, "active");
    assert.equal(compute.requests[0]?.body?.summary?.queue_depth, 1);
    assert.equal(compute.requests[0]?.body?.summary?.runtime_peer_count, 1);

    await harness.handleMessage(
      "demo",
      runtimePeer,
      encodeTypedFrame(FrameType.RUNTIME_STATE_SYNC, new Uint8Array([1])),
    );
    await state.drain();

    assert.equal(
      compute.requests.length,
      1,
      "runtime-state churn at the same queue depth does not rewrite the owner compute index",
    );
  });

  it("coalesces same-depth compute summary publishes while an index write is pending", async () => {
    const state = hibernatedState([]);
    const compute = new BlockingOwnerComputeIndexNamespace();
    const room = new NotebookRoom(state.state, roomEnvWithComputeIndex(compute));
    const harness = roomHarness(room);
    const ownerSocket = new FakeSocket();
    const ownerPeer: PeerForTest = {
      id: "owner",
      socket: ownerSocket.asCloudflareWebSocket(),
      identity: authenticateDevRequest(
        new Request("https://cloud.test/n/demo/sync?user=alice&operator=browser:a&scope=owner"),
      ),
      connectedAt: "2026-05-22T00:00:00.000Z",
    };
    const runtimePeer: PeerForTest = {
      id: "runtime",
      socket: new FakeSocket().asCloudflareWebSocket(),
      identity: authenticateDevRequest(
        new Request(
          "https://cloud.test/n/demo/sync?user=runtime&operator=runtime:py&scope=runtime_peer",
        ),
      ),
      connectedAt: "2026-05-22T00:00:01.000Z",
      workstation: {
        workstationId: "ws-lab2",
        runtimeSessionId: "job-1",
      },
    };
    harness.peers.set(ownerPeer.id, ownerPeer);
    harness.peers.set(runtimePeer.id, runtimePeer);

    let queueDepth = 0;
    harness.materializers.set("demo", {
      receiveFrame: async () => {
        queueDepth = 1;
        return {
          ...noopMaterializedResult(),
          changed: true,
          runtime_state_changed: true,
        };
      },
      checkpoint: async () => undefined,
      getWorkstationAttachment: async () => ({
        workstation_id: "ws-lab2",
        display_name: "lab2 workstation",
        provider: "runtime_peer",
        default_environment_label: "Current Python",
        environment_policy: "current_python",
        status: "ready",
        status_message: null,
        cpu_count: null,
        memory_bytes: null,
        working_directory: "/home/ubuntu/project",
        updated_at: "2026-06-23T00:00:00.000Z",
        runtime_session_id: "job-1",
      }),
      getRuntimeQueueDepth: async () => queueDepth,
      removePeer: async () => undefined,
    } as never);

    await harness.handleMessage(
      "demo",
      ownerPeer,
      encodeTypedFrame(
        FrameType.REQUEST,
        new TextEncoder().encode(
          JSON.stringify({ id: "request-1", action: "execute_cell", cell_id: "cell-1" }),
        ),
      ),
    );
    await compute.firstStarted;
    assert.equal(compute.requests.length, 1);

    await harness.handleMessage(
      "demo",
      runtimePeer,
      encodeTypedFrame(FrameType.RUNTIME_STATE_SYNC, new Uint8Array([1])),
    );
    assert.equal(
      compute.requests.length,
      1,
      "same-depth runtime-state churn is serialized behind the in-flight publish",
    );

    compute.releaseFirst();
    await state.drain();
    assert.equal(
      compute.requests.length,
      1,
      "same-depth runtime-state churn does not write the owner compute index after coalescing",
    );
  });

  it("retries same-depth compute summary after owner index write failure", async () => {
    const state = hibernatedState([]);
    const compute = new FailingFirstOwnerComputeIndexNamespace();
    const room = new NotebookRoom(state.state, roomEnvWithComputeIndex(compute));
    const harness = roomHarness(room);
    const ownerPeer: PeerForTest = {
      id: "owner",
      socket: new FakeSocket().asCloudflareWebSocket(),
      identity: authenticateDevRequest(
        new Request("https://cloud.test/n/demo/sync?user=alice&operator=browser:a&scope=owner"),
      ),
      connectedAt: "2026-05-22T00:00:00.000Z",
    };
    const runtimePeer: PeerForTest = {
      id: "runtime",
      socket: new FakeSocket().asCloudflareWebSocket(),
      identity: authenticateDevRequest(
        new Request(
          "https://cloud.test/n/demo/sync?user=runtime&operator=runtime:py&scope=runtime_peer",
        ),
      ),
      connectedAt: "2026-05-22T00:00:01.000Z",
      workstation: {
        workstationId: "ws-lab2",
        runtimeSessionId: "job-1",
      },
    };
    harness.peers.set(ownerPeer.id, ownerPeer);
    harness.peers.set(runtimePeer.id, runtimePeer);

    let queueDepth = 0;
    harness.materializers.set("demo", {
      receiveFrame: async () => {
        queueDepth = 1;
        return {
          ...noopMaterializedResult(),
          changed: true,
          runtime_state_changed: true,
        };
      },
      checkpoint: async () => undefined,
      getWorkstationAttachment: async () => ({
        workstation_id: "ws-lab2",
        display_name: "lab2 workstation",
        provider: "runtime_peer",
        default_environment_label: "Current Python",
        environment_policy: "current_python",
        status: "ready",
        status_message: null,
        cpu_count: null,
        memory_bytes: null,
        working_directory: "/home/ubuntu/project",
        updated_at: "2026-06-23T00:00:00.000Z",
        runtime_session_id: "job-1",
      }),
      getRuntimeQueueDepth: async () => queueDepth,
      removePeer: async () => undefined,
    } as never);

    await harness.handleMessage(
      "demo",
      ownerPeer,
      encodeTypedFrame(
        FrameType.REQUEST,
        new TextEncoder().encode(
          JSON.stringify({ id: "request-1", action: "execute_cell", cell_id: "cell-1" }),
        ),
      ),
    );
    await state.drain();
    assert.equal(compute.requests.length, 1);

    await harness.handleMessage(
      "demo",
      runtimePeer,
      encodeTypedFrame(FrameType.RUNTIME_STATE_SYNC, new Uint8Array([1])),
    );
    await state.drain();

    assert.equal(
      compute.requests.length,
      2,
      "failed owner-index writes do not mark the queue depth as published",
    );
    assert.equal(compute.requests[1]?.body?.summary?.queue_depth, 1);
  });

  it("skips D1 and owner-index work for clean same-depth runtime-state churn", async () => {
    const state = hibernatedState([]);
    const compute = new FakeOwnerComputeIndexNamespace();
    const db = new CountingNotebookOwnerD1();
    const room = new NotebookRoom(state.state, roomEnvWithComputeIndex(compute, db));
    const harness = roomHarness(room);
    const ownerPeer: PeerForTest = {
      id: "owner",
      socket: new FakeSocket().asCloudflareWebSocket(),
      identity: authenticateDevRequest(
        new Request("https://cloud.test/n/demo/sync?user=alice&operator=browser:a&scope=owner"),
      ),
      connectedAt: "2026-05-22T00:00:00.000Z",
    };
    const runtimePeer: PeerForTest = {
      id: "runtime",
      socket: new FakeSocket().asCloudflareWebSocket(),
      identity: authenticateDevRequest(
        new Request(
          "https://cloud.test/n/demo/sync?user=runtime&operator=runtime:py&scope=runtime_peer",
        ),
      ),
      connectedAt: "2026-05-22T00:00:01.000Z",
      workstation: {
        workstationId: "ws-lab2",
        runtimeSessionId: "job-1",
      },
    };
    harness.peers.set(ownerPeer.id, ownerPeer);
    harness.peers.set(runtimePeer.id, runtimePeer);

    let queueDepth = 0;
    harness.materializers.set("demo", {
      receiveFrame: async () => {
        queueDepth = 1;
        return {
          ...noopMaterializedResult(),
          changed: true,
          runtime_state_changed: true,
        };
      },
      checkpoint: async () => undefined,
      getWorkstationAttachment: async () => ({
        workstation_id: "ws-lab2",
        display_name: "lab2 workstation",
        provider: "runtime_peer",
        default_environment_label: "Current Python",
        environment_policy: "current_python",
        status: "ready",
        status_message: null,
        cpu_count: null,
        memory_bytes: null,
        working_directory: "/home/ubuntu/project",
        updated_at: "2026-06-23T00:00:00.000Z",
        runtime_session_id: "job-1",
      }),
      getRuntimeQueueDepth: async () => queueDepth,
      removePeer: async () => undefined,
    } as never);

    await harness.handleMessage(
      "demo",
      ownerPeer,
      encodeTypedFrame(
        FrameType.REQUEST,
        new TextEncoder().encode(
          JSON.stringify({ id: "request-1", action: "execute_cell", cell_id: "cell-1" }),
        ),
      ),
    );
    await state.drain();
    assert.equal(compute.requests.length, 1);
    assert.equal(db.notebookLookupCount, 1);

    db.notebookLookupCount = 0;
    await harness.handleMessage(
      "demo",
      runtimePeer,
      encodeTypedFrame(FrameType.RUNTIME_STATE_SYNC, new Uint8Array([1])),
    );
    await state.drain();

    assert.equal(compute.requests.length, 1);
    assert.equal(
      db.notebookLookupCount,
      0,
      "same-depth runtime-state churn returns before D1 notebook lookup",
    );
  });

  it("skips D1 and owner-index delete work after clean same-depth no-summary publish", async () => {
    const state = hibernatedState([]);
    const compute = new FakeOwnerComputeIndexNamespace();
    const db = new CountingNotebookOwnerD1();
    const room = new NotebookRoom(state.state, roomEnvWithComputeIndex(compute, db));
    const harness = roomHarness(room);
    const runtimePeer: PeerForTest = {
      id: "runtime",
      socket: new FakeSocket().asCloudflareWebSocket(),
      identity: authenticateDevRequest(
        new Request(
          "https://cloud.test/n/demo/sync?user=runtime&operator=runtime:py&scope=runtime_peer",
        ),
      ),
      connectedAt: "2026-05-22T00:00:01.000Z",
      workstation: {
        workstationId: "ws-lab2",
        runtimeSessionId: "job-1",
      },
    };
    harness.peers.set(runtimePeer.id, runtimePeer);

    harness.materializers.set("demo", {
      receiveFrame: async () => ({
        ...noopMaterializedResult(),
        changed: true,
        runtime_state_changed: true,
      }),
      checkpoint: async () => undefined,
      getWorkstationAttachment: async () => null,
      getRuntimeQueueDepth: async () => 0,
      removePeer: async () => undefined,
    } as never);

    await harness.handleMessage(
      "demo",
      runtimePeer,
      encodeTypedFrame(FrameType.RUNTIME_STATE_SYNC, new Uint8Array([1])),
    );
    await state.drain();
    assert.equal(compute.requests.length, 1);
    assert.match(compute.requests[0]?.url ?? "", /\/delete$/);
    assert.equal(db.notebookLookupCount, 1);

    db.notebookLookupCount = 0;
    await harness.handleMessage(
      "demo",
      runtimePeer,
      encodeTypedFrame(FrameType.RUNTIME_STATE_SYNC, new Uint8Array([1])),
    );
    await state.drain();

    assert.equal(compute.requests.length, 1);
    assert.equal(
      db.notebookLookupCount,
      0,
      "same-depth no-summary churn returns before D1 notebook lookup",
    );
  });

  it("retries same-depth dirty summary after failed active update", async () => {
    const state = hibernatedState([]);
    const compute = new FailingNumberedOwnerComputeIndexNamespace(2);
    const room = new NotebookRoom(state.state, roomEnvWithComputeIndex(compute));
    const harness = roomHarness(room);
    const runtimePeer: PeerForTest = {
      id: "runtime",
      socket: new FakeSocket().asCloudflareWebSocket(),
      identity: authenticateDevRequest(
        new Request(
          "https://cloud.test/n/demo/sync?user=runtime&operator=runtime:py&scope=runtime_peer",
        ),
      ),
      connectedAt: "2026-05-22T00:00:01.000Z",
      workstation: {
        workstationId: "ws-lab2",
        runtimeSessionId: "job-1",
      },
    };
    let currentAttachment: unknown = {
      workstation_id: "ws-lab2",
      display_name: "lab2 workstation",
      provider: "runtime_peer",
      default_environment_label: "Current Python",
      environment_policy: "current_python",
      status: "connecting",
      status_message: "Waiting for lab2.",
      cpu_count: null,
      memory_bytes: null,
      working_directory: "/home/ubuntu/project",
      updated_at: "2026-06-23T00:00:00.000Z",
      runtime_session_id: "job-1",
    };
    harness.materializers.set("demo", {
      receiveFrame: async () => ({
        ...noopMaterializedResult(),
        changed: true,
        runtime_state_changed: true,
      }),
      checkpoint: async () => undefined,
      getWorkstationAttachment: async () => currentAttachment,
      getRuntimeQueueDepth: async () => 0,
      setWorkstationAttachment: async (attachment: unknown) => {
        currentAttachment = attachment;
        return {
          ...noopMaterializedResult(),
          changed: true,
          runtime_state_changed: true,
        };
      },
      removePeer: async () => undefined,
    } as never);

    const response = await room.fetch(
      new Request("https://room.internal/internal/n/demo/workstation-attachment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ attachment: currentAttachment }),
      }),
    );
    assert.equal(response.status, 200);
    await state.drain();
    assert.equal(compute.requests[0]?.body?.summary?.status, "starting");

    harness.peers.set(runtimePeer.id, runtimePeer);
    await harness.publishRuntimePeerAttachment("demo", runtimePeer);
    assert.equal(compute.requests[1]?.body?.summary?.status, "active");

    await harness.handleMessage(
      "demo",
      runtimePeer,
      encodeTypedFrame(FrameType.RUNTIME_STATE_SYNC, new Uint8Array([1])),
    );
    await state.drain();

    assert.equal(
      compute.requests.length,
      3,
      "failed same-depth active update leaves the summary dirty for retry",
    );
    assert.equal(compute.requests[2]?.body?.summary?.status, "active");
    assert.equal(compute.requests[2]?.body?.summary?.queue_depth, 0);
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

    await harness.handleMessage(
      "demo",
      editorPeer,
      encodeTypedFrame(FrameType.AUTOMERGE_SYNC, new Uint8Array([1])),
    );

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

    await harness.handleMessage(
      "demo",
      peer,
      encodeTypedFrame(FrameType.PUT_BLOB, new Uint8Array([1, 2, 3])),
    );

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
    harness.peers.set("runtime", {
      ...peer,
      id: "runtime",
      identity: authenticateDevRequest(
        new Request(
          "https://cloud.test/n/demo/sync?user=alice&operator=runtime:py&scope=runtime_peer",
        ),
      ),
    });
    let materialized = 0;
    harness.materializers.set("demo", {
      receiveFrame: async () => {
        materialized += 1;
        return noopMaterializedResult();
      },
      checkpoint: async () => undefined,
    });

    harness.peers.set(peer.id, peer);
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
    assert.equal(socket.sent.length, 1);
    const accepted = decodeJsonPayload<Record<string, unknown>>(socket.sent[0].slice(1));
    assert.equal(accepted.type, "cloud_frame_accepted");
  });

  it("forwards owner runtime-agent command REQUEST frames to attached runtime peers", async () => {
    const room = new NotebookRoom(fakeState(), {} as Env);
    const ownerIdentity = authenticateDevRequest(
      new Request("https://cloud.test/n/demo/sync?user=alice&operator=browser:a&scope=owner"),
    );
    const runtimeIdentity = authenticateDevRequest(
      new Request(
        "https://cloud.test/n/demo/sync?user=runtime&operator=runtime:py&scope=runtime_peer",
      ),
    );
    const ownerSocket = new FakeSocket();
    const runtimeSocket = new FakeSocket();
    const ownerPeer = {
      id: "owner",
      socket: ownerSocket.asCloudflareWebSocket(),
      identity: ownerIdentity,
      connectedAt: "2026-05-22T00:00:00.000Z",
      consecutiveRejectedFrames: 0,
    };
    const runtimePeer = {
      id: "runtime",
      socket: runtimeSocket.asCloudflareWebSocket(),
      identity: runtimeIdentity,
      connectedAt: "2026-05-22T00:00:00.000Z",
      consecutiveRejectedFrames: 0,
    };
    const harness = roomHarness(room);
    let materialized = 0;
    harness.peers.set(ownerPeer.id, ownerPeer);
    harness.peers.set(runtimePeer.id, runtimePeer);
    harness.materializers.set("demo", {
      receiveFrame: async () => {
        materialized += 1;
        return noopMaterializedResult();
      },
      checkpoint: async () => undefined,
      removePeer: async () => undefined,
    });
    const actions = ["interrupt_execution", "send_comm"] as const;
    for (const action of actions) {
      const envelope =
        action === "send_comm"
          ? {
              id: `request-${action}`,
              action,
              message: {
                header: { msg_type: "comm_msg" },
                metadata: {},
                content: {},
                buffers: [],
                channel: "shell",
              },
            }
          : { id: `request-${action}`, action };
      const requestPayload = new TextEncoder().encode(JSON.stringify(envelope));

      await harness.handleMessage(
        "demo",
        ownerPeer,
        encodeTypedFrame(FrameType.REQUEST, requestPayload),
      );

      assert.equal(runtimeSocket.sent.length, actions.indexOf(action) + 1);
      assert.deepEqual(
        [...runtimeSocket.sent.at(-1)!],
        [FrameType.REQUEST, ...Array.from(requestPayload)],
      );
      assert.equal(ownerSocket.sent.length, actions.indexOf(action) + 1);
      const accepted = decodeJsonPayload<Record<string, unknown>>(
        ownerSocket.sent.at(-1)!.slice(1),
      );
      assert.equal(accepted.type, "cloud_frame_accepted");
    }

    assert.equal(materialized, 0);
  });

  it("forwards runtime-agent command REQUEST frames only to the newest runtime peer", async () => {
    const room = new NotebookRoom(fakeState(), {} as Env);
    const ownerIdentity = authenticateDevRequest(
      new Request("https://cloud.test/n/demo/sync?user=alice&operator=browser:a&scope=owner"),
    );
    const oldRuntimeIdentity = authenticateDevRequest(
      new Request(
        "https://cloud.test/n/demo/sync?user=runtime&operator=runtime:old&scope=runtime_peer",
      ),
    );
    const newRuntimeIdentity = authenticateDevRequest(
      new Request(
        "https://cloud.test/n/demo/sync?user=runtime&operator=runtime:new&scope=runtime_peer",
      ),
    );
    const ownerSocket = new FakeSocket();
    const oldRuntimeSocket = new FakeSocket();
    const newRuntimeSocket = new FakeSocket();
    const ownerPeer = {
      id: "owner",
      socket: ownerSocket.asCloudflareWebSocket(),
      identity: ownerIdentity,
      connectedAt: "2026-05-22T00:00:00.000Z",
      consecutiveRejectedFrames: 0,
    };
    const oldRuntimePeer = {
      id: "runtime-old",
      socket: oldRuntimeSocket.asCloudflareWebSocket(),
      identity: oldRuntimeIdentity,
      connectedAt: "2026-05-22T00:00:00.000Z",
      consecutiveRejectedFrames: 0,
    };
    const newRuntimePeer = {
      id: "runtime-new",
      socket: newRuntimeSocket.asCloudflareWebSocket(),
      identity: newRuntimeIdentity,
      connectedAt: "2026-05-22T00:00:01.000Z",
      consecutiveRejectedFrames: 0,
    };
    const harness = roomHarness(room);
    harness.peers.set(ownerPeer.id, ownerPeer);
    harness.peers.set(oldRuntimePeer.id, oldRuntimePeer);
    harness.peers.set(newRuntimePeer.id, newRuntimePeer);
    harness.materializers.set("demo", fakeMaterializer(noopMaterializedResult()));
    const requestPayload = new TextEncoder().encode(
      JSON.stringify({ id: "request-1", action: "interrupt_execution" }),
    );

    await harness.handleMessage(
      "demo",
      ownerPeer,
      encodeTypedFrame(FrameType.REQUEST, requestPayload),
    );

    assert.equal(oldRuntimeSocket.sent.length, 0);
    assert.equal(newRuntimeSocket.sent.length, 1);
    assert.deepEqual(
      [...newRuntimeSocket.sent[0]],
      [FrameType.REQUEST, ...Array.from(requestPayload)],
    );
  });

  it("forwards runtime-agent command REQUEST frames only to the selected runtime session", async () => {
    const room = new NotebookRoom(fakeState(), {} as Env);
    const ownerIdentity = authenticateDevRequest(
      new Request("https://cloud.test/n/demo/sync?user=alice&operator=browser:a&scope=owner"),
    );
    const selectedRuntimeIdentity = authenticateDevRequest(
      new Request(
        "https://cloud.test/n/demo/sync?user=runtime&operator=runtime:selected&scope=runtime_peer",
      ),
    );
    const staleRuntimeIdentity = authenticateDevRequest(
      new Request(
        "https://cloud.test/n/demo/sync?user=runtime&operator=runtime:stale&scope=runtime_peer",
      ),
    );
    const ownerSocket = new FakeSocket();
    const selectedRuntimeSocket = new FakeSocket();
    const staleRuntimeSocket = new FakeSocket();
    const ownerPeer = {
      id: "owner",
      socket: ownerSocket.asCloudflareWebSocket(),
      identity: ownerIdentity,
      connectedAt: "2026-05-22T00:00:00.000Z",
      consecutiveRejectedFrames: 0,
    };
    const selectedRuntimePeer = {
      id: "runtime-selected",
      socket: selectedRuntimeSocket.asCloudflareWebSocket(),
      identity: selectedRuntimeIdentity,
      connectedAt: "2026-05-22T00:00:01.000Z",
      workstation: { workstationId: "ws-lab2", runtimeSessionId: "job-selected" },
      consecutiveRejectedFrames: 0,
    };
    const staleRuntimePeer = {
      id: "runtime-stale",
      socket: staleRuntimeSocket.asCloudflareWebSocket(),
      identity: staleRuntimeIdentity,
      connectedAt: "2026-05-22T00:00:02.000Z",
      workstation: { workstationId: "ws-lab2", runtimeSessionId: "job-stale" },
      consecutiveRejectedFrames: 0,
    };
    const harness = roomHarness(room);
    harness.peers.set(ownerPeer.id, ownerPeer);
    harness.peers.set(selectedRuntimePeer.id, selectedRuntimePeer);
    harness.peers.set(staleRuntimePeer.id, staleRuntimePeer);
    harness.materializers.set("demo", {
      receiveFrame: async () => noopMaterializedResult(),
      checkpoint: async () => undefined,
      removePeer: async () => undefined,
      getWorkstationAttachment: async () => ({
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
        runtime_session_id: "job-selected",
        updated_at: "2026-06-07T00:00:00.000Z",
      }),
    });
    const requestPayload = new TextEncoder().encode(
      JSON.stringify({ id: "request-1", action: "interrupt_execution" }),
    );

    await harness.handleMessage(
      "demo",
      ownerPeer,
      encodeTypedFrame(FrameType.REQUEST, requestPayload),
    );

    assert.equal(staleRuntimeSocket.sent.length, 0);
    assert.equal(selectedRuntimeSocket.sent.length, 1);
    assert.deepEqual(
      [...selectedRuntimeSocket.sent[0]],
      [FrameType.REQUEST, ...Array.from(requestPayload)],
    );
    assert.equal(ownerSocket.sent.length, 1);
    const accepted = decodeJsonPayload<Record<string, unknown>>(ownerSocket.sent[0].slice(1));
    assert.equal(accepted.type, "cloud_frame_accepted");
  });

  it("replaces duplicate runtime peers for the same workstation only", () => {
    const room = new NotebookRoom(fakeState(), {} as Env);
    const sameWorkstationIdentity = authenticateDevRequest(
      new Request(
        "https://cloud.test/n/demo/sync?user=runtime&operator=runtime:old&scope=runtime_peer",
      ),
    );
    const otherWorkstationIdentity = authenticateDevRequest(
      new Request(
        "https://cloud.test/n/demo/sync?user=runtime&operator=runtime:other&scope=runtime_peer",
      ),
    );
    const incomingIdentity = authenticateDevRequest(
      new Request(
        "https://cloud.test/n/demo/sync?user=runtime&operator=runtime:new&scope=runtime_peer",
      ),
    );
    const sameWorkstationSocket = new FakeSocket();
    const otherWorkstationSocket = new FakeSocket();
    const incomingSocket = new FakeSocket();
    const sameWorkstationPeer = {
      id: "runtime-old",
      socket: sameWorkstationSocket.asCloudflareWebSocket(),
      identity: sameWorkstationIdentity,
      connectedAt: "2026-05-22T00:00:00.000Z",
      workstation: { workstationId: "ws-lab2" },
      consecutiveRejectedFrames: 0,
    };
    const otherWorkstationPeer = {
      id: "runtime-other",
      socket: otherWorkstationSocket.asCloudflareWebSocket(),
      identity: otherWorkstationIdentity,
      connectedAt: "2026-05-22T00:00:00.000Z",
      workstation: { workstationId: "ws-other" },
      consecutiveRejectedFrames: 0,
    };
    const incomingPeer = {
      id: "runtime-new",
      socket: incomingSocket.asCloudflareWebSocket(),
      identity: incomingIdentity,
      connectedAt: "2026-05-22T00:00:01.000Z",
      workstation: { workstationId: "ws-lab2" },
      consecutiveRejectedFrames: 0,
    };
    const harness = roomHarness(room);
    harness.peers.set(sameWorkstationPeer.id, sameWorkstationPeer);
    harness.peers.set(otherWorkstationPeer.id, otherWorkstationPeer);
    harness.materializers.set("demo", fakeMaterializer(noopMaterializedResult()));

    harness.removeDuplicateRuntimePeers?.("demo", incomingPeer);

    assert.equal(harness.peers.has(sameWorkstationPeer.id), false);
    assert.equal(sameWorkstationSocket.closed, true);
    assert.equal(sameWorkstationSocket.closeCode, 1008);
    assert.equal(sameWorkstationSocket.closeReason, "replaced by newer runtime peer");
    assert.equal(harness.peers.has(otherWorkstationPeer.id), true);
    assert.equal(otherWorkstationSocket.closed, false);
  });

  it("breaks equal runtime-peer timestamps in favor of the later connection", async () => {
    const room = new NotebookRoom(fakeState(), {} as Env);
    const ownerIdentity = authenticateDevRequest(
      new Request("https://cloud.test/n/demo/sync?user=alice&operator=browser:a&scope=owner"),
    );
    const oldRuntimeIdentity = authenticateDevRequest(
      new Request(
        "https://cloud.test/n/demo/sync?user=runtime&operator=runtime:old&scope=runtime_peer",
      ),
    );
    const newRuntimeIdentity = authenticateDevRequest(
      new Request(
        "https://cloud.test/n/demo/sync?user=runtime&operator=runtime:new&scope=runtime_peer",
      ),
    );
    const ownerSocket = new FakeSocket();
    const oldRuntimeSocket = new FakeSocket();
    const newRuntimeSocket = new FakeSocket();
    const connectedAt = "2026-05-22T00:00:00.000Z";
    const ownerPeer = {
      id: "owner",
      socket: ownerSocket.asCloudflareWebSocket(),
      identity: ownerIdentity,
      connectedAt,
      consecutiveRejectedFrames: 0,
    };
    const oldRuntimePeer = {
      id: "runtime-old",
      socket: oldRuntimeSocket.asCloudflareWebSocket(),
      identity: oldRuntimeIdentity,
      connectedAt,
      consecutiveRejectedFrames: 0,
    };
    const newRuntimePeer = {
      id: "runtime-new",
      socket: newRuntimeSocket.asCloudflareWebSocket(),
      identity: newRuntimeIdentity,
      connectedAt,
      consecutiveRejectedFrames: 0,
    };
    const harness = roomHarness(room);
    harness.peers.set(ownerPeer.id, ownerPeer);
    harness.peers.set(oldRuntimePeer.id, oldRuntimePeer);
    harness.peers.set(newRuntimePeer.id, newRuntimePeer);
    harness.materializers.set("demo", fakeMaterializer(noopMaterializedResult()));
    const requestPayload = new TextEncoder().encode(
      JSON.stringify({ id: "request-1", action: "interrupt_execution" }),
    );

    await harness.handleMessage(
      "demo",
      ownerPeer,
      encodeTypedFrame(FrameType.REQUEST, requestPayload),
    );

    assert.equal(oldRuntimeSocket.sent.length, 0);
    assert.equal(newRuntimeSocket.sent.length, 1);
    assert.deepEqual(
      [...newRuntimeSocket.sent[0]],
      [FrameType.REQUEST, ...Array.from(requestPayload)],
    );
  });

  it("routes hosted completion REQUEST frames through the active runtime peer response", async () => {
    const room = new NotebookRoom(fakeState(), {} as Env);
    const ownerIdentity = authenticateDevRequest(
      new Request("https://cloud.test/n/demo/sync?user=alice&operator=browser:a&scope=owner"),
    );
    const runtimeIdentity = authenticateDevRequest(
      new Request(
        "https://cloud.test/n/demo/sync?user=runtime&operator=runtime:new&scope=runtime_peer",
      ),
    );
    const ownerSocket = new FakeSocket();
    const runtimeSocket = new FakeSocket();
    const ownerPeer = {
      id: "owner",
      socket: ownerSocket.asCloudflareWebSocket(),
      identity: ownerIdentity,
      connectedAt: "2026-05-22T00:00:00.000Z",
      workstation: null,
      consecutiveRejectedFrames: 0,
    };
    const runtimePeer = {
      id: "runtime",
      socket: runtimeSocket.asCloudflareWebSocket(),
      identity: runtimeIdentity,
      connectedAt: "2026-05-22T00:00:01.000Z",
      workstation: null,
      consecutiveRejectedFrames: 0,
    };
    const harness = roomHarness(room);
    let materialized = 0;
    harness.peers.set(ownerPeer.id, ownerPeer);
    harness.peers.set(runtimePeer.id, runtimePeer);
    harness.materializers.set("demo", {
      receiveFrame: async () => {
        materialized += 1;
        return noopMaterializedResult();
      },
      checkpoint: async () => undefined,
      removePeer: async () => undefined,
    });
    const requestPayload = new TextEncoder().encode(
      JSON.stringify({ id: "request-1", action: "complete", code: "pri", cursor_pos: 3 }),
    );

    await harness.handleMessage(
      "demo",
      ownerPeer,
      encodeTypedFrame(FrameType.REQUEST, requestPayload),
    );

    assert.equal(runtimeSocket.sent.length, 1);
    assert.deepEqual(
      [...runtimeSocket.sent[0]],
      [FrameType.REQUEST, ...Array.from(requestPayload)],
    );
    assert.equal(ownerSocket.sent.length, 1);
    assert.equal(
      decodeJsonPayload<Record<string, unknown>>(ownerSocket.sent[0].slice(1)).type,
      "cloud_frame_accepted",
    );

    const responsePayload = new TextEncoder().encode(
      JSON.stringify({
        id: "request-1",
        result: "completion_result",
        items: [{ label: "print", kind: "function" }],
        cursor_start: 0,
        cursor_end: 3,
      }),
    );
    await harness.handleMessage(
      "demo",
      runtimePeer,
      encodeTypedFrame(FrameType.RESPONSE, responsePayload),
    );

    assert.equal(ownerSocket.sent.length, 2);
    assert.deepEqual(
      [...ownerSocket.sent[1]],
      [FrameType.RESPONSE, ...Array.from(responsePayload)],
    );
    assert.equal(materialized, 0);
  });

  it("rejects late hosted completion responses from replaced runtime sessions", async () => {
    const room = new NotebookRoom(fakeState(), {} as Env);
    const ownerIdentity = authenticateDevRequest(
      new Request("https://cloud.test/n/demo/sync?user=alice&operator=browser:a&scope=owner"),
    );
    const selectedRuntimeIdentity = authenticateDevRequest(
      new Request(
        "https://cloud.test/n/demo/sync?user=runtime&operator=runtime:selected&scope=runtime_peer",
      ),
    );
    const staleRuntimeIdentity = authenticateDevRequest(
      new Request(
        "https://cloud.test/n/demo/sync?user=runtime&operator=runtime:stale&scope=runtime_peer",
      ),
    );
    const ownerSocket = new FakeSocket();
    const selectedRuntimeSocket = new FakeSocket();
    const staleRuntimeSocket = new FakeSocket();
    const ownerPeer = {
      id: "owner",
      socket: ownerSocket.asCloudflareWebSocket(),
      identity: ownerIdentity,
      connectedAt: "2026-05-22T00:00:00.000Z",
      consecutiveRejectedFrames: 0,
    };
    const selectedRuntimePeer = {
      id: "runtime-selected",
      socket: selectedRuntimeSocket.asCloudflareWebSocket(),
      identity: selectedRuntimeIdentity,
      connectedAt: "2026-05-22T00:00:01.000Z",
      workstation: { workstationId: "ws-lab2", runtimeSessionId: "job-selected" },
      consecutiveRejectedFrames: 0,
    };
    const staleRuntimePeer = {
      id: "runtime-stale",
      socket: staleRuntimeSocket.asCloudflareWebSocket(),
      identity: staleRuntimeIdentity,
      connectedAt: "2026-05-22T00:00:02.000Z",
      workstation: { workstationId: "ws-lab2", runtimeSessionId: "job-stale" },
      consecutiveRejectedFrames: 0,
    };
    const harness = roomHarness(room);
    harness.peers.set(ownerPeer.id, ownerPeer);
    harness.peers.set(selectedRuntimePeer.id, selectedRuntimePeer);
    harness.peers.set(staleRuntimePeer.id, staleRuntimePeer);
    harness.materializers.set("demo", {
      receiveFrame: async () => noopMaterializedResult(),
      checkpoint: async () => undefined,
      removePeer: async () => undefined,
      getWorkstationAttachment: async () => ({
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
        runtime_session_id: "job-selected",
        updated_at: "2026-06-07T00:00:00.000Z",
      }),
    });

    const requestPayload = new TextEncoder().encode(
      JSON.stringify({ id: "request-1", action: "complete", code: "pri", cursor_pos: 3 }),
    );
    await harness.handleMessage(
      "demo",
      ownerPeer,
      encodeTypedFrame(FrameType.REQUEST, requestPayload),
    );

    assert.equal(selectedRuntimeSocket.sent.length, 1);
    assert.equal(staleRuntimeSocket.sent.length, 0);

    const responsePayload = new TextEncoder().encode(
      JSON.stringify({
        id: "request-1",
        result: "completion_result",
        items: [{ label: "print", kind: "function" }],
        cursor_start: 0,
        cursor_end: 3,
      }),
    );
    await harness.handleMessage(
      "demo",
      staleRuntimePeer,
      encodeTypedFrame(FrameType.RESPONSE, responsePayload),
    );

    assert.equal(staleRuntimeSocket.sent.length, 0, "stale session did not receive an echo");
    assert.equal(staleRuntimeSocket.closed, true);
    assert.equal(staleRuntimeSocket.closeCode, 1008);
    assert.equal(staleRuntimeSocket.closeReason, "stale runtime session");
    assert.equal(ownerSocket.sent.filter((frame) => frame[0] === FrameType.RESPONSE).length, 0);

    await harness.handleMessage(
      "demo",
      selectedRuntimePeer,
      encodeTypedFrame(FrameType.RESPONSE, responsePayload),
    );

    const ownerResponseFrames = ownerSocket.sent.filter((frame) => frame[0] === FrameType.RESPONSE);
    assert.equal(ownerResponseFrames.length, 1);
    assert.deepEqual(
      [...ownerResponseFrames[0]],
      [FrameType.RESPONSE, ...Array.from(responsePayload)],
    );
  });

  it("settles the oldest hosted completion when the pending query cap evicts it", async () => {
    const room = new NotebookRoom(fakeState(), {} as Env);
    const ownerIdentity = authenticateDevRequest(
      new Request("https://cloud.test/n/demo/sync?user=alice&operator=browser:a&scope=owner"),
    );
    const runtimeIdentity = authenticateDevRequest(
      new Request(
        "https://cloud.test/n/demo/sync?user=runtime&operator=runtime:new&scope=runtime_peer",
      ),
    );
    const ownerSocket = new FakeSocket();
    const runtimeSocket = new FakeSocket();
    const ownerPeer = {
      id: "owner",
      socket: ownerSocket.asCloudflareWebSocket(),
      identity: ownerIdentity,
      connectedAt: "2026-05-22T00:00:00.000Z",
      workstation: null,
      consecutiveRejectedFrames: 0,
    };
    const runtimePeer = {
      id: "runtime",
      socket: runtimeSocket.asCloudflareWebSocket(),
      identity: runtimeIdentity,
      connectedAt: "2026-05-22T00:00:01.000Z",
      workstation: null,
      consecutiveRejectedFrames: 0,
    };
    const harness = roomHarness(room);
    harness.peers.set(ownerPeer.id, ownerPeer);
    harness.peers.set(runtimePeer.id, runtimePeer);
    harness.materializers.set("demo", fakeMaterializer(noopMaterializedResult()));

    for (let index = 0; index < 129; index += 1) {
      await harness.handleMessage(
        "demo",
        ownerPeer,
        encodeTypedFrame(
          FrameType.REQUEST,
          new TextEncoder().encode(
            JSON.stringify({
              id: `request-${index}`,
              action: "complete",
              code: "pri",
              cursor_pos: 3,
            }),
          ),
        ),
      );
    }

    const responseFrames = ownerSocket.sent.filter((frame) => frame[0] === FrameType.RESPONSE);
    assert.equal(responseFrames.length, 1);
    const evicted = decodeJsonPayload<Record<string, unknown>>(responseFrames[0].slice(1));
    assert.equal(evicted.id, "request-0");
    assert.equal(evicted.result, "error");
    assert.match(String(evicted.error), /too many queries are pending/);
    assert.equal(runtimeSocket.sent.length, 129);
  });

  it("settles expired hosted completions when pending queries are pruned", async () => {
    const room = new NotebookRoom(fakeState(), {} as Env);
    const ownerIdentity = authenticateDevRequest(
      new Request("https://cloud.test/n/demo/sync?user=alice&operator=browser:a&scope=owner"),
    );
    const runtimeIdentity = authenticateDevRequest(
      new Request(
        "https://cloud.test/n/demo/sync?user=runtime&operator=runtime:new&scope=runtime_peer",
      ),
    );
    const ownerSocket = new FakeSocket();
    const runtimeSocket = new FakeSocket();
    const ownerPeer = {
      id: "owner",
      socket: ownerSocket.asCloudflareWebSocket(),
      identity: ownerIdentity,
      connectedAt: "2026-05-22T00:00:00.000Z",
      workstation: null,
      consecutiveRejectedFrames: 0,
    };
    const runtimePeer = {
      id: "runtime",
      socket: runtimeSocket.asCloudflareWebSocket(),
      identity: runtimeIdentity,
      connectedAt: "2026-05-22T00:00:01.000Z",
      workstation: null,
      consecutiveRejectedFrames: 0,
    };
    const harness = roomHarness(room);
    harness.peers.set(ownerPeer.id, ownerPeer);
    harness.peers.set(runtimePeer.id, runtimePeer);
    harness.materializers.set("demo", fakeMaterializer(noopMaterializedResult()));
    await harness.handleMessage(
      "demo",
      ownerPeer,
      encodeTypedFrame(
        FrameType.REQUEST,
        new TextEncoder().encode(
          JSON.stringify({ id: "request-1", action: "complete", code: "pri", cursor_pos: 3 }),
        ),
      ),
    );

    harness.prunePendingRuntimePeerResponses(Date.now() + 61_000);

    const responseFrames = ownerSocket.sent.filter((frame) => frame[0] === FrameType.RESPONSE);
    assert.equal(responseFrames.length, 1);
    const expired = decodeJsonPayload<Record<string, unknown>>(responseFrames[0].slice(1));
    assert.equal(expired.id, "request-1");
    assert.equal(expired.result, "error");
    assert.match(String(expired.error), /expired before the runtime peer responded/);
  });

  it("counts unmatched runtime-peer RESPONSE frames toward rejected-frame close", async () => {
    const room = new NotebookRoom(fakeState(), {} as Env);
    const runtimeIdentity = authenticateDevRequest(
      new Request(
        "https://cloud.test/n/demo/sync?user=runtime&operator=runtime:new&scope=runtime_peer",
      ),
    );
    const runtimeSocket = new FakeSocket();
    const runtimePeer = {
      id: "runtime",
      socket: runtimeSocket.asCloudflareWebSocket(),
      identity: runtimeIdentity,
      connectedAt: "2026-05-22T00:00:01.000Z",
      workstation: null,
      consecutiveRejectedFrames: 0,
    };
    const harness = roomHarness(room);
    harness.peers.set(runtimePeer.id, runtimePeer);
    harness.materializers.set("demo", fakeMaterializer(noopMaterializedResult()));
    const responsePayload = new TextEncoder().encode(
      JSON.stringify({ id: "missing-request", result: "completion_result", items: [] }),
    );

    await harness.handleMessage(
      "demo",
      runtimePeer,
      encodeTypedFrame(FrameType.RESPONSE, responsePayload),
    );

    assert.equal(runtimePeer.consecutiveRejectedFrames, 1);
    assert.equal(runtimeSocket.closed, false);
    assert.equal(runtimeSocket.sent.length, 1);
    const rejected = decodeJsonPayload<Record<string, unknown>>(runtimeSocket.sent[0].slice(1));
    assert.equal(rejected.type, "cloud_frame_rejected");
    assert.equal(
      rejected.reason,
      "runtime peer response does not match an in-flight hosted request",
    );
  });

  it("rejects forwarded runtime-agent command REQUEST frames when no runtime peer is attached", async () => {
    const room = new NotebookRoom(fakeState(), {} as Env);
    const identity = authenticateDevRequest(
      new Request("https://cloud.test/n/demo/sync?user=alice&operator=browser:a&scope=owner"),
    );
    const socket = new FakeSocket();
    const peer = {
      id: "owner",
      socket: socket.asCloudflareWebSocket(),
      identity,
      connectedAt: "2026-05-22T00:00:00.000Z",
      consecutiveRejectedFrames: 0,
    };
    const harness = roomHarness(room);
    let materialized = 0;
    harness.materializers.set("demo", {
      receiveFrame: async () => {
        materialized += 1;
        return noopMaterializedResult();
      },
      checkpoint: async () => undefined,
      removePeer: async () => undefined,
    });

    await harness.handleMessage(
      "demo",
      peer,
      encodeTypedFrame(
        FrameType.REQUEST,
        new TextEncoder().encode(
          JSON.stringify({ id: "request-1", action: "interrupt_execution" }),
        ),
      ),
    );

    assert.equal(materialized, 0);
    assert.equal(peer.consecutiveRejectedFrames, 0);
    assert.equal(socket.sent.length, 1);
    const rejected = decodeJsonPayload<Record<string, unknown>>(socket.sent[0].slice(1));
    assert.equal(rejected.type, "cloud_frame_rejected");
    assert.equal(rejected.reason, "no runtime peer is attached for interrupt_execution");
  });

  it("rejects hosted execution requests and repairs stale ready attachments with no runtime peer", async () => {
    const room = new NotebookRoom(fakeState(), {} as Env);
    const identity = authenticateDevRequest(
      new Request("https://cloud.test/n/demo/sync?user=alice&operator=browser:a&scope=owner"),
    );
    const socket = new FakeSocket();
    const peer = {
      id: "owner",
      socket: socket.asCloudflareWebSocket(),
      identity,
      connectedAt: "2026-05-22T00:00:00.000Z",
      consecutiveRejectedFrames: 0,
    };
    const harness = roomHarness(room);
    let materialized = 0;
    let reconciledReason: string | null = null;
    harness.materializers.set("demo", {
      receiveFrame: async () => {
        materialized += 1;
        return noopMaterializedResult();
      },
      checkpoint: async () => undefined,
      removePeer: async () => undefined,
      getWorkstationAttachment: async () => ({
        workstation_id: "ws-lab",
        display_name: "Lab",
        provider: "runtime_peer",
        default_environment_label: "Current Python",
        environment_policy: "current_python",
        status: "ready",
        status_message: null,
        cpu_count: null,
        memory_bytes: null,
        working_directory: null,
        updated_at: "2026-05-22T00:00:00.000Z",
        runtime_session_id: "job-old",
      }),
      reconcileRuntimePeerGone: async (reason: string) => {
        reconciledReason = reason;
        return { ...noopMaterializedResult(), changed: true, runtime_state_changed: true };
      },
    } as never);

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

    assert.equal(materialized, 0, "stale execution request should not queue new work");
    assert.equal(reconciledReason, "no runtime peer is attached for execute_cell");
    assert.equal(peer.consecutiveRejectedFrames, 0);
    assert.equal(socket.sent.length, 1);
    const rejected = decodeJsonPayload<Record<string, unknown>>(socket.sent[0].slice(1));
    assert.equal(rejected.type, "cloud_frame_rejected");
    assert.equal(rejected.reason, "no runtime peer is attached for execute_cell");
  });

  it("allows hosted execution requests to queue while attach is connecting", async () => {
    const room = new NotebookRoom(fakeState(), {} as Env);
    const identity = authenticateDevRequest(
      new Request("https://cloud.test/n/demo/sync?user=alice&operator=browser:a&scope=owner"),
    );
    const socket = new FakeSocket();
    const peer = {
      id: "owner",
      socket: socket.asCloudflareWebSocket(),
      identity,
      connectedAt: "2026-05-22T00:00:00.000Z",
      consecutiveRejectedFrames: 0,
    };
    const harness = roomHarness(room);
    let materialized = 0;
    let reconciled = 0;
    harness.materializers.set("demo", {
      receiveFrame: async () => {
        materialized += 1;
        return noopMaterializedResult();
      },
      checkpoint: async () => undefined,
      removePeer: async () => undefined,
      getWorkstationAttachment: async () => ({
        workstation_id: "ws-lab",
        display_name: "Lab",
        provider: "runtime_peer",
        default_environment_label: "Current Python",
        environment_policy: "current_python",
        status: "connecting",
        status_message: "Lab accepted the request and is starting compute.",
        cpu_count: null,
        memory_bytes: null,
        working_directory: null,
        updated_at: "2026-05-22T00:00:00.000Z",
        runtime_session_id: "job-new",
      }),
      reconcileRuntimePeerGone: async () => {
        reconciled += 1;
        return noopMaterializedResult();
      },
    } as never);

    harness.peers.set(peer.id, peer);
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

    assert.equal(materialized, 1, "connecting attach may queue initial execution");
    assert.equal(reconciled, 0);
    assert.equal(peer.consecutiveRejectedFrames, 0);
    assert.equal(socket.sent.length, 1);
    const accepted = decodeJsonPayload<Record<string, unknown>>(socket.sent[0].slice(1));
    assert.equal(accepted.type, "cloud_frame_accepted");
  });

  it("reconnects a reconstructed room to its surviving interpreter without replacement", async (t) => {
    const fixture = await managedPythonAdmissionFixture("ready", {
      sessionAlive: true,
      immediateOpen: Response.json({ ok: true }),
    });
    t.after(() => fixture.close());
    const first = await fixture.connect("before-hibernation");
    await fixture.seed(first);
    await fixture.reconstruct();
    const reconnected = await fixture.connect("after-hibernation");
    await fixture.drain();
    await reconnected.sync();
    assert.equal(reconnected.runtimeState().workstation?.status, "ready");
    assert.equal(reconnected.runtimeState().workstation?.runtime_session_id, "managed-job");
    assert.equal(fixture.requests.filter((r) => r.path === "/status").length, 1);
    assert.equal(fixture.requests.filter((r) => r.path === "/close").length, 0);
    assert.equal(fixture.requests.find((r) => r.path === "/open")?.resumeOnly, true);
    await fixture.execute(reconnected);
    await fixture.drain();
    assert.equal(fixture.requests.find((r) => r.path === "/execute")?.sessionId, "managed-job");
  });

  it("keeps saved notebook content accessible when recovery catalog retirement fails", async (t) => {
    const fixture = await managedPythonAdmissionFixture("ready");
    t.after(() => fixture.close());
    const first = await fixture.connect("before-redeploy");
    await fixture.seed(first);
    fixture.db.beforeAttachUpdate = () => {
      throw new Error("D1 unavailable");
    };
    await fixture.reconstruct();
    const reconnected = await fixture.connect("after-redeploy");
    assert.match(reconnected.client.get_cells_json(), /print\('ready once'\)/);
    assert.equal(reconnected.runtimeState().workstation?.status, "error");
    assert.equal(fixture.requests.filter((r) => r.path === "/open").length, 0);
    fixture.db.beforeSessionOwnerLookup = undefined;
    fixture.db.beforeAttachUpdate = undefined;
    const attachment = await fixture.materializer.getWorkstationAttachment();
    const delayed = await fixture.room.fetch(
      new Request("https://room/internal/n/demo/workstation-attachment", {
        method: "POST",
        body: JSON.stringify({ attachment: { ...attachment, status: "connecting" } }),
      }),
    );
    assert.equal(
      delayed.status,
      409,
      "a delayed old publish cannot resurrect the retired generation",
    );
  });

  it("abandons saved in-flight work without replaying or killing a busy surviving interpreter", async (t) => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let executions = 0;
    let disposed = 0;
    const pool = new SessionPool({
      warmCount: 0,
      create: async () => ({
        info: {},
        execute: async () => {
          executions++;
          if (executions === 1) await pending;
          return { success: true, execution_count: executions, outputs: [] };
        },
        dispose: async () => {
          disposed++;
        },
      }),
    });
    t.after(async () => {
      finish();
      await pool.close();
    });
    const key = JSON.stringify(["user:dev:alice", "demo", "managed-job"]);
    await pool.open(key, "user:dev:alice");
    const service = createProviderService(pool);
    const fixture = await managedPythonAdmissionFixture("ready", {
      providerFetch: (request) => service.fetch(request),
    });
    t.after(() => fixture.close());
    const first = await fixture.connect("before-hibernation");
    await fixture.seed(first);
    await fixture.materializer.receiveFrame(first.peer, {
      type: FrameType.REQUEST,
      payload: new TextEncoder().encode(
        JSON.stringify({
          id: "orphan",
          action: "execute_cell",
          cell_id: initialHostedCellIdForTest("demo"),
        }),
      ),
    });
    await fixture.materializer.checkpoint();
    const saved = await fixture.state.storage.get<ArrayBuffer>("room-host:runtime-state-doc");
    const previous = RuntimeStatePeerHandle.load(
      new Uint8Array(saved!),
      "user:dev:alice/managed-python:managed-job",
    );
    t.after(() => previous.free());
    const executionId = Object.keys(previous.get_runtime_state().executions)[0];
    previous.set_execution_running(executionId);
    previous.refresh_execution_queue();
    const executing = pool.execute(key, {
      execution_id: executionId,
      cell_id: initialHostedCellIdForTest("demo"),
      source: "print('ready once')",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(pool.inspect(key).busy, true);
    await fixture.reconstruct(previous.save());
    const reconnected = await fixture.connect("after-hibernation");
    await fixture.drain();
    assert.equal(reconnected.runtimeState().executions[executionId].status, "error");
    assert.equal(reconnected.runtimeState().workstation?.status, "disconnected");
    await fixture.execute(reconnected);
    await fixture.drain();
    assert.equal(executions, 1, "busy orphaned work is never replayed or overlapped");
    assert.equal(disposed, 0);
    finish();
    await executing;
    await fixture.execute(reconnected);
    await fixture.drain();
    await reconnected.sync();
    assert.equal(executions, 2);
    assert.equal(disposed, 0);
    assert.equal(pool.has(key), true);
    assert.equal(reconnected.runtimeState().workstation?.status, "ready");
    assert.equal(reconnected.runtimeState().executions[executionId].status, "error");
    assert.equal(fixture.requests.filter((r) => r.path === "/close").length, 0);
  });

  it("returns confirmed loss to the same Start when a surviving session disappears before reopen", async (t) => {
    let unavailable = true;
    const fixture = await managedPythonAdmissionFixture("ready", {
      providerFetch: async (request) => {
        const path = new URL(request.url).pathname;
        if (path === "/status")
          return unavailable
            ? new Response("Unavailable", { status: 503 })
            : Response.json({ alive: true, busy: false });
        if (path === "/open")
          return Response.json(
            { code: "session_lost", error: "Session expired; allocate a new runtime session" },
            { status: 409 },
          );
        return Response.json({ ok: true });
      },
    });
    t.after(() => fixture.close());
    const first = await fixture.connect("before-hibernation");
    await fixture.seed(first);
    await fixture.reconstruct();
    await fixture.connect("after-hibernation");
    unavailable = false;
    const response = await fixture.room.fetch(
      new Request("https://room/internal/n/demo/workstation-attachment"),
    );
    assert.equal(response.status, 200);
    assert.equal(
      ((await response.json()) as { attachment: { status: string } }).attachment.status,
      "error",
    );
    assert.equal(fixture.db.attachJobs[0].status, "failed");
  });

  for (const probeResult of ["lost", "busy", "idle", "unavailable"] as const) {
    it(`ignores a late ${probeResult} survivor probe after confirmed Restart`, async (t) => {
      let holding = false;
      let entered!: () => void;
      let release!: () => void;
      const probing = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const fixture = await managedPythonAdmissionFixture("ready", {
        providerFetch: async (request) => {
          if (new URL(request.url).pathname !== "/status") return Response.json({ ok: true });
          if (!holding) return Response.json({ alive: true, busy: true });
          entered();
          await held;
          if (probeResult === "unavailable") throw new Error("status unavailable");
          return Response.json({ alive: probeResult !== "lost", busy: probeResult === "busy" });
        },
      });
      t.after(async () => {
        release();
        await fixture.close();
      });
      const first = await fixture.connect("before-hibernation");
      await fixture.seed(first);
      await fixture.reconstruct();
      const owner = await fixture.connect("owner");
      const observer = await fixture.connect("observer");
      await fixture.drain();
      assert.equal(owner.runtimeState().workstation?.status, "disconnected");
      holding = true;
      const executing = fixture.execute(owner);
      await probing;
      const response = await fixture.room.fetch(
        new Request("https://room/internal/n/demo/workstation-attachment", {
          method: "DELETE",
          body: JSON.stringify({ runtime_session_id: "managed-job" }),
        }),
      );
      assert.equal(response.status, 200);
      const offsets: number[] = [];
      for (const connection of [owner, observer]) {
        await connection.sync();
        assert.equal(connection.runtimeState().workstation?.status, "idle");
        offsets.push(connection.runtimeHistory.length);
      }
      release();
      await executing;
      await fixture.drain();
      for (const [index, connection] of [owner, observer].entries()) {
        await connection.sync();
        assert.equal(connection.runtimeState().workstation?.status, "idle");
        for (const state of connection.runtimeHistory.slice(offsets[index])) {
          assert.notEqual(state.workstation?.status, "error");
          assert.notEqual(state.workstation?.status, "disconnected");
        }
      }
      assert.equal(fixture.db.attachJobs[0].status, "completed");
      assert.equal(
        fixture.requests.filter((r) => ["/open", "/execute"].includes(r.path)).length,
        0,
      );
      assert.equal(
        (
          fixture.room as unknown as { pendingManagedPythonProbes: Set<string> }
        ).pendingManagedPythonProbes.has("managed-job"),
        false,
      );
    });
  }

  for (const settleProbeFirst of [true, false]) {
    it(`preserves confirmed loss when concurrent Restart fails (${settleProbeFirst ? "probe" : "reset"} settles first)`, async (t) => {
      let lost = false;
      let closeUnavailable = true;
      let enteredWrite!: () => void;
      let releaseWrite!: () => void;
      let enteredClose!: () => void;
      let releaseClose!: () => void;
      const writing = new Promise<void>((resolve) => {
        enteredWrite = resolve;
      });
      const heldWrite = new Promise<void>((resolve) => {
        releaseWrite = resolve;
      });
      const closing = new Promise<void>((resolve) => {
        enteredClose = resolve;
      });
      const heldClose = new Promise<void>((resolve) => {
        releaseClose = resolve;
      });
      const fixture = await managedPythonAdmissionFixture("ready", {
        providerFetch: async (request) => {
          const path = new URL(request.url).pathname;
          if (path === "/status") return Response.json({ alive: !lost, busy: !lost });
          if (path === "/close" && closeUnavailable) {
            enteredClose();
            await heldClose;
            return new Response("Close unavailable", { status: 503 });
          }
          return Response.json({ ok: true });
        },
      });
      t.after(async () => {
        closeUnavailable = false;
        releaseWrite();
        releaseClose();
        await fixture.close();
      });
      const first = await fixture.connect("before-hibernation");
      await fixture.seed(first);
      await fixture.reconstruct();
      const owner = await fixture.connect("owner");
      await fixture.drain();
      assert.equal(owner.runtimeState().workstation?.status, "disconnected");
      fixture.db.beforeAttachUpdate = async () => {
        fixture.db.beforeAttachUpdate = undefined;
        enteredWrite();
        await heldWrite;
      };
      lost = true;
      const executing = fixture.execute(owner);
      await writing;
      const resetting = fixture.room.fetch(
        new Request("https://room/internal/n/demo/workstation-attachment", {
          method: "DELETE",
          body: JSON.stringify({ runtime_session_id: "managed-job" }),
        }),
      );
      await closing;
      if (settleProbeFirst) {
        releaseWrite();
        await executing;
        releaseClose();
        assert.equal((await resetting).status, 503);
      } else {
        releaseClose();
        assert.equal((await resetting).status, 503);
        releaseWrite();
        await executing;
      }
      await fixture.drain();
      await owner.sync();
      assert.equal(owner.runtimeState().workstation?.status, "error");
      assert.equal(fixture.db.attachJobs[0].status, "failed");
      const replacement = await fixture.startReplacement(true);
      assert.notEqual(replacement, "managed-job", "Start can allocate after confirmed loss");
      await owner.sync();
      assert.equal(owner.runtimeState().workstation?.status, "ready");
    });
  }

  it("publishes intentional restart to every viewer without a transient compute error", async (t) => {
    const fixture = await managedPythonAdmissionFixture("connecting", {
      immediateOpen: Response.json({ ok: true }),
    });
    t.after(() => fixture.close());
    const owner = await fixture.connect("owner");
    await fixture.seed(owner);
    await fixture.execute(owner);
    await fixture.drain();
    await owner.sync();
    const observer = await fixture.connect("observer");
    assert.equal(owner.runtimeState().workstation?.status, "ready");
    const completed = owner.runtimeState().executions;
    assert.equal(Object.values(completed)[0].status, "done");
    const content = owner.client.get_cells_json();
    const offsets = [owner.runtimeHistory.length, observer.runtimeHistory.length];

    const response = await fixture.room.fetch(
      new Request("https://room/internal/n/demo/workstation-attachment", {
        method: "DELETE",
        body: JSON.stringify({ runtime_session_id: "managed-job" }),
      }),
    );
    assert.equal(response.status, 200);
    await fixture.drain();
    for (const [index, connection] of [owner, observer].entries()) {
      await connection.sync();
      const transitions = connection.runtimeHistory.slice(offsets[index]);
      assert.ok(transitions.length > 0, "viewer received the stop transition");
      for (const state of transitions) {
        assert.notEqual(state.workstation?.status, "error");
        assert.notEqual(state.workstation?.status, "disconnected");
        assert.notEqual(state.kernel.lifecycle.lifecycle, "Error");
      }
      const stopped = connection.runtimeState();
      assert.equal(stopped.kernel.lifecycle.lifecycle, "Shutdown");
      assert.equal(stopped.workstation?.status, "idle");
      assert.deepEqual(stopped.executions, completed, "completed results are retained");
      assert.equal(connection.client.get_cells_json(), content, "notebook content is retained");
    }
    assert.equal(fixture.db.attachJobs[0].status, "completed");
    assert.equal(fixture.requests.filter((request) => request.path === "/execute").length, 1);

    const replacement = await fixture.startReplacement(true);
    assert.notEqual(replacement, "managed-job");
    await fixture.drain();
    await owner.sync();
    assert.equal(owner.runtimeState().workstation?.status, "ready");
    for (const [index, connection] of [owner, observer].entries()) {
      await connection.sync();
      assertNoComputeFailure(connection.runtimeHistory.slice(offsets[index]));
    }
    assert.equal(
      fixture.requests.filter((request) => request.path === "/execute").length,
      1,
      "Restart alone does not replay completed execution",
    );
  });

  for (const action of ["restart", "interrupt"] as const) {
    it(`allows explicit ${action} of a busy survivor only after disposal is confirmed`, async (t) => {
      let finish!: () => void;
      const pending = new Promise<void>((resolve) => {
        finish = resolve;
      });
      let created = 0;
      let disposed = 0;
      const pool = new SessionPool({
        warmCount: 0,
        maxSessions: 2,
        maxSessionsPerOwner: 2,
        create: async () => {
          created++;
          return {
            info: {},
            execute: async () => {
              await pending;
              return { success: true, execution_count: 1, outputs: [] };
            },
            dispose: async () => {
              disposed++;
              finish();
            },
          };
        },
      });
      t.after(async () => {
        finish();
        await pool.close();
      });
      const key = JSON.stringify(["user:dev:alice", "demo", "managed-job"]);
      await pool.open(key, "user:dev:alice");
      await pool.open("other", "user:dev:alice");
      const executing = pool
        .execute(key, { execution_id: "orphan", cell_id: "cell", source: "while True: pass" })
        .catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 0));
      let rejectClose = true;
      const service = createProviderService(pool);
      const fixture = await managedPythonAdmissionFixture("ready", {
        providerFetch: async (request) => {
          if (rejectClose && new URL(request.url).pathname === "/close")
            return new Response("Unavailable", { status: 503 });
          return service.fetch(request);
        },
      });
      t.after(() => fixture.close());
      const first = await fixture.connect("before-hibernation");
      await fixture.seed(first);
      await fixture.reconstruct();
      const reconnected = await fixture.connect("after-hibernation");
      await fixture.drain();
      const reset = async () => {
        if (action === "restart") {
          const response = await fixture.room.fetch(
            new Request("https://room/internal/n/demo/workstation-attachment", {
              method: "DELETE",
              body: JSON.stringify({ runtime_session_id: "managed-job" }),
            }),
          );
          return response.status === 200;
        }
        const id = crypto.randomUUID();
        const response = reconnected.response(id);
        await fixture.room.webSocketMessage(
          reconnected.peer.socket,
          encodeTypedFrame(
            FrameType.REQUEST,
            new TextEncoder().encode(JSON.stringify({ id, action: "interrupt_execution" })),
          ),
        );
        return (await response).result === "interrupt_sent";
      };
      assert.equal(await reset(), false);
      await fixture.drain();
      await reconnected.sync();
      assert.equal(reconnected.runtimeState().workstation?.status, "disconnected");
      assert.equal(fixture.db.attachJobs[0].status, "running");
      assert.equal(pool.has(key), true);
      assert.equal(disposed, 0);
      rejectClose = false;
      const restartOffset = reconnected.runtimeHistory.length;
      assert.equal(await reset(), true);
      await executing;
      assert.equal(pool.has(key), false);
      assert.equal(disposed, 1);
      await fixture.drain();
      await reconnected.sync();
      assert.equal(
        reconnected.runtimeState().workstation?.status,
        action === "restart" ? "idle" : "error",
      );
      assert.equal(fixture.db.attachJobs[0].status, action === "restart" ? "completed" : "failed");
      if (action === "restart") {
        assert.equal(reconnected.runtimeState().kernel.lifecycle.lifecycle, "Shutdown");
        assert.equal(reconnected.runtimeState().kernel.error_details, "");
      }
      const replacement = await fixture.startReplacement(true);
      assert.notEqual(replacement, "managed-job");
      assert.equal(created, 3, "the owner's full pool admits replacement after confirmed close");
      if (action === "restart") {
        await fixture.drain();
        await reconnected.sync();
        assertNoComputeFailure(reconnected.runtimeHistory.slice(restartOffset));
      }
    });
  }

  for (const failure of ["already-retired", "catalog-failure"] as const) {
    it(`keeps a session terminal after ${failure} during explicit cleanup`, async (t) => {
      const fixture = await managedPythonAdmissionFixture("ready", {
        providerFetch: async (request) =>
          new URL(request.url).pathname === "/status"
            ? Response.json({ alive: failure === "catalog-failure", busy: true })
            : failure === "already-retired"
              ? new Response("Cleanup unconfirmed", { status: 409 })
              : Response.json({ ok: true }),
      });
      t.after(() => fixture.close());
      const first = await fixture.connect("before-loss");
      await fixture.seed(first);
      await fixture.reconstruct();
      const reconnected = await fixture.connect("after-loss");
      await fixture.drain();
      await reconnected.sync();
      assert.equal(
        reconnected.runtimeState().workstation?.status,
        failure === "already-retired" ? "error" : "disconnected",
      );
      if (failure === "catalog-failure")
        fixture.db.beforeAttachUpdate = () => {
          throw new Error("Catalog unavailable after close");
        };
      const response = await fixture.room.fetch(
        new Request("https://room/internal/n/demo/workstation-attachment", {
          method: "DELETE",
          body: JSON.stringify({ runtime_session_id: "managed-job" }),
        }),
      );
      assert.equal(response.status, 503);
      assert.match(
        ((await response.json()) as { error: string }).error,
        failure === "catalog-failure"
          ? /Python stopped, but recovery could not be saved/
          : /termination was not confirmed/,
      );
      await fixture.drain();
      await reconnected.sync();
      assert.equal(reconnected.runtimeState().workstation?.status, "error");
      assert.equal(
        fixture.db.attachJobs[0].status,
        failure === "already-retired" ? "failed" : "running",
      );
      fixture.db.beforeAttachUpdate = undefined;
      const attachment = await fixture.materializer.getWorkstationAttachment();
      const delayed = await fixture.room.fetch(
        new Request("https://room/internal/n/demo/workstation-attachment", {
          method: "POST",
          body: JSON.stringify({ attachment: { ...attachment, status: "connecting" } }),
        }),
      );
      assert.equal(delayed.status, 409, "failed cleanup cannot lift the retired generation fence");
      if (failure === "catalog-failure") {
        const replacement = await fixture.startReplacement(true);
        assert.notEqual(replacement, "managed-job");
        await fixture.drain();
        await reconnected.sync();
        assert.equal(reconnected.runtimeState().workstation?.runtime_session_id, replacement);
        assert.equal(reconnected.runtimeState().workstation?.status, "ready");
      }
    });
  }

  for (const scenario of [
    "already-installed",
    "inventory-failure",
    "restore-failure",
    "open-storage-failure",
    "legacy-open-conflict",
    "legacy-inventory-conflict",
  ] as const) {
    it(`keeps a resumed interpreter through ${scenario}`, async (t) => {
      const manifest = { version: 1, pyodide: "0.28.3", requirements: ["six"], wheels: [] };
      let disposed = 0;
      const pool = new SessionPool({
        warmCount: 0,
        create: async () => ({
          info: {},
          install: async () => ({ status: "ready", installed: ["six==1.0"] }),
          execute: async () => ({ success: true, execution_count: 1, outputs: [] }),
          dispose: async () => {
            disposed++;
          },
        }),
      });
      t.after(() => pool.close());
      const key = JSON.stringify(["user:dev:alice", "demo", "managed-job"]);
      await pool.open(key, "user:dev:alice");
      if (scenario === "already-installed")
        await pool.packages(key, "previous-install", async () => ({
          status: "ready",
          installed: ["six==1.0"],
          manifest,
        }));
      let failing = true;
      const service = createProviderService(pool, {
        get: async () => {
          if (failing && scenario === "open-storage-failure")
            throw new Error("Temporary storage read failure");
          return undefined;
        },
        put: async () => {},
      });
      const fixture = await managedPythonAdmissionFixture("ready", {
        providerFetch: async (request) => {
          const path = new URL(request.url).pathname;
          if (
            failing &&
            ((scenario === "legacy-open-conflict" && path === "/open") ||
              (scenario === "legacy-inventory-conflict" && path === "/packages/inventory"))
          )
            return Response.json({ error: "Unclassified provider conflict" }, { status: 409 });
          if (failing && scenario === "inventory-failure" && path === "/packages/inventory")
            return new Response("Inventory temporarily unavailable", { status: 503 });
          if (failing && scenario === "restore-failure" && path === "/packages")
            return Response.json({
              status: "error",
              needs_restart: false,
              error: "Package download temporarily unavailable",
            });
          return service.fetch(request);
        },
      });
      t.after(() => fixture.close());
      const first = await fixture.connect("before-hibernation");
      await fixture.seed(first);
      await fixture.materializer.compareSetCloudPackageManifest(null, manifest);
      await fixture.reconstruct();
      const reconnected = await fixture.connect("after-hibernation");
      await fixture.drain();
      await reconnected.sync();
      assert.equal(disposed, 0);
      assert.equal(pool.has(key), true);
      if (scenario === "already-installed") {
        assert.equal(reconnected.runtimeState().workstation?.status, "ready");
        assert.equal(fixture.requests.filter((r) => r.path === "/packages").length, 0);
      } else {
        assert.equal(reconnected.runtimeState().workstation?.status, "disconnected");
        assert.equal(fixture.db.attachJobs[0].status, "running");
        failing = false;
        await fixture.execute(reconnected);
        await fixture.drain();
        await reconnected.sync();
        assert.equal(reconnected.runtimeState().workstation?.status, "ready");
        assert.equal(disposed, 0);
        assert.equal(fixture.requests.filter((r) => r.path === "/close").length, 0);
      }
    });
  }

  for (const denied of ["owner", "retired-job"] as const) {
    it(`releases a surviving interpreter when recovery confirms ${denied} is no longer authorized`, async (t) => {
      const fixture = await managedPythonAdmissionFixture("ready", {
        sessionAlive: true,
        ownerAuthorized: denied !== "owner",
      });
      t.after(() => fixture.close());
      const first = await fixture.connect("before-hibernation");
      await fixture.seed(first);
      if (denied === "retired-job") fixture.db.attachJobs[0].status = "failed";
      await fixture.reconstruct();
      const reconnected = await fixture.connect("after-hibernation");
      await fixture.drain();
      await reconnected.sync();
      assert.equal(reconnected.runtimeState().workstation?.status, "error");
      assert.equal(fixture.requests.filter((r) => r.path === "/close").length, 1);
      assert.equal(fixture.requests.filter((r) => r.path === "/open").length, 0);
    });
  }

  for (const failure of [
    "lookup",
    "provider",
    "rejected",
    "timeout",
    "http",
    "invalid",
    "legacy-status",
  ] as const) {
    it(`preserves a surviving interpreter and owner quota after a ${failure} recovery probe`, async (t) => {
      let created = 0;
      let disposed = 0;
      const pool = new SessionPool({
        maxSessions: 2,
        maxSessionsPerOwner: 2,
        warmCount: 0,
        create: async () => {
          const interpreter = ++created;
          return {
            info: { interpreter },
            execute: async () => ({
              success: true,
              execution_count: 1,
              outputs: [
                { output_type: "stream", name: "stdout", text: `survivor-${interpreter}:41\n` },
              ],
            }),
            dispose: async () => {
              disposed++;
            },
          };
        },
      });
      t.after(() => pool.close());
      const key = JSON.stringify(["user:dev:alice", "demo", "managed-job"]);
      await pool.open(key, "user:dev:alice");
      await pool.open(JSON.stringify(["user:dev:alice", "other", "other-job"]), "user:dev:alice");
      const service = createProviderService(pool);
      let unavailable = true;
      const fixture = await managedPythonAdmissionFixture("ready", {
        providerAvailable: () => failure !== "provider" || !unavailable,
        providerFetch: async (request) => {
          if (unavailable && new URL(request.url).pathname === "/status") {
            if (failure === "rejected") throw new Error("Provider temporarily unreachable");
            if (failure === "timeout") throw new DOMException("Status timed out", "TimeoutError");
            if (failure === "http") return new Response("Unavailable", { status: 503 });
            if (failure === "invalid") return Response.json({ alive: "unknown" });
            if (failure === "legacy-status") return Response.json({ alive: true });
          }
          return service.fetch(request);
        },
      });
      t.after(() => fixture.close());
      const first = await fixture.connect("before-hibernation");
      await fixture.seed(first);
      if (failure === "lookup")
        fixture.db.beforeSessionOwnerLookup = async () => {
          if (unavailable) throw new Error("D1 temporarily unavailable");
        };
      await fixture.reconstruct();
      const reconnected = await fixture.connect("after-hibernation");
      await fixture.drain();
      assert.match(reconnected.client.get_cells_json(), /print\('ready once'\)/);
      assert.equal(reconnected.runtimeState().workstation?.status, "disconnected");
      assert.equal(reconnected.runtimeState().workstation?.runtime_session_id, "managed-job");
      assert.match(reconnected.runtimeState().workstation?.status_message ?? "", /same session/);
      assert.equal(fixture.db.attachJobs[0].status, "accepted");
      assert.equal(
        fixture.requests.filter((r) => r.path === "/open" || r.path === "/close").length,
        0,
      );
      assert.equal(pool.has(key), true);
      assert.equal(created, 2);
      assert.equal(disposed, 0);

      // A failed explicit retry must remain recoverable, without creating a
      // replacement or leaving accepted work queued indefinitely.
      await fixture.execute(reconnected);
      await fixture.drain();
      await reconnected.sync();
      assert.equal(reconnected.runtimeState().workstation?.status, "disconnected");
      assert.deepEqual(reconnected.runtimeState().queue.queued, []);
      assert.equal(fixture.db.attachJobs.length, 1);
      assert.equal(disposed, 0);

      unavailable = false;
      // Exercise real catalog deduplication for Start as well as Run alone.
      if (failure !== "timeout") assert.equal(await fixture.startReplacement(true), "managed-job");
      await fixture.execute(reconnected);
      await fixture.drain();
      await reconnected.sync();
      assert.equal(reconnected.runtimeState().workstation?.status, "ready");
      assert.equal(fixture.requests.filter((r) => r.path === "/close").length, 0);
      assert.equal(fixture.requests.find((r) => r.path === "/open")?.resumeOnly, true);
      assert.equal(created, 2, "reconnect succeeds even when both owner slots are occupied");
      assert.equal(disposed, 0);
      assert.ok(
        Object.values(reconnected.runtimeState().executions).some((execution) =>
          execution.outputs.some((output) => output.text?.inline === "survivor-1:41\n"),
        ),
      );
    });
  }

  it("requires a fresh session when a retried probe confirms the old interpreter is gone", async (t) => {
    let unavailable = true;
    const fixture = await managedPythonAdmissionFixture("ready", {
      providerFetch: async () =>
        unavailable
          ? new Response("Unavailable", { status: 503 })
          : Response.json({ alive: false }),
    });
    t.after(() => fixture.close());
    const first = await fixture.connect("before-hibernation");
    await fixture.seed(first);
    await fixture.reconstruct();
    const reconnected = await fixture.connect("after-hibernation");
    assert.equal(reconnected.runtimeState().workstation?.status, "disconnected");
    unavailable = false;
    await fixture.execute(reconnected);
    await fixture.drain();
    await reconnected.sync();
    assert.equal(reconnected.runtimeState().workstation?.status, "error");
    assert.match(
      reconnected.runtimeState().workstation?.status_message ?? "",
      /Variables were lost/,
    );
    assert.equal(fixture.db.attachJobs[0].status, "failed");
    assert.equal(fixture.requests.filter((request) => request.path === "/open").length, 0);
    assert.equal(fixture.requests.filter((request) => request.path === "/close").length, 1);
    assert.deepEqual(reconnected.runtimeState().queue.queued, []);
  });

  for (const status of ["connecting", "ready"] as const) {
    it(`recovers a reconstructed managed room from a saved ${status} attachment`, async (t) => {
      const fixture = await managedPythonAdmissionFixture(status, {
        packageResponse: async () => Response.json({ status: "ready", installed: ["six==1.0"] }),
      });
      t.after(() => fixture.close());
      const first = await fixture.connect("before-redeploy");
      await fixture.seed(first);
      const manifest = { version: 1, pyodide: "0.28.3", requirements: ["six==1.0"], wheels: [] };
      await fixture.materializer.compareSetCloudPackageManifest(null, manifest);
      // Save accepted work whose result is still in flight at redeployment.
      await fixture.materializer.receiveFrame(first.peer, {
        type: FrameType.REQUEST,
        payload: new TextEncoder().encode(
          JSON.stringify({
            id: "before-redeploy",
            action: "execute_cell",
            cell_id: initialHostedCellIdForTest("demo"),
          }),
        ),
      });
      await fixture.materializer.checkpoint();
      const saved = await fixture.state.storage.get<ArrayBuffer>("room-host:runtime-state-doc");
      const oldRuntime = RuntimeStatePeerHandle.load(
        new Uint8Array(saved!),
        "user:dev:alice/managed-python:managed-job",
      );
      t.after(() => oldRuntime.free());
      const oldExecutionId = Object.keys(oldRuntime.get_runtime_state().executions)[0];
      oldRuntime.set_execution_running(oldExecutionId);
      oldRuntime.append_output_json(
        oldExecutionId,
        JSON.stringify({
          output_type: "stream",
          name: "stdout",
          text: { inline: "late old output" },
          output_id: "old-output",
        }),
      );
      oldRuntime.set_execution_done(oldExecutionId, true);
      const lateFrame = oldRuntime.flush_runtime_state_sync();
      assert.ok(lateFrame);
      await fixture.reconstruct();
      // Concurrent browsers must observe one reconciliation, never allocate
      // another interpreter merely by opening the saved notebook.
      const [reconnected, other] = await Promise.all([
        fixture.connect("after-redeploy"),
        fixture.connect("other-browser"),
      ]);
      for (const connection of [reconnected, other]) {
        assert.equal(connection.runtimeState().workstation?.status, "error");
        assert.match(
          connection.runtimeState().workstation?.status_message ?? "",
          /Variables were lost/,
        );
        assert.match(connection.client.get_cells_json(), /print\('ready once'\)/);
      }
      assert.deepEqual(await fixture.materializer.getCloudPackageManifest(), manifest);
      assert.equal(
        fixture.db.attachJobs[0].status,
        "failed",
        "retire the job before retry is visible",
      );
      assert.equal(fixture.requests.filter((r) => r.path === "/open").length, 0);
      assert.equal(fixture.requests.filter((r) => r.path === "/close").length, 1);
      assert.equal(reconnected.runtimeState().executions[oldExecutionId].status, "cancelled");
      assert.deepEqual(reconnected.runtimeState().queue.queued, []);
      await fixture.drain();
      const summary = fixture.computeIndex.requests.at(-1)?.body.summary;
      assert.equal(summary?.status, "error");
      assert.equal(summary?.runtime_peer_count, 0);

      fixture.releaseOpen(Response.json({ ok: true }));
      const replacementId = await fixture.startReplacement(true);
      assert.notEqual(replacementId, "managed-job");
      await fixture.execute(reconnected);
      await fixture.drain();
      await reconnected.sync();
      const executed = fixture.requests.filter((r) => r.path === "/execute");
      assert.equal(executed.length, 1);
      assert.equal(executed[0].sessionId, replacementId);
      assert.equal(reconnected.runtimeState().workstation?.status, "ready");
      const replacementExecution = Object.entries(reconnected.runtimeState().executions).find(
        ([id]) => id !== oldExecutionId,
      )?.[1];
      assert.equal(replacementExecution?.status, "done");
      assert.deepEqual(replacementExecution?.outputs[0].text, { inline: "ready once\n" });
      assert.deepEqual(await fixture.materializer.getCloudPackageManifest(), manifest);
      const beforeLateOutput = reconnected.runtimeState();
      const lateSocket = new FakeSocket();
      const oldPeer = {
        id: "old-managed-session",
        socket: lateSocket.asCloudflareWebSocket(),
        identity: authenticateDevRequest(
          new Request(
            "https://cloud.test/n/demo/sync?user=alice&operator=managed-python:managed-job&scope=runtime_peer",
          ),
        ),
        connectedAt: new Date().toISOString(),
        workstation: { workstationId: "celld-preview-python", runtimeSessionId: "managed-job" },
      };
      roomHarness(fixture.room).peers.set(oldPeer.id, oldPeer);
      await roomHarness(fixture.room).handleMessage(
        "demo",
        oldPeer,
        encodeTypedFrame(FrameType.RUNTIME_STATE_SYNC, lateFrame),
      );
      assert.equal(lateSocket.closeReason, "stale runtime session");
      await reconnected.sync();
      assert.deepEqual(
        reconnected.runtimeState(),
        beforeLateOutput,
        "late output cannot change old or replacement execution",
      );
    });

    it(`admits managed Python execution before ${status} startup and drains after reconnect`, async (t) => {
      const fixture = await managedPythonAdmissionFixture(status);
      t.after(() => fixture.close());
      const first = await fixture.connect("first");
      await fixture.seed(first);

      await fixture.execute(first);
      await fixture.openEntered;
      assert.equal(first.accepted(), true, "Play is acknowledged while /open is still pending");
      await first.sync();
      const queued = first.runtimeState();
      const [executionId] = Object.keys(queued.executions);
      assert.ok(executionId);
      assert.equal(queued.executions[executionId].status, "queued");
      assert.equal(queued.executions[executionId].source, "print('ready once')");
      assert.deepEqual(queued.queue.queued, [{ execution_id: executionId }]);
      assert.equal(fixture.requests.filter((request) => request.path === "/execute").length, 0);

      fixture.room.webSocketClose(first.peer.socket, 1000, "browser disconnected", true);
      const reconnected = await fixture.connect("reconnected");
      assert.deepEqual(Object.keys(reconnected.runtimeState().executions), [executionId]);
      assert.equal(reconnected.runtimeState().executions[executionId].status, "queued");
      assert.equal(reconnected.accepted(), false, "reconnecting must not resubmit Play");

      fixture.releaseOpen(Response.json({ ok: true }));
      await fixture.drain();
      await reconnected.sync();
      const executions = fixture.requests.filter((request) => request.path === "/execute");
      assert.equal(executions.length, 1, "readiness dispatches the accepted intent exactly once");
      assert.equal(executions[0].sessionId, "managed-job");
      assert.equal(executions[0].ownerPrincipal, "user:dev:alice");
      assert.equal(executions[0].execution?.source, "print('ready once')");
      const completed = reconnected.runtimeState();
      assert.deepEqual(Object.keys(completed.executions), [executionId]);
      assert.equal(completed.executions[executionId].status, "done");
      assert.deepEqual(completed.executions[executionId].outputs[0].text, {
        inline: "ready once\n",
      });
      assert.equal(completed.queue.executing, null);
      assert.deepEqual(completed.queue.queued, []);
    });
  }

  for (const immediate of [false, true]) {
    it(`terminalizes accepted managed Python intent after ${immediate ? "immediate" : "delayed"} startup failure without replay`, async (t) => {
      const failure = Response.json({ error: "Python capacity unavailable" }, { status: 503 });
      const fixture = await managedPythonAdmissionFixture("connecting", {
        immediateOpen: immediate ? failure : undefined,
      });
      t.after(() => fixture.close());
      const first = await fixture.connect("first");
      await fixture.seed(first);
      await fixture.execute(first);
      await fixture.openEntered;
      assert.equal(first.accepted(), true, "startup failure follows accepted execution intent");
      if (!immediate) {
        await first.sync();
        assert.equal(Object.values(first.runtimeState().executions)[0]?.status, "queued");
        fixture.releaseOpen(failure);
      }
      await fixture.drain();
      await first.sync();
      const failed = first.runtimeState();
      const [executionId] = Object.keys(failed.executions);
      assert.ok(executionId);
      assert.equal(failed.executions[executionId].status, "cancelled");
      assert.deepEqual(failed.queue.queued, []);
      assert.equal(failed.workstation?.status, "error");
      assert.match(failed.workstation?.status_message ?? "", /Python capacity unavailable/);
      assert.equal(fixture.requests.filter((request) => request.path === "/execute").length, 0);

      fixture.room.webSocketClose(first.peer.socket, 1000, "browser disconnected", true);
      const reconnected = await fixture.connect("reconnected");
      assert.equal(
        (await fixture.materializer.transitionManagedPythonSession("managed-job", "ready"))
          .ignored_stale,
        true,
        "late readiness cannot resurrect failed intent",
      );
      await fixture.drain();
      await reconnected.sync();
      assert.deepEqual(Object.keys(reconnected.runtimeState().executions), [executionId]);
      assert.equal(reconnected.runtimeState().executions[executionId].status, "cancelled");
      assert.equal(fixture.requests.filter((request) => request.path === "/open").length, 1);
      assert.equal(fixture.requests.filter((request) => request.path === "/execute").length, 0);
    });
  }

  for (const failure of [
    "needs_restart",
    "needs_restart_checkpoint",
    "needs_restart_publication",
    "unconfirmed",
  ] as const) {
    it(`terminalizes queued work after ${failure} package installation and recovers without replay`, async (t) => {
      let entered!: () => void;
      let release!: () => void;
      let terminalPublication = false;
      const installing = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const fixture = await managedPythonAdmissionFixture("ready", {
        packageResponse: async () => {
          entered();
          await held;
          if (failure === "unconfirmed") throw new Error("provider connection lost");
          terminalPublication = true;
          return Response.json({
            status: "error",
            error: "Installation needs a restart",
            needs_restart: true,
          });
        },
      });
      t.after(() => fixture.close());
      const owner = await fixture.connect("owner");
      await fixture.seed(owner);
      fixture.releaseOpen(Response.json({ ok: true }));
      await fixture.execute(owner);
      await fixture.drain();
      const result = owner.response("install");
      await fixture.room.webSocketMessage(
        owner.peer.socket,
        encodeTypedFrame(
          FrameType.REQUEST,
          new TextEncoder().encode(
            JSON.stringify({
              id: "install",
              action: "cloud_package_change",
              operation: "add",
              requirement: "six",
            }),
          ),
        ),
      );
      await installing;
      await fixture.execute(owner);
      await owner.sync();
      const queued = Object.entries(owner.runtimeState().executions).find(
        ([, value]) => value.status === "queued",
      );
      assert.ok(queued, "execution is acknowledged while installation is pending");
      if (failure === "needs_restart_checkpoint") {
        const checkpoint = fixture.materializer.checkpoint.bind(fixture.materializer);
        const transition = fixture.materializer.transitionManagedPythonSession.bind(
          fixture.materializer,
        );
        t.mock.method(fixture.materializer, "checkpoint", async () => {
          if (terminalPublication) throw new Error("checkpoint unavailable");
          return checkpoint();
        });
        t.mock.method(
          fixture.materializer,
          "transitionManagedPythonSession",
          (...args: Parameters<typeof transition>) => {
            terminalPublication = false;
            return transition(...args);
          },
        );
      } else if (failure === "needs_restart_publication") {
        t.mock.method(
          fixture.materializer,
          "setCloudPackageState",
          async () => {
            throw new Error("package state publication unavailable");
          },
          { times: 1 },
        );
      }
      release();
      assert.equal((await result).needs_restart, true);
      await fixture.drain();
      await owner.sync();
      const failed = owner.runtimeState();
      assert.equal(failed.executions[queued[0]].status, "cancelled");
      assert.deepEqual(failed.queue.queued, []);
      assert.equal(failed.workstation?.status, "error");
      const ran = fixture.requests.filter((request) => request.path === "/execute").length;
      await fixture.execute(owner);
      await fixture.drain();
      assert.match(String(owner.rejections().at(-1)?.reason), /restart|confirmed/i);
      assert.equal(fixture.requests.filter((request) => request.path === "/execute").length, ran);
      await fixture.startReplacement();
      await fixture.drain();
      await owner.sync();
      assert.equal(owner.runtimeState().workstation?.status, "ready");
      assert.equal(owner.runtimeState().executions[queued[0]].status, "cancelled");
      assert.equal(
        fixture.requests.filter((request) => request.path === "/execute").length,
        ran,
        "recovery does not replay cancelled intent",
      );
      assert.equal(
        (await fixture.materializer.transitionManagedPythonSession("managed-job", "ready"))
          .ignored_stale,
        true,
      );
      await assert.rejects(
        fixture.materializer.compareSetCloudPackageManifest(
          null,
          { version: 1, pyodide: "0.28.3", requirements: ["six"], wheels: [] },
          "managed-job",
        ),
        /session/i,
      );
      assert.equal(await fixture.materializer.getCloudPackageManifest(), null);
    });
  }

  it("terminalizes managed intent without starting compute for a revoked attach-job owner", async (t) => {
    const fixture = await managedPythonAdmissionFixture("connecting", { ownerAuthorized: false });
    t.after(() => fixture.close());
    const owner = await fixture.connect("owner");
    await fixture.seed(owner);
    await fixture.execute(owner);
    await fixture.drain();
    await owner.sync();
    assert.equal(owner.accepted(), true);
    const failed = owner.runtimeState();
    assert.equal(Object.values(failed.executions).length, 1);
    assert.equal(Object.values(failed.executions)[0].status, "cancelled");
    assert.equal(failed.workstation?.status, "error");
    assert.match(failed.workstation?.status_message ?? "", /owner.*access/i);
    assert.deepEqual(fixture.requests, [], "authorization fails before provider /open or /execute");
  });

  it("starts managed Python for an existing queued execution without changing its identity", async (t) => {
    const fixture = await managedPythonAdmissionFixture("ready");
    t.after(() => fixture.close());
    const owner = await fixture.connect("owner");
    await fixture.seed(owner);
    // Model a recovered room whose RuntimeStateDoc already holds accepted work
    // but whose in-memory managed runtime has not been recreated yet.
    const queued = await fixture.materializer.receiveFrame(owner.peer, {
      type: FrameType.REQUEST,
      payload: new TextEncoder().encode(
        JSON.stringify({
          id: "prior-play",
          action: "execute_cell",
          cell_id: initialHostedCellIdForTest("demo"),
        }),
      ),
    });
    for (const frame of queued.outbound)
      if (frame.peer_id === owner.peer.id)
        owner.peer.socket.send(encodeTypedFrame(frame.frame_type, new Uint8Array(frame.payload)));
    await owner.sync();
    const [executionId] = Object.keys(owner.runtimeState().executions);
    assert.ok(executionId);
    assert.equal(owner.runtimeState().executions[executionId].status, "queued");

    await fixture.execute(owner);
    await fixture.openEntered;
    assert.equal(owner.accepted(), true);
    fixture.releaseOpen(Response.json({ ok: true }));
    await fixture.drain();
    await owner.sync();
    assert.deepEqual(Object.keys(owner.runtimeState().executions), [executionId]);
    assert.equal(owner.runtimeState().executions[executionId].status, "done");
    assert.equal(fixture.requests.filter((request) => request.path === "/execute").length, 1);
  });

  for (const pendingStage of ["owner lookup", "package restore"] as const) {
    it(`restarts during ${pendingStage} without letting late startup publish a failure`, async (t) => {
      let enteredPackages!: () => void;
      let releasePackages!: () => void;
      const installing = new Promise<void>((resolve) => {
        enteredPackages = resolve;
      });
      const heldPackages = new Promise<void>((resolve) => {
        releasePackages = resolve;
      });
      const fixture = await managedPythonAdmissionFixture("connecting", {
        holdOwnerLookup: pendingStage === "owner lookup",
        immediateOpen: Response.json({ ok: true }),
        packageResponse: async () => {
          enteredPackages();
          await heldPackages;
          return Response.json({ status: "ready", installed: ["six==1.0"] });
        },
      });
      t.after(async () => {
        releasePackages();
        fixture.releaseOwnerLookup();
        await fixture.close();
      });
      if (pendingStage === "package restore") {
        await fixture.materializer.compareSetCloudPackageManifest(null, {
          version: 1,
          pyodide: "0.28.3",
          requirements: ["six==1.0"],
          wheels: [],
        });
      }
      const owner = await fixture.connect("owner");
      await fixture.seed(owner);
      const observer = await fixture.connect("observer");
      await fixture.execute(owner);
      await (pendingStage === "owner lookup" ? fixture.ownerLookupEntered : installing);
      await owner.sync();
      await observer.sync();
      const [executionId] = Object.keys(owner.runtimeState().executions);
      assert.equal(owner.runtimeState().executions[executionId].status, "queued");
      const offsets = [owner.runtimeHistory.length, observer.runtimeHistory.length];

      const response = await fixture.room.fetch(
        new Request("https://room/internal/n/demo/workstation-attachment", {
          method: "DELETE",
          body: JSON.stringify({ runtime_session_id: "managed-job" }),
        }),
      );
      assert.equal(response.status, 200);
      fixture.releaseOwnerLookup();
      releasePackages();
      await fixture.drain();
      for (const [index, connection] of [owner, observer].entries()) {
        await connection.sync();
        assert.equal(connection.runtimeState().executions[executionId].status, "cancelled");
        assert.equal(connection.runtimeState().workstation?.status, "idle");
        assertNoComputeFailure(connection.runtimeHistory.slice(offsets[index]));
      }
      assert.equal(fixture.db.attachJobs[0].status, "completed");
      assert.equal(fixture.requests.filter((r) => r.path === "/execute").length, 0);
    });
  }

  it("reports a confirmed stop whose checkpoint failed as a recoverable failure", async (t) => {
    const fixture = await managedPythonAdmissionFixture("connecting", {
      immediateOpen: Response.json({ ok: true }),
    });
    t.after(() => fixture.close());
    const owner = await fixture.connect("owner");
    await fixture.seed(owner);
    await fixture.execute(owner);
    await fixture.drain();
    t.mock.method(fixture.materializer, "checkpoint", async () => {
      throw new Error("internal storage detail");
    });
    const response = await fixture.room.fetch(
      new Request("https://room/internal/n/demo/workstation-attachment", {
        method: "DELETE",
        body: JSON.stringify({ runtime_session_id: "managed-job" }),
      }),
    );
    assert.equal(response.status, 503);
    const { error } = (await response.json()) as { error: string };
    assert.match(error, /Python stopped, but recovery could not be saved/);
    await owner.sync();
    assert.equal(owner.runtimeState().workstation?.status, "error");
    assert.equal(owner.runtimeState().workstation?.status_message, error);
    assert.equal(fixture.db.attachJobs[0].status, "completed", "disposal was confirmed");
  });

  it("reports confirmed interrupt checkpoint failure instead of interrupt_sent", async (t) => {
    const fixture = await managedPythonAdmissionFixture("connecting", {
      immediateOpen: Response.json({ ok: true }),
    });
    t.after(() => fixture.close());
    const owner = await fixture.connect("owner");
    await fixture.seed(owner);
    await fixture.execute(owner);
    await fixture.drain();
    t.mock.method(fixture.materializer, "checkpoint", async () => {
      throw new Error("storage failed");
    });
    const response = owner.response("interrupt-failed");
    await fixture.room.webSocketMessage(
      owner.peer.socket,
      encodeTypedFrame(
        FrameType.REQUEST,
        new TextEncoder().encode(
          JSON.stringify({ id: "interrupt-failed", action: "interrupt_execution" }),
        ),
      ),
    );
    const result = await response;
    assert.equal(result.result, "error");
    assert.match(String(result.error), /recovery could not be saved/);
    await owner.sync();
    assert.equal(owner.runtimeState().workstation?.status, "error");
    assert.equal(fixture.db.attachJobs[0].status, "failed");
    assert.ok(fixture.requests.some((request) => request.path === "/close"));
  });

  it("interrupts accepted managed intent while startup is still resolving its owner", async (t) => {
    const fixture = await managedPythonAdmissionFixture("connecting", { holdOwnerLookup: true });
    t.after(() => fixture.close());
    const owner = await fixture.connect("owner");
    await fixture.seed(owner);
    await fixture.execute(owner);
    await fixture.ownerLookupEntered;
    assert.equal(owner.accepted(), true);
    await owner.sync();
    const [executionId] = Object.keys(owner.runtimeState().executions);
    assert.ok(executionId);
    assert.equal(owner.runtimeState().executions[executionId].status, "queued");
    const interrupted = owner.response("interrupt");
    await fixture.room.webSocketMessage(
      owner.peer.socket,
      encodeTypedFrame(
        FrameType.REQUEST,
        new TextEncoder().encode(
          JSON.stringify({ id: "interrupt", action: "interrupt_execution" }),
        ),
      ),
    );
    assert.equal((await interrupted).result, "interrupt_sent");
    await owner.sync();
    assert.equal(owner.runtimeState().executions[executionId].status, "cancelled");
    assert.equal(owner.runtimeState().workstation?.status, "error");
    fixture.releaseOwnerLookup();
    await fixture.drain();
    await owner.sync();
    assert.equal(owner.runtimeState().executions[executionId].status, "cancelled");
    assert.deepEqual(
      fixture.requests.map((request) => request.path),
      ["/close"],
      "late startup cannot open or execute compute after Interrupt",
    );
    assert.equal(fixture.requests[0].sessionId, "managed-job");
    assert.equal(fixture.requests[0].ownerPrincipal, "user:dev:alice");
  });

  it("reports unconfirmed termination when restored managed Python cannot be closed", async (t) => {
    const fixture = await managedPythonAdmissionFixture("ready", {
      closeResponse: Response.json({ error: "termination unavailable" }, { status: 503 }),
    });
    t.after(() => fixture.close());
    const owner = await fixture.connect("owner");
    const interrupted = owner.response("interrupt");
    await fixture.room.webSocketMessage(
      owner.peer.socket,
      encodeTypedFrame(
        FrameType.REQUEST,
        new TextEncoder().encode(
          JSON.stringify({ id: "interrupt", action: "interrupt_execution" }),
        ),
      ),
    );
    const response = await interrupted;
    assert.equal(response.result, "error");
    assert.match(String(response.error), /termination was not confirmed/);
    assert.deepEqual(
      fixture.requests.map((request) => request.path),
      ["/close"],
    );
    assert.equal(fixture.requests[0].sessionId, "managed-job");
    assert.equal(fixture.requests[0].ownerPrincipal, "user:dev:alice");
    await owner.sync();
    assert.equal(owner.runtimeState().workstation?.status, "disconnected");
    assert.equal(
      fixture.db.attachJobs[0].status,
      "accepted",
      "unconfirmed disposal cannot free catalog admission",
    );
  });

  it("preserves startup errors and accepts a retry on the same peer", async () => {
    const room = new NotebookRoom(fakeState(), {} as Env);
    const identity = authenticateDevRequest(
      new Request("https://cloud.test/n/demo/sync?user=alice&operator=browser:a&scope=owner"),
    );
    const socket = new FakeSocket();
    const peer = {
      id: "owner",
      socket: socket.asCloudflareWebSocket(),
      identity,
      connectedAt: "2026-05-22T00:00:00.000Z",
      consecutiveRejectedFrames: 0,
    };
    const harness = roomHarness(room);
    let materialized = 0;
    let reconciled = 0;
    let failed = true;
    harness.materializers.set("demo", {
      receiveFrame: async () => {
        materialized += 1;
        return noopMaterializedResult();
      },
      checkpoint: async () => undefined,
      removePeer: async () => undefined,
      getWorkstationAttachment: async () => ({
        workstation_id: "ws-lab",
        display_name: "Lab",
        provider: "runtime_peer",
        default_environment_label: "Current Python",
        environment_policy: "current_python",
        status: failed ? "error" : "connecting",
        status_message: failed ? "Your Python session limit was reached." : null,
        cpu_count: null,
        memory_bytes: null,
        working_directory: null,
        updated_at: "2026-05-22T00:00:00.000Z",
        runtime_session_id: "job-new",
      }),
      reconcileRuntimePeerGone: async () => {
        reconciled += 1;
        return noopMaterializedResult();
      },
    } as never);

    harness.peers.set(peer.id, peer);
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
    assert.equal(materialized, 0);
    assert.equal(reconciled, 0);
    const rejected = decodeJsonPayload<Record<string, unknown>>(socket.sent[0].slice(1));
    assert.equal(rejected.reason, "Your Python session limit was reached.");
    failed = false;
    socket.sent.length = 0;
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

    assert.equal(materialized, 1, "connecting attach may queue initial execution");
    assert.equal(reconciled, 0);
    assert.equal(peer.consecutiveRejectedFrames, 0);
    assert.equal(socket.sent.length, 1);
    const accepted = decodeJsonPayload<Record<string, unknown>>(socket.sent[0].slice(1));
    assert.equal(accepted.type, "cloud_frame_accepted");
  });

  it("creates an owner-scoped resume attach job when owner execution finds no runtime peer", async () => {
    const db = new ResumeNotebookD1();
    const room = new NotebookRoom(fakeState(), { DB: db } as unknown as Env);
    const identity = authenticateDevRequest(
      new Request("https://cloud.test/n/demo/sync?user=alice&operator=browser:a&scope=owner"),
    );
    const socket = new FakeSocket();
    const peer = {
      id: "owner",
      socket: socket.asCloudflareWebSocket(),
      identity,
      connectedAt: "2026-05-22T00:00:00.000Z",
      consecutiveRejectedFrames: 0,
    };
    const harness = roomHarness(room);
    let materialized = 0;
    let publishedAttachment: unknown = null;
    harness.materializers.set("demo", {
      receiveFrame: async () => {
        materialized += 1;
        return noopMaterializedResult();
      },
      checkpoint: async () => undefined,
      removePeer: async () => undefined,
      getWorkstationAttachment: async () => ({
        workstation_id: "ws-lab2",
        display_name: "Lab2",
        provider: "runtime_peer",
        default_environment_label: "Current Python",
        environment_policy: "current_python",
        status: "disconnected",
        status_message: "Compute stopped after 30 minutes without queued or active execution.",
        cpu_count: null,
        memory_bytes: null,
        working_directory: "/srv/project",
        updated_at: "2026-05-22T00:00:00.000Z",
        runtime_session_id: "job-old",
      }),
      setWorkstationAttachment: async (attachment: unknown) => {
        publishedAttachment = attachment;
        return {
          ...noopMaterializedResult(),
          changed: true,
          runtime_state_changed: true,
        };
      },
    } as never);

    harness.peers.set(peer.id, peer);
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
    assert.equal(db.attachJobs.length, 1);
    assert.equal(db.attachJobs[0]?.owner_principal, "user:dev:alice");
    assert.equal(db.attachJobs[0]?.trigger, "resume");
    assert.equal(db.attachJobs[0]?.requested_by_actor_label, "execution resume");
    assert.equal((publishedAttachment as { status?: string })?.status, "connecting");
    assert.equal(
      (publishedAttachment as { runtime_session_id?: string })?.runtime_session_id,
      db.attachJobs[0]?.id,
    );
    const accepted = decodeJsonPayload<Record<string, unknown>>(socket.sent[0].slice(1));
    assert.equal(accepted.type, "cloud_frame_accepted");
  });

  it("creates an owner-scoped resume attach job when idle owner execution finds no runtime peer", async () => {
    const db = new ResumeNotebookD1();
    const room = new NotebookRoom(fakeState(), { DB: db } as unknown as Env);
    const identity = authenticateDevRequest(
      new Request("https://cloud.test/n/demo/sync?user=alice&operator=browser:a&scope=owner"),
    );
    const socket = new FakeSocket();
    const peer = {
      id: "owner",
      socket: socket.asCloudflareWebSocket(),
      identity,
      connectedAt: "2026-05-22T00:00:00.000Z",
      consecutiveRejectedFrames: 0,
    };
    const harness = roomHarness(room);
    let materialized = 0;
    let publishedAttachment: unknown = null;
    harness.materializers.set("demo", {
      receiveFrame: async () => {
        materialized += 1;
        return noopMaterializedResult();
      },
      checkpoint: async () => undefined,
      removePeer: async () => undefined,
      getWorkstationAttachment: async () => ({
        workstation_id: "ws-lab2",
        display_name: "Lab2",
        provider: "runtime_peer",
        default_environment_label: "Current Python",
        environment_policy: "current_python",
        status: "idle",
        status_message: "Compute stopped after 30 minutes without queued or active execution.",
        cpu_count: null,
        memory_bytes: null,
        working_directory: "/srv/project",
        updated_at: "2026-05-22T00:00:00.000Z",
        runtime_session_id: "job-old",
      }),
      setWorkstationAttachment: async (attachment: unknown) => {
        publishedAttachment = attachment;
        return {
          ...noopMaterializedResult(),
          changed: true,
          runtime_state_changed: true,
        };
      },
    } as never);

    harness.peers.set(peer.id, peer);
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
    assert.equal(db.attachJobs.length, 1);
    assert.equal(db.attachJobs[0]?.owner_principal, "user:dev:alice");
    assert.equal(db.attachJobs[0]?.trigger, "resume");
    assert.equal(db.attachJobs[0]?.requested_by_actor_label, "execution resume");
    assert.equal((publishedAttachment as { status?: string })?.status, "connecting");
    assert.equal(
      (publishedAttachment as { runtime_session_id?: string })?.runtime_session_id,
      db.attachJobs[0]?.id,
    );
    assert.equal(
      await harness.runtimePeerAuthorityError?.("demo", {
        workstationId: "ws-lab2",
        runtimeSessionId: db.attachJobs[0]?.id,
      }),
      null,
    );
    const accepted = decodeJsonPayload<Record<string, unknown>>(socket.sent[0].slice(1));
    assert.equal(accepted.type, "cloud_frame_accepted");
  });

  it("admits owner execution after real idle reconciliation idles the attachment", async () => {
    const db = new ResumeNotebookD1();
    const state = fakeState();
    const env = { DB: db } as unknown as Env;
    const room = new NotebookRoom(state, env);
    const materializer = new RoomMaterializer("demo", state, env);
    const harness = roomHarness(room);
    harness.materializers.set("demo", materializer as never);
    await materializer.setWorkstationAttachment({
      workstation_id: "ws-lab2",
      display_name: "Lab2",
      provider: "runtime_peer",
      default_environment_label: "Current Python",
      environment_policy: "current_python",
      status: "ready",
      status_message: null,
      cpu_count: null,
      memory_bytes: null,
      working_directory: "/srv/project",
      updated_at: "2026-05-22T00:00:00.000Z",
      runtime_session_id: "job-old",
    });

    const idleResult = await materializer.reconcileRuntimeIdleTimeout(
      "Compute stopped after 30 minutes without queued or active execution.",
      "2026-07-08T00:30:00.000Z",
    );
    assert.equal(idleResult.changed, true);
    assert.equal((await materializer.getWorkstationAttachment())?.status, "idle");

    const identity = authenticateDevRequest(
      new Request("https://cloud.test/n/demo/sync?user=alice&operator=browser:a&scope=owner"),
    );
    const socket = new FakeSocket();
    const peer = {
      id: "owner",
      socket: socket.asCloudflareWebSocket(),
      identity,
      connectedAt: "2026-05-22T00:00:00.000Z",
      consecutiveRejectedFrames: 0,
    };

    harness.peers.set(peer.id, peer);
    await harness.handleMessage(
      "demo",
      peer,
      encodeTypedFrame(
        FrameType.REQUEST,
        new TextEncoder().encode(
          JSON.stringify({
            id: "request-1",
            action: "execute_cell",
            cell_id: initialHostedCellIdForTest("demo"),
          }),
        ),
      ),
    );

    assert.equal(db.attachJobs.length, 1);
    const attachment = await materializer.getWorkstationAttachment();
    assert.equal(attachment?.status, "connecting");
    assert.equal(attachment?.runtime_session_id, db.attachJobs[0]?.id);
    const accepted = socket.sent
      .filter((frame) => frame[0] === FrameType.SESSION_CONTROL)
      .map((frame) => decodeJsonPayload<Record<string, unknown>>(frame.slice(1)))
      .find((control) => control.type === "cloud_frame_accepted");
    assert.ok(accepted);
    assert.equal(accepted.type, "cloud_frame_accepted");
  });

  it("creates a resume attach job after grace reconciliation disconnects compute", async () => {
    const db = new ResumeNotebookD1();
    const state = alarmCapableState();
    const env = { DB: db } as unknown as Env;
    const room = new NotebookRoom(state.state, env);
    const materializer = new RoomMaterializer("demo", state.state, env);
    const harness = roomHarness(room);
    harness.materializers.set("demo", materializer as never);
    await materializer.setWorkstationAttachment({
      workstation_id: "ws-lab2",
      display_name: "Lab2",
      provider: "runtime_peer",
      default_environment_label: "Current Python",
      environment_policy: "current_python",
      status: "ready",
      status_message: null,
      cpu_count: null,
      memory_bytes: null,
      working_directory: "/srv/project",
      updated_at: "2026-05-22T00:00:00.000Z",
      runtime_session_id: "job-old",
    });

    const runtimePeer = {
      id: "runtime",
      socket: new FakeSocket().asCloudflareWebSocket(),
      identity: authenticateDevRequest(
        new Request(
          "https://cloud.test/n/demo/sync?user=alice&operator=runtime:py&scope=runtime_peer",
        ),
      ),
      connectedAt: "2026-05-22T00:00:01.000Z",
      consecutiveRejectedFrames: 0,
    };
    harness.peers.set(runtimePeer.id, runtimePeer);
    harness.removePeer("demo", runtimePeer);
    await state.drain();
    assert.equal(await state.getAlarm(), state.now + 30_000, "watch armed after departure");

    await (room as unknown as { alarm(): Promise<void> }).alarm();
    await state.drain();
    const disconnectedAttachment = await materializer.getWorkstationAttachment();
    assert.equal(disconnectedAttachment?.status, "disconnected");
    assert.equal(
      disconnectedAttachment?.status_message,
      "compute disconnected: runtime peer left the room and did not return within the grace window",
    );
    assert.equal(disconnectedAttachment?.runtime_session_id, "job-old");
    assert.equal(disconnectedAttachment?.updated_at, "2026-05-22T00:00:00.000Z");

    const identity = authenticateDevRequest(
      new Request("https://cloud.test/n/demo/sync?user=alice&operator=browser:a&scope=owner"),
    );
    const socket = new FakeSocket();
    const ownerPeer = {
      id: "owner",
      socket: socket.asCloudflareWebSocket(),
      identity,
      connectedAt: "2026-05-22T00:00:02.000Z",
      consecutiveRejectedFrames: 0,
    };

    harness.peers.set(ownerPeer.id, ownerPeer);
    await harness.handleMessage(
      "demo",
      ownerPeer,
      encodeTypedFrame(
        FrameType.REQUEST,
        new TextEncoder().encode(
          JSON.stringify({
            id: "request-1",
            action: "execute_cell",
            cell_id: initialHostedCellIdForTest("demo"),
          }),
        ),
      ),
    );

    assert.equal(db.attachJobs.length, 1);
    assert.equal(db.attachJobs[0]?.trigger, "resume");
    assert.equal(db.attachJobs[0]?.requested_by_actor_label, "execution resume");
    const reconnectingAttachment = await materializer.getWorkstationAttachment();
    assert.equal(reconnectingAttachment?.status, "connecting");
    assert.equal(reconnectingAttachment?.runtime_session_id, db.attachJobs[0]?.id);
    const accepted = socket.sent
      .filter((frame) => frame[0] === FrameType.SESSION_CONTROL)
      .map((frame) => decodeJsonPayload<Record<string, unknown>>(frame.slice(1)))
      .find((control) => control.type === "cloud_frame_accepted");
    assert.ok(accepted);
    assert.equal(accepted.type, "cloud_frame_accepted");
  });

  it("rejects non-owner execution without creating a resume attach job", async () => {
    const db = new ResumeNotebookD1();
    const room = new NotebookRoom(fakeState(), { DB: db } as unknown as Env);
    const identity = authenticateDevRequest(
      new Request("https://cloud.test/n/demo/sync?user=alice&operator=browser:a&scope=editor"),
    );
    const socket = new FakeSocket();
    const peer = {
      id: "editor",
      socket: socket.asCloudflareWebSocket(),
      identity,
      connectedAt: "2026-05-22T00:00:00.000Z",
      consecutiveRejectedFrames: 0,
    };
    const harness = roomHarness(room);
    harness.materializers.set("demo", {
      receiveFrame: async () => {
        throw new Error("non-owner execution should not reach the room host");
      },
      checkpoint: async () => undefined,
      removePeer: async () => undefined,
      getWorkstationAttachment: async () => {
        throw new Error("non-owner execution should not inspect workstation attachment");
      },
    } as never);

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

    assert.equal(db.attachJobs.length, 0);
    const rejected = decodeJsonPayload<Record<string, unknown>>(socket.sent[0].slice(1));
    assert.equal(rejected.type, "cloud_frame_rejected");
    assert.equal(rejected.reason, "editor cannot write request frames");
    assert.equal(rejected.request_id, "request-1");
    assert.equal(rejected.action, "execute_cell");
  });

  it("rejects response-bearing runtime REQUEST frames instead of acknowledging no-ops", async () => {
    const room = new NotebookRoom(fakeState(), {} as Env);
    const identity = authenticateDevRequest(
      new Request("https://cloud.test/n/demo/sync?user=alice&operator=browser:a&scope=owner"),
    );
    const socket = new FakeSocket();
    const peer = {
      id: "owner",
      socket: socket.asCloudflareWebSocket(),
      identity,
      connectedAt: "2026-05-22T00:00:00.000Z",
      consecutiveRejectedFrames: 0,
    };
    const harness = roomHarness(room);
    let materialized = 0;
    harness.materializers.set("demo", {
      receiveFrame: async () => {
        materialized += 1;
        return noopMaterializedResult();
      },
      checkpoint: async () => undefined,
      removePeer: async () => undefined,
    });

    const unsupportedActions = [
      "launch_kernel",
      "restart_kernel",
      "shutdown_kernel",
      "sync_environment",
      "get_history",
    ] as const;

    for (const action of unsupportedActions) {
      await harness.handleMessage(
        "demo",
        peer,
        encodeTypedFrame(
          FrameType.REQUEST,
          new TextEncoder().encode(JSON.stringify({ id: `request-${action}`, action })),
        ),
      );

      assert.equal(materialized, 0);
      assert.equal(peer.consecutiveRejectedFrames, 0);
      assert.equal(socket.sent.length, unsupportedActions.indexOf(action) + 1);
      const rejected = decodeJsonPayload<Record<string, unknown>>(socket.sent.at(-1)!.slice(1));
      assert.equal(rejected.type, "cloud_frame_rejected");
      assert.equal(
        rejected.reason,
        `hosted cloud rooms do not yet support response-bearing runtime request ${action}`,
      );
    }
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
      harness.peers.set(peer.id, peer);
      let materialized = 0;
      harness.materializers.set("demo", {
        receiveFrame: async () => {
          materialized += 1;
          return noopMaterializedResult();
        },
        checkpoint: async () => undefined,
      });

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
      assert.equal(socket.sent.length, 1);
      const rejected = decodeJsonPayload<Record<string, unknown>>(socket.sent[0].slice(1));
      assert.equal(rejected.type, "cloud_frame_rejected");
      assert.equal(rejected.reason, `${scope} cannot write request frames`);
      await harness.handleMessage(
        "demo",
        peer,
        encodeTypedFrame(
          FrameType.REQUEST,
          new TextEncoder().encode(
            JSON.stringify({
              id: "package-1",
              action: "cloud_package_change",
              operation: "add",
              requirement: "six",
            }),
          ),
        ),
      );
      assert.equal(materialized, 0, `${scope} package request reached room host`);
      const packageRejected = decodeJsonPayload<Record<string, unknown>>(
        socket.sent.at(-1)!.slice(1),
      );
      assert.equal(packageRejected.type, "cloud_frame_rejected");
      assert.equal(packageRejected.reason, `${scope} cannot write request frames`);
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
    harness.peers.set(peer.id, peer);

    await harness.handleMessage(
      "demo",
      peer,
      encodeTypedFrame(FrameType.PUT_BLOB, new Uint8Array([1, 2, 3])),
    );

    assert.equal(socket.sent.length, 1);
    assert.equal(
      decodeJsonPayload<Record<string, unknown>>(socket.sent[0].slice(1)).type,
      "cloud_frame_accepted",
    );
  });

  it("closes stale runtime sessions before they can author room frames", async () => {
    const room = new NotebookRoom(fakeState(), {} as Env);
    const harness = roomHarness(room);
    const socket = new FakeSocket();
    const runtimePeer = {
      id: "runtime",
      socket: socket.asCloudflareWebSocket(),
      identity: authenticateDevRequest(
        new Request(
          "https://cloud.test/n/demo/sync?user=runtime&operator=runtime:py&scope=runtime_peer",
        ),
      ),
      connectedAt: "2026-05-22T00:00:00.000Z",
      workstation: {
        workstationId: "lab2",
        runtimeSessionId: "old-job",
      },
    };
    harness.peers.set(runtimePeer.id, runtimePeer);

    let materialized = 0;
    harness.materializers.set("demo", {
      receiveFrame: async () => {
        materialized += 1;
        return noopMaterializedResult();
      },
      checkpoint: async () => undefined,
      removePeer: async () => undefined,
      getWorkstationAttachment: async () => ({
        workstation_id: "lab2",
        display_name: "Lab2 workstation",
        provider: "runtime_peer",
        default_environment_label: "Current Python",
        environment_policy: "current_python",
        status: "ready",
        status_message: null,
        cpu_count: null,
        memory_bytes: null,
        working_directory: "/home/ubuntu/codex/nteract",
        runtime_session_id: "new-job",
        updated_at: "2026-06-07T00:00:00.000Z",
      }),
    } as never);

    await harness.handleMessage(
      "demo",
      runtimePeer,
      encodeTypedFrame(FrameType.RUNTIME_STATE_SYNC, new Uint8Array([1])),
    );

    assert.equal(materialized, 0, "stale runtime frame reached room host");
    assert.equal(socket.sent.length, 0, "stale runtime frame was not echoed");
    assert.equal(socket.closed, true);
    assert.equal(socket.closeCode, 1008);
    assert.equal(socket.closeReason, "stale runtime session");
    assert.equal(harness.peerForSocket(socket.asCloudflareWebSocket()), undefined);
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
      getWorkstationAttachment: async () => null,
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

  it("skips peer-gone reconcile when idle teardown already materialized", async () => {
    const state = alarmCapableState();
    const room = new NotebookRoom(state.state, {} as Env);
    const harness = roomHarness(room);
    const attachment = {
      workstation_id: "ws-lab2",
      display_name: "Lab2",
      provider: "runtime_peer",
      default_environment_label: "Current Python",
      environment_policy: "current_python",
      status: "idle",
      status_message: "Compute stopped after 30 minutes without queued or active execution.",
      updated_at: "2026-05-22T00:00:02.000Z",
      runtime_session_id: "job-idle",
    };
    let reconcileCalls = 0;
    harness.materializers.set("demo", {
      receiveFrame: async () => noopMaterializedResult(),
      checkpoint: async () => undefined,
      removePeer: async () => undefined,
      getWorkstationAttachment: async () => attachment,
      reconcileRuntimePeerGone: async () => {
        reconcileCalls += 1;
        attachment.status = "disconnected";
        attachment.status_message = "compute disconnected: runtime peer disconnected";
        return {
          ...noopMaterializedResult(),
          changed: true,
          runtime_state_changed: true,
        };
      },
    } as never);

    const runtimePeer = peerWithScope("rt", "runtime_peer");
    harness.peers.set(runtimePeer.id, runtimePeer);
    harness.removePeer("demo", runtimePeer);
    await state.drain();
    assert.equal(await state.getAlarm(), state.now + 30_000, "watch armed after departure");

    const logs: unknown[][] = [];
    const originalInfo = console.info;
    console.info = (...args: unknown[]) => {
      logs.push(args);
    };
    try {
      await (room as unknown as { alarm(): Promise<void> }).alarm();
      await state.drain();
    } finally {
      console.info = originalInfo;
    }

    assert.equal(reconcileCalls, 0, "idle attachment suppresses peer-gone reconcile");
    assert.equal(attachment.status, "idle");
    assert.equal(attachment.runtime_session_id, "job-idle");
    assert.equal(attachment.updated_at, "2026-05-22T00:00:02.000Z");
    const skipLog = logs
      .map((args) => args[1])
      .find(
        (record): record is { event?: unknown; counter?: unknown } =>
          typeof record === "object" &&
          record !== null &&
          (record as { counter?: unknown }).counter === "runtime_peer_watch_skipped_idle",
      );
    assert.equal(skipLog?.event, "room.runtime_peer_watch.skipped_idle");
  });

  it("tears down an idle runtime after the TTL without considering viewer sockets", async () => {
    const state = alarmCapableState();
    const room = new NotebookRoom(state.state, {} as Env);
    const harness = roomHarness(room);
    const runtimeSocket = new FakeSocket();
    const viewerSocket = new FakeSocket();
    const runtimePeer = peerWithScope("rt", "runtime_peer");
    runtimePeer.socket = runtimeSocket.asCloudflareWebSocket();
    const viewerPeer = peerWithScope("viewer", "viewer");
    viewerPeer.socket = viewerSocket.asCloudflareWebSocket();
    harness.peers.set(runtimePeer.id, runtimePeer);
    harness.peers.set(viewerPeer.id, viewerPeer);
    let idleReconciles = 0;
    harness.materializers.set("demo", {
      receiveFrame: async () => noopMaterializedResult(),
      checkpoint: async () => undefined,
      removePeer: async () => undefined,
      getRuntimeExecutionActivity: async () => ({ executing: false, queueDepth: 0 }),
      reconcileRuntimeIdleTimeout: async () => {
        idleReconciles += 1;
        return {
          ...noopMaterializedResult(),
          changed: true,
          runtime_state_changed: true,
          outbound: [
            {
              peer_id: "rt",
              frame_type: FrameType.RUNTIME_STATE_SYNC,
              payload: new Uint8Array([7, 8, 9]),
            },
          ],
        };
      },
      getWorkstationAttachment: async () => ({
        workstation_id: "ws-lab2",
        display_name: "Lab2",
        provider: "runtime_peer",
        default_environment_label: "Current Python",
        environment_policy: "current_python",
        status: "ready",
        status_message: null,
        updated_at: "2026-05-22T00:00:00.000Z",
        runtime_session_id: "job-idle",
      }),
    } as never);

    harness.refreshRuntimeIdleWatch?.("demo");
    await state.drain();

    assert.equal(await state.getAlarm(), state.now + RUNTIME_IDLE_TTL_MS);

    await (room as unknown as { alarm(): Promise<void> }).alarm();
    await state.drain();

    assert.equal(idleReconciles, 1);
    assert.deepEqual([...runtimeSocket.sent[0]], [FrameType.RUNTIME_STATE_SYNC, 7, 8, 9]);
    assert.equal(runtimeSocket.closed, true);
    assert.equal(runtimeSocket.closeReason, "runtime idle timeout");
    assert.equal(viewerSocket.closed, false, "viewer presence must not defer idle teardown");
  });

  it("clears a racing peer-gone watch after idle teardown owns the room state", async () => {
    const state = alarmCapableState();
    const room = new NotebookRoom(state.state, {} as Env);
    const harness = roomHarness(room);
    const runtimeSocket = new FakeSocket();
    const runtimePeer = peerWithScope("rt", "runtime_peer");
    runtimePeer.socket = runtimeSocket.asCloudflareWebSocket();
    harness.peers.set(runtimePeer.id, runtimePeer);
    let idleReconciles = 0;
    harness.materializers.set("demo", {
      receiveFrame: async () => noopMaterializedResult(),
      checkpoint: async () => undefined,
      removePeer: async () => undefined,
      getRuntimeExecutionActivity: async () => ({ executing: false, queueDepth: 0 }),
      reconcileRuntimeIdleTimeout: async () => {
        idleReconciles += 1;
        return {
          ...noopMaterializedResult(),
          changed: true,
          runtime_state_changed: true,
        };
      },
    } as never);

    await state.state.storage.put("runtime_peer_gone_watch", "demo");
    await state.state.storage.put("runtime_peer_gone_watch_alarm_at", Number.MAX_SAFE_INTEGER);
    await state.state.storage.put("runtime_idle_watch", "demo");
    await state.state.storage.put("runtime_idle_watch_alarm_at", 0);

    await (room as unknown as { alarm(): Promise<void> }).alarm();
    await state.drain();

    assert.equal(idleReconciles, 1);
    assert.equal(runtimeSocket.closed, true);
    assert.equal(runtimeSocket.closeReason, "runtime idle timeout");
    assert.equal(await state.state.storage.get("runtime_peer_gone_watch"), undefined);
    assert.equal(await state.state.storage.get("runtime_peer_gone_watch_alarm_at"), undefined);
    assert.equal(await state.getAlarm(), null);
  });

  it("suppresses peer-gone watch when idle teardown drops a dead runtime socket", async () => {
    const state = alarmCapableState();
    const room = new NotebookRoom(state.state, {} as Env);
    const harness = roomHarness(room);
    const runtimeSocket = new FakeSocket({ throwOnSend: true });
    const runtimePeer = peerWithScope("rt", "runtime_peer");
    runtimePeer.socket = runtimeSocket.asCloudflareWebSocket();
    harness.peers.set(runtimePeer.id, runtimePeer);
    let idleReconciles = 0;
    let peerGoneReconciles = 0;
    let peerWatchRefreshes = 0;
    const peerWatchSpy = room as unknown as {
      refreshRuntimePeerWatch(notebookId: string): void;
    };
    const originalRefreshRuntimePeerWatch = peerWatchSpy.refreshRuntimePeerWatch.bind(room);
    peerWatchSpy.refreshRuntimePeerWatch = (notebookId: string) => {
      peerWatchRefreshes += 1;
      originalRefreshRuntimePeerWatch(notebookId);
    };
    harness.materializers.set("demo", {
      receiveFrame: async () => noopMaterializedResult(),
      checkpoint: async () => undefined,
      removePeer: async () => undefined,
      getRuntimeExecutionActivity: async () => ({ executing: false, queueDepth: 0 }),
      reconcileRuntimeIdleTimeout: async () => {
        idleReconciles += 1;
        return {
          ...noopMaterializedResult(),
          changed: true,
          runtime_state_changed: true,
          outbound: [
            {
              peer_id: "rt",
              frame_type: FrameType.RUNTIME_STATE_SYNC,
              payload: new Uint8Array([7, 8, 9]),
            },
          ],
        };
      },
      reconcileRuntimePeerGone: async () => {
        peerGoneReconciles += 1;
        return noopMaterializedResult();
      },
    } as never);

    harness.refreshRuntimeIdleWatch?.("demo");
    await state.drain();

    await (room as unknown as { alarm(): Promise<void> }).alarm();
    await state.drain();
    await (room as unknown as { alarm(): Promise<void> }).alarm();
    await state.drain();

    assert.equal(idleReconciles, 1);
    assert.equal(peerWatchRefreshes, 0, "send failure must not arm peer-gone watch");
    assert.equal(peerGoneReconciles, 0, "no peer-gone reconcile follows idle teardown");
    assert.equal(harness.peers.has(runtimePeer.id), false);
    assert.equal(runtimeSocket.closed, true);
    assert.equal(await state.state.storage.get("runtime_peer_gone_watch"), undefined);
    assert.equal(await state.state.storage.get("runtime_peer_gone_watch_alarm_at"), undefined);
    assert.equal(await state.getAlarm(), null);
  });

  it("rearms idle cleanup when managed Python publishes completion", async () => {
    const state = alarmCapableState();
    const room = new NotebookRoom(state.state, {} as Env);
    const harness = roomHarness(room);
    harness.peers.set("rt", peerWithScope("rt", "runtime_peer"));
    let executing = true;
    harness.materializers.set("demo", {
      getRuntimeExecutionActivity: async () => ({ executing, queueDepth: executing ? 1 : 0 }),
    } as never);
    const publish = () =>
      (
        room as unknown as {
          deliverManagedPythonPublication(
            notebookId: string,
            result: ReturnType<typeof noopMaterializedResult>,
          ): void;
        }
      ).deliverManagedPythonPublication("demo", {
        ...noopMaterializedResult(),
        runtime_state_changed: true,
      });
    publish();
    await state.drain();
    assert.equal(await state.getAlarm(), null);
    executing = false;
    const completedAt = Date.now();
    publish();
    await state.drain();
    const deadline = await state.getAlarm();
    assert.ok(deadline! >= completedAt + RUNTIME_IDLE_TTL_MS);
    assert.ok(deadline! <= Date.now() + RUNTIME_IDLE_TTL_MS);
  });

  it("does not arm idle teardown while execution is active or queued", async () => {
    const state = alarmCapableState();
    const room = new NotebookRoom(state.state, {} as Env);
    const harness = roomHarness(room);
    harness.peers.set("rt", peerWithScope("rt", "runtime_peer"));
    harness.materializers.set("demo", {
      receiveFrame: async () => noopMaterializedResult(),
      checkpoint: async () => undefined,
      removePeer: async () => undefined,
      getRuntimeExecutionActivity: async () => ({ executing: true, queueDepth: 1 }),
    } as never);

    harness.refreshRuntimeIdleWatch?.("demo");
    await state.drain();

    assert.equal(await state.getAlarm(), null);
  });

  it("preserves a future idle deadline while the runtime peer is transiently absent", async () => {
    const state = alarmCapableState();
    const room = new NotebookRoom(state.state, {} as Env);
    const harness = roomHarness(room);
    let idleReconciles = 0;
    harness.materializers.set("demo", {
      receiveFrame: async () => noopMaterializedResult(),
      checkpoint: async () => undefined,
      removePeer: async () => undefined,
      getRuntimeExecutionActivity: async () => ({ executing: false, queueDepth: 0 }),
      reconcileRuntimeIdleTimeout: async () => {
        idleReconciles += 1;
        return noopMaterializedResult();
      },
    } as never);
    const existingAlarmAt = state.now + RUNTIME_IDLE_TTL_MS / 2;
    await state.state.storage.put("runtime_idle_watch", "demo");
    await state.state.storage.put("runtime_idle_watch_alarm_at", existingAlarmAt);
    await state.state.storage.setAlarm?.(existingAlarmAt);

    harness.refreshRuntimeIdleWatch?.("demo");
    await state.drain();

    assert.equal(await state.state.storage.get("runtime_idle_watch"), "demo");
    assert.equal(await state.state.storage.get("runtime_idle_watch_alarm_at"), existingAlarmAt);
    assert.equal(await state.getAlarm(), existingAlarmAt);

    await state.state.storage.put("runtime_idle_watch_alarm_at", 0);
    await state.state.storage.setAlarm?.(0);
    await assert.doesNotReject(async () => {
      await (room as unknown as { alarm(): Promise<void> }).alarm();
      await state.drain();
    });

    assert.equal(idleReconciles, 0, "peerless idle alarm is a no-op");
    assert.equal(await state.state.storage.get("runtime_idle_watch"), undefined);
    assert.equal(await state.state.storage.get("runtime_idle_watch_alarm_at"), undefined);
    assert.equal(await state.getAlarm(), null);
  });

  it("publishes active runtime peers to the owner compute index", async () => {
    const compute = new FakeOwnerComputeIndexNamespace();
    const env = roomEnvWithComputeIndex(compute);
    const room = new NotebookRoom(fakeState(), env);
    const harness = roomHarness(room);
    const runtimePeer = {
      ...peerWithScope("rt", "runtime_peer"),
      workstation: {
        workstationId: "ws-lab2",
        displayName: "lab2 workstation",
        defaultEnvironmentLabel: "Current Python",
        environmentPolicy: "current_python",
        runtimeSessionId: "job-1",
        workingDirectory: "/home/ubuntu/project",
      },
    };
    harness.peers.set(runtimePeer.id, runtimePeer);
    let currentAttachment: unknown = null;
    harness.materializers.set("demo", {
      receiveFrame: async () => noopMaterializedResult(),
      checkpoint: async () => undefined,
      setWorkstationAttachment: async (attachment: unknown) => {
        currentAttachment = attachment;
        return {
          ...noopMaterializedResult(),
          changed: true,
          runtime_state_changed: true,
        };
      },
      getWorkstationAttachment: async () => currentAttachment,
      getRuntimeQueueDepth: async () => 2,
    } as never);

    await harness.publishRuntimePeerAttachment("demo", runtimePeer);

    assert.deepEqual(
      compute.requests.map((request) => [
        request.objectName,
        new URL(request.url).pathname,
        request.body?.summary?.status,
        request.body?.summary?.queue_depth,
        request.body?.summary?.runtime_peer_count,
        request.body?.summary?.workstation_id,
      ]),
      [["owner-compute:v1:user:dev:alice", "/upsert", "active", 2, 1, "ws-lab2"]],
    );
  });

  it("publishes stale compute when the last runtime peer leaves", async () => {
    const state = hibernatedState([]);
    const compute = new FakeOwnerComputeIndexNamespace();
    const env = roomEnvWithComputeIndex(compute);
    const room = new NotebookRoom(state.state, env);
    const harness = roomHarness(room);
    const runtimePeer = peerWithScope("rt", "runtime_peer");
    harness.peers.set(runtimePeer.id, runtimePeer);
    harness.materializers.set("demo", {
      receiveFrame: async () => noopMaterializedResult(),
      checkpoint: async () => undefined,
      getWorkstationAttachment: async () => ({
        workstation_id: "ws-lab2",
        display_name: "lab2 workstation",
        provider: "runtime_peer",
        default_environment_label: "Current Python",
        environment_policy: "current_python",
        status: "ready",
        status_message: null,
        updated_at: "2026-06-23T00:00:00.000Z",
        runtime_session_id: "job-1",
      }),
      getRuntimeQueueDepth: async () => 1,
      removePeer: async () => undefined,
      reconcileRuntimePeerGone: async () => noopMaterializedResult(),
    } as never);

    harness.removePeer("demo", runtimePeer);
    await state.drain();

    const staleRequest = compute.requests.find(
      (request) => request.body?.summary?.status === "stale",
    );
    assert.equal(staleRequest?.objectName, "owner-compute:v1:user:dev:alice");
    assert.equal(staleRequest?.body?.summary?.queue_depth, 1);
    assert.equal(staleRequest?.body?.summary?.runtime_peer_count, 0);
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

  it("runs manual runtime-state repair through the internal room-host control path", async () => {
    const state = hibernatedState([]);
    const room = new NotebookRoom(state.state, {} as Env);
    const harness = roomHarness(room);
    const viewerSocket = new FakeSocket();
    const viewerPeer = peerWithScope("viewer", "viewer");
    viewerPeer.socket = viewerSocket.asCloudflareWebSocket();
    harness.peers.set(viewerPeer.id, viewerPeer);

    let checkpointed = 0;
    let repairReason: string | undefined;
    harness.materializers.set("demo", {
      receiveFrame: async () => noopMaterializedResult(),
      checkpoint: async () => {
        checkpointed += 1;
      },
      reconcileRuntimePeerGone: async (reason: string) => {
        repairReason = reason;
        return {
          ...noopMaterializedResult(),
          changed: true,
          runtime_state_changed: true,
          outbound: [
            {
              peer_id: viewerPeer.id,
              frame_type: FrameType.RUNTIME_STATE_SYNC,
              payload: [9, 8, 7],
            },
          ],
        };
      },
    } as never);

    const response = await room.fetch(
      new Request("https://room.internal/internal/n/demo/runtime-state-repair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "manual repair: stale topic-viz runtime" }),
      }),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      changed: true,
      forced: false,
      checkpoint_persisted: true,
      runtime_peer_count: 0,
    });
    assert.equal(repairReason, "manual repair: stale topic-viz runtime");
    assert.equal(checkpointed, 1);
    assert.deepEqual([...viewerSocket.sent[0]], [FrameType.RUNTIME_STATE_SYNC, 9, 8, 7]);
  });

  it("skips runtime-state repair when the expected runtime session is stale", async () => {
    const room = new NotebookRoom(fakeState(), {} as Env);
    const harness = roomHarness(room);
    let checkpointed = 0;
    let reconcileCalls = 0;
    const attachment = {
      workstation_id: "ws-lab2",
      display_name: "Lab2",
      provider: "runtime_peer",
      default_environment_label: "Current Python",
      environment_policy: "current_python",
      runtime_session_id: "fresh-job",
      status: "connecting",
      status_message: "Waiting for Lab2 to accept the compute request.",
      cpu_count: 8,
      memory_bytes: 16_000_000_000,
      working_directory: "/home/ubuntu/project",
      updated_at: "2026-05-22T00:00:01.000Z",
    };
    harness.materializers.set("demo", {
      receiveFrame: async () => noopMaterializedResult(),
      checkpoint: async () => {
        checkpointed += 1;
      },
      getWorkstationAttachment: async () => attachment,
      reconcileRuntimePeerGone: async () => {
        reconcileCalls += 1;
        return {
          ...noopMaterializedResult(),
          changed: true,
          runtime_state_changed: true,
        };
      },
    } as never);

    const response = await room.fetch(
      new Request("https://room.internal/internal/n/demo/runtime-state-repair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expected_runtime_session_id: "expired-job",
          reason: "expired pending attach job",
        }),
      }),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      changed: false,
      skipped: true,
      skip_reason: "runtime_session_mismatch",
      forced: false,
      runtime_peer_count: 0,
    });
    assert.equal(reconcileCalls, 0);
    assert.equal(checkpointed, 0);
    assert.equal(attachment.status, "connecting");
    assert.equal(attachment.runtime_session_id, "fresh-job");
  });

  it("repairs RuntimeStateDoc when the expected runtime session still owns the attachment", async () => {
    const room = new NotebookRoom(fakeState(), {} as Env);
    const harness = roomHarness(room);
    let checkpointed = 0;
    let repairReason: string | undefined;
    const attachment = {
      workstation_id: "ws-lab2",
      display_name: "Lab2",
      provider: "runtime_peer",
      default_environment_label: "Current Python",
      environment_policy: "current_python",
      runtime_session_id: "expired-job",
      status: "connecting",
      status_message: "Waiting for Lab2 to accept the compute request.",
      cpu_count: 8,
      memory_bytes: 16_000_000_000,
      working_directory: "/home/ubuntu/project",
      updated_at: "2026-05-22T00:00:01.000Z",
    };
    harness.materializers.set("demo", {
      receiveFrame: async () => noopMaterializedResult(),
      checkpoint: async () => {
        checkpointed += 1;
      },
      getWorkstationAttachment: async () => attachment,
      reconcileRuntimePeerGone: async (reason: string) => {
        repairReason = reason;
        attachment.status = "disconnected";
        attachment.status_message = "compute disconnected: runtime peer left";
        return {
          ...noopMaterializedResult(),
          changed: true,
          runtime_state_changed: true,
        };
      },
    } as never);

    const response = await room.fetch(
      new Request("https://room.internal/internal/n/demo/runtime-state-repair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expected_runtime_session_id: "expired-job",
          reason: "expired pending attach job",
        }),
      }),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      changed: true,
      forced: false,
      checkpoint_persisted: true,
      runtime_peer_count: 0,
    });
    assert.equal(repairReason, "expired pending attach job");
    assert.equal(checkpointed, 1);
    assert.equal(attachment.status, "disconnected");
    assert.equal(attachment.runtime_session_id, "expired-job");
  });

  it("refuses manual runtime-state repair while a runtime_peer is connected", async () => {
    const state = hibernatedState([]);
    const room = new NotebookRoom(state.state, {} as Env);
    const harness = roomHarness(room);
    let reconcileCalls = 0;
    harness.materializers.set("demo", {
      receiveFrame: async () => noopMaterializedResult(),
      checkpoint: async () => undefined,
      reconcileRuntimePeerGone: async () => {
        reconcileCalls += 1;
        return noopMaterializedResult();
      },
    } as never);
    harness.peers.set("rt", peerWithScope("rt", "runtime_peer"));

    const response = await room.fetch(
      new Request("https://room.internal/internal/n/demo/runtime-state-repair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }),
    );

    assert.equal(response.status, 409);
    assert.equal(reconcileCalls, 0);
    assert.deepEqual(await response.json(), {
      error: "runtime peer is connected; reconnecting compute should reconcile live state",
      runtime_peer_count: 1,
    });
  });

  it("force-repairs by disconnecting runtime peers before reconciliation", async () => {
    const state = hibernatedState([]);
    const room = new NotebookRoom(state.state, {} as Env);
    const harness = roomHarness(room);
    let checkpointed = 0;
    let reconcileCalls = 0;
    harness.materializers.set("demo", {
      receiveFrame: async () => noopMaterializedResult(),
      checkpoint: async () => {
        checkpointed += 1;
      },
      removePeer: async () => undefined,
      reconcileRuntimePeerGone: async () => {
        reconcileCalls += 1;
        return {
          ...noopMaterializedResult(),
          changed: true,
          runtime_state_changed: true,
        };
      },
    } as never);
    const runtimeSocket = new FakeSocket();
    const runtimePeer = {
      ...peerWithScope("rt", "runtime_peer"),
      socket: runtimeSocket.asCloudflareWebSocket(),
    };
    harness.peers.set(runtimePeer.id, runtimePeer);

    const response = await room.fetch(
      new Request("https://room.internal/internal/n/demo/runtime-state-repair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force: true }),
      }),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      changed: true,
      forced: true,
      checkpoint_persisted: true,
      runtime_peer_count: 0,
    });
    assert.equal(reconcileCalls, 1);
    assert.equal(checkpointed, 1);
    assert.equal(runtimeSocket.closed, true);
    assert.equal(runtimeSocket.closeCode, 1008);
    assert.equal(runtimeSocket.closeReason, "runtime state repair");
  });
});

describe("NotebookRoom room summary", () => {
  function summaryPeer(
    id: string,
    user: string,
    scope: "viewer" | "editor" | "owner" | "runtime_peer",
    options: { operator?: string; displayName?: string } = {},
  ): PeerForTest {
    const operator = options.operator ?? `browser:${id}`;
    const identity = authenticateDevRequest(
      new Request(
        `https://cloud.test/n/demo/sync?user=${user}&operator=${operator}&scope=${scope}`,
      ),
    );
    return {
      id,
      socket: new FakeSocket().asCloudflareWebSocket(),
      identity: {
        ...identity,
        metadata: {
          ...identity.metadata,
          ...(options.displayName ? { displayName: options.displayName } : {}),
        },
      },
      connectedAt: "2026-06-05T00:00:00.000Z",
    };
  }

  it("writes deduped human occupants and ignores runtime peers", async () => {
    const state = alarmCapableState();
    const bucket = new FakeRoomSummaryBucket();
    const room = new NotebookRoom(state.state, roomEnvWithSnapshots(bucket));
    const harness = roomHarness(room);

    const beforeAlice = harness.roomSummaryOccupantKeys();
    harness.peers.set(
      "alice-a",
      summaryPeer("alice-a", "alice", "owner", {
        displayName: "Alice Demo",
        operator: "browser:a",
      }),
    );
    harness.publishRoomSummaryIfHumanOccupantsChanged("demo", beforeAlice, "peer_joined");
    await state.drain();

    assert.deepEqual(bucket.summary("demo").occupants, [
      {
        participant_key: "user:dev:alice",
        actor_label: "user:dev:alice/browser:a",
        display_name: "Alice Demo",
        connection_scope: "owner",
      },
    ]);
    assert.equal(await state.getAlarm(), state.now + 60_000);
    const putsAfterAlice = bucket.puts.length;

    const beforeDuplicate = harness.roomSummaryOccupantKeys();
    harness.peers.set(
      "alice-b",
      summaryPeer("alice-b", "alice", "editor", { operator: "browser:b" }),
    );
    harness.publishRoomSummaryIfHumanOccupantsChanged("demo", beforeDuplicate, "peer_joined");
    await state.drain();
    assert.equal(bucket.puts.length, putsAfterAlice, "same participant does not rewrite summary");

    const beforeRuntime = harness.roomSummaryOccupantKeys();
    harness.peers.set("runtime", summaryPeer("runtime", "alice", "runtime_peer"));
    harness.publishRoomSummaryIfHumanOccupantsChanged("demo", beforeRuntime, "peer_joined");
    await state.drain();
    assert.equal(bucket.puts.length, putsAfterAlice, "runtime peer does not rewrite summary");

    const beforeBob = harness.roomSummaryOccupantKeys();
    harness.peers.set("bob", summaryPeer("bob", "bob", "editor", { displayName: "Bob Editor" }));
    harness.publishRoomSummaryIfHumanOccupantsChanged("demo", beforeBob, "peer_joined");
    await state.drain();

    assert.deepEqual(
      bucket
        .summary("demo")
        .occupants.map((occupant) => [
          occupant.participant_key,
          occupant.display_name ?? null,
          occupant.connection_scope,
        ]),
      [
        ["user:dev:alice", "Alice Demo", "owner"],
        ["user:dev:bob", "Bob Editor", "editor"],
      ],
    );
  });

  it("republishes when a participant's strongest scope changes (viewer to editor)", async () => {
    const state = alarmCapableState();
    const bucket = new FakeRoomSummaryBucket();
    const room = new NotebookRoom(state.state, roomEnvWithSnapshots(bucket));
    const harness = roomHarness(room);

    const beforeViewer = harness.roomSummaryOccupantKeys();
    harness.peers.set(
      "vera-view",
      summaryPeer("vera-view", "vera", "viewer", { operator: "browser:a" }),
    );
    harness.publishRoomSummaryIfHumanOccupantsChanged("demo", beforeViewer, "peer_joined");
    await state.drain();
    assert.equal(bucket.summary("demo").occupants[0]?.connection_scope, "viewer");
    const putsAfterViewer = bucket.puts.length;

    // Same participant opens an editing connection: the dashboard only counts
    // editing scopes, so this transition must publish immediately.
    const beforeEditor = harness.roomSummaryOccupantKeys();
    harness.peers.set(
      "vera-edit",
      summaryPeer("vera-edit", "vera", "editor", { operator: "browser:b" }),
    );
    harness.publishRoomSummaryIfHumanOccupantsChanged("demo", beforeEditor, "peer_joined");
    await state.drain();
    assert.ok(bucket.puts.length > putsAfterViewer, "scope transition republishes");
    assert.equal(bucket.summary("demo").occupants[0]?.connection_scope, "editor");
  });

  it("writes an empty summary and disarms refresh when the occupant set empties", async () => {
    const state = alarmCapableState();
    const bucket = new FakeRoomSummaryBucket();
    const room = new NotebookRoom(state.state, roomEnvWithSnapshots(bucket));
    const harness = roomHarness(room);
    harness.materializers.set("demo", {
      receiveFrame: async () => noopMaterializedResult(),
      checkpoint: async () => undefined,
      removePeer: async () => undefined,
    } as never);

    const firstAlice = summaryPeer("alice-a", "alice", "owner");
    const secondAlice = summaryPeer("alice-b", "alice", "owner", { operator: "browser:b" });
    harness.peers.set(firstAlice.id, firstAlice);
    harness.peers.set(secondAlice.id, secondAlice);
    harness.publishRoomSummary("demo", "peer_joined");
    await state.drain();
    const putsAfterInitial = bucket.puts.length;

    harness.removePeer("demo", firstAlice);
    await state.drain();
    assert.equal(bucket.puts.length, putsAfterInitial, "remaining tab keeps occupant set stable");

    harness.removePeer("demo", secondAlice);
    await state.drain();
    assert.deepEqual(bucket.summary("demo").occupants, []);
    assert.equal(await state.getAlarm(), null);
  });

  it("publishes and re-arms the summary on refresh alarms", async () => {
    const state = alarmCapableState();
    const bucket = new FakeRoomSummaryBucket();
    const room = new NotebookRoom(state.state, roomEnvWithSnapshots(bucket));
    const harness = roomHarness(room);
    harness.peers.set("alice", summaryPeer("alice", "alice", "owner"));
    harness.publishRoomSummary("demo", "peer_joined");
    await state.drain();
    const putsAfterInitial = bucket.puts.length;

    await state.state.storage.put("room_summary_refresh", "demo");
    await state.state.storage.put("room_summary_refresh_alarm_at", 0);
    await (room as unknown as { alarm(): Promise<void> }).alarm();
    await state.drain();

    assert.equal(bucket.puts.length, putsAfterInitial + 1);
    assert.notEqual(await state.getAlarm(), null);
  });

  it("restores hibernated human peers into the room summary and refresh alarm", async () => {
    const socket = new FakeSocket();
    const identity = authenticateDevRequest(
      new Request("https://cloud.test/n/demo/sync?user=carol&operator=browser:c&scope=editor"),
    );
    socket.serializeAttachment({
      notebookId: "demo",
      peerId: "carol",
      identity: {
        ...identity,
        metadata: {
          ...identity.metadata,
          displayName: "Carol Editor",
        },
      },
      connectedAt: "2026-06-05T00:00:00.000Z",
      workstation: null,
    });
    const state = alarmCapableState([socket.asCloudflareWebSocket()]);
    const bucket = new FakeRoomSummaryBucket();

    new NotebookRoom(state.state, roomEnvWithSnapshots(bucket));
    await state.drain();

    assert.deepEqual(bucket.summary("demo").occupants, [
      {
        participant_key: "user:dev:carol",
        actor_label: "user:dev:carol/browser:c",
        display_name: "Carol Editor",
        connection_scope: "editor",
      },
    ]);
    assert.equal(await state.getAlarm(), state.now + 60_000);
  });
});

type PeerForTest = {
  id: string;
  socket: CloudflareWebSocket;
  identity: ReturnType<typeof authenticateDevRequest>;
  connectedAt: string;
  consecutiveRejectedFrames?: number;
  workstation?: {
    workstationId?: string;
    displayName?: string;
    defaultEnvironmentLabel?: string;
    environmentPolicy?: string;
    runtimeSessionId?: string;
    workingDirectory?: string;
  } | null;
};

interface RoomHarness {
  peers: Map<string, PeerForTest>;
  managedPython: Map<
    string,
    {
      runtime: {
        ownerPrincipal: string;
        sessionId: string;
        wake(): Promise<void>;
        close(): Promise<void>;
      };
      ready: Promise<void>;
    }
  >;
  materializers: Map<
    string,
    {
      syncPeer?(): Promise<RoomHostFrameResult>;
      receiveFrame(): Promise<RoomHostFrameResult>;
      checkpoint(): Promise<void>;
      getRuntimeExecutionActivity?(): Promise<{ executing: boolean; queueDepth: number }>;
      getRuntimeQueueDepth?(): Promise<number>;
      getWorkstationAttachment?(): Promise<unknown>;
      removePeer?(peerId: string): Promise<void>;
      reconcileRuntimeIdleTimeout?(reason: string, updatedAt: string): Promise<RoomHostFrameResult>;
      reconcileRuntimePeerGone?(reason: string): Promise<RoomHostFrameResult>;
      setWorkstationAttachment?(attachment: unknown): Promise<RoomHostFrameResult>;
    }
  >;
  refreshRuntimeIdleWatch?(notebookId: string): void;
  refreshRuntimePeerWatch?(notebookId: string): void;
  roomSummaryOccupantKeys(): Set<string>;
  publishRoomSummaryIfHumanOccupantsChanged(
    notebookId: string,
    previousOccupantKeys: ReadonlySet<string>,
    reason: "peer_joined" | "peer_left",
  ): void;
  publishRoomSummary(
    notebookId: string,
    reason: "peer_joined" | "peer_left" | "hibernation_restore" | "refresh_alarm",
  ): void;
  runtimePeerAuthorityError?(
    notebookId: string,
    workstation: PeerForTest["workstation"],
  ): Promise<string | null>;
  removeDuplicateRuntimePeers?(notebookId: string, incomingPeer: PeerForTest): void;
  publishRuntimePeerAttachment(notebookId: string, peer: PeerForTest): Promise<void>;
  syncPeerFromRoomHost(notebookId: string, peer: PeerForTest): Promise<void>;
  handleMessage(
    notebookId: string,
    peer: PeerForTest,
    message: string | ArrayBuffer | ArrayBufferView,
  ): Promise<void>;
  removePeer(notebookId: string, peer: PeerForTest): void;
  peerForSocket(socket: CloudflareWebSocket): PeerForTest | undefined;
  roomPeerRoster(): Array<{
    peer_id: string;
    actor_label: string;
    connection_scope: string;
    participant_key: string;
    display_name?: string;
  }>;
  broadcastFrame(notebookId: string, frame: Uint8Array, excludePeerId?: string): void;
  hasRuntimePeer(): boolean;
  prunePendingRuntimePeerResponses(nowMs?: number): void;
}

function roomHarness(room: NotebookRoom): RoomHarness {
  return room as unknown as RoomHarness;
}

type ManagedAdmissionRuntimeState = {
  kernel: { lifecycle: { lifecycle: string }; error_details?: string | null };
  executions: Record<
    string,
    { status: string; source: string; outputs: Array<{ text?: { inline: string } }> }
  >;
  queue: { executing: unknown; queued: Array<{ execution_id: string }> };
  workstation?: { status?: string; status_message?: string | null; runtime_session_id?: string };
};

function assertNoComputeFailure(states: ManagedAdmissionRuntimeState[]) {
  assert.ok(states.length > 0, "viewer received runtime transitions");
  for (const state of states) {
    assert.notEqual(state.workstation?.status, "error");
    assert.notEqual(state.workstation?.status, "disconnected");
    assert.notEqual(state.kernel.lifecycle.lifecycle, "Error");
  }
}

async function managedPythonAdmissionFixture(
  status: "connecting" | "ready",
  options: {
    immediateOpen?: Response;
    ownerAuthorized?: boolean;
    holdOwnerLookup?: boolean;
    closeResponse?: Response;
    packageResponse?: () => Promise<Response>;
    sessionAlive?: boolean;
    providerFetch?: (request: Request) => Promise<Response>;
    providerAvailable?: () => boolean;
  } = {},
) {
  const state = hibernatedState([]);
  const db = new ResumeNotebookD1();
  db.notebookAclOwners.add("user:dev:alice");
  db.attachJobs.push({
    id: "managed-job",
    notebook_id: "demo",
    owner_principal: options.ownerAuthorized === false ? "user:dev:revoked" : "user:dev:alice",
    workstation_id: "celld-preview-python",
    status: "accepted",
    trigger: "user",
    requested_by_actor_label: "user:dev:alice/browser:first",
    requested_at: "2026-09-24T00:00:00.000Z",
    updated_at: "2026-09-24T00:00:00.000Z",
    accepted_at: "2026-09-24T00:00:00.000Z",
    finished_at: null,
    error_message: null,
  });
  let releaseOpen!: (response: Response) => void;
  const opening = new Promise<Response>((resolve) => {
    releaseOpen = resolve;
  });
  let enteredOpen!: () => void;
  const openEntered = new Promise<void>((resolve) => {
    enteredOpen = resolve;
  });
  let releaseOwnerLookup!: () => void;
  const ownerLookup = new Promise<void>((resolve) => {
    releaseOwnerLookup = resolve;
  });
  let enteredOwnerLookup!: () => void;
  const ownerLookupEntered = new Promise<void>((resolve) => {
    enteredOwnerLookup = resolve;
  });
  if (options.holdOwnerLookup)
    db.beforeSessionOwnerLookup = async () => {
      db.beforeSessionOwnerLookup = undefined;
      enteredOwnerLookup();
      await ownerLookup;
    };
  const requests: Array<{
    path: string;
    sessionId?: string;
    ownerPrincipal?: string;
    execution?: { source: string };
    resumeOnly?: boolean;
  }> = [];
  const computeIndex = new FakeOwnerComputeIndexNamespace();
  const env = {
    DB: db,
    OWNER_COMPUTE_INDEX: computeIndex,
    NOTEBOOK_CLOUD_PYTHON_PROVIDER: "celld",
    PREVIEW_PYTHON_SESSIONS: {
      idFromName: (name: string) => ({ toString: () => name }),
      get: () =>
        options.providerAvailable?.() === false
          ? null
          : {
              fetch: async (request: Request) => {
                const path = new URL(request.url).pathname;
                requests.push({
                  path,
                  ...(request.method === "GET" ? {} : await request.clone().json()),
                });
                if (options.providerFetch) return options.providerFetch(request);
                if (path === "/status")
                  return Response.json({ alive: options.sessionAlive ?? false, busy: false });
                if (path === "/open") {
                  enteredOpen();
                  return (options.immediateOpen ?? (await opening)).clone();
                }
                if (path === "/execute")
                  return Response.json({
                    success: true,
                    execution_count: 1,
                    outputs: [{ output_type: "stream", name: "stdout", text: "ready once\n" }],
                  });
                if (path === "/close" && options.closeResponse) return options.closeResponse;
                if (path === "/packages" && options.packageResponse)
                  return options.packageResponse();
                return Response.json({ ok: true });
              },
            },
    },
  } as unknown as Env;
  let room = new NotebookRoom(state.state, env);
  await state.drain();
  let harness = roomHarness(room);
  let materializer = new RoomMaterializer("demo", state.state, env);
  harness.materializers.set("demo", materializer as never);
  await materializer.setWorkstationAttachment({
    workstation_id: "celld-preview-python",
    display_name: "Python (sandboxed)",
    provider: "celld-pyodide",
    default_environment_label: "Python",
    environment_policy: "curated",
    status,
    status_message: null,
    cpu_count: null,
    memory_bytes: null,
    working_directory: null,
    updated_at: "2026-09-24T00:00:00.000Z",
    runtime_session_id: "managed-job",
  });
  const clients: NotebookHandle[] = [];
  const connect = async (id: string) => {
    const responses = new Map<string, (response: Record<string, unknown>) => void>();
    const socket = new FakeSocket({
      onSend: (frame) => {
        if (frame[0] !== FrameType.RESPONSE) return;
        const response = decodeJsonPayload<Record<string, unknown>>(frame.slice(1));
        responses.get(String(response.id))?.(response);
      },
    });
    const peer: PeerForTest = {
      id,
      socket: socket.asCloudflareWebSocket(),
      identity: authenticateDevRequest(
        new Request(`https://cloud.test/n/demo/sync?user=alice&operator=browser:${id}&scope=owner`),
      ),
      connectedAt: new Date().toISOString(),
      consecutiveRejectedFrames: 0,
    };
    socket.serializeAttachment({ notebookId: "demo", peerId: id, ...peer, socket: undefined });
    harness.peers.set(id, peer);
    const client = NotebookHandle.create_bootstrap(peer.identity.actorLabel);
    clients.push(client);
    let received = 0;
    const runtimeHistory: ManagedAdmissionRuntimeState[] = [];
    const sync = async () => {
      await harness.syncPeerFromRoomHost("demo", peer);
      while (received < socket.sent.length) {
        assert.ok(received < 500, "browser sync must converge");
        const frame = socket.sent[received++];
        if (frame[0] !== FrameType.AUTOMERGE_SYNC && frame[0] !== FrameType.RUNTIME_STATE_SYNC)
          continue;
        const events = client.receive_frame(frame) as Array<{ reply?: number[] }>;
        for (const event of events)
          if (event.reply)
            await room.webSocketMessage(
              peer.socket,
              encodeTypedFrame(frame[0], new Uint8Array(event.reply)),
            );
        if (frame[0] === FrameType.RUNTIME_STATE_SYNC) {
          runtimeHistory.push(client.get_runtime_state() as ManagedAdmissionRuntimeState);
          const reply = client.generate_runtime_state_sync_reply();
          if (reply)
            await room.webSocketMessage(
              peer.socket,
              encodeTypedFrame(FrameType.RUNTIME_STATE_SYNC, reply),
            );
        }
      }
    };
    await sync();
    return {
      peer,
      client,
      sync,
      runtimeHistory,
      response: (requestId: string) =>
        new Promise<Record<string, unknown>>((resolve) => {
          responses.set(requestId, resolve);
        }),
      runtimeState: () => client.get_runtime_state() as ManagedAdmissionRuntimeState,
      rejections: () =>
        socket.sent
          .filter((frame) => frame[0] === FrameType.SESSION_CONTROL)
          .map((frame) => decodeJsonPayload<Record<string, unknown>>(frame.slice(1)))
          .filter((control) => control.type === "cloud_frame_rejected"),
      accepted: () =>
        socket.sent.some((frame) => {
          if (frame[0] !== FrameType.SESSION_CONTROL) return false;
          const control = decodeJsonPayload<{ type: string; frame_type: number }>(frame.slice(1));
          return (
            control.type === "cloud_frame_accepted" && control.frame_type === FrameType.REQUEST
          );
        }),
    };
  };
  return {
    get room() {
      return room;
    },
    get materializer() {
      return materializer;
    },
    db,
    state: state.state,
    computeIndex,
    reconstruct: async (runtimeState?: Uint8Array) => {
      await state.drain();
      await materializer.checkpoint();
      if (runtimeState)
        await state.state.storage.put("room-host:runtime-state-doc", runtimeState.slice().buffer);
      room = new NotebookRoom(state.state, env);
      harness = roomHarness(room);
      materializer = (
        room as unknown as { materializerFor(n: string): RoomMaterializer }
      ).materializerFor("demo");
    },
    connect,
    requests,
    openEntered,
    releaseOpen,
    ownerLookupEntered,
    releaseOwnerLookup,
    drain: state.drain,
    startReplacement: async (allocate = false) => {
      let replaceActive = false;
      if (allocate) {
        const current = await room.fetch(
          new Request("https://room/internal/n/demo/workstation-attachment"),
        );
        assert.equal(current.status, 200);
        const { attachment } = (await current.json()) as { attachment: { status: string } };
        // Match the Worker's preflight: a confirmed terminal attachment replaces
        // an active catalog row even if its earlier retirement write failed.
        replaceActive = attachment.status === "error";
        assert.notEqual(
          attachment.status,
          "disconnected",
          "Start must not allocate while liveness is unknown",
        );
      }
      const allocated = allocate
        ? await createWorkstationAttachJob(env, {
            notebookId: "demo",
            ownerPrincipal: "user:dev:alice",
            workstationId: "celld-preview-python",
            actorLabel: "user:dev:alice/browser:recovery",
            trigger: "user_attach",
            replaceActive,
          })
        : null;
      const sessionId = allocated?.job.id ?? "replacement-job";
      if (!allocate) db.attachJobs.push({ ...db.attachJobs[0], id: sessionId, status: "accepted" });
      const attachment = await materializer.getWorkstationAttachment();
      const changed = await materializer.setWorkstationAttachment({
        ...attachment!,
        runtime_session_id: sessionId,
        status: allocated?.job.status === "running" ? "ready" : "connecting",
      });
      (
        room as unknown as { deliverRoomHostFrames(n: string, result: RoomHostFrameResult): void }
      ).deliverRoomHostFrames("demo", changed);
      await (
        room as unknown as { startManagedPython(n: string, s: string): Promise<void> }
      ).startManagedPython("demo", sessionId);
      return sessionId;
    },
    seed: async (connection: Awaited<ReturnType<typeof connect>>) => {
      connection.client.update_source(initialHostedCellIdForTest("demo"), "print('ready once')");
      const source = connection.client.flush_local_changes();
      assert.ok(source);
      await room.webSocketMessage(
        connection.peer.socket,
        encodeTypedFrame(FrameType.AUTOMERGE_SYNC, source),
      );
      await connection.sync();
    },
    execute: (connection: Awaited<ReturnType<typeof connect>>) =>
      room.webSocketMessage(
        connection.peer.socket,
        encodeTypedFrame(
          FrameType.REQUEST,
          new TextEncoder().encode(
            JSON.stringify({
              id: "play",
              action: "execute_cell",
              cell_id: initialHostedCellIdForTest("demo"),
            }),
          ),
        ),
      ),
    close: async () => {
      releaseOwnerLookup();
      releaseOpen(Response.json({ ok: true }));
      await state.drain();
      const runtimes = (
        room as unknown as {
          managedPython: Map<string, { runtime: { close(): Promise<void> } }>;
        }
      ).managedPython;
      for (const { runtime } of runtimes.values()) await runtime.close();
      for (const client of clients) client.free();
    },
  };
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

function roomEnvWithComputeIndex(
  computeIndex: DurableObjectNamespace,
  db: D1Database = new NotebookOwnerD1(),
): Env {
  return {
    DB: db,
    NOTEBOOK_ROOMS: {
      idFromName: (name: string) => ({ toString: () => name }),
      get: () => ({
        fetch: async () => new Response("not implemented", { status: 501 }),
      }),
    },
    OWNER_COMPUTE_INDEX: computeIndex,
  } as Env;
}

function roomEnvWithSnapshots(bucket: FakeRoomSummaryBucket): Env {
  return {
    NOTEBOOK_ROOMS: {
      idFromName: (name: string) => ({ toString: () => name }),
      get: () => ({
        fetch: async () => new Response("not implemented", { status: 501 }),
      }),
    },
    NOTEBOOK_SNAPSHOTS: bucket,
  };
}

class FakeRoomSummaryBucket {
  readonly objects = new Map<string, string>();
  readonly puts: Array<{ key: string; value: string }> = [];

  summary(notebookId: string): NotebookRoomSummary {
    const value = this.objects.get(roomSummaryKey(notebookId));
    assert.ok(value, `expected room summary for ${notebookId}`);
    return JSON.parse(value) as NotebookRoomSummary;
  }

  async get(): Promise<null> {
    return null;
  }

  async head(): Promise<null> {
    return null;
  }

  async put(key: string, value: string): Promise<never> {
    this.objects.set(key, value);
    this.puts.push({ key, value });
    return { key } as never;
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

interface FakeOwnerComputeIndexRequest {
  body: {
    summary?: {
      queue_depth?: number;
      runtime_peer_count?: number;
      status?: string;
      workstation_id?: string;
    };
  };
  objectName: string;
  url: string;
}

class FakeOwnerComputeIndexNamespace implements DurableObjectNamespace {
  readonly requests: FakeOwnerComputeIndexRequest[] = [];

  idFromName(name: string): { toString(): string } {
    return { toString: () => name };
  }

  get(id: { toString(): string }) {
    const requests = this.requests;
    const objectName = id.toString();
    return {
      fetch: async (request: Request) => {
        const body = (await request
          .json()
          .catch(() => ({}))) as FakeOwnerComputeIndexRequest["body"];
        requests.push({ body, objectName, url: request.url });
        return Response.json({ ok: true });
      },
    };
  }
}

class BlockingOwnerComputeIndexNamespace extends FakeOwnerComputeIndexNamespace {
  private resolveFirstStarted: () => void = () => undefined;
  private resolveReleaseFirst: () => void = () => undefined;
  readonly firstStarted = new Promise<void>((resolve) => {
    this.resolveFirstStarted = resolve;
  });
  private readonly firstRelease = new Promise<void>((resolve) => {
    this.resolveReleaseFirst = resolve;
  });

  releaseFirst(): void {
    this.resolveReleaseFirst();
  }

  get(id: { toString(): string }) {
    const requests = this.requests;
    const objectName = id.toString();
    return {
      fetch: async (request: Request) => {
        const body = (await request
          .json()
          .catch(() => ({}))) as FakeOwnerComputeIndexRequest["body"];
        requests.push({ body, objectName, url: request.url });
        if (requests.length === 1) {
          this.resolveFirstStarted();
          await this.firstRelease;
        }
        return Response.json({ ok: true });
      },
    };
  }
}

class FailingFirstOwnerComputeIndexNamespace extends FakeOwnerComputeIndexNamespace {
  get(id: { toString(): string }) {
    const requests = this.requests;
    const objectName = id.toString();
    return {
      fetch: async (request: Request) => {
        const body = (await request
          .json()
          .catch(() => ({}))) as FakeOwnerComputeIndexRequest["body"];
        requests.push({ body, objectName, url: request.url });
        if (requests.length === 1) {
          return new Response("owner compute index unavailable", { status: 503 });
        }
        return Response.json({ ok: true });
      },
    };
  }
}

class FailingNumberedOwnerComputeIndexNamespace extends FakeOwnerComputeIndexNamespace {
  constructor(private readonly failOnRequestNumber: number) {
    super();
  }

  get(id: { toString(): string }) {
    const requests = this.requests;
    const objectName = id.toString();
    return {
      fetch: async (request: Request) => {
        const body = (await request
          .json()
          .catch(() => ({}))) as FakeOwnerComputeIndexRequest["body"];
        requests.push({ body, objectName, url: request.url });
        if (requests.length === this.failOnRequestNumber) {
          return new Response("owner compute index unavailable", { status: 503 });
        }
        return Response.json({ ok: true });
      },
    };
  }
}

class NotebookOwnerD1 implements D1Database {
  prepare(query: string): D1PreparedStatement {
    return new NotebookOwnerD1Statement(query);
  }

  async exec(): Promise<D1Result> {
    return d1OkResult();
  }

  async batch<T = unknown>(): Promise<D1Result<T>[]> {
    return [];
  }
}

class CountingNotebookOwnerD1 extends NotebookOwnerD1 {
  notebookLookupCount = 0;

  override prepare(query: string): D1PreparedStatement {
    if (query.includes("FROM notebooks") && query.includes("WHERE id = ?")) {
      this.notebookLookupCount += 1;
    }
    return super.prepare(query);
  }
}

class ResumeNotebookD1 implements D1Database {
  readonly notebookAclOwners = new Set<string>();
  beforeSessionOwnerLookup?: () => Promise<void>;
  beforeAttachUpdate?: () => void | Promise<void>;
  readonly attachJobs: Array<{
    id: string;
    notebook_id: string;
    owner_principal: string;
    workstation_id: string;
    status: string;
    trigger: string;
    requested_by_actor_label: string;
    requested_at: string;
    updated_at: string;
    accepted_at: string | null;
    finished_at: string | null;
    error_message: string | null;
  }> = [];

  constructor(
    readonly workstationFacts: {
      acceleratorsJson?: string | null;
      cpuCount?: number | null;
      memoryBytes?: number | null;
      workstationLookupFails?: boolean;
    } = {},
  ) {}

  prepare(query: string): D1PreparedStatement {
    return new ResumeNotebookD1Statement(this, query);
  }

  async exec(): Promise<D1Result> {
    return d1OkResult();
  }

  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    const results: D1Result<T>[] = [];
    for (const statement of statements) {
      results.push(await statement.run<T>());
    }
    return results;
  }
}

class ResumeNotebookD1Statement implements D1PreparedStatement {
  private values: unknown[] = [];

  constructor(
    private readonly db: ResumeNotebookD1,
    private readonly query: string,
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    this.values = values;
    return this;
  }

  async first<T = unknown>(): Promise<T | null> {
    if (this.query.includes("FROM notebooks") && this.query.includes("WHERE id = ?")) {
      const notebookId = String(this.values[0] ?? "demo");
      return {
        id: notebookId,
        owner_principal: "user:dev:alice",
        title: "Demo",
        created_at: "2026-06-23T00:00:00.000Z",
        updated_at: "2026-06-23T00:00:00.000Z",
        latest_revision_id: null,
      } as T;
    }
    if (this.query.includes("FROM workstations") && this.query.includes("workstation_id = ?")) {
      if (this.db.workstationFacts.workstationLookupFails) {
        throw new Error("workstation registry unavailable");
      }
      return {
        owner_principal: "user:dev:alice",
        workstation_id: "ws-lab2",
        display_name: "Lab2",
        provider: "runtime_peer",
        provider_label: null,
        status: "online",
        status_message: null,
        default_environment_label: "Current Python",
        environment_policy: "current_python",
        working_directory: "/srv/project",
        cpu_count: this.db.workstationFacts.cpuCount ?? null,
        memory_bytes: this.db.workstationFacts.memoryBytes ?? null,
        accelerators_json: this.db.workstationFacts.acceleratorsJson ?? null,
        environments_json: null,
        created_at: "2026-06-23T00:00:00.000Z",
        updated_at: "2026-06-23T00:00:00.000Z",
        last_seen_at: new Date().toISOString(),
      } as T;
    }
    if (this.query.includes("FROM workstation_attach_jobs") && this.query.includes("LIMIT 1")) {
      const [notebookId, owner, pendingStaleBefore, staleBefore] = this.values;
      return (this.db.attachJobs.find(
        (job) =>
          job.notebook_id === notebookId &&
          job.owner_principal === owner &&
          (job.status === "pending"
            ? job.requested_at >= String(pendingStaleBefore)
            : ["accepted", "running"].includes(job.status) &&
              job.updated_at >= String(staleBefore)),
      ) ?? null) as T | null;
    }
    if (
      this.query.includes("FROM workstation_attach_jobs") &&
      this.query.includes("WHERE id = ?")
    ) {
      if (this.query.includes("SELECT owner_principal")) await this.db.beforeSessionOwnerLookup?.();
      const [jobId] = this.values;
      return (this.db.attachJobs.find(
        (job) =>
          job.id === jobId &&
          (!this.query.includes("AND status IN") ||
            ["pending", "accepted", "running"].includes(job.status)),
      ) ?? null) as T | null;
    }
    return null;
  }

  async run<T = unknown>(): Promise<D1Result<T>> {
    if (
      this.query.includes("UPDATE workstation_attach_jobs") &&
      this.query.includes("SET status = ?")
    ) {
      await this.db.beforeAttachUpdate?.();
      const [status, updatedAt, , , , finishedAt, errorMessage, id, owner, workstation, maxRank] =
        this.values;
      const job = this.db.attachJobs.find(
        (job) =>
          job.id === id && job.owner_principal === owner && job.workstation_id === workstation,
      );
      if (
        job &&
        ["pending", "accepted", "running"].includes(job.status) &&
        ["pending", "accepted", "running"].indexOf(job.status) <= Number(maxRank)
      ) {
        job.status = String(status);
        job.updated_at = String(updatedAt);
        job.error_message = errorMessage === null ? null : String(errorMessage);
        if (["failed", "completed", "cancelled"].includes(job.status))
          job.finished_at = String(finishedAt);
      }
    }
    if (this.query.includes("INSERT INTO workstation_attach_jobs")) {
      const [
        id,
        notebookId,
        ownerPrincipal,
        workstationId,
        trigger,
        requestedByActorLabel,
        requestedAt,
        updatedAt,
      ] = this.values.map((value) => String(value));
      this.db.attachJobs.push({
        id,
        notebook_id: notebookId,
        owner_principal: ownerPrincipal,
        workstation_id: workstationId,
        status: "pending",
        trigger,
        requested_by_actor_label: requestedByActorLabel,
        requested_at: requestedAt,
        updated_at: updatedAt,
        accepted_at: null,
        finished_at: null,
        error_message: null,
      });
    }
    return d1OkResult<T>();
  }

  async all<T = unknown>(): Promise<D1Result<T>> {
    if (this.query.includes("FROM notebook_acl")) {
      const [notebookId, principal] = this.values;
      return d1OkResult<T>(
        this.db.notebookAclOwners.has(String(principal))
          ? [
              {
                notebook_id: notebookId,
                subject_kind: "principal",
                subject: principal,
                scope: "owner",
              } as T,
            ]
          : [],
      );
    }
    return d1OkResult<T>([]);
  }
}

class NotebookOwnerD1Statement implements D1PreparedStatement {
  private values: unknown[] = [];

  constructor(private readonly query: string) {}

  bind(...values: unknown[]): D1PreparedStatement {
    this.values = values;
    return this;
  }

  async first<T = unknown>(): Promise<T | null> {
    if (this.query.includes("FROM notebooks") && this.query.includes("WHERE id = ?")) {
      const notebookId = String(this.values[0] ?? "demo");
      return {
        id: notebookId,
        owner_principal: "user:dev:alice",
        title: "Demo",
        created_at: "2026-06-23T00:00:00.000Z",
        updated_at: "2026-06-23T00:00:00.000Z",
        latest_revision_id: null,
      } as T;
    }
    return null;
  }

  async run<T = unknown>(): Promise<D1Result<T>> {
    return d1OkResult<T>();
  }

  async all<T = unknown>(): Promise<D1Result<T>> {
    return d1OkResult<T>([]);
  }
}

function d1OkResult<T = unknown>(results: T[] = []): D1Result<T> {
  return { results, success: true, meta: {} };
}

function initialHostedCellIdForTest(notebookId: string): string {
  return `cell-room-${stableRoomKeyForTest(notebookId)}`;
}

function stableRoomKeyForTest(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
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
function alarmCapableState(sockets: CloudflareWebSocket[] = []): {
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
    getWebSockets: () => sockets,
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
  // Opt-in listener capture for tests that must prove a listener was really
  // detached (e.g. AbortController-based removal), without changing the
  // default no-op behavior every other FakeSocket user relies on.
  private readonly captured: Array<{
    type: string;
    handler: (event: unknown) => void;
    signal?: AbortSignal;
  }> = [];

  constructor(
    private readonly options: {
      throwOnSend?: boolean;
      onSend?: (frame: Uint8Array) => void;
      captureListeners?: boolean;
    } = {},
  ) {}

  accept(): void {}

  addEventListener(
    type: string,
    handler: (event: unknown) => void,
    options?: { signal?: AbortSignal },
  ): void {
    if (!this.options.captureListeners) return;
    this.captured.push({ type, handler, signal: options?.signal });
  }

  /** Fires `type` on every captured listener whose signal is not aborted. */
  fire(type: string, event: unknown = {}): void {
    for (const entry of this.captured) {
      if (entry.type === type && !entry.signal?.aborted) entry.handler(event);
    }
  }

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
    this.options.onSend?.(this.sent[this.sent.length - 1]);
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

for (const race of ["failure", "replacement"] as const)
  it(`rejects execution after managed ${race} during owner check`, { timeout: 3000 }, async () => {
    const state = hibernatedState([]);
    let ownerChecked!: () => void, releaseOwner!: () => void;
    const checking = new Promise<void>((resolve) => {
      ownerChecked = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      releaseOwner = resolve;
    });
    let first = true;
    const db = new NotebookOwnerD1();
    const prepare = db.prepare.bind(db);
    db.prepare = (query) => {
      const statement = prepare(query);
      if (query.includes("FROM notebook_acl"))
        statement.all = async <T>() => {
          if (first) {
            first = false;
            ownerChecked();
            await hold;
          }
          return d1OkResult<T>([
            {
              scope: "owner",
              subject_kind: "principal",
              subject: "user:dev:alice",
              notebook_id: "demo",
            } as T,
          ]);
        };
      return statement;
    };
    const env = {
      DB: db,
      NOTEBOOK_CLOUD_PYTHON_PROVIDER: "celld",
      PREVIEW_PYTHON_SESSIONS: {
        idFromName: (name: string) => name,
        get: () => ({ fetch: async () => Response.json({}) }),
      },
    } as unknown as Env;
    const room = new NotebookRoom(state.state, env);
    await state.drain();
    const harness = roomHarness(room);
    const materializer = new RoomMaterializer("demo", state.state, {} as Env);
    harness.materializers.set("demo", materializer as never);
    await materializer.setWorkstationAttachment({
      workstation_id: "celld-preview-python",
      display_name: "Python",
      provider: "celld-pyodide",
      default_environment_label: "Python",
      environment_policy: "curated",
      status: "connecting",
      runtime_session_id: "restore-session",
    });
    const socket = new FakeSocket();
    const peer = {
      id: "owner",
      socket: socket.asCloudflareWebSocket(),
      identity: authenticateDevRequest(
        new Request("https://cloud.test/n/demo/sync?user=alice&operator=browser:a&scope=owner"),
      ),
      connectedAt: new Date().toISOString(),
      workstation: null,
    };
    socket.serializeAttachment({
      notebookId: "demo",
      peerId: peer.id,
      identity: peer.identity,
      connectedAt: peer.connectedAt,
    });
    harness.peers.set(peer.id, peer);
    const runtime = {
      ownerPrincipal: "user:dev:alice",
      sessionId: "restore-session",
      presence: { peer_id: "runtime", connection_scope: "runtime_peer" },
      wake: async () => {},
      close: async () => {},
      accept: () => {},
    };
    Object.assign(room, {
      managedPython: new Map([["demo", { runtime, ready: Promise.resolve() }]]),
    });
    await room.webSocketMessage(
      peer.socket,
      encodeTypedFrame(
        FrameType.REQUEST,
        new TextEncoder().encode(
          JSON.stringify({
            id: "run",
            action: "execute_cell",
            cell_id: initialHostedCellIdForTest("demo"),
          }),
        ),
      ),
    );
    await checking;
    if (race === "failure") {
      await (
        room as unknown as { failManagedPython(n: string, r: unknown, error: Error): Promise<void> }
      ).failManagedPython("demo", runtime, new Error("saved package restore failed"));
    } else {
      const current = await materializer.getWorkstationAttachment();
      await materializer.setWorkstationAttachment({
        ...current!,
        status: "ready",
        runtime_session_id: "replacement",
      });
      Object.assign(room, {
        managedPython: new Map([
          ["demo", { runtime: { ...runtime, sessionId: "replacement" }, ready: Promise.resolve() }],
        ]),
      });
    }
    assert.equal(await materializer.getRuntimeQueueDepth(), 0);
    releaseOwner();
    await state.drain();
    const attachment = await materializer.getWorkstationAttachment();
    const queued = await materializer.getRuntimeQueueDepth();
    assert.equal(attachment?.status, race === "failure" ? "error" : "ready");
    assert.equal(queued, 0, "a late request cannot queue for a failed or replacement session");
    const rejected = decodeJsonPayload<Record<string, unknown>>(socket.sent.at(-1)!.slice(1));
    assert.equal(rejected.type, "cloud_frame_rejected");
    assert.match(
      String(rejected.reason),
      race === "failure" ? /saved package restore failed/ : /session changed/,
    );
  });

describe("NotebookRoom stale-activation defense-in-depth (#4295)", () => {
  function gate() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { resolve, promise };
  }
  function peerWithScope(id: string, scope: "runtime_peer"): PeerForTest {
    return {
      id,
      socket: new FakeSocket().asCloudflareWebSocket(),
      identity: authenticateDevRequest(
        new Request(`https://cloud.test/n/demo/sync?user=alice&scope=${scope}`),
      ),
      connectedAt: new Date().toISOString(),
      workstation: { runtimeSessionId: "session" },
    };
  }
  for (const deferred of [false, true])
    it(`keeps replacement listeners alive after repeated ${deferred ? "deferred" : "direct"} old-peer removal`, async () => {
      const fixture = hibernatedState([]);
      const room = new NotebookRoom(fixture.state, {} as Env);
      await fixture.drain();
      const harness = roomHarness(room);
      harness.materializers.set("demo", fakeMaterializer(noopMaterializedResult()));
      const old = peerWithScope("same-id", "runtime_peer");
      const socket = new FakeSocket({ captureListeners: true });
      const replacement = { ...old, socket: socket.asCloudflareWebSocket() };
      const lifecycle = room as unknown as {
        broadcastDepth: number;
        flushPendingRemovals(): void;
        acceptPeerSocket(n: string, p: PeerForTest): void;
        peerListeners: Map<string, AbortController>;
      };
      harness.peers.set(old.id, old);
      if (deferred) {
        lifecycle.broadcastDepth = 1;
        harness.removePeer("demo", old);
      }
      harness.peers.set(old.id, replacement);
      lifecycle.acceptPeerSocket("demo", replacement);
      const controller = lifecycle.peerListeners.get(old.id)!;
      if (deferred) {
        lifecycle.broadcastDepth = 0;
        lifecycle.flushPendingRemovals();
      }
      harness.removePeer("demo", old);
      harness.removePeer("demo", old);
      assert.equal(controller.signal.aborted, false);
      assert.equal(harness.peers.get(old.id), replacement);
      socket.fire("message", { data: LIVENESS_PING });
      await fixture.drain();
      assert.equal(new TextDecoder().decode(socket.sent[0]), LIVENESS_PONG);
      socket.fire("close", { code: 1000 });
      socket.fire("error");
      await fixture.drain();
      assert.equal(controller.signal.aborted, true);
      assert.equal(harness.peers.has(old.id), false);
    });

  it("keeps newly busy peers after the idle catalog await", async () => {
    const fixture = alarmCapableState();
    const room = new NotebookRoom(fixture.state, {} as Env);
    await fixture.drain();
    const peer = peerWithScope("rt", "runtime_peer");
    roomHarness(room).peers.set(peer.id, peer);
    await fixture.state.storage.put("runtime_idle_watch", "demo");
    await fixture.state.storage.put("runtime_idle_watch_alarm_at", 0);
    const entered = gate(),
      release = gate();
    let busy = false;
    Object.assign(room, {
      markIdleRuntimeSessionCompleted: async () => {
        entered.resolve();
        await release.promise;
      },
    });
    roomHarness(room).materializers.set("demo", {
      ...fakeMaterializer(noopMaterializedResult()),
      getRuntimeExecutionActivity: async () => ({ executing: busy, queueDepth: 0 }),
      reconcileRuntimeIdleTimeout: async () => noopMaterializedResult(),
    });
    const alarm = room.alarm();
    await entered.promise;
    busy = true;
    release.resolve();
    await alarm;
    await fixture.drain();
    assert.equal(roomHarness(room).peers.get(peer.id), peer);
    assert.equal((peer.socket as unknown as FakeSocket).closed, false);
  });

  it("publishes and checkpoints accepted idle reconciliation despite catalog failure", async () => {
    const fixture = alarmCapableState();
    const room = new NotebookRoom(fixture.state, {} as Env);
    await fixture.drain();
    const peer = peerWithScope("rt", "runtime_peer");
    roomHarness(room).peers.set(peer.id, peer);
    await fixture.state.storage.put("runtime_idle_watch", "demo");
    await fixture.state.storage.put("runtime_idle_watch_alarm_at", 0);
    let checkpoints = 0,
      deliveries = 0;
    Object.assign(room, {
      markIdleRuntimeSessionCompleted: async () => {
        throw new Error("catalog unavailable");
      },
      deliverRoomHostFrames: () => {
        deliveries++;
      },
    });
    const materializer = new RoomMaterializer("demo", fixture.state, {} as Env);
    roomHarness(room).materializers.set("demo", materializer as never);
    await materializer.setWorkstationAttachment({
      workstation_id: "ws",
      display_name: "Python",
      provider: "runtime_peer",
      default_environment_label: "Python",
      environment_policy: "runtime_peer",
      status: "ready",
      runtime_session_id: "session",
    });
    const checkpoint = materializer.checkpoint.bind(materializer);
    materializer.checkpoint = async () => {
      checkpoints++;
      await checkpoint();
    };
    await room.alarm();
    await fixture.drain();
    assert.equal(deliveries, 1);
    assert.equal(checkpoints, 1);
    assert.equal((await materializer.getWorkstationAttachment())?.status, "idle");
    assert.ok(await fixture.state.storage.get("room-host:checkpoint"));
    assert.equal((peer.socket as unknown as FakeSocket).closed, true);
  });

  it("honors real host busy refusal when execution queues after idle activity", async () => {
    const fixture = alarmCapableState();
    const room = new NotebookRoom(fixture.state, {} as Env);
    await fixture.drain();
    const materializer = new RoomMaterializer("demo", fixture.state, {} as Env);
    roomHarness(room).materializers.set("demo", materializer as never);
    const peer = peerWithScope("rt", "runtime_peer");
    roomHarness(room).peers.set(peer.id, peer);
    await materializer.setWorkstationAttachment({
      workstation_id: "ws",
      display_name: "Python",
      provider: "runtime_peer",
      default_environment_label: "Python",
      environment_policy: "runtime_peer",
      status: "ready",
      runtime_session_id: "session",
    });
    await fixture.state.storage.put("runtime_idle_watch", "demo");
    await fixture.state.storage.put("runtime_idle_watch_alarm_at", 0);
    const entered = gate(),
      release = gate();
    const reconcile = materializer.reconcileRuntimeIdleTimeout.bind(materializer);
    materializer.reconcileRuntimeIdleTimeout = async (...args) => {
      entered.resolve();
      await release.promise;
      return reconcile(...args);
    };
    let catalogCompletions = 0;
    Object.assign(room, {
      markIdleRuntimeSessionCompleted: async () => {
        catalogCompletions++;
      },
    });
    const alarm = room.alarm();
    await entered.promise;
    await materializer.receiveFrame(
      {
        id: "owner",
        identity: {
          principal: "user:dev:alice",
          actorLabel: "user:dev:alice/browser",
          scope: "owner",
        },
      },
      {
        type: FrameType.REQUEST,
        payload: new TextEncoder().encode(
          JSON.stringify({
            id: "queued",
            action: "execute_cell",
            cell_id: initialHostedCellIdForTest("demo"),
          }),
        ),
      },
    );
    release.resolve();
    await alarm;
    await fixture.drain();
    assert.equal(await materializer.getRuntimeQueueDepth(), 1);
    assert.equal((await materializer.getWorkstationAttachment())?.status, "ready");
    assert.equal(catalogCompletions, 0);
    assert.equal(roomHarness(room).peers.get(peer.id), peer);
    assert.equal((peer.socket as unknown as FakeSocket).closed, false);
  });
  for (const operation of ["cancel", "fail", "disconnect"] as const)
    it(`rejects awaited ${operation} when checkpoint persistence fails`, async () => {
      const fixture = hibernatedState([]);
      const room = new NotebookRoom(fixture.state, {} as Env);
      await fixture.drain();
      let deliveries = 0,
        closed = 0;
      const changed = { ...noopMaterializedResult(), changed: true, runtime_state_changed: true };
      Object.assign(room, {
        deliverRoomHostFrames: () => {
          deliveries++;
        },
      });
      roomHarness(room).materializers.set("demo", {
        ...fakeMaterializer(changed),
        checkpoint: async () => {
          throw new Error("storage failed");
        },
        getRuntimeExecutionActivity: async () => ({ executing: false, queueDepth: 1 }),
        cancelUnstartedExecutions: async () => changed,
        transitionManagedPythonSession: async () => changed,
      } as never);
      const runtime = {
        sessionId: "session",
        close: async () => {
          closed++;
        },
        presence: { peer_id: "managed" },
      };
      Object.assign(room, { managedPython: new Map([["demo", { runtime }]]) });
      const harness = room as unknown as {
        cancelUnstartedExecutions(n: string): Promise<boolean>;
        failManagedPython(n: string, r: unknown, e: Error): Promise<void>;
        disconnectManagedPythonSession(n: string, s: string, e: Error, r: unknown): Promise<void>;
      };
      const pending =
        operation === "cancel"
          ? harness.cancelUnstartedExecutions("demo")
          : operation === "fail"
            ? harness.failManagedPython("demo", runtime, new Error("failed"))
            : harness.disconnectManagedPythonSession(
                "demo",
                "session",
                new Error("disconnected"),
                runtime,
              );
      await assert.rejects(pending, /checkpoint|recovery/i);
      await fixture.drain();
      assert.equal(deliveries, 1, "live terminal publication survives persistence failure");
      assert.equal(closed, operation === "cancel" ? 0 : 1, "cleanup must still complete");
    });
  for (const kind of ["summary", "peer"] as const)
    for (const arm of [false, true])
      it(`preserves ${kind} watch replacement during ${arm ? "arm" : "disarm"} refresh`, async () => {
        const fixture = alarmCapableState();
        const room = new NotebookRoom(fixture.state, {} as Env);
        await fixture.drain();
        const key = kind === "summary" ? "room_summary_refresh" : "runtime_peer_gone_watch";
        const alarmKey = `${key}_alarm_at`;
        await fixture.state.storage.put(key, "demo");
        await fixture.state.storage.put(alarmKey, 100);
        await fixture.state.storage.setAlarm!(200);
        if (kind === "peer" && !arm)
          roomHarness(room).peers.set("rt", peerWithScope("rt", "runtime_peer"));
        const entered = gate();
        const release = gate();
        const get = fixture.state.storage.get.bind(fixture.state.storage);
        let held = false,
          observed: unknown;
        fixture.state.storage.get = async <T>(readKey: string) => {
          const value = await get<T>(readKey);
          if (readKey === alarmKey && !held) {
            held = true;
            observed = value;
            entered.resolve();
            await release.promise;
          }
          return value;
        };
        const refresh =
          kind === "summary"
            ? (
                room as unknown as {
                  refreshRoomSummaryWatch(n: string, count: number): Promise<void>;
                }
              ).refreshRoomSummaryWatch("demo", arm ? 1 : 0)
            : (roomHarness(room).refreshRuntimePeerWatch!("demo"), Promise.resolve());
        await entered.promise;
        await fixture.state.storage.put(key, "demo");
        await fixture.state.storage.put(alarmKey, 200);
        release.resolve();
        await refresh;
        await fixture.drain();
        assert.equal(observed, 100, "refresh must observe the record before mutation");
        assert.equal(await fixture.state.storage.get(key), "demo");
        assert.equal(await fixture.state.storage.get(alarmKey), 200);
        assert.equal(await fixture.getAlarm(), 200);
      });

  for (const phase of ["attachment", "reconcile"] as const)
    it(`cancels consumed peer watch after rejoin/disarm during ${phase}`, async () => {
      const fixture = alarmCapableState();
      const room = new NotebookRoom(fixture.state, {} as Env);
      await fixture.drain();
      await fixture.state.storage.put("runtime_peer_gone_watch", "demo");
      await fixture.state.storage.put("runtime_peer_gone_watch_alarm_at", 0);
      const entered = gate();
      const release = gate();
      let reconciles = 0,
        invalidations = 0;
      Object.assign(room, {
        invalidateSelectedRuntimePeerSession: () => {
          invalidations++;
        },
      });
      roomHarness(room).materializers.set("demo", {
        ...fakeMaterializer(noopMaterializedResult()),
        getWorkstationAttachment: async () => {
          if (phase === "attachment") {
            entered.resolve();
            await release.promise;
          }
          return null;
        },
        reconcileRuntimePeerGone: async () => {
          reconciles++;
          if (phase === "reconcile") {
            entered.resolve();
            await release.promise;
          }
          return noopMaterializedResult();
        },
      });
      const alarm = room.alarm();
      await entered.promise;
      const rejoined = peerWithScope("rejoined", "runtime_peer");
      roomHarness(room).peers.set(rejoined.id, rejoined);
      roomHarness(room).refreshRuntimePeerWatch!("demo");
      await fixture.drain();
      assert.equal(await fixture.state.storage.get("runtime_peer_gone_watch"), undefined);
      release.resolve();
      await alarm;
      await fixture.drain();
      assert.equal(reconciles, phase === "attachment" ? 0 : 1);
      assert.equal(invalidations, 0, "an entered continuation cannot invalidate a rejoined peer");
      assert.equal(roomHarness(room).peers.get(rejoined.id), rejoined);
    });

  for (const outcome of ["busy", "idempotent"] as const)
    it(`handles idle reconcile ${outcome} without guessing from changed:false`, async () => {
      const fixture = alarmCapableState();
      const room = new NotebookRoom(fixture.state, {} as Env);
      await fixture.drain();
      await fixture.state.storage.put("runtime_idle_watch", "demo");
      await fixture.state.storage.put("runtime_idle_watch_alarm_at", 0);
      const peer = peerWithScope("rt", "runtime_peer");
      roomHarness(room).peers.set(peer.id, peer);
      const entered = gate();
      const release = gate();
      let busy = false,
        catalogCompletions = 0;
      Object.assign(room, {
        markIdleRuntimeSessionCompleted: async () => {
          catalogCompletions++;
        },
      });
      roomHarness(room).materializers.set("demo", {
        ...fakeMaterializer(noopMaterializedResult()),
        getRuntimeExecutionActivity: async () => ({ executing: busy, queueDepth: busy ? 1 : 0 }),
        reconcileRuntimeIdleTimeout: async () => {
          entered.resolve();
          await release.promise;
          return noopMaterializedResult();
        },
      });
      const alarm = room.alarm();
      await entered.promise;
      const prematureCompletions = catalogCompletions;
      busy = outcome === "busy";
      release.resolve();
      await alarm;
      await fixture.drain();
      assert.equal(
        prematureCompletions,
        0,
        "catalog completion must wait for reconcile acceptance",
      );
      assert.equal(catalogCompletions, outcome === "busy" ? 0 : 1);
      assert.equal(roomHarness(room).peers.has(peer.id), outcome === "busy");
      assert.equal((peer.socket as unknown as FakeSocket).closed, outcome === "idempotent");
    });

  for (const phase of ["authorization", "registry", "attachment"] as const)
    it(`denies a removed runtime peer after ${phase} await`, async () => {
      const fixture = hibernatedState([]);
      const room = new NotebookRoom(fixture.state, {} as Env);
      await fixture.drain();
      const peer = peerWithScope("rt", "runtime_peer");
      const harness = roomHarness(room);
      harness.peers.set(peer.id, peer);
      const entered = gate();
      const release = gate();
      let materialized = 0,
        published = 0;
      Object.assign(room, {
        runtimePeerAuthorityError: async () => {
          entered.resolve();
          await release.promise;
          return null;
        },
        registeredWorkstationForRuntimePeer: async () => {
          if (phase === "registry") {
            entered.resolve();
            await release.promise;
          }
          return { failed: phase === "attachment", workstation: null };
        },
      });
      harness.materializers.set("demo", {
        ...fakeMaterializer(noopMaterializedResult()),
        receiveFrame: async () => {
          materialized++;
          return noopMaterializedResult();
        },
        getWorkstationAttachment: async () => {
          entered.resolve();
          await release.promise;
          return null;
        },
        setWorkstationAttachment: async () => {
          published++;
          return noopMaterializedResult();
        },
      });
      const pending =
        phase === "authorization"
          ? harness.handleMessage(
              "demo",
              peer,
              encodeTypedFrame(FrameType.RUNTIME_STATE_SYNC, new Uint8Array([0])),
            )
          : harness.publishRuntimePeerAttachment("demo", peer);
      await entered.promise;
      harness.removePeer("demo", peer);
      release.resolve();
      await pending;
      await fixture.drain();
      assert.equal(materialized, 0);
      assert.equal(published, 0);
      assert.equal((peer.socket as unknown as FakeSocket).sent.length, 0);
    });

  for (const phase of ["idle_activity", "idle_busy", "idle_catalog", "peer", "attachment"] as const)
    it(`publishes accepted real host changes before a stale ${phase} continuation exits`, async (t) => {
      const fixture = alarmCapableState();
      const room = new NotebookRoom(fixture.state, {} as Env);
      await fixture.drain();
      const harness = roomHarness(room);
      const materializer = new RoomMaterializer("demo", fixture.state, {} as Env);
      harness.materializers.set("demo", materializer as never);
      const attachment = {
        workstation_id: "ws-lab2",
        display_name: "Lab2",
        provider: "runtime_peer",
        default_environment_label: "Python",
        environment_policy: "current_python",
        status: "ready",
        runtime_session_id: "job-old",
      };
      await materializer.setWorkstationAttachment(attachment);
      const viewer = {
        ...peerWithScope("viewer", "runtime_peer"),
        identity: authenticateDevRequest(
          new Request(
            "https://cloud.test/n/demo/sync?user=alice&operator=browser:viewer&scope=viewer",
          ),
        ),
      };
      const runtime = peerWithScope("rt", "runtime_peer");
      runtime.workstation = { workstationId: "ws-lab2", runtimeSessionId: "job-old" };
      harness.peers.set(viewer.id, viewer);
      if (phase !== "peer") harness.peers.set(runtime.id, runtime);
      await harness.syncPeerFromRoomHost("demo", viewer);
      const socket = viewer.socket as unknown as FakeSocket;
      const client = NotebookHandle.create_bootstrap("viewer");
      t.after(() => client.free());
      for (let received = 0; received < socket.sent.length; received++) {
        assert.ok(received < 100, "viewer sync converges");
        const frame = socket.sent[received];
        if (frame[0] !== FrameType.AUTOMERGE_SYNC && frame[0] !== FrameType.RUNTIME_STATE_SYNC)
          continue;
        for (const event of client.receive_frame(frame) as Array<{ reply?: number[] }>)
          if (event.reply)
            await harness.handleMessage(
              "demo",
              viewer,
              encodeTypedFrame(frame[0], new Uint8Array(event.reply)),
            );
        if (frame[0] === FrameType.RUNTIME_STATE_SYNC) {
          const reply = client.generate_runtime_state_sync_reply();
          if (reply) await harness.handleMessage("demo", viewer, encodeTypedFrame(frame[0], reply));
        }
      }
      socket.sent.length = 0;
      const entered = gate(),
        release = gate();
      let changed = false,
        saves = 0,
        busy = false;
      const checkpoint = materializer.checkpoint.bind(materializer);
      materializer.checkpoint = async () => {
        saves++;
        return checkpoint();
      };
      const replaceWatch = async () => {
        await fixture.state.storage.put("runtime_idle_watch", "demo");
        await fixture.state.storage.put("runtime_idle_watch_alarm_at", Date.now() + 60_000);
      };
      if (phase.startsWith("idle")) {
        const reconcile = materializer.reconcileRuntimeIdleTimeout.bind(materializer);
        materializer.reconcileRuntimeIdleTimeout = async (...args) => {
          const result = await reconcile(...args);
          changed = result.changed;
          if (phase === "idle_activity") await replaceWatch();
          if (phase === "idle_busy") busy = true;
          return result;
        };
        if (phase === "idle_busy") {
          const activity = materializer.getRuntimeExecutionActivity.bind(materializer);
          materializer.getRuntimeExecutionActivity = async () =>
            busy ? { executing: true, queueDepth: 0 } : activity();
        }
        Object.assign(room, {
          markIdleRuntimeSessionCompleted: async () => {
            entered.resolve();
            await release.promise;
          },
        });
      } else if (phase === "peer") {
        const reconcile = materializer.reconcileRuntimePeerGone.bind(materializer);
        materializer.reconcileRuntimePeerGone = async (...args) => {
          const result = await reconcile(...args);
          changed = result.changed;
          entered.resolve();
          await release.promise;
          return result;
        };
      } else {
        Object.assign(room, {
          registeredWorkstationForRuntimePeer: async () => ({ failed: false, workstation: null }),
        });
        const set = materializer.setWorkstationAttachment.bind(materializer);
        materializer.setWorkstationAttachment = async (...args) => {
          const result = await set(...args);
          changed = result.changed;
          entered.resolve();
          await release.promise;
          return result;
        };
      }
      const lifecycle = room as unknown as {
        handleRuntimeIdleWatchAlarm(n: string): Promise<void>;
        handleRuntimePeerWatchAlarm(n: string): Promise<void>;
      };
      const pending =
        phase === "attachment"
          ? harness.publishRuntimePeerAttachment("demo", runtime)
          : phase === "peer"
            ? lifecycle.handleRuntimePeerWatchAlarm("demo")
            : lifecycle.handleRuntimeIdleWatchAlarm("demo");
      if (phase !== "idle_activity" && phase !== "idle_busy") {
        await entered.promise;
        if (phase === "idle_catalog") await replaceWatch();
        else
          harness.peers.set(runtime.id, {
            ...runtime,
            socket: new FakeSocket().asCloudflareWebSocket(),
          });
        release.resolve();
      }
      await pending;
      await fixture.drain();
      assert.equal(changed, true, "the real host accepted a mutation");
      assert.ok(
        socket.sent.some((frame) => frame[0] === FrameType.RUNTIME_STATE_SYNC),
        "accepted runtime output reaches the viewer",
      );
      assert.ok(saves > 0, "accepted host state is checkpointed");
      assert.ok(await fixture.state.storage.get("room-host:checkpoint"));
      if (phase.startsWith("idle")) {
        assert.equal(
          harness.peers.get(runtime.id),
          runtime,
          "replacement watch prevents destructive teardown",
        );
        if (phase !== "idle_busy")
          assert.equal(await fixture.state.storage.get("runtime_idle_watch"), "demo");
      }
    });

  for (const continuation of ["send failure", "replacement", "removed peer"] as const)
    it(`completes only the accepted idle session after ${continuation}`, async (t) => {
      const fixture = alarmCapableState();
      const db = new ResumeNotebookD1();
      const env = { DB: db } as unknown as Env;
      const room = new NotebookRoom(fixture.state, env);
      await fixture.drain();
      const harness = roomHarness(room);
      const materializer = new RoomMaterializer("demo", fixture.state, env);
      harness.materializers.set("demo", materializer as never);
      for (const id of ["old", "new"])
        db.attachJobs.push({
          id,
          notebook_id: "demo",
          owner_principal: "user:dev:alice",
          workstation_id: "ws-lab2",
          status: id === "old" ? "running" : "pending",
          trigger: "user_attach",
          requested_by_actor_label: "user:dev:alice/browser",
          requested_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          accepted_at: null,
          finished_at: null,
          error_message: null,
        });
      const attachment = {
        workstation_id: "ws-lab2",
        display_name: "Lab2",
        provider: "runtime_peer",
        default_environment_label: "Python",
        environment_policy: "current_python",
        status: "ready",
        runtime_session_id: "old",
      };
      await materializer.setWorkstationAttachment(attachment);
      const lifecycle = room as unknown as {
        selectedRuntimePeerSession(
          n: string,
        ): Promise<{ runtimeSessionId: string; status: string } | null>;
        cacheSelectedRuntimePeerSession(n: string, a: typeof attachment): void;
        handleRuntimeIdleWatchAlarm(n: string): Promise<void>;
        withRuntimePeerWatchSuppressed(callback: () => void): void;
      };
      assert.equal((await lifecycle.selectedRuntimePeerSession("demo"))?.status, "ready");
      const peer = peerWithScope("rt", "runtime_peer");
      peer.workstation = { workstationId: "ws-lab2", runtimeSessionId: "old" };
      harness.peers.set(peer.id, peer);
      const replacementPeer = peerWithScope("new-rt", "runtime_peer");
      replacementPeer.workstation = { workstationId: "ws-lab2", runtimeSessionId: "new" };
      const socket = peer.socket as unknown as FakeSocket;
      const client = NotebookHandle.create_bootstrap("runtime");
      t.after(() => client.free());
      await harness.syncPeerFromRoomHost("demo", peer);
      for (let received = 0; received < socket.sent.length; received++) {
        assert.ok(received < 100, "runtime sync converges");
        const frame = socket.sent[received];
        if (frame[0] !== FrameType.AUTOMERGE_SYNC && frame[0] !== FrameType.RUNTIME_STATE_SYNC)
          continue;
        for (const event of client.receive_frame(frame) as Array<{ reply?: number[] }>)
          if (event.reply)
            await harness.handleMessage(
              "demo",
              peer,
              encodeTypedFrame(frame[0], new Uint8Array(event.reply)),
            );
        if (frame[0] === FrameType.RUNTIME_STATE_SYNC) {
          const reply = client.generate_runtime_state_sync_reply();
          if (reply) await harness.handleMessage("demo", peer, encodeTypedFrame(frame[0], reply));
        }
      }
      await fixture.drain();
      await fixture.state.storage.delete("runtime_idle_watch");
      await fixture.state.storage.delete("runtime_idle_watch_alarm_at");
      let changed = false,
        sends = 0;
      peer.socket.send = () => {
        sends++;
        throw new Error("runtime socket closed");
      };
      const reconcile = materializer.reconcileRuntimeIdleTimeout.bind(materializer);
      materializer.reconcileRuntimeIdleTimeout = async (...args) => {
        const pending = reconcile(...args);
        if (continuation === "replacement") {
          const replacement = {
            ...attachment,
            runtime_session_id: "new",
            status: "connecting",
          };
          // Queue the replacement before reconciliation returns. A separate
          // attachment read after that operation would capture the wrong job.
          await materializer.setWorkstationAttachment(replacement);
          lifecycle.cacheSelectedRuntimePeerSession("demo", replacement);
          harness.peers.set(replacementPeer.id, replacementPeer);
        }
        const result = await pending;
        changed = result.changed;
        if (continuation === "removed peer")
          lifecycle.withRuntimePeerWatchSuppressed(() => harness.removePeer("demo", peer));
        return result;
      };
      await lifecycle.handleRuntimeIdleWatchAlarm("demo");
      await fixture.drain();
      assert.equal(changed, true);
      if (continuation !== "removed peer")
        assert.ok(sends > 0, "accepted real-host output attempted runtime delivery");
      assert.equal(db.attachJobs[0].status, "completed", "accepted idle job must complete");
      assert.equal(db.attachJobs[1].status, "pending", "replacement job must remain available");
      const replacement = continuation === "replacement";
      assert.equal(
        (await materializer.getWorkstationAttachment())?.status,
        replacement ? "connecting" : "idle",
      );
      assert.equal(harness.peers.has(peer.id), false);
      assert.equal(await fixture.state.storage.get("runtime_peer_gone_watch"), undefined);
      assert.ok(await fixture.state.storage.get("room-host:checkpoint"));
      const selected = await lifecycle.selectedRuntimePeerSession("demo");
      assert.equal(selected?.runtimeSessionId, replacement ? "new" : "old");
      assert.equal(selected?.status, replacement ? "connecting" : "idle");
      if (replacement) {
        assert.equal(harness.peers.get(replacementPeer.id), replacementPeer);
        assert.equal((replacementPeer.socket as unknown as FakeSocket).closed, false);
      }
      assert.notEqual(
        await harness.runtimePeerAuthorityError!("demo", peer.workstation),
        null,
        "old runtime cannot reconnect after accepted idle",
      );
    });

  for (const lookup of ["lazy", "equivalent_refresh", "invalidated"] as const)
    it(`runs consumed peer recovery when ${lookup} populates the same selected session`, async () => {
      const fixture = alarmCapableState();
      const room = new NotebookRoom(fixture.state, {} as Env);
      await fixture.drain();
      const materializer = new RoomMaterializer("demo", fixture.state, {} as Env);
      roomHarness(room).materializers.set("demo", materializer as never);
      await materializer.setWorkstationAttachment({
        workstation_id: "ws-lab2",
        display_name: "Lab2",
        provider: "runtime_peer",
        default_environment_label: "Python",
        environment_policy: "current_python",
        status: "ready",
        runtime_session_id: "job-old",
      });
      const selected = room as unknown as {
        selectedRuntimePeerSession(n: string): Promise<unknown>;
        cacheSelectedRuntimePeerSession(n: string, attachment: unknown): void;
        invalidateSelectedRuntimePeerSession(n: string): void;
      };
      if (lookup === "equivalent_refresh") await selected.selectedRuntimePeerSession("demo");
      await fixture.state.storage.put("runtime_peer_gone_watch", "demo");
      await fixture.state.storage.put("runtime_peer_gone_watch_alarm_at", 0);
      const entered = gate(),
        release = gate();
      const get = materializer.getWorkstationAttachment.bind(materializer);
      let reads = 0;
      materializer.getWorkstationAttachment = async () => {
        const attachment = await get();
        if (reads++ === 0) {
          entered.resolve();
          await release.promise;
        }
        return attachment;
      };
      const alarm = room.alarm();
      await entered.promise;
      if (lookup === "lazy") await selected.selectedRuntimePeerSession("demo");
      else if (lookup === "equivalent_refresh")
        selected.cacheSelectedRuntimePeerSession("demo", await get());
      else selected.invalidateSelectedRuntimePeerSession("demo");
      release.resolve();
      await alarm;
      await fixture.drain();
      if (lookup === "invalidated") {
        assert.equal(
          await fixture.state.storage.get("runtime_peer_gone_watch"),
          "demo",
          "deferred recovery is rearmed without a peer",
        );
        await fixture.state.storage.put("runtime_peer_gone_watch_alarm_at", 0);
        await room.alarm();
        await fixture.drain();
      }
      assert.equal((await materializer.getWorkstationAttachment())?.status, "disconnected");
      assert.equal(await fixture.state.storage.get("runtime_peer_gone_watch"), undefined);
      assert.ok(await fixture.state.storage.get("room-host:checkpoint"));
    });

  for (const reconstructed of [false, true])
    it(`retires idle managed catalog generation before resume after catalog failure (${reconstructed ? "reconstructed" : "live"})`, async (t) => {
      const pool = new SessionPool({
        warmCount: 0,
        create: async () => ({
          info: { installed: [] },
          execute: async () => ({ success: true, execution_count: 1, outputs: [] }),
          dispose: async () => {},
        }),
      });
      const provider = createProviderService(pool);
      const fixture = await managedPythonAdmissionFixture("ready", {
        providerFetch: (request) => provider.fetch(request),
      });
      t.after(() => fixture.close());
      const prepare = fixture.db.prepare.bind(fixture.db);
      fixture.db.prepare = (query) => {
        const statement = prepare(query);
        if (query.includes("FROM workstations")) {
          const first = statement.first.bind(statement);
          statement.first = async <T>() => {
            const row = await first<Record<string, unknown>>();
            return (
              row
                ? { ...row, workstation_id: "celld-preview-python", provider: "celld-pyodide" }
                : row
            ) as T | null;
          };
        }
        return statement;
      };
      const connection = await fixture.connect("idle-retry");
      const old = fixture.db.attachJobs.find((job) => job.id === "managed-job")!;
      old.updated_at = new Date().toISOString();
      await fixture.startReplacement(true);
      await fixture.drain();
      await fixture.state.storage.delete("runtime_idle_watch");
      await fixture.state.storage.delete("runtime_idle_watch_alarm_at");
      fixture.db.beforeAttachUpdate = () => {
        throw new Error("idle catalog unavailable");
      };
      await (
        fixture.room as unknown as { handleRuntimeIdleWatchAlarm(n: string): Promise<void> }
      ).handleRuntimeIdleWatchAlarm("demo");
      await fixture.drain();
      assert.equal(old.status, "running", "failed catalog write leaves the job active");
      assert.equal((await fixture.materializer.getWorkstationAttachment())?.status, "idle");
      assert.equal(
        (await fixture.materializer.getWorkstationAttachment())?.runtime_session_id,
        "managed-job",
      );
      assert.ok(
        fixture.requests.some((request) => request.path === "/close"),
        "idle cleanup still releases the provider",
      );
      await fixture.execute(connection);
      await fixture.drain();
      assert.equal(
        (await fixture.materializer.getWorkstationAttachment())?.status,
        "idle",
        "catalog outage cannot resurrect the closed session",
      );
      assert.equal(
        await fixture.materializer.getRuntimeQueueDepth(),
        0,
        "failed retirement cannot accept work for the closed session",
      );
      fixture.db.beforeAttachUpdate = undefined;
      if (reconstructed) await fixture.reconstruct();
      const resumed = reconstructed ? await fixture.connect("resumed") : connection;
      await fixture.execute(resumed);
      await fixture.drain();
      const selected = await fixture.materializer.getWorkstationAttachment();
      assert.notEqual(
        selected?.runtime_session_id,
        "managed-job",
        "resume must not reuse the closed generation",
      );
      assert.equal(old.status, "completed");
      assert.ok(
        fixture.requests.some(
          (request) =>
            request.path === "/open" && request.sessionId === selected?.runtime_session_id,
        ),
      );
    });

  it("preserves a replacement peer watch during delayed clear", async () => {
    const fixture = alarmCapableState();
    const room = new NotebookRoom(fixture.state, {} as Env);
    await fixture.drain();
    await fixture.state.storage.put("runtime_peer_gone_watch", "demo");
    await fixture.state.storage.put("runtime_peer_gone_watch_alarm_at", 200);
    await fixture.state.storage.setAlarm!(200);
    await (
      room as unknown as {
        clearRuntimePeerWatch(
          n: string,
          expected: { notebookId: string; alarmAt: number },
        ): Promise<void>;
      }
    ).clearRuntimePeerWatch("demo", { notebookId: "demo", alarmAt: 100 });
    assert.equal(await fixture.state.storage.get("runtime_peer_gone_watch_alarm_at"), 200);
    assert.equal(await fixture.getAlarm(), 200);
  });

  it("does not reschedule from an alarm snapshot replaced during reads", async () => {
    const fixture = alarmCapableState();
    const room = new NotebookRoom(fixture.state, {} as Env);
    await fixture.drain();
    await fixture.state.storage.put("runtime_peer_gone_watch_alarm_at", 100);
    await fixture.state.storage.setAlarm!(200);
    const get = fixture.state.storage.get.bind(fixture.state.storage);
    let reads = 0;
    fixture.state.storage.get = async <T>(key: string) => {
      const value = await get<T>(key);
      if (key === "runtime_peer_gone_watch_alarm_at" && reads++ === 0)
        await fixture.state.storage.put(key, 200);
      return value;
    };
    await (room as unknown as { rescheduleRoomAlarm(): Promise<void> }).rescheduleRoomAlarm();
    assert.equal(await fixture.getAlarm(), 200);
  });

  it("does not tear down runtime after a new idle watch arrives during activity", async () => {
    const fixture = alarmCapableState();
    const room = new NotebookRoom(fixture.state, {} as Env);
    await fixture.drain();
    await fixture.state.storage.put("runtime_idle_watch", "demo");
    await fixture.state.storage.put("runtime_idle_watch_alarm_at", 1);
    let tornDown = 0;
    Object.assign(room, {
      hasRuntimePeer: () => true,
      markIdleRuntimeSessionCompleted: async () => {
        tornDown++;
      },
    });
    roomHarness(room).materializers.set("demo", {
      ...fakeMaterializer(noopMaterializedResult()),
      getRuntimeExecutionActivity: async () => {
        await fixture.state.storage.put("runtime_idle_watch", "demo");
        await fixture.state.storage.put("runtime_idle_watch_alarm_at", Date.now() + 60_000);
        return { executing: false, queueDepth: 0 };
      },
    });
    await room.alarm();
    await fixture.drain();
    assert.equal(tornDown, 0);
    assert.equal(await fixture.state.storage.get("runtime_idle_watch"), "demo");
  });

  it("preserves a replacement idle watch during the activity await", async () => {
    const fixture = alarmCapableState();
    const room = new NotebookRoom(fixture.state, {} as Env);
    await fixture.drain();
    await fixture.state.storage.put("runtime_idle_watch", "demo");
    await fixture.state.storage.put("runtime_idle_watch_alarm_at", 100);
    let entered!: () => void, release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    roomHarness(room).materializers.set("demo", {
      ...fakeMaterializer(noopMaterializedResult()),
      getRuntimeExecutionActivity: async () => {
        entered();
        await held;
        return { executing: true, queueDepth: 0 };
      },
    });
    roomHarness(room).refreshRuntimeIdleWatch!("demo");
    await waiting;
    await fixture.state.storage.put("runtime_idle_watch_alarm_at", 200);
    release();
    await fixture.drain();
    assert.equal(await fixture.state.storage.get("runtime_idle_watch"), "demo");
    assert.equal(await fixture.state.storage.get("runtime_idle_watch_alarm_at"), 200);
  });

  it("does not consume a replaced due alarm or reconcile its runtime", async () => {
    const fixture = alarmCapableState();
    const room = new NotebookRoom(fixture.state, {} as Env);
    await fixture.drain();
    await fixture.state.storage.put("runtime_peer_gone_watch", "demo");
    await fixture.state.storage.put("runtime_peer_gone_watch_alarm_at", 1);
    let reconciled = 0;
    roomHarness(room).materializers.set("demo", {
      ...fakeMaterializer(noopMaterializedResult()),
      getWorkstationAttachment: async () => null,
      reconcileRuntimePeerGone: async () => {
        reconciled++;
        return noopMaterializedResult();
      },
    });
    const get = fixture.state.storage.get.bind(fixture.state.storage);
    let replaced = false;
    fixture.state.storage.get = async <T>(key: string) => {
      if (key === "runtime_idle_watch" && !replaced) {
        replaced = true;
        await fixture.state.storage.put("runtime_peer_gone_watch_alarm_at", Date.now() + 60_000);
      }
      return get<T>(key);
    };
    await room.alarm();
    await fixture.drain();
    assert.equal(await fixture.state.storage.get("runtime_peer_gone_watch"), "demo");
    assert.equal(reconciled, 0);
    assert.ok((await fixture.getAlarm())! > Date.now());
  });

  for (const claim of ["pending", "failed", "delayed"] as const)
    it(
      `persists through actual room wiring without self-denying a ${claim} UUID claim`,
      { timeout: 3000 },
      async () => {
        const state = hibernatedState([]);
        await state.state.storage.put("room-host:activation-current", "previous-activation");
        const put = state.state.storage.put.bind(state.state.storage);
        let release!: () => void;
        const hold = new Promise<void>((resolve) => {
          release = resolve;
        });
        state.state.storage.put = async <T>(key: string, value: T) => {
          if (key === "room-host:activation-current") {
            if (claim === "failed") throw new Error("transient claim failure");
            await hold;
          }
          await put(key, value);
        };
        const old = new NotebookRoom(state.state, {} as Env);
        const fresh = claim === "delayed" ? new NotebookRoom(state.state, {} as Env) : old;
        const harness = fresh as unknown as {
          materializerFor(n: string): RoomMaterializer;
          checkpointRoomHost(n: string, m: RoomMaterializer, operation: string): Promise<boolean>;
        };
        try {
          if (claim === "delayed") release();
          const materializer = harness.materializerFor("demo");
          assert.equal(await harness.checkpointRoomHost("demo", materializer, "test"), true);
          assert.ok(await state.state.storage.get("room-host:checkpoint"));
          assert.ok(await state.state.storage.get("room-host:notebook-doc"));
          assert.equal(
            await state.state.storage.get("room-host:activation-current"),
            "previous-activation",
            "room must not issue an unordered ownership claim",
          );
        } finally {
          release();
          await state.drain();
        }
      },
    );

  it("reports skipped persistence from the materializer instead of success", async () => {
    const state = hibernatedState([]);
    const room = new NotebookRoom(state.state, {} as Env);
    await state.drain();
    const materializer = new RoomMaterializer("demo", state.state, {} as Env);
    let release!: () => void;
    Object.assign(materializer, {
      operationQueue: new Promise<void>((resolve) => {
        release = resolve;
      }),
    });
    const harness = room as unknown as {
      checkpointRoomHost(n: string, m: RoomMaterializer, op: string): Promise<boolean>;
    };
    const saving = harness.checkpointRoomHost("demo", materializer, "test");
    await Promise.resolve();
    await state.state.storage.put("room-host:checkpoint", "replacement");
    release();
    assert.equal(await saving, false);
    assert.equal(await state.state.storage.get("room-host:checkpoint"), "replacement");
  });

  for (const event of ["close", "error"] as const)
    it(`detaches fallback socket listeners through ${event} peer removal`, async () => {
      const state = hibernatedState([]);
      const room = new NotebookRoom(state.state, {} as Env);
      await state.drain();
      const harness = roomHarness(room);
      const socket = new FakeSocket({ captureListeners: true });
      const listenerMap = (room as unknown as { peerListeners: Map<string, { abort(): void }> })
        .peerListeners;
      let dispatchCalls = 0;
      Object.assign(room, {
        dispatchSocketMessage: async () => {
          dispatchCalls += 1;
        },
      });
      const peer = {
        id: "owner",
        socket: socket.asCloudflareWebSocket(),
        identity: authenticateDevRequest(
          new Request("https://cloud.test/n/demo/sync?user=alice&operator=browser:a&scope=owner"),
        ),
        connectedAt: new Date().toISOString(),
        workstation: null,
      };
      socket.serializeAttachment({
        notebookId: "demo",
        peerId: peer.id,
        identity: peer.identity,
        connectedAt: peer.connectedAt,
      });
      harness.peers.set(peer.id, peer);
      (room as unknown as { acceptPeerSocket(n: string, p: typeof peer): void }).acceptPeerSocket(
        "demo",
        peer,
      );
      const controller = listenerMap.get(peer.id) as unknown as { signal: AbortSignal } | undefined;
      assert.ok(controller, "the fallback path registers a detachable listener");
      assert.equal(
        (controller as unknown as { signal: AbortSignal }).signal.aborted,
        false,
        "the controller starts un-aborted",
      );

      socket.fire("message", { data: new Uint8Array() });
      assert.equal(dispatchCalls, 1, "a live peer's message still dispatches");

      // Exercise removePeer through the registered lifecycle listener, not the
      // detach helper: membership and the AbortController must both be cleared.
      harness.materializers.set("demo", fakeMaterializer(noopMaterializedResult()));
      socket.fire(event, { code: 1000, reason: "test", wasClean: true });
      await state.drain();
      assert.equal(harness.peers.has(peer.id), false);
      assert.equal(listenerMap.has(peer.id), false, "removal detaches the listener registration");
      assert.equal(
        (controller as unknown as { signal: AbortSignal }).signal.aborted,
        true,
        "detachPeerListeners aborts the controller",
      );

      socket.fire("message", { data: new Uint8Array() });
      assert.equal(dispatchCalls, 1, "no dispatch fires for the removed peer");
    });
});
