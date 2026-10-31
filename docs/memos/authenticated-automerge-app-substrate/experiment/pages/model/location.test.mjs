import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_DEPTH,
  MAX_KEY_LENGTH,
  REBALANCE_KEY_LENGTH,
  MOVE_REFUSALS,
  applyWrite,
  checkInvariants,
  deriveLocation,
  entryProblems,
  planMove,
  positionAmong,
  siblingsOf,
  subtreeOf,
  subtreeSpaceIds,
  validPositionKey,
  validateEntry,
} from "./location.mjs";

const PRJ = "prj_launch";
const OTHER = "prj_archive";

/** An entry with sensible defaults. */
const entry = (page_id, parent_id = null, extra = {}) => ({
  page_id,
  state: "active",
  parent_id,
  position: "a0",
  ...extra,
});
const stateOf = (...list) => ({
  revision: 7,
  entries: new Map(list.map((item) => [item.page_id, item])),
});

/**
 * Two Projects and Your items:
 *   launch (home of prj_launch)
 *     plan
 *       risks
 *       budget (pending)
 *     notes
 *   archive (home of prj_archive)
 *     old
 *   loose
 *   drafts
 *     idea
 *   gone (trashed, was under plan)
 */
function world() {
  return stateOf(
    entry("launch", null, { space_id: PRJ, position: "a0" }),
    entry("plan", "launch", { position: "a0" }),
    entry("risks", "plan", { position: "a0" }),
    entry("budget", "plan", { position: "a1", state: "pending" }),
    entry("notes", "launch", { position: "a1" }),
    entry("archive", null, { space_id: OTHER, position: "a1" }),
    entry("old", "archive"),
    entry("loose", null, { position: "a2" }),
    entry("drafts", null, { position: "a3" }),
    entry("idea", "drafts"),
    entry("gone", null, {
      state: "trashed",
      restore_parent_id: "plan",
      restore_space_id: PRJ,
    }),
  );
}

const ordered = (state, parentId) => siblingsOf(state.entries, parentId).map((e) => e.page_id);

test("MAX_DEPTH is 9 until the design's question 2 picks it", () => {
  assert.equal(MAX_DEPTH, 9);
});

test("entry shape: space_id only on a root, restore fields only in Trash", () => {
  assert.deepEqual(entryProblems(entry("a")), []);
  assert.deepEqual(entryProblems(entry("a", null, { space_id: PRJ, title: "kept" })), []);
  assert.deepEqual(
    entryProblems(entry("t", null, { state: "trashed", restore_parent_id: null })),
    [],
  );
  const cases = [
    [null, /not an object/],
    [{ ...entry("a"), page_id: "" }, /page_id/],
    [entry("a"), /differs from its key/, "b"],
    [{ ...entry("a"), state: "deleted" }, /state/],
    [{ ...entry("a"), parent_id: 3 }, /parent_id/],
    [entry("a", "a"), /names the entry itself/],
    [{ ...entry("a"), position: "" }, /position/],
    [{ ...entry("a"), position: "a 0" }, /position/],
    [{ ...entry("a"), position: "a" }, /position/],
    [{ ...entry("a"), position: "a00" }, /position/],
    [{ ...entry("a"), position: 7 }, /position/],
    [entry("a", "p", { space_id: PRJ }), /only on a root/],
    [entry("a", null, { space_id: "" }), /space_id/],
    [entry("a", null, { restore_parent_id: "p" }), /only on a trashed/],
    [entry("a", null, { state: "trashed", restore_space_id: 4 }), /restore_space_id/],
  ];
  for (const [value, pattern, key] of cases) {
    const problems = entryProblems(value, key);
    assert.ok(
      problems.some((problem) => pattern.test(problem)),
      `${JSON.stringify(value)}: ${problems}`,
    );
  }
  assert.throws(() => validateEntry(entry("a", "p", { space_id: PRJ })), /Invalid location entry/);
  assert.equal(validateEntry(entry("a")).page_id, "a");
});

