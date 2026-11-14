import assert from "node:assert/strict";
import test from "node:test";
import * as A from "@automerge/automerge";
import { DocStore, MemoryByteStore } from "../sync/doc-store.mjs";
import { authorOf } from "./author.mjs";
import {
  MAX_SOURCES,
  MAX_SOURCE_IDS,
  SOURCE_HISTORY_LIMIT,
  WRITER_LIMITS,
  deletedSource,
  listSources,
  readSource,
  setSources,
  sourcesGenesis,
  validateSourceBatch,
  checkSources,
} from "./sources-doc.mjs";

const PARQUET = "application/vnd.apache.parquet";
const first = "a".repeat(64),
  second = "b".repeat(64),
  third = "c".repeat(64);
const uuid = "5e0c1a4e-7d2b-4c1e-9f3a-0b1c2d3e4f50";
const mediaTypes = new Map([first, second, third].map((id) => [id, PARQUET]));
const op = (fields = {}) => ({
  op: "set_source",
  source_id: "usage",
  name: "Tool usage",
  asset_id: first,
  source_revision: null,
  ...fields,
});
const AT = "2026-11-12T10:00:00.000Z";
const writer = (principal, agent) =>
  authorOf({ principal, displayName: "Owner", driver: "MCP" }, agent);
const OWNER = writer("user:test:owner");
const write = (doc, operations, by = OWNER, at = AT) =>
  A.change(doc, (draft) => {
    setSources(draft, operations, { mediaTypes, by, at });
  });
const initial = () => write(A.clone(sourcesGenesis(uuid)), [op()]);

test("retired IDs are bounded without preventing an existing source's update or deletion", () => {
  const doc = { sources: { ...initial().sources } };
  for (let i = 1; i < MAX_SOURCE_IDS; i++) doc.sources[`retired_${i}`] = { deleted: true };
  assert.throws(
    () => checkSources(doc, [op({ source_id: "new_source" })]),
    /including deleted sources/,
  );
  assert.doesNotThrow(() => checkSources(doc, [op({ source_revision: "1" })]));
  assert.doesNotThrow(() =>
    checkSources(doc, [{ op: "delete_source", source_id: "usage", source_revision: "1" }]),
  );
  assert.throws(() => checkSources(doc, [op({ source_id: "retired_1" })]), /was deleted/);
  assert.equal(listSources(doc).length, 1);
});

test("a delete records the batch's time and writer in the tombstone", () => {
  const deleter = writer("user:test:editor", { name: "Claude", model: "opus" });
  const later = "2026-11-12T12:00:00.000Z";
  const doc = write(
    initial(),
    [{ op: "delete_source", source_id: "usage", source_revision: "1" }],
    deleter,
    later,
  );
  const by = {
    principal: "user:test:editor",
    displayName: "Owner",
    driver: "MCP",
    agent: { name: "Claude", model: "opus" },
  };
  assert.deepEqual(
    { ...doc.sources.usage, by: { ...doc.sources.usage.by } },
    {
      deleted: true,
      at: later,
      by,
    },
  );
  assert.deepEqual(deletedSource(doc, "usage"), { source_id: "usage", at: later, by });
  assert.throws(() => readSource(doc, "usage"), { code: "source_not_found" });
  assert.deepEqual(listSources(doc), []);
  assert.throws(
    () => write(doc, [op({ source_id: "usage" })]),
    { code: "source_not_found" },
    "a retired id is not reused",
  );
});

