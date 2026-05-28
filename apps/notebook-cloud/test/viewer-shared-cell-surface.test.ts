import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("cloud editable markdown cells use shared cell and output rendering surfaces", () => {
  const sourcePath = new URL("../viewer/editable-markdown-cell.tsx", import.meta.url);
  const sourceText = readFileSync(sourcePath, "utf8");

  assert.match(sourceText, /import \{ CellContainer \} from "@\/components\/cell\/CellContainer";/);
  assert.match(sourceText, /import \{ OutputArea \} from "@\/components\/cell\/OutputArea";/);
  assert.match(sourceText, /<CellContainer/);
  assert.match(sourceText, /<OutputArea/);
  assert.match(sourceText, /isolated="auto"/);
  assert.match(sourceText, /priority=\{priority\}/);
  assert.match(sourceText, /hostContext=\{hostContext\}/);
  assert.match(sourceText, /<CodeMirrorEditor/);
});

test("cloud live notebook passes renderer policy into editable markdown cells", () => {
  const sourcePath = new URL("../viewer/index.tsx", import.meta.url);
  const sourceText = readFileSync(sourcePath, "utf8");

  assert.match(sourceText, /<EditableMarkdownCell[\s\S]*priority=\{priority\}/);
  assert.match(sourceText, /<EditableMarkdownCell[\s\S]*hostContext=\{hostContext\}/);
});
