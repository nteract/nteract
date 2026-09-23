import { terminateLoadedPython } from "./host-termination.js";
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
  // Deployment bundles carry hashed asset descriptors rather than megabytes of
  // base64 JS in every notebook-room isolate. Only this compute factory loads
  // the immutable bytes, and the Dynamic Worker API requires bytes, not modules.
  const loadBytes = async (value) => {
    if (!value?.asset) return value;
    const response = await env.PACKAGES.fetch(
      new Request(`https://python-assets.invalid/${value.asset}`),
    );
    if (!response.ok) throw new Error(`Missing Python module asset: ${value.asset}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    if (bytes.byteLength !== value.size || hash !== value.sha256)
      throw new Error("Python module asset integrity mismatch");
    return bytes;
  };
  const modules = await runWithDeadline(
    async () =>
      Object.fromEntries(
        await Promise.all(
          Object.entries({
            ...libraries,
            "pyodide.asm.wasm": { wasm: interpreter },
            "sentinel.wasm": { wasm: sentinel },
          }).map(async ([name, module]) => [name, { wasm: await loadBytes(module.wasm) }]),
        ),
      ),
    {
      timeoutMs: startupWallMs,
      terminate: async () => {},
      message: "Python module asset deadline exceeded",
    },
  );
  const stub = env.LOADER.load({
    mainModule: "session.js",
    compatibilityDate: "2026-09-21",
    compatibilityFlags: ["python_workers"],
    globalOutbound: null,
    env: { PACKAGES: env.PACKAGES },
    modules: {
      ...modules,
      "session.js": source,
    },
  });
  let disposed = false;
  let active = false;
  let terminating;
  async function terminate() {
    terminating ??= terminateLoadedPython(stub);
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
