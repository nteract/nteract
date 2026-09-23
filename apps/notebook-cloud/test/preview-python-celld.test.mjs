import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { startCelld } from "../../preview-python/test/local-celld.mjs";
import { PythonRuntimePeer } from "../../preview-python/src/runtime-peer.js";
import { createOutputPreparer } from "../../preview-python/src/output-manifests.js";
import {
  prepare_output_content,
  RuntimeStatePeerHandle,
} from "../../notebook/src/wasm/runtimed-wasm/runtimed_wasm.js";
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
    const { host, peer, publish } = await fixture(
      t,
      "import pandas as pd\nimport matplotlib.pyplot as plt\nprint('from real Python')\nplt.plot([1,2], [3,4])\nplt.show()\npd.DataFrame({'x':[1,2]})",
    );
    const blobs = new Map();
    const bridge = new PythonRuntimePeer({
      peer,
      sessionKey: "bridge",
      isCurrent: () => true,
      publish,
      pool: {
        execute: async (_key, execution) => {
          const response = await fetch(server.url + "/bridge", {
            method: "POST",
            body: JSON.stringify(execution),
            signal: AbortSignal.timeout(40000),
          });
          assert.equal(response.status, 200, await response.clone().text());
          return response.json();
        },
        release: async () => {},
      },
      prepareOutputs: createOutputPreparer({
        prepareContent: prepare_output_content,
        putBlob: async (blob) => blobs.set(blob.hash, blob),
      }),
    });
    await bridge.drain();
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
    assert.match(html.inline ?? new TextDecoder().decode(blobs.get(html.blob).bytes), /<table/);
    const png = executions[0].outputs.find((o) => o.data?.["image/png"]).data["image/png"];
    assert.deepEqual(
      Array.from(blobs.get(png.blob).bytes.slice(0, 8)),
      [137, 80, 78, 71, 13, 10, 26, 10],
    );
    await bridge.close();
  },
);
