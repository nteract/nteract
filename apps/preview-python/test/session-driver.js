import { SessionPool } from "../src/session-pool.js";
import { createCelldRuntime } from "@nteract/pyodide-runtime/celld";
import { createProviderService } from "../src/provider-service.js";
import { WorkerEntrypoint } from "cloudflare:workers";
import packages from "@nteract/pyodide-runtime/assets/package-assets.js";
import libraries from "@nteract/pyodide-runtime/assets/library-modules.js";
// Test-only driver. Never deployed as the provider's public API.
import source from "@nteract/pyodide-runtime/assets/session.js";
import interpreter from "@nteract/pyodide-runtime/assets/pyodide.asm.wasm";
import sentinel from "@nteract/pyodide-runtime/assets/sentinel.wasm";
let bridgePool;

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname === "/startup-deadline") {
      let attempt = 0;
      const pool = new SessionPool({
        maxSessions: 1,
        warmCount: 0,
        create: () =>
          createCelldRuntime(attempt++ === 0 ? { ...env, PACKAGES: env.SLOW_PACKAGES } : env, {
            startupWallMs: attempt === 1 ? 250 : 60_000,
          }),
      });
      try {
        const started = Date.now();
        let error;
        try {
          await pool.open("slow");
        } catch (failure) {
          error = String(failure);
        }
        const elapsedMs = Date.now() - started;
        await pool.open("replacement");
        const result = await pool.execute("replacement", {
          cell_id: "test-cell",
          execution_id: "ready",
          source: "6 * 7",
        });
        return Response.json({ error, elapsedMs, result });
      } finally {
        await pool.close();
      }
    }
    if (new URL(request.url).pathname.startsWith("/private/")) {
      bridgePool ??= new SessionPool({
        create: () => createCelldRuntime(env),
        maxSessions: 1,
        warmCount: 0,
      });
      const url = new URL(request.url);
      url.pathname = url.pathname.slice("/private".length);
      return createProviderService(bridgePool).fetch(new Request(url, request));
    }
    if (new URL(request.url).pathname === "/bridge") {
      bridgePool ??= new SessionPool({
        create: () => createCelldRuntime(env),
        maxSessions: 1,
        warmCount: 0,
      });
      const service = createProviderService(bridgePool);
      const identity = {
        ownerPrincipal: "test-owner",
        notebookId: "test-notebook",
        sessionId: "bridge",
      };
      const opened = await service.fetch(
        new Request("https://private.invalid/open", {
          method: "POST",
          body: JSON.stringify(identity),
        }),
      );
      if (!opened.ok) return opened;
      return service.fetch(
        new Request("https://private.invalid/execute", {
          method: "POST",
          body: JSON.stringify({ ...identity, execution: await request.json() }),
        }),
      );
    }
    if (new URL(request.url).pathname === "/deadline") {
      const pool = new SessionPool({
        create: () => createCelldRuntime(env, { wallMs: 150 }),
        maxSessions: 1,
        warmCount: 0,
      });
      try {
        const original = await pool.open("deadline/1");
        const started = Date.now();
        let error;
        try {
          await pool.execute("deadline/1", {
            cell_id: "test-cell",
            execution_id: "sleep",
            source: "import asyncio\nawait asyncio.sleep(60)",
          });
        } catch (failure) {
          error = String(failure);
        }
        const elapsedMs = Date.now() - started;
        const replacement = await pool.open("deadline/2");
        const result = await pool.execute("deadline/2", {
          cell_id: "test-cell",
          execution_id: "after",
          source: "21 * 2",
        });
        return Response.json({ original, error, elapsedMs, replacement, result });
      } finally {
        await pool.close();
      }
    }
    if (new URL(request.url).pathname === "/pool") {
      const pool = new SessionPool({ create: () => createCelldRuntime(env), maxSessions: 2 });
      try {
        const warm = await pool.prewarm();
        const started = Date.now();
        const assigned = await pool.open("owner/notebook/generation-1");
        const allocationMs = Date.now() - started;
        const result = await pool.execute("owner/notebook/generation-1", {
          cell_id: "test-cell",
          execution_id: "pool-1",
          source: "secret = 123\nsecret",
        });
        const sibling = await pool.open("owner/notebook-2/generation-1");
        const isolated = await pool.execute("owner/notebook-2/generation-1", {
          cell_id: "test-cell",
          execution_id: "pool-2",
          source: "'secret' in globals()",
        });
        await pool.release("owner/notebook/generation-1");
        const replacement = await pool.open("owner/notebook/generation-2");
        const reset = await pool.execute("owner/notebook/generation-2", {
          cell_id: "test-cell",
          execution_id: "pool-3",
          source: "'secret' in globals()",
        });
        return Response.json({
          warm,
          assigned,
          allocationMs,
          result,
          sibling,
          isolated,
          replacement,
          reset,
        });
      } finally {
        await pool.close();
      }
    }
    const code = {
      mainModule: "session.js",
      compatibilityDate: "2026-09-21",
      compatibilityFlags: ["python_workers"],
      globalOutbound: null,
      env: { PACKAGES: env.PACKAGES },
      modules: {
        ...libraries,
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
          body: JSON.stringify({ source, execution_id, cell_id: "test-cell" }),
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
      await second.getEntrypoint().fetch("https://session.invalid/ready");
      const assignment = await run(first, "value = 41\nprint('hello')\nvalue + 1", "first");
      const warmStart = Date.now();
      const persisted = await run(first, "value + 2", "second");
      const warmMs = Date.now() - warmStart;
      const isolated = await run(second, "'value' in globals()", "isolated");
      const nameError = await run(first, "x", "undefined-name");
      const error = await run(first, "raise ValueError('expected')", "error");
      const recovered = await run(
        first,
        "import asyncio\nawait asyncio.sleep(0)\nvalue",
        "recovery",
      );
      const rich = await run(first, "import pandas as pd\npd.DataFrame({'x': [1, 2]})", "rich");
      const explicit = await run(
        first,
        "from IPython.display import display, HTML\ndisplay(HTML('<b>hello</b>'))",
        "display",
      );
      const plot = await run(
        first,
        "import matplotlib.pyplot as plt\nplt.plot([1, 2], [3, 4])\nplt.show()",
        "plot",
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
        rich,
        explicit,
        plot,
        ready,
        coldMs,
        warmMs,
        assignment,
        persisted,
        isolated,
        error,
        nameError,
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

export class PackageAssets extends WorkerEntrypoint {
  fetch(request) {
    const filename = new URL(request.url).pathname.slice(1);
    const bytes = Object.hasOwn(packages, filename) ? packages[filename] : null;
    return bytes ? new Response(bytes) : new Response("Unknown package", { status: 404 });
  }
}

export class SlowPackageAssets extends PackageAssets {
  async fetch(request) {
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    return super.fetch(request);
  }
}