test("position keys follow fractional-indexing's own rules", () => {
  for (const key of ["a0", "a1", "Zz", "b00", "a0V", "a0G1", "a0Z", "a0a", "a0z"])
    assert.equal(validPositionKey(key), true, key);
  assert.equal(validPositionKey("a0" + "V".repeat(MAX_KEY_LENGTH - 2)), true, "at the cap");
  assert.equal(validPositionKey("a0" + "V".repeat(MAX_KEY_LENGTH - 1)), false, "past the cap");
  // "a" and "a00" pass an alphanumeric check but break the generator.
  for (const key of [
    "a",
    "a00",
    "a0a0",
    "",
    ".",
    "a 0",
    "A",
    "z",
    null,
    3,
    "a" + "1".repeat(600),
    // Structurally fine, but outside the base-62 digits: "a0!" sorts where
    // new keys between it and "a0" fall outside the interval.
    "a0!",
    "a0é",
    "a0\u{1F600}",
    // ASCII puts [ \ ] ^ _ ` between Z and a; none is a digit.
    "a0[",
    "a0_",
    "a0`",
  ])
    assert.equal(validPositionKey(key), false, JSON.stringify(key));
  // A sibling with such a key is an invalid entry, so it never reaches planMove.
  const s = stateOf(entry("p"), entry("x", "p", { position: "a00" }), entry("m"));
  assert.deepEqual(
    checkInvariants(s).map((v) => [v.code, v.page_id]),
    [["invalid_entry", "x"]],
  );
});

test("deriveLocation walks to the root and reports its Project", () => {
  const { entries } = world();
  assert.deepEqual(deriveLocation(entries, "risks"), {
    ok: true,
    root: "launch",
    space_id: PRJ,
    depth: 3,
    ancestors: ["plan", "launch"],
  });
  assert.deepEqual(deriveLocation(entries, "launch"), {
    ok: true,
    root: "launch",
    space_id: PRJ,
    depth: 1,
    ancestors: [],
  });
  assert.equal(deriveLocation(entries, "idea").space_id, null, "Your items");
  // Plain objects work too.
  assert.equal(deriveLocation(Object.fromEntries(entries), "old").space_id, OTHER);
});

test("deriveLocation reports cycles, missing parents and depth; it never loops", () => {
  assert.deepEqual(deriveLocation(stateOf(entry("a")).entries, "z"), {
    ok: false,
    problem: "missing_page",
    page_id: "z",
  });
  assert.deepEqual(deriveLocation(stateOf(entry("a", "ghost")).entries, "a"), {
    ok: false,
    problem: "missing_parent",
    page_id: "a",
  });
  const cycle = stateOf(entry("a", "b"), entry("b", "c"), entry("c", "a"), entry("d", "a"));
  assert.deepEqual(deriveLocation(cycle.entries, "d"), {
    ok: false,
    problem: "cycle",
    page_id: "a",
  });
  // A long cycle still stops: the walk is bounded and never revisits.
  const ring = Array.from({ length: 50 }, (_, i) => entry(`r${i}`, `r${(i + 1) % 50}`));
  const result = deriveLocation(stateOf(...ring).entries, "r0");
  assert.equal(result.ok, false);
  assert.equal(result.problem, "too_deep");
});

test("depth: exactly MAX_DEPTH resolves, one more is too deep", () => {
  const chain = (length) =>
    stateOf(...Array.from({ length }, (_, i) => entry(`d${i + 1}`, i ? `d${i}` : null)));
  const fits = deriveLocation(chain(MAX_DEPTH).entries, `d${MAX_DEPTH}`);
  assert.equal(fits.ok, true);
  assert.equal(fits.depth, MAX_DEPTH);
  const deep = deriveLocation(chain(MAX_DEPTH + 1).entries, `d${MAX_DEPTH + 1}`);
  assert.deepEqual(deep, { ok: false, problem: "too_deep", page_id: "d1" });
  assert.deepEqual(checkInvariants(chain(MAX_DEPTH)), []);
  assert.deepEqual(
    checkInvariants(chain(MAX_DEPTH + 1)).map((v) => [v.code, v.page_id]),
    [["nesting_depth_exceeded", `d${MAX_DEPTH + 1}`]],
  );
});

test("subtreeOf and subtreeSpaceIds list a Page's descendants top-down", () => {
  const { entries } = world();
  assert.deepEqual(subtreeOf(entries, "launch"), [
    { page_id: "launch", depth: 0 },
    { page_id: "plan", depth: 1 },
    { page_id: "notes", depth: 1 },
    { page_id: "risks", depth: 2 },
    { page_id: "budget", depth: 2 },
  ]);
  assert.deepEqual(subtreeOf(entries, "nope"), []);
  assert.deepEqual(subtreeSpaceIds(entries, "plan"), [
    { page_id: "plan", space_id: PRJ },
    { page_id: "risks", space_id: PRJ },
    { page_id: "budget", space_id: PRJ },
  ]);
  assert.deepEqual(subtreeSpaceIds(entries, "drafts"), [
    { page_id: "drafts", space_id: null },
    { page_id: "idea", space_id: null },
  ]);
  assert.deepEqual(subtreeSpaceIds(entries, "nope"), []);
});

