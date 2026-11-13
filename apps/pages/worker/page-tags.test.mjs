import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  MAX_EXPRESSION_DEPTH,
  MAX_EXPRESSION_LENGTH,
  MAX_EXPRESSION_TAGS,
  TAG_PATTERN,
  TagError,
  matchesTags,
  normalizeTag,
  parseTagExpression,
  tagPredicate,
  writeTagExpression,
} from "./page-tags.mjs";

const refuses = (input, pattern, position) => {
  assert.throws(
    () => parseTagExpression(input),
    (error) => {
      assert.ok(error instanceof TagError, `${input}: ${error}`);
      assert.match(error.message, pattern, input);
      if (position !== undefined) assert.equal(error.position, position, input);
      return true;
    },
  );
};

test("a tag is normalized to lowercase and checked against the alphabet", () => {
  assert.equal(normalizeTag("Code"), "code");
  assert.equal(normalizeTag("  Session:ses_E2fa191B7ffeNllc  "), "session:ses_e2fa191b7ffenllc");
  assert.equal(normalizeTag("repo:nteract/nteract"), "repo:nteract/nteract");
  assert.equal(normalizeTag("v1.2-rc_3"), "v1.2-rc_3");
  assert.equal(normalizeTag("a".repeat(64)), "a".repeat(64));
  for (const bad of [
    "",
    " ",
    "a".repeat(65),
    "has space",
    "(group)",
    "a+b",
    "a&b",
    "a=b",
    "a#b",
    "a%b",
    "a?b",
    "a,b",
    "a|b",
    "a!b",
    "a*b",
    "a~b",
    "-lead",
    ".lead",
    ":lead",
    "/lead",
    "café",
    "日本",
  ])
    assert.throws(() => normalizeTag(bad), TagError, JSON.stringify(bad));
  for (const word of ["and", "or", "not", "AND", "Or", "NoT"])
    assert.throws(() => normalizeTag(word), /reserved/, word);
  assert.throws(() => normalizeTag(7), /must be a string/);
  assert.throws(() => normalizeTag(null), /must be a string/);
  assert.ok(TAG_PATTERN.test("a"));
});

test("expressions parse to the canonical form that a cursor scope seals", () => {
  const cases = [
    ["hello", "hello"],
    ["  Hello  ", "hello"],
    ["hello AND world", "hello AND world"],
    ["hello   AND\tworld", "hello AND world"],
    ["hello OR world", "hello OR world"],
    ["a AND b AND c", "a AND b AND c"],
    ["hello AND NOT world", "hello AND NOT world"],
    ["NOT done", "NOT done"],
    ["NOT NOT x", "NOT NOT x"],
    ["(hello OR world) AND foo", "(hello OR world) AND foo"],
    ["(hello OR world)AND(foo)", "(hello OR world) AND foo"],
    ["((a))", "a"],
    ["NOT (a OR b)", "NOT (a OR b)"],
    ["(a AND b) OR c", "(a AND b) OR c"],
    ["a AND (b OR c)", "a AND (b OR c)"],
    ["(a AND b) AND c", "(a AND b) AND c"],
    [
      "(repo:nteract OR repo:kilo) AND (status:reviewing OR status:blocked)",
      "(repo:nteract OR repo:kilo) AND (status:reviewing OR status:blocked)",
    ],
    ["session:ses_E2FA AND role:scratch", "session:ses_e2fa AND role:scratch"],
  ];
  for (const [input, canonical] of cases) {
    const parsed = parseTagExpression(input);
    assert.equal(parsed.canonical, canonical, input);
    // The canonical form parses back to itself.
    assert.equal(parseTagExpression(parsed.canonical).canonical, canonical, input);
    assert.deepEqual(parseTagExpression(parsed.canonical).ast, parsed.ast, input);
  }
  assert.deepEqual(parseTagExpression("a AND b AND NOT (a OR c)").tags, ["a", "b", "c"]);
  assert.deepEqual(parseTagExpression("(a OR b) AND c").ast, {
    type: "and",
    operands: [
      {
        type: "or",
        operands: [
          { type: "tag", tag: "a" },
          { type: "tag", tag: "b" },
        ],
      },
      { type: "tag", tag: "c" },
    ],
  });
  assert.equal(writeTagExpression(parseTagExpression("NOT a").ast), "NOT a");
});

