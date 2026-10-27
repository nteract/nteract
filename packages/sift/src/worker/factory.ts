/**
 * How Sift spawns its data worker. The library ships the worker bundle
 * (`@nteract/sift/worker`) but not the spawn: a same-origin module worker, a
 * blob worker for an opaque-origin frame, or a host-managed pool are the
 * host's choice. With no factory, `worker: true` sources fail at validation
 * rather than falling back to the main thread.
 */

export type WorkerFactory = () => Worker;

let factory: WorkerFactory | null = null;

/** Register how to spawn the Sift data worker; `null` unregisters. */
export function setWorkerFactory(next: WorkerFactory | null): void {
  factory = next;
}

export function getWorkerFactory(): WorkerFactory | null {
  return factory;
}