test("every refusal code has a case, and refusals carry a message", () => {
  const s = world();
  const cases = [
    ["page_not_found", "nope", { project_id: null }],
    ["home_page_protected", "launch", { project_id: OTHER }],
    ["home_page_protected", "archive", { parent_id: "plan" }],
    ["placement_cycle", "plan", { parent_id: "plan" }],
    ["placement_cycle", "plan", { parent_id: "risks" }],
    ["placement_mismatch", "loose", { project_id: OTHER, parent_id: "plan" }],
    ["placement_mismatch", "loose", { project_id: null, parent_id: "plan" }],
    ["placement_mismatch", "plan", { project_id: PRJ, parent_id: "idea" }],
    ["page_trashed", "gone", { project_id: PRJ }],
    ["parent_unavailable", "loose", { parent_id: "gone" }],
    ["parent_unavailable", "loose", { parent_id: "budget" }],
    ["parent_unavailable", "loose", { parent_id: "ghost" }],
    ["project_not_found", "loose", { project_id: "prj_missing" }],
    ["project_not_found", "loose", { project_id: "prj_missing", parent_id: "plan" }],
    ["move_destination_required", "loose", {}],
    ["move_destination_required", "loose", { parent_id: null }],
    ["invalid_position", "loose", { project_id: PRJ }, "middle"],
    ["invalid_position", "loose", { project_id: PRJ }, { before: "plan", after: "notes" }],
    ["invalid_position", "loose", { project_id: PRJ }, { before: "" }],
    ["invalid_position", "loose", { project_id: PRJ }, { after: "loose" }],
    ["position_sibling_unknown", "loose", { project_id: PRJ }, { before: "risks" }],
  ];
  const seen = new Set();
  for (const [code, pageId, destination, position] of cases) {
    const result = planMove(s, pageId, destination, position);
    assert.equal(result.ok, false, `${code}: ${JSON.stringify(result)}`);
    assert.equal(result.code, code, `${pageId} → ${JSON.stringify(destination)}`);
    assert.equal(typeof result.message, "string");
    seen.add(code);
  }
  // A pending Project (its home is still being created) can't take Pages.
  const pendingProject = stateOf(entry("h", null, { space_id: PRJ, state: "pending" }), entry("p"));
  assert.equal(planMove(pendingProject, "p", { project_id: PRJ }).code, "project_not_found");
  // nesting_depth_exceeded has its own boundary test.
  seen.add("nesting_depth_exceeded");
  assert.deepEqual([...seen].sort(), [...MOVE_REFUSALS].sort());
});

test("malformed arguments are programming errors, not refusals", () => {
  const s = world();
  assert.throws(() => planMove(s, "loose", { project_id: 3 }), TypeError);
  assert.throws(() => planMove(s, "loose", { parent_id: {} }), TypeError);
  assert.throws(() => planMove(s, "loose", null), TypeError);
  assert.throws(() => planMove({ ...s, revision: -1 }, "loose", { project_id: null }), TypeError);
});

test("depth at the boundary: a subtree fits only where its deepest Page stays within MAX_DEPTH", () => {
  // chain c1..c7 under the home Page h (h is depth 1, c7 depth 8).
  const list = [entry("h", null, { space_id: PRJ })];
  for (let i = 1; i <= MAX_DEPTH - 2; i++) list.push(entry(`c${i}`, i === 1 ? "h" : `c${i - 1}`));
  // m has one child, so it adds two levels.
  list.push(entry("m"), entry("m1", "m"));
  const s = stateOf(...list);
  const last = `c${MAX_DEPTH - 2}`;
  const tooDeep = planMove(s, "m", { parent_id: last });
  assert.equal(tooDeep.code, "nesting_depth_exceeded");
  const fits = planMove(s, "m", { parent_id: `c${MAX_DEPTH - 3}` });
  assert.equal(fits.ok, true, JSON.stringify(fits));
  const after = applyWrite(s, fits);
  assert.equal(deriveLocation(after.entries, "m1").depth, MAX_DEPTH);
  assert.deepEqual(checkInvariants(after), []);
  // A leaf fits one level lower.
  assert.equal(planMove(s, "m1", { parent_id: last }).ok, true);
});

