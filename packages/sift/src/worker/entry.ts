/**
 * Bundle entry for `@nteract/sift/worker`: the data side in a dedicated worker.
 *
 * Spawn it from the main thread and register the spawn with `setWorkerFactory`:
 *
 *     setWorkerFactory(() => new Worker(new URL("@nteract/sift/worker", import.meta.url), { type: "module" }));
 *
 * Importing this module outside a worker (Node, the main thread) is a no-op so
 * resolvability can be checked without a `Worker`.
 */

import { createWorkerHost, type HostPort } from "./host";

const scope = globalThis as unknown as Partial<HostPort> & { document?: unknown };
if (
  typeof scope.postMessage === "function" &&
  typeof scope.addEventListener === "function" &&
  scope.document === undefined
) {
  createWorkerHost(scope as HostPort);
}