test("deletedSource reads both tombstone forms and nothing else", () => {
  const doc = initial();
  const by = { principal: "user:test:owner", displayName: "Owner", driver: "MCP" };
  const stored = {
    ...doc.sources,
    bare: { deleted: true },
    full: { deleted: true, at: AT, by },
    bad_at: { deleted: true, at: "not a time", by },
    bad_by: { deleted: true, at: AT, by: { principal: 7 } },
  };
  const tombstones = { sources: stored };
  assert.equal(deletedSource(tombstones, "usage"), null, "an active source");
  assert.equal(deletedSource(tombstones, "missing"), null, "an unknown id");
  assert.equal(deletedSource(tombstones, "constructor"), null, "a reserved id");
  assert.equal(deletedSource(undefined, "usage"), null, "no sources document");
  assert.deepEqual(deletedSource(tombstones, "full"), { source_id: "full", at: AT, by });
  for (const id of ["bare", "bad_at", "bad_by"])
    assert.deepEqual(deletedSource(tombstones, id), { source_id: id, at: null, by: null });
  for (const id of ["bare", "full", "bad_at", "bad_by"]) {
    assert.throws(() => readSource(tombstones, id), { code: "source_not_found" });
    assert.throws(() => checkSources(tombstones, [op({ source_id: id })]), /was deleted/);
  }
  assert.deepEqual(
    listSources(tombstones).map((source) => source.source_id),
    ["usage"],
  );
});

test("the genesis is a pure function of the document id", () => {
  const one = sourcesGenesis(uuid);
  const two = sourcesGenesis(uuid);
  assert.deepEqual(A.getHeads(one), A.getHeads(two));
  assert.deepEqual(A.save(one), A.save(two));
  assert.deepEqual({ ...one }, { sources: {} });
  assert.notDeepEqual(
    A.getHeads(sourcesGenesis("5e0c1a4e-7d2b-4c1e-9f3a-0b1c2d3e4f51")),
    A.getHeads(one),
  );
  assert.throws(() => sourcesGenesis("not-a-uuid"), /Invalid sources document id/);
});

test("create, rename and refresh mint one revision per write and survive save and load", () => {
  let doc = initial();
  const owner = { principal: "user:test:owner", displayName: "Owner", driver: "MCP" };
  assert.deepEqual(readSource(doc, "usage"), {
    source_id: "usage",
    name: "Tool usage",
    source_revision: "1",
    asset_id: first,
    media_type: PARQUET,
    producer: { kind: "upload", at: AT, by: owner },
    history: [
      {
        revision: "1",
        name: "Tool usage",
        media_type: PARQUET,
        asset_id: first,
        at: AT,
        by: owner,
      },
    ],
    history_truncated: false,
  });
  doc = write(doc, [op({ name: "  Renamed  ", source_revision: "1" })]);
  assert.equal(readSource(doc, "usage").name, "Renamed");
  assert.equal(readSource(doc, "usage").source_revision, "2");
  assert.equal(readSource(doc, "usage").asset_id, first);
  const later = "2026-11-12T11:00:00.000Z";
  doc = write(
    doc,
    [op({ name: "Renamed", asset_id: second, source_revision: "2" })],
    writer("user:b", { name: "Release bot", model: "m-1" }),
    later,
  );
  const loaded = A.load(A.save(doc));
  const releaser = {
    principal: "user:b",
    displayName: "Owner",
    driver: "MCP",
    agent: { name: "Release bot", model: "m-1" },
  };
  const { history, ...present } = readSource(loaded, "usage");
  assert.deepEqual(present, {
    source_id: "usage",
    name: "Renamed",
    source_revision: "3",
    asset_id: second,
    media_type: PARQUET,
    producer: { kind: "upload", at: later, by: releaser },
    history_truncated: false,
  });
  assert.deepEqual(
    history.map(({ revision, name, asset_id, at, by }) => [revision, name, asset_id, at, by]),
    [
      ["1", "Tool usage", first, AT, owner],
      ["2", "Renamed", first, AT, owner],
      ["3", "Renamed", second, later, releaser],
    ],
  );
  assert.deepEqual(listSources(loaded), [
    {
      source_id: "usage",
      name: "Renamed",
      source_revision: "3",
      asset_id: second,
      media_type: PARQUET,
    },
  ]);
});

test("a write records the media type it is given, not one the caller names", () => {
  const types = new Map([[first, "application/x-other"]]);
  const doc = A.change(A.clone(sourcesGenesis(uuid)), (draft) => {
    setSources(draft, [op()], { mediaTypes: types, by: OWNER });
  });
  assert.equal(readSource(doc, "usage").media_type, "application/x-other");
  assert.ok(!Number.isNaN(Date.parse(readSource(doc, "usage").producer.at)), "the host's time");
  assert.throws(
    () =>
      A.change(A.clone(sourcesGenesis(uuid)), (draft) => {
        setSources(draft, [op()], { mediaTypes: new Map(), by: OWNER });
      }),
    /no checked media type/,
  );
  for (const bad of [{ by: undefined }, { by: { principal: "p" } }, { at: "yesterday" }])
    assert.throws(
      () =>
        A.change(A.clone(sourcesGenesis(uuid)), (draft) => {
          setSources(draft, [op()], { mediaTypes, by: OWNER, ...bad });
        }),
      /needs its writer and time/,
    );
});