test("corrupt input: an over-deep chain is enumerated whole, never truncated", () => {
  // Ten Pages in one chain: one level past MAX_DEPTH, as old or imported data
  // might be.
  const length = MAX_DEPTH + 1;
  const s = stateOf(
    ...Array.from({ length }, (_, i) => entry(`d${i + 1}`, i ? `d${i}` : null)),
    entry("other", null, { position: "a1" }),
  );
  assert.ok(checkInvariants(s).some((v) => v.code === "nesting_depth_exceeded"));
  assert.equal(subtreeOf(s.entries, "d1").length, length);
  assert.deepEqual(
    subtreeSpaceIds(s.entries, "d1").map((row) => row.page_id),
    Array.from({ length }, (_, i) => `d${i + 1}`),
  );
  // Moving the whole chain anywhere is refused, even to where it already is.
  assert.equal(planMove(s, "d1", { project_id: null }).code, "nesting_depth_exceeded");
  assert.equal(planMove(s, "d1", { parent_id: "other" }).code, "nesting_depth_exceeded");
  // Cutting it below the root repairs it, and the projection names all nine
  // moved Pages, d10 included.
  const cut = planMove(s, "d2", { project_id: null });
  assert.equal(cut.ok, true, JSON.stringify(cut));
  assert.equal(cut.projection.length, length - 1);
  assert.equal(cut.projection.at(-1).page_id, `d${length}`);
  assert.deepEqual(checkInvariants(applyWrite(s, cut)), []);
  // A Page inside a cycle has no root, but listing below it still ends.
  const looped = stateOf(entry("a", "b"), entry("b", "a"));
  assert.deepEqual(
    subtreeOf(looped.entries, "a").map((member) => member.page_id),
    ["a", "b"],
  );
});

test("a move is one write: the moved entry and the revision, never its descendants", () => {
  const s = world();
  const result = planMove(s, "plan", { project_id: OTHER });
  assert.equal(result.ok, true);
  assert.equal(result.revision, 8);
  assert.deepEqual(Object.keys(result.entries), ["plan"]);
  assert.equal(result.entries.plan.parent_id, "archive");
  assert.deepEqual(result.moved, {
    page_id: "plan",
    parent_id: "archive",
    space_id: OTHER,
    position: result.entries.plan.position,
    descendants: 2,
  });
  assert.deepEqual(result.projection, [
    { page_id: "plan", space_id: OTHER },
    { page_id: "risks", space_id: OTHER },
    { page_id: "budget", space_id: OTHER },
  ]);
  // The input state is untouched.
  assert.equal(s.entries.get("plan").parent_id, "launch");
  assert.equal(s.revision, 7);
});

test("a subtree move across Projects changes every descendant's derived space_id", () => {
  const s = world();
  const before = subtreeSpaceIds(s.entries, "plan").map((row) => row.space_id);
  assert.deepEqual(before, [PRJ, PRJ, PRJ]);
  const after = applyWrite(s, planMove(s, "plan", { parent_id: "old" }));
  assert.deepEqual(subtreeSpaceIds(after.entries, "plan"), [
    { page_id: "plan", space_id: OTHER },
    { page_id: "risks", space_id: OTHER },
    { page_id: "budget", space_id: OTHER },
  ]);
  assert.deepEqual(deriveLocation(after.entries, "risks").ancestors, ["plan", "old", "archive"]);
  // Out to Your items and back into a Project.
  const out = applyWrite(after, planMove(after, "plan", { project_id: null }));
  assert.equal(deriveLocation(out.entries, "budget").space_id, null);
  assert.equal(out.entries.get("plan").parent_id, null);
  assert.equal(out.revision, 9);
  const back = applyWrite(out, planMove(out, "plan", { project_id: PRJ }));
  assert.equal(deriveLocation(back.entries, "risks").space_id, PRJ);
  assert.equal(back.entries.get("plan").parent_id, "launch");
  for (const state of [after, out, back]) assert.deepEqual(checkInvariants(state), []);
});

