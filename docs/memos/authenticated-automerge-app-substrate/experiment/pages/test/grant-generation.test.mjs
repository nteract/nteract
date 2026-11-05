import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseGrantGeneration,
  projectGrantGeneration,
  compareGrantGenerations,
  replicaGrantGeneration,
} from "../shared/grant-generation.mjs";

const a = "prj_00000000-0000-4000-8000-000000000001";
const b = "sp_00000000-0000-4000-8000-000000000002";
test("grant grammar preserves direct numbers and validates canonical Project counter tuples", () => {
  for (const value of [0, 1, Number.MAX_SAFE_INTEGER]) {
    assert.equal(parseGrantGeneration(value).direct, value);
    assert.equal(replicaGrantGeneration(`${value}:writer`), value);
  }
  for (const id of [a, b]) {
    const token = projectGrantGeneration(id, Number.MAX_SAFE_INTEGER, 0);
    assert.equal(parseGrantGeneration(token).project, id);
    for (const role of ["reader", "commenter", "writer"])
      assert.equal(replicaGrantGeneration(`${token}:${role}`), token);
  }
  for (const value of [
    null,
    {},
    -1,
    0.1,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    "1",
    "",
    `project:${a}:-1:0`,
    `project:${a}:01:0`,
    `project:${a}:1:9007199254740992`,
    `project:${a}:1:1e3`,
    `project:${a}:1:0:extra`,
    "project:prj_invalid:1:0",
  ])
    assert.equal(parseGrantGeneration(value), null, JSON.stringify(value));
  for (const key of ["1:writer:extra", "1:owner", "01:writer", `project:${a}:1:0:admin`])
    assert.equal(replicaGrantGeneration(key), undefined);
});
test("generation order is partial, never lexicographic or across authority sources", () => {
  assert.equal(compareGrantGenerations(10, 2), 1);
  const token = (m, d) => projectGrantGeneration(a, m, d);
  for (const [left, right, order] of [
    [token(1, 1), token(1, 1), 0],
    [token(10, 1), token(2, 1), 1],
    [token(1, 1), token(2, 2), -1],
    [token(2, 1), token(1, 2), null],
    [token(1, 1), projectGrantGeneration(b, 1, 1), null],
    [token(1, 1), 1, null],
    ["bad", 0, null],
  ])
    assert.equal(compareGrantGenerations(left, right), order);
});
