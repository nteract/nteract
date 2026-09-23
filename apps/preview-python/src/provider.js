import { SessionPool } from "./session-pool.js";
import { createCelldRuntime } from "./celld-runtime.js";
import { createProviderService } from "./provider-service.js";
import { ensureHousekeepingAlarm } from "./housekeeping.js";
import { WorkerEntrypoint } from "cloudflare:workers";
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
        const pending = createCelldRuntime(env);
        // A clean replacement starts in the background after allocation.
        // Keep its I/O alive after the request that triggered warming ends.
        state.waitUntil(pending.catch(() => undefined));
        return pending;
      },
      maxSessions: 4,
      warmCount: 1,
    });
    this.service = createProviderService(this.pool);
  }
  async fetch(request) {
    // Alarms are only lifecycle housekeeping; no notebook code is replayed.
    await ensureHousekeepingAlarm(this.state.storage);
    return this.service.fetch(request);
  }
  async alarm() {
    await this.pool.expire();
    await this.state.storage.setAlarm(Date.now() + 60_000);
  }
}

export default {
  fetch() {
    return new Response("Not found", { status: 404 });
  },
};