test("a writer's display name is cut to its bound; over-long driver and agent labels are refused", () => {
  const long = authorOf({ principal: "user:long", displayName: "x".repeat(6000), driver: "MCP" });
  let doc = write(A.clone(sourcesGenesis(uuid)), [op()], long);
  const stored = readSource(doc, "usage");
  assert.equal(stored.producer.by.displayName, "x".repeat(WRITER_LIMITS.displayName));
  assert.deepEqual(stored.history[0].by, stored.producer.by);
  // A cut never leaves half a surrogate pair.
  const astral = authorOf({ principal: "p", displayName: `${"x".repeat(199)}😀`, driver: "MCP" });
  doc = write(doc, [op({ source_revision: "1" })], astral);
  assert.equal(readSource(doc, "usage").producer.by.displayName, "x".repeat(199));
  for (const by of [
    authorOf({ principal: "p", displayName: "d", driver: "D".repeat(WRITER_LIMITS.driver + 1) }),
    writer("p", { name: "N".repeat(WRITER_LIMITS.agentName + 1) }),
    writer("p", { model: "M".repeat(WRITER_LIMITS.agentModel + 1) }),
  ])
    assert.throws(() => write(A.clone(doc), [op({ source_revision: "2" })], by), /writer and time/);
  // At their bounds they are stored.
  const widest = authorOf(
    { principal: "p", displayName: "d", driver: "D".repeat(WRITER_LIMITS.driver) },
    { name: "N".repeat(WRITER_LIMITS.agentName), model: "M".repeat(WRITER_LIMITS.agentModel) },
  );
  doc = write(doc, [op({ source_revision: "2" })], widest);
  assert.deepEqual(readSource(doc, "usage").producer.by, widest);
  // A stored label over its bound is not one a host write stores.
  const overLong = A.change(A.clone(doc), (draft) => {
    draft.sources.usage.producer.by.displayName = "x".repeat(WRITER_LIMITS.displayName + 1);
  });
  assert.throws(() => readSource(overLong, "usage"), { code: "invalid_source" });
});

test("a stale, missing or ambiguous revision is refused with the current one", () => {
  const doc = initial();
  for (const [revision, code, current] of [
    [null, "stale_source", "1"],
    ["2", "stale_source", "1"],
  ])
    assert.throws(
      () => write(A.clone(doc), [op({ source_revision: revision })]),
      (error) =>
        error.code === code &&
        error.status === 409 &&
        error.details.source_id === "usage" &&
        error.details.source_revision === current,
    );
  assert.throws(
    () => write(A.clone(doc), [op({ source_id: "missing", source_revision: "1" })]),
    (error) =>
      error.code === "source_not_found" &&
      error.status === 404 &&
      error.details.source_revision === null,
  );
});

test("every malformed field is invalid_source, before anything is written", () => {
  for (const bad of [
    { source_id: "Usage" },
    { source_id: "1usage" },
    { source_id: "a/b" },
    { source_id: "" },
    { source_id: "a".repeat(65) },
    { source_id: "__proto__" },
    { source_id: "constructor" },
    { source_id: 7 },
    { name: "" },
    { name: "   " },
    { name: "x".repeat(201) },
    { name: 3 },
    { asset_id: "bad" },
    { asset_id: "A".repeat(64) },
    { source_revision: "0" },
    { source_revision: "01" },
    { source_revision: 1 },
    { source_revision: undefined },
    { expected_revision: null },
    { media_type: PARQUET },
  ]) {
    const operation = op(bad);
    if (Object.hasOwn(bad, "source_revision") && bad.source_revision === undefined)
      delete operation.source_revision;
    assert.throws(
      () => validateSourceBatch([operation]),
      (error) => error.code === "invalid_source" && error.status === 400,
      JSON.stringify(bad),
    );
  }
  assert.throws(() => validateSourceBatch([]), { code: "invalid_source" });
  assert.throws(() => validateSourceBatch([op(), op({ name: "Again" })]), {
    code: "invalid_source",
    message: "A batch cannot change the same source twice",
  });
  assert.deepEqual(validateSourceBatch([op(), op({ source_id: "b", asset_id: first })]), [first]);
});

