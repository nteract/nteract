let fallbackCellIdCounter = 0;

export interface CloudNotebookCellIdRandomSource {
  randomUUID?: () => string;
  getRandomValues?: (bytes: Uint8Array) => Uint8Array;
}

export function createCloudNotebookCellId(
  randomSource: CloudNotebookCellIdRandomSource | null = globalThis.crypto ?? null,
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
