import test from "node:test";
import assert from "node:assert/strict";
import { mermaidTitle } from "./mermaid-title.mjs";

test("frontmatter title names any diagram type", () => {
  assert.equal(
    mermaidTitle("---\ntitle: Checkout flow\n---\nflowchart LR\nA --> B"),
    "Checkout flow",
  );
  assert.equal(
    mermaidTitle(
      '\n---\nconfig:\n  theme: dark\ntitle: "Quoted: yes"\n---\nsequenceDiagram\nA->>B: hi',
    ),
    "Quoted: yes",
  );
  assert.equal(mermaidTitle("---\r\ntitle: 'It''s' # note\r\n---\r\ngraph TD"), "It's");
  assert.equal(mermaidTitle("---\ntitle: Plain # comment\n---\ngraph TD"), "Plain");
});

test("a leading title statement names diagram types that support one", () => {
  assert.equal(mermaidTitle('pie title Pets adopted\n"Dogs": 386\n"Cats": 85'), "Pets adopted");
  assert.equal(mermaidTitle('pie showData title Key elements\n"A": 1'), "Key elements");
  assert.equal(
    mermaidTitle("%%{init: {}}%%\ngantt\n  %% plan\n  title Release plan\n  dateFormat YYYY-MM-DD"),
    "Release plan",
  );
  assert.equal(
    mermaidTitle('xychart-beta\n  title "Sales Revenue"\n  x-axis [a, b]'),
    "Sales Revenue",
  );
  // Frontmatter wins; a body statement still applies when frontmatter has no title.
  assert.equal(mermaidTitle("---\ntitle: Front\n---\npie title Body\n"), "Front");
  assert.equal(mermaidTitle("---\nconfig: {}\n---\npie title Body\n"), "Body");
});

test("diagrams without a title, or with a title that isn't leading, have none", () => {
  for (const source of [
    "",
    "   \n",
    "flowchart LR\nA --> B",
    // Flowcharts have no title statement; a node called `title` isn't one.
    "flowchart LR\ntitle --> B",
    "gantt\n  dateFormat YYYY-MM-DD\n  title Late title",
    "pie\n",
    "---\nconfig:\n  title: nested\n---\nflowchart LR\nA --> B",
    "---\ntitle:\n---\ngraph TD",
    "---\ntitle: |\n  Block\n---\ngraph TD",
  ])
    assert.equal(mermaidTitle(source), null, JSON.stringify(source));
});

test("frontmatter without a closing fence has no title", () => {
  assert.equal(mermaidTitle("---\ntitle: Unclosed\nflowchart LR\nA --> B"), null);
  assert.equal(mermaidTitle("---\ntitle: Unclosed\npie title Pets"), null);
});

// Extraction runs synchronously while the editor renders. Hostile source must
// not stall it through regex backtracking on long whitespace runs. Each case is
// a source and its expected title, built around the whitespace `run`.
function longRuns(run) {
  return [
    [`---\ntitle: A${run}B\n---\ngraph TD`, `A${run}B`],
    [`---\ntitle: A${run}# note\n---\ngraph TD`, "A"],
    [`---\ntitle: "A"${run}B\n---\ngraph TD`, `"A"${run}B`],
    [`---\ntitle: 'A'${run}B\n---\ngraph TD`, `'A'${run}B`],
    [`---\ntitle${run}x\n---\ngraph TD`, null],
    [`---${run}x\ntitle: A\n---\ngraph TD`, null],
    [`pie${run}x\n"A": 1`, null],
    [`pie showData${run}x\n"A": 1`, null],
    [`gantt\ntitle${run}x${run}B`, `x${run}B`],
    // U+2028 and U+2029 survive the line split, so each parser path must
    // treat them as ordinary characters rather than line ends.
    [`gantt\ntitle${run}X\u2028Y`, "X\u2028Y"],
    [`gantt\ntitle${run}X\u2029Y`, "X\u2029Y"],
    [`pie title${run}X\u2028Y\n"A": 1`, "X\u2028Y"],
    [`pie showData${run}title${run}X\u2029Y\n"A": 1`, "X\u2029Y"],
    [`pie${run}\u2028title X\n"A": 1`, null],
    [`pie\u2028${run}title X\n"A": 1`, null],
    [`---\ntitle: A${run}\u2028B\n---\ngraph TD`, `A${run}\u2028B`],
    [`---\ntitle: A${run}\u2029# note\n---\ngraph TD`, `A${run}\u2029# note`],
    [`---\ntitle: "A"${run}\u2028B\n---\ngraph TD`, `"A"${run}\u2028B`],
    [`---\ntitle${run}\u2028: A\n---\ngraph TD`, null],
    [`---${run}\u2028\ntitle: A\n---\ngraph TD`, "A"],
  ];
}

test("long whitespace runs extract the expected title", () => {
  for (const [source, expected] of longRuns(" ".repeat(100_000)))
    assert.equal(mermaidTitle(source), expected);
});

// The fastest of several batches of calls. Load only adds time to a batch, so
// the minimum is the closest to the parser's own cost.
function fastest(source, batches = 7, calls = 4) {
  let best = Infinity;
  for (let batch = 0; batch < batches; batch++) {
    const started = performance.now();
    for (let call = 0; call < calls; call++) mermaidTitle(source);
    best = Math.min(best, performance.now() - started);
  }
  return best;
}

// Linear time stated as scaling, not as a wall-clock bound: 16 times the run
// costs about 16 times as much when extraction is linear and about 256 times
// when it is quadratic. The bound of 64 leaves a factor of 4 either way.
test("long whitespace runs extract in linear time", () => {
  const small = longRuns(" ".repeat(4_000));
  const large = longRuns(" ".repeat(4_000 * 16));
  for (const [index, [source]] of small.entries()) {
    const ratio = fastest(large[index][0]) / fastest(source);
    assert.ok(ratio < 64, `${ratio.toFixed(1)}x for ${JSON.stringify(source.slice(0, 16))}`);
  }
});

test("a quoted frontmatter title keeps escapes and allows a trailing comment", () => {
  assert.equal(mermaidTitle('---\ntitle: "Say \\"hi\\"" # c\n---\ngraph TD'), 'Say "hi"');
  assert.equal(mermaidTitle('---\ntitle: "unterminated # c\n---\ngraph TD'), '"unterminated');
  assert.equal(mermaidTitle("---\ntitle: A#B\n---\ngraph TD"), "A#B");
});

test("an HTML-looking title is returned verbatim as text", () => {
  assert.equal(
    mermaidTitle("---\ntitle: <img src=x onerror=alert(1)>\n---\ngraph TD"),
    "<img src=x onerror=alert(1)>",
  );
});
