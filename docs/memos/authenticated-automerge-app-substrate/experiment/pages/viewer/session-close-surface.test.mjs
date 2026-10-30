// A session's close can grow while it runs (a late deletion adds its forget),
// so a promise read from it once can settle too early. Only closeSettled()
// waits on it, and no viewer module reads or writes `.closing` on a session.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

// `.closing` on these is a machine field or a rejection reason, not a close.
const ALLOWED = /(?:phase|state|attempt|value|REJECT|snapshot\(\))\??$/;

function violations(source, name = "source") {
  const found = [];
  source.split("\n").forEach((line, index) => {
    for (const match of line.matchAll(/\.closing\b/g))
      if (!ALLOWED.test(line.slice(0, match.index)))
        found.push(`${name}:${index + 1}: ${line.trim()}`);
  });
  return found;
}

test("the scan flags session close reads and writes, not machine fields", () => {
  assert.equal(violations("await session.closing;").length, 1);
  assert.equal(violations("this.closing = done;").length, 1);
  assert.equal(violations("return left?.closing;").length, 1);
  assert.deepEqual(
    violations(
      [
        "this.#closing = done;",
        "if (phase.closing) return;",
        "this.phase$.snapshot().closing",
        "state.attempt.closing.filter(Boolean)",
        "reject(state, REJECT.closing)",
      ].join("\n"),
    ),
    [],
  );
});

test("only closeSettled() reads a session's close", () => {
  const dir = new URL(".", import.meta.url);
  const found = readdirSync(dir)
    .filter((name) => /\.(mjs|jsx)$/.test(name) && !name.endsWith(".test.mjs"))
    .flatMap((name) => violations(readFileSync(new URL(name, dir), "utf8"), name));
  assert.deepEqual(found, []);
});
