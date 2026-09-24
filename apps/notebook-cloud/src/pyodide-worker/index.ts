/**
 * Pyodide execution worker — fleet entry point.
 *
 * A plain JS Worker (celld does not support native Python Workers) that hosts
 * the Pyodide interpreter and executes cells for notebooks that select the
 * `pyodide` runtime. The worker is a separate script on the celld substrate:
 * the document engine Worker never imports or embeds this bundle.
 *
 * The worker attaches to notebook rooms as an authenticated `runtime_peer`
 * client (outbound WebSocket, credential subprotocol, `runtime_peer` ACL row)
 * and writes only RuntimeStateDoc lifecycle/outputs. The room-sync frame loop
 * reuses the same wire contract as the Rust `cloud-runtime-agent`
 * (`crates/runtimed/src/runtime_agent.rs`).
 *
 * Health endpoint: `GET /health` returns 200 once the interpreter plane is
 * configured, so the celld fleet controller can gate the service.
 */

import { PyodideSession } from "./session.ts";

export interface PyodideWorkerEnv {
  /** Base URL (or bundled sibling prefix) of the Pyodide distribution. */
  PYODIDE_ASSETS_URL?: string;
  /** Notebook cloud base for room attachment (wss/ws swapped from https/http). */
  CLOUD_URL?: string;
  /** Credential for the room dial; never logged. */
  RUNT_CLOUD_TOKEN?: string;
}

let session: PyodideSession | null = null;
let configured = false;

function assetsBase(env: PyodideWorkerEnv): string | null {
  return env.PYODIDE_ASSETS_URL ?? null;
}

/** Initialize the interpreter plane once per isolate (warm reuse). */
export async function ensureSession(env: PyodideWorkerEnv): Promise<PyodideSession> {
  if (session !== null && session.ready) return session;
  const indexURL = assetsBase(env);
  if (indexURL === null) {
    throw new Error("PYODIDE_ASSETS_URL is not configured for the pyodide worker");
  }
  session = new PyodideSession({ indexURL });
  await session.init();
  return session;
}

export default {
  async fetch(request: Request, env: PyodideWorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      if (!configured) {
        configured = assetsBase(env) !== null;
      }
      const body = JSON.stringify({
        ok: configured,
        worker: "pyodide",
        state: session?.state ?? "initializing",
      });
      return new Response(body, {
        status: configured ? 200 : 503,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("Not found\n", { status: 404 });
  },
};

export type { SessionState, ExecutionResult } from "./session.ts";
export { PyodideSession, toStructuredError } from "./session.ts";
export {
  WheelCache,
  installPackages,
  InMemoryWheelCacheStore,
  UninstallablePackageError,
  summarizeInstallError,
} from "./packages.ts";
export type { InstallProgressEvent, InstallProgressPhase } from "./packages.ts";
