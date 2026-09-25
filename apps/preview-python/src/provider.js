import { PROVIDER_ORPHAN_IDLE_MS } from "./lifecycle-policy.js";
import { SessionPool } from "./session-pool.js";
import { createCelldRuntime } from "@nteract/pyodide-runtime/celld";
import { createProviderService } from "./provider-service.js";
import { ensureHousekeepingAlarm, runHousekeepingAlarm } from "./housekeeping.js";
import { WorkerEntrypoint } from "cloudflare:workers";
import { PackageResolver } from "./package-resolver.js";
import { PACKAGE_INSTALL_MS } from "./package-limits.js";
import packages from "../dist/packages.json";
const packageNames = new Set(packages.map((entry) => entry.filename));

/** Immutable package bytes only; this binding has no user data or credentials. */
export class PackageAssets extends WorkerEntrypoint {
  fetch(request) {
    const name = new URL(request.url).pathname.slice(1);
    return packageNames.has(name) ||
      /^(?:library-[a-f0-9]{64}|pyodide\.asm|sentinel)\.wasm$/.test(name)
      ? this.env.ASSETS.fetch(
          new Request(`https://python-assets.invalid/__preview-python-packages/${name}`),
        )
      : new Response("Not found", { status: 404 });
  }
}

/** One explicitly configured celld deployment quota and clean warm pool. */
export class PreviewPythonSessions {
  constructor(state, env) {
    this.state = state;
    this.pool = new SessionPool({
      create: () => {
        const pending = createCelldRuntime(env, { wallMs: PACKAGE_INSTALL_MS });
        // A clean replacement starts in the background after allocation.
        // Keep its I/O alive after the request that triggered warming ends.
        state.waitUntil(pending.catch(() => undefined));
        return pending;
      },
      maxSessions: 4,
      maxSessionsPerOwner: 2,
      warmCount: 1,
      idleMs: PROVIDER_ORPHAN_IDLE_MS,
    });
    this.packageResolver = new PackageResolver({
      create: () => createCelldRuntime(env, { wallMs: PACKAGE_INSTALL_MS }),
    });
    this.service = createProviderService(this.pool, state.storage, this.packageResolver);
  }
  async fetch(request) {
    // Alarms are only lifecycle housekeeping; no notebook code is replayed.
    await ensureHousekeepingAlarm(this.state.storage);
    if (request.method === "GET" && new URL(request.url).pathname === "/health") {
      // Discovery prepares one clean interpreter without allocating a tenant
      // session. Initialization is retained after this fast response returns.
      this.state.waitUntil(this.pool.prewarm().catch(() => undefined));
    }
    return this.service.fetch(request);
  }
  async alarm() {
    await runHousekeepingAlarm(this.state.storage, this.pool);
  }
}

export default {
  fetch() {
    return new Response("Not found", { status: 404 });
  },
};
