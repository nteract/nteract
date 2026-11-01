import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import {
  enableRich,
  exportMarkdown,
  parseAgentMarkdown,
  parseMarkdown,
  richDoc,
  unsupportedMarkdown,
} from "./richtext.mjs";

const nodeNames = (doc) => {
  const names = [];
  doc.descendants((node) => {
    names.push(node.type.name);
  });
  return names;
};
// Process CPU time, best of three. Wall time also counts waiting for a core
// while parallel test files and other work share the machine. A quadratic
// scan spends seconds of CPU on every run.
const cpuMs = () => {
  const { user, system } = process.cpuUsage();
  return (user + system) / 1000;
};
const elapsed = (run) => {
  let best = Infinity;
  for (let i = 0; i < 3; i++) {
    const start = cpuMs();
    run();
    best = Math.min(best, cpuMs() - start);
  }
  return best;
};

// Page Markdown is bounded only by the record size. Each input is a worst case
// for a scan that rescans a run. A quadratic step takes tens of seconds here.
const RUN = 200_000;
const mixedBreaks = Array.from({ length: RUN / 2 }, (_, i) => ["\r", "\n", "\r\n", "\n\r"][i % 4])
  .join("")
  .slice(0, RUN);
const runs = {
  "CR run": "\r".repeat(RUN),
  "LF run": "\n".repeat(RUN),
  "CRLF run": "\r\n".repeat(RUN / 2),
  "mixed line-break run": mixedBreaks,
  "CR run before a task": `${"\r".repeat(RUN)}- [ ] task`,
  "quote-marker run": `${"> ".repeat(RUN / 2)}x`,
  "space run after a bullet": `-${" ".repeat(RUN)}x`,
  "space run after a thematic break": `---${" ".repeat(RUN)}x`,
  "open-bracket run": `${"[".repeat(RUN)}~~`,
  "open-bracket line run": `${"\n[".repeat(RUN / 2)}~~`,
  "space run inside a table break": `| a |\n| --- |\n| <br${" ".repeat(RUN)}x |`,
  "backtick run": "`".repeat(RUN),
  "backtick runs of growing length": Array.from({ length: 600 }, (_, i) => "`".repeat(i + 1))
    .join(" ")
    .slice(0, RUN),
  "unclosed tag run": "<a ".repeat(RUN / 3),
  "open-angle run": "<".repeat(RUN),
  "comment opener run": `${"<!--".repeat(RUN / 4)}-->`,
  "instruction opener run": `${"<?".repeat(RUN / 2)}?>`,
  "highlight opener run": `${'<mark data-color="'.repeat(RUN / 18)}>`,
  "display math opener run": "$$\n".repeat(RUN / 3),
  "dollar run": "$".repeat(RUN),
  "backslash run": "\\".repeat(RUN),
  "strike delimiter run": "~~".repeat(RUN / 2),
  "link destination run": "](".repeat(RUN / 2),
  "nested destination run": "[a](b(".repeat(RUN / 6),
  "unclosed title run": '](x "'.repeat(RUN / 5),
  "unbalanced definition run": `${"]:x".repeat(RUN / 3)}(`,
  "unclosed quoted attribute run": '<a b="'.repeat(RUN / 6),
  "nested quoted tag run": '<a b="<a b="'.repeat(RUN / 12),
  "long open tag run": `<a ${"b ".repeat(RUN / 2)}`,
  "unclosed declaration run": "<!x".repeat(RUN / 3),
  "unclosed CDATA run": "<![CDATA[".repeat(RUN / 9),
  "table cell backtick run": `| a |\n| - |\n${"| ` ".repeat(RUN / 4)}`,
  "wrapped image run": "[![a](b)](c)".repeat(RUN / 12),
  "unused definition run": "[a]: b\n".repeat(RUN / 7),
};

// The scan is ours and must stay well under the parser. The parse includes
// Markdown-it's own work, whose floor on these inputs is tens of milliseconds;
// a quadratic step still costs seconds.
for (const [name, source] of Object.entries(runs)) {
  test(`Markdown import is linear on input: ${name}`, () => {
    parseMarkdown(source.slice(0, 1000));
    const scan = elapsed(() => unsupportedMarkdown(source));
    assert.ok(scan < 150, `${name}: scan ${scan.toFixed(1)} ms`);
    const parse = elapsed(() => exportMarkdown(parseMarkdown(source)));
    assert.ok(parse < 1500, `${name}: import and export ${parse.toFixed(1)} ms`);
  });
}

