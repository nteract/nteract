import type { HistoryEntry } from "./request-types";

const CURRENT_SESSION_RANK = Number.MAX_SAFE_INTEGER;

function sessionRecencyRank(session: number): number {
  // Jupyter uses session 0 as "current session" in history APIs.
  // Put it ahead of persisted session ids when kernels return it in entries.
  return session === 0 ? CURRENT_SESSION_RANK : session;
}

export function historySourceKey(source: string): string {
  return source.replace(/\r\n?/g, "\n").trim();
}

export function compareHistoryEntriesByRecency(a: HistoryEntry, b: HistoryEntry): number {
  const sessionDelta = sessionRecencyRank(b.session) - sessionRecencyRank(a.session);
  if (sessionDelta !== 0) return sessionDelta;
  return b.line - a.line;
}

export function normalizeHistoryEntries(entries: HistoryEntry[]): HistoryEntry[] {
  const latestBySource = new Map<string, HistoryEntry>();

  for (const entry of entries) {
    const sourceKey = historySourceKey(entry.source);
    if (!sourceKey) continue;

    const existing = latestBySource.get(sourceKey);
    if (!existing || compareHistoryEntriesByRecency(entry, existing) < 0) {
      latestBySource.set(sourceKey, entry);
    }
  }

  return [...latestBySource.values()].sort(compareHistoryEntriesByRecency);
}
