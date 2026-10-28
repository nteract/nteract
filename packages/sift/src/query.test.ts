import { describe, expect, it } from "vite-plus/test";
import { type QueryCapabilities, supportsQuery, type TableQuery } from "./query";

const caps: QueryCapabilities = {
  filters: {
    score: ["between", "gt"],
    status: ["in", "not_in", "is_null"],
    active: ["eq"],
  },
  sort: ["score"],
  casts: [{ column: "id", to: "categorical" }],
  counts: ["exact"],
};

function query(partial: Partial<TableQuery>): TableQuery {
  return { casts: [], filters: [], sort: [], ...partial };
}

describe("supportsQuery", () => {
  it("accepts an empty query", () => {
    expect(supportsQuery(caps, query({}))).toEqual({ ok: true });
  });

  it("accepts declared leaf ops, sort columns, and casts", () => {
    expect(
      supportsQuery(
        caps,
        query({
          casts: [{ column: "id", to: "categorical" }],
          filters: [
            { column: "score", op: "between", value: [1, 2] },
            { column: "status", op: "in", value: ["a"] },
            { column: "active", op: "eq", value: true },
          ],
          sort: [{ column: "score", direction: "desc" }],
        }),
      ),
    ).toEqual({ ok: true });
  });

  it("refuses a column with no pushdown", () => {
    expect(
      supportsQuery(caps, query({ filters: [{ column: "name", op: "contains", value: "x" }] })),
    ).toEqual({ ok: false, reason: "Filters on name are not supported" });
  });

  it("refuses an undeclared op on a declared column", () => {
    expect(
      supportsQuery(caps, query({ filters: [{ column: "score", op: "lt", value: 3 }] })),
    ).toEqual({ ok: false, reason: 'Filter "lt" on score is not supported' });
  });

  it("refuses sort and cast the provider did not declare", () => {
    expect(supportsQuery(caps, query({ sort: [{ column: "status", direction: "asc" }] }))).toEqual({
      ok: false,
      reason: "Sorting by status is not supported",
    });
    expect(supportsQuery(caps, query({ casts: [{ column: "score", to: "categorical" }] }))).toEqual(
      { ok: false, reason: "Cast of score to categorical is not supported" },
    );
  });

  it("treats compound predicates as unsupported unless declared, then checks leaves", () => {
    const exclusion: TableQuery["filters"][number] = {
      op: "or",
      args: [
        { column: "status", op: "is_null" },
        { column: "status", op: "not_in", value: ["a"] },
      ],
    };
    expect(supportsQuery(caps, query({ filters: [exclusion] }))).toEqual({
      ok: false,
      reason: 'Compound "or" filters are not supported',
    });
    const withOr = { ...caps, compound: ["or"] as const };
    expect(supportsQuery(withOr, query({ filters: [exclusion] }))).toEqual({ ok: true });
    expect(
      supportsQuery(
        withOr,
        query({
          filters: [{ op: "not", arg: { column: "score", op: "gt", value: 1 } }],
        }),
      ),
    ).toEqual({ ok: false, reason: 'Compound "not" filters are not supported' });
    expect(
      supportsQuery(
        withOr,
        query({
          filters: [
            {
              op: "or",
              args: [
                { column: "score", op: "gt", value: 1 },
                { column: "score", op: "lte", value: 0 },
              ],
            },
          ],
        }),
      ),
    ).toEqual({ ok: false, reason: 'Filter "lte" on score is not supported' });
  });
});