test("code spans and fenced or indented code never count as math or HTML", () => {
  for (const source of [
    "Keep `~~x~~` as code.",
    "Run `$x + 1$` literally.",
    "A `<div>` tag in a code span.",
    "``a ` <b> ` b``",
    "```\n$$\n<div>\n$x$\n```",
    "~~~\n<section>\n~~~",
    "    <div>indented</div>\n    $x$",
    "> ```\n> <b>\n> ```",
    "- item\n\n  ```\n  $$x$$\n  ```",
    "| A | B |\n| --- | --- |\n| `$x$` | `<b>` |",
    "Escaped \\$x\\$ and \\<b> stay text.",
    "<mark>highlight</mark> and <mark data-color='pink'>pink</mark>",
    "| a<br>b |\n| --- |\n| c |",
    "$30 and $25",
  ]) {
    assert.equal(unsupportedMarkdown(source), null, JSON.stringify(source));
    assert.ok(!nodeNames(parseAgentMarkdown(source)).includes("raw"));
  }
});

test("a code span can't cross a table cell boundary", () => {
  // Markdown-it splits cells before reading them, so these backticks open no
  // span and the dollars are math.
  assert.deepEqual(unsupportedMarkdown("| a | b |\n| - | - |\n| `$x | y$` |"), {
    construct: "math",
    line: 3,
    column: 4,
    excerpt: "$x | y$",
  });
  assert.equal(unsupportedMarkdown("| a | b |\n| - | - |\n| `<i> | </i>` |")?.construct, "html");
  // Inside one cell they are code.
  assert.equal(unsupportedMarkdown("| a |\n| - |\n| `$x$ <i>` |"), null);
});

test("HTML tags are recognized whatever their length, with > inside quoted values", () => {
  const long = `<a title="${"x".repeat(5000)}">`;
  for (const [source, excerpt] of [
    [`${long}t</a>`, long.slice(0, 80)],
    ['<a href="x>y">t</a>', '<a href="x>y">'],
    ["<a b='>'>", "<a b='>'>"],
    ["<!-- a > b -->", "<!-- a > b -->"],
    ["<?php x > y ?>", "<?php x > y ?>"],
    ["<![CDATA[ x > y ]]>", "<![CDATA[ x > y ]]>"],
    ['<a\nb="c">', "<a"],
  ]) {
    const found = unsupportedMarkdown(source);
    assert.equal(found?.construct, "html", source.slice(0, 40));
    assert.equal(found.excerpt, excerpt, source.slice(0, 40));
    const doc = parseMarkdown(source);
    assert.ok(parseAgentMarkdown(exportMarkdown(doc)).eq(doc), source.slice(0, 40));
  }
  // Not tags: a tag's spaces are ASCII, and an attribute needs a space first.
  for (const source of ["x < y > z", "<a b='x'c>", "<mark\u00a0>x</mark>"])
    assert.equal(unsupportedMarkdown(source), null, source);
});

test("Markdown that would parse to less than it says is refused or kept literal", () => {
  for (const [source, construct, line, column] of [
    ["[![caption](image.png)](https://example.org)", "wrapped-image", 1, 2],
    ["**![caption](image.png)**", "wrapped-image", 1, 3],
    ["<mark>![c](i.png)</mark>", "wrapped-image", 1, 7],
    ["| A |\n| --- |\n| **![c](i.png)** |", "wrapped-image", 3, 5],
    ["| A |\n| --- |\n| b | c |", "table-cells", 3, 5],
    ["> | A | B |\n> | - | - |\n> | 1 | 2 | 3 |", "table-cells", 3, 11],
    ["Before [](https://example.org)", "empty-link", 1, 8],
    ["Prose.\n\n[unused]: https://example.org", "definition", 3, 1],
    ["[a][r]\n\n[r]: /one\n[r]: /two", "definition", 4, 1],
  ]) {
    const found = unsupportedMarkdown(source);
    assert.deepEqual(
      [found?.construct, found?.line, found?.column],
      [construct, line, column],
      source,
    );
    assert.throws(() => parseAgentMarkdown(source), { code: "unsupported_markdown" });
    // Literal import keeps every character as text.
    const doc = parseMarkdown(source);
    for (const part of source.split("\n"))
      if (part.trim()) assert.ok(doc.textContent.includes(part.trim()), `${source}: ${part}`);
    assert.ok(parseAgentMarkdown(exportMarkdown(doc)).eq(doc), source);
  }
  // Still native: a used definition, a short row padded with empty cells, an
  // escaped pipe, an image beside a link.
  for (const source of [
    "[a][r]\n\n[r]: /x",
    "| A | B |\n| - | - |\n| c |",
    "| A |\n| - |\n| b \\| c |",
    "![c](i.png) [link](https://example.org)",
  ])
    assert.equal(unsupportedMarkdown(source), null, source);
});

