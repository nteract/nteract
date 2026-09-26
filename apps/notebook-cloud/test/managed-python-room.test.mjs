import { test } from "node:test";
import assert from "node:assert/strict";
import { ManagedPythonRoom } from "../src/managed-python-room.ts";
import { SessionPool } from "../../preview-python/src/session-pool.js";
import { createProviderService } from "../../preview-python/src/provider-service.js";
import { initializeTestRuntimedWasm } from "./runtimed-wasm-test-loader.ts";
import { fixture, sync } from "./preview-python-helpers.mjs";
import { RuntimeStatePeerHandle } from "../src/runtimed-wasm.ts";
import { encodeTypedFrame } from "../src/protocol.ts";

for (const failurePhase of ["before_install", "after_install", "unconfirmed_install"])
  test(`package publication failure preserves recovery state: ${failurePhase}`, async (t) => {
    await initializeTestRuntimedWasm();
    const { host } = await fixture(t);
    host.set_workstation_attachment_json(
      JSON.stringify({
        workstation_id: "celld-preview-python",
        display_name: "Python",
        provider: "celld-pyodide",
        default_environment_label: "Python",
        environment_policy: "curated",
        status: "connecting",
        runtime_session_id: "session",
      }),
    );
    let installs = 0;
    let executions = 0;
    let failCheckpoint = false;
    let injectFailure = false;
    const pool = new SessionPool({
      warmCount: 0,
      create: async () => ({
        info: { installed: [] },
        install: async () => {
          installs++;
          return { status: "ready", installed: ["six==1.0"] };
        },
        execute: async () => {
          executions++;
          return { success: true, execution_count: 1, outputs: [] };
        },
        dispose: async () => {},
      }),
    });
    const service = createProviderService(pool, undefined, {
      resolve: async (requirements) => ({ requirements, wheels: [] }),
    });
    const states = [];
    const materializer = {
      getCloudPackageManifest: async () => null,
      setCloudPackageState: async (sessionId, value) => {
        states.push(value.managed_packages);
        return host.set_cloud_package_state_json(sessionId, JSON.stringify(value));
      },
      syncPeer: async (peer) => host.sync_peer(peer.id, peer.identity.scope),
      receiveFrame: async (peer, frame) =>
        host.receive_peer_frame(
          peer.id,
          peer.identity.principal,
          peer.identity.actorLabel,
          peer.identity.scope,
          false,
          encodeTypedFrame(frame.type, frame.payload),
        ),
      checkpoint: async () => {
        if (failCheckpoint) {
          failCheckpoint = false;
          throw new Error("checkpoint unavailable");
        }
      },
      removePeer: async (id) => host.remove_peer(id),
    };
    const runtime = new ManagedPythonRoom(
      {
        NOTEBOOK_CLOUD_PYTHON_PROVIDER: "celld",
        PREVIEW_PYTHON_SESSIONS: {
          idFromName: (name) => name,
          get: () => ({
            fetch: async (request) => {
              const result = await service.fetch(request);
              if (
                injectFailure &&
                failurePhase !== "before_install" &&
                new URL(request.url).pathname === "/packages"
              ) {
                injectFailure = false;
                failCheckpoint = true;
                if (failurePhase === "unconfirmed_install")
                  throw new Error("provider response was lost after install");
              }
              return result;
            },
          }),
        },
      },
      materializer,
      "notebook",
      "user:dev:owner",
      "session",
      (result) => runtime.accept(result),
    );
    try {
      await runtime.start();
      injectFailure = true;
      failCheckpoint = failurePhase === "before_install";
      const manifest = { version: 1, pyodide: "0.28.3", requirements: [], wheels: [] };
      if (failurePhase === "unconfirmed_install") {
        const result = await runtime.installPackages(manifest, "add", "six");
        assert.equal(result.status, "error");
        assert.equal(
          result.needs_restart,
          true,
          "failed error publication must preserve restart guidance",
        );
      } else {
        await assert.rejects(
          runtime.installPackages(manifest, "add", "six"),
          /checkpoint unavailable/,
        );
      }
      assert.equal(installs, failurePhase === "before_install" ? 0 : 1);
      const inventory = await (
        await service.fetch(
          new Request("https://provider/packages/inventory", {
            method: "POST",
            body: JSON.stringify({
              ownerPrincipal: "user:dev:owner",
              notebookId: "notebook",
              sessionId: "session",
            }),
          }),
        )
      ).json();
      assert.deepEqual(inventory.installed, failurePhase === "before_install" ? [] : ["six==1.0"]);
      assert.equal(states.at(-1).needs_restart, failurePhase === "unconfirmed_install");
      assert.equal(
        states.at(-1).phase,
        "error",
        "recovered publication clears the busy phase for retry",
      );
      await runtime.wake();
      assert.equal(
        executions,
        failurePhase === "unconfirmed_install" ? 0 : 1,
        "only unconfirmed provider work blocks accepted execution",
      );
    } finally {
      await runtime.close();
      await pool.close();
    }
  });

