import "pyodide/pyodide.asm.js";
import { loadPyodide } from "pyodide";
import lockFileContents from "pyodide/pyodide-lock.json";
import source from "./session.py";

// The supervisor serializes this session. The guard also rejects accidental
// concurrent admission rather than mixing Python globals/output attribution.
let ready;
let busy = false;
const instanceId = crypto.randomUUID();
async function initialize() {
  const python = await loadPyodide({
    indexURL: "https://python-runtime.invalid/",
    lockFileContents,
    stdout: () => {},
    stderr: () => {},
  });
  python.runPython(source);
  return { python, evaluate: python.globals.get("evaluate") };
}
export default {
  async fetch(request) {
    const { python, evaluate } = await (ready ??= initialize());
    if (new URL(request.url).pathname === "/ready") {
      return Response.json({ instanceId, linearMemory: python._module.HEAPU8.byteLength });
    }
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    if (busy) return new Response("Session is executing", { status: 409 });
    busy = true;
    try {
      const payload = await request.json();
      if (typeof payload.source !== "string" || typeof payload.execution_id !== "string") {
        return new Response("Expected accepted source and execution_id", { status: 400 });
      }
      const pending = evaluate(payload.source, payload.execution_id);
      try {
        return new Response(await pending, { headers: { "content-type": "application/json" } });
      } finally {
        pending.destroy();
      }
    } finally {
      busy = false;
    }
  },
};