test("link destinations and titles are never math or HTML", () => {
  for (const source of [
    "![one\ntwo](<x>)",
    '[a](<x> "<b> $t$")',
    "[r]: <x>\n\n[a][r]",
    "[a](/$x$)",
    "[a](/p?q=<b>)",
  ]) {
    assert.equal(unsupportedMarkdown(source), null, source);
    const doc = parseAgentMarkdown(source);
    assert.ok(parseAgentMarkdown(exportMarkdown(doc)).eq(doc), source);
  }
  // Escaped, the bracket opens no link, so the tag after it is HTML.
  assert.equal(unsupportedMarkdown("x\\](<y>)")?.construct, "html");
  // A long run of unclosed links reads each line once.
  const source = "[a](<b ".repeat(30_000);
  assert.ok(elapsed(() => unsupportedMarkdown(source)) < 150);
});

test("math and HTML outside code are found with their line and column", () => {
  for (const [source, expected] of [
    ["The value is $x + 1$.", { construct: "math", line: 1, column: 14, excerpt: "$x + 1$" }],
    ["Intro\n\n$$\n\\frac{a}{b}\n$$", { construct: "math", line: 3, column: 1, excerpt: "$$" }],
    ["Inline $$x$$ math.", { construct: "math", line: 1, column: 8, excerpt: "$$x$$" }],
    ["`$x$` then $y$", { construct: "math", line: 1, column: 12, excerpt: "$y$" }],
    ["a\r\n<div>b</div>", { construct: "html", line: 2, column: 1, excerpt: "<div>" }],
    ["Inline <b>x</b>", { construct: "html", line: 1, column: 8, excerpt: "<b>" }],
    ["<!-- note -->", { construct: "html", line: 1, column: 1, excerpt: "<!-- note -->" }],
    ["café <br> outside a table", { construct: "html", line: 1, column: 6, excerpt: "<br>" }],
    ['x <mark data-color="nope">y</mark>', { construct: "html", line: 1, column: 3 }],
    ["`<b>` and `$x$` but <i>", { construct: "html", line: 1, column: 21, excerpt: "<i>" }],
    ["🦀 $x$", { construct: "math", line: 1, column: 3, excerpt: "$x$" }],
  ]) {
    const found = unsupportedMarkdown(source);
    assert.ok(found, JSON.stringify(source));
    for (const [key, value] of Object.entries(expected))
      assert.equal(found[key], value, `${JSON.stringify(source)} ${key}`);
  }
});

test("every former preserved-block trigger imports natively", () => {
  for (const [source, names] of [
    ["~~struck~~", ["strike"]],
    ["Before\n\n---\n\nAfter", ["horizontal_rule"]],
    ["Title\n---", ["heading"]],
    ["[Guide][ref]\n\n[ref]: https://example.org", ["link"]],
    ["[Guide][]\n\n[guide]: https://example.org", ["link"]],
    ["[a][b]", []],
    ["~~~\ncode\n~~~", ["code_block"]],
  ]) {
    const doc = parseAgentMarkdown(source);
    const seen = new Set(nodeNames(doc));
    doc.descendants((node) => node.marks.forEach((mark) => seen.add(mark.type.name)));
    assert.ok(!seen.has("raw"), source);
    for (const name of names) assert.ok(seen.has(name), `${JSON.stringify(source)} has ${name}`);
  }
  // A reference to an unsafe destination stays literal text, as does its
  // definition.
  const unsafe = parseAgentMarkdown("[x][r]\n\n[r]: javascript:alert(1)");
  assert.match(unsafe.textContent, /^\[x\]\[r\]/);
  unsafe.descendants((node) => assert.ok(!node.marks.some((mark) => mark.type.name === "link")));
});