test("AND and OR never mix at one level", () => {
  refuses("a AND b OR c", /can't mix at one level.*parentheses/, 8);
  refuses("a OR b AND c", /can't mix/, 7);
  refuses("a AND b AND c OR d", /can't mix/, 14);
  refuses("a AND NOT b OR c", /can't mix/, 12);
  for (const fine of ["(a AND b) OR c", "a AND (b OR c)", "NOT (a AND b) OR c"])
    assert.doesNotThrow(() => parseTagExpression(fine), fine);
});

test("a malformed expression is refused with the position of the problem", () => {
  refuses("", /empty/);
  refuses("   ", /empty/);
  refuses("a AND", /ended/, 5);
  refuses("AND a", /found AND/, 0);
  refuses("a AND AND b", /found AND/, 6);
  refuses("a OR", /ended/, 4);
  refuses("a b", /Expected AND, OR or the end but found b/, 2);
  refuses("a NOT b", /found NOT/, 2);
  refuses("NOT", /ended/, 3);
  refuses("NOT AND a", /found AND/, 4);
  refuses("(a", /Expected \)/, 2);
  refuses("a)", /Unexpected \)/, 1);
  refuses(")", /Unexpected \)/, 0);
  refuses("()", /Unexpected \)/, 1);
  refuses("(a AND b", /Expected \)/, 8);
  refuses("a AND (b OR c))", /Unexpected \)/, 14);
  refuses("a AND has+space", /1 to 64 characters/, 6);
  refuses("a AND b,c", /1 to 64 characters/, 6);
  refuses("a AND Ünï", /1 to 64 characters/, 6);
  refuses("a AND and", /reserved/, 6);
  refuses("a AND And", /reserved/, 6);
  refuses("a AND not", /reserved/, 6);
  refuses("a AND or", /reserved/, 6);
  refuses(7, /must be a string/);
  refuses(undefined, /must be a string/);
});

test("an expression is bounded in length, tags and nesting", () => {
  assert.doesNotThrow(() =>
    parseTagExpression(
      Array.from({ length: MAX_EXPRESSION_TAGS }, (_, index) => `t${index}`).join(" OR "),
    ),
  );
  refuses(
    Array.from({ length: MAX_EXPRESSION_TAGS + 1 }, (_, index) => `t${index}`).join(" OR "),
    /at most 16 tags/,
  );
  refuses("a".repeat(MAX_EXPRESSION_LENGTH + 1), /at most 256 characters/);
  assert.doesNotThrow(() => parseTagExpression("a".repeat(64)));
  // The same tag repeated counts each reference.
  refuses(
    Array(MAX_EXPRESSION_TAGS + 1)
      .fill("a")
      .join(" AND "),
    /at most 16 tags/,
  );
  const nested = (depth) => "(".repeat(depth) + "a" + ")".repeat(depth);
  assert.doesNotThrow(() => parseTagExpression(nested(MAX_EXPRESSION_DEPTH)));
  refuses(nested(MAX_EXPRESSION_DEPTH + 1), /nest at most 4 levels/);
  refuses("NOT NOT NOT NOT NOT a", /nest at most 4 levels/);
  assert.doesNotThrow(() => parseTagExpression("NOT NOT NOT NOT a"));
});

