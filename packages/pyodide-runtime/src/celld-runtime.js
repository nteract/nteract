import { terminateLoadedPython } from "./host-termination.js";
import { runWithDeadline } from "./runtime-deadline.js";
import { validateExecutionResult } from "./execution-result.js";
import source from "../dist/session.js";
import interpreter from "../dist/pyodide.asm.wasm";
import sentinel from "../dist/sentinel.wasm";
import libraries from "../dist/library-modules.js";

// Live output is advisory and bounded apart from the result batch.
const MAX_LIVE_BYTES = 1024 * 1024;

function safely(deliver, event) {
  try {
    deliver(event);
  } catch {
    // A failed live consumer must not change the execution result.
  }
}

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
    const packageOperation = async (path, payload) => {
      if (active) throw new Error("Python session is already busy");
      if (disposed) throw new Error("Python session was disposed");
      active = true;
      try {
        return await runWithDeadline(
          async () => {
            const response = await stub
              .getEntrypoint(null, { limits: { cpuMs: 10_000, subRequests: 0 } })
              .fetch(`https://session.invalid/${path}`, {
                method: "POST",
                body: JSON.stringify(payload),
              });
            if (!response.ok) throw new Error("Python package operation failed");
            const reader = response.body.getReader();
            const chunks = [];
            let size = 0;
            try {
              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                size += value.length;
                if (size > 128 * 1024) {
                  await reader.cancel();
                  throw new Error("Package result limit exceeded");
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
              offset += chunk.length;
            }
            return JSON.parse(new TextDecoder().decode(bytes));
          },
          {
            timeoutMs: wallMs,
            terminate,
            message: "Python package deadline exceeded; restart required",
          },
        );
      } finally {
        active = false;
      }
    };
    return {
      info,
      dispose,
      plan: (payload) => packageOperation("plan", payload),
      install: (payload) => packageOperation("install", payload),
      /**
       * `onLive`, when given, receives validated live events while the cell
       * runs: {type:"stream", name, text}, {type:"clear", wait},
       * {type:"boundary"} or {type:"live_stopped"}. They are advisory; the resolved result stays the
       * authoritative, validated batch.
       */
      async execute(execution, { onLive } = {}) {
        if (active) throw new Error("Python session is already executing");
        if (disposed) throw new Error("Python session was disposed");
        if (
          typeof execution.execution_id !== "string" ||
          !execution.execution_id ||
          typeof execution.cell_id !== "string" ||
          !execution.cell_id ||
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
              body: JSON.stringify(
                typeof onLive === "function" ? { ...execution, stream: true } : execution,
              ),
            });
          if (!response.ok) throw new Error(`Python execution failed (${response.status})`);
          if (typeof onLive === "function") return readLive(response, onLive);
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
          return accept(JSON.parse(new TextDecoder().decode(bytes)));
        };
        const readLive = async (response, deliver) => {
          // NDJSON from the guest. Live events are untrusted and separately
          // bounded; the result line keeps the batch byte limit and validation.
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          const encoder = new TextEncoder();
          let buffered = "";
          let liveBytes = 0;
          let live = true;
          let result;
          const handle = (line) => {
            if (!line) return;
            if (result !== undefined) throw new Error("Python output continued after its result");
            if (encoder.encode(line).byteLength > maxOutputBytes + 64)
              throw new Error("Python output limit exceeded");
            const event = JSON.parse(line);
            if (event?.type === "result") {
              result = event.result;
              return;
            }
            if (!live) return;
            // Every live event costs budget, so empty or structural events
            // cannot create unbounded work downstream.
            liveBytes +=
              64 + (typeof event?.text === "string" ? encoder.encode(event.text).byteLength : 0);
            if (liveBytes > MAX_LIVE_BYTES) {
              live = false;
              safely(deliver, { type: "live_stopped" });
              return;
            }
            if (event?.type === "stream") {
              if (
                (event.name !== "stdout" && event.name !== "stderr") ||
                typeof event.text !== "string"
              )
                throw new Error("Invalid live Python output");
              safely(deliver, { type: "stream", name: event.name, text: event.text });
            } else if (event?.type === "clear") {
              safely(deliver, { type: "clear", wait: event.wait === true });
            } else if (event?.type === "boundary" || event?.type === "live_stopped") {
              if (event.type === "live_stopped") live = false;
              safely(deliver, { type: event.type });
            } else throw new Error("Invalid live Python output");
          };
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              buffered += decoder.decode(value, { stream: true });
              if (encoder.encode(buffered).byteLength > maxOutputBytes + MAX_LIVE_BYTES) {
                await reader.cancel();
                throw new Error("Python output limit exceeded");
              }
              let newline;
              while ((newline = buffered.indexOf("\n")) !== -1) {
                const line = buffered.slice(0, newline);
                buffered = buffered.slice(newline + 1);
                handle(line);
              }
            }
            handle(buffered + decoder.decode());
          } catch (error) {
            await reader.cancel().catch(() => undefined);
            throw error;
          } finally {
            reader.releaseLock();
          }
          if (result === undefined) throw new Error("Python execution ended without a result");
          return accept(result);
        };
        const accept = async (result) => {
          const digest = new Uint8Array(
            await crypto.subtle.digest("SHA-256", new TextEncoder().encode(execution.source)),
          );
          const sourceHash =
            "sha256:" + Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
          return validateExecutionResult(result, execution.execution_id, {
            cellId: execution.cell_id,
            sourceHash,
          });
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