for (const outcome of [
  "restored",
  "restore_failure",
  "stale_lock",
  "contention_success",
  "contention_other_owner",
  "contention_other_owner_cancel",
  "contention_cancel",
  "contention_timeout",
]) {
  test(
    `managed startup preserves saved intent and reports package state: ${outcome}`,
    { timeout: 10_000 },
    async (t) => {
      await initializeTestRuntimedWasm();
      const { host } = await fixture(t);
      const manifest = {
        version: 1,
        pyodide: outcome === "stale_lock" ? "old" : "0.28.3",
        requirements: ["six>=1"],
        wheels: [],
      };
      host.compare_set_cloud_package_manifest_json("null", JSON.stringify(manifest));
      host.set_workstation_attachment_json(
        JSON.stringify({
          workstation_id: "celld-preview-python",
          display_name: "Python",
          provider: "celld-pyodide",
          default_environment_label: "Python",
          environment_policy: "curated",
          status: "connecting",
          runtime_session_id: "restore-session",
        }),
      );
      const requests = [];
      const states = [];
      let runtime;
      let waiting;
      const waitingForCapacity = new Promise((resolve) => {
        waiting = resolve;
      });
      let service, pool, releaseAdd, addResult, releaseAhead, aheadResult, aheadStarted;
      if (outcome.startsWith("contention")) {
        const gate = new Promise((resolve) => {
          releaseAdd = resolve;
        });
        let entered;
        const firstStarted = new Promise((resolve) => {
          entered = resolve;
        });
        pool = new SessionPool({
          warmCount: 0,
          maxSessions: 4,
          maxSessionsPerOwner: 2,
          create: async () => ({
            info: { installed: [] },
            install: async () => ({ status: "ready", installed: ["six==1.0"] }),
            dispose: async () => {},
          }),
        });
        let enterAhead;
        aheadStarted = new Promise((resolve) => {
          enterAhead = resolve;
        });
        const aheadGate = new Promise((resolve) => {
          releaseAhead = resolve;
        });
        service = createProviderService(pool, undefined, {
          resolve: async (requirements) => {
            if (requirements.includes("ahead")) {
              enterAhead();
              await aheadGate;
            } else {
              entered();
              await gate;
            }
            return { requirements, wheels: [] };
          },
        });
        const firstIdentity = {
          ownerPrincipal: outcome.startsWith("contention_other_owner")
            ? "user:dev:other"
            : "user:dev:owner",
          notebookId: "other-notebook",
          sessionId: "add-session",
        };
        const post = (path, extra = {}) =>
          service.fetch(
            new Request("https://provider" + path, {
              method: "POST",
              body: JSON.stringify({ ...firstIdentity, ...extra }),
            }),
          );
        await post("/open");
        addResult = post("/packages", {
          operation: "add",
          requirement: "six",
          manifest: null,
          operation_id: "add",
        });
        t.after(async () => {
          releaseAdd();
          releaseAhead();
          await addResult;
          await aheadResult;
          await pool.close();
        });
        await firstStarted;
        t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
        if (outcome.startsWith("contention_other_owner")) {
          const aheadIdentity = {
            ownerPrincipal: "user:dev:ahead",
            notebookId: "ahead",
            sessionId: "ahead",
          };
          await post("/open", aheadIdentity);
          aheadResult = post("/packages", {
            ...aheadIdentity,
            operation: "add",
            requirement: "ahead",
            manifest: null,
            operation_id: "ahead",
          });
          await new Promise((resolve) => setImmediate(resolve));
        }
      }
      const materializer = {
        getCloudPackageManifest: async () => JSON.parse(host.get_cloud_package_manifest_json()),
        setCloudPackageState: async (session, value) => {
          states.push({ ...value.managed_packages, message: value.message });
          if (value.message?.startsWith("Waiting for another")) waiting();
          return host.set_cloud_package_state_json(session, JSON.stringify(value));
        },
        syncPeer: async (peer) => host.sync_peer(peer.id, peer.identity.scope),
        receiveFrame: async (peer, frame) =>
          host.receive_peer_frame(
            peer.id,
            peer.identity.principal,
            peer.identity.actorLabel,
            peer.identity.scope,
            false,
            encodeTypedFrame(frame.type, frame.payload),
          ),
        checkpoint: async () => {},
        removePeer: async (id) => host.remove_peer(id),
      };
      runtime = new ManagedPythonRoom(
        {
          NOTEBOOK_CLOUD_PYTHON_PROVIDER: "celld",
          PREVIEW_PYTHON_SESSIONS: {
            idFromName: (name) => name,
            get: () => ({
              fetch: async (request) => {
                const path = new URL(request.url).pathname;
                requests.push({ path, ...(await request.clone().json()) });
                if (service) {
                  if (path === "/packages") {
                    assert.equal(states.at(-1).phase, "restoring");
                    assert.equal(
                      states.at(-1).message,
                      null,
                      "a retry must clear waiting copy before acquisition and installation can begin",
                    );
                  }
                  return service.fetch(request);
                }
                if (path === "/packages/inventory") return Response.json({ installed: [] });
                if (path === "/packages")
                  return Response.json(
                    outcome === "restore_failure"
                      ? { status: "error", error: "Download unavailable", needs_restart: false }
                      : { status: "ready", installed: ["six==1.0"], manifest },
                  );
                return Response.json({ ok: true });
              },
            }),
          },
        },
        materializer,
        "notebook",
        "user:dev:owner",
        "restore-session",
        (result) => runtime.accept(result),
      );
      if (service) {
        // Exercise two notebook sessions through the real service, pool and
        // admission lane; only the Python machine is a deterministic stub.
        const started = runtime.start().then(
          () => null,
          (error) => error,
        );
        if (outcome.startsWith("contention_other_owner")) {
          for (
            let round = 0;
            round < 100 && !requests.some((request) => request.path === "/packages");
            round++
          )
            await new Promise((resolve) => setImmediate(resolve));
          await new Promise((resolve) => setImmediate(resolve));
          t.mock.timers.tick(90_000);
          releaseAdd();
          await addResult;
          await aheadStarted;
          t.mock.timers.tick(100_000); // Two legal active turns, past the room's180s retry window.
          await new Promise((resolve) => setImmediate(resolve));
          assert.equal(states.at(-1).phase, "restoring");
          assert.equal(
            requests.filter((request) => request.path === "/packages").length,
            1,
            "a retained request is not retried at180s",
          );
          const health = await (await service.fetch(new Request("https://provider/health"))).json();
          assert.deepEqual(
            { active: health.packages.active, waiting: health.packages.waiting },
            { active: true, waiting: 1 },
          );
          if (outcome.endsWith("cancel")) {
            const publications = states.length;
            await runtime.close();
            assert.match((await started).message, /expired/);
            releaseAhead();
            await aheadResult;
            assert.equal(
              states.length,
              publications,
              "queued cancellation cannot later publish ready",
            );
          } else {
            releaseAhead();
            await aheadResult;
            assert.equal(await started, null);
            assert.equal(states.at(-1).phase, "ready");
            assert.equal(requests.filter((request) => request.path === "/packages").length, 1);
            await runtime.close();
          }
          await pool.close();
          return;
        }
        await waitingForCapacity;
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(states.at(-1).phase, "restoring");
        assert.match(states.at(-1).message, /Waiting for another package installation/);
        const health = await (await service.fetch(new Request("https://provider/health"))).json();
        assert.equal(health.packages.active, true);
        assert.equal(
          health.packages.waiting,
          0,
          "same-owner retries do not occupy a second queue slot",
        );
        await runtime.wake();
        assert.ok(!requests.some((request) => request.path === "/execute"));
        if (outcome === "contention_success" || outcome === "contention_other_owner") {
          releaseAdd();
          assert.equal((await (await addResult).json()).status, "ready");
          await new Promise((resolve) => setImmediate(resolve));
          t.mock.timers.tick(1_000);
          assert.equal(await started, null);
          assert.equal(states.at(-1).phase, "ready");
          const attempts = requests.filter((request) => request.path === "/packages");
          assert.equal(attempts.length, 2);
          assert.notEqual(attempts[0].operation_id, attempts[1].operation_id);
          assert.equal(
            states.at(-1).operation_id,
            attempts[0].operation_id,
            "logical progress remains correlated",
          );
          await runtime.close();
        } else if (outcome === "contention_cancel") {
          const publications = states.length;
          await runtime.close();
          assert.match((await started).message, /expired/);
          t.mock.timers.tick(180_000);
          await new Promise((resolve) => setImmediate(resolve));
          assert.equal(requests.filter((request) => request.path === "/packages").length, 1);
          assert.equal(
            states.length,
            publications,
            "cancelled startup never publishes stale success or error",
          );
        } else {
          for (let i = 0; i < 18; i++) {
            t.mock.timers.tick(10_000);
            await new Promise((resolve) => setImmediate(resolve));
          }
          assert.match((await started).message, /Another package installation/);
          assert.equal(states.at(-1).phase, "error");
          assert.equal(states.at(-1).needs_restart, true);
          assert.ok(!states.some((state) => state.phase === "ready"));
          await runtime.close();
        }
        assert.deepEqual(JSON.parse(host.get_cloud_package_manifest_json()), manifest);
        releaseAdd();
        await addResult;
        await pool.close();
        return;
      }
      if (outcome === "restored") {
        await runtime.start();
        const before = { requests: requests.length, publications: states.length };
        for (const operationId of ["", "x".repeat(129)])
          await assert.rejects(
            runtime.installPackages(manifest, "add", "six", operationId),
            /Invalid package operation ID/,
          );
        assert.deepEqual(
          { requests: requests.length, publications: states.length },
          before,
          "invalid client operation IDs cannot reach provider work or durable progress",
        );
      } else
        await assert.rejects(
          runtime.start(),
          outcome === "stale_lock" ? /Saved packages cannot/ : /Download unavailable/,
        );
      assert.deepEqual(
        JSON.parse(host.get_cloud_package_manifest_json()),
        manifest,
        "failed or successful restore cannot rewrite requirements",
      );
      assert.equal(states.at(-1).phase, outcome === "restored" ? "ready" : "error");
      if (outcome === "stale_lock")
        assert.ok(!requests.some((request) => request.path === "/packages"));
      else {
        const restore = requests.find((request) => request.path === "/packages");
        assert.equal(restore.operation, "restore");
        assert.deepEqual(restore.manifest, manifest);
        assert.equal(states.at(-1).operation_id, restore.operation_id);
      }
      await runtime.close();
    },
  );
}

