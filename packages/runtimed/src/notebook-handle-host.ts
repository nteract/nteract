import { DEFAULT_MIME_PRIORITY } from "./mime-priority";

export interface HostedNotebookHandle {
  /** Release the underlying handle. Must not be called while published. */
  free(): void;

  /** Configure MIME selection used by output/runtime-state projection. */
  set_mime_priority(priority: readonly string[]): void;

  /** Configure the daemon blob server port used for ContentRef resolution. */
  set_blob_port(port: number): void;
}

export interface NotebookHandleSlot<THandle extends HostedNotebookHandle = HostedNotebookHandle> {
  current: THandle | null;
}

export interface NotebookHandleHostOptions<THandle extends HostedNotebookHandle> {
  /** Mutable owner slot used by sync engines and callers that need current handle access. */
  slot: NotebookHandleSlot<THandle>;

  /** Actor label for new local handles. */
  actorLabel: () => string;

  /** Create a new local handle once `ready` resolves. */
  createHandle: (actorLabel: string) => THandle;

  /**
   * Publish the current handle to any external readers, or clear it.
   *
   * This is called with `null` before any previous handle is freed so
   * external readers cannot call into a stale wasm-bindgen pointer.
   */
  publishHandle: (handle: THandle | null) => void;

  /** Optional readiness gate, commonly WASM initialization. */
  ready?: Promise<void> | (() => Promise<void>);

  /** Optional current blob port provider. */
  getBlobPort?: () => number | null;

  /** Optional async blob port refresh. */
  refreshBlobPort?: () => Promise<number | null>;

  /** MIME priority to install on each handle. */
  mimePriority?: readonly string[];
}

/**
 * Transport-agnostic owner for the active notebook handle.
 *
 * UI frameworks can build lifecycle around this class without duplicating the
 * ordering that protects external readers from freed wasm-bindgen handles.
 */
export class NotebookHandleHost<THandle extends HostedNotebookHandle = HostedNotebookHandle> {
  readonly #slot: NotebookHandleSlot<THandle>;
  readonly #actorLabel: () => string;
  readonly #createHandle: (actorLabel: string) => THandle;
  readonly #publishHandle: (handle: THandle | null) => void;
  readonly #getBlobPort?: () => number | null;
  readonly #refreshBlobPort?: () => Promise<number | null>;
  readonly #mimePriority: readonly string[];
  readonly #ready: () => Promise<void>;

  constructor(options: NotebookHandleHostOptions<THandle>) {
    this.#slot = options.slot;
    this.#actorLabel = options.actorLabel;
    this.#createHandle = options.createHandle;
    this.#publishHandle = options.publishHandle;
    this.#getBlobPort = options.getBlobPort;
    this.#refreshBlobPort = options.refreshBlobPort;
    this.#mimePriority = options.mimePriority ?? DEFAULT_MIME_PRIORITY;
    const ready = options.ready ?? Promise.resolve();
    this.#ready = typeof ready === "function" ? ready : () => ready;
  }

  get current(): THandle | null {
    return this.#slot.current;
  }

  async bootstrap(isCancelled: () => boolean = () => false): Promise<boolean> {
    const ready = this.#ready();
    await ready;
    if (isCancelled()) return false;

    const handle = this.#createHandle(this.#actorLabel());
    this.#replaceHandle(handle);
    handle.set_mime_priority(this.#mimePriority);

    const initialBlobPort = await this.#resolveBlobPort();

    // A caller may run cleanup while the blob-port refresh is pending. Cleanup
    // frees the handle, so only the current owner may publish or configure it.
    if (isCancelled() || this.#slot.current !== handle) {
      if (this.#slot.current === handle) {
        this.clear();
      }
      return false;
    }

    if (initialBlobPort !== null) {
      handle.set_blob_port(initialBlobPort);
    }
    this.#publishHandle(handle);
    return true;
  }

  clear(): void {
    this.#replaceHandle(null);
  }

  async #resolveBlobPort(): Promise<number | null> {
    const existingPort = this.#getBlobPort?.() ?? null;
    if (existingPort !== null) return existingPort;
    return (await this.#refreshBlobPort?.()) ?? null;
  }

  #replaceHandle(nextHandle: THandle | null): void {
    const previousHandle = this.#slot.current;
    if (previousHandle === nextHandle) return;

    this.#publishHandle(null);
    this.#slot.current = null;
    previousHandle?.free();
    this.#slot.current = nextHandle;
  }
}
