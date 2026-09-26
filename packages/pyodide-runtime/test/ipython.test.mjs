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
    // Stand-in for the guest worker's control module (runtime/worker.js).
    const control = {
      requested: false,
      pending: () => control.requested,
      consume: () => {
        const pending = control.requested;
        control.requested = false;
        return pending;
      },
      turn: () => new Promise((resolve) => setTimeout(resolve, 0)),
    };
    python.registerJsModule("nteract_control", control);
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
    await t.test("consecutive writes to one stream coalesce into one output", async () => {
      const printed = await run("for i in range(2000):\n    print('tick', i)");
      assert.equal(printed.success, true);
      assert.equal(printed.outputs.length, 1);
      assert.equal(
        streams(printed),
        Array.from({ length: 2000 }, (_, i) => `tick ${i}\n`).join(""),
      );
      const mixed = await run(
        "import sys\nprint('a')\nprint('b', file=sys.stderr)\nprint('c')\ndisplay('d')\nprint('e')",
      );
      assert.deepEqual(
        mixed.outputs.map((o) =>
          o.output_type === "stream" ? `${o.name}:${o.text}` : o.output_type,
        ),
        ["stdout:a\n", "stderr:b\n", "stdout:c\n", "display_data", "stdout:e\n"],
      );
    });
    // Without JSPI (plain Node), checkpoints cannot yield, so these set the
    // request before the cell starts; the celld probe covers delivery mid-cell.
    await t.test("Interrupt raises KeyboardInterrupt at an output checkpoint", async () => {
      await run("kept = 41");
      control.requested = true;
      const interrupted = await run("print('before')\nkept = 0");
      assert.equal(interrupted.success, false);
      assert.equal(interrupted.outputs.at(-1).data[tracebackMime].ename, "KeyboardInterrupt");
      // The interrupted assignment never ran; earlier state is preserved.
      assert.equal(value(await run("kept")), "41");
    });
    await t.test("Interrupt at a time.sleep checkpoint keeps the namespace", async () => {
      control.requested = true;
      const interrupted = await run("import time\nkept = 1\ntime.sleep(0)\nkept = 2");
      assert.equal(interrupted.outputs.at(-1).data[tracebackMime].ename, "KeyboardInterrupt");
      assert.equal(value(await run("kept")), "1");
    });
    await t.test("time.sleep keeps its input validation in a notebook cell", async () => {
      for (const [delay, error] of [
        ["-1", "ValueError"],
        ["float('nan')", "ValueError"],
        ["float('inf')", "OverflowError"],
        ["'0'", "TypeError"],
        ["None", "TypeError"],
      ]) {
        const result = await run(`import time\ntime.sleep(${delay})`);
        assert.equal(result.success, false, delay);
        assert.equal(result.outputs.at(-1).data[tracebackMime].ename, error, delay);
      }
      assert.equal(
        value(
          await run("class Delay:\n    def __index__(self): return 0\ntime.sleep(Delay())\n42"),
        ),
        "42",
      );
    });
    await t.test(
      "Interrupt during a long time.sleep preserves variables before the grace deadline",
      { skip: typeof WebAssembly.Suspending !== "function" },
      async () => {
        const running = run("import time\nkept = 7\ntime.sleep(4)\nkept = 8");
        await new Promise((resolve) => setTimeout(resolve, 100));
        const requestedAt = performance.now();
        control.requested = true;
        const interrupted = await running;
        assert.ok(performance.now() - requestedAt < 2000, "Interrupt must wake the sleeping cell");
        assert.equal(interrupted.success, false);
        assert.equal(interrupted.outputs.at(-1).data[tracebackMime].ename, "KeyboardInterrupt");
        assert.equal(value(await run("kept")), "7");
      },
    );
    await t.test("Interrupt at an await cancels the cell as KeyboardInterrupt", async () => {
      const running = run("import asyncio\nkept = 5\nawait asyncio.sleep(30)\nkept = 6");
      await new Promise((resolve) => setTimeout(resolve, 100));
      control.requested = true;
      const interrupted = await running;
      assert.equal(interrupted.success, false);
      assert.equal(interrupted.outputs.at(-1).data[tracebackMime].ename, "KeyboardInterrupt");
      assert.equal(value(await run("kept")), "5");
    });
    await t.test("a printing background task cannot absorb the cell's Interrupt", async () => {
      // Every write is a checkpoint here, and the background task raises the
      // request immediately before its own print: only task ownership keeps
      // it from absorbing the interrupt.
      python.runPython("CHECKPOINT_EVERY_WRITES = 1");
      t.after(() => python.runPython("CHECKPOINT_EVERY_WRITES = 128"));
      const interrupted = await run(
        [
          "import asyncio, nteract_control",
          "async def ticker():",
          "    await asyncio.sleep(0.05)",
          "    nteract_control.requested = True",
          "    print('bg')",
          "background = asyncio.create_task(ticker())",
          "await asyncio.sleep(30)",
        ].join("\n"),
      );
      assert.equal(interrupted.success, false);
      assert.equal(interrupted.outputs.at(-1).data[tracebackMime].ename, "KeyboardInterrupt");
      await run("background.cancel()");
    });
    await t.test("post_execute hooks cannot consume an Interrupt request", async () => {
      python.runPython("CHECKPOINT_EVERY_WRITES = 1");
      t.after(() => python.runPython("CHECKPOINT_EVERY_WRITES = 128"));
      await run(
        [
          "import nteract_control",
          "def late_hook():",
          "    nteract_control.requested = True",
          "    print('hook output')",
          "get_ipython().events.register('post_execute', late_hook)",
        ].join("\n"),
      );
      const hooked = await run("6 * 7");
      await run("get_ipython().events.unregister('post_execute', late_hook)");
      assert.equal(hooked.success, true);
      assert.equal(
        hooked.outputs.some((o) => o.data?.[tracebackMime]),
        false,
        "the hook's print must not raise KeyboardInterrupt",
      );
      assert.equal(control.requested, false, "completion clears the request");
    });
    await t.test("live mode sends complete stream lines and keeps the batch", async () => {
      python.runPython("CHECKPOINT_EVERY_WRITES = 1");
      t.after(() => python.runPython("CHECKPOINT_EVERY_WRITES = 128"));
      const events = [];
      const executionId = `attempt-${++sequence}`;
      const source = "print('a')\nprint('b', end='')\ndisplay('x')\nprint('c')";
      const pending = evaluate(source, executionId, "cell", (line) =>
        events.push(JSON.parse(line)),
      );
      let result;
      try {
        result = validateExecutionResult(JSON.parse(await pending), executionId, {
          cellId: "cell",
          sourceHash: "sha256:" + createHash("sha256").update(source).digest("hex"),
        });
      } finally {
        pending.destroy();
      }
      assert.deepEqual(events, [
        { type: "stream", name: "stdout", text: "a\n" },
        { type: "stream", name: "stdout", text: "b" },
        { type: "boundary" },
        { type: "stream", name: "stdout", text: "c\n" },
      ]);
      assert.deepEqual(
        result.outputs.map((o) => (o.output_type === "stream" ? o.text : o.output_type)),
        ["a\nb", "display_data", "c\n"],
      );
    });
    await t.test(
      "an Interrupt request left after a cell does not reach the next cell",
      async () => {
        await run("pass");
        control.requested = true;
        // Completion clears the request (the worker also clears it per request).
        await run("pass");
        assert.equal(value(await run("print('fine')\n6 * 7")), "42");
      },
    );
  },
);
