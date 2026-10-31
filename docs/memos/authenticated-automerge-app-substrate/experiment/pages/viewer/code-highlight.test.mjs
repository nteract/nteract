import test from "node:test";
import assert from "node:assert/strict";
import { CODE_LANGUAGES, languageFor } from "./code-highlight.mjs";

test("a stored language finds its highlighter by first word, any case", () => {
  for (const [stored, name] of [
    ["python", "Python"],
    ["Python", "Python"],
    ["  py  ", "Python"],
    ["python title=demo.py", "Python"],
    ["js", "JavaScript"],
    ["tsx", "TypeScript"],
    ["bash", "Shell"],
    ["sh", "Shell"],
    ["console", "Shell"],
    ["rs", "Rust"],
    ["yml", "YAML"],
    ["JSON", "JSON"],
    ["golang", "Go"],
  ])
    assert.equal(languageFor(stored)?.name, name, stored);
  for (const stored of [undefined, null, "", "   ", "mermaid", "markdown", "brainfuck"])
    assert.equal(languageFor(stored), null, String(stored));
});

test("every menu language highlights except Mermaid and Markdown", () => {
  const plain = CODE_LANGUAGES.filter((name) => !languageFor(name));
  assert.deepEqual(plain, ["Mermaid", "Markdown"]);
});
