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

test("an HTML-looking title is returned verbatim as text", () => {
  assert.equal(
    mermaidTitle("---\ntitle: <img src=x onerror=alert(1)>\n---\ngraph TD"),
    "<img src=x onerror=alert(1)>",
  );
});
