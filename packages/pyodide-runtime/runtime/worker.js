import { WorkerEntrypoint } from "cloudflare:workers";
import { wheels, libraries } from "preview-python:packages";
import "pyodide/pyodide.asm.js";
import { loadPyodide } from "pyodide";
import lockFileContents from "pyodide/pyodide-lock.json";
import source from "./session.py";
import packageSource from "./packages.py";
import bootstrap from "nteract:python-bootstrap";
import { includedPackageInventory } from "./package-inventory.js";

// The supervisor serializes this session. The guard also rejects accidental
// concurrent admission rather than mixing Python globals/output attribution.
let ready;
let busy = false;
// Set while a streamed /execute response owns `busy` past the fetch handler.
let streamOwnsBusy = false;
// Same-isolate interrupt request (not shared memory, not Pyodide's interrupt
// buffer). Python observes it only at nteract-owned checkpoints in
// runtime/session.py, so KeyboardInterrupt lands in the cell's own frames
// rather than in an unraisable callback. The control RPC can set it whenever
// the guest event loop has a turn: while the cell awaits, sleeps, or yields at
// an output checkpoint. A cell that never yields is not interruptible here; the
// supervisor then falls back to host termination.
let interruptRequested = false;
const control = {
  pending: () => interruptRequested,
  consume: () => {
    const pending = interruptRequested;
    interruptRequested = false;
    return pending;
  },
  // One macrotask turn, so queued control RPCs can run.
  turn: () => new Promise((resolve) => setTimeout(resolve, 0)),
};
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
    python.unpackArchive(bytes, "zip", { extractDir: "/packages/site-packages" });
  }
  python.runPython(
    "import sys, os; sys.path.insert(0, '/packages/site-packages'); os.environ['LD_LIBRARY_PATH'] = '/packages/site-packages'; os.environ['MPLBACKEND'] = 'Agg'",
  );
  for (const library of libraries) await python._api.loadDynlib(library.path);
  python.registerJsModule("nteract_control", control);
  python.FS.mkdirTree("/packages/site-packages/nteract_kernel_launcher");
  for (const [name, contents] of Object.entries(bootstrap))
    python.FS.writeFile(`/packages/site-packages/nteract_kernel_launcher/${name}`, contents);
  python.runPython(source);
  python.runPython(packageSource);
  const inventory = python.globals.get("inventory");
  const initial = inventory();
  let included;
  try {
    included = includedPackageInventory(wheels, initial.toJs());
  } finally {
    initial.destroy();
  }
  return {
    python,
    evaluate: python.globals.get("evaluate"),
    plan: python.globals.get("plan_packages"),
    install: python.globals.get("install_packages"),
    inventory,
    included,
  };
}
let role;
export default {
  async fetch(request, env) {
    const { python, evaluate, plan, install, inventory, included } = await (ready ??=
      initialize(env));
    const path = new URL(request.url).pathname;
    if (path === "/ready") {
      const packages = inventory();
      try {
        return Response.json({
          instanceId,
          linearMemory: python._module.HEAPU8.byteLength,
          installed: packages.toJs(),
          included,
        });
      } finally {
        packages.destroy();
      }
    }
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    if (busy) return new Response("Session is executing", { status: 409 });
    busy = true;
    try {
      const payload = await request.json();
      if (path === "/plan" || path === "/install") {
        const nextRole = path === "/plan" ? "planner" : "tenant";
        if (role && role !== nextRole)
          return new Response("Session role mismatch", { status: 409 });
        role = nextRole;
        const pending = (path === "/plan" ? plan : install)(JSON.stringify(payload));
        try {
          return new Response(await pending, { headers: { "content-type": "application/json" } });
        } finally {
          pending.destroy();
        }
      }
      if (path !== "/execute" || role === "planner")
        return new Response("Not found", { status: 404 });
      role = "tenant";
      if (
        typeof payload.source !== "string" ||
        typeof payload.execution_id !== "string" ||
        typeof payload.cell_id !== "string" ||
        !payload.cell_id
      ) {
        return new Response("Expected accepted source, execution_id and cell_id", { status: 400 });
      }
      if (payload.stream === true) {
        // NDJSON: live {"type":"stream"|"boundary"|"live_stopped"} events as the
        // guest event loop flushes them, then one {"type":"result"} line with
        // the authoritative batch. The request stays busy until evaluate ends.
        const { readable, writable } = new TransformStream();
        const writer = writable.getWriter();
        const encoder = new TextEncoder();
        const sink = (line) => {
          void writer.write(encoder.encode(line + "\n")).catch(() => undefined);
        };
        streamOwnsBusy = true;
        void (async () => {
          let pending;
          try {
            pending = evaluate(payload.source, payload.execution_id, payload.cell_id, sink);
            const result = await pending;
            await writer.write(encoder.encode(`{"type":"result","result":${result}}\n`));
            await writer.close();
          } catch (error) {
            await writer.abort(error).catch(() => undefined);
          } finally {
            pending?.destroy();
            busy = false;
            interruptRequested = false;
          }
        })();
        return new Response(readable, { headers: { "content-type": "application/x-ndjson" } });
      }
      const pending = evaluate(payload.source, payload.execution_id, payload.cell_id);
      try {
        return new Response(await pending, { headers: { "content-type": "application/json" } });
      } finally {
        pending.destroy();
      }
    } finally {
      if (streamOwnsBusy) streamOwnsBusy = false;
      else {
        busy = false;
        // A request that arrives after completion must not interrupt the next cell.
        interruptRequested = false;
      }
    }
  },
};

// Only the supervisor holds this named entrypoint. No URL parsing, global
// constructors, Python callbacks or guest-controlled error text participate.
export class RuntimeControl extends WorkerEntrypoint {
  terminate() {
    while (true) {
      /* celld's host CPU limiter invalidates the isolate */
    }
  }
  isAlive() {
    return true;
  }
  // Request KeyboardInterrupt in the running cell. Writes one flag; it does not
  // dispatch into Python or read guest globals. Returns whether a cell was
  // running when the request was recorded.
  interrupt() {
    if (!busy) return false;
    interruptRequested = true;
    return true;
  }
}