test("a pending child follows its parent's move with no extra step", () => {
  // P1 #1 in #4597: an interrupted child creation kept its old Project. Here
  // the pending entry stores only its parent, so a move carries it along.
  const s = world();
  assert.equal(s.entries.get("budget").state, "pending");
  const result = planMove(s, "plan", { project_id: OTHER });
  assert.ok(!("budget" in result.entries), "the pending child isn't written");
  const after = applyWrite(s, result);
  assert.equal(after.entries.get("budget"), s.entries.get("budget"), "same entry object");
  assert.equal(deriveLocation(after.entries, "budget").space_id, OTHER);
  // A pending Page is only a pointer here, so it can move itself too.
  const own = planMove(after, "budget", { project_id: null });
  assert.equal(own.ok, true);
  assert.equal(own.entries.budget.state, "pending");
  // But nothing can move under a pending Page.
  assert.equal(planMove(s, "loose", { parent_id: "budget" }).code, "parent_unavailable");
});

test("project_id with a matching parent is accepted; null matches Your items", () => {
  const s = world();
  assert.equal(planMove(s, "loose", { project_id: PRJ, parent_id: "risks" }).ok, true);
  assert.equal(planMove(s, "plan", { project_id: null, parent_id: "idea" }).ok, true);
  assert.equal(planMove(s, "idea", { project_id: null }).entries.idea.parent_id, null);
});

test("positions: first, last, before and after order the moved Page among siblings", () => {
  let s = world();
  const move = (position) => {
    const result = planMove(s, "loose", { parent_id: "plan" }, position);
    assert.equal(result.ok, true, JSON.stringify(result));
    s = applyWrite(s, result);
    return ordered(s, "plan");
  };
  assert.deepEqual(move("first"), ["loose", "risks", "budget"]);
  assert.deepEqual(move("last"), ["risks", "budget", "loose"]);
  assert.deepEqual(move(undefined), ["risks", "budget", "loose"], "last is the default");
  assert.deepEqual(move({ before: "budget" }), ["risks", "loose", "budget"]);
  assert.deepEqual(move({ after: "budget" }), ["risks", "budget", "loose"]);
  assert.deepEqual(move({ before: "risks" }), ["loose", "risks", "budget"]);
  assert.deepEqual(move({ after: "risks" }), ["risks", "loose", "budget"]);
  // Within the same parent the Page's own old key is excluded.
  assert.deepEqual(move({ after: "budget" }), ["risks", "budget", "loose"]);
  // Roots order the same way.
  const root = applyWrite(s, planMove(s, "idea", { project_id: null }, "first"));
  assert.equal(ordered(root, null)[0], "idea");
  // Trashed entries are never siblings.
  assert.ok(!ordered(root, null).includes("gone"));
});

test("a move repairs every tie in its destination", () => {
  const ties = () =>
    stateOf(
      entry("p"),
      entry("x", "p", { position: "a0" }),
      entry("y", "p", { position: "a0" }),
      entry("z", "p", { position: "a0" }),
      entry("w", "p", { position: "a2" }),
      entry("m", null, { position: "a1" }),
    );
  const keysOf = (state) => ordered(state, "p").map((id) => state.entries.get(id).position);
  const cases = [
    [{ after: "x" }, ["x", "m", "y", "z", "w"]],
    // After y: x and y were equal before, and stay distinct after.
    [{ after: "y" }, ["x", "y", "m", "z", "w"]],
    [{ before: "x" }, ["m", "x", "y", "z", "w"]],
    ["first", ["m", "x", "y", "z", "w"]],
    // A tie away from the insertion point is repaired too.
    ["last", ["x", "y", "z", "w", "m"]],
    [{ after: "w" }, ["x", "y", "z", "w", "m"]],
  ];
  for (const [position, order] of cases) {
    const s = ties();
    assert.deepEqual(ordered(s, "p"), ["x", "y", "z", "w"]);
    assert.ok(checkInvariants(s).some((v) => v.code === "duplicate_position"));
    const result = planMove(s, "m", { parent_id: "p" }, position);
    assert.equal(result.ok, true, JSON.stringify(position));
    assert.deepEqual(Object.keys(result.entries).sort(), ["m", "y", "z"], JSON.stringify(position));
    const after = applyWrite(s, result);
    assert.deepEqual(ordered(after, "p"), order, JSON.stringify(position));
    const keys = keysOf(after);
    assert.deepEqual([...keys].sort(), keys, JSON.stringify(position));
    assert.equal(new Set(keys).size, keys.length, `${JSON.stringify(position)}: distinct keys`);
    assert.equal(after.entries.get("x").position, "a0", "the first of a run keeps its key");
    assert.equal(after.entries.get("w").position, "a2", "untied siblings keep their keys");
    assert.deepEqual(checkInvariants(after), [], JSON.stringify(position));
  }
  // Without ties only the moved Page is written.
  const clean = stateOf(
    entry("p"),
    entry("x", "p", { position: "a0" }),
    entry("m", null, { position: "a1" }),
  );
  assert.deepEqual(Object.keys(planMove(clean, "m", { parent_id: "p" }).entries), ["m"]);
});

