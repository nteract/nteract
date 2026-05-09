import { describe, expect, it } from "vite-plus/test";
import { orderHistoryMostRecentFirst, type HistoryEntry } from "../useHistorySearch";

function historyEntry(session: number, line: number, source = ""): HistoryEntry {
  return { session, line, source };
}

describe("orderHistoryMostRecentFirst", () => {
  it("orders history entries by newest session and line first", () => {
    const oldest = historyEntry(1, 10, "old");
    const newestLine = historyEntry(1, 12, "newer line");
    const newestSession = historyEntry(2, 1, "newer session");

    expect(orderHistoryMostRecentFirst([oldest, newestSession, newestLine])).toEqual([
      newestSession,
      newestLine,
      oldest,
    ]);
  });

  it("does not mutate the original result array", () => {
    const entries = [historyEntry(1, 1), historyEntry(1, 2)];

    expect(orderHistoryMostRecentFirst(entries)).toEqual([historyEntry(1, 2), historyEntry(1, 1)]);
    expect(entries).toEqual([historyEntry(1, 1), historyEntry(1, 2)]);
  });
});