test("a refusal names the rule the field broke", () => {
  const refusal = (fields) => {
    try {
      validateSourceBatch([op(fields)]);
    } catch (error) {
      assert.equal(error.code, "invalid_source");
      return error.message;
    }
    assert.fail(`${JSON.stringify(fields)} was accepted`);
  };
  // A control character anywhere in a name, even one a trim would remove.
  for (const name of ["Tool\u0000usage", "Tool\nusage", "Tool usage\n", "\u007f"])
    assert.equal(refusal({ name }), "name can't hold control characters such as a newline or NUL");
  assert.match(refusal({ source_id: "constructor" }), /not constructor or prototype$/);
  // An uppercase id is a malformed id, not a missing asset.
  assert.equal(
    refusal({ asset_id: "A".repeat(64) }),
    "asset_id is 64 lowercase hex characters: the asset_id an upload returned",
  );
});

test("a Page holds at most 64 sources; changing one at the cap still works", () => {
  const operations = Array.from({ length: MAX_SOURCES }, (_, i) =>
    op({ source_id: `s${i}`, asset_id: first }),
  );
  let doc = write(A.clone(sourcesGenesis(uuid)), operations);
  assert.equal(listSources(doc).length, MAX_SOURCES);
  const heads = A.getHeads(doc);
  assert.throws(() => write(A.clone(doc), [op({ source_id: "one-more" })]), {
    code: "invalid_source",
  });
  assert.deepEqual(A.getHeads(doc), heads);
  doc = write(doc, [op({ source_id: "s0", asset_id: second, source_revision: "1" })]);
  assert.equal(readSource(doc, "s0").asset_id, second);
});

test("a failed operation leaves the batch's earlier operations unapplied", () => {
  const doc = initial();
  const heads = A.getHeads(doc);
  assert.throws(
    () =>
      write(A.clone(doc), [
        op({ source_id: "daily", asset_id: second }),
        op({ source_revision: "9" }),
      ]),
    { code: "stale_source" },
  );
  assert.deepEqual(A.getHeads(doc), heads);
  assert.deepEqual(
    listSources(doc).map((source) => source.source_id),
    ["usage"],
  );
});

test("reads refuse malformed and unknown ids; a Page with no document lists none", () => {
  const doc = initial();
  for (const id of ["__proto__", "constructor", "prototype", "", "a/b", true])
    assert.throws(() => readSource(doc, id), { code: "invalid_source" });
  assert.throws(() => readSource(doc, "missing"), { code: "source_not_found", status: 404 });
  assert.deepEqual(listSources(undefined), []);
  assert.throws(() => readSource(undefined, "usage"), { code: "source_not_found" });
});

