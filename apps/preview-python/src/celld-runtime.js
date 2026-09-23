import { runWithDeadline } from "./runtime-deadline.js";
import { validateExecutionResult } from "./execution-result.js";
import source from "../dist/session.js";
import interpreter from "../dist/pyodide.asm.wasm";
import sentinel from "../dist/sentinel.wasm";
import libraries from "../dist/library-modules.js";

/** Called only by the trusted supervisor, never directly by a browser. */
export async function createCelldRuntime(
  env,
  { cpuMs = 3000, wallMs = 30_000, startupWallMs = 60_000, maxOutputBytes = 3 * 1024 * 1024 } = {},
) {
  if (!Number.isFinite(wallMs) || wallMs <= 0) throw new Error("Invalid execution deadline");
  if (!Number.isFinite(startupWallMs) || startupWallMs <= 0)
    throw new Error("Invalid startup deadline");
  const stub = env.LOADER.load({
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
  });
  let disposed = false;
  let active = false;
  let terminating;
  async function terminate() {
    terminating ??= (async () => {
      try {
        await stub
          .getEntrypoint(null, { limits: { cpuMs: 10, subRequests: 0 } })
          .fetch("https://session.invalid/terminate");
        throw new Error("Python host did not terminate the session");
      } catch (error) {
        if (
          !/exceeded CPU limit|runtime invalidated after execution termination/i.test(String(error))
        )
          throw error;
      }
    })();
    return terminating;
  }
  const dispose = async () => {
    if (disposed) return;
    // Python may spawn background tasks that outlive its execution response.
    // Registry removal alone waits for outstanding guest calls to finish.
    // Invalidate even idle interpreters before returning their admission slot.
    await terminate();
    disposed = true;
    stub.dispose();
  };
  try {
    const started = Date.now();
    const info = await runWithDeadline(
      async () => {
        const response = await stub
          .getEntrypoint(null, { limits: { cpuMs: 30_000, subRequests: 100 } })
          .fetch("https://session.invalid/ready");
        if (!response.ok) throw new Error("Python initialization failed");
        return { ...(await response.json()), startupMs: Date.now() - started };
      },
      {
        timeoutMs: startupWallMs,
        terminate,
        message: "Preview Python initialization deadline exceeded",
      },
    );
    return {
      info,
      dispose,
      async execute(execution) {
        if (active) throw new Error("Python session is already executing");
        if (disposed) throw new Error("Python session was disposed");
        if (
          typeof execution.execution_id !== "string" ||
          !execution.execution_id ||
          typeof execution.source !== "string" ||
          execution.source.length > 1_000_000
        ) {
          throw new Error("Invalid accepted execution");
        }
        active = true;
        const invoke = async () => {
          const response = await stub
            .getEntrypoint(null, { limits: { cpuMs, subRequests: 0 } })
            .fetch("https://session.invalid/execute", {
              method: "POST",
              body: JSON.stringify(execution),
            });
          if (!response.ok) throw new Error(`Python execution failed (${response.status})`);
          // Python's own bounds improve behavior; the supervisor independently
          // bounds untrusted bytes before accepting its result into room state.
          const reader = response.body.getReader();
          const chunks = [];
          let size = 0;
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              size += value.byteLength;
              if (size > maxOutputBytes) {
                await reader.cancel();
                throw new Error("Python output limit exceeded");
              }
              chunks.push(value);
            }
          } finally {
            reader.releaseLock();
          }
          const bytes = new Uint8Array(size);
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
          }
          const result = JSON.parse(new TextDecoder().decode(bytes));
          return validateExecutionResult(result, execution.execution_id);
        };
        try {
          return await runWithDeadline(invoke, {
            timeoutMs: wallMs,
            terminate,
            message: "Preview Python execution deadline exceeded; restart required",
          });
        } finally {
          active = false;
        }
      },
    };
  } catch (error) {
    try {
      await dispose();
    } catch (cleanupError) {
      const retained = new Error(
        "Python initialization failed and the host could not confirm termination",
        { cause: cleanupError },
      );
      retained.runtimeRetained = true;
      throw retained;
    }
    throw error;
  }
}
