let fallbackCellIdCounter = 0;

export interface NotebookCellIdRandomSource {
  randomUUID?: () => string;
  getRandomValues?: (bytes: Uint8Array) => Uint8Array;
}

/**
 * Generate a new notebook cell id. Prefers `crypto.randomUUID`, falls back to
 * random bytes (non-secure-context browsers), then to a monotonic counter.
 *
 * Shared by desktop and cloud: this is the single cell-id factory both
 * `createNotebookController` consumers pass as `createCellId`, so the id
 * format cannot drift between topologies.
 */
export function createNotebookCellId(
  randomSource: NotebookCellIdRandomSource | null = globalThis.crypto ?? null,
): string {
  if (typeof randomSource?.randomUUID === "function") {
    return randomSource.randomUUID();
  }

  if (typeof randomSource?.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    randomSource.getRandomValues(bytes);
    return `cell-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  }

  fallbackCellIdCounter += 1;
  return `cell-${Date.now().toString(36)}-${fallbackCellIdCounter.toString(36)}`;
}