test("concurrent host candidates never tear an asset from its media type, and distinct sources survive", () => {
  const base = initial();
  // Two distinct asset and media type pairs, so a torn merge shows.
  const OTHER = "application/x-other-dataset";
  const pairs = new Map([
    [second, PARQUET],
    [third, OTHER],
  ]);
  const candidate = (actor, operations, by, at) =>
    A.change(A.clone(base, { actor }), (draft) => {
      setSources(draft, operations, { mediaTypes: pairs, by, at });
    });
  const LEFT = writer("user:left");
  const RIGHT = writer("user:right-hand");
  const LEFT_AT = "2026-11-12T10:01:00.000Z";
  const RIGHT_AT = "2026-11-12T10:02:00.000Z";
  // Each candidate's whole state for "usage" at revision "2".
  const written = [
    { name: "Tool usage", asset_id: second, media_type: PARQUET, at: LEFT_AT, by: LEFT },
    { name: "Tool usage", asset_id: third, media_type: OTHER, at: RIGHT_AT, by: RIGHT },
  ];
  // Each actor order decides each key's conflict on its own; the two orders
  // cover a merge where `current` and `producer` come from one candidate and
  // one where they come from different candidates.
  const torn = [];
  for (const [leftActor, rightActor] of [
    ["aa".repeat(16), "bb".repeat(16)],
    ["bb".repeat(16), "aa".repeat(16)],
  ]) {
    const left = candidate(
      leftActor,
      [
        op({ asset_id: second, source_revision: "1" }),
        op({ source_id: "daily", asset_id: second }),
      ],
      LEFT,
      LEFT_AT,
    );
    const right = candidate(
      rightActor,
      [
        op({ asset_id: third, source_revision: "1" }),
        op({ source_id: "latency", asset_id: third }),
      ],
      RIGHT,
      RIGHT_AT,
    );
    for (const merged of [A.merge(A.clone(left), right), A.merge(A.clone(right), left)]) {
      const stored = merged.sources.usage;
      // `current` is one map: its asset keeps its own media type.
      assert.equal(stored.current.media_type, pairs.get(stored.current.asset_id));
      // Both candidates stay recoverable as conflicts. The host writes one
      // source at a time in the Page's queue, so it never accepts both.
      assert.equal(Object.keys(A.getConflicts(stored, "current")).length, 2);
      assert.equal(stored.history.length, 3, "both appended a revision 2 state");
      torn.push(
        stored.producer.by.principal !==
          (stored.current.asset_id === second ? LEFT : RIGHT).principal,
      );
      // A read returns one candidate's whole state or refuses; never a mix.
      let value;
      try {
        value = readSource(merged, "usage");
      } catch (error) {
        assert.equal(error.code, "invalid_source");
      }
      if (value) {
        const present = {
          name: value.name,
          asset_id: value.asset_id,
          media_type: value.media_type,
          at: value.producer.at,
          by: value.producer.by,
        };
        assert.ok(written.some((state) => JSON.stringify(state) === JSON.stringify(present)));
        const { revision: _revision, ...last } = value.history.at(-1);
        assert.deepEqual(last, present);
      }
      // The sources each candidate created alone still read.
      assert.equal(readSource(merged, "daily").asset_id, second);
      assert.equal(readSource(merged, "latency").asset_id, third);
    }
  }
  assert.deepEqual([...new Set(torn)].sort(), [false, true], "some merges mixed the fields");
});

test("an entry that reads as invalid_source refuses its own writes, not new sources", () => {
  // Two candidates' revision 2 states in one list: no read accepts it.
  let doc = initial();
  doc = A.change(doc, (draft) => {
    const state = { ...JSON.parse(JSON.stringify(draft.sources.usage.history[0])) };
    draft.sources.usage.history.push({ ...state, revision: "2" });
    draft.sources.usage.history.push({ ...state, revision: "2" });
    draft.sources.usage.revision = "2";
  });
  assert.throws(() => readSource(doc, "usage"), { code: "invalid_source" });
  // The list read refuses as a whole, so it can't show the broken entry's name.
  assert.throws(() => listSources(doc), { code: "invalid_source" });
  // A write to that id is refused before anything is written.
  for (const revision of [null, "2"])
    assert.throws(() => write(A.clone(doc), [op({ source_revision: revision })]), {
      code: "invalid_source",
    });
  // A new id is written, and reads alone.
  doc = write(doc, [op({ source_id: "usage-2" })]);
  assert.equal(readSource(doc, "usage-2").name, "Tool usage");
  // The name is still in the document, but no read returns it.
  assert.equal(doc.sources.usage.name, "Tool usage");
});

