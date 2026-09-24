import test from "node:test";
import assert from "node:assert/strict";
import { startProviderFixture } from "./provider-fixture.mjs";

test(
  "real celld resolves packages outside tenant, installs offline and restores pinned wheels",
  {
    skip: !process.env.CELLD_BIN || process.env.NTERACT_PACKAGE_NETWORK_TEST !== "1",
    timeout: 180_000,
  },
  async (t) => {
    const server = await startProviderFixture();
    t.after(server.close);
    const identity = { ownerPrincipal: "owner", notebookId: "packages", sessionId: "1" };
    async function post(path, body = {}) {
      const response = await fetch(server.url + path, {
        method: "POST",
        body: JSON.stringify({ ...identity, ...body }),
        signal: AbortSignal.timeout(145_000),
      });
      const value = await response.json();
      assert.equal(response.status, 200, JSON.stringify(value));
      return value;
    }
    await post("/open");
    const result = await post("/packages", {
      operation_id: "install-1",
      operation: "add",
      requirement: "snowballstemmer>=2,<4",
      manifest: null,
    });
    assert.equal(result.status, "ready", JSON.stringify(result));
    assert.ok(result.manifest.wheels.every((wheel) => wheel.sha256.length === 64 && !wheel.body));
    const executed = await post("/execute", {
      execution: {
        cell_id: "package-cell",
        execution_id: "e1",
        source:
          "import snowballstemmer\nkept = 7\nsnowballstemmer.stemmer('english').stemWord('running')",
      },
    });
    assert.equal(executed.outputs.at(-1).data["text/plain"], "'run'");
    // Reach the resolver after the per-owner add cooldown, rather than
    // mistaking an admission rejection for unsupported-package validation.
    await new Promise((resolve) => setTimeout(resolve, 5_100));
    const failed = await post("/packages", {
      operation_id: "install-native",
      operation: "add",
      requirement: "tensorflow",
      manifest: result.manifest,
    });
    assert.equal(failed.status, "error");
    assert.equal(failed.code, "unavailable", JSON.stringify(failed));
    assert.equal(failed.needs_restart, false);
    const afterFailure = await post("/execute", {
      execution: { cell_id: "package-cell", execution_id: "e2", source: "kept" },
    });
    assert.equal(afterFailure.outputs.at(-1).data["text/plain"], "7");
    await post("/close");
    identity.sessionId = "2";
    await post("/open");
    const restored = await post("/packages", {
      operation_id: "restore",
      operation: "restore",
      manifest: result.manifest,
    });
    assert.equal(restored.status, "ready", JSON.stringify(restored));
    const fresh = await post("/execute", {
      execution: {
        cell_id: "package-cell",
        execution_id: "e3",
        source:
          "import snowballstemmer\n(snowballstemmer.stemmer('english').stemWord('running'), 'kept' in globals())",
      },
    });
    assert.equal(fresh.outputs.at(-1).data["text/plain"], "('run', False)");
    const denied = await post("/execute", {
      execution: {
        cell_id: "package-cell",
        execution_id: "network-denied",
        source: "from pyodide.http import pyfetch\nawait pyfetch('https://pypi.org/pypi/six/json')",
      },
    });
    assert.equal(denied.success, false);
    await post("/close");
  },
);
