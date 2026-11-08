import assert from "node:assert/strict";
import { test } from "node:test";
import { attribution, messageRuns } from "./comment-thread-display.mjs";

test("author disclosure treats hostile-looking labels as text and splits models without changing principal", () => {
  const author = {
    principal: "account",
    displayName: "Owner",
    driver: "Kilo",
    clientAssertions: {
      version: 1,
      name: '<img src=x onerror="alert(1)">',
      model: "model-a",
    },
  };
  const display = attribution(author);
  assert.equal(display.name, author.clientAssertions.name);
  assert.equal(display.clientSupplied, true);
  assert.ok(display.label.includes("client-supplied"));
  assert.ok(display.label.includes("Model: model-a"));
  const other = { ...author, clientAssertions: { ...author.clientAssertions, model: "model-b" } };
  assert.notEqual(attribution(author).key, attribution(other).key);
  assert.equal(
    messageRuns([
      { author, createdAt: "2026-11-08T00:00:00Z" },
      { author: other, createdAt: "2026-11-08T00:00:01Z" },
    ]).length,
    2,
  );
});