test("the last history state is always the present entry", () => {
  let doc = initial();
  for (let revision = 1; revision <= 5; revision++) {
    doc = write(doc, [
      op({
        name: `Usage ${revision}`,
        asset_id: [first, second][revision % 2],
        source_revision: String(revision),
      }),
    ]);
    const source = readSource(doc, "usage");
    const last = source.history.at(-1);
    assert.deepEqual(
      [last.revision, last.name, last.asset_id, last.media_type, last.at, last.by],
      [
        source.source_revision,
        source.name,
        source.asset_id,
        source.media_type,
        source.producer.at,
        source.producer.by,
      ],
    );
  }
  // An entry whose present fields disagree with its last state is refused.
  for (const edit of [
    (entry) => (entry.name = "Elsewhere"),
    (entry) => (entry.current = { media_type: PARQUET, asset_id: third }),
    (entry) => (entry.producer = { kind: "upload", at: AT, by: writer("user:other") }),
    (entry) => (entry.revision = "7"),
    (entry) => entry.history.splice(entry.history.length - 1, 1),
  ]) {
    const broken = A.change(A.clone(doc), (draft) => edit(draft.sources.usage));
    assert.throws(() => readSource(broken, "usage"), { code: "invalid_source" });
  }
});

test("a stored record no host write produces reads as invalid_source", () => {
  const doc = A.change(A.clone(sourcesGenesis(uuid)), (draft) => {
    draft.sources.broken = { name: "x", revision: "1", current: { asset_id: first } };
    // A producer without a time and a writer is not one a host write stores.
    draft.sources.unattributed = {
      name: "x",
      revision: "1",
      current: { media_type: PARQUET, asset_id: first },
      producer: { kind: "upload", principal: "user:test:owner" },
    };
  });
  for (const id of ["broken", "unattributed"])
    assert.throws(() => readSource(doc, id), { code: "invalid_source" });
  assert.throws(() => listSources(doc), { code: "invalid_source" });
});

test("a malformed history list reads as invalid_source", () => {
  const doc = fourWrites();
  for (const edit of [
    (entry) => delete entry.history,
    (entry) => (entry.history = []),
    (entry) => (entry.history = "states"),
    (entry) => (entry.history[0].by = { principal: "p" }),
    (entry) => (entry.history[0].at = "yesterday"),
    (entry) => (entry.history[1].asset_id = "bad"),
    (entry) => (entry.history[1].extra = true),
    (entry) => (entry.history[0].revision = "9"),
    (entry) => entry.history.insertAt(0, "not a state"),
  ]) {
    const broken = A.change(A.clone(doc), (draft) => edit(draft.sources.usage));
    assert.throws(() => readSource(broken, "usage"), { code: "invalid_source" }, String(edit));
    assert.throws(() => listSources(broken), { code: "invalid_source" });
  }
});

const times = ["T10:00:00.000Z", "T11:00:00.000Z", "T12:00:00.000Z", "T13:00:00.000Z"].map(
  (time) => `2026-11-12${time}`,
);
const ALICE = writer("user:alice", { name: "Loader", model: "m-1" });
const BOB = authorOf({ principal: "user:bob", displayName: "Bob", driver: "Browser" });

/** Create, rename, refresh, rename again: one source's four writes. */
function fourWrites() {
  let doc = write(A.clone(sourcesGenesis(uuid)), [op()], ALICE, times[0]);
  doc = write(doc, [op({ name: "Usage", source_revision: "1" })], BOB, times[1]);
  doc = write(
    doc,
    [op({ name: "Usage", asset_id: second, source_revision: "2" })],
    ALICE,
    times[2],
  );
  doc = write(
    doc,
    [op({ name: "Daily usage", asset_id: second, source_revision: "3" })],
    OWNER,
    times[3],
  );
  return doc;
}
const FOUR_STATES = [
  {
    revision: "1",
    name: "Tool usage",
    media_type: PARQUET,
    asset_id: first,
    at: times[0],
    by: ALICE,
  },
  { revision: "2", name: "Usage", media_type: PARQUET, asset_id: first, at: times[1], by: BOB },
  { revision: "3", name: "Usage", media_type: PARQUET, asset_id: second, at: times[2], by: ALICE },
  {
    revision: "4",
    name: "Daily usage",
    media_type: PARQUET,
    asset_id: second,
    at: times[3],
    by: OWNER,
  },
];

const history = (doc, id = "usage") => readSource(doc, id).history;

test("a source's history is every revision's file, name, time and writer, oldest first", () => {
  const doc = fourWrites();
  const source = readSource(doc, "usage");
  assert.deepEqual(source.history, FOUR_STATES);
  assert.equal(source.history_truncated, false);
  assert.deepEqual(source.producer, { kind: "upload", at: times[3], by: OWNER });
});