for (const staleQueue of [false, true])
  test(`managed room publishes execution and repairs stale queue: ${staleQueue}`, async (t) => {
    await initializeTestRuntimedWasm();
    const { host, peer, publish } = await fixture(t);
    if (staleQueue) {
      const id = Object.keys(peer.get_runtime_state().executions)[0];
      peer.set_execution_done(id, true);
      await publish();
    }
    host.set_workstation_attachment_json(
      JSON.stringify({
        workstation_id: "celld-preview-python",
        display_name: "Python (sandboxed)",
        provider: "celld-pyodide",
        default_environment_label: "Python",
        environment_policy: "curated",
        status: "connecting",
        runtime_session_id: "session",
      }),
    );
    const requests = [];
    const env = {
      NOTEBOOK_CLOUD_PYTHON_PROVIDER: "celld",
      PREVIEW_PYTHON_SESSIONS: {
        idFromName: (n) => n,
        get: () => ({
          fetch: async (request) => {
            const body = await request.json();
            requests.push({ path: new URL(request.url).pathname, ...body });
            if (new URL(request.url).pathname === "/execute")
              return Response.json({
                execution_count: 1,
                success: true,
                outputs: [{ output_type: "stream", name: "stdout", text: "managed output\n" }],
              });
            return Response.json({ ok: true });
          },
        }),
      },
    };
    const materializer = {
      getCloudPackageManifest: async () => null,
      setCloudPackageState: async (sessionId, value) =>
        host.set_cloud_package_state_json(sessionId, JSON.stringify(value)),
      syncPeer: async (peer) => host.sync_peer(peer.id, peer.identity.scope),
      receiveFrame: async (peer, frame) =>
        host.receive_peer_frame(
          peer.id,
          peer.identity.principal,
          peer.identity.actorLabel,
          peer.identity.scope,
          false,
          encodeTypedFrame(frame.type, frame.payload),
        ),
      checkpoint: async () => {},
      removePeer: async (id) => host.remove_peer(id),
    };
    const runtime = new ManagedPythonRoom(
      env,
      materializer,
      "notebook",
      "user:dev:owner",
      "session",
      (result) => runtime.accept(result),
    );
    await runtime.start();
    await runtime.wake();
    assert.equal(requests[0].path, "/open");
    const executed = requests.find((r) => r.path === "/execute");
    if (!staleQueue) {
      assert.equal(executed.ownerPrincipal, "user:dev:owner");
      assert.equal(executed.notebookId, "notebook");
      assert.equal(executed.sessionId, "session");
      assert.equal(executed.execution.source, "print('accepted from notebook')");
    } else assert.equal(executed, undefined);
    const viewer = new RuntimeStatePeerHandle("user:dev:viewer/test");
    t.after(() => viewer.free());
    sync(host, viewer, "viewer", "viewer", true);
    const execution = Object.values(viewer.get_runtime_state().executions)[0];
    assert.equal(execution.status, "done");
    if (!staleQueue) assert.deepEqual(execution.outputs[0].text, { inline: "managed output\n" });
    assert.equal(viewer.get_runtime_state().queue.executing, null);
    assert.deepEqual(viewer.get_runtime_state().queue.queued, []);
    await runtime.close();
    assert.equal(requests.at(-1).path, "/close");
  });

