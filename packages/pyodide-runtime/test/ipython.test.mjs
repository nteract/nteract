import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPyodide } from "pyodide";
import { validateExecutionResult } from "../src/execution-result.js";
import { createHash } from "node:crypto";

const root = new URL("../", import.meta.url);
const tracebackMime = "application/vnd.nteract.traceback+json";
const streams = (result) =>
  result.outputs
    .filter((o) => o.output_type === "stream")
    .map((o) => o.text)
    .join("");
const value = (result) =>
  result.outputs.findLast((o) => o.output_type === "execute_result")?.data["text/plain"];

test(
  "IPython semantics and nteract provenance in the pinned Pyodide interpreter",
  { timeout: 60000 },
  async (t) => {
    const python = await loadPyodide({
      indexURL: dirname(fileURLToPath(import.meta.resolve("pyodide"))) + "/",
      stdout() {},
      stderr() {},
    });
    const packages = JSON.parse(await readFile(new URL("dist/packages.json", root), "utf8"));
    for (const { filename } of packages) {
      const bytes = await readFile(new URL(`.scratch/packages/${filename}`, root));
      python.unpackArchive(new Uint8Array(bytes), "zip", { extractDir: "/packages/site-packages" });
    }
    python.FS.mkdirTree("/packages/site-packages/nteract_kernel_launcher");
    const bootstrap = JSON.parse(await readFile(new URL("dist/bootstrap.json", root), "utf8"));
    for (const [name, source] of Object.entries(bootstrap))
      python.FS.writeFile(`/packages/site-packages/nteract_kernel_launcher/${name}`, source);
    python.runPython(
      "import sys, os; sys.path.insert(0, '/packages/site-packages'); os.environ['LD_LIBRARY_PATH'] = '/packages/site-packages'",
    );
    python.runPython(await readFile(new URL("runtime/session.py", root), "utf8"));
    const evaluate = python.globals.get("evaluate");
    t.after(() => evaluate.destroy());
    let sequence = 0;
    async function run(source, cellId = "cell") {
      const executionId = `attempt-${++sequence}`;
      const pending = evaluate(source, executionId, cellId);
      try {
        return validateExecutionResult(JSON.parse(await pending), executionId, {
          cellId,
          sourceHash: "sha256:" + createHash("sha256").update(source).digest("hex"),
        });
      } finally {
        pending.destroy();
      }
    }
    await t.test("persistent namespace, last result and semicolon suppression", async () => {
      assert.equal(value(await run("x = 41\nx + 1")), "42");
      assert.equal(value(await run("x + 2;")), undefined);
      assert.equal(value(await run("x")), "41");
      assert.equal(value(await run("_")), "41");
    });
    await t.test("input/output history and extension pre/post lifecycle", async () => {
      await run(
        "seen = []\nip = get_ipython()\nip.events.register('pre_run_cell', lambda info: seen.append(('pre', info.cell_id)))\nip.events.register('post_run_cell', lambda result: seen.append(('post', result.success)))",
      );
      assert.equal(value(await run("6 * 7", "history-cell")), "42");
      const result = await run("print(In[-2], Out[get_ipython().execution_count - 1], seen[-2:])");
      assert.match(streams(result), /6 \* 7 42/);
      assert.match(streams(result), /history-cell|post/);
      assert.match(
        streams(await run("print(seen)")),
        /\('pre', 'history-cell'\), \('post', True\)/,
      );
    });
    await t.test("magics, top-level await and future flags", async () => {
      assert.match(streams(await run("%time sum(range(10))")), /Wall time/);
      assert.equal(value(await run("import asyncio\nawait asyncio.sleep(0)\nx + 1")), "42");
      await run("from __future__ import annotations");
      assert.equal(
        value(await run("def f(a: MissingType): pass\nf.__annotations__['a']")),
        "'MissingType'",
      );
    });
    await t.test("display updates, deferred clear and implicit Matplotlib flush", async () => {
      const result = await run(
        "from IPython.display import display, clear_output\nd = display('before', display_id=True)\nd.update('after')\nclear_output(wait=True)",
      );
      assert.deepEqual(
        result.outputs.map((o) => o.output_type),
        ["display_data", "update_display_data", "clear_output"],
      );
      assert.equal(result.outputs[0].transient.display_id, result.outputs[1].transient.display_id);
      const plot = await run("import matplotlib.pyplot as plt\nplt.plot([1, 2], [3, 4]);");
      assert.ok(plot.outputs.some((o) => o.data?.["image/png"]));
    });
    await t.test("rich tracebacks preserve earlier cell lineage and recover", async () => {
      const definition = await run("def fail():\n    raise ValueError('expected')", "definition");
      const failed = await run("fail()", "caller");
      assert.equal(failed.success, false);
      const trace = failed.outputs.find((o) => o.data?.[tracebackMime]).data[tracebackMime];
      assert.equal(trace.execution.cell_id, "caller");
      assert.equal(trace.execution.execution_id, failed.execution_id);
      assert.equal(trace.frames[0].cell_id, "caller");
      assert.ok(
        trace.frames.some(
          (f) =>
            f.cell_id === "definition" &&
            f.execution_id === definition.execution_id &&
            f.source_hash === definition.source_hash,
        ),
      );
      const syntax = await run("if :", "syntax");
      assert.equal(syntax.success, false);
      assert.equal(syntax.outputs[0].data[tracebackMime].ename, "SyntaxError");
      assert.equal(syntax.outputs[0].data[tracebackMime].syntax.source_ref.cell_id, "syntax");
      assert.equal(value(await run("2 + 2")), "4");
    });
    await t.test("unsupported shell commands fail inside the session", async () => {
      const result = await run("!echo forbidden");
      assert.equal(result.success, false);
      assert.match(result.outputs[0].data[tracebackMime].evalue, /unavailable/);
      assert.equal(value(await run("3 + 4")), "7");
    });
    await t.test(
      "exception formatting failures preserve the original error and recover",
      async () => {
        const failed = await run(
          "class Bad(Exception):\n    def __str__(self):\n        raise ValueError('format failed')\nraise Bad()",
        );
        assert.equal(failed.success, false);
        assert.equal(failed.outputs[0].ename, "Bad");
        assert.match(failed.outputs[0].evalue, /unavailable/);
        assert.equal(value(await run("2 + 3")), "5");
      },
    );
    await t.test("repeated caught tracebacks stay within the response budget", async () => {
      const result = await run(
        "for i in range(200):\n    try:\n        raise ValueError('x' * 20000)\n    except ValueError:\n        get_ipython().showtraceback()",
      );
      assert.equal(result.success, true);
      assert.ok(
        Buffer.byteLength(JSON.stringify(result.outputs)) <= 2 * 1024 * 1024 + 32768 + 2000,
      );
      assert.equal(value(await run("2 + 4")), "6");
    });
    await t.test("background output cannot migrate into a later execution", async () => {
      await run(
        "import asyncio\ngate = asyncio.Event()\nasync def late():\n    await gate.wait()\n    print('old execution')\n    display('old display')\ntask = asyncio.create_task(late())",
      );
      const current = await run("gate.set()\nawait task\nprint('current execution')");
      assert.equal(streams(current), "current execution\n");
      assert.equal(
        current.outputs.some((o) => o.output_type === "display_data"),
        false,
      );
    });
    await t.test("output exhaustion still emits an error and allows another cell", async () => {
      const exhausted = await run("print('x' * (3 * 1024 * 1024))");
      assert.equal(exhausted.success, false);
      assert.match(exhausted.outputs[0].data[tracebackMime].evalue, /output limit/);
      assert.equal(value(await run("5 + 5")), "10");
    });
  },
);