test("an accepted expression's canonical spelling is accepted too, at the length bound", () => {
  // Groups sent without spaces gain spaces when written canonically.
  const groups = (count) =>
    Array.from(
      { length: count },
      (_, i) => `(${String(i).padStart(11, "t")} OR ${String(i + 100).padStart(11, "u")})`,
    ).join("AND");
  for (let count = 1; count <= 7; count++) {
    const parsed = parseTagExpression(groups(count));
    assert.ok(parsed.canonical.length <= MAX_EXPRESSION_LENGTH, `${count} groups`);
    assert.equal(parseTagExpression(parsed.canonical).canonical, parsed.canonical);
  }
  const crowded = groups(8);
  assert.ok(crowded.length <= MAX_EXPRESSION_LENGTH, "it fits as written");
  refuses(crowded, /at most 256 characters once written canonically \(259/);
  // Spaced as the echo would be, it is over the bound as written.
  refuses(crowded.replaceAll("AND", " AND "), /at most 256 characters$/);
  // A canonical spelling of exactly the bound is accepted.
  const exact = parseTagExpression(
    `${"a".repeat(64)} OR ${"b".repeat(64)} OR ${"c".repeat(64)} OR ${"d".repeat(52)}`,
  );
  assert.equal(exact.canonical.length, MAX_EXPRESSION_LENGTH);
  assert.equal(parseTagExpression(exact.canonical).canonical, exact.canonical);
});

test("matching evaluates the expression over a set of tags", () => {
  const has = (expression, ...tags) =>
    matchesTags(parseTagExpression(expression).ast, new Set(tags));
  assert.equal(has("hello", "hello"), true);
  assert.equal(has("hello", "world"), false);
  assert.equal(has("hello AND world", "hello", "world"), true);
  assert.equal(has("hello AND world", "hello"), false);
  assert.equal(has("hello OR world", "world"), true);
  assert.equal(has("hello OR world", "other"), false);
  assert.equal(has("hello AND NOT world", "hello"), true);
  assert.equal(has("hello AND NOT world", "hello", "world"), false);
  assert.equal(has("NOT done"), true);
  assert.equal(has("NOT done", "done"), false);
  assert.equal(has("(a OR b) AND c", "b", "c"), true);
  assert.equal(has("(a OR b) AND c", "b"), false);
  assert.equal(has("a AND NOT a", "a"), false);
  assert.equal(has("a AND NOT a"), false);
});

/** Pages p1..p8 over tags a, b, c, with every combination of the three. */
function tagDatabase() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE pages_catalog_pages (page_id TEXT PRIMARY KEY);
    CREATE TABLE page_tags (
      page_id TEXT NOT NULL, tag TEXT NOT NULL, PRIMARY KEY (page_id, tag)
    ) WITHOUT ROWID;
  `);
  const names = ["a", "b", "c"];
  const pages = new Map();
  for (let mask = 0; mask < 8; mask++) {
    const pageId = `p${mask}`;
    const tags = names.filter((_, bit) => mask & (1 << bit));
    pages.set(pageId, new Set(tags));
    db.prepare("INSERT INTO pages_catalog_pages VALUES (?)").run(pageId);
    for (const tag of tags) db.prepare("INSERT INTO page_tags VALUES (?, ?)").run(pageId, tag);
  }
  return { db, pages };
}

test("the SQL predicate agrees with the evaluator on every combination of tags", () => {
  const { db, pages } = tagDatabase();
  const expressions = [
    "a",
    "NOT a",
    "a AND b",
    "a OR b",
    "a AND NOT b",
    "(a OR b) AND c",
    "(a AND b) OR c",
    "NOT (a OR b)",
    "NOT (a AND b)",
    "(a OR b) AND (b OR c)",
    "(a OR b) AND NOT (b AND c)",
    "a AND b AND c",
    "a OR b OR c",
    "a AND NOT a",
    "z",
    "NOT z",
    "(a OR z) AND NOT (b OR z)",
    "NOT NOT a",
    "(a AND b) AND (b AND c)",
  ];
  for (const expression of expressions) {
    const { ast } = parseTagExpression(expression);
    const { sql, params } = tagPredicate(ast, "p.page_id");
    const rows = db
      .prepare(`SELECT p.page_id FROM pages_catalog_pages p WHERE ${sql} ORDER BY p.page_id`)
      .all(...params)
      .map((row) => row.page_id);
    const want = [...pages]
      .filter(([, tags]) => matchesTags(ast, tags))
      .map(([pageId]) => pageId)
      .sort();
    assert.deepEqual(rows, want, expression);
    // One bound parameter per tag reference, in the order the SQL reads them.
    assert.equal(sql.split("?").length - 1, params.length, expression);
    assert.ok(!sql.includes("z") || params.includes("z"), `no tag is interpolated: ${expression}`);
  }
});

test("a tag name never reaches the SQL text", () => {
  const { sql, params } = tagPredicate(parseTagExpression("repo:a/b AND NOT x.y").ast, "a.page_id");
  assert.ok(!/repo|x\.y/.test(sql), sql);
  assert.deepEqual(params, ["repo:a/b", "x.y"]);
});