for (const checkpointOutcome of ["complete", "close", "fail"])
  test(`managed room preserves a wake during its final execution checkpoint: ${checkpointOutcome}`, async (t) => {
    await initializeTestRuntimedWasm();
    const { host, owner, request } = await fixture(t);
    owner.add_cell(1, "next", "code");
    owner.update_source("next", "print('queued during checkpoint')");
    sync(host, owner, "owner", "owner");
    host.set_workstation_attachment_json(
      JSON.stringify({
        workstation_id: "celld-preview-python",
        display_name: "Python (sandboxed)",
        provider: "celld-pyodide",
        default_environment_label: "Python",
        environment_policy: "curated",
        status: "connecting",
        runtime_session_id: "session",
      }),
    );
    const executions = [];
    let releaseCheckpoint;
    const checkpointReleased = new Promise((resolve) => {
      releaseCheckpoint = resolve;
    });
    let enterCheckpoint;
    const checkpointEntered = new Promise((resolve) => {
      enterCheckpoint = resolve;
    });
    let checkpointHeld = false;
    const env = {
      NOTEBOOK_CLOUD_PYTHON_PROVIDER: "celld",
      PREVIEW_PYTHON_SESSIONS: {
        idFromName: (name) => name,
        get: () => ({
          fetch: async (request) => {
            if (new URL(request.url).pathname !== "/execute") return Response.json({ ok: true });
            executions.push((await request.json()).execution);
            return Response.json({
              execution_count: executions.length,
              success: true,
              outputs: [],
            });
          },
        }),
      },
    };
    const materializer = {
      getCloudPackageManifest: async () => null,
      setCloudPackageState: async (sessionId, value) =>
        host.set_cloud_package_state_json(sessionId, JSON.stringify(value)),
      syncPeer: async (peer) => host.sync_peer(peer.id, peer.identity.scope),
      receiveFrame: async (peer, frame) =>
        host.receive_peer_frame(
          peer.id,
          peer.identity.principal,
          peer.identity.actorLabel,
          peer.identity.scope,
          false,
          encodeTypedFrame(frame.type, frame.payload),
        ),
      checkpoint: async () => {
        if (executions.length === 1 && !checkpointHeld) {
          checkpointHeld = true;
          enterCheckpoint();
          await checkpointReleased;
          if (checkpointOutcome === "fail") throw new Error("checkpoint failed");
        }
      },
      removePeer: async (id) => host.remove_peer(id),
    };
    const runtime = new ManagedPythonRoom(
      env,
      materializer,
      "notebook",
      "user:dev:owner",
      "session",
      (result) => runtime.accept(result),
    );
    let closing;
    try {
      await runtime.start();
      const firstWake = runtime.wake();
      await checkpointEntered;
      // The first execution is already published as done, but its checkpoint is
      // still pending. The next accepted request only reaches the peer on sync.
      runtime.accept(request("owner", "next"));
      const nextWake = runtime.wake();
      if (checkpointOutcome === "close") closing = runtime.close();
      releaseCheckpoint();
      if (checkpointOutcome === "fail") {
        await assert.rejects(Promise.all([firstWake, nextWake]), /checkpoint failed/);
      } else {
        await Promise.all([firstWake, nextWake]);
      }

      assert.deepEqual(
        executions.map((execution) => execution.cell_id),
        checkpointOutcome === "complete" ? ["code", "next"] : ["code"],
      );
      if (checkpointOutcome !== "complete") return;
      assert.equal(executions[1].source, "print('queued during checkpoint')");
      const viewer = new RuntimeStatePeerHandle("user:dev:viewer/test");
      t.after(() => viewer.free());
      sync(host, viewer, "viewer", "viewer", true);
      assert.deepEqual(
        Object.values(viewer.get_runtime_state().executions).map((execution) => execution.status),
        ["done", "done"],
      );
    } finally {
      releaseCheckpoint();
      await (closing ?? runtime.close());
    }
  });