test("two sources written in turn keep separate histories", () => {
  let doc = write(A.clone(sourcesGenesis(uuid)), [op()], ALICE, times[0]);
  doc = write(doc, [op({ source_id: "latency", name: "Latency", asset_id: third })], BOB, times[1]);
  doc = write(doc, [op({ asset_id: second, source_revision: "1" })], BOB, times[2]);
  doc = write(
    doc,
    [op({ source_id: "latency", name: "P99", asset_id: third, source_revision: "1" })],
    ALICE,
    times[3],
  );
  // A batch that writes both sources is one revision of each.
  doc = write(
    doc,
    [
      op({ name: "Both", asset_id: first, source_revision: "2" }),
      op({ source_id: "latency", name: "Both", asset_id: first, source_revision: "2" }),
    ],
    OWNER,
    times[3],
  );
  const usage = history(doc, "usage");
  const latency = history(doc, "latency");
  assert.deepEqual(
    usage.map(({ revision, name, asset_id, at }) => [revision, name, asset_id, at]),
    [
      ["1", "Tool usage", first, times[0]],
      ["2", "Tool usage", second, times[2]],
      ["3", "Both", first, times[3]],
    ],
  );
  assert.deepEqual(
    latency.map(({ revision, name, asset_id, at, by }) => [revision, name, asset_id, at, by]),
    [
      ["1", "Latency", third, times[1], BOB],
      ["2", "P99", third, times[3], ALICE],
      ["3", "Both", first, times[3], OWNER],
    ],
  );
});

test("history keeps the newest 50 states and says when older ones exist", () => {
  let doc = write(A.clone(sourcesGenesis(uuid)), [op({ name: "Usage 1" })]);
  let writes = 1;
  const writeUpTo = (count) => {
    for (; writes < count; writes++)
      doc = write(doc, [op({ name: `Usage ${writes + 1}`, source_revision: String(writes) })]);
  };
  writeUpTo(SOURCE_HISTORY_LIMIT);
  assert.equal(history(doc).length, SOURCE_HISTORY_LIMIT);
  assert.equal(readSource(doc, "usage").history_truncated, false, "a full list holds every state");
  for (const count of [SOURCE_HISTORY_LIMIT + 1, SOURCE_HISTORY_LIMIT + 10]) {
    writeUpTo(count);
    const source = readSource(doc, "usage");
    assert.equal(doc.sources.usage.history.length, SOURCE_HISTORY_LIMIT, "the stored list");
    assert.equal(source.history.length, SOURCE_HISTORY_LIMIT);
    assert.equal(source.history_truncated, true);
    assert.equal(source.history[0].revision, String(count - SOURCE_HISTORY_LIMIT + 1));
    assert.equal(source.history[0].name, `Usage ${count - SOURCE_HISTORY_LIMIT + 1}`);
    assert.equal(source.history.at(-1).revision, String(count));
    assert.equal(source.history.at(-1).name, `Usage ${count}`);
  }
});

test("history survives the host's chunked storage and compaction", async () => {
  const concat = (parts) => {
    const out = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
    let at = 0;
    for (const part of parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  };
  const store = new DocStore(new MemoryByteStore());
  const genesis = sourcesGenesis(uuid);
  await store.compact("s", A.save(genesis), A.getHeads(genesis));
  const doc = fourWrites();
  // Each write lands as its own chunk of change bytes, as SyncHost appends
  // them, and a compaction folds the first two into the snapshot.
  const changes = A.getChanges(genesis, doc);
  const loadStored = async () => {
    const stored = await store.read("s");
    return A.load(concat([stored.snapshot, ...stored.chunks].filter(Boolean)));
  };
  for (const [index, change] of changes.entries()) {
    await store.append("s", change, []);
    if (index === 1) await store.compact("s", A.save(await loadStored()), []);
  }
  const chunked = await loadStored();
  assert.deepEqual(history(chunked), FOUR_STATES);
  await store.compact("s", A.save(chunked), A.getHeads(chunked));
  assert.deepEqual(history(await loadStored()), FOUR_STATES);
});
