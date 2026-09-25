/** The metadata read surface shared by live and snapshot WASM handles. */
export interface NotebookMetadataHandle {
  get_metadata_fingerprint(): string | undefined;
  get_metadata_snapshot(): unknown;
}

/**
 * Synchronous projection of Automerge metadata. The WASM fingerprint avoids
 * deserialization and subscriber work for unrelated cell/output sync. Hosts
 * own handle lifetime and call refresh after document changes.
 */
export class NotebookMetadataStore<T = unknown> {
  private handle: NotebookMetadataHandle | null = null;
  private fingerprint: string | null = null;
  private snapshot: T | null = null;
  private live = false;
  private readonly subscribers = new Set<() => void>();

  readonly getSnapshot = (): T | null => this.snapshot;
  readonly subscribe = (callback: () => void): (() => void) => {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  };

  refresh(handle: NotebookMetadataHandle): void {
    const fingerprint = handle.get_metadata_fingerprint() ?? null;
    if (this.handle === handle && this.fingerprint === fingerprint) return;
    this.handle = handle;
    this.fingerprint = fingerprint;
    this.live = true;
    this.publish(handle.get_metadata_snapshot());
  }

  /** A delayed fallback snapshot cannot overwrite metadata already read live. */
  acceptSnapshot(snapshot: unknown): void {
    if (!this.live) this.publish(snapshot);
  }

  /** Release a freed handle while preserving the same notebook's visible facts. */
  detach(handle: NotebookMetadataHandle): void {
    if (this.handle === handle) {
      this.handle = null;
      this.fingerprint = null;
    }
  }

  /** Notebook identity changes clear both the projection and fallback ownership. */
  reset(): void {
    this.handle = null;
    this.fingerprint = null;
    this.live = false;
    this.publish(null);
  }

  private publish(value: unknown): void {
    this.snapshot = value && typeof value === "object" ? (value as T) : null;
    for (const callback of this.subscribers) callback();
  }
}