test("managed lifecycle updates cannot overwrite a replacement session", async () => {
  await initializeTestRuntimedWasm();
  const { RoomMaterializer } = await import("../src/room-materializer.ts");
  const materializer = new RoomMaterializer(
    "fencing",
    { storage: { get: async () => undefined } },
    {},
  );
  const attachment = {
    workstation_id: "celld-preview-python",
    display_name: "Python (sandboxed)",
    provider: "celld-pyodide",
    default_environment_label: "Python",
    environment_policy: "curated",
    status: "connecting",
    runtime_session_id: "old",
  };
  await materializer.setWorkstationAttachment(attachment);
  await materializer.setWorkstationAttachment({ ...attachment, runtime_session_id: "replacement" });
  assert.equal(
    (await materializer.transitionManagedPythonSession("old", "error", "old startup failed"))
      .ignored_stale,
    true,
  );
  assert.equal(
    (await materializer.transitionManagedPythonSession("old", "ready")).ignored_stale,
    true,
  );
  assert.equal((await materializer.getWorkstationAttachment()).status, "connecting");
  await materializer.transitionManagedPythonSession(
    "replacement",
    "error",
    "package initialization failed",
  );
  const failed = await materializer.getWorkstationAttachment();
  assert.equal(failed.status, "error");
  assert.equal(failed.status_message, "package initialization failed");
  assert.equal(
    (await materializer.transitionManagedPythonSession("replacement", "ready")).ignored_stale,
    true,
  );
});