test("a key that would pass the rebalance length rebalances the whole destination", () => {
  // x and y are adjacent long keys: the next key between them is one longer
  // than the threshold.
  const x = "a0" + "V".repeat(REBALANCE_KEY_LENGTH - 2);
  const s = stateOf(
    entry("p"),
    entry("w", "p", { position: "Zz" }),
    entry("x", "p", { position: x }),
    entry("y", "p", { position: x + "V" }),
    entry("z", "p", { position: "a1" }),
    entry("m", null, { position: "a1" }),
  );
  assert.deepEqual(checkInvariants(s), []);
  const result = planMove(s, "m", { parent_id: "p" }, { after: "x" });
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result.entries).sort(), ["m", "w", "x", "y", "z"]);
  const after = applyWrite(s, result);
  assert.deepEqual(ordered(after, "p"), ["w", "x", "m", "y", "z"]);
  for (const id of ["w", "x", "m", "y", "z"])
    assert.ok(after.entries.get(id).position.length <= 3, id);
  // Only positions changed, so the projection is the moved Page alone.
  assert.deepEqual(result.projection, [{ page_id: "m", space_id: null }]);
  for (const id of ["w", "x", "y", "z"])
    assert.deepEqual(
      { ...after.entries.get(id), position: undefined },
      { ...s.entries.get(id), position: undefined },
    );
  assert.deepEqual(checkInvariants(after), []);
});

test("repeated inserts at one spot never grow a key past the threshold", () => {
  // Each new Page goes right after x, so each key splits the gap between x
  // and the previous insert. Without rebalancing the keys would pass
  // MAX_KEY_LENGTH after about 3,000 inserts.
  let s = stateOf(
    entry("p"),
    entry("x", "p", { position: "a0" }),
    entry("y", "p", { position: "a1" }),
  );
  const order = ["x", "y"];
  let rebalances = 0;
  let longest = 0;
  for (let i = 0; i < 1800; i++) {
    const id = `m${i}`;
    s = applyWrite(s, {
      revision: s.revision,
      entries: { [id]: entry(id, null, { position: "a5" }) },
    });
    const result = planMove(s, id, { parent_id: "p" }, { after: "x" });
    assert.equal(result.ok, true, `insert ${i}`);
    const rekeyed = Object.keys(result.entries).filter((key) => key !== id);
    if (rekeyed.length) {
      rebalances++;
      // A rebalance writes every sibling whose key changed, in this one write.
      assert.ok(rekeyed.length >= order.length - 1, `insert ${i}: ${rekeyed.length} rekeyed`);
      assert.deepEqual(result.projection, [{ page_id: id, space_id: null }]);
    }
    s = applyWrite(s, result);
    order.splice(1, 0, id);
    for (const [key, value] of Object.entries(result.entries)) {
      assert.equal(validPositionKey(value.position), true, `insert ${i}: ${key}`);
      longest = Math.max(longest, value.position.length);
    }
    if (i % 100 === 99 || rekeyed.length)
      assert.deepEqual(ordered(s, "p"), order, `insert ${i}: order`);
  }
  assert.ok(rebalances >= 1, "the threshold was reached");
  assert.ok(longest <= REBALANCE_KEY_LENGTH, `longest key ${longest}`);
  assert.deepEqual(ordered(s, "p"), order);
  assert.deepEqual(checkInvariants(s), []);
});

test("positionAmong reports bad shapes and unknown siblings", () => {
  const siblings = [entry("a", "p", { position: "a0" }), entry("b", "p", { position: "a1" })];
  assert.deepEqual(positionAmong(siblings, "middle"), { ok: false, code: "invalid_position" });
  assert.deepEqual(positionAmong(siblings, { before: "c" }), {
    ok: false,
    code: "position_sibling_unknown",
  });
  const first = positionAmong(siblings, "first");
  assert.ok(first.position < "a0");
  const between = positionAmong(siblings, { after: "a" });
  assert.ok(between.position > "a0" && between.position < "a1");
  assert.ok(positionAmong([], "last").position);
});

