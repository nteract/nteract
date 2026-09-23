import { wheels, libraries } from "preview-python:packages";
import "pyodide/pyodide.asm.js";
import { loadPyodide } from "pyodide";
import lockFileContents from "pyodide/pyodide-lock.json";
import source from "./session.py";

// The supervisor serializes this session. The guard also rejects accidental
// concurrent admission rather than mixing Python globals/output attribution.
let ready;
let busy = false;
const instanceId = crypto.randomUUID();
async function initialize(env) {
  const python = await loadPyodide({
    indexURL: "https://python-runtime.invalid/",
    lockFileContents,
    stdout: () => {},
    stderr: () => {},
  });
  for (const wheel of wheels) {
    const response = await env.PACKAGES.fetch("https://packages.invalid/" + wheel.filename);
    if (!response.ok) throw new Error("Pinned package unavailable: " + wheel.name);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    const hash = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
    if (hash !== wheel.sha256) throw new Error("Pinned package hash mismatch: " + wheel.name);
    python.unpackArchive(bytes, "zip", { extractDir: "/packages" });
  }
  python.runPython(
    "import sys, os; sys.path.insert(0, '/packages'); os.environ['LD_LIBRARY_PATH'] = '/packages'; os.environ['MPLBACKEND'] = 'Agg'",
  );
  for (const library of libraries) await python._api.loadDynlib(library.path);
  python.runPython(source);
  return { python, evaluate: python.globals.get("evaluate") };
}
export default {
  async fetch(request, env) {
    // Internal supervisor-only endpoint. Deliberately cross the caller's tiny
    // CPU budget to make celld invalidate this entire isolate, including tasks
    // suspended in Python. Loader fetch currently ignores AbortSignal.
    if (new URL(request.url).pathname === "/terminate") {
      while (true) {
        /* celld's host CPU limiter terminates this isolate */
      }
    }
    const { python, evaluate } = await (ready ??= initialize(env));
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