test("managed live execute reads split NDJSON, accepts older providers and rejects trailing output", async () => {
  const responses = [];
  const env = {
    NOTEBOOK_CLOUD_PYTHON_PROVIDER: "celld",
    PREVIEW_PYTHON_SESSIONS: {
      idFromName: (n) => n,
      get: () => ({
        fetch: async (request) => {
          assert.equal((await request.json()).stream, true);
          return responses.shift()();
        },
      }),
    },
  };
  const runtime = new ManagedPythonRoom(
    env,
    { removePeer: async () => {} },
    "notebook",
    "user:dev:owner",
    "session",
    () => {},
  );
  const ndjson = (chunks) =>
    new Response(
      new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
          controller.close();
        },
      }),
      { headers: { "content-type": "application/x-ndjson" } },
    );
  const execution = { execution_id: "e", cell_id: "c", source: "print('a')" };
  const result = { execution_count: 1, success: true, outputs: [] };
  const events = [];
  responses.push(() =>
    ndjson([
      '{"type":"stream","name":"stdout","te',
      'xt":"a\\n"}\n{"type":"res',
      `ult","result":${JSON.stringify(result)}}\n`,
    ]),
  );
  assert.deepEqual(await runtime.executeLive(execution, (event) => events.push(event)), result);
  assert.deepEqual(events, [{ type: "stream", name: "stdout", text: "a\n" }]);
  // A provider that predates live output answers with the plain batch.
  responses.push(() => Response.json(result));
  assert.deepEqual(await runtime.executeLive(execution, () => {}), result);
  responses.push(() => ndjson(['{"type":"error","error":"Error: boom"}\n']));
  await assert.rejects(
    runtime.executeLive(execution, () => {}),
    /boom/,
  );
  responses.push(() =>
    ndjson([
      `{"type":"result","result":${JSON.stringify(result)}}\n`,
      '{"type":"stream","name":"stdout","text":"late"}\n',
    ]),
  );
  await assert.rejects(
    runtime.executeLive(execution, () => {}),
    /continued after/,
  );
  responses.push(() => ndjson(['{"type":"stream","name":"stdout","text":"x"}\n']));
  await assert.rejects(
    runtime.executeLive(execution, () => {}),
    /without a result/,
  );
});