test("checkInvariants finds each kind of violation", () => {
  const codes = (state, options) => checkInvariants(state, options).map((v) => v.code);
  assert.deepEqual(codes(world()), []);
  assert.deepEqual(codes(stateOf(entry("a", "p", { space_id: PRJ }))), ["invalid_entry"]);
  assert.deepEqual(codes(stateOf(entry("a", "ghost"))), ["missing_parent"]);
  assert.deepEqual(codes(stateOf(entry("p", null, { state: "pending" }), entry("a", "p"))), [
    "inactive_parent",
  ]);
  assert.deepEqual(codes(stateOf(entry("p", null, { state: "trashed" }), entry("a", "p"))), [
    "inactive_parent",
  ]);
  assert.deepEqual(codes(stateOf(entry("p"), entry("t", "p", { state: "trashed" }))), [
    "trashed_parent_active",
  ]);
  assert.deepEqual(
    codes(stateOf(entry("p", null, { state: "trashed" }), entry("t", "p", { state: "trashed" }))),
    [],
    "a trashed subtree can keep its shape",
  );
  assert.deepEqual(codes(stateOf(entry("a", "b"), entry("b", "a"))), [
    "placement_cycle",
    "placement_cycle",
  ]);
  assert.deepEqual(
    codes(
      stateOf(
        entry("h1", null, { space_id: PRJ }),
        entry("h2", null, { space_id: PRJ, position: "a1" }),
      ),
    ),
    ["duplicate_home"],
  );
  assert.deepEqual(
    checkInvariants(
      stateOf(entry("p"), entry("x", "p"), entry("y", "p"), entry("q", null, { position: "a1" })),
    ),
    [{ code: "duplicate_position", page_id: "y", detail: "a0" }],
  );
  assert.deepEqual(
    codes(
      stateOf(entry("p"), entry("x", "p"), entry("t", null, { state: "trashed", position: "a0" })),
    ),
    [],
    "the trashed t shares the root key a0 with p, but Trash isn't a sibling",
  );
  assert.deepEqual(
    codes(
      stateOf(
        entry("h1", null, { space_id: PRJ }),
        entry("h2", null, { space_id: PRJ, state: "trashed" }),
      ),
    ),
    [],
    "a trashed home doesn't count",
  );
  const projects = { [PRJ]: "launch", [OTHER]: "archive" };
  assert.deepEqual(codes(world(), { projects }), []);
  assert.deepEqual(codes(world(), { projects: { [PRJ]: "launch" } }), ["project_home_mismatch"]);
  assert.deepEqual(codes(world(), { projects: { ...projects, [PRJ]: "plan" } }), [
    "project_home_mismatch",
  ]);
  assert.deepEqual(
    codes(world(), { projects: new Map([...Object.entries(projects), ["prj_x", "x"]]) }),
    ["project_home_mismatch"],
  );
});

/** Small deterministic PRNG so a failing seed replays. */
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A valid random Catalog: a few Projects, Pages under random live parents
 * within MAX_DEPTH, some pending leaves and some trashed roots. */
function randomCatalog(next, size) {
  const pick = (list) => list[Math.floor(next() * list.length)];
  const entries = new Map();
  const depth = new Map();
  const projects = Math.floor(next() * 4);
  for (let i = 0; i < projects; i++) {
    const id = `h${i}`;
    entries.set(id, entry(id, null, { space_id: `prj_${i}`, position: `a${i}` }));
    depth.set(id, 1);
  }
  for (let i = 0; i < size; i++) {
    const id = `p${i}`;
    const parents = [...entries.values()].filter(
      (e) => e.state === "active" && depth.get(e.page_id) < MAX_DEPTH,
    );
    const parent = next() < 0.25 || !parents.length ? null : pick(parents).page_id;
    const roll = next();
    const state = roll < 0.1 ? "pending" : roll < 0.15 && parent === null ? "trashed" : "active";
    entries.set(
      id,
      entry(id, parent, {
        state,
        position: `a${Math.floor(next() * 6)}`,
        ...(state === "trashed" && { restore_parent_id: null }),
      }),
    );
    depth.set(id, parent ? depth.get(parent) + 1 : 1);
  }
  return { revision: 0, entries };
}

