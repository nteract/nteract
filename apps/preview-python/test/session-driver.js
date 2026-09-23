// Test-only driver. Never deployed as the provider's public API.
import source from "../dist/session.js";
import interpreter from "../dist/pyodide.asm.wasm";
import sentinel from "../dist/sentinel.wasm";

export default {
  async fetch(request, env) {
    const code = {
      mainModule: "session.js",
      compatibilityDate: "2026-09-21",
      compatibilityFlags: ["python_workers"],
      globalOutbound: null,
      modules: {
        "session.js": source,
        "pyodide.asm.wasm": { wasm: interpreter },
        "sentinel.wasm": { wasm: sentinel },
      },
    };
    const first = env.LOADER.load(code);
    const second = env.LOADER.load(code);
    async function run(stub, source, execution_id, cpuMs = 3000) {
      const response = await stub
        .getEntrypoint(null, { limits: { cpuMs } })
        .fetch("https://session.invalid/execute", {
          method: "POST",
          body: JSON.stringify({ source, execution_id }),
        });
      if (!response.ok) throw new Error(await response.text());
      return response.json();
    }
    try {
      const started = Date.now();
      const ready = await first
        .getEntrypoint()
        .fetch("https://session.invalid/ready")
        .then((r) => r.json());
      const coldMs = Date.now() - started;
      const assignment = await run(first, "value = 41\nprint('hello')\nvalue + 1", "first");
      const warmStart = Date.now();
      const persisted = await run(first, "value + 2", "second");
      const warmMs = Date.now() - warmStart;
      const isolated = await run(second, "'value' in globals()", "isolated");
      const error = await run(first, "raise ValueError('expected')", "error");
      const recovered = await run(
        first,
        "import asyncio\nawait asyncio.sleep(0)\nvalue",
        "recovery",
      );
      const denied = await run(
        second,
        "from js import fetch\nawait fetch('https://example.com/')",
        "denied",
      );
      let timeout;
      try {
        await run(first, "while True: pass", "timeout", 25);
      } catch (error) {
        timeout = String(error);
      }
      const sibling = await run(second, "6 * 7", "sibling");
      return Response.json({
        ready,
        coldMs,
        warmMs,
        assignment,
        persisted,
        isolated,
        error,
        recovered,
        denied,
        timeout,
        sibling,
      });
    } finally {
      first.dispose();
      second.dispose();
    }
  },
};
