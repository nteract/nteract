import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { startCelld } from "../../preview-python/test/local-celld.mjs";
import { ManagedPythonRoom } from "../src/managed-python-room.ts";
import { encodeTypedFrame } from "../src/protocol.ts";
import { blobKey } from "../src/storage.ts";
import { RuntimeStatePeerHandle } from "../../notebook/src/wasm/runtimed-wasm/runtimed_wasm.js";
import { initializeTestRuntimedWasm } from "./runtimed-wasm-test-loader.ts";
import { fixture, sync } from "./preview-python-helpers.mjs";

test(
  "real celld Python publishes scientific output through the Automerge room",
  { timeout: 90000, skip: !process.env.CELLD_BIN },
  async (t) => {
    await initializeTestRuntimedWasm();
    const root = fileURLToPath(new URL("../../preview-python/", import.meta.url));
    const bundle = await build({
      absWorkingDir: root,
      entryPoints: ["test/session-driver.js"],
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      target: "es2022",
      external: ["cloudflare:workers"],
      loader: { ".wasm": "binary", ".whl": "binary" },
      plugins: [
        {
          name: "session-source",
          setup(builder) {
            builder.onLoad({ filter: /dist\/session\.js$/ }, async (args) => ({
              contents: await readFile(args.path, "utf8"),
              loader: "text",
            }));
          },
        },
      ],
    });
    const server = await startCelld(
      { "index.js": bundle.outputFiles[0].text },
      {
        worker_loaders: [{ binding: "LOADER" }],
        services: [
          { binding: "PACKAGES", service: "python-runtime-probe", entrypoint: "PackageAssets" },
        ],
      },
    );
    t.after(server.close);
    const { host, owner, request } = await fixture(
      t,
      "import pandas as pd\nimport matplotlib.pyplot as plt\nprint('from real Python')\nplt.plot([1,2], [3,4])\nplt.show()\npd.DataFrame({'x':[1,2]})",
    );
    const blobs = new Map();
    host.set_workstation_attachment_json(
      JSON.stringify({
        workstation_id: "celld-preview-python",
        display_name: "Preview Python",
        provider: "celld-pyodide",
        default_environment_label: "Python",
        environment_policy: "curated",
        status: "connecting",
        runtime_session_id: "bridge",
      }),
    );
    const env = {
      NOTEBOOK_CLOUD_PYTHON_PROVIDER: "celld",
      PREVIEW_PYTHON_SESSIONS: {
        idFromName: (name) => name,
        get: () => ({
          fetch: (request) =>
            fetch(server.url + "/private" + new URL(request.url).pathname, {
              method: request.method,
              body: request.body,
              duplex: "half",
              signal: AbortSignal.timeout(40000),
            }),
        }),
      },
      NOTEBOOK_SNAPSHOTS: {
        head: async (key) => blobs.get(key) ?? null,
        put: async (key, bytes, metadata) => {
          if (blobs.has(key)) return null;
          const object = { bytes, size: bytes.byteLength, ...metadata };
          blobs.set(key, object);
          return object;
        },
      },
    };
    const materializer = {
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
    const bridge = new ManagedPythonRoom(
      env,
      materializer,
      "notebook",
      "user:dev:owner",
      "bridge",
      (result) => bridge.accept(result),
    );
    await bridge.start();
    await bridge.wake();
    const viewer = new RuntimeStatePeerHandle("user:dev:viewer/test");
    t.after(() => viewer.free());
    sync(host, viewer, "viewer", "viewer", true);
    const executions = Object.values(viewer.get_runtime_state().executions);
    assert.equal(executions.length, 1);
    assert.equal(executions[0].status, "done");
    assert.equal(executions[0].success, true);
    assert.match(
      executions[0].outputs
        .filter((o) => o.output_type === "stream")
        .map((o) => o.text.inline)
        .join(""),
      /from real Python/,
    );
    const html = executions[0].outputs.find((o) => o.data?.["text/html"]).data["text/html"];
    assert.match(
      html.inline ?? new TextDecoder().decode(blobs.get(blobKey("notebook", html.blob)).bytes),
      /<table/,
    );
    const png = executions[0].outputs.find((o) => o.data?.["image/png"]).data["image/png"];
    assert.deepEqual(
      Array.from(blobs.get(blobKey("notebook", png.blob)).bytes.slice(0, 8)),
      [137, 80, 78, 71, 13, 10, 26, 10],
    );
    async function runAccepted(source) {
      owner.update_source("code", source);
      sync(host, owner, "owner", "owner");
      const accepted = request();
      bridge.accept(accepted);
      sync(host, owner, "owner", "owner", false, accepted.outbound);
      await bridge.wake();
    }
    await runAccepted("saved_after_error = 99\nraise ValueError('expected recovery probe')");
    await runAccepted("saved_after_error");
    const recoveredViewer = new RuntimeStatePeerHandle("user:dev:recovery-viewer/test");
    t.after(() => recoveredViewer.free());
    sync(host, recoveredViewer, "recovery-viewer", "viewer", true);
    const recovered = Object.values(recoveredViewer.get_runtime_state().executions);
    assert.ok(recovered.some((execution) => execution.success === false));
    const last = recovered.find((execution) => execution.source === "saved_after_error");
    assert.equal(last.success, true);
    assert.deepEqual(last.outputs.at(-1).data["text/plain"], { inline: "99" });
    await bridge.close();
  },
);
