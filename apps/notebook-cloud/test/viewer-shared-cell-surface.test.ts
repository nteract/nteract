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

test("cloud markdown edit toggle avoids blur and stale-source races", () => {
  const sourcePath = new URL("../viewer/editable-markdown-cell.tsx", import.meta.url);
  const sourceText = readFileSync(sourcePath, "utf8");

  assert.match(sourceText, /editorRef\.current\?\.getEditor\(\)\?\.state\.doc\.toString\(\)/);
  assert.match(sourceText, /suppressNextToggleClickRef/);
  assert.match(sourceText, /onMouseDown=\{handleActionMouseDown\}/);
  assert.match(sourceText, /onClick=\{handleActionClick\}/);
});

test("cloud live notebook passes renderer policy into editable markdown cells", () => {
  const sourcePath = new URL("../viewer/index.tsx", import.meta.url);
  const sourceText = readFileSync(sourcePath, "utf8");

  assert.match(sourceText, /<EditableMarkdownCell[\s\S]*priority=\{priority\}/);
  assert.match(sourceText, /<EditableMarkdownCell[\s\S]*hostContext=\{hostContext\}/);
});
