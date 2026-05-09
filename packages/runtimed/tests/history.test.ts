import { describe, expect, it } from "vite-plus/test";

import { normalizeHistoryEntries } from "../src";

describe("normalizeHistoryEntries", () => {
  it("deduplicates by source and keeps the most recent occurrence", () => {
    expect(
      normalizeHistoryEntries([
        { session: 12, line: 4, source: "x = 1" },
        { session: 12, line: 9, source: "print(x)" },
        { session: 13, line: 1, source: "x = 1" },
        { session: 11, line: 20, source: "print(x)" },
      ]),
    ).toEqual([
      { session: 13, line: 1, source: "x = 1" },
      { session: 12, line: 9, source: "print(x)" },
    ]);
  });

  it("sorts newest history first", () => {
    expect(
      normalizeHistoryEntries([
        { session: 10, line: 20, source: "older same session" },
        { session: 9, line: 99, source: "older session" },
        { session: 11, line: 1, source: "newer session" },
        { session: 10, line: 25, source: "newer same session" },
      ]).map((entry) => entry.source),
    ).toEqual(["newer session", "newer same session", "older same session", "older session"]);
  });

  it("treats session zero as current and ignores empty entries", () => {
    expect(
      normalizeHistoryEntries([
        { session: 999, line: 1, source: "persisted" },
        { session: 0, line: 2, source: "current" },
        { session: 0, line: 3, source: "   " },
      ]),
    ).toEqual([
      { session: 0, line: 2, source: "current" },
      { session: 999, line: 1, source: "persisted" },
    ]);
  });

  it("deduplicates sources across line-ending and outer-whitespace differences", () => {
    expect(
      normalizeHistoryEntries([
        { session: 1, line: 1, source: "print('hi')\r\n" },
        { session: 1, line: 2, source: "print('hi')" },
      ]),
    ).toEqual([{ session: 1, line: 2, source: "print('hi')" }]);
  });
});