test("closing a managed session cancels a live response without a terminal record", async () => {
  await initializeTestRuntimedWasm();
  let controller;
  let cancelled = false;
  let observed;
  const firstOutput = new Promise((resolve) => {
    observed = resolve;
  });
  const env = {
    NOTEBOOK_CLOUD_PYTHON_PROVIDER: "celld",
    PREVIEW_PYTHON_SESSIONS: {
      idFromName: (name) => name,
      get: () => ({
        fetch: async (request) => {
          if (new URL(request.url).pathname === "/close") return Response.json({ ok: true });
          return new Response(
            new ReadableStream({
              start(value) {
                controller = value;
                controller.enqueue(
                  new TextEncoder().encode('{"type":"stream","name":"stdout","text":"partial"}\n'),
                );
              },
              cancel() {
                cancelled = true;
              },
            }),
            { headers: { "content-type": "application/x-ndjson" } },
          );
        },
      }),
    },
  };
  const runtime = new ManagedPythonRoom(
    env,
    { removePeer: async () => {} },
    "notebook",
    "user:dev:owner",
    "session",
    () => {},
  );
  const executing = runtime.executeLive(
    { execution_id: "e", cell_id: "c", source: "await pending" },
    observed,
  );
  runtime.pumping = executing;
  const rejected = assert.rejects(executing, /abort|expired|without a result/i);
  await firstOutput;
  const closing = runtime.close();
  try {
    await Promise.resolve();
    assert.equal(cancelled, true, "Interrupt must not wait for a dead guest's terminal response");
  } finally {
    if (!cancelled) controller.close();
    await rejected;
    await closing;
  }
});
