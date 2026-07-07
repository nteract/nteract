import type { NotebookDocPersistenceMeta } from "runtimed";

export const CLOUD_PENDING_LOCAL_EDIT_MARKER_STORAGE_KEY =
  "nteract:notebook-cloud:pending-local-edit-marker:v1";

export interface PendingLocalEditMarkerStorage {
  getItem(key: string): string | null;
  removeItem(key: string): void;
  setItem(key: string, value: string): void;
}

interface PendingLocalEditMarkerEntry {
  headsHex: string[];
  notebookId: string;
  principal: string;
  savedAt: number;
}

interface PendingLocalEditMarkerRoot {
  entries: PendingLocalEditMarkerEntry[];
  v: 1;
}

export function readPendingLocalEditMarker(
  storage: Pick<PendingLocalEditMarkerStorage, "getItem" | "removeItem" | "setItem">,
  input: {
    notebookId: string;
    principal: string;
    seedMeta: NotebookDocPersistenceMeta | null | undefined;
  },
): boolean {
  const root = readPendingLocalEditMarkerRoot(storage);
  if (!root) {
    return false;
  }
  const entry = root.entries.find(
    (candidate) =>
      candidate.notebookId === input.notebookId && candidate.principal === input.principal,
  );
  if (!entry) {
    return false;
  }
  if (!pendingLocalEditMarkerMatchesSeed(entry, input.seedMeta)) {
    writePendingLocalEditMarkerRoot(
      storage,
      root.entries.filter((candidate) => candidate !== entry),
    );
    return false;
  }
  return true;
}

export function writePendingLocalEditMarker(
  storage: Pick<PendingLocalEditMarkerStorage, "getItem" | "removeItem" | "setItem">,
  input: {
    headsHex: string[];
    notebookId: string;
    now?: number;
    principal: string;
  },
): void {
  if (!isPendingLocalEditMarkerInput(input)) {
    return;
  }
  const root = readPendingLocalEditMarkerRoot(storage) ?? { v: 1, entries: [] };
  const entry = {
    headsHex: input.headsHex,
    notebookId: input.notebookId,
    principal: input.principal,
    savedAt: input.now ?? Date.now(),
  } satisfies PendingLocalEditMarkerEntry;
  writePendingLocalEditMarkerRoot(storage, [
    entry,
    ...root.entries.filter(
      (candidate) =>
        candidate.notebookId !== input.notebookId || candidate.principal !== input.principal,
    ),
  ]);
}

export function clearPendingLocalEditMarker(
  storage: Pick<PendingLocalEditMarkerStorage, "getItem" | "removeItem" | "setItem">,
  input: { notebookId: string; principal: string },
): void {
  const root = readPendingLocalEditMarkerRoot(storage);
  if (!root) {
    return;
  }
  writePendingLocalEditMarkerRoot(
    storage,
    root.entries.filter(
      (candidate) =>
        candidate.notebookId !== input.notebookId || candidate.principal !== input.principal,
    ),
  );
}

function readPendingLocalEditMarkerRoot(
  storage: Pick<PendingLocalEditMarkerStorage, "getItem" | "removeItem">,
): PendingLocalEditMarkerRoot | null {
  const raw = storage.getItem(CLOUD_PENDING_LOCAL_EDIT_MARKER_STORAGE_KEY);
  if (!raw) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    storage.removeItem(CLOUD_PENDING_LOCAL_EDIT_MARKER_STORAGE_KEY);
    return null;
  }
  if (!isPendingLocalEditMarkerRoot(parsed)) {
    return null;
  }
  return parsed;
}

function writePendingLocalEditMarkerRoot(
  storage: Pick<PendingLocalEditMarkerStorage, "removeItem" | "setItem">,
  entries: PendingLocalEditMarkerEntry[],
): void {
  const retained = entries.slice(0, 16);
  if (retained.length === 0) {
    storage.removeItem(CLOUD_PENDING_LOCAL_EDIT_MARKER_STORAGE_KEY);
    return;
  }
  storage.setItem(
    CLOUD_PENDING_LOCAL_EDIT_MARKER_STORAGE_KEY,
    JSON.stringify({ entries: retained, v: 1 } satisfies PendingLocalEditMarkerRoot),
  );
}

function pendingLocalEditMarkerMatchesSeed(
  entry: PendingLocalEditMarkerEntry,
  seedMeta: NotebookDocPersistenceMeta | null | undefined,
): boolean {
  return (
    seedMeta?.principal === entry.principal && headsHexSetsEqual(seedMeta.headsHex, entry.headsHex)
  );
}

function headsHexSetsEqual(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const rightSet = new Set(right);
  return left.every((head) => rightSet.has(head));
}

function isPendingLocalEditMarkerRoot(value: unknown): value is PendingLocalEditMarkerRoot {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<PendingLocalEditMarkerRoot>;
  return (
    candidate.v === 1 &&
    Array.isArray(candidate.entries) &&
    candidate.entries.every(isPendingLocalEditMarkerEntry)
  );
}

function isPendingLocalEditMarkerEntry(value: unknown): value is PendingLocalEditMarkerEntry {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<PendingLocalEditMarkerEntry>;
  return (
    typeof candidate.notebookId === "string" &&
    typeof candidate.principal === "string" &&
    Number.isFinite(candidate.savedAt) &&
    Array.isArray(candidate.headsHex) &&
    candidate.headsHex.every((head) => typeof head === "string")
  );
}

function isPendingLocalEditMarkerInput(value: {
  headsHex: string[];
  notebookId: string;
  principal: string;
}): boolean {
  return (
    value.notebookId.trim() !== "" &&
    value.principal.trim() !== "" &&
    Array.isArray(value.headsHex) &&
    value.headsHex.every((head) => typeof head === "string")
  );
}
