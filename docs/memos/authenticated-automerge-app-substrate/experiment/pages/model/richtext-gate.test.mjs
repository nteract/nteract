import test from "node:test";
import assert from "node:assert/strict";
import { parseMarkdown } from "./richtext.mjs";

const opaque = (source) => {
  const doc = parseMarkdown(source);
  return doc.childCount === 1 && doc.firstChild.type.name === "raw";
};
// Best of three, so a GC pause or a busy parallel test runner doesn't decide
// the result. A quadratic scan takes seconds on every run.
const elapsed = (source) => {
  let best = Infinity;
  for (let run = 0; run < 3; run++) {
    const start = performance.now();
    parseMarkdown(source);
    best = Math.min(best, performance.now() - start);
  }
  return best;
};

// Page Markdown is bounded only by the record size. Each input is a worst case
// for a pattern that was quadratic in the run length. Each run takes tens of
// seconds when any import step rescans the run.
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
  // `~~` makes these opaque, so the time is the gate's scan alone rather than
  // a prose parse of every bracket.
  "open-bracket run": `${"[".repeat(RUN)}~~`,
  "open-bracket line run": `${"\n[".repeat(RUN / 2)}~~`,
  "space run inside a table break": `| a |\n| --- |\n| <br${" ".repeat(RUN)}x |`,
};

for (const [name, source] of Object.entries(runs)) {
  test(`Markdown import is linear on input: ${name}`, () => {
    parseMarkdown(source.slice(0, 1000));
    const ms = elapsed(source);
    assert.ok(ms < 100, `${name}: ${ms.toFixed(1)} ms`);
  });
}

// The gate as one regex pass, with the same line and space semantics. It is
// quadratic on long runs, so the comparison uses short inputs only. Math is
// gated separately and left out of the alphabet.
const reference = (source) => {
  const syntax = source.replace(/^(\s*(?:>\s*)*[-+*][ \t]+)\[[ xX]\](?=[ \t]|$)/gm, "$1");
  return /(^|\n)\s*(<(?!\/?mark[ \t\r\n>])|---\s*$)|!?\[[^\]]*\]\s*\[|^\s*\[[^\]]+\]:|~~/im.test(
    syntax,
  );
};

test("the import gate matches the single-regex gate on line-start syntax", () => {
  for (const [source, expected] of [
    ["- [ ] [Read](https://example.com)", false],
    ["- [ ] [a] [b]", true],
    ["> * [x]\ttask", false],
    ["  <div>", true],
    ["<mark>highlight</mark>", false],
    ["</MARK\r>", false],
    ["<mark", true],
    ["<mark\u2028", true],
    ["---  ", true],
    ["----", false],
    ["--- x", false],
    ["[label]: https://example.com", true],
    ["[multi\nline]: https://example.com", true],
    ["[]: empty", false],
    ["\u2028[a]: x", true],
    ["\u00a0<p>", true],
    ["~~struck~~", true],
  ]) {
    assert.equal(reference(source), expected, JSON.stringify(source));
    assert.equal(opaque(source), expected, JSON.stringify(source));
  }

  // A fixed seed keeps failures reproducible.
  let seed = 0x4594;
  const random = (n) => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return (seed >>> 8) % n;
  };
  const pieces = [
    " ",
    "\t",
    "\r",
    "\n",
    "\r\n",
    "\u2028",
    "\u2029",
    "\u00a0",
    "\ufeff",
    ">",
    "-",
    "+",
    "*",
    "[",
    "]",
    "[ ]",
    "[x]",
    "[X]",
    ":",
    "x",
    "<",
    "/",
    "mark",
    "MaRk",
    "<mark>",
    "</mark",
    "<br>",
    "---",
    "~",
    "!",
    "(",
    ")",
  ];
  for (let n = 0; n < 20_000; n++) {
    let source = "";
    for (let length = random(10); length >= 0; length--) source += pieces[random(pieces.length)];
    assert.equal(opaque(source), reference(source), JSON.stringify(source));
  }
});

test("a table break tag may hold spaces around its slash", () => {
  for (const tag of ["<br>", "<br/>", "<br />", "<BR  / >", "<br\t>"]) {
    const doc = parseMarkdown(`| a${tag}b |\n| --- |\n| c |`);
    const names = [];
    doc.descendants((node) => {
      names.push(node.type.name);
    });
    assert.ok(names.includes("hard_break"), tag);
  }
  const doc = parseMarkdown("| a<br / / >b |\n| --- |\n| c |");
  assert.match(doc.textContent, /<br/);
});