test("literal import keeps math and HTML as their exact text", () => {
  for (const [source, text] of [
    ["The value is $x + 1$.", "The value is $x + 1$."],
    ["Escapes $$\\frac{a}{b} \\_ \\{x\\}$$ stay.", "Escapes $$\\frac{a}{b} \\_ \\{x\\}$$ stay."],
    ["<section>Preserve *this*</section>", "<section>Preserve this</section>"],
    ["$x_1 * y_2$ and *z*", "$x_1 * y_2$ and z"],
  ])
    assert.equal(parseMarkdown(source).textContent, text, JSON.stringify(source));
  // Display math keeps its lines as hard breaks in one paragraph.
  const display = parseMarkdown("$$\n\\{x\\}\n$$");
  assert.equal(display.childCount, 1);
  assert.deepEqual(nodeNames(display), [
    "paragraph",
    "text",
    "hard_break",
    "text",
    "hard_break",
    "text",
  ]);
});

// Properties of every import: no preserved block, export that an agent may
// write back, and agreement between the literal and agent parsers wherever
// the agent parser accepts the source.
test("random input never imports a preserved block, and its export is writable", () => {
  // A fixed seed keeps failures reproducible.
  let seed = 0x4594;
  const random = (n) => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return (seed >>> 8) % n;
  };
  const pieces = [
    ..." \t\r\n",
    "\r\n",
    "\n\n",
    "\u2028",
    "\u00a0",
    ...'>-+*_[]:x</|$`\\#~!()"=3&',
    "[ ]",
    "[x]",
    "mark",
    "<mark>",
    "</mark>",
    "<br>",
    "<b>",
    "<!--",
    "-->",
    "<?",
    "?>",
    "---",
    "~~",
    "| --- |",
    "$$",
    "``",
    "```",
    "    ",
    "1.",
    "&amp;",
    "http://x",
    "](",
    "]:",
    "<x>",
    "](<x>",
    "![i](p)",
    "[r]: u",
    "[r]",
    "| a | b |",
    '<a b="',
    "'>",
  ];
  for (let n = 0; n < 10_000; n++) {
    let source = "";
    for (let length = random(14); length >= 0; length--) source += pieces[random(pieces.length)];
    const label = JSON.stringify(source);
    const doc = parseMarkdown(source);
    assert.ok(!nodeNames(doc).includes("raw"), label);
    assert.doesNotThrow(() => parseAgentMarkdown(exportMarkdown(doc)), label);
    if (!unsupportedMarkdown(source)) assert.ok(parseAgentMarkdown(source).eq(doc), label);
  }
});

test("exported literal math and HTML read back as the same text", () => {
  for (const source of [
    "The value is $x + 1$.",
    "$5 and $$x$$",
    "Before\r$$\n\\{x\\}",
    "$<b>! <mark>!$    </mark>~~",
    "<!-- _&amp;$$$$$<[x] |-->_",
    'Inline <b>x</b> and <mark data-color="red">y</mark>',
    "| A | $x$ |\n| --- | --- |\n| <b>q</b> | `$y$` |",
    "> quote with $a$\n> and <i>b</i>",
  ]) {
    const doc = parseMarkdown(source);
    const exported = exportMarkdown(doc);
    assert.equal(unsupportedMarkdown(exported), null, JSON.stringify(exported));
    assert.ok(parseAgentMarkdown(exported).eq(doc), JSON.stringify(exported));
  }
});

test("a table break tag may hold spaces around its slash", () => {
  for (const tag of ["<br>", "<br/>", "<br />", "<BR  / >", "<br\t>"]) {
    const doc = parseMarkdown(`| a${tag}b |\n| --- |\n| c |`);
    assert.ok(nodeNames(doc).includes("hard_break"), tag);
  }
  const doc = parseMarkdown("| a<br / / >b |\n| --- |\n| c |");
  assert.match(doc.textContent, /<br/);
});

test("a table break tag with an attribute stays literal through import and export", () => {
  const source = '| a<br class="x">b |\n| --- |\n| c |';
  const native = A.change(
    A.from({ blocks: { one: { id: "one", kind: "markdown", markdown: source } } }),
    (doc) => enableRich(doc, "one"),
  );
  const imported = richDoc(native.blocks.one);
  assert.ok(nodeNames(imported).includes("table"));
  assert.ok(!nodeNames(imported).includes("hard_break"));
  assert.equal(imported.firstChild.firstChild.firstChild.textContent, 'a<br class="x">b');

  // The exported cell escapes `<`, so a later import reads the same text.
  const exported = exportMarkdown(imported);
  assert.ok(exported.includes('a\\<br class="x">b'), exported);
  const reimported = parseAgentMarkdown(exported);
  assert.ok(!nodeNames(reimported).includes("hard_break"));
  assert.ok(reimported.eq(imported), exported);
});
