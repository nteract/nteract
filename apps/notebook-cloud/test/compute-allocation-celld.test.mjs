import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { readFile, readdir } from "node:fs/promises";
import { resolve, basename } from "node:path";
import { startCelld } from "../../preview-python/test/local-celld.mjs";

test(
  "real celld allocation crash recovery, alarms and provider fencing",
  { skip: !process.env.CELLD_BIN, timeout: 180_000 },
  async (t) => {
    const root = new URL("../../preview-python/dist/", import.meta.url).pathname;
    const files = {};
    for (const filename of await readdir(root + "/wheels"))
      files["assets/__preview-python-packages/" + filename] = await readFile(
        root + "/wheels/" + filename,
      );
    const bundle = await build({
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      external: ["cloudflare:workers"],
      plugins: [
        {
          name: "wasm-modules",
          setup(b) {
            b.onResolve({ filter: /\.wasm$/ }, async (args) => {
              const name = basename(args.path);
              files[name] = await readFile(resolve(args.resolveDir, args.path));
              return { path: "./" + name, external: true };
            });
          },
        },
      ],
      stdin: {
        resolveDir: root,
        contents: `
    export { PreviewPythonSessions, PackageAssets } from './provider.js';
    import { ComputeAllocation as Allocation, allocationObjectName } from '../../notebook-cloud/src/compute-allocation.ts';
    export class ComputeAllocation extends Allocation {
      constructor(state, env) { super(state, env); this.probeState=state; }
      async fetch(request) {
        if(new URL(request.url).pathname==='/arm-probe') { await this.probeState.storage.setAlarm(Date.now()+300); return Response.json({ok:true}); }
        return super.fetch(request);
      }
    }
    export default { async fetch(request,env) {
      const path=new URL(request.url).pathname;
      const input=await request.json();
      const target=path.startsWith('/allocation/') ? env.COMPUTE_ALLOCATIONS.get(env.COMPUTE_ALLOCATIONS.idFromName(allocationObjectName(input))) : env.PREVIEW_PYTHON_SESSIONS.get(env.PREVIEW_PYTHON_SESSIONS.idFromName('preview-python:deployment:v1'));
      return target.fetch(new Request('https://private.invalid/'+path.split('/').at(-1),{method:'POST',body:JSON.stringify(input)}));
    }};`,
      },
    });
    const server = await startCelld(
      { ...files, "index.js": bundle.outputFiles[0].text },
      {
        vars: { NOTEBOOK_CLOUD_PYTHON_PROVIDER: "celld" },
        assets: { directory: "assets", binding: "ASSETS" },
        worker_loaders: [{ binding: "LOADER" }],
        durable_objects: {
          bindings: [
            { name: "PREVIEW_PYTHON_SESSIONS", class_name: "PreviewPythonSessions" },
            { name: "COMPUTE_ALLOCATIONS", class_name: "ComputeAllocation" },
          ],
        },
        services: [
          { binding: "PACKAGES", service: "python-runtime-probe", entrypoint: "PackageAssets" },
        ],
      },
    );
    const who = { ownerPrincipal: "probe-owner", notebookId: "probe-notebook", sessionId: "first" };
    const results = [];
    async function post(path, body = who) {
      const r = await fetch(server.url + path, {
        method: "POST",
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(45000),
      });
      return { status: r.status, body: await r.json() };
    }
    try {
      const initial = await post("/allocation/ensure");
      assert.equal(initial.status, 200, JSON.stringify(initial));
      const executed = await post("/provider/execute", {
        ...who,
        execution: { cell_id: "probe-cell", execution_id: "e1", source: "saved = 41\nsaved + 1" },
      });
      assert.equal(executed.body.outputs.at(-1).data["text/plain"], "42");
      results.push("real Python direct execution");
      await server.restart({ crash: true });
      const lost = await post("/allocation/ensure");
      assert.equal(lost.status, 409);
      assert.match(lost.body.error, /lost/);
      results.push("crash recovery rejects lost Python state");
      who.sessionId = "second";
      assert.equal((await post("/allocation/ensure")).status, 200);
      const fresh = await post("/provider/execute", {
        ...who,
        execution: { cell_id: "probe-cell", execution_id: "e2", source: "'saved' in globals()" },
      });
      assert.equal(fresh.body.outputs.at(-1).data["text/plain"], "False");
      results.push("new generation has fresh globals");
      assert.equal((await post("/provider/close")).status, 200);
      await post("/allocation/arm-probe");
      let status;
      const deadline = Date.now() + 15000;
      do {
        await new Promise((r) => setTimeout(r, 200));
        status = await post("/allocation/status");
      } while (status.body.allocation.phase !== "failed" && Date.now() < deadline);
      assert.equal(status.body.allocation.phase, "failed");
      results.push("real alarm reconciles missing provider");
      assert.equal((await post("/provider/open")).status, 409);
      results.push("provider release fence rejects delayed open");
      t.diagnostic(JSON.stringify({ passed: results }));
    } catch (error) {
      t.diagnostic(server.logs());
      throw error;
    } finally {
      await server.close();
    }
  },
);
