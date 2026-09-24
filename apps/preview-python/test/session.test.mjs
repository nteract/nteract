import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { startCelld } from "./local-celld.mjs";
const root = fileURLToPath(new URL("..", import.meta.url));

test(
  "real celld Python sessions persist, isolate and contain termination",
  { timeout: 120000 },
  async (t) => {
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
          {
            binding: "SLOW_PACKAGES",
            service: "python-runtime-probe",
            entrypoint: "SlowPackageAssets",
          },
        ],
      },
    );
    t.after(server.close);
    const response = await fetch(server.url, { signal: AbortSignal.timeout(40000) });
    const text = await response.text();
    assert.equal(response.status, 200, text + server.logs());
    const result = JSON.parse(text);
    assert.equal(
      result.assignment.outputs
        .filter((o) => o.output_type === "stream")
        .map((o) => o.text)
        .join(""),
      "hello\n",
    );
    assert.equal(result.assignment.outputs.at(-1).data["text/plain"], "42");
    assert.match(result.rich.outputs[0].data["text/html"], /<table/);
    assert.equal(result.explicit.outputs[0].data["text/html"], "<b>hello</b>");
    assert.ok(result.plot.outputs.some((o) => o.data?.["image/png"]?.startsWith("iVBOR")));
    assert.equal(result.persisted.outputs[0].data["text/plain"], "43");
    assert.equal(result.isolated.outputs[0].data["text/plain"], "False");
    assert.equal(result.nameError.success, false);
    const traceMime = "application/vnd.nteract.traceback+json";
    assert.equal(result.nameError.outputs[0].data[traceMime].ename, "NameError");
    assert.match(result.nameError.outputs[0].data[traceMime].evalue, /x/);
    assert.equal(result.error.success, false);
    assert.equal(result.error.outputs[0].data[traceMime].ename, "ValueError");
    assert.equal(result.recovered.outputs[0].data["text/plain"], "41");
    assert.equal(result.denied.success, false);
    assert.match(result.timeout, /CPU|cpu|invalidated/);
    assert.equal(result.sibling.outputs[0].data["text/plain"], "42");
    await mkdir(new URL("../.scratch/", import.meta.url), { recursive: true });
    await writeFile(
      new URL("../.scratch/session-evidence.json", import.meta.url),
      JSON.stringify(result, null, 2),
    );
    const poolResponse = await fetch(server.url + "/pool", { signal: AbortSignal.timeout(60000) });
    const poolText = await poolResponse.text();
    assert.equal(poolResponse.status, 200, poolText);
    const pool = JSON.parse(poolText);
    assert.equal(pool.assigned.instanceId, pool.warm[0].instanceId);
    assert.notEqual(pool.sibling.instanceId, pool.assigned.instanceId);
    assert.notEqual(pool.replacement.instanceId, pool.assigned.instanceId);
    assert.equal(pool.result.outputs.at(-1).data["text/plain"], "123");
    assert.equal(pool.isolated.outputs.at(-1).data["text/plain"], "False");
    assert.equal(pool.reset.outputs.at(-1).data["text/plain"], "False");
    await writeFile(
      new URL("../.scratch/pool-evidence.json", import.meta.url),
      JSON.stringify(pool, null, 2),
    );
    const deadlineResponse = await fetch(server.url + "/deadline", {
      signal: AbortSignal.timeout(60000),
    });
    const deadlineText = await deadlineResponse.text();
    assert.equal(deadlineResponse.status, 200, deadlineText);
    const deadline = JSON.parse(deadlineText);
    assert.match(deadline.error, /execution deadline exceeded/);
    assert.ok(deadline.elapsedMs < 2000, JSON.stringify(deadline));
    assert.notEqual(deadline.original.instanceId, deadline.replacement.instanceId);
    assert.equal(deadline.result.outputs.at(-1).data["text/plain"], "42");
    const startup = await (
      await fetch(server.url + "/startup-deadline", { signal: AbortSignal.timeout(60000) })
    ).json();
    assert.match(startup.error, /initialization deadline exceeded/);
    assert.ok(startup.elapsedMs < 5000, JSON.stringify(startup));
    assert.equal(startup.result.outputs.at(-1).data["text/plain"], "42");
    await writeFile(
      new URL("../.scratch/startup-deadline-evidence.json", import.meta.url),
      JSON.stringify(startup, null, 2),
    );
    await writeFile(
      new URL("../.scratch/deadline-evidence.json", import.meta.url),
      JSON.stringify(deadline, null, 2),
    );
    t.diagnostic(
      JSON.stringify({ warmAllocationMs: pool.allocationMs, deadlineMs: deadline.elapsedMs }),
    );
    t.diagnostic(
      JSON.stringify({
        coldMs: result.coldMs,
        warmMs: result.warmMs,
        linearMemory: result.ready.linearMemory,
      }),
    );
  },
);