test("property: random moves on random trees keep every invariant", () => {
  const iterations = Number(process.env.LOCATION_PROPERTY_RUNS || 300);
  let applied = 0;
  let refused = 0;
  let tied = 0;
  for (let seed = 1; seed <= iterations; seed++) {
    const next = random(seed);
    let state = randomCatalog(next, 5 + Math.floor(next() * 30));
    // Random keys tie often; ties are the only violation the generator makes.
    const structural = (current) =>
      checkInvariants(current).filter((violation) => violation.code !== "duplicate_position");
    const duplicates = (current) =>
      checkInvariants(current).filter((violation) => violation.code === "duplicate_position")
        .length;
    assert.deepEqual(structural(state), [], `seed ${seed}: generator`);
    if (duplicates(state)) tied++;
    // Every parent a move has landed in (null for roots). Each must keep
    // distinct keys from then on, whatever later moves do.
    const destinations = new Set();
    const distinct = (current, parentId) => {
      const keys = siblingsOf(current.entries, parentId).map((e) => e.position);
      return new Set(keys).size === keys.length;
    };
    const ids = [...state.entries.keys()];
    const spaces = [...state.entries.values()].filter((e) => e.space_id).map((e) => e.space_id);
    const pick = (list) => list[Math.floor(next() * list.length)];
    for (let step = 0; step < 25; step++) {
      const pageId = next() < 0.05 ? "missing" : pick(ids);
      const kind = next();
      const destination =
        kind < 0.2
          ? { project_id: null }
          : kind < 0.4 && spaces.length
            ? { project_id: pick(spaces) }
            : kind < 0.45
              ? {}
              : kind < 0.5
                ? { project_id: pick([...spaces, null]), parent_id: pick(ids) }
                : { parent_id: pick(ids) };
      const siblings = ids.filter((id) => id !== pageId);
      const position = pick([
        "first",
        "last",
        undefined,
        { before: pick(siblings) },
        { after: pick(siblings) },
      ]);
      const before = state;
      const result = planMove(state, pageId, destination, position);
      const where = `seed ${seed} step ${step}: ${pageId} → ${JSON.stringify(destination)} ${JSON.stringify(position)}`;
      if (!result.ok) {
        assert.ok(MOVE_REFUSALS.includes(result.code), `${where}: ${result.code}`);
        refused++;
        continue;
      }
      applied++;
      state = applyWrite(state, result);
      assert.equal(state.revision, before.revision + 1, where);
      assert.deepEqual(structural(state), [], where);
      assert.ok(duplicates(state) <= duplicates(before), `${where}: no new ties`);
      destinations.add(result.moved.parent_id);
      for (const parentId of destinations)
        assert.ok(distinct(state, parentId), `${where}: ties left under ${parentId}`);
      // Only the moved Page changes its parent; descendants keep theirs.
      for (const [id, previous] of before.entries) {
        const now = state.entries.get(id);
        if (id !== pageId) {
          assert.equal(now.parent_id, previous.parent_id, `${where}: ${id} parent`);
          assert.equal(now.state, previous.state, `${where}: ${id} state`);
          // Only destination siblings get new keys, and only to repair ties.
          if (now.position !== previous.position)
            assert.equal(now.parent_id, result.moved.parent_id, `${where}: ${id} rekeyed`);
        }
      }
      const location = deriveLocation(state.entries, pageId);
      assert.equal(location.ok, true, where);
      assert.equal(location.space_id, result.moved.space_id, where);
      assert.equal(state.entries.get(pageId).parent_id, result.moved.parent_id, where);
      // The projection names every Page in the subtree with its new Project.
      assert.deepEqual(result.projection, subtreeSpaceIds(state.entries, pageId), where);
      for (const { page_id, space_id } of result.projection)
        assert.equal(deriveLocation(state.entries, page_id).space_id, space_id, where);
      // Siblings at the destination have strictly increasing keys around it.
      const order = ordered(state, result.moved.parent_id);
      const at = order.indexOf(pageId);
      const key = (i) => state.entries.get(order[i])?.position;
      if (at > 0) assert.ok(key(at - 1) < key(at), `${where}: left key`);
      if (at < order.length - 1) assert.ok(key(at) < key(at + 1), `${where}: right key`);
      if (position && typeof position === "object") {
        const anchor = order.indexOf(position.before ?? position.after);
        assert.equal(at, position.before ? anchor - 1 : anchor + 1, `${where}: relative position`);
      }
      if (position === "first") assert.equal(at, 0, where);
      if (position === "last" || position === undefined) assert.equal(at, order.length - 1, where);
    }
  }
  // Both outcomes are exercised often.
  assert.ok(applied > iterations * 5, `applied ${applied}`);
  assert.ok(refused > iterations * 2, `refused ${refused}`);
  assert.ok(tied > iterations / 2, `only ${tied} Catalogs started with ties`);
});
