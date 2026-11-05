// ONE-SHOT MIGRATION tests: delete with content-migration.mjs.
import assert from "node:assert/strict";
import { test } from "node:test";
import { drive, parseArgs } from "./content-migration.mjs";

test("arguments need an origin and a mode", () => {
  const { log, ...rest } = parseArgs([
    "--origin",
    "https://x",
    "--mode",
    "apply",
    "--page-id",
    "p",
  ]);
  assert.deepEqual(rest, {
    origin: "https://x",
    mode: "apply",
    limit: 10,
    pageIds: ["p"],
    maxCalls: 100,
  });
  assert.ok(log.endsWith(".jsonl"));
  assert.throws(() => parseArgs(["--mode", "apply"]));
  assert.throws(() => parseArgs(["--origin", "https://x", "--mode", "go"]));
  assert.throws(() => parseArgs(["--origin", "https://x", "--mode", "apply", "--nope", "1"]));
});

test("dry run follows next and adds the totals", async () => {
  const bodies = [];
  const pages = [
    { next: "b", visited: ["a"], totals: { pages: 1, statuses: { unchanged: 1 } } },
    { next: null, visited: ["c"], totals: { pages: 1, statuses: { would_normalize: 1 } } },
  ];
  const report = await drive({
    mode: "dry_run",
    limit: 1,
    call: async (body) => {
      bodies.push(body);
      const page = pages.shift();
      return { pages: [{}], targets: { total: 2 }, tombstones: [], progress: null, ...page };
    },
  });
  assert.deepEqual(
    bodies.map((body) => body.after),
    [undefined, "b"],
  );
  assert.deepEqual(report.visited, ["a", "c"]);
  assert.deepEqual(report.totals, { pages: 2, statuses: { unchanged: 1, would_normalize: 1 } });
});

test("apply calls until the run settles", async () => {
  const phases = ["applying", "applying", "done"];
  const report = await drive({
    mode: "apply",
    limit: 2,
    call: async () => ({ pages: [], visited: [], totals: {}, progress: { phase: phases.shift() } }),
  });
  assert.equal(report.calls, 3);
  assert.equal(report.progress.phase, "done");
  await assert.rejects(
    drive({
      mode: "apply",
      maxCalls: 2,
      call: async () => ({ pages: [], visited: [], progress: { phase: "applying" } }),
    }),
    /Stopped after 2 calls/,
  );
});

test("each response is handed over as it arrives, and a failure keeps the partial report", async () => {
  const seen = [];
  let calls = 0;
  const error = await drive({
    mode: "apply",
    limit: 1,
    onResponse: (body) => seen.push(body.visited),
    call: async () => {
      if (++calls === 2) throw Error("502 Bad Gateway");
      return {
        pages: [{ page_id: "a" }],
        visited: ["a"],
        totals: {},
        progress: { phase: "applying" },
      };
    },
  }).catch((reason) => reason);
  assert.match(error.message, /502/);
  assert.deepEqual(seen, [["a"]]);
  assert.equal(error.report.calls, 1);
  assert.deepEqual(error.report.visited, ["a"]);
});

test("the log path is a flag, with a default per mode", () => {
  assert.match(
    parseArgs(["--origin", "https://x", "--mode", "apply"]).log,
    /^content-migration-apply-.*\.jsonl$/,
  );
  assert.equal(
    parseArgs(["--origin", "https://x", "--mode", "dry_run", "--log", "out.jsonl"]).log,
    "out.jsonl",
  );
});
