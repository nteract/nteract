import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("cloud editable markdown cells use shared cell and output rendering surfaces", () => {
  const sourcePath = new URL("../viewer/editable-markdown-cell.tsx", import.meta.url);
  const sourceText = readFileSync(sourcePath, "utf8");

  assert.match(
    sourceText,
    /import \{ EditableMarkdownCell as SharedEditableMarkdownCell \} from "@\/components\/cell\/EditableMarkdownCell";/,
  );
  assert.match(sourceText, /<SharedEditableMarkdownCell/);
  assert.match(sourceText, /priority=\{priority\}/);
  assert.match(sourceText, /hostContext=\{hostContext\}/);
  assert.match(sourceText, /editorExtensions=\{extensions\}/);
  assert.doesNotMatch(sourceText, /from "@\/components\/cell\/CellContainer"/);
  assert.doesNotMatch(sourceText, /from "@\/components\/cell\/OutputArea"/);
  assert.doesNotMatch(sourceText, /from "@\/components\/editor\/codemirror-editor"/);
});

test("cloud markdown edit toggle avoids blur and stale-source races", () => {
  const sourcePath = new URL(
    "../../../src/components/cell/EditableMarkdownCell.tsx",
    import.meta.url,
  );
  const sourceText = readFileSync(sourcePath, "utf8");

  assert.match(sourceText, /editorRef\.current\?\.getEditor\(\)\?\.state\.doc\.toString\(\)/);
  assert.match(sourceText, /suppressNextToggleClickRef/);
  assert.match(sourceText, /onMouseDown=\{handleActionMouseDown\}/);
  assert.match(sourceText, /onClick=\{handleActionClick\}/);
});

test("cloud markdown editor remounts with latest source state", () => {
  const sourcePath = new URL("../viewer/editable-markdown-cell.tsx", import.meta.url);
  const sourceText = readFileSync(sourcePath, "utf8");

  assert.match(sourceText, /if \(!editing\) return;\s+bridge\.applyFullSource\(cell\.source\);/);
  assert.match(sourceText, /cell\.source\.trim\(\)\.length === 0 && !editing/);
});

test("cloud live notebook passes renderer policy into editable markdown cells", () => {
  const sourcePath = new URL("../viewer/cloud-live-notebook.tsx", import.meta.url);
  const sourceText = readFileSync(sourcePath, "utf8");

  assert.match(sourceText, /NotebookCellList/);
  assert.match(sourceText, /slot="cloud-live-notebook"/);
  assert.match(sourceText, /<EditableMarkdownCell[\s\S]*priority=\{priority\}/);
  assert.match(sourceText, /<EditableMarkdownCell[\s\S]*hostContext=\{hostContext\}/);
});

test("cloud viewer shell uses the shared notebook rail as an adapter surface", () => {
  const sourcePath = new URL("../viewer/index.tsx", import.meta.url);
  const sourceText = readFileSync(sourcePath, "utf8");

  assert.match(sourceText, /NotebookRail/);
  assert.match(sourceText, /createNotebookViewModel\(cells/);
  assert.match(sourceText, /<NotebookRail[\s\S]*outlineItems=\{outlineItems\}/);
  assert.match(sourceText, /onNavigateOutlineItem=\{handleNavigateOutlineItem\}/);
  assert.match(sourceText, /navigateMarkdownHeading\(item\.cellId, item\.headingAnchorId/);
});

test("cloud viewer shell keeps render endpoints out of the interactive load path", () => {
  const sourcePath = new URL("../viewer/index.tsx", import.meta.url);
  const sourceText = readFileSync(sourcePath, "utf8");

  assert.doesNotMatch(sourceText, /renderEndpoint/);
  assert.doesNotMatch(sourceText, /pinnedRenderBasePath/);
  assert.doesNotMatch(sourceText, /api\/n\/[^"`']+\/render/);
});
